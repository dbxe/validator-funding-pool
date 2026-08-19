import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Address, Hex } from "viem";

import {
  assertActiveSigner,
  assertDeployedAt,
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

interface FakeTransaction {
  hash: Hex;
  to: Address | null;
  value: bigint;
  input: Hex;
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
  return { hash: HASH, to: POOL, value: 1_000n, input: "0xdeadbeef", ...overrides };
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
      /FATAL REPLACED TRANSACTION: sweep transaction .* reason "replaced", different destination, value, or calldata/,
    );
  });

  it("is fatal for a repriced classification whose content actually changed", async function () {
    // viem only labels a replacement `repriced` when to, value, and input all match
    // (`waitForTransactionReceipt.js` lines 171-176). The policy re-derives that rather
    // than trusting the label, so a wrong label cannot buy a success line.
    for (const changed of [
      { to: OTHER_SIGNER },
      { value: 999n },
      { input: "0xbeefdead" as Hex },
    ]) {
      const client = fakeClient(
        { from: SIGNER, blockNumber: 11n, status: "success" },
        replacementOf("repriced", changed),
      );

      await assert.rejects(
        waitForSenderVerifiedReceipt(client, HASH, SIGNER, "fund"),
        /different destination, value, or calldata/,
      );
    }
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
