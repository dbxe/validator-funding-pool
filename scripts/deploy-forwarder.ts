import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeployedAt,
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  assertForwarderAuthenticity,
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
  // The command that deploys and records a forwarder: any forwarder the record ALREADY names
  // is authenticated before it is replaced, so a record that was already wrong is a finding
  // here rather than an address quietly overwritten.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "authenticate-forwarder");

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
  // `sweep` and `status` reach this through `assertDeploymentIntegrity`, which runs it for the
  // commands that touch the forwarder. This command is the one that writes that field, so
  // it has no such record to run integrity against yet and calls the check directly — exactly
  // as `deploy.ts` does for the pool, and for the same reason: the address is about to be
  // written down and configured as a validator's fee recipient, so a creation transaction
  // that landed as something other than what was compiled has to be caught here.
  await assertForwarderAuthenticity(publicClient, forwarder.address, deployment.pool);
  writeDeployment(updatedDeployment);

  console.log(`Fee recipient forwarder deployed: ${forwarder.address}`);
  console.log(`Immutable pool destination: ${deployment.pool}`);
  console.log("Do not configure fee_recipient until the pool is topped up.");
}

main().catch((error) => reportFatalError(error, "deploy-forwarder"));
