import { network } from "hardhat";

import {
  assertDeploymentChain,
  asHex,
  readDeployment,
  readSingleDepositData,
  validateDepositData,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const deposit = readSingleDepositData();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const expectedCredentials = await pool.read.withdrawalCredentials();
  const expectedPubkey = process.env.EXPECTED_PUBKEY ? asHex(process.env.EXPECTED_PUBKEY) : undefined;
  const validated = validateDepositData(deposit, expectedCredentials, expectedPubkey);

  if (wallet.account.address.toLowerCase() !== deployment.operator.toLowerCase()) {
    throw new Error(`PRIVATE_KEY must be the operator ${deployment.operator}`);
  }

  console.log(`Committing validator ${validated.pubkey} to ${deployment.pool}`);
  const hash = await pool.write.commitValidator([
    validated.pubkey,
    validated.signature,
    validated.depositDataRoot,
  ]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const fundingDeadline = await pool.read.fundingDeadline();
  console.log(`Committed in block ${receipt.blockNumber}`);
  console.log(`Funding deadline: ${fundingDeadline}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
