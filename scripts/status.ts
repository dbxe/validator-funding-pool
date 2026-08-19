import { network } from "hardhat";

import {
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
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
  // `status` reports the forwarder's balance and is the read-only command an operator runs to
  // check the sidecar, so it authenticates it. It signs nothing, so a refusal here costs a
  // read rather than a recovery path.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "authenticate-forwarder");
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
  if (deployment.feeRecipientForwarder !== undefined) {
    const forwarderBalance = await publicClient.getBalance({
      address: deployment.feeRecipientForwarder,
    });
    console.log(`Fee recipient forwarder: ${deployment.feeRecipientForwarder}`);
    console.log(`Forwarder pending balance: ${formatWei(forwarderBalance)}`);
  } else {
    console.log("Fee recipient forwarder: not configured");
  }

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

  const refundParticipants = process.env.REFUND_PARTICIPANTS
    ? parseAddressList(process.env.REFUND_PARTICIPANTS)
    : [];
  for (const participant of refundParticipants) {
    console.log(`Refund holder ${participant}: refundable=${formatWei(await pool.read.refundableWeiOf([participant]))}`);
  }
}

main().catch((error) => reportFatalError(error, "status"));
