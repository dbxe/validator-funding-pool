import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertFundingWasCredited,
  assertStillFundable,
  beaconApiUrl,
  describeFatalError,
  envBigInt,
  formatPoolState,
  fundViaPlainTransfer,
  optionalEnvBigInt,
  parseBigIntList,
  waitForSenderVerifiedReceipt,
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

describe("assertActiveSigner", function () {
  const nonLedger = { networkName: "rpc", networkConfig: {} };
  const ledger = { networkName: "ledger", networkConfig: { ledgerAccounts: [SIGNER] } };

  it("prints the active signer and the network on every connection", function () {
    const original = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    delete process.env.EXPECTED_SIGNER;

    try {
      assert.equal(assertActiveSigner(nonLedger, SIGNER, "fund"), SIGNER);
      assert.deepEqual(log.lines, [`fund active signer: ${SIGNER} (network rpc)`]);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", original);
    }
  });

  it("requires LEDGER_ADDRESS on a Ledger-signing connection", function () {
    const original = process.env.LEDGER_ADDRESS;
    const originalExpected = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    delete process.env.LEDGER_ADDRESS;
    delete process.env.EXPECTED_SIGNER;

    try {
      assert.throws(
        () => assertActiveSigner(ledger, SIGNER, "fund"),
        /fund is connected to a Ledger-signing network but LEDGER_ADDRESS is unset/,
      );
    } finally {
      log.restore();
      restoreEnv("LEDGER_ADDRESS", original);
      restoreEnv("EXPECTED_SIGNER", originalExpected);
    }
  });

  it("asserts nothing about the address when neither variable is declared", function () {
    const originalExpected = process.env.EXPECTED_SIGNER;
    const originalLedger = process.env.LEDGER_ADDRESS;
    const log = captureLog();
    delete process.env.EXPECTED_SIGNER;
    delete process.env.LEDGER_ADDRESS;

    try {
      assert.equal(assertActiveSigner(nonLedger, OTHER_SIGNER, "claim"), OTHER_SIGNER);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", originalExpected);
      restoreEnv("LEDGER_ADDRESS", originalLedger);
    }
  });

  it("enforces EXPECTED_SIGNER on a network that signs with no device", function () {
    const original = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    process.env.EXPECTED_SIGNER = SIGNER;

    try {
      assert.equal(assertActiveSigner(nonLedger, SIGNER, "fund"), SIGNER);
      // Declared and active differ only in case: still the same account.
      assert.equal(
        assertActiveSigner(nonLedger, SIGNER.toUpperCase().replace("0X", "0x") as Address, "fund").toLowerCase(),
        SIGNER,
      );
      assert.throws(
        () => assertActiveSigner(nonLedger, OTHER_SIGNER, "fund"),
        /fund would sign with .* not the declared EXPECTED_SIGNER/,
      );
      process.env.EXPECTED_SIGNER = "not-an-address";
      assert.throws(
        () => assertActiveSigner(nonLedger, SIGNER, "fund"),
        /EXPECTED_SIGNER not-an-address is not a 0x-prefixed 20-byte address/,
      );
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", original);
    }
  });

  it("enforces EXPECTED_SIGNER on the Ledger path too, alongside LEDGER_ADDRESS", function () {
    const originalExpected = process.env.EXPECTED_SIGNER;
    const originalLedger = process.env.LEDGER_ADDRESS;
    const log = captureLog();
    process.env.LEDGER_ADDRESS = SIGNER;
    process.env.EXPECTED_SIGNER = OTHER_SIGNER;

    try {
      // The device account is the one that would sign, and it is not the declared one.
      assert.throws(
        () => assertActiveSigner(ledger, SIGNER, "fund"),
        /not the declared EXPECTED_SIGNER/,
      );
      process.env.EXPECTED_SIGNER = SIGNER;
      assert.equal(assertActiveSigner(ledger, SIGNER, "fund"), SIGNER);
    } finally {
      log.restore();
      restoreEnv("EXPECTED_SIGNER", originalExpected);
      restoreEnv("LEDGER_ADDRESS", originalLedger);
    }
  });

  it("refuses to sign with an account that is not the Ledger account", function () {
    const original = process.env.LEDGER_ADDRESS;
    const originalExpected = process.env.EXPECTED_SIGNER;
    const log = captureLog();
    process.env.LEDGER_ADDRESS = SIGNER;
    delete process.env.EXPECTED_SIGNER;

    try {
      assert.throws(
        () => assertActiveSigner(ledger, OTHER_SIGNER, "fund"),
        /fund would sign with .* not the Ledger account/,
      );
      assert.equal(assertActiveSigner(ledger, SIGNER.toUpperCase().replace("0X", "0x") as Address, "fund").toLowerCase(), SIGNER);
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
