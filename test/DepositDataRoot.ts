import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SecretKey } from "@chainsafe/blst";
import type { Hex } from "viem";

import {
  computeDepositDataRoot,
  computeDepositSigningRoot,
  validateDepositData,
  VALIDATOR_DEPOSIT_GWEI,
} from "../scripts/lib/common.js";

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
});
