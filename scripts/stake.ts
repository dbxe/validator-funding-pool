import { network } from "hardhat";

import { assertBeaconValidatorAbsent, assertDeploymentChain, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  if (wallet.account.address.toLowerCase() !== deployment.operator.toLowerCase()) {
    throw new Error(`PRIVATE_KEY must be the operator ${deployment.operator}`);
  }

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const pubkey = await pool.read.validatorPubkey();
  const depositDataRoot = await pool.read.validatorDepositDataRoot();
  await assertBeaconValidatorAbsent(pubkey, "stake");

  console.log(`Submitting committed validator deposit through ${deployment.pool}`);
  console.log(`Validator pubkey: ${pubkey}`);
  console.log(`Deposit data root: ${depositDataRoot}`);
  const hash = await pool.write.stake();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Staked in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
