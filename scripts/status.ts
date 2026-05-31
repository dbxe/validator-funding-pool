import { network } from "hardhat";

import { formatWei, readDeployment } from "./lib/common.js";

const STATE_NAMES = ["Funding", "Staked", "Canceled"];

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  const state = Number(await pool.read.state());
  const participantCount = Number(await pool.read.participantCount());
  const validatorCount = Number(await pool.read.depositedValidatorCount());
  const balance = await publicClient.getBalance({ address: deployment.pool });

  console.log(`Pool: ${deployment.pool}`);
  console.log(`State: ${STATE_NAMES[state] ?? state}`);
  console.log(`Balance: ${formatWei(balance)}`);
  console.log(`Gross proceeds: ${formatWei(await pool.read.grossPoolProceeds())}`);
  console.log(`Total funded: ${formatWei(await pool.read.totalFunded())}`);
  console.log(`Total claimed: ${formatWei(await pool.read.totalClaimed())}`);
  console.log(`Deposited validators: ${validatorCount}`);

  for (let i = 0; i < participantCount; ++i) {
    const participant = await pool.read.participantAt([BigInt(i)]);
    console.log(
      `Participant ${i}: ${participant} target=${formatWei(
        await pool.read.fundingTargetOf([participant]),
      )} funded=${formatWei(await pool.read.fundedOf([participant]))} claimed=${formatWei(
        await pool.read.claimedOf([participant]),
      )} claimable=${formatWei(await pool.read.claimable([participant]))}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
