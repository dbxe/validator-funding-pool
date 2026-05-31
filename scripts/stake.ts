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
  const validatorCount = Number(BigInt(deployment.validatorCount));
  if (deposits.length !== validatorCount) {
    throw new Error(`Deposit data count ${deposits.length} does not match validatorCount ${validatorCount}`);
  }

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  const expectedCredentials = (await pool.read.withdrawalCredentials()).toLowerCase();
  const expectedAmountGwei = BigInt(deployment.validatorDepositWei) / GWEI;

  const pubkeys = [] as `0x${string}`[];
  const signatures = [] as `0x${string}`[];
  const depositDataRoots = [] as `0x${string}`[];
  for (const [index, deposit] of deposits.entries()) {
    const withdrawalCredentials = asHex(deposit.withdrawal_credentials).toLowerCase();
    if (withdrawalCredentials !== expectedCredentials) {
      throw new Error(
        `Deposit ${index} withdrawal_credentials ${withdrawalCredentials} != pool ${expectedCredentials}`,
      );
    }
    if (BigInt(deposit.amount) !== expectedAmountGwei) {
      throw new Error(`Deposit ${index} amount ${deposit.amount} != expected ${expectedAmountGwei}`);
    }
    pubkeys.push(asHex(deposit.pubkey));
    signatures.push(asHex(deposit.signature));
    depositDataRoots.push(asHex(deposit.deposit_data_root));
  }

  console.log(`Submitting ${validatorCount} validator deposit(s) through ${deployment.pool}`);
  const hash = await pool.write.stake([pubkeys, signatures, depositDataRoots]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Staked in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
