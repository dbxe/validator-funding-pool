import { network } from "hardhat";

import {
  assertActiveSigner,
  assertDeploymentIntegrity,
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
  const hash = await pool.write.closeExpiredFundingAttempt();
  const receipt = await waitForSenderVerifiedReceipt(
    publicClient,
    hash,
    signer,
    "close-expired-funding-attempt",
  );
  console.log(`Closed in block ${receipt.blockNumber}`);
}

main().catch((error) => reportFatalError(error, "close-expired-funding-attempt"));
