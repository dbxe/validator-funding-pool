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

  const claimable = await pool.read.canceledSurplusClaimable([wallet.account.address]);
  console.log(`Canceled surplus claimable for ${wallet.account.address}: ${formatWei(claimable)}`);
  if (claimable === 0n) return;

  const hash = await pool.write.sweepCanceledSurplus();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Swept canceled surplus in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
