import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  formatWei,
  readDeployment,
  reportFatalError,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  if (deployment.feeRecipientForwarder === undefined) {
    throw new Error("Deployment record has no feeRecipientForwarder; run deploy-forwarder first");
  }

  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "sweep");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  await assertDeploymentIntegrity(publicClient, pool, deployment);
  const forwarder = await viem.getContractAt(
    "FeeRecipientForwarder",
    deployment.feeRecipientForwarder,
    { client: { wallet } },
  );
  await assertFeeRecipientForwarderMatchesDeployment(publicClient, forwarder, deployment);

  const forwarderBalanceBefore = await publicClient.getBalance({
    address: deployment.feeRecipientForwarder,
  });
  const poolBalanceBefore = await publicClient.getBalance({ address: deployment.pool });
  console.log(`Forwarder pending balance: ${formatWei(forwarderBalanceBefore)}`);
  console.log(`Pool balance before: ${formatWei(poolBalanceBefore)}`);

  const hash = await forwarder.write.sweep();
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "sweep");
  const forwarderBalanceAfter = await publicClient.getBalance({
    address: deployment.feeRecipientForwarder,
  });
  const poolBalanceAfter = await publicClient.getBalance({ address: deployment.pool });
  console.log(`Swept in block ${receipt.blockNumber}`);
  console.log(`Forwarder pending balance after: ${formatWei(forwarderBalanceAfter)}`);
  console.log(`Pool balance after: ${formatWei(poolBalanceAfter)}`);
}

main().catch((error) => reportFatalError(error, "sweep"));
