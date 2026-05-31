import { readFileSync } from "node:fs";

import { network } from "hardhat";

import { asHex, DEFAULT_DEPOSIT_DATA_FILE, readDeployment } from "./lib/common.js";

const GWEI = 1_000_000_000n;

interface DepositData {
  pubkey: string;
  withdrawal_credentials: string;
  amount: string | number;
  signature: string;
  deposit_data_root: string;
}

async function main() {
  const deployment = readDeployment();
  const depositDataFile = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE;
  const deposits = JSON.parse(readFileSync(depositDataFile, "utf8")) as DepositData[];
  if (deposits.length !== 1) {
    throw new Error(`Expected exactly one validator deposit entry, got ${deposits.length}`);
  }

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  const expectedCredentials = (await pool.read.withdrawalCredentials()).toLowerCase();
  const expectedAmountGwei = BigInt(deployment.validatorDepositWei) / GWEI;

  const deposit = deposits[0];
  const withdrawalCredentials = asHex(deposit.withdrawal_credentials).toLowerCase();
  if (withdrawalCredentials !== expectedCredentials) {
    throw new Error(`Deposit withdrawal_credentials ${withdrawalCredentials} != pool ${expectedCredentials}`);
  }
  if (BigInt(deposit.amount) !== expectedAmountGwei) {
    throw new Error(`Deposit amount ${deposit.amount} != expected ${expectedAmountGwei}`);
  }

  const pubkey = asHex(deposit.pubkey);
  const signature = asHex(deposit.signature);
  const depositDataRoot = asHex(deposit.deposit_data_root);

  console.log(`Submitting validator deposit through ${deployment.pool}`);
  const hash = await pool.write.stake([pubkey, signature, depositDataRoot]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Staked in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
