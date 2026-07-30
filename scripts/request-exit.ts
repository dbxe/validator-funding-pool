import { network } from "hardhat";

import {
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorReadyForExit,
  assertDeploymentIntegrity,
  envBigInt,
  formatWei,
  readDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  const liveConfig = await assertDeploymentIntegrity(publicClient, pool, deployment);
  await assertBeaconMatchesExecutionChain(deployment, liveConfig, "request-exit", {
    optional: true,
  });

  const expectedCredentials = liveConfig.withdrawalCredentials;
  const pubkey = await pool.read.committedPubkey();
  await assertBeaconValidatorReadyForExit(pubkey, expectedCredentials, "request-exit");

  const fee = await pool.read.currentExitRequestFee();
  const maxFee = envBigInt("MAX_FEE_WEI", fee);

  console.log(`Requesting full exit for ${pubkey}`);
  console.log(`EIP-7002 fee: ${formatWei(fee)}`);
  console.log(`Max fee sent: ${formatWei(maxFee)}`);
  const hash = await pool.write.requestExit([maxFee], { value: maxFee });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Exit requested in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
