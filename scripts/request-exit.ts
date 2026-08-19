import { network } from "hardhat";

import {
  assertActiveSigner,
  assertBeaconMatchesExecutionChain,
  assertBeaconValidatorReadyForExit,
  assertDeploymentIntegrity,
  envBigInt,
  formatWei,
  readDeployment,
  waitForSenderVerifiedReceipt,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const signer = assertActiveSigner(connection, wallet.account.address, "request-exit");
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

  // The EIP-7002 fee is read here and charged at inclusion, and it rises with demand for
  // the predeploy. Defaulting the cap to the fee observed a moment ago made any uptick in
  // between revert `ExitFeeTooHigh`, on the one path that exists to recover capital
  // without the operator. Two times the observed fee is the headroom; it costs nothing,
  // because `requestExit` forwards only the live fee to the predeploy and refunds
  // `msg.value - fee` in the same transaction (`ValidatorFundingPool.sol:415-442`).
  const fee = await pool.read.currentExitRequestFee();
  const maxFee = envBigInt("MAX_FEE_WEI", fee * 2n);
  if (maxFee < fee) {
    throw new Error(
      `MAX_FEE_WEI ${formatWei(maxFee)} is below the current EIP-7002 fee ${formatWei(fee)}; ` +
        `the request would revert ExitFeeTooHigh`,
    );
  }

  console.log(`Requesting full exit for ${pubkey}`);
  console.log(`EIP-7002 fee: ${formatWei(fee)}`);
  console.log(`Max fee sent: ${formatWei(maxFee)} (the excess above the fee charged is refunded)`);
  const hash = await pool.write.requestExit([maxFee], { value: maxFee });
  const receipt = await waitForSenderVerifiedReceipt(publicClient, hash, signer, "request-exit");
  console.log(`Exit requested in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
