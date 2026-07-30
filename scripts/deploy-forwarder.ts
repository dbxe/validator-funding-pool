import { network } from "hardhat";

import {
  assertDeploymentIntegrity,
  assertFeeRecipientForwarderMatchesDeployment,
  readDeployment,
  writeDeployment,
} from "./lib/common.js";

async function main() {
  const deployment = readDeployment();
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pool = await viem.getContractAt("ValidatorFundingPool", deployment.pool, {
    client: { wallet },
  });
  await assertDeploymentIntegrity(publicClient, pool, deployment);

  const forwarder = await viem.deployContract("FeeRecipientForwarder", [deployment.pool]);
  const updatedDeployment = {
    ...deployment,
    feeRecipientForwarder: forwarder.address,
  };
  await assertFeeRecipientForwarderMatchesDeployment(publicClient, forwarder, updatedDeployment);
  writeDeployment(updatedDeployment);

  console.log(`Fee recipient forwarder deployed: ${forwarder.address}`);
  console.log(`Immutable pool destination: ${deployment.pool}`);
  console.log("Do not configure fee_recipient until the pool is topped up.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
