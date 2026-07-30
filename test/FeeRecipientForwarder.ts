import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";

import {
  assertFeeRecipientForwarderMatchesDeployment,
  computeDepositDataRoot,
} from "../scripts/lib/common.js";

const PREDEPOSIT = parseEther("1");
const OPERATOR_TARGET = parseEther("2");
const ALICE_TARGET = parseEther("12");
const BOB_TARGET = parseEther("18");
const FUNDING_WINDOW = 3_600n;
const EXIT_FEE = 1_234n;
const PUBKEY = fixedHex("11", 48);
const PREDEPOSIT_SIGNATURE = fixedHex("aa", 96);
const TOP_UP_SIGNATURE = fixedHex("bb", 96);

function fixedHex(byte: string, length: number): Hex {
  return `0x${byte.repeat(length)}` as Hex;
}

function withdrawalCredentials(pool: Address): Hex {
  return `0x01${"00".repeat(11)}${pool.slice(2).toLowerCase()}` as Hex;
}

describe("FeeRecipientForwarder", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  async function wait(hash: Hex) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function deployPool() {
    const [operator, alice, bob, outsider] = await viem.getWalletClients();
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      operator.account.address,
      FUNDING_WINDOW,
    ]);
    const forwarder = await viem.deployContract("FeeRecipientForwarder", [pool.address]);

    return { operator, alice, bob, outsider, deposit, withdrawal, pool, forwarder };
  }

  async function predeposit(pool: Awaited<ReturnType<typeof deployPool>>["pool"]) {
    const credentials = withdrawalCredentials(pool.address);
    const predepositRoot = computeDepositDataRoot(
      PUBKEY,
      credentials,
      1_000_000_000n,
      PREDEPOSIT_SIGNATURE,
    );
    const topUpRoot = computeDepositDataRoot(PUBKEY, credentials, 31_000_000_000n, TOP_UP_SIGNATURE);
    await wait(
      await pool.write.commitAndPredeposit(
        [PUBKEY, PREDEPOSIT_SIGNATURE, predepositRoot, TOP_UP_SIGNATURE, topUpRoot],
        { value: PREDEPOSIT },
      ),
    );
  }

  async function toppedUpFixture() {
    const fixture = await deployPool();
    await predeposit(fixture.pool);
    await wait(
      await fixture.pool.write.openFundingAttempt([
        [fixture.operator.account.address, fixture.alice.account.address, fixture.bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    const operatorPool = await viem.getContractAt("ValidatorFundingPool", fixture.pool.address, {
      client: { wallet: fixture.operator },
    });
    const alicePool = await viem.getContractAt("ValidatorFundingPool", fixture.pool.address, {
      client: { wallet: fixture.alice },
    });
    const bobPool = await viem.getContractAt("ValidatorFundingPool", fixture.pool.address, {
      client: { wallet: fixture.bob },
    });
    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await fixture.pool.write.topUpValidator());
    return { ...fixture, operatorPool, alicePool, bobPool };
  }

  it("accepts baseline-cost ETH transfers throughout the pool lifecycle", async function () {
    const { pool, forwarder, operator, outsider } = await networkHelpers.loadFixture(deployPool);
    const transfer = async () => {
      const receipt = await wait(await outsider.sendTransaction({ to: forwarder.address, value: 1n }));
      assert.ok(receipt.gasUsed <= 22_000n, `forwarder receive gas ${receipt.gasUsed} exceeds 22,000`);
    };

    await transfer();
    await predeposit(pool);
    await transfer();
    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address],
        [parseEther("32")],
      ]),
    );
    await transfer();
    await wait(await pool.write.fund({ value: parseEther("31") }));
    await wait(await pool.write.topUpValidator());
    await transfer();

    assert.equal(await publicClient.getBalance({ address: forwarder.address }), 4n);
  });

  it("binds the forwarder deployment record to its immutable pool", async function () {
    const { pool, forwarder, outsider } = await networkHelpers.loadFixture(deployPool);
    const deployment = {
      pool: pool.address,
      feeRecipientForwarder: forwarder.address,
    } as any;

    assert.equal(
      (await assertFeeRecipientForwarderMatchesDeployment(publicClient, forwarder, deployment)).toLowerCase(),
      pool.address.toLowerCase(),
    );
    await assert.rejects(
      assertFeeRecipientForwarderMatchesDeployment(
        publicClient,
        forwarder,
        { ...deployment, pool: outsider.account.address },
      ),
      /does not match deployment pool/,
    );
  });

  it("rejects invalid constructor targets", async function () {
    const { forwarder, outsider } = await networkHelpers.loadFixture(deployPool);
    const noCredentials = await viem.deployContract("MockDepositContract");

    await viem.assertions.revertWithCustomError(
      viem.deployContract("FeeRecipientForwarder", [zeroAddress]),
      forwarder,
      "InvalidPool",
    );
    await viem.assertions.revertWithCustomError(
      viem.deployContract("FeeRecipientForwarder", [outsider.account.address]),
      forwarder,
      "InvalidPool",
    );
    await viem.assertions.revertWithCustomError(
      viem.deployContract("FeeRecipientForwarder", [noCredentials.address]),
      forwarder,
      "InvalidPoolWithdrawalCredentials",
    );
  });

  it("keeps failed sweeps retryable until the pool is topped up", async function () {
    const { pool, forwarder, operator, outsider } = await networkHelpers.loadFixture(deployPool);
    await predeposit(pool);
    await wait(await outsider.sendTransaction({ to: forwarder.address, value: parseEther("1") }));

    const outsiderForwarder = await viem.getContractAt("FeeRecipientForwarder", forwarder.address, {
      client: { wallet: outsider },
    });
    await viem.assertions.revertWithCustomError(
      outsiderForwarder.write.sweep(),
      forwarder,
      "SweepFailed",
    );
    assert.equal(await publicClient.getBalance({ address: forwarder.address }), parseEther("1"));

    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address],
        [parseEther("32")],
      ]),
    );
    await wait(await pool.write.fund({ value: parseEther("31") }));
    await wait(await pool.write.topUpValidator());
    await wait(await outsiderForwarder.write.sweep());

    assert.equal(await publicClient.getBalance({ address: forwarder.address }), 0n);
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("1"));
    await viem.assertions.revertWithCustomError(
      outsiderForwarder.write.sweep(),
      forwarder,
      "EmptyBalance",
    );
  });

  it("sweeps the full balance permissionlessly into pro-rata pool proceeds", async function () {
    const { pool, forwarder, operator, alice, bob, outsider } =
      await networkHelpers.loadFixture(toppedUpFixture);
    const amount = parseEther("8");
    await wait(await outsider.sendTransaction({ to: forwarder.address, value: amount }));
    const outsiderForwarder = await viem.getContractAt("FeeRecipientForwarder", forwarder.address, {
      client: { wallet: outsider },
    });
    const receipt = await wait(await outsiderForwarder.write.sweep());
    const events = parseEventLogs({ abi: forwarder.abi, logs: receipt.logs });

    assert.equal(events.length, 1);
    assert.equal(events[0].eventName, "Swept");
    assert.equal(events[0].args.caller.toLowerCase(), outsider.account.address.toLowerCase());
    assert.equal(events[0].args.amount, amount);
    assert.equal(await publicClient.getBalance({ address: forwarder.address }), 0n);
    assert.equal(await pool.read.grossPoolProceeds(), amount);
    assert.equal(await pool.read.claimable([operator.account.address]), parseEther("0.5"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("3"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("4.5"));
  });

  it("cannot transfer more than its balance during a reentrant sweep", async function () {
    const [, , , outsider] = await viem.getWalletClients();
    const hostilePool = await viem.deployContract("ReentrantForwarderPool");
    const forwarder = await viem.deployContract("FeeRecipientForwarder", [hostilePool.address]);
    await wait(await hostilePool.write.setForwarder([forwarder.address]));
    await wait(await outsider.sendTransaction({ to: forwarder.address, value: parseEther("1") }));

    await wait(await forwarder.write.sweep());

    assert.equal(await publicClient.getBalance({ address: forwarder.address }), 0n);
    assert.equal(await hostilePool.read.totalReceived(), parseEther("1"));
    assert.equal(await hostilePool.read.reentryAttempts(), 1n);
  });
});
