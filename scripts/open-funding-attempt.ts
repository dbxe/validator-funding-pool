import { network } from "hardhat";

import {
  assertDeploymentIntegrity,
  parseAddressList,
  parseBigIntList,
  readDeployment,
  VALIDATOR_DEPOSIT_GWEI,
} from "./lib/common.js";

const GWEI = 1_000_000_000n;

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);

  if (wallet.account.address.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`PRIVATE_KEY must be the operator ${liveConfig.operator}`);
  }

  const participants = process.env.PARTICIPANTS
    ? parseAddressList(process.env.PARTICIPANTS)
    : [liveConfig.operator];
  const fundingTargetsGwei = process.env.FUNDING_TARGETS_GWEI
    ? parseBigIntList(process.env.FUNDING_TARGETS_GWEI)
    : [VALIDATOR_DEPOSIT_GWEI];
  if (participants.length !== fundingTargetsGwei.length) {
    throw new Error("PARTICIPANTS and FUNDING_TARGETS_GWEI length mismatch");
  }

  const fundingTargetsWei = fundingTargetsGwei.map((value) => value * GWEI);
  console.log(`Opening funding attempt for ${deployment.pool}`);
  for (let i = 0; i < participants.length; ++i) {
    console.log(`Participant ${i}: ${participants[i]} target=${fundingTargetsGwei[i]} Gwei`);
  }
  const hash = await pool.write.openFundingAttempt([participants, fundingTargetsWei]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Opened in block ${receipt.blockNumber}`);
  console.log(`Funding deadline: ${await pool.read.fundingDeadline()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
