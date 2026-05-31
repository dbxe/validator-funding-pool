import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";

const STATE_FUNDING = 0;
const STATE_STAKED = 1;
const STATE_CANCELED = 2;

const GWEI = 1_000_000_000n;
const VALIDATOR_DEPOSIT = parseEther("32");
const ALICE_TARGET = parseEther("12");
const BOB_TARGET = parseEther("20");
const EXIT_FEE = 1_234n;

function fixedHex(byte: string, length: number): Hex {
  return `0x${byte.repeat(length)}` as Hex;
}

function expectedWithdrawalCredentials(pool: Address): Hex {
  return `0x01${"00".repeat(11)}${pool.slice(2).toLowerCase()}` as Hex;
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

describe("ValidatorFundingPool", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  async function wait(hash: Hex) {
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function poolAs(poolAddress: Address, wallet: Awaited<ReturnType<typeof viem.getWalletClients>>[number]) {
    return viem.getContractAt("ValidatorFundingPool", poolAddress, {
      client: { wallet },
    });
  }

  async function assertAccountingInvariants(poolAddress: Address, participants: Address[]) {
    const pool = await viem.getContractAt("ValidatorFundingPool", poolAddress);
    const balance = await publicClient.getBalance({ address: poolAddress });
    const totalClaimed = await pool.read.totalClaimed();
    const gross = await pool.read.grossPoolProceeds();

    assert.equal(gross, balance + totalClaimed);
    assert.ok(totalClaimed <= gross);

    let sumClaimed = 0n;
    let sumClaimable = 0n;
    for (const participant of participants) {
      sumClaimed += await pool.read.claimedOf([participant]);
      sumClaimable += await pool.read.claimable([participant]);
    }

    assert.equal(sumClaimed, totalClaimed);
    assert.ok(sumClaimable <= balance);
  }

  async function deployFixture() {
    const wallets = await viem.getWalletClients();
    const [deployer, alice, bob, charlie, outsider] = wallets;

    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const latest = await networkHelpers.time.latest();
    const deadline = BigInt(latest + 3_600);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      VALIDATOR_DEPOSIT,
      1n,
      deadline,
      [alice.account.address, bob.account.address],
      [ALICE_TARGET, BOB_TARGET],
    ]);

    return {
      deployer,
      alice,
      bob,
      charlie,
      outsider,
      deposit,
      withdrawal,
      pool,
      alicePool: await poolAs(pool.address, alice),
      bobPool: await poolAs(pool.address, bob),
      outsiderPool: await poolAs(pool.address, outsider),
      deadline,
    };
  }

  async function twoValidatorFundedFixture() {
    const wallets = await viem.getWalletClients();
    const [, alice, bob] = wallets;

    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const latest = await networkHelpers.time.latest();
    const deadline = BigInt(latest + 3_600);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      VALIDATOR_DEPOSIT,
      2n,
      deadline,
      [alice.account.address, bob.account.address],
      [parseEther("24"), parseEther("40")],
    ]);

    const alicePool = await poolAs(pool.address, alice);
    const bobPool = await poolAs(pool.address, bob);
    await wait(await alicePool.write.fund({ value: parseEther("24") }));
    await wait(await bobPool.write.fund({ value: parseEther("40") }));

    return { pool };
  }

  async function awkwardWeightsStakedFixture() {
    const wallets = await viem.getWalletClients();
    const [, alice, bob, charlie, outsider] = wallets;

    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const latest = await networkHelpers.time.latest();
    const deadline = BigInt(latest + 3_600);
    const targets = [1n * GWEI, 3n * GWEI, 7n * GWEI];
    const validatorDeposit = sum(targets);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      validatorDeposit,
      1n,
      deadline,
      [alice.account.address, bob.account.address, charlie.account.address],
      targets,
    ]);

    const alicePool = await poolAs(pool.address, alice);
    const bobPool = await poolAs(pool.address, bob);
    const charliePool = await poolAs(pool.address, charlie);

    await wait(await alicePool.write.fund({ value: targets[0] }));
    await wait(await bobPool.write.fund({ value: targets[1] }));
    await wait(await charliePool.write.fund({ value: targets[2] }));
    await wait(await pool.write.stake([[fixedHex("44", 48)], [fixedHex("ee", 96)], [fixedHex("05", 32)]]));

    return {
      pool,
      alice,
      bob,
      charlie,
      outsider,
      alicePool,
      bobPool,
      charliePool,
      targets,
    };
  }

  async function fullyFundedFixture() {
    const fixture = await deployFixture();
    await wait(await fixture.alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await fixture.bobPool.write.fund({ value: BOB_TARGET }));
    return fixture;
  }

  async function stakedFixture() {
    const fixture = await fullyFundedFixture();
    const pubkey = fixedHex("11", 48);
    const signature = fixedHex("aa", 96);
    const depositDataRoot = fixedHex("01", 32);

    await wait(await fixture.pool.write.stake([[pubkey], [signature], [depositDataRoot]]));

    return {
      ...fixture,
      pubkey,
      signature,
      depositDataRoot,
    };
  }

  it("uses fixed participant funding weights and computes 0x01 credentials to the pool", async function () {
    const { pool, alice, bob, outsiderPool } = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await pool.read.state(), STATE_FUNDING);
    assert.equal(await pool.read.totalFundingTarget(), VALIDATOR_DEPOSIT);
    assert.equal(await pool.read.fundingTargetOf([alice.account.address]), ALICE_TARGET);
    assert.equal(await pool.read.fundingTargetOf([bob.account.address]), BOB_TARGET);
    assert.equal((await pool.read.withdrawalCredentials()).toLowerCase(), expectedWithdrawalCredentials(pool.address));

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.fund({ value: 1n }),
      pool,
      "NotParticipant",
    );
  });

  it("keeps funding separate from live proceeds and refunds exact contributions on cancel", async function () {
    const { pool, alicePool, bobPool, alice, deadline } = await networkHelpers.loadFixture(deployFixture);

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);

    await viem.assertions.revertWithCustomError(alicePool.write.claim(), pool, "InvalidState");

    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await alicePool.write.cancel());
    assert.equal(await pool.read.state(), STATE_CANCELED);

    await viem.assertions.revertWithCustomError(bobPool.write.refund(), pool, "NothingToRefund");

    await wait(await alicePool.write.refund());
    assert.equal(await pool.read.fundedOf([alice.account.address]), 0n);
    assert.equal(await pool.read.refundedTotal(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("deposits only after exact full funding and passes pool-owned 0x01 credentials", async function () {
    const { pool, deposit, alicePool, bobPool } = await networkHelpers.loadFixture(deployFixture);

    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await viem.assertions.revertWithCustomError(
      pool.write.stake([[fixedHex("11", 48)], [fixedHex("aa", 96)], [fixedHex("01", 32)]]),
      pool,
      "NotFullyFunded",
    );

    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.stake([[fixedHex("11", 48)], [fixedHex("aa", 96)], [fixedHex("01", 32)]]));

    assert.equal(await pool.read.state(), STATE_STAKED);
    assert.equal(await pool.read.depositedValidatorCount(), 1n);
    assert.equal(await deposit.read.depositCount(), 1n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);

    const record = await deposit.read.depositAt([0n]);
    assert.equal(record[0], fixedHex("11", 48));
    assert.equal(record[1].toLowerCase(), expectedWithdrawalCredentials(pool.address));
    assert.equal(record[4], VALIDATOR_DEPOSIT);
  });

  it("treats every post-stake ETH inflow as pro-rata pool proceeds", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider } = await networkHelpers.loadFixture(stakedFixture);

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("6") }));

    assert.equal(await pool.read.grossPoolProceeds(), parseEther("6"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("2.25"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("3.75"));

    await wait(await alicePool.write.claim());
    assert.equal(await pool.read.claimedOf([alice.account.address]), parseEther("2.25"));
    assert.equal(await pool.read.totalClaimed(), parseEther("2.25"));

    // Simulate a CL-side voluntary exit returning principal while the pool is still "live".
    await wait(await outsider.sendTransaction({ to: pool.address, value: VALIDATOR_DEPOSIT }));

    assert.equal(await pool.read.grossPoolProceeds(), parseEther("38"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("12"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("23.75"));

    await wait(await alicePool.write.claim());
    await wait(await bobPool.write.claim());

    assert.equal(await pool.read.claimedOf([alice.account.address]), parseEther("14.25"));
    assert.equal(await pool.read.claimedOf([bob.account.address]), parseEther("23.75"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("keeps cumulative entitlements fair when participants claim at different times", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider } = await networkHelpers.loadFixture(stakedFixture);
    const participants = [alice.account.address, bob.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("10") }));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("3.75"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("6.25"));
    await assertAccountingInvariants(pool.address, participants);

    const grossBeforeClaim = await pool.read.grossPoolProceeds();
    await wait(await alicePool.write.claim());
    assert.equal(await pool.read.grossPoolProceeds(), grossBeforeClaim);
    assert.equal(await pool.read.claimedOf([alice.account.address]), parseEther("3.75"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("6.25"));
    await assertAccountingInvariants(pool.address, participants);

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("14") }));
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("24"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("5.25"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("15"));

    await wait(await bobPool.write.claim());
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("24"));
    assert.equal(await pool.read.claimedOf([bob.account.address]), parseEther("15"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("5.25"));

    await wait(await alicePool.write.claim());
    assert.equal(await pool.read.claimedOf([alice.account.address]), parseEther("9"));
    assert.equal(await pool.read.claimedOf([bob.account.address]), parseEther("15"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
    await assertAccountingInvariants(pool.address, participants);
  });

  it("bounds rounding dust and lets later proceeds unlock it", async function () {
    const { pool, alicePool, bobPool, charliePool, alice, bob, charlie, outsider } =
      await networkHelpers.loadFixture(awkwardWeightsStakedFixture);
    const participants = [alice.account.address, bob.account.address, charlie.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: 10n }));
    assert.equal(await pool.read.grossPoolProceeds(), 10n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);
    assert.equal(await pool.read.claimable([bob.account.address]), 2n);
    assert.equal(await pool.read.claimable([charlie.account.address]), 6n);

    await viem.assertions.revertWithCustomError(alicePool.write.claim(), pool, "NothingToClaim");
    await wait(await bobPool.write.claim());
    await wait(await charliePool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 2n);
    assert.ok((await publicClient.getBalance({ address: pool.address })) < BigInt(participants.length));
    await assertAccountingInvariants(pool.address, participants);

    await wait(await outsider.sendTransaction({ to: pool.address, value: 1n }));
    assert.equal(await pool.read.grossPoolProceeds(), 11n);
    assert.equal(await pool.read.claimable([alice.account.address]), 1n);
    assert.equal(await pool.read.claimable([bob.account.address]), 1n);
    assert.equal(await pool.read.claimable([charlie.account.address]), 1n);

    await wait(await alicePool.write.claim());
    await wait(await bobPool.write.claim());
    await wait(await charliePool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
    assert.equal(await pool.read.totalClaimed(), 11n);
    await assertAccountingInvariants(pool.address, participants);
  });

  it("treats forced ETH before staking as proceeds once staking starts", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider } = await networkHelpers.loadFixture(deployFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 2n }));
    await wait(await forceSend.write.forceSend([pool.address]));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);

    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.stake([[fixedHex("55", 48)], [fixedHex("ff", 96)], [fixedHex("06", 32)]]));

    assert.equal(await pool.read.grossPoolProceeds(), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);
    assert.equal(await pool.read.claimable([bob.account.address]), 1n);

    await wait(await bobPool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 1n);
    await assertAccountingInvariants(pool.address, [alice.account.address, bob.account.address]);
  });

  it("lets funded participants sweep canceled surplus without changing refunds", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider, deadline } =
      await networkHelpers.loadFixture(deployFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 2n }));
    await wait(await forceSend.write.forceSend([pool.address]));

    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await alicePool.write.cancel());

    assert.equal(await pool.read.state(), STATE_CANCELED);
    assert.equal(await pool.read.grossCanceledSurplus(), 2n);
    assert.equal(await pool.read.canceledSurplusClaimable([alice.account.address]), 2n);
    assert.equal(await pool.read.canceledSurplusClaimable([bob.account.address]), 0n);
    assert.equal(await pool.read.refundedTotal(), 0n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("5") + 2n);

    await viem.assertions.revertWithCustomError(bobPool.write.sweepCanceledSurplus(), pool, "NothingToClaim");
    await wait(await alicePool.write.sweepCanceledSurplus());
    assert.equal(await pool.read.canceledSurplusClaimedOf([alice.account.address]), 2n);
    assert.equal(await pool.read.canceledSurplusClaimedTotal(), 2n);
    assert.equal(await pool.read.grossCanceledSurplus(), 2n);

    await wait(await alicePool.write.refund());
    assert.equal(await pool.read.refundedTotal(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("uses target weights for canceled surplus if no participant funded", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider, deadline } =
      await networkHelpers.loadFixture(deployFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await alicePool.write.cancel());

    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 32n }));
    await wait(await forceSend.write.forceSend([pool.address]));

    assert.equal(await pool.read.refundedTotal(), 0n);
    assert.equal(await pool.read.grossCanceledSurplus(), 32n);
    assert.equal(await pool.read.canceledSurplusClaimable([alice.account.address]), 12n);
    assert.equal(await pool.read.canceledSurplusClaimable([bob.account.address]), 20n);

    await wait(await alicePool.write.sweepCanceledSurplus());
    await wait(await bobPool.write.sweepCanceledSurplus());
    assert.equal(await pool.read.canceledSurplusClaimedOf([alice.account.address]), 12n);
    assert.equal(await pool.read.canceledSurplusClaimedOf([bob.account.address]), 20n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("rolls claim accounting back if a participant cannot receive ETH", async function () {
    const wallets = await viem.getWalletClients();
    const [, , bob, , outsider] = wallets;
    const rejectingParticipant = await viem.deployContract("RejectEthParticipant");
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const latest = await networkHelpers.time.latest();
    const deadline = BigInt(latest + 3_600);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      VALIDATOR_DEPOSIT,
      1n,
      deadline,
      [rejectingParticipant.address, bob.account.address],
      [ALICE_TARGET, BOB_TARGET],
    ]);
    const bobPool = await poolAs(pool.address, bob);

    await wait(await rejectingParticipant.write.fundPool([pool.address], { value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.stake([[fixedHex("66", 48)], [fixedHex("aa", 96)], [fixedHex("07", 32)]]));
    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("8") }));

    assert.equal(await pool.read.claimable([rejectingParticipant.address]), parseEther("3"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("5"));

    await viem.assertions.revertWithCustomError(
      rejectingParticipant.write.claimPool([pool.address]),
      pool,
      "EthTransferFailed",
    );
    assert.equal(await pool.read.claimedOf([rejectingParticipant.address]), 0n);
    assert.equal(await pool.read.totalClaimed(), 0n);
    assert.equal(await pool.read.claimable([rejectingParticipant.address]), parseEther("3"));

    await wait(await bobPool.write.claim());
    assert.equal(await pool.read.claimedOf([bob.account.address]), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("3"));
    await assertAccountingInvariants(pool.address, [rejectingParticipant.address, bob.account.address]);
  });

  it("lets any participant request an EIP-7002 full exit from the pool address", async function () {
    const { pool, alicePool, bobPool, withdrawal, outsiderPool, pubkey } =
      await networkHelpers.loadFixture(stakedFixture);

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.requestExit([pubkey, EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );

    await viem.assertions.revertWithCustomError(
      alicePool.write.requestExit([pubkey, EXIT_FEE - 1n], { value: EXIT_FEE }),
      pool,
      "ExitFeeTooHigh",
    );

    await wait(await alicePool.write.requestExit([pubkey, EXIT_FEE], { value: EXIT_FEE + 100n }));

    assert.equal(await withdrawal.read.requestCount(), 1n);
    assert.equal((await withdrawal.read.lastSourceAddress()).toLowerCase(), pool.address.toLowerCase());
    assert.equal(await withdrawal.read.lastPubkey(), pubkey);
    assert.equal(await withdrawal.read.lastAmountData(), "0x0000000000000000");
    assert.equal(await withdrawal.read.lastValue(), EXIT_FEE);
    assert.equal(await publicClient.getBalance({ address: withdrawal.address }), EXIT_FEE);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);

    await viem.assertions.revertWithCustomError(
      bobPool.write.requestExit([pubkey, EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "ExitAlreadyRequested",
    );
  });

  it("rejects malformed validator data", async function () {
    const { pool } = await networkHelpers.loadFixture(fullyFundedFixture);
    const pubkey = fixedHex("22", 48);
    const signature = fixedHex("bb", 96);
    const root = fixedHex("02", 32);

    await viem.assertions.revertWithCustomError(
      pool.write.stake([[fixedHex("22", 47)], [signature], [root]]),
      pool,
      "InvalidPubkey",
    );

    await viem.assertions.revertWithCustomError(
      pool.write.stake([[pubkey], [fixedHex("bb", 95)], [root]]),
      pool,
      "InvalidSignature",
    );

    await viem.assertions.revertWithCustomError(
      pool.write.stake([[pubkey], [signature], ["0x0000000000000000000000000000000000000000000000000000000000000000"]]),
      pool,
      "InvalidDepositDataRoot",
    );
  });

  it("rejects duplicate validators in a multi-validator staking call", async function () {
    const { pool } = await networkHelpers.loadFixture(twoValidatorFundedFixture);
    const pubkey = fixedHex("33", 48);

    await viem.assertions.revertWithCustomError(
      pool.write.stake([[pubkey, pubkey], [fixedHex("cc", 96), fixedHex("dd", 96)], [fixedHex("03", 32), fixedHex("04", 32)]]),
      pool,
      "DuplicateValidator",
    );
  });
});
