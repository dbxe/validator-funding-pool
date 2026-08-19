import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  assertSweepWasCredited,
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

  // Pinned to the sweep's own block rather than read at head. The reads above happened
  // before the transaction was even broadcast, and a head read afterwards would fold in
  // every other transaction since — a refund or a claim leaving the pool in a later block
  // would look exactly like a sweep that never arrived. Across `blockNumber - 1` and
  // `blockNumber` the delta is the sweep's, plus at most whatever else shared its block.
  const blockBefore = { blockNumber: receipt.blockNumber - 1n };
  const blockOfSweep = { blockNumber: receipt.blockNumber };
  const [forwarderAtSweep, poolBeforeSweep, poolAfterSweep, forwarderBalanceAfter] =
    await Promise.all([
      publicClient.getBalance({ address: deployment.feeRecipientForwarder, ...blockBefore }),
      publicClient.getBalance({ address: deployment.pool, ...blockBefore }),
      publicClient.getBalance({ address: deployment.pool, ...blockOfSweep }),
      publicClient.getBalance({ address: deployment.feeRecipientForwarder }),
    ]);

  console.log(`Swept in block ${receipt.blockNumber}`);
  console.log(`Forwarder pending balance after: ${formatWei(forwarderBalanceAfter)}`);
  console.log(`Pool balance after: ${formatWei(poolAfterSweep)}`);
  assertSweepWasCredited(
    receipt,
    deployment.feeRecipientForwarder,
    deployment.pool,
    signer,
    { forwarderBefore: forwarderAtSweep, poolBefore: poolBeforeSweep, poolAfter: poolAfterSweep },
    "sweep",
  );
}

main().catch((error) => reportFatalError(error, "sweep"));
