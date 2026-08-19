import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertDeploymentCanonicity,
  assertDeploymentMatchesPool,
  assertDeploymentSystemCodeHashes,
  assertHasCode,
  codeHash,
  defaultDepositContract,
  envAddress,
  envBigInt,
  waitForSenderVerifiedReceipt,
  writeDeployment,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
} from "./lib/common.js";

async function main() {
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, deployer.account.address, "deploy");

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

  const operator = envAddress("OPERATOR", signer);
  const fundingWindowDuration = envBigInt("FUNDING_WINDOW_SECONDS", 86_400n);
  const chainId = await publicClient.getChainId();
  await assertDeploymentCanonicity(
    chainId,
    { depositContract, withdrawalRequestPredeploy },
    { depositContractCodeHash, withdrawalRequestPredeployCodeHash },
  );

  // sendDeploymentTransaction rather than deployContract: it surfaces the deployment
  // transaction hash, which is what the post-broadcast sender check needs. The address
  // it returns is derived from the sender and nonce before mining, so the receipt is
  // also checked to have created a contract at exactly that address.
  const { contract: pool, deploymentTransaction } = await viem.sendDeploymentTransaction(
    "ValidatorFundingPool",
    [depositContract, withdrawalRequestPredeploy, operator, fundingWindowDuration],
  );
  const deploymentReceipt = await waitForSenderVerifiedReceipt(
    publicClient,
    deploymentTransaction.hash,
    signer,
    "deploy",
  );
  assertDeployedAt(deploymentReceipt.contractAddress, pool.address, "ValidatorFundingPool");

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
