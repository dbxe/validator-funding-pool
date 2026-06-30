import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SecretKey } from "@chainsafe/blst";
import type { Hex } from "viem";

import {
  assertBeaconValidatorReadyForExit,
  assertBeaconValidatorReadyForTopUp,
  assertBeaconValidatorHasWithdrawalCredentials,
  assertPoolWithdrawalCredentials,
  computeDepositDataRoot,
  computeDepositSigningRoot,
  UNSAFE_BEACON_BYPASS_ACK,
  UNSAFE_SKIP_BEACON_CONFIRMATION,
  validateDepositData,
  VALIDATOR_DEPOSIT_GWEI,
} from "../scripts/lib/common.js";

const PUBKEY =
  "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111" as Hex;
const WITHDRAWAL_CREDENTIALS = "0x0100000000000000000000002222222222222222222222222222222222222222" as Hex;
const OTHER_WITHDRAWAL_CREDENTIALS =
  "0x0100000000000000000000003333333333333333333333333333333333333333" as Hex;
const FAR_FUTURE_EPOCH = "18446744073709551615";

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

describe("deposit data validation", function () {
  it("computes a stable 0x01 DepositData root fixture", function () {
    const pubkey =
      "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    const withdrawalCredentials = "0x0100000000000000000000002222222222222222222222222222222222222222";
    const amountGwei = 32_000_000_000n;
    const signature =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Fixed fixture to catch accidental changes to deposit root encoding.
    assert.equal(
      computeDepositDataRoot(pubkey, withdrawalCredentials, amountGwei, signature),
      "0x6dd03ee1016b251f0b998ab6379b190847f2740987400fd59535b1c7894c2749",
    );
  });

  it("validates the BLS deposit signature and rejects invalid signatures", function () {
    const originalNetworkName = process.env.DEPOSIT_NETWORK_NAME;
    const originalForkVersion = process.env.DEPOSIT_FORK_VERSION;
    delete process.env.DEPOSIT_NETWORK_NAME;
    delete process.env.DEPOSIT_FORK_VERSION;

    try {
      const secretKey = SecretKey.fromKeygen(Buffer.alloc(32, 1));
      const pubkey = bytesToHex(secretKey.toPublicKey().toBytes());
      const withdrawalCredentials = "0x0100000000000000000000002222222222222222222222222222222222222222";
      const forkVersion = "0x00000000";
      const signingRoot = computeDepositSigningRoot(
        pubkey,
        withdrawalCredentials,
        VALIDATOR_DEPOSIT_GWEI,
        forkVersion,
      );
      const signature = bytesToHex(secretKey.sign(Buffer.from(signingRoot.slice(2), "hex")).toBytes());
      const depositDataRoot = computeDepositDataRoot(
        pubkey,
        withdrawalCredentials,
        VALIDATOR_DEPOSIT_GWEI,
        signature,
      );

      assert.deepEqual(
        validateDepositData(
          {
            pubkey,
            withdrawal_credentials: withdrawalCredentials,
            amount: VALIDATOR_DEPOSIT_GWEI.toString(),
            signature,
            deposit_data_root: depositDataRoot,
            fork_version: forkVersion,
          },
          withdrawalCredentials,
        ),
        {
          pubkey,
          withdrawalCredentials,
          signature,
          depositDataRoot,
          amountGwei: VALIDATOR_DEPOSIT_GWEI,
          forkVersion,
        },
      );

      const invalidSignatureBytes = Buffer.from(signature.slice(2), "hex");
      invalidSignatureBytes[invalidSignatureBytes.length - 1] ^= 1;
      const invalidSignature = bytesToHex(invalidSignatureBytes);
      assert.throws(
        () =>
          validateDepositData(
            {
              pubkey,
              withdrawal_credentials: withdrawalCredentials,
              amount: VALIDATOR_DEPOSIT_GWEI.toString(),
              signature: invalidSignature,
              deposit_data_root: computeDepositDataRoot(
                pubkey,
                withdrawalCredentials,
                VALIDATOR_DEPOSIT_GWEI,
                invalidSignature,
              ),
              fork_version: forkVersion,
            },
            withdrawalCredentials,
          ),
        /Invalid BLS deposit signature/,
      );
    } finally {
      if (originalNetworkName === undefined) {
        delete process.env.DEPOSIT_NETWORK_NAME;
      } else {
        process.env.DEPOSIT_NETWORK_NAME = originalNetworkName;
      }
      if (originalForkVersion === undefined) {
        delete process.env.DEPOSIT_FORK_VERSION;
      } else {
        process.env.DEPOSIT_FORK_VERSION = originalForkVersion;
      }
    }
  });

  it("requires an explicit acknowledgement for unsafe required beacon bypasses", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalUnsafeSkip = process.env[UNSAFE_SKIP_BEACON_CONFIRMATION];
    const originalUnsafeAck = process.env[UNSAFE_BEACON_BYPASS_ACK];
    delete process.env.BEACON_NODE_URL;
    delete process.env[UNSAFE_SKIP_BEACON_CONFIRMATION];
    delete process.env[UNSAFE_BEACON_BYPASS_ACK];

    try {
      await assert.rejects(
        assertBeaconValidatorHasWithdrawalCredentials(
          "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
          "0x0100000000000000000000002222222222222222222222222222222222222222",
          "test",
          true,
        ),
        /I_UNDERSTAND_FUNDS_CAN_BE_LOST/,
      );

      process.env[UNSAFE_SKIP_BEACON_CONFIRMATION] = "1";
      await assert.rejects(
        assertBeaconValidatorHasWithdrawalCredentials(
          "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
          "0x0100000000000000000000002222222222222222222222222222222222222222",
          "test",
          true,
        ),
        /I_UNDERSTAND_FUNDS_CAN_BE_LOST/,
      );

      process.env[UNSAFE_BEACON_BYPASS_ACK] = "1";
      assert.equal(
        await assertBeaconValidatorHasWithdrawalCredentials(
          "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
          "0x0100000000000000000000002222222222222222222222222222222222222222",
          "test",
          true,
        ),
        undefined,
      );
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv(UNSAFE_SKIP_BEACON_CONFIRMATION, originalUnsafeSkip);
      restoreEnv(UNSAFE_BEACON_BYPASS_ACK, originalUnsafeAck);
    }
  });
});

