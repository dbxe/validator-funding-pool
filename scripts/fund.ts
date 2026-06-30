import { network } from "hardhat";

import {
  assertBeaconValidatorHasWithdrawalCredentials,
  assertDeploymentChain,
  assertDeploymentSystemCodeHashes,
  assertPoolWithdrawalCredentials,
  envBigInt,
  formatWei,
  PREDEPOSIT_GWEI,
  readDeployment,
  readPredepositAndTopUpDepositData,
  TOP_UP_GWEI,
  validateDepositData,
  VALIDATOR_DEPOSIT_WEI,
} from "./lib/common.js";

const GWEI = 1_000_000_000n;

async function main() {
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);
  await assertDeploymentSystemCodeHashes(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const expectedCredentials = await assertPoolWithdrawalCredentials(pool, deployment);
  const predeposit = validateDepositData(deposits.predeposit, expectedCredentials, undefined, PREDEPOSIT_GWEI);
  const topUp = validateDepositData(deposits.topUp, expectedCredentials, predeposit.pubkey, TOP_UP_GWEI);

  const committedPubkey = await pool.read.committedPubkey();
  const predepositRoot = await pool.read.predepositDataRoot();
  const topUpRoot = await pool.read.topUpDepositDataRoot();
  const committedPredepositSignature = await pool.read.predepositSignature();
  const committedTopUpSignature = await pool.read.topUpSignature();
  if (committedPubkey.toLowerCase() !== predeposit.pubkey.toLowerCase()) {
    throw new Error(`Committed pubkey ${committedPubkey} != deposit-data pubkey ${predeposit.pubkey}`);
  }
  if (predepositRoot.toLowerCase() !== predeposit.depositDataRoot.toLowerCase()) {
    throw new Error(`Committed predeposit root ${predepositRoot} != deposit-data root ${predeposit.depositDataRoot}`);
  }
  if (topUpRoot.toLowerCase() !== topUp.depositDataRoot.toLowerCase()) {
    throw new Error(`Committed top-up root ${topUpRoot} != deposit-data root ${topUp.depositDataRoot}`);
  }
  if (committedPredepositSignature.toLowerCase() !== predeposit.signature.toLowerCase()) {
    throw new Error("Committed predeposit signature does not match deposit-data file");
  }
  if (committedTopUpSignature.toLowerCase() !== topUp.signature.toLowerCase()) {
    throw new Error("Committed top-up signature does not match deposit-data file");
  }
  await assertBeaconValidatorHasWithdrawalCredentials(predeposit.pubkey, expectedCredentials, "fund", true);

  await printAndCheckFundingReview(pool, wallet.account.address);

  const remaining = await pool.read.fundingRemainingWeiOf([wallet.account.address]);
  if (remaining <= 0n) {
    throw new Error(`No remaining funding cap for ${wallet.account.address}`);
  }

  const amount = envBigInt("AMOUNT_WEI", remaining);
  if (amount > remaining) {
    throw new Error(`AMOUNT_WEI exceeds remaining cap: ${formatWei(remaining)}`);
  }

  console.log(`Funding ${deployment.pool} from ${wallet.account.address}: ${formatWei(amount)}`);
  const hash = await pool.write.fund({ value: amount });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Funded in block ${receipt.blockNumber}`);
}

async function printAndCheckFundingReview(pool: any, caller: string) {
  const fundingAttempt = await pool.read.fundingAttempt();
  const fundingDeadline = await pool.read.fundingDeadline();
  const state = await pool.read.state();
  const totalActiveFundedWei = await pool.read.totalActiveFundedWei();
  const totalRefundableWei = await pool.read.totalRefundableWei();
  const participantCount = Number(await pool.read.participantCount());
  const operator = (await pool.read.operator()) as string;

  const expectedAttempt = process.env.EXPECTED_FUNDING_ATTEMPT;
  if (expectedAttempt !== undefined && BigInt(expectedAttempt) !== fundingAttempt) {
    throw new Error(`Funding attempt ${fundingAttempt} != EXPECTED_FUNDING_ATTEMPT ${expectedAttempt}`);
  }

  const expectedDeadlineBefore = process.env.EXPECTED_DEADLINE_BEFORE;
  if (expectedDeadlineBefore !== undefined && fundingDeadline > BigInt(expectedDeadlineBefore)) {
    throw new Error(`Funding deadline ${fundingDeadline} is after EXPECTED_DEADLINE_BEFORE ${expectedDeadlineBefore}`);
  }

  console.log(`Funding review for pool ${pool.address}`);
  console.log(`State: ${state}`);
  console.log(`Funding attempt: ${fundingAttempt}`);
  console.log(`Funding deadline: ${fundingDeadline}`);
  console.log(`Total active funded: ${formatWei(totalActiveFundedWei)}`);
  console.log(`Total refundable from previous attempts: ${formatWei(totalRefundableWei)}`);

  let callerTarget = 0n;
  let operatorTarget = 0n;
  for (let i = 0; i < participantCount; ++i) {
    const participant = (await pool.read.participantAt([BigInt(i)])) as string;
    const target = await pool.read.fundingTargetWeiOf([participant]);
    const funded = await pool.read.activeFundedWeiOf([participant]);
    const remaining = await pool.read.fundingRemainingWeiOf([participant]);
    const refundable = await pool.read.refundableWeiOf([participant]);
    if (participant.toLowerCase() === caller.toLowerCase()) callerTarget = target;
    if (participant.toLowerCase() === operator.toLowerCase()) operatorTarget = target;

    console.log(
      `Participant ${i}: ${participant} target=${formatWei(target)} activeFunded=${formatWei(
        funded,
      )} remaining=${formatWei(remaining)} refundable=${formatWei(refundable)}`,
    );
  }
  console.log(`Operator target: ${formatWei(operatorTarget)} (${formatPercent(operatorTarget)})`);

  const expectedMyTargetGwei = process.env.EXPECTED_MY_TARGET_GWEI;
  if (expectedMyTargetGwei !== undefined && callerTarget !== BigInt(expectedMyTargetGwei) * GWEI) {
    throw new Error(`Caller target ${formatWei(callerTarget)} != EXPECTED_MY_TARGET_GWEI ${expectedMyTargetGwei}`);
  }

  const expectedOperatorTargetGwei = process.env.EXPECTED_OPERATOR_TARGET_GWEI;
  if (expectedOperatorTargetGwei !== undefined && operatorTarget !== BigInt(expectedOperatorTargetGwei) * GWEI) {
    throw new Error(
      `Operator target ${formatWei(operatorTarget)} != EXPECTED_OPERATOR_TARGET_GWEI ${expectedOperatorTargetGwei}`,
    );
  }
}

function formatPercent(value: bigint): string {
  const basisPoints = (value * 10_000n) / VALIDATOR_DEPOSIT_WEI;
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, "0")}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
