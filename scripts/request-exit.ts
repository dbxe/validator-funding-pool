import { network } from "hardhat";

import {
  assertBeaconValidatorReadyForExit,
  assertDeploymentChain,
  assertDeploymentSystemCodeHashes,
  assertPoolWithdrawalCredentials,
  envBigInt,
  formatWei,
  readDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);
  await assertDeploymentSystemCodeHashes(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const expectedCredentials = await assertPoolWithdrawalCredentials(pool, deployment);
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
