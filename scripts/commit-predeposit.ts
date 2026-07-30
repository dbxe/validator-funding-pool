import { network } from "hardhat";

import {
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorAbsent,
  assertDeploymentIntegrity,
  asHex,
  PREDEPOSIT_GWEI,
  readBeaconGenesisForkVersion,
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
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "commit-predeposit");

  if (wallet.account.address.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`PRIVATE_KEY must be the operator ${liveConfig.operator}`);
  }

  const expectedCredentials = liveConfig.withdrawalCredentials;
  const expectedPubkey = process.env.EXPECTED_PUBKEY ? asHex(process.env.EXPECTED_PUBKEY) : undefined;
  const chainForkVersion = await readBeaconGenesisForkVersion("commit-predeposit");

  const predeposit = validateDepositData(
    deposits.predeposit,
    expectedCredentials,
    chainForkVersion,
    expectedPubkey,
    PREDEPOSIT_GWEI,
  );
  const topUp = validateDepositData(
    deposits.topUp,
    expectedCredentials,
    chainForkVersion,
    predeposit.pubkey,
    TOP_UP_GWEI,
  );

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
