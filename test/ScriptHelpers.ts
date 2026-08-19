import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";

import {
  assertActiveSigner,
  assertCommittedPubkeyMatchesLocal,
  assertCommittedPubkeyMatchesLocalIfReadable,
  assertContractPredepositWei,
  assertDeployedAt,
  assertDeploymentRecordShape,
  assertExpectedForwarder,
  assertExpectedForwarderRecorded,
  assertFreshForwarderMatchesExpectedForwarder,
  assertExpectedPool,
  assertExpectedPubkey,
  assertFundingWasCredited,
  assertFundingWindowNotDeclared,
  assertFreshDeploymentMatchesExpectedPool,
  assertPayoutReachedRecipient,
  assertStillFundable,
  assertSweepWasCredited,
  beaconApiUrl,
  decodePoolOutflows,
  describeFatalError,
  envBigInt,
  formatPoolState,
  formatWei,
  fundViaPlainTransfer,
  optionalEnvBigInt,
  parseBigIntList,
  printPayoutRecipient,
  printSuggestedFees,
  reportForwarderWithoutRefusing,
  requireFundingAllocation,
  resolveSuggestedFees,
  requireFundingWindowSeconds,
  PREDEPOSIT_WEI,
  waitForSenderVerifiedReceipt,
  warnOnPlaintextEndpoints,
  type DeploymentRecord,
  type ForwarderReportClient,
  type PoolOutflow,
} from "../scripts/lib/common.js";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_SIGNER = "0x2222222222222222222222222222222222222222" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const REPLACEMENT_HASH = `0x${"cd".repeat(32)}` as Hex;

interface FakeReceipt {
  from: Address;
  blockNumber: bigint;
  status: "success" | "reverted";
  contractAddress?: Address | null;
}

/// Mirrors `ObservedTransaction`: the four fields every transaction carries plus every
/// non-fee semantic field viem's per-type transaction variants add
/// (`node_modules/viem/_types/types/transaction.d.ts` lines 84-129, viem 2.49.3). Each of
/// the optional ones is absent on the types that do not have it, which is what makes
/// absent-versus-present a case the policy has to decide.
interface FakeTransaction {
  hash: Hex;
  to: Address | null;
  value: bigint;
  input: Hex;
  type?: string;
  accessList?: readonly { address: Address; storageKeys: readonly Hex[] }[];
  blobVersionedHashes?: readonly Hex[];
  authorizationList?: readonly { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number }[];
}

interface FakeReplacement {
  reason: string;
  replacedTransaction: FakeTransaction;
  transaction: FakeTransaction;
}

/// The narrowest client `waitForSenderVerifiedReceipt` accepts. Its parameter type is
/// structural precisely so the post-broadcast policy can be driven without a chain: every
/// outcome below is one a real `waitForTransactionReceipt` can resolve with.
function fakeClient(receipt: FakeReceipt, replacement?: FakeReplacement) {
  const calls: Hex[] = [];
  return {
    calls,
    waitForTransactionReceipt: async ({
      hash,
      onReplaced,
    }: {
      hash: Hex;
      onReplaced?: (replacement: FakeReplacement) => void;
    }) => {
      calls.push(hash);
      // viem invokes `onReplaced` and resolves with the replacement's receipt from the
      // same `done()` callback, so a caller sees both before the promise settles
      // (`viem/_esm/actions/public/waitForTransactionReceipt.js` lines 181-189).
      if (replacement !== undefined) onReplaced?.(replacement);
      return receipt;
    },
  };
}

function sentTransaction(overrides: Partial<FakeTransaction> = {}): FakeTransaction {
  return {
    hash: HASH,
    to: POOL,
    value: 1_000n,
    input: "0xdeadbeef",
    type: "eip1559",
    accessList: [],
    ...overrides,
  };
}

function replacementOf(
  reason: string,
  overrides: Partial<FakeTransaction> = {},
): FakeReplacement {
  return {
    reason,
    replacedTransaction: sentTransaction(),
    transaction: sentTransaction({ hash: REPLACEMENT_HASH, ...overrides }),
  };
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

async function silentlyAsync<T>(run: () => Promise<T>): Promise<T> {
  const log = captureLog();
  try {
    return await run();
  } finally {
    log.restore();
  }
}

function silently<T>(run: () => T): T {
  const log = captureLog();
  try {
    return run();
  } finally {
    log.restore();
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("waitForSenderVerifiedReceipt", function () {
  it("returns the receipt of a successful transaction from the intended signer", async function () {
    const client = fakeClient({ from: SIGNER, blockNumber: 7n, status: "success" });

    const receipt = await waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund");

    assert.deepEqual(client.calls, [HASH]);
    assert.equal(receipt.blockNumber, 7n);
  });

  it("accepts a case-different sender", async function () {
    const client = fakeClient({
      from: SIGNER.toUpperCase().replace("0X", "0x") as Address,
      blockNumber: 7n,
      status: "success",
    });

    assert.equal(
      (await waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund")).blockNumber,
      7n,
    );
  });

  it("is fatal when the mined transaction reverted", async function () {
    const client = fakeClient({ from: SIGNER, blockNumber: 9n, status: "reverted" });

    await assert.rejects(
      waitForSenderVerifiedReceipt(client, HASH, SIGNER, "top-up"),
      (error: Error) => {
        assert.match(error.message, /top-up transaction .* REVERTED/);
        assert.match(error.message, new RegExp(HASH));
        assert.match(error.message, /receipt status reverted/);
        assert.match(error.message, /block 9/);
        assert.match(error.message, /npm run status/);
        return true;
      },
    );
  });

  it("is fatal when the mined sender is not the intended signer", async function () {
    const client = fakeClient({ from: OTHER_SIGNER, blockNumber: 9n, status: "success" });

    await assert.rejects(
      waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
      /FATAL SIGNER MISMATCH: fund transaction .* was mined with from=/,
    );
  });

  it("checks the sender before the status, so a swapped signer is never reported as a revert", async function () {
    const client = fakeClient({ from: OTHER_SIGNER, blockNumber: 9n, status: "reverted" });

    await assert.rejects(
      waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
      /FATAL SIGNER MISMATCH/,
    );
  });

  it("accepts a reprice that kept the destination, value, and calldata", async function () {
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      replacementOf("repriced"),
    );
    const log = captureLog();

    try {
      const receipt = await waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund");
      assert.equal(receipt.blockNumber, 11n);
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /fund transaction .* was repriced and mined as/);
      assert.match(log.lines[0], new RegExp(REPLACEMENT_HASH));
    } finally {
      log.restore();
    }
  });

  it("is fatal when the same-nonce transaction that landed was a cancellation", async function () {
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      replacementOf("cancelled", { to: SIGNER, value: 0n, input: "0x" }),
    );

    await assert.rejects(
      waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
      (error: Error) => {
        assert.match(error.message, /FATAL REPLACED TRANSACTION: fund transaction .* never landed/);
        assert.match(error.message, new RegExp(`${REPLACEMENT_HASH}, reason "cancelled"`));
        assert.match(error.message, /npm run status/);
        return true;
      },
    );
  });

  it("is fatal when the same-nonce transaction that landed was a different transaction", async function () {
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      replacementOf("replaced", { to: OTHER_SIGNER, value: 5n, input: "0xfeed" }),
    );

    await assert.rejects(
      waitForSenderVerifiedReceipt(client, HASH, SIGNER, "sweep"),
      /FATAL REPLACED TRANSACTION: sweep transaction .* reason "replaced", differing semantic fields: to, value, input/,
    );
  });

  it("is fatal for a repriced classification whose content actually changed", async function () {
    // viem only labels a replacement `repriced` when to, value, and input all match
    // (`waitForTransactionReceipt.js` lines 171-176). The policy re-derives that rather
    // than trusting the label, so a wrong label cannot buy a success line.
    for (const [changed, field] of [
      [{ to: OTHER_SIGNER }, "to"],
      [{ value: 999n }, "value"],
      [{ input: "0xbeefdead" as Hex }, "input"],
    ] as const) {
      const client = fakeClient(
        { from: SIGNER, blockNumber: 11n, status: "success" },
        replacementOf("repriced", changed),
      );

      await assert.rejects(
        waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
        new RegExp(`differing semantic fields: ${field}`),
      );
    }
  });

  it("is fatal for a reprice that changed a semantic field beyond to, value, and input", async function () {
    // viem's own `repriced` test is exactly to/value/input
    // (`waitForTransactionReceipt.js` lines 171-176), so each of these is a substitution
    // viem itself would label a reprice. The authorization-list case is the sharpest: same
    // destination, same value, same calldata, and an EIP-7702 delegation of the sending
    // EOA's own code to an arbitrary contract riding along.
    const delegation = [
      {
        address: OTHER_SIGNER,
        chainId: 1,
        nonce: 7,
        r: `0x${"11".repeat(32)}` as Hex,
        s: `0x${"22".repeat(32)}` as Hex,
        yParity: 0,
      },
    ];
    for (const [changed, field] of [
      [{ type: "eip7702", authorizationList: delegation }, "type, authorizationList"],
      [{ authorizationList: delegation }, "authorizationList"],
      [{ type: "legacy" }, "type"],
      [{ accessList: [{ address: POOL, storageKeys: [`0x${"00".repeat(32)}` as Hex] }] }, "accessList"],
      [{ accessList: undefined }, "accessList"],
      [{ blobVersionedHashes: [`0x01${"33".repeat(31)}` as Hex] }, "blobVersionedHashes"],
    ] as const) {
      const client = fakeClient(
        { from: SIGNER, blockNumber: 11n, status: "success" },
        replacementOf("repriced", changed),
      );

      await assert.rejects(
        waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
        (error: Error) => {
          assert.match(error.message, /FATAL REPLACED TRANSACTION/);
          assert.match(error.message, new RegExp(`differing semantic fields: ${field}$|differing semantic fields: ${field}\\)`));
          return true;
        },
      );
    }
  });

  it("accepts a reprice whose semantic fields match structurally, case and order aside", async function () {
    const accessList = [
      { address: POOL, storageKeys: [`0x${"ab".repeat(32)}` as Hex] },
    ];
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      {
        reason: "repriced",
        replacedTransaction: sentTransaction({ accessList }),
        transaction: sentTransaction({
          hash: REPLACEMENT_HASH,
          // Same destination and same access list, differently cased on the wire.
          to: POOL.toUpperCase().replace("0X", "0x") as Address,
          input: "0xDEADBEEF",
          accessList: [
            {
              address: POOL.toUpperCase().replace("0X", "0x") as Address,
              storageKeys: [`0x${"AB".repeat(32)}` as Hex],
            },
          ],
        }),
      },
    );

    await assert.doesNotReject(silentlyAsync(() => waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund")));
  });

  it("treats an absent optional field as equal only to another absent one", async function () {
    // A legacy transaction repriced as a legacy transaction: `accessList`,
    // `blobVersionedHashes`, and `authorizationList` are all absent on both sides.
    const legacy = {
      hash: HASH,
      to: POOL,
      value: 1_000n,
      input: "0xdeadbeef" as Hex,
      type: "legacy",
    };
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      {
        reason: "repriced",
        replacedTransaction: legacy,
        transaction: { ...legacy, hash: REPLACEMENT_HASH },
      },
    );

    await assert.doesNotReject(silentlyAsync(() => waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund")));

    // An empty access list is PRESENT, and present never equals absent.
    const withEmptyList = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "success" },
      {
        reason: "repriced",
        replacedTransaction: legacy,
        transaction: { ...legacy, hash: REPLACEMENT_HASH, accessList: [] },
      },
    );

    await assert.rejects(
      waitForSenderVerifiedReceipt(withEmptyList, HASH, SIGNER, "fund"),
      /differing semantic fields: accessList/,
    );
  });

  it("is fatal when an accepted reprice reverted", async function () {
    const client = fakeClient(
      { from: SIGNER, blockNumber: 11n, status: "reverted" },
      replacementOf("repriced"),
    );
    const log = captureLog();

    try {
      await assert.rejects(
        waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
        // The mined hash is the replacement's, not the one that was broadcast.
        new RegExp(`fund transaction ${REPLACEMENT_HASH} was mined but REVERTED`),
      );
    } finally {
      log.restore();
    }
  });
});

