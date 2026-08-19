import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertDeploymentCanonicity,
  assertDeploymentMatchesPool,
  assertDeploymentSystemCodeHashes,
  assertHasCode,
  assertPoolRuntimeCodeMatchesLocalBuild,
  codeHash,
  defaultDepositContract,
  envAddress,
  envBigInt,
  readLocalPoolBuildArtifacts,
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
  // Every other command runs this through `assertDeploymentIntegrity`, and the
  // documentation says every script compares the pool's runtime code against a local build.
  // `deploy` did not, which made it the one command that could write a deployment record
  // for a pool whose code it never checked -- and the record is what every later command
  // starts from. It reads the chain rather than the artifact it just deployed from, so a
  // creation transaction that landed as something other than what was compiled is caught
  // here, before the address is written down or published.
  await assertPoolRuntimeCodeMatchesLocalBuild(
    publicClient,
    pool.address,
    readLocalPoolBuildArtifacts(),
  );
  writeDeployment(deployment);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
