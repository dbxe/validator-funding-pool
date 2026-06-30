import { network } from "hardhat";

import {
  assertBeaconValidatorHasWithdrawalCredentials,
  assertDeploymentChain,
  envBigInt,
  formatWei,
  PREDEPOSIT_GWEI,
  readDeployment,
  readPredepositAndTopUpDepositData,
  TOP_UP_GWEI,
  validateDepositData,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const deposits = readPredepositAndTopUpDepositData();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const expectedCredentials = await pool.read.withdrawalCredentials();
  const predeposit = validateDepositData(deposits.predeposit, expectedCredentials, undefined, PREDEPOSIT_GWEI);
  const topUp = validateDepositData(deposits.topUp, expectedCredentials, predeposit.pubkey, TOP_UP_GWEI);

  const committedPubkey = await pool.read.committedPubkey();
  const predepositRoot = await pool.read.predepositDataRoot();
  const topUpRoot = await pool.read.topUpDepositDataRoot();
  const committedPredepositSignature = await pool.read.predepositSignature();
  const committedTopUpSignature = await pool.read.topUpSignature();
  if (committedPubkey.toLowerCase() !== predeposit.pubkey.toLowerCase()) {
    throw new Error(`Committed pubkey ${committedPubkey} != deposit-data pubkey ${predeposit.pubkey}`);
  }
  if (predepositRoot.toLowerCase() !== predeposit.depositDataRoot.toLowerCase()) {
    throw new Error(`Committed predeposit root ${predepositRoot} != deposit-data root ${predeposit.depositDataRoot}`);
  }
  if (topUpRoot.toLowerCase() !== topUp.depositDataRoot.toLowerCase()) {
    throw new Error(`Committed top-up root ${topUpRoot} != deposit-data root ${topUp.depositDataRoot}`);
  }
  if (committedPredepositSignature.toLowerCase() !== predeposit.signature.toLowerCase()) {
    throw new Error("Committed predeposit signature does not match deposit-data file");
  }
  if (committedTopUpSignature.toLowerCase() !== topUp.signature.toLowerCase()) {
    throw new Error("Committed top-up signature does not match deposit-data file");
  }
  await assertBeaconValidatorHasWithdrawalCredentials(predeposit.pubkey, expectedCredentials, "fund");

  const remaining = await pool.read.fundingRemainingWeiOf([wallet.account.address]);
  if (remaining <= 0n) {
    throw new Error(`No remaining funding cap for ${wallet.account.address}`);
  }

  const amount = envBigInt("AMOUNT_WEI", remaining);
  if (amount > remaining) {
    throw new Error(`AMOUNT_WEI exceeds remaining cap: ${formatWei(remaining)}`);
  }

  console.log(`Funding ${deployment.pool} from ${wallet.account.address}: ${formatWei(amount)}`);
  const hash = await pool.write.fund({ value: amount });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Funded in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
