import { network } from "hardhat";

import { formatWei, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const claimable = await pool.read.claimable([wallet.account.address]);
  console.log(`Claimable for ${wallet.account.address}: ${formatWei(claimable)}`);
  if (claimable === 0n) return;

  const hash = await pool.write.claim();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Claimed in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
