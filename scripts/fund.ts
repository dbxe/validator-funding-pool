import { network } from "hardhat";

import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorReadyForFunding,
  assertBeaconValidatorStillFresh,
  assertDeploymentIntegrity,
  assertFundingWasCredited,
  assertStillFundable,
  envBigInt,
  formatWei,
  fundViaPlainTransfer,
  PREDEPOSIT_GWEI,
  readBeaconGenesisForkVersion,
  readDeployment,
  readPredepositAndTopUpDepositData,
  TOP_UP_GWEI,
  validateDepositData,
  VALIDATOR_DEPOSIT_WEI,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

const GWEI = 1_000_000_000n;

async function main() {
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "fund");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "fund");

  const expectedCredentials = liveConfig.withdrawalCredentials;
  const chainForkVersion = await readBeaconGenesisForkVersion("fund");
  const predeposit = validateDepositData(
    deposits.predeposit,
    expectedCredentials,
    chainForkVersion,
    undefined,
    PREDEPOSIT_GWEI,
  );
  const topUp = validateDepositData(
    deposits.topUp,
    expectedCredentials,
    chainForkVersion,
    predeposit.pubkey,
    TOP_UP_GWEI,
  );

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
  const headBalanceGwei = await assertBeaconValidatorReadyForFunding(
    predeposit.pubkey,
    expectedCredentials,
    "fund",
  );

  await printAndCheckFundingReview(pool, signer);

  const remaining = await pool.read.fundingRemainingWeiOf([signer]);
  if (remaining <= 0n) {
    throw new Error(`No remaining funding cap for ${signer}`);
  }

  const amount = envBigInt("AMOUNT_WEI", remaining);
  if (amount > remaining) {
    throw new Error(`AMOUNT_WEI exceeds remaining cap: ${formatWei(remaining)}`);
  }

  const viaTransfer = fundViaPlainTransfer(connection.networkConfig);
  console.log(
    `Funding ${deployment.pool} from ${signer}: ${formatWei(amount)} ` +
      `via ${viaTransfer ? "plain transfer (zero calldata)" : "fund() calldata"}`,
  );

  // Final race-narrowing re-reads, immediately before signing. They cannot close the
  // race, only shorten it: see "Plain-Transfer Funding" in the README for the one
  // window where a plain transfer behaves differently from a reverting fund().
  //
  // The beacon leg matters just as much as the on-chain leg here. The full preflight ran
  // before the funding review printed and before the operator started reading it; on the
  // Ledger path the device approval is still ahead. Re-reading head state now shrinks the
  // window in which a third-party deposit, a slashing, or an activation can go unnoticed
  // from minutes to seconds.
  await assertBeaconValidatorStillFresh(
    predeposit.pubkey,
    expectedCredentials,
    "fund",
    headBalanceGwei,
  );
  await assertStillFundable(pool, publicClient, signer, amount);

  const hash = viaTransfer
    ? await wallet.sendTransaction({ to: deployment.pool, value: amount })
    : await pool.write.fund({ value: amount });
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "fund");
  // A successful receipt is not proof of funding. On the plain-transfer path a pool that
  // reached `ToppedUp` accepts the ETH as proceeds and emits `EthReceivedViaCall` instead
  // of crediting it, and the transaction still succeeds. The receipt's own logs are what
  // tell the two apart.
  assertFundingWasCredited(receipt, deployment.pool, signer, amount, "fund");
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
