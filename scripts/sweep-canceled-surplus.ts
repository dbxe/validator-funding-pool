import { network } from "hardhat";

import { asAddress, formatWei, readDeployment } from "./lib/common.js";

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

  const recipient = process.env.RECIPIENT ? asAddress(process.env.RECIPIENT) : wallet.account.address;
  const hash = recipient.toLowerCase() === wallet.account.address.toLowerCase()
    ? await pool.write.sweepCanceledSurplus()
    : await pool.write.sweepCanceledSurplusTo([recipient]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Swept canceled surplus to ${recipient} in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
