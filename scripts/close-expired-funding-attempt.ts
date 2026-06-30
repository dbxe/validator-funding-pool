import { network } from "hardhat";

import { assertDeploymentChain, assertDeploymentSystemCodeHashes, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);
  await assertDeploymentSystemCodeHashes(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  console.log(`Closing expired funding attempt for ${deployment.pool}`);
  const hash = await pool.write.closeExpiredFundingAttempt();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Closed in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
