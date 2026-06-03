import { network } from "hardhat";

import { assertDeploymentChain, formatWei, readDeployment } from "./lib/common.js";

const STATE_NAMES = ["Uninitialized", "Funding", "Staked", "Canceled"];

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  const state = Number(await pool.read.state());
  const participantCount = Number(await pool.read.participantCount());
  const balance = await publicClient.getBalance({ address: deployment.pool });

  console.log(`Pool: ${deployment.pool}`);
  console.log(`State: ${STATE_NAMES[state] ?? state}`);
  console.log(`Operator: ${await pool.read.operator()}`);
  console.log(`Funding deadline: ${await pool.read.fundingDeadline()}`);
  console.log(`Balance: ${formatWei(balance)}`);
  console.log(`Gross proceeds: ${formatWei(await pool.read.grossPoolProceeds())}`);
  console.log(`Gross canceled surplus: ${formatWei(await pool.read.grossCanceledSurplus())}`);
  console.log(`Total funded: ${formatWei(await pool.read.totalFundedWei())}`);
  console.log(`Total claimed: ${formatWei(await pool.read.totalClaimedWei())}`);
  console.log(`Validator deposit submitted: ${await pool.read.validatorDepositSubmitted()}`);
  console.log(`Validator pubkey: ${await pool.read.committedPubkey()}`);
  console.log(`Validator pubkey hash: ${await pool.read.committedPubkeyHash()}`);
  console.log(`Deposit data root: ${await pool.read.committedDepositDataRoot()}`);
  console.log(`Exit request count: ${await pool.read.exitRequestAttemptCount()}`);
  console.log(`Last exit request fee: ${formatWei(await pool.read.lastExitRequestFeePaid())}`);

  for (let i = 0; i < participantCount; ++i) {
    const participant = await pool.read.participantAt([BigInt(i)]);
    console.log(
      `Participant ${i}: ${participant} target=${formatWei(
        await pool.read.fundingTargetWeiOf([participant]),
      )} funded=${formatWei(await pool.read.fundedWeiOf([participant]))} claimed=${formatWei(
        await pool.read.claimedWeiOf([participant]),
      )} claimable=${formatWei(await pool.read.claimable([participant]))} canceledSurplusClaimable=${formatWei(
        await pool.read.canceledSurplusClaimable([participant]),
      )}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
