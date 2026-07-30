import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SecretKey } from "@chainsafe/blst";
import type { Hex } from "viem";

import {
  assertBeaconValidatorAbsent,
  assertBeaconValidatorReadyForExit,
  assertBeaconValidatorReadyForFunding,
  assertBeaconValidatorReadyForTopUp,
  assertBeaconValidatorHasWithdrawalCredentials,
  assertDeploymentMatchesPool,
  computeDepositDataRoot,
  computeDepositSigningRoot,
  PREDEPOSIT_GWEI,
  readBeaconGenesisForkVersion,
  readDeployment,
  TOP_UP_GWEI,
  UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY,
  UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK,
  validateDepositData,
  VALIDATOR_DEPOSIT_GWEI,
  writeDeployment,
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
    delete process.env.DEPOSIT_NETWORK_NAME;

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
          forkVersion,
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
            forkVersion,
          ),
        /Invalid BLS deposit signature/,
      );
    } finally {
      if (originalNetworkName === undefined) {
        delete process.env.DEPOSIT_NETWORK_NAME;
      } else {
        process.env.DEPOSIT_NETWORK_NAME = originalNetworkName;
      }
    }
  });

  it("requires BEACON_NODE_URL on every capital-risk path despite obsolete bypass variables", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalUnsafeSkip = process.env.UNSAFE_SKIP_BEACON_CONFIRMATION;
    const originalUnsafeAck = process.env.I_UNDERSTAND_FUNDS_CAN_BE_LOST;
    delete process.env.BEACON_NODE_URL;
    process.env.UNSAFE_SKIP_BEACON_CONFIRMATION = "1";
    process.env.I_UNDERSTAND_FUNDS_CAN_BE_LOST = "1";

    try {
      await assert.rejects(
        assertBeaconValidatorAbsent(PUBKEY, "commit-predeposit"),
        /commit-predeposit requires BEACON_NODE_URL/,
      );
      await assert.rejects(
        assertBeaconValidatorHasWithdrawalCredentials(PUBKEY, WITHDRAWAL_CREDENTIALS, "fund"),
        /fund requires BEACON_NODE_URL/,
      );
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up"),
        /top-up requires BEACON_NODE_URL/,
      );
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("UNSAFE_SKIP_BEACON_CONFIRMATION", originalUnsafeSkip);
      restoreEnv("I_UNDERSTAND_FUNDS_CAN_BE_LOST", originalUnsafeAck);
    }
  });

  it("round-trips deployment records with and without an optional fee recipient forwarder", function () {
    const directory = mkdtempSync(path.join(tmpdir(), "validator-funding-pool-"));
    const deploymentFile = path.join(directory, "deployment.json");
    const originalDeploymentFile = process.env.DEPLOYMENT_FILE;
    const originalLog = console.log;
    process.env.DEPLOYMENT_FILE = deploymentFile;
    console.log = () => {};

    const deployment = {
      chainId: 31337,
      pool: "0x1111111111111111111111111111111111111111",
      depositContract: "0x2222222222222222222222222222222222222222",
      depositContractCodeHash: `0x${"11".repeat(32)}`,
      withdrawalRequestPredeploy: "0x3333333333333333333333333333333333333333",
      withdrawalRequestPredeployCodeHash: `0x${"22".repeat(32)}`,
      operator: "0x4444444444444444444444444444444444444444",
      fundingWindowDuration: "3600",
      withdrawalCredentials: `0x01${"00".repeat(11)}${"11".repeat(20)}`,
    } as const;

    try {
      writeDeployment(deployment);
      assert.deepEqual(readDeployment(), deployment);

      const withForwarder = {
        ...deployment,
        feeRecipientForwarder: "0x5555555555555555555555555555555555555555" as const,
      };
      writeDeployment(withForwarder);
      assert.deepEqual(readDeployment(), withForwarder);
    } finally {
      console.log = originalLog;
      restoreEnv("DEPLOYMENT_FILE", originalDeploymentFile);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("beacon preflight checks", function () {
  it("binds both deposit entries to the beacon genesis fork version before validator lookup", async function () {
    const calls = installBeaconMock({
      genesisForkVersion: "0XAABBCCDD",
      validatorStatus: 404,
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      const chainForkVersion = await readBeaconGenesisForkVersion("deposit-test");
      assert.equal(chainForkVersion, "0xaabbccdd");

      const secretKey = SecretKey.fromKeygen(Buffer.alloc(32, 2));
      const pubkey = bytesToHex(secretKey.toPublicKey().toBytes());
      for (const amountGwei of [PREDEPOSIT_GWEI, TOP_UP_GWEI]) {
        const deposit = signedDeposit(secretKey, pubkey, WITHDRAWAL_CREDENTIALS, amountGwei, "0xAaBbCcDd");
        assert.equal(
          validateDepositData(deposit, WITHDRAWAL_CREDENTIALS, chainForkVersion, pubkey, amountGwei).forkVersion,
          chainForkVersion,
        );
      }

      const wrongForkVersion = "0x01020304" as Hex;
      const wrongNetworkDeposit = signedDeposit(
        secretKey,
        pubkey,
        WITHDRAWAL_CREDENTIALS,
        PREDEPOSIT_GWEI,
        wrongForkVersion,
      );
      assert.throws(
        () =>
          validateDepositData(
            wrongNetworkDeposit,
            WITHDRAWAL_CREDENTIALS,
            chainForkVersion,
            pubkey,
            PREDEPOSIT_GWEI,
          ),
        /Deposit fork_version 0x01020304 != beacon genesis_fork_version 0xaabbccdd/,
      );
      assert(!calls.some((pathname) => pathname.includes("/validators/")));
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("refuses participant funding for every fresh-predeposit mutable-state anomaly", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      const cases: Array<{
        validator?: Parameters<typeof beaconValidator>[1];
        response?: Parameters<typeof beaconValidator>[2];
        message: RegExp;
      }> = [
        {
          response: { balance: "1000000001" },
          message: /balance 1000000001 is not exactly 1000000000 Gwei/,
        },
        { validator: { slashed: true }, message: /validator is slashed/ },
        {
          validator: { activation_epoch: "12" },
          message: /activation_epoch 12 is not FAR_FUTURE_EPOCH/,
        },
        {
          validator: { activation_eligibility_epoch: "13" },
          message: /activation_eligibility_epoch 13 is not FAR_FUTURE_EPOCH/,
        },
        { validator: { exit_epoch: "14" }, message: /exit_epoch 14 is not FAR_FUTURE_EPOCH/ },
        {
          validator: { withdrawable_epoch: "15" },
          message: /withdrawable_epoch 15 is not FAR_FUTURE_EPOCH/,
        },
      ];

      for (const testCase of cases) {
        installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: beaconValidator(
            "pending_initialized",
            testCase.validator,
            testCase.response,
          ),
        });
        try {
          await assert.rejects(
            assertBeaconValidatorReadyForFunding(PUBKEY, WITHDRAWAL_CREDENTIALS, "fund-test"),
            testCase.message,
          );
        } finally {
          restoreFetch();
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("uses finalized credentials and head consensus fields rather than the status label", async function () {
    const calls = installBeaconMock({
      finalizedValidator: beaconValidator("pending_initialized"),
      headValidator: beaconValidator("active_ongoing"),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalConfirmationStateId = process.env.BEACON_CONFIRMATION_STATE_ID;
    process.env.BEACON_NODE_URL = "http://beacon.example";
    delete process.env.BEACON_CONFIRMATION_STATE_ID;

    try {
      await assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test");
      assert(calls.includes(`/eth/v1/beacon/states/finalized/validators/${PUBKEY}`));
      assert(calls.includes(`/eth/v1/beacon/states/head/validators/${PUBKEY}`));
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("BEACON_CONFIRMATION_STATE_ID", originalConfirmationStateId);
    }
  });

  it("rejects a head-state credential divergence even with the top-up anomaly override", async function () {
    installBeaconMock({
      finalizedValidator: beaconValidator("pending_initialized"),
      headValidator: beaconValidator("pending_initialized", {
        withdrawal_credentials: OTHER_WITHDRAWAL_CREDENTIALS,
        exit_epoch: "17",
      }),
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalOverride = process.env[UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY];
    const originalAck = process.env[UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK];
    process.env.BEACON_NODE_URL = "http://beacon.example";
    process.env[UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY] = "1";
    process.env[UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK] = "1";

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test"),
        /head beacon withdrawal_credentials .* != pool/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv(UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY, originalOverride);
      restoreEnv(UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK, originalAck);
    }
  });

  it("allows only top-up to waive mutable anomalies with both override variables", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalOverride = process.env[UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY];
    const originalAck = process.env[UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK];
    process.env.BEACON_NODE_URL = "http://beacon.example";
    process.env[UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY] = "1";
    process.env[UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK] = "1";

    try {
      installBeaconMock({
        finalizedValidator: beaconValidator("pending_initialized"),
        headValidator: beaconValidator(
          "active_exiting",
          {
            slashed: true,
            activation_epoch: "12",
            activation_eligibility_epoch: "11",
            exit_epoch: "14",
            withdrawable_epoch: "15",
          },
          { balance: "32000000000" },
        ),
      });
      await assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test");
      restoreFetch();

      installBeaconMock({
        finalizedValidator: beaconValidator("pending_initialized"),
        headValidator: beaconValidator("pending_initialized", {}, { balance: "1000000001" }),
      });
      await assert.rejects(
        assertBeaconValidatorReadyForFunding(PUBKEY, WITHDRAWAL_CREDENTIALS, "fund-test"),
        /balance 1000000001 is not exactly 1000000000 Gwei/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv(UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY, originalOverride);
      restoreEnv(UNSAFE_TOPUP_VALIDATOR_ANOMALY_ACK, originalAck);
    }
  });

  it("passes funding and top-up for a healthy fresh 1 ETH validator", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      installBeaconMock({});
      await assertBeaconValidatorReadyForFunding(PUBKEY, WITHDRAWAL_CREDENTIALS, "fund-test");
      restoreFetch();

      installBeaconMock({});
      await assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up-test");
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

  it("compares every recorded immutable against the live pool", async function () {
    const depositContract = "0x1111111111111111111111111111111111111111" as const;
    const withdrawalRequestPredeploy = "0x2222222222222222222222222222222222222222" as const;
    const operator = "0x3333333333333333333333333333333333333333" as const;
    const fundingWindowDuration = 3600n;
    const pool = {
      read: {
        depositContract: async () => depositContract,
        withdrawalRequestPredeploy: async () => withdrawalRequestPredeploy,
        operator: async () => operator,
        withdrawalCredentials: async () => WITHDRAWAL_CREDENTIALS,
        fundingWindowDuration: async () => fundingWindowDuration,
      },
    };
    const deployment = {
      depositContract,
      withdrawalRequestPredeploy,
      operator,
      withdrawalCredentials: WITHDRAWAL_CREDENTIALS,
      fundingWindowDuration: fundingWindowDuration.toString(),
    } as any;

    assert.deepEqual(await assertDeploymentMatchesPool(pool, deployment), {
      depositContract,
      withdrawalRequestPredeploy,
      operator,
      withdrawalCredentials: WITHDRAWAL_CREDENTIALS,
      fundingWindowDuration,
    });

    const mismatches = [
      { field: "depositContract", value: operator },
      { field: "withdrawalRequestPredeploy", value: operator },
      { field: "operator", value: depositContract },
      { field: "withdrawalCredentials", value: OTHER_WITHDRAWAL_CREDENTIALS },
      { field: "fundingWindowDuration", value: "3601" },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        assertDeploymentMatchesPool(pool, { ...deployment, [mismatch.field]: mismatch.value }),
        new RegExp(`Pool ${mismatch.field} .* does not match deployment record`),
      );
    }
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
  genesisForkVersion = "0x00000000",
  validatorStatus = 200,
}: {
  finalizedValidator?: ReturnType<typeof beaconValidator>;
  headValidator?: ReturnType<typeof beaconValidator>;
  headSlot?: string;
  genesisForkVersion?: string;
  validatorStatus?: number;
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
          genesis_fork_version: genesisForkVersion,
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
      if (validatorStatus !== 200) {
        return new Response("validator not found", { status: validatorStatus });
      }
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
  responseOverrides: Partial<{ balance: string }> = {},
) {
  return {
    data: {
      index: "123",
      balance: "1000000000",
      status,
      ...responseOverrides,
      validator: {
        pubkey: PUBKEY,
        withdrawal_credentials: WITHDRAWAL_CREDENTIALS,
        effective_balance: "1000000000",
        slashed: false,
        activation_eligibility_epoch: FAR_FUTURE_EPOCH,
        activation_epoch: FAR_FUTURE_EPOCH,
        exit_epoch: FAR_FUTURE_EPOCH,
        withdrawable_epoch: FAR_FUTURE_EPOCH,
        ...validatorOverrides,
      },
    },
  };
}

function signedDeposit(
  secretKey: SecretKey,
  pubkey: Hex,
  withdrawalCredentials: Hex,
  amountGwei: bigint,
  forkVersion: Hex,
) {
  const signingRoot = computeDepositSigningRoot(pubkey, withdrawalCredentials, amountGwei, forkVersion);
  const signature = bytesToHex(secretKey.sign(Buffer.from(signingRoot.slice(2), "hex")).toBytes());
  return {
    pubkey,
    withdrawal_credentials: withdrawalCredentials,
    amount: amountGwei.toString(),
    signature,
    deposit_data_root: computeDepositDataRoot(pubkey, withdrawalCredentials, amountGwei, signature),
    fork_version: forkVersion,
  };
}
