import { network } from "hardhat";

import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorReadyForTopUp,
  assertBeaconValidatorStillFresh,
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
  const signer = assertActiveSigner(connection, wallet.account.address, "top-up");
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "top-up");

  if (signer.toLowerCase() !== liveConfig.operator.toLowerCase()) {
    throw new Error(`top-up must be signed by the operator ${liveConfig.operator}`);
  }

  const expectedCredentials = liveConfig.withdrawalCredentials;
  const pubkey = await pool.read.committedPubkey();
  const headBalanceGwei = await assertBeaconValidatorReadyForTopUp(
    pubkey,
    expectedCredentials,
    "top-up",
  );

  console.log(`Submitting 31 ETH top-up through ${deployment.pool}`);
  console.log(`Validator pubkey: ${pubkey}`);
  console.log(`Top-up deposit data root: ${await pool.read.topUpDepositDataRoot()}`);

  // Last read before the device is asked to sign. Everything after this line is outside
  // what any check here can see.
  await assertBeaconValidatorStillFresh(pubkey, expectedCredentials, "top-up", headBalanceGwei);
  const hash = await pool.write.topUpValidator();
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "top-up");
  console.log(`Topped up in block ${receipt.blockNumber}`);
}

main().catch((error) => reportFatalError(error, "top-up"));
