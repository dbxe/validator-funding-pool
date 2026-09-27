import { network } from "hardhat";

import {
  assertActiveSigner,
  assertCompilationNotSkipped,
  assertDeploymentIntegrity,
  readDeployment,
  reportFatalError,
  resolveSigningWallet,
  resolveTransactionFields,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  // An argv check, so it costs nothing and runs before every other line: a stale artifact
  // would make the runtime-code check print a pass it did not earn.
  assertCompilationNotSkipped("close-expired-funding-attempt");
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const wallet = await resolveSigningWallet(connection, "close-expired-funding-attempt");
  const signer = await assertActiveSigner(
    connection,
    wallet.account.address,
    "close-expired-funding-attempt",
  );
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  // The permissionless step that makes refunds available; it never touches the forwarder.
  await assertDeploymentIntegrity(publicClient, pool, deployment, "forwarder-untouched");

  console.log(`Closing expired funding attempt for ${deployment.pool}`);
  const fields = await resolveTransactionFields(publicClient, "close-expired-funding-attempt", () =>
    pool.estimateGas.closeExpiredFundingAttempt(),
  );
  const hash = await pool.write.closeExpiredFundingAttempt(fields);
  const receipt = await waitForSenderVerifiedReceipt(
    publicClient,
    hash,
    signer,
    "close-expired-funding-attempt",
  );
  console.log(`Closed in block ${receipt.blockNumber}`);
}

main().catch((error) => reportFatalError(error, "close-expired-funding-attempt"));
