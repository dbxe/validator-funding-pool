import { network } from "hardhat";

import {
  asAddress,
  assertActiveSigner,
  assertDeploymentIntegrity,
  formatWei,
  readDeployment,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "refund");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  await assertDeploymentIntegrity(publicClient, pool, deployment);

  const refundable = await pool.read.refundableWeiOf([signer]);
  console.log(`Refundable for ${signer}: ${formatWei(refundable)}`);
  if (refundable === 0n) {
    // See claim.ts: a zero-balance exit says so instead of ending in silence.
    console.log("Nothing to refund; no transaction was sent.");
    return;
  }

  const recipient = process.env.RECIPIENT ? asAddress(process.env.RECIPIENT) : signer;
  const hash = recipient.toLowerCase() === signer.toLowerCase()
    ? await pool.write.refund()
    : await pool.write.refundTo([recipient]);
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "refund");
  console.log(`Refunded to ${recipient} in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
