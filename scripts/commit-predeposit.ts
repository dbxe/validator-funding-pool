import { network } from "hardhat";

import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorAbsent,
  assertDeploymentIntegrity,
  asHex,
  PREDEPOSIT_GWEI,
  readBeaconGenesisForkVersion,
  readDeployment,
  readPredepositAndTopUpDepositData,
  reportFatalError,
  TOP_UP_GWEI,
  validateDepositData,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "commit-predeposit");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "commit-predeposit");

  if (signer.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`commit-predeposit must be signed by the operator ${liveConfig.operator}`);
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
  const receipt = await waitForSenderVerifiedReceipt(
    publicClient,
    hash,
    signer,
    "commit-predeposit",
  );
  console.log(`Predeposited in block ${receipt.blockNumber}`);
  console.log("Participants should wait for beacon confirmation before funding.");
}

main().catch((error) => reportFatalError(error, "commit-predeposit"));
