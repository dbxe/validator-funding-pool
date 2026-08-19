import { writeFileSync } from "node:fs";

import { SecretKey } from "@chainsafe/blst";
import type { Hex } from "viem";

import {
  computeDepositDataRoot,
  computeDepositSigningRoot,
  PREDEPOSIT_GWEI,
  TOP_UP_GWEI,
  type DepositData,
} from "../scripts/lib/common.js";

/// Builds a real `deposit-data.json`, shaped exactly as `staking-deposit-cli` writes one:
/// unprefixed lowercase hex, `amount` as a JSON number, an unprefixed `fork_version`, and a
/// `network_name`. The commands validate this file with real BLS verification against the
/// fork version the mock beacon reports, so nothing here can be a placeholder — the
/// signatures are genuine signatures over the genuine signing root.
///
/// The withdrawal credentials come from the pool that was just deployed, which is why this
/// runs after `deploy` rather than from a checked-in fixture: credentials are derived from
/// the pool's own address.
export interface GeneratedDepositData {
  pubkey: Hex;
  entries: DepositData[];
}

export function buildDepositData(
  keySeed: number,
  withdrawalCredentials: Hex,
  forkVersion: Hex,
): GeneratedDepositData {
  const secretKey = SecretKey.fromKeygen(Buffer.alloc(32, keySeed));
  const pubkey = `0x${Buffer.from(secretKey.toPublicKey().toBytes()).toString("hex")}` as Hex;

  const entry = (amountGwei: bigint): DepositData => {
    const signingRoot = computeDepositSigningRoot(
      pubkey,
      withdrawalCredentials,
      amountGwei,
      forkVersion,
    );
    const signature = `0x${Buffer.from(
      secretKey.sign(Buffer.from(signingRoot.slice(2), "hex")).toBytes(),
    ).toString("hex")}` as Hex;
    return {
      pubkey: strip(pubkey),
      withdrawal_credentials: strip(withdrawalCredentials),
      amount: Number(amountGwei),
      signature: strip(signature),
      deposit_message_root: strip(signingRoot),
      deposit_data_root: strip(
        computeDepositDataRoot(pubkey, withdrawalCredentials, amountGwei, signature),
      ),
      fork_version: strip(forkVersion),
      network_name: "mainnet",
      deposit_cli_version: "2.8.0",
    } as DepositData;
  };

  return { pubkey, entries: [entry(PREDEPOSIT_GWEI), entry(TOP_UP_GWEI)] };
}

export function writeDepositDataFile(file: string, generated: GeneratedDepositData) {
  writeFileSync(file, `${JSON.stringify(generated.entries, null, 2)}\n`);
}

function strip(value: Hex): string {
  return value.slice(2).toLowerCase();
}
