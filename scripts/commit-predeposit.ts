import { network } from "hardhat";

import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorAbsent,
  assertCompilationNotSkipped,
  assertContractPredepositWei,
  assertDeploymentIntegrity,
  assertExpectedPubkey,
  PREDEPOSIT_GWEI,
  PREDEPOSIT_WEI,
  printSuggestedFees,
  readBeaconGenesisForkVersion,
  readDeployment,
  readPredepositAndTopUpDepositData,
  reportFatalError,
  TOP_UP_GWEI,
  validateDepositData,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("commit-predeposit");
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  // Before a single RPC read, exactly like `assertExpectedPool`: this command binds the pool
  // to whatever validator the deposit-data file names, permanently, and the declaration is
  // the only check on that file that does not come from the file itself.
  const expectedPubkey = assertExpectedPubkey(deposits.predeposit.pubkey, "commit-predeposit");
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, wallet.account.address, "commit-predeposit");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(
    publicClient,
    pool,
    deployment,
    "forwarder-untouched",
  );
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "commit-predeposit");

  if (signer.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`commit-predeposit must be signed by the operator ${liveConfig.operator}`);
  }

  // The 1 ETH this command sends is the local constant, not the chain's answer; the chain's
  // answer only has to agree with it. See `assertContractPredepositWei`.
  assertContractPredepositWei(await pool.read.PREDEPOSIT_WEI(), "commit-predeposit");

  const expectedCredentials = liveConfig.withdrawalCredentials;
  const chainForkVersion = await readBeaconGenesisForkVersion(deployment.chainId, "commit-predeposit");

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
  await printSuggestedFees(publicClient, "commit-predeposit");
  const hash = await pool.write.commitAndPredeposit(
    [predeposit.pubkey, predeposit.signature, predeposit.depositDataRoot, topUp.signature, topUp.depositDataRoot],
    { value: PREDEPOSIT_WEI },
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
