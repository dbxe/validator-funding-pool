import { network } from "hardhat";

import { asHex, envBigInt, formatWei, readDeployment } from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });

  const pubkey = process.env.PUBKEY ? asHex(process.env.PUBKEY) : await pool.read.validatorPubkey();
  const fee = await pool.read.currentExitRequestFee();
  const maxFee = envBigInt("MAX_FEE_WEI", fee);

  console.log(`Requesting full exit for ${pubkey}`);
  console.log(`EIP-7002 fee: ${formatWei(fee)}`);
  const hash = await pool.write.requestExit([pubkey, maxFee], { value: fee });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Exit requested in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
