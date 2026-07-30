import { network } from "hardhat";

import {
  assertDeploymentCanonicity,
  assertDeploymentMatchesPool,
  assertDeploymentSystemCodeHashes,
  assertHasCode,
  codeHash,
  defaultDepositContract,
  envAddress,
  envBigInt,
  writeDeployment,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
} from "./lib/common.js";

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
  const depositContractCodeHash = await codeHash(publicClient, depositContract, "DEPOSIT_CONTRACT");
  const withdrawalRequestPredeployCodeHash = await codeHash(
    publicClient,
    withdrawalRequestPredeploy,
    "WITHDRAWAL_REQUEST_PREDEPLOY",
  );

  const operator = envAddress("OPERATOR", deployer.account.address);
  const fundingWindowDuration = envBigInt("FUNDING_WINDOW_SECONDS", 86_400n);
  const chainId = await publicClient.getChainId();
  await assertDeploymentCanonicity(
    chainId,
    { depositContract, withdrawalRequestPredeploy },
    { depositContractCodeHash, withdrawalRequestPredeployCodeHash },
  );

  const pool = await viem.deployContract("ValidatorFundingPool", [
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    fundingWindowDuration,
  ]);

  const withdrawalCredentials = await pool.read.withdrawalCredentials();

  console.log("Pool deployed:", pool.address);
  console.log("Operator:", operator);
  console.log("Withdrawal credentials:", withdrawalCredentials);
  console.log("Deposit contract code hash:", depositContractCodeHash);
  console.log("Withdrawal request predeploy code hash:", withdrawalRequestPredeployCodeHash);

  const deployment = {
    chainId,
    pool: pool.address,
    depositContract,
    depositContractCodeHash,
    withdrawalRequestPredeploy,
    withdrawalRequestPredeployCodeHash,
    operator,
    fundingWindowDuration: fundingWindowDuration.toString(),
    withdrawalCredentials,
  };
  const liveConfig = await assertDeploymentMatchesPool(pool, deployment);
  await assertDeploymentSystemCodeHashes(publicClient, deployment, liveConfig);
  writeDeployment(deployment);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