describe("warnOnPlaintextEndpoints", function () {
  /// A connection whose resolved `url` behaves exactly as Hardhat's
  /// `ResolvedConfigurationVariable` does: the value is behind a promise, and it does NOT
  /// come from `process.env`. That is the whole point of the fixture — the keystore path
  /// this repository documents for mainnet leaves `process.env.RPC_URL` unset, so a check
  /// that read the environment would see nothing to warn about.
  function connectionWithUrl(resolved: string | (() => Promise<string>)) {
    return {
      networkName: "rpc",
      networkConfig: {
        url: {
          getUrl: typeof resolved === "string" ? async () => resolved : resolved,
        },
      },
    };
  }

  /// An `edr-simulated` network: a resolved config with no `url` at all.
  const noUrl = { networkName: "hardhatMainnet", networkConfig: {} };

  async function warningsFor(
    connection: Parameters<typeof warnOnPlaintextEndpoints>[0],
  ): Promise<string[]> {
    const warn = captureWarn();
    try {
      await warnOnPlaintextEndpoints(connection);
      return warn.lines;
    } finally {
      warn.restore();
    }
  }

  function withoutEndpointEnv<T>(run: () => Promise<T>): Promise<T> {
    const originalRpc = process.env.RPC_URL;
    const originalBeacon = process.env.BEACON_NODE_URL;
    delete process.env.RPC_URL;
    delete process.env.BEACON_NODE_URL;
    return run().finally(() => {
      restoreEnv("RPC_URL", originalRpc);
      restoreEnv("BEACON_NODE_URL", originalBeacon);
    });
  }

  it("warns on a non-loopback plaintext RPC_URL that never appears in the environment", async function () {
    await withoutEndpointEnv(async () => {
      const lines = await warningsFor(connectionWithUrl("http://10.0.0.7:8545"));

      assert.equal(lines.length, 1);
      assert.match(lines[0], /WARNING: RPC_URL is plaintext http:\/\/ to 10\.0\.0\.7, which is not loopback/);
      assert.match(lines[0], /Anyone on the network path/);
      assert.match(lines[0], /SECURITY\.md §2/);
      // The environment is not where the value came from, and the check still fired.
      assert.equal(process.env.RPC_URL, undefined);
    });
  });

  it("says nothing about an https RPC_URL, or about one on loopback", async function () {
    await withoutEndpointEnv(async () => {
      for (const url of [
        "https://mainnet.example.com",
        "http://localhost:8545",
        "http://127.0.0.1:8545",
        "http://127.10.20.30:8545",
        "http://[::1]:8545",
        "https://10.0.0.7:8545",
        "wss://mainnet.example.com",
        "ws://127.0.0.1:8546",
      ]) {
        assert.deepEqual(await warningsFor(connectionWithUrl(url)), [], url);
      }
    });
  });

  it("warns about ws:// too, and names the scheme it saw", async function () {
    // A WebSocket endpoint is as plaintext as an http one and viem's transports take it, so
    // a `ws://` RPC_URL used to pass this check in silence. The message names the scheme
    // rather than asserting http, and points at wss rather than https.
    await withoutEndpointEnv(async () => {
      const lines = await warningsFor(connectionWithUrl("ws://10.0.0.7:8546"));

      assert.equal(lines.length, 1);
      assert.match(lines[0], /WARNING: RPC_URL is plaintext ws:\/\/ to 10\.0\.0\.7/);
      assert.match(lines[0], /Use wss:\/\//);
      assert.doesNotMatch(lines[0], /Use https:\/\//);

      process.env.BEACON_NODE_URL = "ws://10.0.0.9:5052";
      const beacon = await warningsFor(connectionWithUrl("https://mainnet.example.com"));
      assert.equal(beacon.length, 1);
      assert.match(beacon[0], /WARNING: BEACON_NODE_URL is plaintext ws:\/\/ to 10\.0\.0\.9/);
    });
  });

  it("still reads BEACON_NODE_URL from the environment, which is where it lives", async function () {
    await withoutEndpointEnv(async () => {
      process.env.BEACON_NODE_URL = "http://10.0.0.9:5052";

      const lines = await warningsFor(connectionWithUrl("https://mainnet.example.com"));

      assert.equal(lines.length, 1);
      assert.match(lines[0], /WARNING: BEACON_NODE_URL is plaintext http:\/\/ to 10\.0\.0\.9/);
    });
  });

  it("warns about both endpoints when both are plaintext", async function () {
    await withoutEndpointEnv(async () => {
      process.env.BEACON_NODE_URL = "http://10.0.0.9:5052";

      const lines = await warningsFor(connectionWithUrl("http://10.0.0.7:8545"));

      assert.equal(lines.length, 2);
      assert.match(lines[0], /RPC_URL is plaintext/);
      assert.match(lines[1], /BEACON_NODE_URL is plaintext/);
    });
  });

  it("is silent, and never throws, when the endpoint cannot be resolved or is not a URL", async function () {
    await withoutEndpointEnv(async () => {
      // A network with no endpoint at all.
      assert.deepEqual(await warningsFor(noUrl), []);
      // Hardhat's `getUrl()` rejects for an unset variable and for a value that is not a
      // URL. A warning must not be the thing that ends a run.
      assert.deepEqual(
        await warningsFor(
          connectionWithUrl(async () => {
            throw new Error("Configuration variable RPC_URL not found");
          }),
        ),
        [],
      );
      assert.deepEqual(await warningsFor(connectionWithUrl("")), []);
    });
  });
});

describe("assertActiveSigner", function () {
  const nonLedger = { networkName: "rpc", networkConfig: {} };
  const ledger = { networkName: "ledger", networkConfig: { ledgerAccounts: [SIGNER] } };

  it("prints the active signer and the network on every connection", async function () {
    const original = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    delete process.env.EXPECTED_SIGNER;

    try {
      assert.equal(await assertActiveSigner(nonLedger, SIGNER, "fund"), SIGNER);
      assert.deepEqual(log.lines, [`fund active signer: ${SIGNER} (network rpc)`]);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", original);
    }
  });

  it("requires LEDGER_ADDRESS on a Ledger-signing connection", async function () {
    const original = process.env.LEDGER_ADDRESS;
    const originalExpected = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    delete process.env.LEDGER_ADDRESS;
    delete process.env.EXPECTED_SIGNER;

    try {
      await assert.rejects(
        () => assertActiveSigner(ledger, SIGNER, "fund"),
        /fund is connected to a Ledger-signing network but LEDGER_ADDRESS is unset/,
      );
    } finally {
      log.restore();
      restoreEnv("LEDGER_ADDRESS", original);
      restoreEnv("EXPECTED_SIGNER", originalExpected);
    }
  });

  it("asserts nothing about the address when neither variable is declared", async function () {
    const originalExpected = process.env.EXPECTED_SIGNER;
    const originalLedger = process.env.LEDGER_ADDRESS;
    const log = captureLog();
    delete process.env.EXPECTED_SIGNER;
    delete process.env.LEDGER_ADDRESS;

    try {
      assert.equal(await assertActiveSigner(nonLedger, OTHER_SIGNER, "claim"), OTHER_SIGNER);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", originalExpected);
      restoreEnv("LEDGER_ADDRESS", originalLedger);
    }
  });

  it("enforces EXPECTED_SIGNER on a network that signs with no device", async function () {
    const original = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    process.env.EXPECTED_SIGNER = SIGNER;

    try {
      assert.equal(await assertActiveSigner(nonLedger, SIGNER, "fund"), SIGNER);
      // Declared and active differ only in case: still the same account.
      assert.equal(
        (await assertActiveSigner(nonLedger, SIGNER.toUpperCase().replace("0X", "0x") as Address, "fund")).toLowerCase(),
        SIGNER,
      );
      await assert.rejects(
        () => assertActiveSigner(nonLedger, OTHER_SIGNER, "fund"),
        /fund would sign with .* not the declared EXPECTED_SIGNER/,
      );
      process.env.EXPECTED_SIGNER = "not-an-address";
      await assert.rejects(
        () => assertActiveSigner(nonLedger, SIGNER, "fund"),
        /EXPECTED_SIGNER not-an-address is not a 0x-prefixed 20-byte address/,
      );
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", original);
    }
  });

  it("enforces EXPECTED_SIGNER on the Ledger path too, alongside LEDGER_ADDRESS", async function () {
    const originalExpected = process.env.EXPECTED_SIGNER;
    const originalLedger = process.env.LEDGER_ADDRESS;
    const log = captureLog();
    process.env.LEDGER_ADDRESS = SIGNER;
    process.env.EXPECTED_SIGNER = OTHER_SIGNER;

    try {
      // The device account is the one that would sign, and it is not the declared one.
      await assert.rejects(
        () => assertActiveSigner(ledger, SIGNER, "fund"),
        /not the declared EXPECTED_SIGNER/,
      );
      process.env.EXPECTED_SIGNER = SIGNER;
      assert.equal(await assertActiveSigner(ledger, SIGNER, "fund"), SIGNER);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", originalExpected);
      restoreEnv("LEDGER_ADDRESS", originalLedger);
    }
  });

  it("refuses to sign with an account that is not the Ledger account", async function () {
    const original = process.env.LEDGER_ADDRESS;
    const originalExpected = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    process.env.LEDGER_ADDRESS = SIGNER;
    delete process.env.EXPECTED_SIGNER;

    try {
      await assert.rejects(
        () => assertActiveSigner(ledger, OTHER_SIGNER, "fund"),
        /fund would sign with .* not the Ledger account/,
      );
      assert.equal(
        (await assertActiveSigner(ledger, SIGNER.toUpperCase().replace("0X", "0x") as Address, "fund")).toLowerCase(),
        SIGNER,
      );
    } finally {
      log.restore();
      restoreEnv("LEDGER_ADDRESS", original);
      restoreEnv("EXPECTED_SIGNER", originalExpected);
    }
  });
});

describe("fundViaPlainTransfer", function () {
  const noLedger = {};
  const withLedger = { ledgerAccounts: [SIGNER] };

  it("defaults to the transfer path only when the connection signs with a device", function () {
    const original = process.env.FUND_VIA_TRANSFER;
    delete process.env.FUND_VIA_TRANSFER;

    try {
      assert.equal(fundViaPlainTransfer(withLedger), true);
      assert.equal(fundViaPlainTransfer(noLedger), false);
      assert.equal(fundViaPlainTransfer({ ledgerAccounts: [] }), false);
      // An empty override is the same as an unset one.
      process.env.FUND_VIA_TRANSFER = "";
      assert.equal(fundViaPlainTransfer(withLedger), true);
      assert.equal(fundViaPlainTransfer(noLedger), false);
    } finally {
      restoreEnv("FUND_VIA_TRANSFER", original);
    }
  });

  it("lets FUND_VIA_TRANSFER force either path on either kind of connection", function () {
    const original = process.env.FUND_VIA_TRANSFER;

    try {
      process.env.FUND_VIA_TRANSFER = "1";
      assert.equal(fundViaPlainTransfer(noLedger), true);
      assert.equal(fundViaPlainTransfer(withLedger), true);

      process.env.FUND_VIA_TRANSFER = "0";
      assert.equal(fundViaPlainTransfer(noLedger), false);
      assert.equal(fundViaPlainTransfer(withLedger), false);
    } finally {
      restoreEnv("FUND_VIA_TRANSFER", original);
    }
  });

  it("refuses any other value rather than guessing which path was meant", function () {
    const original = process.env.FUND_VIA_TRANSFER;

    try {
      for (const value of ["true", "yes", "01", "2", "TRUE", " 1", "0x1"]) {
        process.env.FUND_VIA_TRANSFER = value;
        assert.throws(
          () => fundViaPlainTransfer(withLedger),
          new RegExp(`FUND_VIA_TRANSFER must be 0 or 1, got ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        );
      }
    } finally {
      restoreEnv("FUND_VIA_TRANSFER", original);
    }
  });
});

describe("assertFundingWasCredited", function () {
  // Encoded independently of the implementation, from the event signatures in
  // `contracts/ValidatorFundingPool.sol:117-123` and `:139`.
  const POOL_EVENTS = [
    {
      type: "event",
      name: "ParticipantFunded",
      inputs: [
        { name: "attempt", type: "uint256", indexed: true },
        { name: "participant", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "participantTotal", type: "uint256", indexed: false },
        { name: "attemptTotal", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "EthReceivedViaCall",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
    // An event the check must ignore rather than choke on.
    {
      type: "event",
      name: "PoolToppedUp",
      inputs: [],
    },
  ] as const;

  const AMOUNT = 1_000n;

  function participantFunded(participant: Address, amount: bigint, address: Address = POOL) {
    return {
      address,
      topics: encodeEventTopics({
        abi: POOL_EVENTS,
        eventName: "ParticipantFunded",
        args: { attempt: 3n, participant },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [amount, amount, amount],
      ),
    };
  }

  function ethReceivedViaCall(sender: Address, amount: bigint) {
    return {
      address: POOL,
      topics: encodeEventTopics({ abi: POOL_EVENTS, eventName: "EthReceivedViaCall", args: { sender } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    };
  }

  const poolToppedUp = {
    address: POOL,
    topics: encodeEventTopics({ abi: POOL_EVENTS, eventName: "PoolToppedUp" }) as Hex[],
    data: "0x" as Hex,
  };

  it("passes when the receipt credits the signer with exactly the sent amount", async function () {
    const log = captureLog();
    try {
      assertFundingWasCredited(
        { logs: [poolToppedUp, participantFunded(SIGNER, AMOUNT)] },
        POOL,
        SIGNER,
        AMOUNT,
        "fund",
      );
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /fund credit confirmed from the receipt/);
      assert.match(log.lines[0], new RegExp(SIGNER));
    } finally {
      log.restore();
    }

    // Case differences between the log's address and the signer are not differences.
    assert.doesNotThrow(() =>
      silently(() =>
        assertFundingWasCredited(
          { logs: [participantFunded(SIGNER.toUpperCase().replace("0X", "0x") as Address, AMOUNT)] },
          POOL.toUpperCase().replace("0X", "0x") as Address,
          SIGNER,
          AMOUNT,
          "fund",
        ),
      ),
    );
  });

  it("is fatal for an EthReceivedViaCall-only receipt, naming what actually happened", function () {
    assert.throws(
      () =>
        assertFundingWasCredited(
          { logs: [ethReceivedViaCall(SIGNER, AMOUNT)] },
          POOL,
          SIGNER,
          AMOUNT,
          "fund",
        ),
      (error: Error) => {
        assert.match(error.message, /was NOT credited as funding/);
        assert.match(error.message, /emitted EthReceivedViaCall/);
        assert.match(error.message, /POST-TOP-UP PROCEEDS/);
        assert.match(error.message, /recovers only their own share/);
        assert.match(error.message, /DETECTS an uncredited transfer, it cannot prevent one/);
        assert.match(error.message, /npm run status/);
        return true;
      },
    );
  });

  it("is fatal when the credited amount is not the amount that was sent", function () {
    assert.throws(
      () =>
        assertFundingWasCredited(
          { logs: [participantFunded(SIGNER, AMOUNT - 1n)] },
          POOL,
          SIGNER,
          AMOUNT,
          "fund",
        ),
      /the pool credited 999 wei .*, not the 1000 wei .* that was sent/,
    );
  });

  it("is fatal when the credited participant is somebody else, or the log is another contract's", function () {
    for (const logs of [
      [participantFunded(OTHER_SIGNER, AMOUNT)],
      // Right event, right participant, right amount — emitted by a contract that is not
      // the pool. An impostor cannot forge the pool's credit.
      [participantFunded(SIGNER, AMOUNT, OTHER_SIGNER)],
      [],
    ]) {
      assert.throws(
        () => assertFundingWasCredited({ logs }, POOL, SIGNER, AMOUNT, "fund"),
        /emitted no ParticipantFunded for .* at all/,
      );
    }
  });
});

describe("the payout recipient, printed and then proven", function () {
  // Encoded independently of the implementation, from the event declarations in
  // `contracts/ValidatorFundingPool.sol:154` and `:132`.
  const PAYOUT_EVENTS = [
    {
      type: "event",
      name: "Claimed",
      inputs: [
        { name: "participant", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "Refunded",
      inputs: [
        { name: "participant", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
    // An event the check must skip rather than choke on.
    {
      type: "event",
      name: "PoolToppedUp",
      inputs: [],
    },
  ] as const;

  const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
  const AMOUNT = 5_000n;

  function paid(
    eventName: "Claimed" | "Refunded",
    participant: Address,
    recipient: Address,
    amount: bigint,
    address: Address = POOL,
  ) {
    return {
      address,
      topics: encodeEventTopics({
        abi: PAYOUT_EVENTS,
        eventName,
        args: { participant, recipient },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    };
  }

  const poolToppedUp = {
    address: POOL,
    topics: encodeEventTopics({ abi: PAYOUT_EVENTS, eventName: "PoolToppedUp" }) as Hex[],
    data: "0x" as Hex,
  };

  it("prints the pool, the recipient, and the amount before anything is signed", function () {
    const log = captureLog();
    const warn = captureWarn();
    try {
      printPayoutRecipient("claim", POOL, SIGNER, SIGNER, AMOUNT);
      assert.deepEqual(log.lines, [
        `claim pool: ${POOL}`,
        `claim recipient: ${SIGNER}`,
        `claim amount: ${formatWei(AMOUNT)}`,
        "claim pays the signing account itself, so the no-argument claim() is used and no " +
          "recipient address goes into calldata",
      ]);
      // The self path has no unverifiable argument, so it gets no warning.
      assert.deepEqual(warn.lines, []);
    } finally {
      warn.restore();
      log.restore();
    }
  });

  it("warns loudly about the address a device will not render, when redirected", function () {
    const log = captureLog();
    const warn = captureWarn();
    try {
      printPayoutRecipient("refund", POOL, SIGNER, RECIPIENT, AMOUNT);
      assert.deepEqual(log.lines.slice(0, 3), [
        `refund pool: ${POOL}`,
        `refund recipient: ${RECIPIENT}`,
        `refund amount: ${formatWei(AMOUNT)}`,
      ]);
      assert.equal(warn.lines.length, 1);
      assert.match(warn.lines[0], /REFUND IS REDIRECTED: EVERY WEI GOES TO/);
      assert.match(warn.lines[0], new RegExp(RECIPIENT));
      assert.match(warn.lines[0], /A Ledger will NOT render it/);
      assert.match(warn.lines[0], /before you approve on the device/);
    } finally {
      warn.restore();
      log.restore();
    }
  });

  it("confirms a payout that reached the intended recipient", function () {
    const log = captureLog();
    try {
      assertPayoutReachedRecipient(
        { logs: [poolToppedUp, paid("Claimed", SIGNER, RECIPIENT, AMOUNT)] },
        POOL,
        "Claimed",
        SIGNER,
        RECIPIENT,
        AMOUNT,
        "claim",
      );
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /claim recipient confirmed from the receipt/);
      assert.match(log.lines[0], new RegExp(RECIPIENT));
    } finally {
      log.restore();
    }
  });

  it("is fatal, naming both addresses, when the receipt paid somebody else", function () {
    assert.throws(
      () =>
        assertPayoutReachedRecipient(
          { logs: [paid("Claimed", SIGNER, OTHER_SIGNER, AMOUNT)] },
          POOL,
          "Claimed",
          SIGNER,
          RECIPIENT,
          AMOUNT,
          "claim",
        ),
      (error: Error) => {
        assert.match(error.message, /FATAL PAYOUT REDIRECTED/);
        assert.match(error.message, new RegExp(`intended to pay ${RECIPIENT}`));
        assert.match(error.message, new RegExp(`went to ${OTHER_SIGNER}`));
        assert.match(error.message, /DETECTS a substituted recipient, it cannot prevent one/);
        return true;
      },
    );
  });

  it("reports an amount that moved between the read and the transaction, and does not fail", function () {
    const log = captureLog();
    try {
      assertPayoutReachedRecipient(
        { logs: [paid("Claimed", SIGNER, SIGNER, AMOUNT + 1n)] },
        POOL,
        "Claimed",
        SIGNER,
        SIGNER,
        AMOUNT,
        "claim",
      );
      assert.equal(log.lines.length, 2);
      assert.match(log.lines[1], /paid 5001 wei .*, not the 5000 wei/);
      assert.match(log.lines[1], /the contract pays the balance as it stands/);
    } finally {
      log.restore();
    }
  });

  it("requires exactly one payout event of the right name, from the pool, for this signer", function () {
    for (const logs of [
      // The other payout event entirely: a refund receipt cannot confirm a claim.
      [paid("Refunded", SIGNER, RECIPIENT, AMOUNT)],
      // Somebody else's payout in the same block.
      [paid("Claimed", OTHER_SIGNER, RECIPIENT, AMOUNT)],
      // Right event, right addresses — emitted by a contract that is not the pool.
      [paid("Claimed", SIGNER, RECIPIENT, AMOUNT, OTHER_SIGNER)],
      [],
    ]) {
      assert.throws(
        () =>
          assertPayoutReachedRecipient(
            { logs },
            POOL,
            "Claimed",
            SIGNER,
            RECIPIENT,
            AMOUNT,
            "claim",
          ),
        /emitted no Claimed event for/,
      );
    }

    assert.throws(
      () =>
        assertPayoutReachedRecipient(
          {
            logs: [
              paid("Claimed", SIGNER, RECIPIENT, AMOUNT),
              paid("Claimed", SIGNER, RECIPIENT, AMOUNT),
            ],
          },
          POOL,
          "Claimed",
          SIGNER,
          RECIPIENT,
          AMOUNT,
          "claim",
        ),
      /emitted 2 Claimed events for/,
    );
  });
});

describe("assertSweepWasCredited", function () {
  // Encoded independently of the implementation, from `contracts/FeeRecipientForwarder.sol:13`.
  const FORWARDER_EVENTS = [
    {
      type: "event",
      name: "Swept",
      inputs: [
        { name: "caller", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
  ] as const;

  const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;
  const AMOUNT = 250_000_000_000_000_000n;

  function swept(caller: Address, amount: bigint, address: Address = FORWARDER) {
    return {
      address,
      topics: encodeEventTopics({ abi: FORWARDER_EVENTS, eventName: "Swept", args: { caller } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    };
  }

  function balances(
    forwarderBefore: bigint,
    poolBefore: bigint,
    poolAfter: bigint,
    sameBlockOutflows: PoolOutflow[] = [],
  ) {
    return { forwarderBefore, poolBefore, poolAfter, sameBlockOutflows };
  }

  /// The pool's own events for the sweep's block, encoded independently of the
  /// implementation from `ValidatorFundingPool.sol:132`, `:154`, and `:133`.
  const POOL_EVENTS = [
    {
      type: "event",
      name: "Claimed",
      inputs: [
        { name: "participant", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "Refunded",
      inputs: [
        { name: "participant", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "PoolToppedUp",
      inputs: [],
    },
  ] as const;

  function poolPayout(
    eventName: "Claimed" | "Refunded",
    participant: Address,
    amount: bigint,
    address: Address = POOL,
  ) {
    return {
      address,
      topics: encodeEventTopics({
        abi: POOL_EVENTS,
        eventName,
        args: { participant, recipient: participant },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    };
  }

  it("confirms a sweep whose whole balance shows up in the pool", function () {
    const log = captureLog();
    try {
      assertSweepWasCredited(
        { logs: [swept(SIGNER, AMOUNT)] },
        FORWARDER,
        POOL,
        SIGNER,
        balances(AMOUNT, 7n, 7n + AMOUNT),
        "sweep",
      );
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /^sweep credit confirmed: the forwarder's Swept event reports /);
      assert.match(log.lines[0], /rose by exactly the 250000000000000000 wei \(0\.25 ETH\)/);
    } finally {
      log.restore();
    }

    // Case differences on either address are not differences.
    assert.doesNotThrow(() =>
      silently(() =>
        assertSweepWasCredited(
          { logs: [swept(SIGNER.toUpperCase().replace("0X", "0x") as Address, AMOUNT)] },
          FORWARDER.toUpperCase().replace("0X", "0x") as Address,
          POOL,
          SIGNER,
          balances(AMOUNT, 0n, AMOUNT),
          "sweep",
        ),
      ),
    );
  });

  it("accepts a delta above the balance it read, and says what happened", function () {
    // The forwarder IS a fee recipient: a block the validator proposed can pay into it
    // between the balance read and the sweep. That is not a shortfall.
    const log = captureLog();
    try {
      assertSweepWasCredited(
        { logs: [swept(SIGNER, AMOUNT + 5n)] },
        FORWARDER,
        POOL,
        SIGNER,
        balances(AMOUNT, 0n, AMOUNT + 5n),
        "sweep",
      );
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /more than the 250000000000000000 wei/);
      assert.match(log.lines[0], /ETH arrived at the forwarder between the read and the sweep/);
    } finally {
      log.restore();
    }
  });

  it("is fatal on the Swept amount alone, even when an unlogged inflow makes the delta look whole", function () {
    // The one-sidedness of the balance delta, made concrete. The forwarder held AMOUNT and
    // forwarded a tenth of it; a consensus withdrawal to the pool's own credentials landed in
    // the same block and paid in the rest. Withdrawals are credited by the protocol and emit
    // no log anywhere, so `readPoolOutflowsInBlock` cannot see it and the delta reconciles
    // perfectly — the pool really is AMOUNT richer. Only the forwarder's own Swept event says
    // what the forwarder actually sent.
    const forwarded = AMOUNT / 10n;
    const withdrawal = AMOUNT - forwarded;
    assert.throws(
      () =>
        assertSweepWasCredited(
          { logs: [swept(SIGNER, forwarded)] },
          FORWARDER,
          POOL,
          SIGNER,
          balances(AMOUNT, 7n, 7n + forwarded + withdrawal),
          "sweep",
        ),
      (error: Error) => {
        assert.match(
          error.message,
          /^FATAL: sweep transaction succeeded but the forwarder at 0x4444444444444444444444444444444444444444 forwarded only 25000000000000000 wei/,
        );
        assert.match(error.message, /of the 250000000000000000 wei .* it was holding/);
        assert.match(error.message, /225000000000000000 wei .* was not forwarded at all/);
        // It says why the pool's balance was not consulted.
        assert.match(error.message, /consensus withdrawal to the pool's credentials/);
        assert.match(error.message, /npm run status/);
        return true;
      },
    );

    // And the delta check on its own would have passed this: same balances, honest Swept.
    assert.doesNotThrow(() =>
      silently(() =>
        assertSweepWasCredited(
          { logs: [swept(SIGNER, AMOUNT)] },
          FORWARDER,
          POOL,
          SIGNER,
          balances(AMOUNT, 7n, 7n + forwarded + withdrawal),
          "sweep",
        ),
      ),
    );
  });

  it("is fatal when the pool is not richer by what the forwarder was holding", function () {
    for (const poolAfter of [0n, AMOUNT - 1n]) {
      assert.throws(
        () =>
          assertSweepWasCredited(
            { logs: [swept(SIGNER, AMOUNT)] },
            FORWARDER,
            POOL,
            SIGNER,
            balances(AMOUNT, 0n, poolAfter),
            "sweep",
          ),
        (error: Error) => {
          assert.match(error.message, /^FATAL: sweep transaction succeeded but the pool at /);
          assert.match(error.message, new RegExp(`${poolAfter} wei`));
          assert.match(error.message, /its Swept event says it forwarded 250000000000000000 wei/);
          assert.match(error.message, /DETECTS a sweep that did not land in the pool/);
          assert.match(error.message, /npm run status/);
          return true;
        },
      );
    }
  });

  it("reconciles a same-block claim or refund instead of accusing the sweep", function () {
    // The false FATAL this reconciliation exists for. `claim()` and `refund()` are
    // permissionless and callable at any moment, so one landing in the sweep's own block is
    // ordinary — and every wei it pays out comes off the same balance delta, which made a
    // sweep that landed in full look like a shortfall of exactly the amount somebody else
    // withdrew.
    const claimed = 100_000n;
    const refunded = 900_000n;
    const log = captureLog();
    try {
      assertSweepWasCredited(
        { logs: [swept(SIGNER, AMOUNT)] },
        FORWARDER,
        POOL,
        SIGNER,
        balances(AMOUNT, 7n, 7n + AMOUNT - claimed - refunded, [
          { event: "Claimed", amount: claimed },
          { event: "Refunded", amount: refunded },
        ]),
        "sweep",
      );
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /^sweep credit confirmed: /);
      // The pass says what had to be netted to reach it: "the numbers agree once you account
      // for X" is the operator's business, not an implementation detail.
      assert.match(
        log.lines[0],
        /after adding back the 1000000 wei .* the pool's own logs record leaving it in that block/,
      );
      assert.match(log.lines[0], /Claimed 100000 wei .*, Refunded 900000 wei/);
    } finally {
      log.restore();
    }
  });

  it("still fails a genuine shortfall, and says what the reconciliation could not explain", function () {
    // One wei short of the forwarder's balance AFTER every logged outflow is added back.
    // Nothing the pool recorded accounts for it, which is the finding.
    const claimed = 100_000n;
    assert.throws(
      () =>
        assertSweepWasCredited(
          { logs: [swept(SIGNER, AMOUNT)] },
          FORWARDER,
          POOL,
          SIGNER,
          balances(AMOUNT, 0n, AMOUNT - claimed - 1n, [{ event: "Claimed", amount: claimed }]),
          "sweep",
        ),
      (error: Error) => {
        assert.match(error.message, /^FATAL: sweep transaction succeeded but the pool at /);
        assert.match(error.message, /only 249999999999999999 wei/);
        assert.match(error.message, /after adding back the 100000 wei/);
        assert.match(error.message, /not explained by anything the pool logged/);
        return true;
      },
    );
  });

  it("counts every pool outflow event and nothing else", function () {
    // Decoded from raw logs the way the block's logs arrive, so the event set the
    // reconciliation trusts is pinned. A log from another contract is not the pool's, and a
    // pool event that moves no ETH out is not an outflow.
    assert.deepEqual(
      decodePoolOutflows(
        [
          poolPayout("Claimed", SIGNER, 5n),
          poolPayout("Refunded", OTHER_SIGNER, 7n),
          // Right event, wrong contract.
          poolPayout("Claimed", SIGNER, 11n, FORWARDER),
          // A pool event that is not an outflow at all.
          {
            address: POOL,
            topics: encodeEventTopics({ abi: POOL_EVENTS, eventName: "PoolToppedUp" }) as Hex[],
            data: "0x" as Hex,
          },
        ],
        POOL,
      ),
      [
        { event: "Claimed", amount: 5n },
        { event: "Refunded", amount: 7n },
      ],
    );
  });

  it("is fatal when the receipt carries no Swept for this signer at this forwarder", function () {
    for (const logs of [
      [],
      // The right event for somebody else's sweep.
      [swept(OTHER_SIGNER, AMOUNT)],
      // The right event, from a contract that is not the forwarder the record names.
      [swept(SIGNER, AMOUNT, OTHER_SIGNER)],
    ]) {
      assert.throws(
        () =>
          assertSweepWasCredited({ logs }, FORWARDER, POOL, SIGNER, balances(AMOUNT, 0n, AMOUNT), "sweep"),
        (error: Error) => {
          assert.match(error.message, /emitted no Swept event for /);
          assert.match(error.message, /did not do what the command is for/);
          return true;
        },
      );
    }
  });
});

describe("requireFundingAllocation", function () {
  function withAllocationEnv<T>(
    participants: string | undefined,
    targets: string | undefined,
    run: () => T,
  ): T {
    const originalParticipants = process.env.PARTICIPANTS;
    const originalTargets = process.env.FUNDING_TARGETS_GWEI;
    restoreEnv("PARTICIPANTS", participants);
    restoreEnv("FUNDING_TARGETS_GWEI", targets);
    try {
      return run();
    } finally {
      restoreEnv("PARTICIPANTS", originalParticipants);
      restoreEnv("FUNDING_TARGETS_GWEI", originalTargets);
    }
  }

  it("is fatal when PARTICIPANTS is unset or empty, and spells out the solo form", function () {
    for (const declared of [undefined, ""]) {
      withAllocationEnv(declared, "32000000000", () => {
        assert.throws(
          () => requireFundingAllocation("open-funding-attempt"),
          (error: Error) => {
            assert.match(error.message, /^open-funding-attempt: PARTICIPANTS is unset or empty/);
            // The default it replaces is named, so the error explains what would otherwise
            // have happened silently.
            assert.match(error.message, /used to default to the operator alone/);
            assert.match(error.message, /Nothing has been sent/);
            assert.match(
              error.message,
              /PARTICIPANTS=<operator address> FUNDING_TARGETS_GWEI=32000000000$/,
            );
            return true;
          },
        );
      });
    }
  });

  it("is fatal when FUNDING_TARGETS_GWEI is unset or empty, even with PARTICIPANTS set", function () {
    for (const declared of [undefined, ""]) {
      withAllocationEnv(SIGNER, declared, () => {
        assert.throws(
          () => requireFundingAllocation("open-funding-attempt"),
          (error: Error) => {
            assert.match(
              error.message,
              /^open-funding-attempt: FUNDING_TARGETS_GWEI is unset or empty/,
            );
            assert.match(error.message, /Nothing has been sent/);
            assert.match(
              error.message,
              /PARTICIPANTS=<operator address> FUNDING_TARGETS_GWEI=32000000000$/,
            );
            return true;
          },
        );
      });
    }
  });

  it("returns the declared allocation, including the deliberate single-participant one", function () {
    withAllocationEnv(SIGNER, "32000000000", () => {
      assert.deepEqual(requireFundingAllocation("open-funding-attempt"), {
        participants: [SIGNER],
        fundingTargetsGwei: [32_000_000_000n],
      });
    });
    withAllocationEnv(`${SIGNER}, ${OTHER_SIGNER}`, "16000000000, 16000000000", () => {
      assert.deepEqual(requireFundingAllocation("open-funding-attempt"), {
        participants: [SIGNER, OTHER_SIGNER],
        fundingTargetsGwei: [16_000_000_000n, 16_000_000_000n],
      });
    });
  });

  it("is fatal for a length mismatch, and for a non-canonical target", function () {
    withAllocationEnv(`${SIGNER},${OTHER_SIGNER}`, "32000000000", () => {
      assert.throws(
        () => requireFundingAllocation("open-funding-attempt"),
        /PARTICIPANTS lists 2 addresses and FUNDING_TARGETS_GWEI lists 1 target/,
      );
    });
    withAllocationEnv(SIGNER, "0x20", () => {
      assert.throws(
        () => requireFundingAllocation("open-funding-attempt"),
        /FUNDING_TARGETS_GWEI entry 0 "0x20" is not a canonical unsigned decimal integer/,
      );
    });
  });
});

describe("assertFundingWindowNotDeclared", function () {
  it("asserts nothing when the variable is unset or empty", function () {
    const original = process.env.FUNDING_WINDOW_SECONDS;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("FUNDING_WINDOW_SECONDS", value);
        assert.doesNotThrow(() => assertFundingWindowNotDeclared("open-funding-attempt"));
      }
    } finally {
      restoreEnv("FUNDING_WINDOW_SECONDS", original);
    }
  });

  it("is fatal for any declared value, including the deployed default", function () {
    const original = process.env.FUNDING_WINDOW_SECONDS;

    try {
      // The default is refused as loudly as an unusual value: an operator who typed the
      // number that happens to match is still expecting this command to decide it, and it
      // cannot. A well-formed value is refused for the same reason a malformed one is —
      // the failure is that the input has no effect, not that it could not be parsed.
      for (const value of ["86400", "0", "3600", "not-a-number"]) {
        process.env.FUNDING_WINDOW_SECONDS = value;
        assert.throws(
          () => assertFundingWindowNotDeclared("open-funding-attempt"),
          (error: Error) => {
            assert.match(
              error.message,
              new RegExp(`^open-funding-attempt: FUNDING_WINDOW_SECONDS is set to "${value}"`),
            );
            assert.match(error.message, /immutable fundingWindowDuration/);
            assert.match(error.message, /read from the environment by "npm run deploy" only/);
            assert.match(error.message, /strands this one's 1 ETH predeposit/);
            assert.match(error.message, /Nothing has been sent/);
            return true;
          },
        );
      }
    } finally {
      restoreEnv("FUNDING_WINDOW_SECONDS", original);
    }
  });
});

describe("the fee preview printed before signing", function () {
  /// Reproduces what hardhat's `AutomaticGasPriceHandler` would compute from the same
  /// responses, independently of the implementation:
  /// `maxFeePerGas = baseFeePerGas * 9^2 / 8^2` (three full blocks' worth of 1/8 growth),
  /// `maxPriorityFeePerGas` = the 50th-percentile reward.
  function feeClient(
    baseFeePerGas: bigint,
    reward: bigint | undefined,
    suggestedPriorityFee?: bigint,
  ) {
    const calls: { blockCount: number; rewardPercentiles: readonly number[] }[] = [];
    return {
      calls,
      getFeeHistory: async (args: { blockCount: number; rewardPercentiles: readonly number[] }) => {
        calls.push(args);
        return {
          baseFeePerGas: [baseFeePerGas - 1n, baseFeePerGas],
          gasUsedRatio: [0.5],
          oldestBlock: 1n,
          reward: reward === undefined ? undefined : [[reward]],
        };
      },
      estimateMaxPriorityFeePerGas: async () => {
        if (suggestedPriorityFee === undefined) throw new Error("eth_maxPriorityFeePerGas");
        return suggestedPriorityFee;
      },
    };
  }

  it("computes the fields hardhat will fill, from the next block's base fee", async function () {
    const client = feeClient(8_000_000_000n, 1_500_000_000n);

    const fees = await resolveSuggestedFees(client);

    assert.deepEqual(client.calls, [{ blockCount: 1, rewardPercentiles: [50] }]);
    assert.equal(fees.baseFeePerGas, 8_000_000_000n);
    assert.equal(fees.maxPriorityFeePerGas, 1_500_000_000n);
    // 8 gwei * 81 / 64.
    assert.equal(fees.maxFeePerGas, (8_000_000_000n * 81n) / 64n);
  });

  it("falls back the way hardhat does when the reward percentile reports zero", async function () {
    // The empty-chain case: every percentile is zero, so the node's own suggestion is asked
    // for next, and 1 wei is the floor when there is not one.
    assert.equal(
      (await resolveSuggestedFees(feeClient(1_000n, 0n, 7n))).maxPriorityFeePerGas,
      7n,
    );
    assert.equal((await resolveSuggestedFees(feeClient(1_000n, 0n))).maxPriorityFeePerGas, 1n);
    assert.equal((await resolveSuggestedFees(feeClient(1_000n, undefined))).maxPriorityFeePerGas, 1n);
  });

  it("keeps maxFeePerGas at or above the priority fee, as hardhat does", async function () {
    // A base fee far below an extreme priority fee. hardhat adds them rather than signing an
    // impossible pair, and the preview must print the same number the device will show.
    const fees = await resolveSuggestedFees(feeClient(1n, 500_000_000_000n));
    assert.equal(fees.maxFeePerGas, 500_000_000_000n + (1n * 81n) / 64n);
    assert.ok(fees.maxFeePerGas >= fees.maxPriorityFeePerGas);
  });

  it("prints all three fields, in gwei, and says the gas limit is not previewed", async function () {
    const log = captureLog();
    try {
      await printSuggestedFees(feeClient(8_000_000_000n, 1_500_000_000n), "fund");
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /fund fees, as this endpoint suggests them/);
      assert.match(log.lines[0], /base fee per gas: +8000000000 wei \(8 gwei\)/);
      assert.match(log.lines[0], /max priority fee per gas: +1500000000 wei \(1\.5 gwei\)/);
      assert.match(log.lines[0], /max fee per gas: +10125000000 wei \(10\.125 gwei\)/);
      assert.match(log.lines[0], /gas limit: +filled from eth_estimateGas/);
      // It is a preview, and says so: hardhat re-reads when it composes the transaction.
      assert.match(log.lines[0], /the signed values may differ by a block/);
    } finally {
      log.restore();
    }
  });

  it("never ends a run: an endpoint that cannot answer costs a line, not the command", async function () {
    const broken = {
      getFeeHistory: async () => {
        throw new Error("eth_feeHistory unsupported");
      },
      estimateMaxPriorityFeePerGas: async () => 1n,
    };
    const log = captureLog();
    try {
      await assert.doesNotReject(() => printSuggestedFees(broken, "sweep"));
      assert.match(log.lines[0], /sweep fees: could not be previewed \(eth_feeHistory unsupported\)/);
      assert.match(log.lines[0], /Hardhat will still fill them from this endpoint/);
    } finally {
      log.restore();
    }
  });
});

describe("requireFundingWindowSeconds", function () {
  const NAME = "FUNDING_WINDOW_SECONDS";

  function withWindow<T>(value: string | undefined, run: () => T): T {
    const original = process.env[NAME];
    restoreEnv(NAME, value);
    try {
      return run();
    } finally {
      restoreEnv(NAME, original);
    }
  }

  it("is fatal when unset or empty, and names the old default as the explicit form", function () {
    for (const value of [undefined, ""]) {
      assert.throws(
        () => withWindow(value, () => requireFundingWindowSeconds("deploy")),
        (error: Error) => {
          assert.match(error.message, /deploy: FUNDING_WINDOW_SECONDS is unset or empty/);
          // The reason it may not default: the value is permanent and it is the whole bound
          // on how long a listed participant can lock everyone else's capital.
          assert.match(error.message, /immutable fundingWindowDuration/);
          assert.match(error.message, /lock everyone else's capital/);
          assert.match(error.message, /Nothing has been deployed/);
          assert.match(error.message, /FUNDING_WINDOW_SECONDS=86400/);
          return true;
        },
      );
    }
  });

  it("refuses a window below one hour, which no attempt could be funded within", function () {
    for (const value of ["0", "1", "3599"]) {
      assert.throws(
        () => withWindow(value, () => requireFundingWindowSeconds("deploy")),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(`FUNDING_WINDOW_SECONDS is ${value}, outside the 3600\\.\\.31536000 seconds`),
          );
          assert.match(error.message, /Below one hour the window is unusable/);
          return true;
        },
      );
    }
  });

  it("refuses a window above one year, up to the value that bricks every attempt", function () {
    const uint256Max = (2n ** 256n - 1n).toString();
    for (const value of ["31536001", uint256Max]) {
      assert.throws(
        () => withWindow(value, () => requireFundingWindowSeconds("deploy")),
        (error: Error) => {
          assert.match(error.message, /outside the 3600\.\.31536000 seconds/);
          // The upper bound is not only about a lock that is too long: the deadline is
          // checked arithmetic, so a window near the uint256 maximum reverts every attempt.
          assert.match(error.message, /revert on overflow/);
          assert.match(error.message, /1 ETH predeposit is already stranded/);
          assert.match(error.message, /contracts\/ is frozen/);
          return true;
        },
      );
    }
  });

  it("accepts both bounds and the old default, and applies the canonical-decimal parser", function () {
    for (const value of ["3600", "86400", "31536000"]) {
      assert.equal(withWindow(value, () => requireFundingWindowSeconds("deploy")), BigInt(value));
    }
    // `0x15180` is 86400 and is not a form anyone means to type into a window.
    assert.throws(
      () => withWindow("0x15180", () => requireFundingWindowSeconds("deploy")),
      /FUNDING_WINDOW_SECONDS "0x15180" is not a canonical unsigned decimal integer/,
    );
  });
});

describe("assertExpectedForwarder", function () {
  const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;

  it("asserts nothing when the pin is unset or empty", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_FORWARDER", value);
        assert.doesNotThrow(() => assertExpectedForwarder(FORWARDER, "record"));
        assert.doesNotThrow(() => assertExpectedForwarder(OTHER_SIGNER, "record"));
      }
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("accepts the declared forwarder, case differences aside, and refuses any other", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = FORWARDER.toUpperCase().replace("0X", "0x");
      assert.doesNotThrow(() => assertExpectedForwarder(FORWARDER, "record"));
      assert.throws(
        () => assertExpectedForwarder(OTHER_SIGNER, "record"),
        (error: Error) => {
          assert.match(error.message, new RegExp(`names fee-recipient forwarder ${OTHER_SIGNER}`));
          assert.match(error.message, /declared EXPECTED_FORWARDER/);
          assert.match(error.message, /Nothing has been sent/);
          assert.match(error.message, /DEPLOYMENT_FILE selects that record/);
          return true;
        },
      );
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("is fatal for a malformed declaration rather than ignoring it", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      for (const value of ["not-an-address", "0x1234", FORWARDER.slice(0, -1), "0"]) {
        process.env.EXPECTED_FORWARDER = value;
        assert.throws(
          () => assertExpectedForwarder(FORWARDER, "record"),
          new RegExp(`EXPECTED_FORWARDER ${value} is not a 0x-prefixed 20-byte address`),
        );
      }
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("says something site-accurate about an address this run just deployed", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = FORWARDER;
      assert.throws(
        () => assertExpectedForwarder(OTHER_SIGNER, "fresh-deployment"),
        (error: Error) => {
          // No record named this address and a transaction HAS been sent, so neither the
          // record clause nor "Nothing has been sent" may appear.
          assert.match(error.message, /the forwarder this run just deployed is/);
          assert.match(error.message, /a fresh deployment cannot satisfy it/);
          assert.match(error.message, /deployed and unrecorded/);
          assert.doesNotMatch(error.message, /Nothing has been sent/);
          assert.doesNotMatch(error.message, /the deployment record .* names/);
          return true;
        },
      );
      // The matching case is silent at either site.
      assert.doesNotThrow(() => assertExpectedForwarder(FORWARDER, "fresh-deployment"));
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });
});

describe("assertFreshForwarderMatchesExpectedForwarder", function () {
  const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;

  it("asserts nothing when the pin is unset or empty", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_FORWARDER", value);
        assert.doesNotThrow(() => assertFreshForwarderMatchesExpectedForwarder());
      }
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("refuses any declaration, because a fresh deployment can never be one", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = FORWARDER;
      assert.throws(
        () => assertFreshForwarderMatchesExpectedForwarder(),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(`^deploy-forwarder: EXPECTED_FORWARDER is declared as ${FORWARDER}`),
          );
          assert.match(error.message, /deploys a NEW forwarder/);
          // Pre-broadcast, which is the whole difference from the pool's guard.
          assert.match(error.message, /Nothing has been sent/);
          // And the consequence an operator has to act on if they meant it: the old address
          // is still what the validator client pays.
          assert.match(error.message, /fee_recipient was configured to/);
          return true;
        },
      );
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("is fatal for a malformed declaration rather than ignoring it", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = "0x1234";
      assert.throws(
        () => assertFreshForwarderMatchesExpectedForwarder(),
        /EXPECTED_FORWARDER 0x1234 is not a 0x-prefixed 20-byte address/,
      );
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });
});

describe("assertExpectedForwarderRecorded", function () {
  const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;

  it("is fatal when the pin is declared and the record names no forwarder", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = FORWARDER;
      assert.throws(
        () => assertExpectedForwarderRecorded({}),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(`^EXPECTED_FORWARDER ${FORWARDER} is declared, but the deployment record `),
          );
          assert.match(error.message, /deployments\/latest\.json/);
          assert.match(error.message, /names no fee-recipient forwarder at all/);
          assert.match(error.message, /Nothing has been sent/);
          assert.match(error.message, /predates "npm run deploy-forwarder"/);
          return true;
        },
      );

      // The other direction: a record that names the declared forwarder satisfies it.
      assert.doesNotThrow(() =>
        assertExpectedForwarderRecorded({ feeRecipientForwarder: FORWARDER }),
      );
      assert.throws(
        () => assertExpectedForwarderRecorded({ feeRecipientForwarder: OTHER_SIGNER }),
        /not the declared EXPECTED_FORWARDER/,
      );
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("asserts nothing about a record with no forwarder when nothing is declared", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_FORWARDER", value);
        assert.doesNotThrow(() => assertExpectedForwarderRecorded({}));
        assert.doesNotThrow(() =>
          assertExpectedForwarderRecorded({ feeRecipientForwarder: FORWARDER }),
        );
      }
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("is fatal for a malformed declaration even when the record names no forwarder", function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = "0x1234";
      assert.throws(
        () => assertExpectedForwarderRecorded({}),
        /EXPECTED_FORWARDER 0x1234 is not a 0x-prefixed 20-byte address/,
      );
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });
});

describe("reportForwarderWithoutRefusing", function () {
  const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;

  /// A record with only the fields this helper reads. The rest of `DeploymentRecord` is the
  /// integrity gate's business, and that gate has already run by the time this is called.
  function record(feeRecipientForwarder?: Address) {
    return { pool: POOL, feeRecipientForwarder } as DeploymentRecord;
  }

  /// A client whose forwarder-facing reads all fail. `status` never reaches the authenticity
  /// layers in these tests — the balance read is the first of them and the point is that it,
  /// too, is inside the boundary.
  function clientWhoseBalanceReadFails(message: string): ForwarderReportClient {
    return {
      getBalance: async () => {
        throw new Error(message);
      },
      getChainId: async () => 1,
      getCode: async () => undefined,
      readContract: async () => {
        throw new Error("readContract must not be reached once the balance read has failed");
      },
    } as unknown as ForwarderReportClient;
  }

  async function run(
    client: ForwarderReportClient,
    deployment: DeploymentRecord,
  ): Promise<{ log: string[]; warn: string[] }> {
    const log = captureLog();
    const warn = captureWarn();
    try {
      await assert.doesNotReject(() => reportForwarderWithoutRefusing(client, deployment));
      return { log: log.lines, warn: warn.lines };
    } finally {
      log.restore();
      warn.restore();
    }
  }

  it("evaluates a mismatched EXPECTED_FORWARDER loudly, and does not throw", async function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = OTHER_SIGNER;
      const printed = await run(clientWhoseBalanceReadFails("unreachable"), record(FORWARDER));

      // The pin IS evaluated — a set pin that goes unevaluated is a check reported as passed —
      // and the finding is the same one every other command is fatal on.
      assert.deepEqual(printed.log, [`Fee recipient forwarder: ${FORWARDER}`]);
      assert.equal(printed.warn.length, 1);
      assert.match(printed.warn[0], new RegExp(`the fee-recipient forwarder at ${FORWARDER} did NOT check out`));
      assert.match(printed.warn[0], /not the declared EXPECTED_FORWARDER/);
      assert.match(printed.warn[0], /status signs nothing/);
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("evaluates the pin against a record naming no forwarder, and still does not throw", async function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      process.env.EXPECTED_FORWARDER = FORWARDER;
      const printed = await run(clientWhoseBalanceReadFails("unreachable"), record(undefined));

      assert.deepEqual(printed.log, ["Fee recipient forwarder: not configured"]);
      assert.equal(printed.warn.length, 1);
      assert.match(printed.warn[0], /the fee-recipient forwarder did NOT check out/);
      assert.match(printed.warn[0], /names no fee-recipient forwarder at all/);
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("is silent on a record with no forwarder and no declaration", async function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      delete process.env.EXPECTED_FORWARDER;
      const printed = await run(clientWhoseBalanceReadFails("unreachable"), record(undefined));

      assert.deepEqual(printed.log, ["Fee recipient forwarder: not configured"]);
      assert.deepEqual(printed.warn, []);
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("keeps the balance read inside the boundary: an unanswerable read costs a warning", async function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      delete process.env.EXPECTED_FORWARDER;
      const printed = await run(
        clientWhoseBalanceReadFails("eth_getBalance: connection refused"),
        record(FORWARDER),
      );

      // The address line is above the boundary and survives; the balance line is inside it and
      // is replaced by the finding. Nothing throws, so `status` goes on to exit 0.
      assert.deepEqual(printed.log, [`Fee recipient forwarder: ${FORWARDER}`]);
      assert.equal(printed.warn.length, 1);
      assert.match(printed.warn[0], /eth_getBalance: connection refused/);
      assert.match(printed.warn[0], new RegExp(`the fee-recipient forwarder at ${FORWARDER} did NOT check out`));
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });

  it("prints the balance before the authenticity check, which a codeless address fails", async function () {
    const original = process.env.EXPECTED_FORWARDER;

    try {
      delete process.env.EXPECTED_FORWARDER;
      const printed = await run(
        {
          getBalance: async () => 1_500_000_000_000_000_000n,
          getChainId: async () => 1,
          getCode: async () => undefined,
          readContract: async () => POOL,
        } as unknown as ForwarderReportClient,
        record(FORWARDER),
      );

      assert.deepEqual(printed.log, [
        `Fee recipient forwarder: ${FORWARDER}`,
        `Forwarder pending balance: ${formatWei(1_500_000_000_000_000_000n)}`,
      ]);
      assert.equal(printed.warn.length, 1);
      assert.match(printed.warn[0], new RegExp(`feeRecipientForwarder has no code at ${FORWARDER}`));
    } finally {
      restoreEnv("EXPECTED_FORWARDER", original);
    }
  });
});

describe("assertStillFundable", function () {
  const FUNDING = 2;
  const DEADLINE = 2_000n;
  const REVIEWED_ATTEMPT = 4n;
  const GWEI = 1_000_000_000n;

  function poolAt(
    state: number,
    remaining: bigint,
    overrides: { attempt?: bigint; targets?: Record<string, bigint> } = {},
  ) {
    const targets = overrides.targets ?? {};
    return {
      address: POOL,
      read: {
        state: async () => state,
        fundingAttempt: async () => overrides.attempt ?? REVIEWED_ATTEMPT,
        fundingDeadline: async () => DEADLINE,
        fundingRemainingWeiOf: async (_args: readonly [Address]) => remaining,
        fundingTargetWeiOf: async ([who]: readonly [Address]) => targets[who.toLowerCase()] ?? 0n,
        operator: async () => OTHER_SIGNER,
      },
    };
  }

  function blockAt(timestamp: bigint) {
    return { getBlock: async () => ({ number: 42n, timestamp }) };
  }

  it("passes and prints the re-read when funding is still open", async function () {
    const log = captureLog();
    try {
      await assertStillFundable(poolAt(FUNDING, 10n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT);
      assert.deepEqual(log.lines, [
        "Final re-read at block 42: state=2 remaining=10 wei (0.00000000000000001 ETH)",
        "Final re-read attempt: 4 (unchanged since the funding review)",
        "Final re-read deadline margin: 1000s",
      ]);
    } finally {
      log.restore();
    }
  });

  it("refuses once the pool has left the Funding state", async function () {
    // State 3 is ToppedUp, which is the one state where a plain transfer is accepted as
    // pool proceeds instead of reverting.
    for (const state of [0, 1, 3]) {
      await assert.rejects(
        assertStillFundable(poolAt(state, 10n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
        new RegExp(`Pool state changed to ${state}; funding is no longer open`),
      );
    }
  });

  it("refuses an attempt that was closed and reopened since the funding review", async function () {
    // Every other signal still looks fundable: the pool is in Funding, the deadline is
    // ahead, and the caller's allocation covers the amount. It is a different agreement.
    await assert.rejects(
      assertStillFundable(
        poolAt(FUNDING, 10n, { attempt: REVIEWED_ATTEMPT + 1n }),
        blockAt(1_000n),
        SIGNER,
        10n,
        REVIEWED_ATTEMPT,
      ),
      (error: Error) => {
        assert.match(error.message, /Funding attempt changed from 4 at the funding review to 5/);
        assert.match(error.message, /nothing was sent/);
        assert.match(error.message, /participant set, every funding target, and your own allocation/);
        assert.match(error.message, /Re-run "npm run fund"/);
        return true;
      },
    );

    // A stale review of an OLDER attempt is refused just as loudly.
    await assert.rejects(
      assertStillFundable(
        poolAt(FUNDING, 10n, { attempt: REVIEWED_ATTEMPT }),
        blockAt(1_000n),
        SIGNER,
        10n,
        REVIEWED_ATTEMPT - 1n,
      ),
      /Funding attempt changed from 3 at the funding review to 4/,
    );
  });

  it("re-evaluates every EXPECTED_ pin against state read now, not at the review", async function () {
    const originals = {
      attempt: process.env.EXPECTED_FUNDING_ATTEMPT,
      deadline: process.env.EXPECTED_DEADLINE_BEFORE,
      mine: process.env.EXPECTED_MY_TARGET_GWEI,
      operator: process.env.EXPECTED_OPERATOR_TARGET_GWEI,
    };
    const targets = { [SIGNER.toLowerCase()]: 16n * GWEI * GWEI, [OTHER_SIGNER.toLowerCase()]: 16n * GWEI * GWEI };
    const pool = poolAt(FUNDING, 10n, { targets });

    try {
      for (const [name, value, expected] of [
        ["EXPECTED_FUNDING_ATTEMPT", "9", /Final re-read: funding attempt 4 != EXPECTED_FUNDING_ATTEMPT 9/],
        ["EXPECTED_DEADLINE_BEFORE", "1999", /Final re-read: funding deadline 2000 is after EXPECTED_DEADLINE_BEFORE 1999/],
        ["EXPECTED_MY_TARGET_GWEI", "8000000000", /Final re-read: caller target .* != EXPECTED_MY_TARGET_GWEI 8000000000/],
        [
          "EXPECTED_OPERATOR_TARGET_GWEI",
          "8000000000",
          /Final re-read: operator target .* != EXPECTED_OPERATOR_TARGET_GWEI 8000000000/,
        ],
      ] as const) {
        delete process.env.EXPECTED_FUNDING_ATTEMPT;
        delete process.env.EXPECTED_DEADLINE_BEFORE;
        delete process.env.EXPECTED_MY_TARGET_GWEI;
        delete process.env.EXPECTED_OPERATOR_TARGET_GWEI;
        process.env[name] = value;

        await assert.rejects(
          assertStillFundable(pool, blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
          expected,
        );
      }

      // The pins that hold are silent, and the caller's and operator's targets are read
      // separately: the operator's comes from `operator()`, not from the caller.
      process.env.EXPECTED_FUNDING_ATTEMPT = "4";
      process.env.EXPECTED_DEADLINE_BEFORE = "2000";
      process.env.EXPECTED_MY_TARGET_GWEI = "16000000000";
      process.env.EXPECTED_OPERATOR_TARGET_GWEI = "16000000000";
      await assert.doesNotReject(
        silentlyAsync(() => assertStillFundable(pool, blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT)),
      );
    } finally {
      restoreEnv("EXPECTED_FUNDING_ATTEMPT", originals.attempt);
      restoreEnv("EXPECTED_DEADLINE_BEFORE", originals.deadline);
      restoreEnv("EXPECTED_MY_TARGET_GWEI", originals.mine);
      restoreEnv("EXPECTED_OPERATOR_TARGET_GWEI", originals.operator);
    }
  });

  it("re-checks EXPECTED_POOL against the contract the transaction is about to go to", async function () {
    const original = process.env.EXPECTED_POOL;

    try {
      process.env.EXPECTED_POOL = OTHER_SIGNER;
      await assert.rejects(
        assertStillFundable(poolAt(FUNDING, 10n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
        (error: Error) => {
          assert.match(error.message, /^Final re-read: the deployment record /);
          assert.match(error.message, new RegExp(`names pool ${POOL}`));
          return true;
        },
      );

      process.env.EXPECTED_POOL = POOL;
      await assert.doesNotReject(
        silentlyAsync(() =>
          assertStillFundable(poolAt(FUNDING, 10n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
        ),
      );
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });

  it("refuses at and after the funding deadline", async function () {
    for (const timestamp of [DEADLINE, DEADLINE + 1n]) {
      await assert.rejects(
        assertStillFundable(poolAt(FUNDING, 10n), blockAt(timestamp), SIGNER, 10n, REVIEWED_ATTEMPT),
        new RegExp(`Funding deadline ${DEADLINE} has passed at block timestamp ${timestamp}`),
      );
    }
    await assert.doesNotReject(
      silentlyAsync(() =>
        assertStillFundable(poolAt(FUNDING, 10n), blockAt(DEADLINE - 1n), SIGNER, 10n, REVIEWED_ATTEMPT),
      ),
    );
  });

  it("refuses an amount above the remaining allocation, and allows exactly it", async function () {
    await assert.rejects(
      assertStillFundable(poolAt(FUNDING, 9n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
      /Remaining funding cap dropped to 9 wei .*; 10 wei .* would revert/,
    );
    await assert.doesNotReject(
      silentlyAsync(() =>
        assertStillFundable(poolAt(FUNDING, 10n), blockAt(1_000n), SIGNER, 10n, REVIEWED_ATTEMPT),
      ),
    );
  });
});

describe("assertContractPredepositWei", function () {
  const ONE_ETH = 1_000_000_000_000_000_000n;

  it("accepts a pool that agrees with the audited contract's 1 ether", function () {
    assert.equal(PREDEPOSIT_WEI, ONE_ETH);
    assert.doesNotThrow(() => assertContractPredepositWei(ONE_ETH, "commit-predeposit"));
  });

  it("is fatal on any divergence, because the amount is no longer the chain's to choose", function () {
    // The command sends the local constant. A pool reporting something else is not the
    // contract this checkout builds, whatever else agreed.
    for (const reported of [0n, 1n, ONE_ETH - 1n, ONE_ETH + 1n, 31n * ONE_ETH]) {
      assert.throws(
        () => assertContractPredepositWei(reported, "commit-predeposit"),
        (error: Error) => {
          assert.match(error.message, /^commit-predeposit: the pool reports PREDEPOSIT_WEI /);
          assert.match(error.message, new RegExp(`${reported} wei`));
          assert.match(error.message, new RegExp(`audited contract declares ${ONE_ETH} wei`));
          assert.match(error.message, /Nothing has been sent/);
          assert.match(error.message, /do not send capital to it/);
          return true;
        },
      );
    }
  });
});

describe("assertCommittedPubkeyMatchesLocal", function () {
  const PUBKEY = `0x${"aa".repeat(48)}` as Hex;
  const OTHER_PUBKEY = `0x${"bb".repeat(48)}` as Hex;

  function predepositEntry(pubkey: string) {
    return {
      pubkey,
      withdrawal_credentials: `0x${"00".repeat(32)}`,
      amount: "1000000000",
      signature: `0x${"cc".repeat(96)}`,
      deposit_data_root: `0x${"dd".repeat(32)}`,
    };
  }

  it("returns the local pubkey when the chain's commitment matches it", function () {
    assert.equal(
      assertCommittedPubkeyMatchesLocal(PUBKEY, predepositEntry(PUBKEY), "top-up"),
      PUBKEY,
    );
    // Neither side has a guaranteed case on the wire, and the file may omit the 0x.
    assert.equal(
      assertCommittedPubkeyMatchesLocal(
        PUBKEY.toUpperCase().replace("0X", "0x") as Hex,
        predepositEntry(PUBKEY.slice(2)),
        "top-up",
      ),
      PUBKEY,
    );
  });

  it("is fatal when the endpoint's committed pubkey is not the local file's, naming both", function () {
    assert.throws(
      () => assertCommittedPubkeyMatchesLocal(OTHER_PUBKEY, predepositEntry(PUBKEY), "top-up"),
      (error: Error) => {
        assert.match(error.message, new RegExp(`^top-up: the pool reports committedPubkey ${OTHER_PUBKEY}`));
        assert.match(error.message, new RegExp(`1 ETH predeposit entry is for ${PUBKEY}`));
        assert.match(error.message, /Nothing has been sent/);
        assert.match(error.message, /DEPOSIT_DATA_FILE and DEPLOYMENT_FILE/);
        return true;
      },
    );
  });

  it("is fatal for a local entry that is not a 48-byte pubkey at all", function () {
    for (const pubkey of ["", "0xnothex", `0x${"aa".repeat(47)}`]) {
      assert.throws(
        () => assertCommittedPubkeyMatchesLocal(PUBKEY, predepositEntry(pubkey), "top-up"),
        /deposit-data predeposit pubkey (is not hex|must be 48 bytes)/,
      );
    }
  });

  describe("the request-exit form, which must not gain a hard file dependency", function () {
    const workdir = mkdtempSync(path.join(tmpdir(), "validator-funding-pool-exit-"));

    function depositDataFile(name: string, contents: string): string {
      const file = path.join(workdir, name);
      writeFileSync(file, contents);
      return file;
    }

    function withDepositDataFile<T>(file: string, run: () => T): T {
      const original = process.env.DEPOSIT_DATA_FILE;
      process.env.DEPOSIT_DATA_FILE = file;
      try {
        return run();
      } finally {
        restoreEnv("DEPOSIT_DATA_FILE", original);
      }
    }

    function entriesFor(pubkey: string): string {
      return JSON.stringify([
        { ...predepositEntry(pubkey) },
        { ...predepositEntry(pubkey), amount: "31000000000" },
      ]);
    }

    it("makes the same comparison when the file is there", function () {
      const file = depositDataFile("matching.json", entriesFor(PUBKEY));

      assert.equal(
        withDepositDataFile(file, () =>
          silently(() => assertCommittedPubkeyMatchesLocalIfReadable(PUBKEY, "request-exit")),
        ),
        PUBKEY,
      );

      const wrong = depositDataFile("other-validator.json", entriesFor(OTHER_PUBKEY));
      assert.throws(
        () =>
          withDepositDataFile(wrong, () =>
            silently(() => assertCommittedPubkeyMatchesLocalIfReadable(PUBKEY, "request-exit")),
          ),
        /request-exit: the pool reports committedPubkey /,
      );
    });

    it("warns and proceeds on the RPC's value when the file is missing or malformed", function () {
      const cases = [
        path.join(workdir, "does-not-exist.json"),
        depositDataFile("not-json.json", "{"),
        // Readable JSON with no 1 ETH entry: unusable for the comparison, same as absent.
        depositDataFile("no-predeposit.json", "[]"),
      ];

      for (const file of cases) {
        const log = captureLog();
        const warn = captureWarn();
        let result: Hex;
        try {
          result = withDepositDataFile(file, () =>
            assertCommittedPubkeyMatchesLocalIfReadable(PUBKEY, "request-exit"),
          );
        } finally {
          warn.restore();
          log.restore();
        }

        assert.equal(result, PUBKEY);
        assert.equal(warn.lines.length, 1);
        assert.match(warn.lines[0], /could not read the deposit-data file /);
        assert.match(warn.lines[0], /Continuing with the committedPubkey\(\) the EL RPC reported/);
        assert.match(warn.lines[0], /must not be able to disable it/);
      }
    });
  });
});

describe("assertExpectedPubkey", function () {
  const PUBKEY = `0x${"aa".repeat(48)}` as Hex;
  const OTHER_PUBKEY = `0x${"bb".repeat(48)}` as Hex;

  /// Runs the announcement with both channels captured, so a test can decide on what the
  /// operator reads as well as on whether it threw.
  function announce(pubkey: string): { lines: string[]; warnings: string[]; pubkey: Hex } {
    const log = captureLog();
    const warn = captureWarn();
    try {
      return {
        pubkey: assertExpectedPubkey(pubkey, "commit-predeposit"),
        lines: log.lines,
        warnings: warn.lines,
      };
    } finally {
      warn.restore();
      log.restore();
    }
  }

  it("warns loudly, and does not refuse, when no pubkey is declared", function () {
    const original = process.env.EXPECTED_PUBKEY;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_PUBKEY", value);
        const { pubkey, lines, warnings } = announce(PUBKEY);

        assert.equal(pubkey, PUBKEY);
        // The pubkey is printed either way: it is what the command is about to bind the pool
        // to, permanently.
        assert.ok(lines.some((line) => line.includes(`WILL COMMIT VALIDATOR ${PUBKEY}`)));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /WARNING: EXPECTED_PUBKEY is not set/);
        assert.match(warnings[0], /IRREVERSIBLE/);
        assert.match(warnings[0], /DEPOSIT_DATA_FILE chose that file/);
      }
    } finally {
      restoreEnv("EXPECTED_PUBKEY", original);
    }
  });

  it("accepts the declared pubkey, prefix and case differences aside, and does not warn", function () {
    const original = process.env.EXPECTED_PUBKEY;

    try {
      // Deposit-data files are written both with and without the 0x prefix, and the operator
      // copies the value out of theirs.
      for (const declared of [PUBKEY, PUBKEY.slice(2), PUBKEY.toUpperCase().replace("0X", "0x")]) {
        process.env.EXPECTED_PUBKEY = declared;
        const { pubkey, lines, warnings } = announce(PUBKEY.slice(2));

        assert.equal(pubkey, PUBKEY);
        assert.deepEqual(warnings, []);
        assert.ok(
          lines.some((line) => line.includes("equals the declared EXPECTED_PUBKEY")),
          `no confirmation line in ${JSON.stringify(lines)}`,
        );
      }
    } finally {
      restoreEnv("EXPECTED_PUBKEY", original);
    }
  });

  it("is fatal when the file would commit a different validator, naming both and the file", function () {
    const original = process.env.EXPECTED_PUBKEY;
    const originalFile = process.env.DEPOSIT_DATA_FILE;

    try {
      process.env.EXPECTED_PUBKEY = PUBKEY;
      process.env.DEPOSIT_DATA_FILE = "/tmp/some-other-validator.json";
      assert.throws(
        () => announce(OTHER_PUBKEY),
        (error: Error) => {
          assert.match(error.message, /^commit-predeposit: the deposit-data file /);
          assert.match(error.message, new RegExp(`/tmp/some-other-validator.json would commit validator ${OTHER_PUBKEY}`));
          assert.match(error.message, new RegExp(`declared EXPECTED_PUBKEY ${PUBKEY}`));
          assert.match(error.message, /Nothing has been sent/);
          assert.match(error.message, /DEPOSIT_DATA_FILE selects/);
          return true;
        },
      );
    } finally {
      restoreEnv("EXPECTED_PUBKEY", original);
      restoreEnv("DEPOSIT_DATA_FILE", originalFile);
    }
  });

  it("is fatal for a malformed declaration rather than ignoring it", function () {
    const original = process.env.EXPECTED_PUBKEY;

    try {
      for (const value of ["not-hex", "0x1234", PUBKEY.slice(0, -2), `${PUBKEY}aa`, "0"]) {
        process.env.EXPECTED_PUBKEY = value;
        assert.throws(
          () => announce(PUBKEY),
          new RegExp(`EXPECTED_PUBKEY ${value} is not a 48-byte BLS public key`),
        );
      }
    } finally {
      restoreEnv("EXPECTED_PUBKEY", original);
    }
  });

  it("is fatal for a local entry that is not a 48-byte pubkey at all", function () {
    const original = process.env.EXPECTED_PUBKEY;

    try {
      delete process.env.EXPECTED_PUBKEY;
      for (const pubkey of ["", "0xnothex", `0x${"aa".repeat(47)}`]) {
        assert.throws(
          () => announce(pubkey),
          /deposit-data predeposit pubkey (is not hex|must be 48 bytes)/,
        );
      }
    } finally {
      restoreEnv("EXPECTED_PUBKEY", original);
    }
  });
});

describe("assertDeploymentRecordShape", function () {
  const FILE = "deployments/latest.json";
  const HASH = `0x${"ab".repeat(32)}`;

  function validRecord(): Record<string, unknown> {
    return {
      chainId: 1,
      pool: POOL,
      depositContract: SIGNER,
      depositContractCodeHash: HASH,
      withdrawalRequestPredeploy: OTHER_SIGNER,
      withdrawalRequestPredeployCodeHash: HASH,
      operator: SIGNER,
      fundingWindowDuration: "86400",
      withdrawalCredentials: `0x01${"00".repeat(11)}${POOL.slice(2)}`,
    };
  }

  it("accepts a record the commands wrote, with and without a forwarder", function () {
    assert.doesNotThrow(() => assertDeploymentRecordShape(validRecord(), FILE));
    assert.doesNotThrow(() =>
      assertDeploymentRecordShape({ ...validRecord(), feeRecipientForwarder: SIGNER }, FILE),
    );
    // Returned unchanged: the check narrows a parse, it does not rewrite one.
    assert.deepEqual(assertDeploymentRecordShape(validRecord(), FILE), validRecord());
  });

  it("refuses anything that is not a JSON object at all", function () {
    for (const value of [null, 42, "0x", [], undefined]) {
      assert.throws(
        () => assertDeploymentRecordShape(value, FILE),
        new RegExp(`The deployment record ${FILE} is .*, not a JSON object`),
      );
    }
  });

  it("names the field and what it found, for every field a check later reads", function () {
    const cases: [string, unknown, RegExp][] = [
      ["chainId", "1", /has chainId "1", which is not a positive integer/],
      ["chainId", 0, /has chainId 0, which is not a positive integer/],
      ["chainId", 1.5, /has chainId 1.5, which is not a positive integer/],
      ["pool", "0x1234", /has pool "0x1234", which is not a 0x-prefixed 20-byte address/],
      ["operator", undefined, /has operator <missing>, which is not a 0x-prefixed 20-byte address/],
      [
        "depositContractCodeHash",
        "0xabcd",
        /has depositContractCodeHash "0xabcd", which is not a 32-byte 0x-prefixed hex string/,
      ],
      [
        "withdrawalCredentials",
        null,
        /has withdrawalCredentials null, which is not a 32-byte 0x-prefixed hex string/,
      ],
      [
        "fundingWindowDuration",
        86_400,
        /has fundingWindowDuration 86400, which is not a string/,
      ],
      // The same canonical-decimal parser every amount goes through: "0x15180" is 86400 and
      // is not the form anything here writes.
      [
        "fundingWindowDuration",
        "0x15180",
        /fundingWindowDuration "0x15180" is not a canonical unsigned decimal integer/,
      ],
    ];

    for (const [field, value, expected] of cases) {
      assert.throws(
        () => assertDeploymentRecordShape({ ...validRecord(), [field]: value }, FILE),
        expected,
        `${field}=${JSON.stringify(value)}`,
      );
    }
  });

  it("refuses a null forwarder outright, which no undefined comparison would have caught", function () {
    assert.throws(
      () => assertDeploymentRecordShape({ ...validRecord(), feeRecipientForwarder: null }, FILE),
      (error: Error) => {
        assert.match(error.message, /has feeRecipientForwarder: null/);
        assert.match(error.message, /null is neither/);
        assert.match(error.message, /as if it were an address/);
        return true;
      },
    );
    // An explicit `undefined` is the same as an absent field, which is what the record looks
    // like before `deploy-forwarder` runs.
    assert.doesNotThrow(() =>
      assertDeploymentRecordShape({ ...validRecord(), feeRecipientForwarder: undefined }, FILE),
    );
    assert.throws(
      () => assertDeploymentRecordShape({ ...validRecord(), feeRecipientForwarder: "0x00" }, FILE),
      /has feeRecipientForwarder "0x00", which is not a 0x-prefixed 20-byte address/,
    );
  });
});

describe("assertExpectedPool", function () {
  // `DEPLOYMENT_FILE` selects the record, and the record selects the pool every other check
  // is made about. This is the only declaration that catches a record naming a pool the
  // operator did not mean.
  it("asserts nothing when the pin is unset or empty", function () {
    const original = process.env.EXPECTED_POOL;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_POOL", value);
        assert.doesNotThrow(() => assertExpectedPool(POOL, "Deployment record"));
        assert.doesNotThrow(() => assertExpectedPool(OTHER_SIGNER, "Deployment record"));
      }
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });

  it("accepts the declared pool, case differences aside", function () {
    const original = process.env.EXPECTED_POOL;

    try {
      process.env.EXPECTED_POOL = POOL;
      assert.doesNotThrow(() => assertExpectedPool(POOL, "Deployment record"));
      assert.doesNotThrow(() =>
        assertExpectedPool(POOL.toUpperCase().replace("0X", "0x") as Address, "Final re-read"),
      );
      process.env.EXPECTED_POOL = POOL.toUpperCase().replace("0X", "0x");
      assert.doesNotThrow(() => assertExpectedPool(POOL, "Deployment record"));
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });

  it("is fatal for a record naming a different pool, and names the moment", function () {
    const original = process.env.EXPECTED_POOL;

    try {
      process.env.EXPECTED_POOL = POOL;
      for (const where of ["Deployment record", "Final re-read"]) {
        assert.throws(
          () => assertExpectedPool(OTHER_SIGNER, where),
          (error: Error) => {
            assert.match(error.message, new RegExp(`^${where}: the deployment record `));
            assert.match(error.message, new RegExp(`names pool ${OTHER_SIGNER}`));
            assert.match(error.message, new RegExp(`declared EXPECTED_POOL ${POOL}`));
            assert.match(error.message, /Nothing has been sent/);
            assert.match(error.message, /DEPLOYMENT_FILE selects/);
            return true;
          },
        );
      }
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });

  it("is fatal for a malformed declaration rather than ignoring it", function () {
    const original = process.env.EXPECTED_POOL;

    try {
      // A pin that cannot be parsed has not been declared. Ignoring one reports a pass for a
      // check that never ran, which is worse than no pin at all.
      for (const value of ["not-an-address", "0x1234", POOL.slice(0, -1), `${POOL}00`, "0"]) {
        process.env.EXPECTED_POOL = value;
        assert.throws(
          () => assertExpectedPool(POOL, "Deployment record"),
          new RegExp(`EXPECTED_POOL ${value} is not a 0x-prefixed 20-byte address`),
        );
      }
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });
});

describe("assertFreshDeploymentMatchesExpectedPool", function () {
  it("asserts nothing when the pin is unset or empty", function () {
    const original = process.env.EXPECTED_POOL;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_POOL", value);
        assert.doesNotThrow(() => assertFreshDeploymentMatchesExpectedPool(POOL));
      }
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });

  it("refuses to record a new pool while a different one is declared", function () {
    // `deploy` writes the record every other command's EXPECTED_POOL is checked against. A
    // declaration still in the environment says the operator means the pool they already
    // have, and this run was about to replace its record with a second pool's.
    const original = process.env.EXPECTED_POOL;

    try {
      process.env.EXPECTED_POOL = POOL;
      assert.throws(
        () => assertFreshDeploymentMatchesExpectedPool(OTHER_SIGNER),
        (error: Error) => {
          assert.match(error.message, new RegExp(`^deploy: EXPECTED_POOL is declared as ${POOL}`));
          assert.match(error.message, new RegExp(`deployed a NEW pool at ${OTHER_SIGNER}`));
          assert.match(error.message, /stranded the existing pool's 1 ETH predeposit/);
          assert.match(error.message, /The record has NOT been written/);
          return true;
        },
      );

      // The declared address itself is not refused: the check is a comparison, not a ban on
      // running `deploy` with the variable set.
      assert.doesNotThrow(() => assertFreshDeploymentMatchesExpectedPool(POOL));
      assert.doesNotThrow(() =>
        assertFreshDeploymentMatchesExpectedPool(POOL.toUpperCase().replace("0X", "0x") as Address),
      );

      // And a declaration that cannot be parsed is fatal here too.
      process.env.EXPECTED_POOL = "0x1234";
      assert.throws(
        () => assertFreshDeploymentMatchesExpectedPool(POOL),
        /EXPECTED_POOL 0x1234 is not a 0x-prefixed 20-byte address/,
      );
    } finally {
      restoreEnv("EXPECTED_POOL", original);
    }
  });
});

describe("unsigned decimal environment values", function () {
  const rejected = ["0x20", "+5", "-5", " 5", "5 ", "5_0", "05", "1e3", "", "five", "1.0"];

  it("requires a canonical unsigned decimal from envBigInt and names the variable", function () {
    const original = process.env.AMOUNT_WEI;

    try {
      for (const value of rejected) {
        process.env.AMOUNT_WEI = value;
        if (value === "") {
          // An empty value is an unset value, and falls back.
          assert.equal(envBigInt("AMOUNT_WEI", 7n), 7n);
          continue;
        }
        assert.throws(
          () => envBigInt("AMOUNT_WEI", 7n),
          /AMOUNT_WEI ".*" is not a canonical unsigned decimal integer/,
        );
      }

      for (const value of ["0", "5", "31000000000000000000"]) {
        process.env.AMOUNT_WEI = value;
        assert.equal(envBigInt("AMOUNT_WEI"), BigInt(value));
      }
    } finally {
      restoreEnv("AMOUNT_WEI", original);
    }
  });

  it("applies the same parser to a declare-and-verify pin, with no fallback", function () {
    const original = process.env.EXPECTED_FUNDING_ATTEMPT;

    try {
      for (const value of [undefined, ""]) {
        restoreEnv("EXPECTED_FUNDING_ATTEMPT", value);
        assert.equal(optionalEnvBigInt("EXPECTED_FUNDING_ATTEMPT"), undefined);
      }

      // `BigInt` accepted every one of these; each compares unequal to the number the
      // operator meant, and `""` was `0n`.
      for (const value of rejected.filter((entry) => entry !== "")) {
        process.env.EXPECTED_FUNDING_ATTEMPT = value;
        assert.throws(
          () => optionalEnvBigInt("EXPECTED_FUNDING_ATTEMPT"),
          /EXPECTED_FUNDING_ATTEMPT ".*" is not a canonical unsigned decimal integer/,
        );
      }

      process.env.EXPECTED_FUNDING_ATTEMPT = "3";
      assert.equal(optionalEnvBigInt("EXPECTED_FUNDING_ATTEMPT"), 3n);
    } finally {
      restoreEnv("EXPECTED_FUNDING_ATTEMPT", original);
    }
  });

  it("requires the same of every entry of a list, and names the entry", function () {
    assert.deepEqual(parseBigIntList("1,2, 3 ,0", "FUNDING_TARGETS_GWEI"), [1n, 2n, 3n, 0n]);
    assert.throws(
      () => parseBigIntList("1,0x20", "FUNDING_TARGETS_GWEI"),
      /FUNDING_TARGETS_GWEI entry 1 "0x20" is not a canonical unsigned decimal integer/,
    );
    assert.throws(
      () => parseBigIntList("+1,2", "FUNDING_TARGETS_GWEI"),
      /FUNDING_TARGETS_GWEI entry 0 "\+1" is not a canonical unsigned decimal integer/,
    );
    assert.throws(
      () => parseBigIntList("1,,2", "FUNDING_TARGETS_GWEI"),
      /FUNDING_TARGETS_GWEI entry 1 "" is not a canonical unsigned decimal integer/,
    );
  });
});

describe("beaconApiUrl", function () {
  const ROUTE = "/eth/v1/beacon/states/head/validators";

  it("keeps a path prefix, with or without a trailing slash, and on a bare host", function () {
    assert.equal(
      beaconApiUrl("https://host/eth-beacon-node/deadbeef", ROUTE).href,
      "https://host/eth-beacon-node/deadbeef/eth/v1/beacon/states/head/validators",
    );
    assert.equal(
      beaconApiUrl("https://host/eth-beacon-node/deadbeef/", ROUTE).href,
      "https://host/eth-beacon-node/deadbeef/eth/v1/beacon/states/head/validators",
    );
    for (const base of ["https://host", "https://host/"]) {
      assert.equal(
        beaconApiUrl(base, ROUTE).href,
        "https://host/eth/v1/beacon/states/head/validators",
      );
    }
  });

  it("keeps the base's query, which is where hosted endpoints put the API key", function () {
    const url = beaconApiUrl("https://host/prefix?apikey=deadbeef", ROUTE);

    assert.equal(url.pathname, "/prefix/eth/v1/beacon/states/head/validators");
    assert.equal(url.searchParams.get("apikey"), "deadbeef");
    assert.equal(url.href, "https://host/prefix/eth/v1/beacon/states/head/validators?apikey=deadbeef");
  });

  it("merges a route parameter into the base's query rather than replacing it", function () {
    const url = beaconApiUrl("https://host/prefix?apikey=deadbeef&team=ops", ROUTE);
    url.searchParams.set("id", "0xabc");

    assert.equal(url.searchParams.get("apikey"), "deadbeef");
    assert.equal(url.searchParams.get("team"), "ops");
    assert.equal(url.searchParams.get("id"), "0xabc");
  });

  it("keeps a query on a bare host too, and drops only the fragment", function () {
    assert.equal(
      beaconApiUrl("https://host?apikey=deadbeef", ROUTE).href,
      "https://host/eth/v1/beacon/states/head/validators?apikey=deadbeef",
    );
    assert.equal(
      beaconApiUrl("https://host/prefix?apikey=deadbeef#note", ROUTE).href,
      "https://host/prefix/eth/v1/beacon/states/head/validators?apikey=deadbeef",
    );
  });

  it("rejects a base that is not a URL instead of composing a wrong one", function () {
    assert.throws(() => beaconApiUrl("beacon.example", ROUTE));
    assert.throws(() => beaconApiUrl("", ROUTE));
  });
});

describe("assertDeployedAt", function () {
  it("accepts a receipt that created the predicted contract", function () {
    assert.doesNotThrow(() =>
      assertDeployedAt(POOL.toUpperCase().replace("0X", "0x") as Address, POOL, "ValidatorFundingPool"),
    );
  });

  it("is fatal for a different address, a null, and a missing one", function () {
    for (const created of [OTHER_SIGNER, null, undefined]) {
      assert.throws(
        () => assertDeployedAt(created, POOL, "ValidatorFundingPool"),
        /ValidatorFundingPool deployment receipt created a contract at/,
      );
    }
  });
});

describe("describeFatalError", function () {
  /// One level of a viem error object. viem's error classes are ordinary objects carrying
  /// these fields plus a `cause`, so a literal is structurally what the walker sees.
  function viemLevel(fields: Record<string, unknown>): Record<string, unknown> {
    return fields;
  }

  it("prints an ordinary Error's message in full", function () {
    // Errors raised by this codebase ARE the guidance: their whole text is actionable and
    // none of it may be trimmed to a first line.
    const message =
      "fund head beacon validator balance changed from 1000000000 Gwei at the preflight to " +
      "2000000000 Gwei immediately before broadcast; nothing was sent. Re-run this command " +
      "so the preflight decides on the state that exists now";
    assert.deepEqual(describeFatalError(new Error(message)), [message]);
  });

  it("summarises a viem revert and hoists the decoded custom error to the top", function () {
    const lines = describeFatalError(
      viemLevel({
        // The long `message` a viem error carries is the one with the ABI in it. It is
        // never printed when a `shortMessage` exists.
        message: `The contract function "closeExpiredFundingAttempt" reverted.\n\n${"abi ".repeat(400)}`,
        shortMessage: 'The contract function "closeExpiredFundingAttempt" reverted.',
        functionName: "closeExpiredFundingAttempt",
        contractAddress: POOL,
        sender: SIGNER,
        details:
          "VM Exception while processing transaction: reverted with custom error 'FundingStillOpen()'",
        cause: viemLevel({
          shortMessage: 'The contract function "closeExpiredFundingAttempt" reverted.',
          data: { errorName: "FundingStillOpen", args: [] },
        }),
      }),
    );

    assert.deepEqual(lines, [
      'The contract function "closeExpiredFundingAttempt" reverted.',
      "Contract error: FundingStillOpen()",
      `Contract call: closeExpiredFundingAttempt() at ${POOL}`,
      `Sender: ${SIGNER}`,
      "Details: VM Exception while processing transaction: reverted with custom error 'FundingStillOpen()'",
    ]);
    assert.ok(!lines.some((line) => line.includes("abi abi")));
  });

  it("renders a custom error's arguments, which are what say how far off the value was", function () {
    const lines = describeFatalError(
      viemLevel({
        shortMessage: 'The contract function "requestExit" reverted.',
        cause: viemLevel({ data: { errorName: "ExitFeeTooHigh", args: [3n, 2n] } }),
      }),
    );
    assert.ok(lines.includes("Contract error: ExitFeeTooHigh(3, 2)"));
  });

  it("does not loop on a cyclic cause chain", function () {
    const outer: Record<string, unknown> = { shortMessage: "outer" };
    const inner: Record<string, unknown> = { shortMessage: "inner", cause: outer };
    outer.cause = inner;
    assert.deepEqual(describeFatalError(outer), ["outer", "inner"]);
  });

  it("says something for a thrown non-error", function () {
    assert.deepEqual(describeFatalError("plain string"), ["plain string"]);
    assert.deepEqual(describeFatalError(undefined), ["undefined"]);
  });
});

describe("formatPoolState", function () {
  it("names every state the pool declares, and keeps the ordinal", function () {
    assert.equal(formatPoolState(0), "Uninitialized (0)");
    assert.equal(formatPoolState(1), "Predeposited (1)");
    assert.equal(formatPoolState(2), "Funding (2)");
    assert.equal(formatPoolState(3n), "ToppedUp (3)");
  });

  it("does not invent a name for an ordinal the enum does not have", function () {
    assert.equal(formatPoolState(4), "4 (unknown state)");
  });
});
