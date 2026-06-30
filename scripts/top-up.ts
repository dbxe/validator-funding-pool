import { network } from "hardhat";

import {
  assertBeaconValidatorReadyForTopUp,
  assertDeploymentChain,
  assertDeploymentSystemCodeHashes,
  assertPoolWithdrawalCredentials,
  readDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);
  await assertDeploymentSystemCodeHashes(publicClient, deployment);

  if (wallet.account.address.toLowerCase() !== deployment.operator.toLowerCase()) {
    throw new Error(`PRIVATE_KEY must be the operator ${deployment.operator}`);
  }

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const expectedCredentials = await assertPoolWithdrawalCredentials(pool, deployment);
  const pubkey = await pool.read.committedPubkey();
  await assertBeaconValidatorReadyForTopUp(pubkey, expectedCredentials, "top-up");

  console.log(`Submitting 31 ETH top-up through ${deployment.pool}`);
  console.log(`Validator pubkey: ${pubkey}`);
  console.log(`Top-up deposit data root: ${await pool.read.topUpDepositDataRoot()}`);
  const hash = await pool.write.topUpValidator();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Topped up in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
