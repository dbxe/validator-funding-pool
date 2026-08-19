import { network } from "hardhat";
import type { Address } from "viem";

import type { DeploymentPublicClient, DeploymentRecord } from "./lib/common.js";
import {
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
  assertForwarderAuthenticity,
  describeFatalError,
  formatPoolState,
  formatWei,
  parseAddressList,
  readDeployment,
  reportFatalError,
  warnOnPlaintextEndpoints,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("status");
  // Every other command reaches this through `assertActiveSigner`. `status` signs nothing,
  // so it calls it directly — a status read is exactly where an operator would notice that
  // the endpoint everything else trusts is plaintext.
  //
  // It runs after `network.create()` rather than before it because the URL it checks is the
  // connection's resolved one, which may come from the encrypted keystore rather than the
  // environment. Creating the connection sends no request; the resolution this forces is the
  // one the first `eth_call` below would have forced anyway.
  const connection = await network.create();
  await warnOnPlaintextEndpoints(connection);
  const deployment = readDeployment();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool);
  // `"forwarder-untouched"`, even though `status` is the command an operator runs to check the
  // sidecar. The forwarder IS authenticated here — at the end, below — but never as part of
  // the integrity gate, because a gate is a refusal: `assertForwarderAuthenticity` handed a
  // forwarder replaced on chain, or a missing `artifacts/FeeRecipientForwarder.sol`, would stop
  // `status` from printing a single line of pool state. Every FATAL in this repository ends by
  // telling the operator to run "npm run status" and reconcile, so the one command that must
  // never be blocked by the optional sidecar is this one. And it signs nothing, so downgrading
  // the refusal to a warning gives up nothing at all.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "forwarder-untouched");
  const state = Number(await pool.read.state());
  const participantCount = Number(await pool.read.participantCount());
  const balance = await publicClient.getBalance({ address: deployment.pool });

  console.log(`Pool: ${deployment.pool}`);
  console.log(`State: ${formatPoolState(state)}`);
  console.log(`Operator: ${await pool.read.operator()}`);
  console.log(`Funding attempt: ${await pool.read.fundingAttempt()}`);
  // The immutable, next to the deadline it produced. It is the bound on how long a listed
  // participant who never funds can lock everyone else's capital, it was chosen once at
  // deployment, and it is the number a participant should read off the pool before funding.
  console.log(`Funding window (immutable): ${await pool.read.fundingWindowDuration()}s`);
  console.log(`Funding deadline: ${await pool.read.fundingDeadline()}`);
  console.log(`Balance: ${formatWei(balance)}`);
  console.log(`Gross proceeds: ${formatWei(await pool.read.grossPoolProceeds())}`);
  console.log(`Total active funded: ${formatWei(await pool.read.totalActiveFundedWei())}`);
  console.log(`Total refundable: ${formatWei(await pool.read.totalRefundableWei())}`);
  console.log(`Total refunded: ${formatWei(await pool.read.totalRefundedWei())}`);
  console.log(`Total credited: ${formatWei(await pool.read.totalCreditedWei())}`);
  console.log(`Total claimed: ${formatWei(await pool.read.totalClaimedWei())}`);
  console.log(`Predeposit submitted: ${await pool.read.predepositSubmitted()}`);
  console.log(`Top-up submitted: ${await pool.read.topUpSubmitted()}`);
  console.log(`Validator pubkey: ${await pool.read.committedPubkey()}`);
  console.log(`Validator pubkey hash: ${await pool.read.committedPubkeyHash()}`);
  console.log(`Predeposit root: ${await pool.read.predepositDataRoot()}`);
  console.log(`Top-up root: ${await pool.read.topUpDepositDataRoot()}`);
  console.log(`Exit request count: ${await pool.read.exitRequestAttemptCount()}`);
  console.log(`Last exit request fee: ${formatWei(await pool.read.lastExitRequestFeePaid())}`);
  for (let i = 0; i < participantCount; ++i) {
    const participant = await pool.read.participantAt([BigInt(i)]);
    console.log(
      `Participant ${i}: ${participant} target=${formatWei(
        await pool.read.fundingTargetWeiOf([participant]),
      )} activeFunded=${formatWei(await pool.read.activeFundedWeiOf([participant]))} remaining=${formatWei(
        await pool.read.fundingRemainingWeiOf([participant]),
      )} refundable=${formatWei(await pool.read.refundableWeiOf([participant]))} credited=${formatWei(
        await pool.read.creditedWeiOf([participant]),
      )} claimed=${formatWei(await pool.read.claimedWeiOf([participant]))} claimable=${formatWei(
        await pool.read.claimable([participant]),
      )}`,
    );
  }

  // Last, and after every line of pool state above it: the forwarder is the optional sidecar,
  // and whatever is wrong with it must not cost the operator the reconciliation they came for.
  await reportForwarder(publicClient, deployment);

  const refundParticipants = process.env.REFUND_PARTICIPANTS
    ? parseAddressList(process.env.REFUND_PARTICIPANTS)
    : [];
  for (const participant of refundParticipants) {
    console.log(`Refund holder ${participant}: refundable=${formatWei(await pool.read.refundableWeiOf([participant]))}`);
  }
}

/// Prints the forwarder's address and balance, then authenticates it — and reports a failure
/// as a loud warning next to those lines rather than as a refusal.
///
/// The three layers `assertForwarderAuthenticity` applies are the ones that matter for an
/// address a validator client pays into on every proposal: the `EXPECTED_FORWARDER` pin, the
/// binding to this pool, and the runtime code against the local build. What changes here is
/// only what a failure costs. In `sweep` and `deploy-forwarder` a failure must stop the
/// command, because both are about to transact with the forwarder. `status` transacts with
/// nothing, so refusing would withhold the pool state the operator is reading it for — at
/// exactly the moment something is wrong. The finding is printed in full instead, and the exit
/// code stays zero.
async function reportForwarder(
  publicClient: DeploymentPublicClient & {
    getBalance: (args: { address: Address }) => Promise<bigint>;
  },
  deployment: DeploymentRecord,
) {
  const forwarder = deployment.feeRecipientForwarder;
  if (forwarder === undefined) {
    console.log("Fee recipient forwarder: not configured");
    return;
  }

  console.log(`Fee recipient forwarder: ${forwarder}`);
  // `getBalance` answers for an address with no code as readily as for one with code, so the
  // balance is printed before the authenticity check rather than after it.
  console.log(
    `Forwarder pending balance: ${formatWei(await publicClient.getBalance({ address: forwarder }))}`,
  );

  try {
    await assertForwarderAuthenticity(publicClient, forwarder, deployment.pool);
  } catch (error) {
    console.warn(
      `\nWARNING: the fee-recipient forwarder at ${forwarder} did NOT authenticate.\n` +
        describeFatalError(error)
          .map((line) => `  ${line}\n`)
          .join("") +
        `  This is a warning and not a refusal because status signs nothing: every FATAL in ` +
        `this repository ends by telling you to run it and reconcile, so a broken sidecar must ` +
        `not be able to withhold the pool state above.\n` +
        `  "npm run sweep" and "npm run deploy-forwarder" DO refuse on this, and they are the ` +
        `two commands that transact with the forwarder. Do not point a validator client's ` +
        `fee_recipient at this address until it authenticates.\n`,
    );
  }
}

main().catch((error) => reportFatalError(error, "status"));
