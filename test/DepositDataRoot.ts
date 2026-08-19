import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SecretKey } from "@chainsafe/blst";
import type { Hex } from "viem";

import type { ExcessBalanceConfirmationReader } from "../scripts/lib/common.js";
import {
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorAbsent,
  assertBeaconValidatorReadyForExit,
  assertBeaconValidatorReadyForFunding,
  assertBeaconValidatorReadyForTopUp,
  assertDeploymentMatchesPool,
  computeDepositDataRoot,
  computeDepositSigningRoot,
  PREDEPOSIT_GWEI,
  readBeaconGenesisForkVersion,
  readDeployment,
  TOP_UP_GWEI,
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
// Both variables were deleted from the codebase. They are referenced here only to prove that
// setting them changes nothing.
const DELETED_OVERRIDE_VARS = [
  "UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY",
  "I_UNDERSTAND_TOPUP_VALIDATOR_ANOMALY",
] as const;
// The fund and top-up legs run the identical fresh-predeposit preflight; every case below is
// exercised against both.
const freshPredepositLegs = [
  { label: "fund-test", assert: assertBeaconValidatorReadyForFunding },
  { label: "top-up-test", assert: assertBeaconValidatorReadyForTopUp },
] as const;

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
    const obsolete = [
      "UNSAFE_SKIP_BEACON_CONFIRMATION",
      "I_UNDERSTAND_FUNDS_CAN_BE_LOST",
      ...DELETED_OVERRIDE_VARS,
    ];
    const originalObsolete = obsolete.map((name) => [name, process.env[name]] as const);
    delete process.env.BEACON_NODE_URL;
    for (const name of obsolete) process.env[name] = "1";

    try {
      await assert.rejects(
        assertBeaconValidatorAbsent(PUBKEY, "commit-predeposit"),
        /commit-predeposit requires BEACON_NODE_URL/,
      );
      await assert.rejects(
        assertBeaconValidatorReadyForFunding(PUBKEY, WITHDRAWAL_CREDENTIALS, "fund"),
        /fund requires BEACON_NODE_URL/,
      );
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(PUBKEY, WITHDRAWAL_CREDENTIALS, "top-up"),
        /top-up requires BEACON_NODE_URL/,
      );
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      for (const [name, value] of originalObsolete) restoreEnv(name, value);
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
  it("rejects a beacon chain mismatch before consuming the genesis fork version", async function () {
    const calls = installBeaconMock({
      beaconChainId: "1",
      genesisForkVersion: "0xaabbccdd",
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      await assert.rejects(
        (async () => {
          await assertBeaconMatchesExecutionChain(
            { chainId: 31337 },
            { depositContract: "0x1111111111111111111111111111111111111111" },
            "deposit-test",
          );
          await readBeaconGenesisForkVersion("deposit-test");
        })(),
        /deposit-test beacon deposit chain_id 1 does not match deployment chainId 31337/,
      );
      assert.deepEqual(calls, ["/eth/v1/config/deposit_contract"]);
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("rejects a beacon deposit contract mismatch against the live pool", async function () {
    const calls = installBeaconMock({
      beaconChainId: "31337",
      depositContractAddress: "0x2222222222222222222222222222222222222222",
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      await assert.rejects(
        assertBeaconMatchesExecutionChain(
          { chainId: 31337 },
          { depositContract: "0x1111111111111111111111111111111111111111" },
          "fund-test",
        ),
        /fund-test beacon deposit contract 0x2222222222222222222222222222222222222222 does not match pool depositContract 0x1111111111111111111111111111111111111111/,
      );
      assert.deepEqual(calls, ["/eth/v1/config/deposit_contract"]);
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("accepts a matching beacon endpoint and lets advisory exit preflight skip it", async function () {
    const calls = installBeaconMock({
      beaconChainId: "31337",
      depositContractAddress: "0x1111111111111111111111111111111111111111",
    });
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      assert.equal(
        await assertBeaconMatchesExecutionChain(
          { chainId: 31337 },
          { depositContract: "0x1111111111111111111111111111111111111111" },
          "top-up-test",
        ),
        true,
      );
      assert.deepEqual(calls, ["/eth/v1/config/deposit_contract"]);

      delete process.env.BEACON_NODE_URL;
      assert.equal(
        await assertBeaconMatchesExecutionChain(
          { chainId: 31337 },
          { depositContract: "0x1111111111111111111111111111111111111111" },
          "exit-test",
          { optional: true },
        ),
        false,
      );
      await assertBeaconValidatorReadyForExit(PUBKEY, WITHDRAWAL_CREDENTIALS, "exit-test");
      assert.deepEqual(calls, ["/eth/v1/config/deposit_contract"]);
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

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

  // The matrix runs twice: once with the deleted override variables explicitly cleared and
  // once with both set to "1". The deleted-variable test below only exercises a combined
  // fixture plus withdrawable_epoch, so a regression that waived a single anomaly under those
  // variables would otherwise slip through.
  it("refuses funding and top-up for every fresh-predeposit mutable-state anomaly", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    const cases: Array<{
      validator?: Record<string, unknown>;
      response?: Record<string, unknown>;
      message: RegExp;
    }> = [
      {
        response: { balance: "999999999" },
        message: /balance 999999999 is below the 1000000000 Gwei predeposit/,
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

    const overrideModes = [
      { name: "deleted override variables cleared", enter: clearDeletedOverrideVars },
      { name: "deleted override variables set", enter: setDeletedOverrideVars },
    ];

    try {
      for (const mode of overrideModes) {
        const restoreVars = mode.enter();
        try {
          for (const testCase of cases) {
            for (const leg of freshPredepositLegs) {
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
                  leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
                  testCase.message,
                  `${leg.label} accepted an anomaly with ${mode.name}`,
                );
              } finally {
                restoreFetch();
              }
            }
          }
        } finally {
          restoreVars();
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
      await assertBeaconValidatorReadyForTopUp(
        PUBKEY,
        WITHDRAWAL_CREDENTIALS,
        "top-up-test",
        refusingReader(),
      );
      assert(calls.includes(`/eth/v1/beacon/states/finalized/validators/${PUBKEY}`));
      assert(calls.includes(`/eth/v1/beacon/states/head/validators/${PUBKEY}`));
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("BEACON_CONFIRMATION_STATE_ID", originalConfirmationStateId);
    }
  });

  it("rejects a head-state credential divergence even with the deleted override variables set", async function () {
    installBeaconMock({
      finalizedValidator: beaconValidator("pending_initialized"),
      headValidator: beaconValidator("pending_initialized", {
        withdrawal_credentials: OTHER_WITHDRAWAL_CREDENTIALS,
        exit_epoch: "17",
      }),
    });
    const restore = setDeletedOverrideVars();
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      await assert.rejects(
        assertBeaconValidatorReadyForTopUp(
          PUBKEY,
          WITHDRAWAL_CREDENTIALS,
          "top-up-test",
          refusingReader(),
        ),
        /head beacon withdrawal_credentials .* != pool/,
      );
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restore();
    }
  });

  it("keeps mutable anomalies fatal on both legs with the deleted override variables set", async function () {
    const restore = setDeletedOverrideVars();
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      for (const leg of freshPredepositLegs) {
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
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
            /validator is slashed/,
          );
        } finally {
          restoreFetch();
        }

        installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: beaconValidator(
            "pending_initialized",
            { withdrawable_epoch: "15" },
            { balance: "1000000000" },
          ),
        });
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
            /withdrawable_epoch 15 is not FAR_FUTURE_EPOCH/,
          );
        } finally {
          restoreFetch();
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restore();
    }
  });

  it("passes funding and top-up for a healthy fresh 1 ETH validator", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      for (const leg of freshPredepositLegs) {
        installBeaconMock({});
        const log = captureLog();
        try {
          await leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader());
        } finally {
          log.restore();
          restoreFetch();
        }
        assert(
          log.lines.includes(`${leg.label} head beacon fresh-predeposit preflight passed`),
          `missing plain pass line for ${leg.label}`,
        );
      }
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("requires an interactive typed confirmation for an excess head balance", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const restore = setDeletedOverrideVars();
    process.env.BEACON_NODE_URL = "http://beacon.example";
    const excessBalance = "1500000000";
    const excessHead = () =>
      installBeaconMock({
        finalizedValidator: beaconValidator("pending_initialized"),
        headValidator: beaconValidator("pending_initialized", {}, { balance: excessBalance }),
      });

    try {
      for (const leg of freshPredepositLegs) {
        excessHead();
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader(excessBalance, false)),
            new RegExp(
              `${leg.label} excess head beacon balance ${excessBalance} Gwei requires an interactive ` +
                `typed confirmation, but stdin is not a TTY`,
            ),
          );
        } finally {
          restoreFetch();
        }

        excessHead();
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader("1500000001")),
            /excess-balance confirmation failed: expected the exact observed balance 1500000000/,
          );
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader("yes")),
            /excess-balance confirmation failed: expected the exact observed balance 1500000000/,
          );
        } finally {
          restoreFetch();
        }

        excessHead();
        const reader = typedReader(` ${excessBalance}\n`);
        const log = captureLog();
        try {
          await leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, reader);
        } finally {
          log.restore();
          restoreFetch();
        }
        assert.equal(reader.prompts.length, 1);
        assert(
          log.lines.some((line) =>
            line.includes(
              `${leg.label} head beacon fresh-predeposit preflight passed WITH an ` +
                `interactively confirmed excess balance of ${excessBalance} Gwei`,
            ),
          ),
          `missing interactively confirmed pass line for ${leg.label}`,
        );
        assert(
          !log.lines.includes(`${leg.label} head beacon fresh-predeposit preflight passed`),
          `plain pass line must not appear for ${leg.label}`,
        );
      }
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restore();
    }
  });

  it("rejects every non-canonical head balance shape on both legs", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    // BigInt() accepts each of the first four on its own; none is a shape a conforming beacon
    // node emits, and each compares unequal to the canonical decimal the checks assume.
    const cases: Array<{ balance: unknown; message: RegExp }> = [
      { balance: "0x3b9aca00", message: /balance "0x3b9aca00" is not a canonical unsigned decimal string/ },
      { balance: "+1000000000", message: /balance "\+1000000000" is not a canonical unsigned decimal string/ },
      { balance: " 1000000000 ", message: /balance " 1000000000 " is not a canonical unsigned decimal string/ },
      { balance: "", message: /balance "" is not a canonical unsigned decimal string/ },
      { balance: "01000000000", message: /balance "01000000000" is not a canonical unsigned decimal string/ },
      { balance: 1_000_000_000, message: /balance 1000000000 is not a canonical unsigned decimal string/ },
      { balance: null, message: /balance null is not a canonical unsigned decimal string/ },
      { balance: undefined, message: /balance <missing> is not a canonical unsigned decimal string/ },
      {
        balance: "18446744073709551616",
        message: /balance 18446744073709551616 exceeds the uint64 maximum 18446744073709551615/,
      },
    ];

    try {
      for (const testCase of cases) {
        for (const leg of freshPredepositLegs) {
          installBeaconMock({
            finalizedValidator: beaconValidator("pending_initialized"),
            headValidator: beaconValidator("pending_initialized", {}, { balance: testCase.balance }),
          });
          try {
            await assert.rejects(
              leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
              testCase.message,
              `${leg.label} accepted balance ${String(testCase.balance)}`,
            );
          } finally {
            restoreFetch();
          }
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("treats a missing, null, or non-boolean slashed flag as fatal on both legs", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    const cases: Array<{ slashed: unknown; described: string }> = [
      { slashed: undefined, described: "<missing>" },
      { slashed: null, described: "null" },
      { slashed: "false", described: '"false"' },
      { slashed: 0, described: "0" },
    ];

    try {
      for (const testCase of cases) {
        for (const leg of freshPredepositLegs) {
          installBeaconMock({
            finalizedValidator: beaconValidator("pending_initialized"),
            headValidator: beaconValidator("pending_initialized", { slashed: testCase.slashed }),
          });
          try {
            await assert.rejects(
              leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
              new RegExp(
                `validator slashed ${escapeRegExp(testCase.described)} is not the boolean true or false`,
              ),
              `${leg.label} accepted slashed=${testCase.described}`,
            );
          } finally {
            restoreFetch();
          }
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("fails closed on malformed node health fields", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    const cases: Array<{ overrides: Record<string, unknown>; message: RegExp }> = [
      { overrides: { is_optimistic: undefined }, message: /node is_optimistic <missing> is not the boolean/ },
      { overrides: { el_offline: undefined }, message: /node el_offline <missing> is not the boolean/ },
      { overrides: { is_syncing: null }, message: /node is_syncing null is not the boolean/ },
      { overrides: { head_slot: "0x2000" }, message: /node head_slot "0x2000" is not a canonical unsigned decimal string/ },
      { overrides: { sync_distance: -1 }, message: /node sync_distance -1 is not a canonical unsigned decimal string/ },
    ];

    try {
      for (const testCase of cases) {
        installBeaconMock({ syncingOverrides: testCase.overrides });
        try {
          await assert.rejects(
            assertBeaconValidatorReadyForFunding(
              PUBKEY,
              WITHDRAWAL_CREDENTIALS,
              "fund-test",
              refusingReader(),
            ),
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

  it("re-runs the head preflight after an excess-balance confirmation and refuses divergence", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";
    const confirmed = "1500000000";

    try {
      for (const leg of freshPredepositLegs) {
        // Balance moved between the prompt and the re-read.
        let calls = installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: [
            beaconValidator("pending_initialized", {}, { balance: confirmed }),
            beaconValidator("pending_initialized", {}, { balance: "2000000000" }),
          ],
        });
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader(confirmed)),
            new RegExp(
              `${leg.label} head beacon validator balance changed from the confirmed ${confirmed} ` +
                `Gwei to 2000000000 Gwei between the confirmation and the re-read`,
            ),
          );
          assert.equal(
            calls.filter((pathname) => pathname === `/eth/v1/beacon/states/head/validators/${PUBKEY}`)
              .length,
            2,
            `${leg.label} did not re-read head state after the confirmation`,
          );
        } finally {
          restoreFetch();
        }

        // A different head-state anomaly appearing after the confirmation is equally fatal.
        calls = installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: [
            beaconValidator("pending_initialized", {}, { balance: confirmed }),
            beaconValidator("pending_initialized", { slashed: true }, { balance: confirmed }),
          ],
        });
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader(confirmed)),
            new RegExp(`${leg.label} head re-read beacon validator is slashed`),
          );
        } finally {
          restoreFetch();
        }

        // An unchanged balance passes, and the re-read still happened.
        calls = installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: beaconValidator("pending_initialized", {}, { balance: confirmed }),
        });
        const log = captureLog();
        try {
          await leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, typedReader(confirmed));
        } finally {
          log.restore();
          restoreFetch();
        }
        assert.equal(
          calls.filter((pathname) => pathname === `/eth/v1/beacon/states/head/validators/${PUBKEY}`)
            .length,
          2,
          `${leg.label} did not re-read head state on the passing path`,
        );
        assert(
          log.lines.some((line) => line.includes(`${leg.label} head re-read beacon state id: head`)),
          `missing head re-read preflight print for ${leg.label}`,
        );
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("still confirms credentials at the settled state through the surviving entry points", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      for (const leg of freshPredepositLegs) {
        const calls = installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized", {
            withdrawal_credentials: OTHER_WITHDRAWAL_CREDENTIALS,
          }),
          headValidator: beaconValidator("pending_initialized"),
        });
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
            new RegExp(
              `${leg.label} beacon withdrawal_credentials ${OTHER_WITHDRAWAL_CREDENTIALS} != pool ` +
                WITHDRAWAL_CREDENTIALS,
            ),
          );
          // The settled-state read is what failed: head was never consulted.
          assert(!calls.includes(`/eth/v1/beacon/states/head/validators/${PUBKEY}`));
        } finally {
          restoreFetch();
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("keeps every other anomaly fatal without prompting when the balance is also excessive", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      for (const leg of freshPredepositLegs) {
        installBeaconMock({
          finalizedValidator: beaconValidator("pending_initialized"),
          headValidator: beaconValidator(
            "pending_initialized",
            { exit_epoch: "14" },
            { balance: "32000000000" },
          ),
        });
        try {
          await assert.rejects(
            leg.assert(PUBKEY, WITHDRAWAL_CREDENTIALS, leg.label, refusingReader()),
            /exit_epoch 14 is not FAR_FUTURE_EPOCH/,
          );
        } finally {
          restoreFetch();
        }
      }
    } finally {
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
    }
  });

  it("restricts BEACON_CONFIRMATION_STATE_ID to settled states", async function () {
    const originalBeaconNodeUrl = process.env.BEACON_NODE_URL;
    const originalStateId = process.env.BEACON_CONFIRMATION_STATE_ID;
    process.env.BEACON_NODE_URL = "http://beacon.example";

    try {
      for (const stateId of ["head", "justified-ish", "0x1234", ""]) {
        process.env.BEACON_CONFIRMATION_STATE_ID = stateId;
        installBeaconMock({});
        try {
          await assert.rejects(
            assertBeaconValidatorReadyForFunding(
              PUBKEY,
              WITHDRAWAL_CREDENTIALS,
              "fund-test",
              refusingReader(),
            ),
            new RegExp(
              `fund-test BEACON_CONFIRMATION_STATE_ID ${stateId} is not allowed; ` +
                `use one of finalized, justified`,
            ),
          );
        } finally {
          restoreFetch();
        }
      }

      for (const stateId of ["finalized", "justified"]) {
        process.env.BEACON_CONFIRMATION_STATE_ID = stateId;
        const calls = installBeaconMock({});
        const log = captureLog();
        try {
          await assertBeaconValidatorReadyForFunding(
            PUBKEY,
            WITHDRAWAL_CREDENTIALS,
            "fund-test",
            refusingReader(),
          );
        } finally {
          log.restore();
          restoreFetch();
        }
        assert(calls.includes(`/eth/v1/beacon/states/${stateId}/validators/${PUBKEY}`));
        assert(calls.includes(`/eth/v1/beacon/states/head/validators/${PUBKEY}`));
      }
    } finally {
      restoreFetch();
      restoreEnv("BEACON_NODE_URL", originalBeaconNodeUrl);
      restoreEnv("BEACON_CONFIRMATION_STATE_ID", originalStateId);
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
      // WITHDRAWAL_CREDENTIALS are this pool address's own 0x01 credentials, which
      // `assertDeploymentMatchesPool` now derives rather than trusts.
      pool: "0x2222222222222222222222222222222222222222",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function setDeletedOverrideVars(): () => void {
  const originals = DELETED_OVERRIDE_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of DELETED_OVERRIDE_VARS) process.env[name] = "1";
  return () => {
    for (const [name, value] of originals) restoreEnv(name, value);
  };
}

function clearDeletedOverrideVars(): () => void {
  const originals = DELETED_OVERRIDE_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of DELETED_OVERRIDE_VARS) delete process.env[name];
  return () => {
    for (const [name, value] of originals) restoreEnv(name, value);
  };
}

// Any preflight that reaches this reader has decided to ask for a confirmation it should not need.
function refusingReader(): ExcessBalanceConfirmationReader {
  const refuse = (): never => {
    throw new Error("unexpected excess-balance confirmation attempt");
  };
  return { isTty: refuse, readLine: refuse };
}

function typedReader(answer: string, isTty = true) {
  const prompts: string[] = [];
  return {
    prompts,
    isTty: () => isTty,
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      return answer;
    },
  };
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

let originalFetch: typeof fetch | undefined;

type BeaconValidatorBody = ReturnType<typeof beaconValidator>;

function installBeaconMock({
  finalizedValidator = beaconValidator("pending_initialized"),
  headValidator = beaconValidator("pending_initialized"),
  headSlot = "8192",
  genesisForkVersion = "0x00000000",
  beaconChainId = "31337",
  depositContractAddress = "0x1111111111111111111111111111111111111111",
  validatorStatus = 200,
  syncingOverrides = {},
}: {
  finalizedValidator?: BeaconValidatorBody;
  /// A single body, or one body per successive head-state validator fetch. The last entry is
  /// reused once the list runs out, so a two-entry list models a validator whose head state
  /// changes between the first read and the post-confirmation re-read.
  headValidator?: BeaconValidatorBody | BeaconValidatorBody[];
  headSlot?: string;
  genesisForkVersion?: string;
  beaconChainId?: string;
  depositContractAddress?: string;
  validatorStatus?: number;
  syncingOverrides?: Record<string, unknown>;
}): string[] {
  const calls: string[] = [];
  const headValidators = Array.isArray(headValidator) ? headValidator : [headValidator];
  let headValidatorReads = 0;
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    calls.push(url.pathname);

    if (url.pathname === "/eth/v1/node/syncing") {
      return jsonResponse({
        data: {
          head_slot: headSlot,
          sync_distance: "0",
          is_syncing: false,
          is_optimistic: false,
          el_offline: false,
          ...syncingOverrides,
        },
      });
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
    if (url.pathname === "/eth/v1/config/deposit_contract") {
      return jsonResponse({ data: { chain_id: beaconChainId, address: depositContractAddress } });
    }

    const validatorMatch = url.pathname.match(/^\/eth\/v1\/beacon\/states\/([^/]+)\/validators\//);
    if (validatorMatch !== null) {
      if (validatorStatus !== 200) {
        return new Response("validator not found", { status: validatorStatus });
      }
      if (validatorMatch[1] !== "head") {
        return jsonResponse(finalizedValidator);
      }
      const body = headValidators[Math.min(headValidatorReads, headValidators.length - 1)];
      headValidatorReads += 1;
      return jsonResponse(body);
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

/// Overrides are deliberately untyped: several tests need to reproduce responses a
/// conforming beacon node would never send. A key set to `undefined` is dropped by
/// `JSON.stringify`, so `{ slashed: undefined }` models an omitted field.
function beaconValidator(
  status: string,
  validatorOverrides: Record<string, unknown> = {},
  responseOverrides: Record<string, unknown> = {},
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
