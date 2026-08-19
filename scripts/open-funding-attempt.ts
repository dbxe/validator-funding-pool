import { network } from "hardhat";

import {
  assertActiveSigner,
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
  assertFundingWindowNotDeclared,
  printSuggestedFees,
  readDeployment,
  reportFatalError,
  requireFundingAllocation,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

const GWEI = 1_000_000_000n;

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("open-funding-attempt");
  // Before the record is even opened: this is an input the operator supplied for THIS command,
  // and this command cannot act on it.
  assertFundingWindowNotDeclared("open-funding-attempt");
  // Read for the same reason and at the same moment: both variables are inputs the operator
  // supplied for THIS command, and neither has a defensible default. A missing one is fatal
  // before a single JSON-RPC request goes out.
  const { participants, fundingTargetsGwei } = requireFundingAllocation("open-funding-attempt");
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, wallet.account.address, "open-funding-attempt");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(
    publicClient,
    pool,
    deployment,
    "forwarder-untouched",
  );

  if (signer.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`open-funding-attempt must be signed by the operator ${liveConfig.operator}`);
  }

  const fundingTargetsWei = fundingTargetsGwei.map((value) => value * GWEI);
  console.log(`Opening funding attempt for ${deployment.pool}`);
  for (let i = 0; i < participants.length; ++i) {
    console.log(`Participant ${i}: ${participants[i]} target=${fundingTargetsGwei[i]} Gwei`);
  }
  await printSuggestedFees(publicClient, "open-funding-attempt");
  const hash = await pool.write.openFundingAttempt([participants, fundingTargetsWei]);
  const receipt = await waitForSenderVerifiedReceipt(
    publicClient,
    hash,
    signer,
    "open-funding-attempt",
  );
  console.log(`Opened in block ${receipt.blockNumber}`);
  // The deadline and the window it came from, together: the deadline is
  // `block.timestamp + fundingWindowDuration`, and the window is this pool's immutable — the
  // one number in the pair that no later command, this one included, can change.
  console.log(`Funding window (immutable): ${liveConfig.fundingWindowDuration}s`);
  console.log(`Funding deadline: ${await pool.read.fundingDeadline()}`);
}

main().catch((error) => reportFatalError(error, "open-funding-attempt"));
