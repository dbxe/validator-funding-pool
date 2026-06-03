import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, parseEther, zeroAddress, type Address, type Hex } from "viem";

const STATE_UNINITIALIZED = 0;
const STATE_FUNDING = 1;
const STATE_STAKED = 2;
const STATE_CANCELED = 3;

const GWEI = 1_000_000_000n;
const VALIDATOR_DEPOSIT = parseEther("32");
const ALICE_TARGET = parseEther("12");
const BOB_TARGET = parseEther("20");
const FUNDING_WINDOW = 3_600n;
const EXIT_FEE = 1_234n;
const DEFAULT_PUBKEY = fixedHex("11", 48);
const DEFAULT_SIGNATURE = fixedHex("aa", 96);
const DEFAULT_DEPOSIT_ROOT = fixedHex("01", 32);

function fixedHex(byte: string, length: number): Hex {
  return `0x${byte.repeat(length)}` as Hex;
}

function expectedWithdrawalCredentials(pool: Address): Hex {
  return `0x01${"00".repeat(11)}${pool.slice(2).toLowerCase()}` as Hex;
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
    const [operator, alice, bob, charlie, outsider] = wallets;

    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      operator.account.address,
      FUNDING_WINDOW,
      [alice.account.address, bob.account.address],
      [ALICE_TARGET, BOB_TARGET],
    ]);

    return {
      operator,
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
    };
  }

  async function committedFixture() {
    const fixture = await deployFixture();
    await wait(await fixture.pool.write.commitValidator([DEFAULT_PUBKEY, DEFAULT_SIGNATURE, DEFAULT_DEPOSIT_ROOT]));
    const committedAt = BigInt(await networkHelpers.time.latest());
    const deadline = await fixture.pool.read.fundingDeadline();

    return {
      ...fixture,
      pubkey: DEFAULT_PUBKEY,
      signature: DEFAULT_SIGNATURE,
      depositDataRoot: DEFAULT_DEPOSIT_ROOT,
      committedAt,
      deadline,
    };
  }

  async function fullyFundedFixture() {
    const fixture = await committedFixture();
    await wait(await fixture.alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await fixture.bobPool.write.fund({ value: BOB_TARGET }));
    return fixture;
  }

  async function stakedFixture() {
    const fixture = await fullyFundedFixture();
    await wait(await fixture.pool.write.stake());
    return fixture;
  }

  it("deploys uninitialized with fixed participant weights and pool-owned 0x01 credentials", async function () {
    const { pool, alice, bob, outsiderPool } = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await pool.read.state(), STATE_UNINITIALIZED);
    assert.equal(
      (await pool.read.operator()).toLowerCase(),
      (await viem.getWalletClients())[0].account.address.toLowerCase(),
    );
    assert.equal(await pool.read.totalFundingTarget(), VALIDATOR_DEPOSIT);
    assert.equal(await pool.read.VALIDATOR_DEPOSIT_WEI(), VALIDATOR_DEPOSIT);
    assert.equal(await pool.read.fundingDeadline(), 0n);
    assert.equal(await pool.read.fundingTargetOf([alice.account.address]), ALICE_TARGET);
    assert.equal(await pool.read.fundingTargetOf([bob.account.address]), BOB_TARGET);
    assert.equal((await pool.read.withdrawalCredentials()).toLowerCase(), expectedWithdrawalCredentials(pool.address));

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.fund({ value: 1n }),
      pool,
      "InvalidState",
    );
  });

  it("rejects no-code system addresses and funding targets that do not sum to 32 ETH", async function () {
    const wallets = await viem.getWalletClients();
    const [operator, alice, bob, , outsider] = wallets;
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const participants = [alice.account.address, bob.account.address];

    await assert.rejects(
      viem.deployContract("ValidatorFundingPool", [
        outsider.account.address,
        withdrawal.address,
        operator.account.address,
        FUNDING_WINDOW,
        participants,
        [ALICE_TARGET, BOB_TARGET],
      ]),
      /InvalidDepositContract/,
    );

    await assert.rejects(
      viem.deployContract("ValidatorFundingPool", [
        deposit.address,
        outsider.account.address,
        operator.account.address,
        FUNDING_WINDOW,
        participants,
        [ALICE_TARGET, BOB_TARGET],
      ]),
      /InvalidWithdrawalRequestPredeploy/,
    );

    await assert.rejects(
      viem.deployContract("ValidatorFundingPool", [
        deposit.address,
        withdrawal.address,
        operator.account.address,
        FUNDING_WINDOW,
        participants,
        [ALICE_TARGET, BOB_TARGET - 1n],
      ]),
      /FundingTargetsDoNotMatchValidator/,
    );
  });

  it("stays closed until the operator commits validator data", async function () {
    const { pool, alicePool, outsiderPool } = await networkHelpers.loadFixture(deployFixture);

    await viem.assertions.revertWithCustomError(alicePool.write.fund({ value: 1n }), pool, "InvalidState");
    await viem.assertions.revertWithCustomError(pool.write.stake(), pool, "InvalidState");
    await viem.assertions.revertWithCustomError(alicePool.write.cancel(), pool, "InvalidState");
    await viem.assertions.revertWithCustomError(alicePool.write.claim(), pool, "InvalidState");
    await viem.assertions.revertWithCustomError(
      alicePool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "InvalidState",
    );
    await viem.assertions.revertWithCustomError(
      outsiderPool.write.commitValidator([DEFAULT_PUBKEY, DEFAULT_SIGNATURE, DEFAULT_DEPOSIT_ROOT]),
      pool,
      "NotOperator",
    );
  });

  it("commits validator data once and starts the funding deadline at commitment time", async function () {
    const { pool, alicePool, pubkey, signature, depositDataRoot, committedAt, deadline } =
      await networkHelpers.loadFixture(committedFixture);

    assert.equal(await pool.read.state(), STATE_FUNDING);
    assert.equal(deadline, committedAt + FUNDING_WINDOW);
    assert.equal(await pool.read.validatorPubkey(), pubkey);
    assert.equal(await pool.read.validatorSignature(), signature);
    assert.equal(await pool.read.validatorDepositDataRoot(), depositDataRoot);
    assert.equal(await pool.read.validatorPubkeyHash(), keccak256(pubkey));

    await viem.assertions.revertWithCustomError(
      pool.write.commitValidator([fixedHex("22", 48), signature, fixedHex("02", 32)]),
      pool,
      "InvalidState",
    );
    await viem.assertions.revertWithCustomError(
      alicePool.write.fund({ value: ALICE_TARGET + 1n }),
      pool,
      "FundingCapExceeded",
    );
  });

  it("rejects malformed validator commitment data", async function () {
    const { pool } = await networkHelpers.loadFixture(deployFixture);

    await viem.assertions.revertWithCustomError(
      pool.write.commitValidator([fixedHex("22", 47), DEFAULT_SIGNATURE, DEFAULT_DEPOSIT_ROOT]),
      pool,
      "InvalidPubkey",
    );

    await viem.assertions.revertWithCustomError(
      pool.write.commitValidator([DEFAULT_PUBKEY, fixedHex("bb", 95), DEFAULT_DEPOSIT_ROOT]),
      pool,
      "InvalidSignature",
    );

    await viem.assertions.revertWithCustomError(
      pool.write.commitValidator([
        DEFAULT_PUBKEY,
        DEFAULT_SIGNATURE,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ]),
      pool,
      "InvalidDepositDataRoot",
    );
  });

  it("keeps funding separate from live proceeds and refunds exact contributions on cancel", async function () {
    const { pool, alicePool, bobPool, alice, charlie, deadline } =
      await networkHelpers.loadFixture(committedFixture);

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);

    await viem.assertions.revertWithCustomError(alicePool.write.claim(), pool, "InvalidState");

    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await alicePool.write.cancel());
    assert.equal(await pool.read.state(), STATE_CANCELED);

    await viem.assertions.revertWithCustomError(bobPool.write.refund(), pool, "NothingToRefund");
    await viem.assertions.revertWithCustomError(alicePool.write.refundTo([zeroAddress]), pool, "InvalidRecipient");
    await viem.assertions.revertWithCustomError(alicePool.write.refundTo([pool.address]), pool, "InvalidRecipient");

    const charlieBalanceBefore = await publicClient.getBalance({ address: charlie.account.address });
    await wait(await alicePool.write.refundTo([charlie.account.address]));
    assert.equal(await pool.read.fundedOf([alice.account.address]), 0n);
    assert.equal(await pool.read.refundedTotal(), parseEther("5"));
    assert.equal(
      await publicClient.getBalance({ address: charlie.account.address }),
      charlieBalanceBefore + parseEther("5"),
    );
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("enforces deadline boundary behavior", async function () {
    const fundingFixture = await networkHelpers.loadFixture(committedFixture);
    await networkHelpers.time.setNextBlockTimestamp(fundingFixture.deadline);
    await wait(await fundingFixture.alicePool.write.fund({ value: 1n, gas: 100_000n }));
    assert.equal(await fundingFixture.pool.read.fundedOf([fundingFixture.alice.account.address]), 1n);

    const cancelAtDeadlineFixture = await networkHelpers.loadFixture(committedFixture);
    await networkHelpers.time.setNextBlockTimestamp(cancelAtDeadlineFixture.deadline);
    await viem.assertions.revertWithCustomError(
      cancelAtDeadlineFixture.alicePool.write.cancel({ gas: 100_000n }),
      cancelAtDeadlineFixture.pool,
      "FundingStillOpen",
    );

    const stakeFixture = await networkHelpers.loadFixture(fullyFundedFixture);
    await networkHelpers.time.setNextBlockTimestamp(stakeFixture.deadline);
    await wait(await stakeFixture.pool.write.stake({ gas: 500_000n }));
    assert.equal(await stakeFixture.pool.read.state(), STATE_STAKED);

    const cancelFixture = await networkHelpers.loadFixture(committedFixture);
    await networkHelpers.time.increaseTo(cancelFixture.deadline + 1n);
    await wait(await cancelFixture.alicePool.write.cancel());
    assert.equal(await cancelFixture.pool.read.state(), STATE_CANCELED);
  });

  it("deposits only after exact full funding and passes committed pool-owned 0x01 data", async function () {
    const { pool, deposit, alicePool, bobPool, outsiderPool, pubkey, signature, depositDataRoot } =
      await networkHelpers.loadFixture(committedFixture);

    await viem.assertions.revertWithCustomError(alicePool.write.stake(), pool, "NotOperator");

    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await viem.assertions.revertWithCustomError(pool.write.stake(), pool, "NotFullyFunded");

    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await viem.assertions.revertWithCustomError(outsiderPool.write.stake(), pool, "NotOperator");
    await wait(await pool.write.stake());

    assert.equal(await pool.read.state(), STATE_STAKED);
    assert.equal(await pool.read.validatorDeposited(), true);
    assert.equal(await pool.read.validatorPubkey(), pubkey);
    assert.equal(await deposit.read.depositCount(), 1n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);

    const record = await deposit.read.depositAt([0n]);
    assert.equal(record[0], pubkey);
    assert.equal(record[1].toLowerCase(), expectedWithdrawalCredentials(pool.address));
    assert.equal(record[2], signature);
    assert.equal(record[3], depositDataRoot);
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
    const { pool, alicePool, bobPool, alice, bob, charlie, outsider } =
      await networkHelpers.loadFixture(stakedFixture);
    const participants = [alice.account.address, bob.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("10") }));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("3.75"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("6.25"));
    await assertAccountingInvariants(pool.address, participants);

    await viem.assertions.revertWithCustomError(alicePool.write.claimTo([zeroAddress]), pool, "InvalidRecipient");
    await viem.assertions.revertWithCustomError(alicePool.write.claimTo([pool.address]), pool, "InvalidRecipient");

    const grossBeforeClaim = await pool.read.grossPoolProceeds();
    const charlieBalanceBefore = await publicClient.getBalance({ address: charlie.account.address });
    await wait(await alicePool.write.claimTo([charlie.account.address]));
    assert.equal(await pool.read.grossPoolProceeds(), grossBeforeClaim);
    assert.equal(await pool.read.claimedOf([alice.account.address]), parseEther("3.75"));
    assert.equal(
      await publicClient.getBalance({ address: charlie.account.address }),
      charlieBalanceBefore + parseEther("3.75"),
    );
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
    const { pool, alicePool, bobPool, alice, bob, outsider } = await networkHelpers.loadFixture(stakedFixture);
    const participants = [alice.account.address, bob.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: 1n }));
    assert.equal(await pool.read.grossPoolProceeds(), 1n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);
    assert.equal(await pool.read.claimable([bob.account.address]), 0n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 1n);
    assert.ok((await publicClient.getBalance({ address: pool.address })) < BigInt(participants.length));
    await assertAccountingInvariants(pool.address, participants);

    await wait(await outsider.sendTransaction({ to: pool.address, value: 31n }));
    assert.equal(await pool.read.grossPoolProceeds(), 32n);
    assert.equal(await pool.read.claimable([alice.account.address]), 12n);
    assert.equal(await pool.read.claimable([bob.account.address]), 20n);

    await wait(await alicePool.write.claim());
    await wait(await bobPool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
    assert.equal(await pool.read.totalClaimed(), 32n);
    await assertAccountingInvariants(pool.address, participants);
  });

  it("treats forced ETH before staking as proceeds once staking starts", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider } = await networkHelpers.loadFixture(committedFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 2n }));
    await wait(await forceSend.write.forceSend([pool.address]));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);

    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.stake());

    assert.equal(await pool.read.grossPoolProceeds(), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);
    assert.equal(await pool.read.claimable([bob.account.address]), 1n);

    await wait(await bobPool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 1n);
    await assertAccountingInvariants(pool.address, [alice.account.address, bob.account.address]);
  });

  it("lets funded participants sweep canceled surplus without changing refunds", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider, deadline } =
      await networkHelpers.loadFixture(committedFixture);
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
    await viem.assertions.revertWithCustomError(
      alicePool.write.sweepCanceledSurplusTo([zeroAddress]),
      pool,
      "InvalidRecipient",
    );
    await viem.assertions.revertWithCustomError(
      alicePool.write.sweepCanceledSurplusTo([pool.address]),
      pool,
      "InvalidRecipient",
    );
    const outsiderBalanceBefore = await publicClient.getBalance({ address: outsider.account.address });
    await wait(await alicePool.write.sweepCanceledSurplusTo([outsider.account.address]));
    assert.equal(await pool.read.canceledSurplusClaimedOf([alice.account.address]), 2n);
    assert.equal(await pool.read.canceledSurplusClaimedTotal(), 2n);
    assert.equal(await pool.read.grossCanceledSurplus(), 2n);
    assert.equal(await publicClient.getBalance({ address: outsider.account.address }), outsiderBalanceBefore + 2n);

    await wait(await alicePool.write.refund());
    assert.equal(await pool.read.refundedTotal(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("uses target weights for canceled surplus if no participant funded", async function () {
    const { pool, alicePool, bobPool, alice, bob, outsider, deadline } =
      await networkHelpers.loadFixture(committedFixture);
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
    const [operator, , bob, , outsider] = wallets;
    const rejectingParticipant = await viem.deployContract("RejectEthParticipant");
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);

    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      operator.account.address,
      FUNDING_WINDOW,
      [rejectingParticipant.address, bob.account.address],
      [ALICE_TARGET, BOB_TARGET],
    ]);
    const bobPool = await poolAs(pool.address, bob);

    await wait(await pool.write.commitValidator([fixedHex("66", 48), fixedHex("aa", 96), fixedHex("07", 32)]));
    await wait(await rejectingParticipant.write.fundPool([pool.address], { value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.stake());
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

    const outsiderBalanceBefore = await publicClient.getBalance({ address: outsider.account.address });
    await wait(await rejectingParticipant.write.claimPoolTo([pool.address, outsider.account.address]));
    assert.equal(await pool.read.claimedOf([rejectingParticipant.address]), parseEther("3"));
    assert.equal(await pool.read.totalClaimed(), parseEther("3"));
    assert.equal(
      await publicClient.getBalance({ address: outsider.account.address }),
      outsiderBalanceBefore + parseEther("3"),
    );

    await wait(await bobPool.write.claim());
    assert.equal(await pool.read.claimedOf([bob.account.address]), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
    await assertAccountingInvariants(pool.address, [rejectingParticipant.address, bob.account.address]);
  });

  it("lets any participant retry EIP-7002 full-exit requests from the pool address", async function () {
    const { pool, alicePool, bobPool, withdrawal, outsiderPool, pubkey } =
      await networkHelpers.loadFixture(stakedFixture);

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );

    await viem.assertions.revertWithCustomError(
      alicePool.write.requestExit([EXIT_FEE - 1n], { value: EXIT_FEE }),
      pool,
      "ExitFeeTooHigh",
    );

    await wait(await alicePool.write.requestExit([EXIT_FEE], { value: EXIT_FEE + 100n }));

    assert.equal(await withdrawal.read.requestCount(), 1n);
    assert.equal((await withdrawal.read.lastSourceAddress()).toLowerCase(), pool.address.toLowerCase());
    assert.equal(await withdrawal.read.lastPubkey(), pubkey);
    assert.equal(await withdrawal.read.lastAmountData(), "0x0000000000000000");
    assert.equal(await withdrawal.read.lastValue(), EXIT_FEE);
    assert.equal(await pool.read.exitRequestCount(), 1n);
    assert.equal(await pool.read.exitRequested(), true);
    assert.equal(await publicClient.getBalance({ address: withdrawal.address }), EXIT_FEE);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);

    await wait(await bobPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }));

    assert.equal(await withdrawal.read.requestCount(), 2n);
    assert.equal((await withdrawal.read.lastSourceAddress()).toLowerCase(), pool.address.toLowerCase());
    assert.equal(await withdrawal.read.lastPubkey(), pubkey);
    assert.equal(await pool.read.exitRequestCount(), 2n);
    assert.equal(await pool.read.lastExitRequestFee(), EXIT_FEE);
    assert.equal(await publicClient.getBalance({ address: withdrawal.address }), EXIT_FEE * 2n);
  });
});
