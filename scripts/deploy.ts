import { network } from "hardhat";

import {
  defaultDepositContract,
  defaultValidatorDepositGwei,
  envAddress,
  envNumber,
  parseAddressList,
  parseBigIntList,
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
  const validatorDepositGwei = defaultValidatorDepositGwei();
  const validatorDepositWei = validatorDepositGwei * GWEI;
  const deadlineSeconds = envNumber("FUNDING_DEADLINE_SECONDS", 86_400);
  const latestBlock = await publicClient.getBlock();
  const fundingDeadline = latestBlock.timestamp + BigInt(deadlineSeconds);

  const participants = process.env.PARTICIPANTS
    ? parseAddressList(process.env.PARTICIPANTS)
    : [deployer.account.address];
  const fundingTargetsGwei = process.env.FUNDING_TARGETS_GWEI
    ? parseBigIntList(process.env.FUNDING_TARGETS_GWEI)
    : [validatorDepositGwei];
  if (participants.length !== fundingTargetsGwei.length) {
    throw new Error("PARTICIPANTS and FUNDING_TARGETS_GWEI length mismatch");
  }

  const fundingTargetsWei = fundingTargetsGwei.map((value) => value * GWEI);
  const pool = await viem.deployContract("ValidatorFundingPool", [
    depositContract,
    withdrawalRequestPredeploy,
    validatorDepositWei,
    fundingDeadline,
    participants,
    fundingTargetsWei,
  ]);

  const chainId = await publicClient.getChainId();
  const withdrawalCredentials = await pool.read.withdrawalCredentials();

  console.log("Pool deployed:", pool.address);
  console.log("Withdrawal credentials:", withdrawalCredentials);

  writeDeployment({
    chainId,
    pool: pool.address,
    depositContract,
    withdrawalRequestPredeploy,
    validatorDepositWei: validatorDepositWei.toString(),
    fundingDeadline: fundingDeadline.toString(),
    withdrawalCredentials,
    participants,
    fundingTargetsWei: fundingTargetsWei.map((value) => value.toString()),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
