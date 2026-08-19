import { network } from "hardhat";

import {
  assertActiveSigner,
  assertCompilationNotSkipped,
  assertDeployedAt,
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  assertForwarderAuthenticity,
  assertFreshForwarderMatchesExpectedForwarder,
  printSuggestedFees,
  readDeployment,
  reportFatalError,
  waitForSenderVerifiedReceipt,
  writeDeployment,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("deploy-forwarder");
  // Before a single JSON-RPC request, for the reason assertFreshDeploymentMatchesExpectedPool
  // gives about the pool: a declaration names a forwarder that already exists, and this
  // command can only produce a new one. Refusing here leaves nothing deployed and unrecorded.
  assertFreshForwarderMatchesExpectedForwarder();
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = await assertActiveSigner(connection, wallet.account.address, "deploy-forwarder");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  // The command that deploys and records a forwarder: any forwarder the record ALREADY names
  // is authenticated before it is replaced, so a record that was already wrong is a finding
  // here rather than an address quietly overwritten.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "authenticate-forwarder");

  await printSuggestedFees(publicClient, "deploy-forwarder");
  // See deploy.ts: sendDeploymentTransaction is used for the transaction hash the
  // post-broadcast sender check needs.
  const { contract: forwarder, deploymentTransaction } = await viem.sendDeploymentTransaction(
    "FeeRecipientForwarder",
    [deployment.pool],
  );
  const deploymentReceipt = await waitForSenderVerifiedReceipt(
    publicClient,
    deploymentTransaction.hash,
    signer,
    "deploy-forwarder",
  );
  assertDeployedAt(deploymentReceipt.contractAddress, forwarder.address, "FeeRecipientForwarder");

  const updatedDeployment = {
    ...deployment,
    feeRecipientForwarder: forwarder.address,
  };
  await assertFeeRecipientForwarderMatchesDeployment(publicClient, forwarder, updatedDeployment);
  // `sweep` and `status` reach this through `assertDeploymentIntegrity`, which runs it for the
  // commands that touch the forwarder. This command is the one that writes that field, so
  // it has no such record to run integrity against yet and calls the check directly — exactly
  // as `deploy.ts` does for the pool, and for the same reason: the address is about to be
  // written down and configured as a validator's fee recipient, so a creation transaction
  // that landed as something other than what was compiled has to be caught here.
  // `"fresh-deployment"`: the address under check was created by this run, so the pin's
  // record wording — "the deployment record names X", "Nothing has been sent" — would be
  // false here. The pin itself is unreachable at this point, since the guard at the top
  // refuses while EXPECTED_FORWARDER is declared at all.
  await assertForwarderAuthenticity(
    publicClient,
    forwarder.address,
    deployment.pool,
    "fresh-deployment",
  );
  writeDeployment(updatedDeployment);

  console.log(`Fee recipient forwarder deployed: ${forwarder.address}`);
  console.log(`Immutable pool destination: ${deployment.pool}`);
  console.log("Do not configure fee_recipient until the pool is topped up.");
}

main().catch((error) => reportFatalError(error, "deploy-forwarder"));
