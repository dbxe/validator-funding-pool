import { network } from "hardhat";

import { assertDeploymentIntegrity, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  await assertDeploymentIntegrity(publicClient, pool, deployment);

  console.log(`Closing expired funding attempt for ${deployment.pool}`);
  const hash = await pool.write.closeExpiredFundingAttempt();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Closed in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
