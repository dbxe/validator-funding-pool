import { network } from "hardhat";

import {
  assertBeaconValidatorAbsent,
  assertDeploymentChain,
  asHex,
  PREDEPOSIT_GWEI,
  readDeployment,
  readPredepositAndTopUpDepositData,
  TOP_UP_GWEI,
  validateDepositData,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
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
  const expectedCredentials = await pool.read.withdrawalCredentials();
  const expectedPubkey = process.env.EXPECTED_PUBKEY ? asHex(process.env.EXPECTED_PUBKEY) : undefined;

  const predeposit = validateDepositData(
    deposits.predeposit,
    expectedCredentials,
    expectedPubkey,
    PREDEPOSIT_GWEI,
  );
  const topUp = validateDepositData(deposits.topUp, expectedCredentials, predeposit.pubkey, TOP_UP_GWEI);

  await assertBeaconValidatorAbsent(predeposit.pubkey, "commit-predeposit");

  console.log(`Committing validator ${predeposit.pubkey} to ${deployment.pool}`);
  console.log(`Submitting operator-funded predeposit: 1 ETH`);
  const hash = await pool.write.commitAndPredeposit(
    [predeposit.pubkey, predeposit.signature, predeposit.depositDataRoot, topUp.signature, topUp.depositDataRoot],
    { value: await pool.read.PREDEPOSIT_WEI() },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Predeposited in block ${receipt.blockNumber}`);
  console.log("Participants should wait for beacon confirmation before funding.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
