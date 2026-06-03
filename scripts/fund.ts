import { network } from "hardhat";

import { assertDeploymentChain, envBigInt, formatWei, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const target = await pool.read.fundingTargetOf([wallet.account.address]);
  const funded = await pool.read.fundedOf([wallet.account.address]);
  const remaining = target - funded;
  if (remaining <= 0n) {
    throw new Error(`No remaining funding cap for ${wallet.account.address}`);
  }

  const amount = envBigInt("AMOUNT_WEI", remaining);
  if (amount > remaining) {
    throw new Error(`AMOUNT_WEI exceeds remaining cap: ${formatWei(remaining)}`);
  }

  console.log(`Funding ${deployment.pool} from ${wallet.account.address}: ${formatWei(amount)}`);
  const hash = await pool.write.fund({ value: amount });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Funded in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
