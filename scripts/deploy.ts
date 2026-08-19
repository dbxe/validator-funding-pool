import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertDeploymentCanonicity,
  assertDeploymentMatchesPool,
  assertDeploymentSystemCodeHashes,
  assertFreshDeploymentMatchesExpectedPool,
  assertHasCode,
  assertRuntimeCodeMatchesLocalBuild,
  codeHash,
  defaultDepositContract,
  deploymentPath,
  envAddress,
  envBigInt,
  readLocalBuildArtifacts,
  reportFatalError,
  VERIFIED_POOL,
  waitForSenderVerifiedReceipt,
  writeDeployment,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
} from "./lib/common.js";

async function main() {
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, deployer.account.address, "deploy");
  // `deploy` is the one command that WRITES the record every other command reads, so it
  // announces the same path at the same point in its output rather than only when it
  // writes. An existing record at that path is overwritten.
  console.log(`Deployment record: ${deploymentPath()} (to be written by this command)`);

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
  // The redeploy guard. Every other command treats `EXPECTED_POOL` as "the pool I mean"; this
  // one would otherwise ignore it and overwrite the record naming that pool with a new one.
  // Checked before `writeDeployment`, so a refusal leaves the existing record intact.
  assertFreshDeploymentMatchesExpectedPool(pool.address);

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
  await assertRuntimeCodeMatchesLocalBuild(
    publicClient,
    pool.address,
    readLocalBuildArtifacts(VERIFIED_POOL),
    VERIFIED_POOL,
  );
  writeDeployment(deployment);
}

main().catch((error) => reportFatalError(error, "deploy"));