describe("beacon preflight checks", function () {
  it("checks top-up credentials at finalized state and mutable validator status at head", async function () {
    const calls = installBeaconMock({
      finalizedValidator: beaconValidator("pending_initialized"),
      headValidator: beaconValidator("active_ongoing"),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalConfirmationStateId = process.env.BEACON_CONFIRMATION_STATE_ID;
    process.env.BEACON_NODE_URL = "http://beacon.example";
    delete process.env.BEACON_CONFIRMATION_STATE_ID;

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test"),
        /top-up-test head beacon validator status active_ongoing is not safe/,
      );
      assert(calls.includes(`/eth/v1/beacon/states/finalized/validators/${PUBKEY}`));
      assert(calls.includes(`/eth/v1/beacon/states/head/validators/${PUBKEY}`));
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("BEACON_CONFIRMATION_STATE_ID", originalConfirmationStateId);
    }
  });

  it("rejects top-up when the head validator has already initiated exit", async function () {
    installBeaconMock({
      finalizedValidator: beaconValidator("pending_initialized"),
      headValidator: beaconValidator("pending_initialized", { exit_epoch: "17" }),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test"),
        /exit_epoch 17 is not FAR_FUTURE_EPOCH/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("rejects exit preflight before SHARD_COMMITTEE_PERIOD has elapsed", async function () {
    installBeaconMock({
      headSlot: "8191",
      headValidator: beaconValidator("active_ongoing", { activation_epoch: "0" }),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalExitStateId = process.env.BEACON_EXIT_STATE_ID;
    process.env.BEACON_NODE_URL = "http://beacon.example";
    process.env.BEACON_EXIT_STATE_ID = "finalized";

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForExit(PUBKEY, WITHDRAWAL_CREDENTIALS, "exit-test"),
        /not exit-eligible until epoch 256 \(current epoch 255\)/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("BEACON_EXIT_STATE_ID", originalExitStateId);
    }
  });

  it("rejects exit preflight when exit has already been initiated", async function () {
    installBeaconMock({
      headSlot: "8192",
      headValidator: beaconValidator("active_ongoing", { exit_epoch: "99" }),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForExit(PUBKEY, WITHDRAWAL_CREDENTIALS, "exit-test"),
        /exit_epoch 99 is not FAR_FUTURE_EPOCH/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("compares live pool withdrawal credentials against the deployment record", async function () {
    const pool = {
      read: {
        withdrawalCredentials: async () => WITHDRAWAL_CREDENTIALS,
      },
    };
    const deployment = {
      withdrawalCredentials: WITHDRAWAL_CREDENTIALS,
    } as any;

    assert.equal(await assertPoolWithdrawalCredentials(pool, deployment), WITHDRAWAL_CREDENTIALS);

    await assert.rejects(
      assertPoolWithdrawalCredentials(pool, {
        withdrawalCredentials: OTHER_WITHDRAWAL_CREDENTIALS,
      } as any),
      /does not match deployment record/,
    );
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

let originalFetch: typeof fetch | undefined;

function installBeaconMock({
  finalizedValidator = beaconValidator("pending_initialized"),
  headValidator = beaconValidator("pending_initialized"),
  headSlot = "8192",
}: {
  finalizedValidator?: ReturnType<typeof beaconValidator>;
  headValidator?: ReturnType<typeof beaconValidator>;
  headSlot?: string;
}): string[] {
  const calls: string[] = [];
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    calls.push(url.pathname);

    if (url.pathname === "/eth/v1/node/syncing") {
      return jsonResponse({ data: { head_slot: headSlot, sync_distance: "0", is_syncing: false } });
    }
    if (url.pathname === "/eth/v1/beacon/genesis") {
      return jsonResponse({
        data: {
          genesis_time: "0",
          genesis_validators_root: `0x${"11".repeat(32)}`,
          genesis_fork_version: "0x00000000",
        },
      });
    }
    if (url.pathname.endsWith("/finality_checkpoints")) {
      return jsonResponse({
        data: {
          previous_justified: { epoch: "254", root: `0x${"22".repeat(32)}` },
          current_justified: { epoch: "255", root: `0x${"33".repeat(32)}` },
          finalized: { epoch: "254", root: `0x${"44".repeat(32)}` },
        },
      });
    }
    if (url.pathname === "/eth/v1/config/spec") {
      return jsonResponse({ data: { SLOTS_PER_EPOCH: "32", SHARD_COMMITTEE_PERIOD: "256" } });
    }

    const validatorMatch = url.pathname.match(/^\/eth\/v1\/beacon\/states\/([^/]+)\/validators\//);
    if (validatorMatch !== null) {
      return jsonResponse(validatorMatch[1] === "head" ? headValidator : finalizedValidator);
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return calls;
}

function restoreFetch() {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function beaconValidator(
  status: string,
  validatorOverrides: Partial<{
    withdrawal_credentials: string;
    effective_balance: string;
    slashed: boolean;
    activation_eligibility_epoch: string;
    activation_epoch: string;
    exit_epoch: string;
    withdrawable_epoch: string;
  }> = {},
) {
  return {
    data: {
      index: "123",
      balance: "1000000000",
      status,
      validator: {
        pubkey: PUBKEY,
        withdrawal_credentials: WITHDRAWAL_CREDENTIALS,
        effective_balance: "1000000000",
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: FAR_FUTURE_EPOCH,
        withdrawable_epoch: FAR_FUTURE_EPOCH,
        ...validatorOverrides,
      },
    },
  };
}
