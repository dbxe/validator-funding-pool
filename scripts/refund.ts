import { network } from "hardhat";

import { asAddress, assertDeploymentChain, formatWei, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const refundable = await pool.read.fundedWeiOf([wallet.account.address]);
  console.log(`Refundable for ${wallet.account.address}: ${formatWei(refundable)}`);
  if (refundable === 0n) return;

  const recipient = process.env.RECIPIENT ? asAddress(process.env.RECIPIENT) : wallet.account.address;
  const hash = recipient.toLowerCase() === wallet.account.address.toLowerCase()
    ? await pool.write.refund()
    : await pool.write.refundTo([recipient]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Refunded to ${recipient} in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
