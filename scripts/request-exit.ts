import { network } from "hardhat";

import { assertDeploymentChain, envBigInt, formatWei, readDeployment } from "./lib/common.js";

interface BeaconValidatorResponse {
  data: {
    status: string;
    validator: {
      pubkey: string;
      withdrawal_credentials: string;
    };
  };
}

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  await assertDeploymentChain(publicClient, deployment);

  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const pubkey = await pool.read.committedPubkey();
  await assertBeaconExitPreflight(pubkey, deployment.withdrawalCredentials);

  const fee = await pool.read.currentExitRequestFee();
  const maxFee = envBigInt("MAX_FEE_WEI", fee);

  console.log(`Requesting full exit for ${pubkey}`);
  console.log(`EIP-7002 fee: ${formatWei(fee)}`);
  const hash = await pool.write.requestExit([maxFee], { value: fee });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Exit requested in block ${receipt.blockNumber}`);
}

async function assertBeaconExitPreflight(pubkey: string, withdrawalCredentials: string) {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) return;

  const url = new URL(`/eth/v1/beacon/states/head/validators/${pubkey}`, beaconNodeUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Beacon validator lookup failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as BeaconValidatorResponse;
  const actualCredentials = body.data.validator.withdrawal_credentials.toLowerCase();
  if (actualCredentials !== withdrawalCredentials.toLowerCase()) {
    throw new Error(`Beacon withdrawal_credentials ${actualCredentials} != pool ${withdrawalCredentials}`);
  }
  if (body.data.status !== "active_ongoing") {
    throw new Error(`Validator status is ${body.data.status}, expected active_ongoing`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
