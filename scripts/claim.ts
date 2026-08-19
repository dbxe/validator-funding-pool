import { network } from "hardhat";

import {
  asAddress,
  assertActiveSigner,
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
  assertPayoutReachedRecipient,
  formatWei,
  printPayoutRecipient,
  readDeployment,
  reportFatalError,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("claim");
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, wallet.account.address, "claim");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  // A payout path: it reads and pays from the pool and never touches the forwarder, so the
  // sidecar's condition must not be able to stop it. See `ForwarderScope`.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "forwarder-untouched");

  const claimable = await pool.read.claimable([signer]);
  console.log(`Claimable for ${signer}: ${formatWei(claimable)}`);
  if (claimable === 0n) {
    // Said outright rather than left to be inferred from a command that printed a zero and
    // exited quietly: on the Ledger path there is no device prompt either, and "nothing
    // happened" and "something happened and it worked" looked identical.
    console.log("Nothing to claim; no transaction was sent.");
    return;
  }

  // Printed BEFORE the transaction is composed, which is the only moment at which the
  // recipient is still a decision. On the Ledger path the address goes into calldata the
  // device does not render, and README.md's mitigation ladder tells the operator to compare
  // it against an independently derived one right here.
  const recipient = process.env.RECIPIENT ? asAddress(process.env.RECIPIENT) : signer;
  printPayoutRecipient("claim", deployment.pool, signer, recipient, claimable);
  const hash = recipient.toLowerCase() === signer.toLowerCase()
    ? await pool.write.claim()
    : await pool.write.claimTo([recipient]);
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "claim");
  // And checked after mining against the pool's own event, where `recipient` is a topic:
  // the receipt is the next and last place the address can be verified at all.
  assertPayoutReachedRecipient(
    receipt,
    deployment.pool,
    "Claimed",
    signer,
    recipient,
    claimable,
    "claim",
  );
  console.log(`Claimed to ${recipient} in block ${receipt.blockNumber}`);
}

main().catch((error) => reportFatalError(error, "claim"));
