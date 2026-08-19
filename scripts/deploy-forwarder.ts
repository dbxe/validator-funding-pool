import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  readDeployment,
  reportFatalError,
  waitForSenderVerifiedReceipt,
  writeDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "deploy-forwarder");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  await assertDeploymentIntegrity(publicClient, pool, deployment);

  // See deploy.ts: sendDeploymentTransaction is used for the transaction hash the
  // post-broadcast sender check needs.
  const { contract: forwarder, deploymentTransaction } = await viem.sendDeploymentTransaction(
    "FeeRecipientForwarder",
    [deployment.pool],
  );
  const deploymentReceipt = await waitForSenderVerifiedReceipt(
    publicClient,
    deploymentTransaction.hash,
    signer,
    "deploy-forwarder",
  );
  assertDeployedAt(deploymentReceipt.contractAddress, forwarder.address, "FeeRecipientForwarder");

  const updatedDeployment = {
    ...deployment,
    feeRecipientForwarder: forwarder.address,
  };
  await assertFeeRecipientForwarderMatchesDeployment(publicClient, forwarder, updatedDeployment);
  writeDeployment(updatedDeployment);

  console.log(`Fee recipient forwarder deployed: ${forwarder.address}`);
  console.log(`Immutable pool destination: ${deployment.pool}`);
  console.log("Do not configure fee_recipient until the pool is topped up.");
}

main().catch((error) => reportFatalError(error, "deploy-forwarder"));
