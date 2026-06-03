import { network } from "hardhat";

import {
  assertHasCode,
  defaultDepositContract,
  envAddress,
  envBigInt,
  parseAddressList,
  parseBigIntList,
  VALIDATOR_DEPOSIT_GWEI,
  writeDeployment,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
} from "./lib/common.js";

const GWEI = 1_000_000_000n;

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const depositContract = envAddress("DEPOSIT_CONTRACT", defaultDepositContract());
  const withdrawalRequestPredeploy = envAddress(
    "WITHDRAWAL_REQUEST_PREDEPLOY",
    DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
  );
  await assertHasCode(publicClient, depositContract, "DEPOSIT_CONTRACT");
  await assertHasCode(publicClient, withdrawalRequestPredeploy, "WITHDRAWAL_REQUEST_PREDEPLOY");

  const operator = envAddress("OPERATOR", deployer.account.address);
  const fundingWindowDuration = envBigInt("FUNDING_WINDOW_SECONDS", 86_400n);

  const participants = process.env.PARTICIPANTS
    ? parseAddressList(process.env.PARTICIPANTS)
    : [deployer.account.address];
  const fundingTargetsGwei = process.env.FUNDING_TARGETS_GWEI
    ? parseBigIntList(process.env.FUNDING_TARGETS_GWEI)
    : [VALIDATOR_DEPOSIT_GWEI];
  if (participants.length !== fundingTargetsGwei.length) {
    throw new Error("PARTICIPANTS and FUNDING_TARGETS_GWEI length mismatch");
  }

  const fundingTargetsWei = fundingTargetsGwei.map((value) => value * GWEI);
  const pool = await viem.deployContract("ValidatorFundingPool", [
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    fundingWindowDuration,
    participants,
    fundingTargetsWei,
  ]);

  const chainId = await publicClient.getChainId();
  const withdrawalCredentials = await pool.read.withdrawalCredentials();

  console.log("Pool deployed:", pool.address);
  console.log("Operator:", operator);
  console.log("Withdrawal credentials:", withdrawalCredentials);

  writeDeployment({
    chainId,
    pool: pool.address,
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    fundingWindowDuration: fundingWindowDuration.toString(),
    withdrawalCredentials,
    participants,
    fundingTargetsWei: fundingTargetsWei.map((value) => value.toString()),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
