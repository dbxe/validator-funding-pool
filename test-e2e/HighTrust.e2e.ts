import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseAbiItem, parseEther, type Hex } from "viem";

import type { DeploymentRecord } from "../scripts/lib/common.js";
import { buildDepositData, writeDepositDataFile } from "./deposit-data.js";
import { DEPOSIT_CONTRACT_ADDRESS, LOCAL_CHAIN_ID, LocalChain } from "./local-chain.js";
import { absentValidator, GENESIS_FORK_VERSION, MockBeaconNode } from "./mock-beacon.js";
import { POOL_ABI } from "./pool.js";
import { assertOutputContains, expectSuccess, runCommand } from "./run-command.js";

it("funds 16/16 and submits both deposits while the validator remains absent from beacon state", { timeout: 180_000 }, async () => {
  const chain = await LocalChain.start();
  const beacon = new MockBeaconNode(LOCAL_CHAIN_ID, DEPOSIT_CONTRACT_ADDRESS);
  const directory = mkdtempSync(path.join(tmpdir(), "high-trust-e2e-"));
  try {
    await beacon.start();
    const [operator, friend] = chain.accounts;
    const deploymentFile = path.join(directory, "deployment.json");
    const depositDataFile = path.join(directory, "deposits.json");
    const env = {
      RPC_URL: chain.url,
      BEACON_NODE_URL: beacon.url,
      PRIVATE_KEY: operator.privateKey,
      DEPLOYMENT_FILE: deploymentFile,
      DEPOSIT_DATA_FILE: depositDataFile,
    };
    const run = async (script: string, extra: Record<string, string> = {}) =>
      expectSuccess(await runCommand({ script, env: { ...env, ...extra } }));

    await run("deploy", { FUNDING_WINDOW_SECONDS: "86400" });
    const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as DeploymentRecord;
    const deposits = buildDepositData(23, deployment.withdrawalCredentials, GENESIS_FORK_VERSION as Hex);
    writeDepositDataFile(depositDataFile, deposits);
    beacon.setValidator(deposits.pubkey, absentValidator());
    await run("commit-predeposit", { EXPECTED_PUBKEY: deposits.pubkey });
    await run("open-funding-attempt", {
      PARTICIPANTS: `${operator.address},${friend.address}`,
      FUNDING_TARGETS_GWEI: "16000000000,16000000000",
    });
    // No beacon-state transition between these commands: the 1 ETH deposit is still queued.
    const operatorFunding = await run("fund", { FUND_VIA_TRANSFER: "0" });
    assertOutputContains(operatorFunding, "15 ETH");
    const friendFunding = await run("fund", { PRIVATE_KEY: friend.privateKey, FUND_VIA_TRANSFER: "1" });
    assertOutputContains(friendFunding, "16 ETH");
    const toppedUp = await run("top-up");
    for (const result of [operatorFunding, friendFunding, toppedUp]) {
      assertOutputContains(result, "HIGH TRUST - proceeding without finalized credential confirmation");
      assertOutputContains(result, "validator still absent (high trust)");
    }

    const read = (functionName: string, args: readonly unknown[] = []) => chain.publicClient.readContract({
      address: deployment.pool, abi: POOL_ABI, functionName, args: args as never,
    });
    assert.equal(await read("state"), 3);
    assert.equal(await read("creditedWeiOf", [operator.address]), parseEther("16"));
    assert.equal(await read("creditedWeiOf", [friend.address]), parseEther("16"));
    assert.equal(await chain.publicClient.getBalance({ address: DEPOSIT_CONTRACT_ADDRESS }), parseEther("32"));
    assert.equal(beacon.scenario.validators.get(deposits.pubkey)?.present, false);
    const depositEvents = await chain.publicClient.getLogs({
      address: DEPOSIT_CONTRACT_ADDRESS,
      event: parseAbiItem("event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index)"),
      fromBlock: 0n,
      toBlock: "latest",
      strict: true,
    });
    assert.deepEqual(
      depositEvents.map((event) => Buffer.from(event.args.amount.slice(2), "hex").readBigUInt64LE()),
      [1_000_000_000n, 31_000_000_000n],
    );
    for (const event of depositEvents) {
      assert.equal(event.args.pubkey, deposits.pubkey);
      assert.equal(event.args.withdrawal_credentials, deployment.withdrawalCredentials.toLowerCase());
    }
  } finally {
    await beacon.stop();
    await chain.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
