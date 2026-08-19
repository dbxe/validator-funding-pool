import { network } from "hardhat";
import type { Address } from "viem";

import type { FundingPinnedValues } from "./lib/common.js";
import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorReadyForFunding,
  assertBeaconValidatorStillFresh,
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
  assertFundingPins,
  assertFundingWasCredited,
  assertStillFundable,
  envBigInt,
  formatPoolState,
  formatWei,
  fundViaPlainTransfer,
  PREDEPOSIT_GWEI,
  printSuggestedFees,
  readBeaconGenesisForkVersion,
  readDeployment,
  readPredepositAndTopUpDepositData,
  reportFatalError,
  TOP_UP_GWEI,
  validateDepositData,
  VALIDATOR_DEPOSIT_WEI,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("fund");
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, wallet.account.address, "fund");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(
    publicClient,
    pool,
    deployment,
    "forwarder-untouched",
  );
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

  const reviewed = await printAndCheckFundingReview(pool, signer);

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

  await printSuggestedFees(publicClient, "fund");
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
  await assertStillFundable(pool, publicClient, signer, amount, reviewed.fundingAttempt);

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

/// The pool reads the funding review makes. Structural rather than `any`: the review is
/// what the operator decides on, and an `any` here silently tolerated a misspelled getter
/// or a value read as the wrong type.
interface FundingReviewReader {
  address: Address;
  read: {
    state: () => Promise<number>;
    fundingAttempt: () => Promise<bigint>;
    fundingDeadline: () => Promise<bigint>;
    totalActiveFundedWei: () => Promise<bigint>;
    totalRefundableWei: () => Promise<bigint>;
    participantCount: () => Promise<bigint>;
    operator: () => Promise<Address>;
    participantAt: (args: readonly [bigint]) => Promise<Address>;
    fundingTargetWeiOf: (args: readonly [Address]) => Promise<bigint>;
    activeFundedWeiOf: (args: readonly [Address]) => Promise<bigint>;
    fundingRemainingWeiOf: (args: readonly [Address]) => Promise<bigint>;
    refundableWeiOf: (args: readonly [Address]) => Promise<bigint>;
  };
}

async function printAndCheckFundingReview(
  pool: FundingReviewReader,
  caller: Address,
): Promise<FundingPinnedValues> {
  const fundingAttempt = await pool.read.fundingAttempt();
  const fundingDeadline = await pool.read.fundingDeadline();
  const state = await pool.read.state();
  const totalActiveFundedWei = await pool.read.totalActiveFundedWei();
  const totalRefundableWei = await pool.read.totalRefundableWei();
  const participantCount = Number(await pool.read.participantCount());
  const operator = await pool.read.operator();

  console.log(`Funding review for pool ${pool.address}`);
  console.log(`State: ${formatPoolState(state)}`);
  console.log(`Funding attempt: ${fundingAttempt}`);
  console.log(`Funding deadline: ${fundingDeadline}`);
  console.log(`Total active funded: ${formatWei(totalActiveFundedWei)}`);
  console.log(`Total refundable from previous attempts: ${formatWei(totalRefundableWei)}`);

  let callerTargetWei = 0n;
  let operatorTargetWei = 0n;
  for (let i = 0; i < participantCount; ++i) {
    const participant = await pool.read.participantAt([BigInt(i)]);
    const target = await pool.read.fundingTargetWeiOf([participant]);
    const funded = await pool.read.activeFundedWeiOf([participant]);
    const remaining = await pool.read.fundingRemainingWeiOf([participant]);
    const refundable = await pool.read.refundableWeiOf([participant]);
    if (participant.toLowerCase() === caller.toLowerCase()) callerTargetWei = target;
    if (participant.toLowerCase() === operator.toLowerCase()) operatorTargetWei = target;

    console.log(
      `Participant ${i}: ${participant} target=${formatWei(target)} activeFunded=${formatWei(
        funded,
      )} remaining=${formatWei(remaining)} refundable=${formatWei(refundable)}`,
    );
  }
  console.log(`Operator target: ${formatWei(operatorTargetWei)} (${formatPercent(operatorTargetWei)})`);

  const reviewed = { fundingAttempt, fundingDeadline, callerTargetWei, operatorTargetWei };
  assertFundingPins(reviewed, "Funding review");
  return reviewed;
}

function formatPercent(value: bigint): string {
  const basisPoints = (value * 10_000n) / VALIDATOR_DEPOSIT_WEI;
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, "0")}%`;
}

main().catch((error) => reportFatalError(error, "fund"));
