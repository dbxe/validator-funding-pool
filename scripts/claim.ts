import { network } from "hardhat";

import {
  asAddress,
  assertActiveSigner,
  assertDeploymentIntegrity,
  formatWei,
  readDeployment,
  reportFatalError,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "claim");
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

  const recipient = process.env.RECIPIENT ? asAddress(process.env.RECIPIENT) : signer;
  const hash = recipient.toLowerCase() === signer.toLowerCase()
    ? await pool.write.claim()
    : await pool.write.claimTo([recipient]);
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "claim");
  console.log(`Claimed to ${recipient} in block ${receipt.blockNumber}`);
}

main().catch((error) => reportFatalError(error, "claim"));
