import { network } from "hardhat";

import {
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  formatWei,
  readDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  if (deployment.feeRecipientForwarder === undefined) {
    throw new Error("Deployment record has no feeRecipientForwarder; run deploy-forwarder first");
  }

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const forwarderBalanceAfter = await publicClient.getBalance({
    address: deployment.feeRecipientForwarder,
  });
  const poolBalanceAfter = await publicClient.getBalance({ address: deployment.pool });
  console.log(`Swept in block ${receipt.blockNumber}`);
  console.log(`Forwarder pending balance after: ${formatWei(forwarderBalanceAfter)}`);
  console.log(`Pool balance after: ${formatWei(poolBalanceAfter)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
