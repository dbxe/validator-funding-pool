import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, parseEther, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";

const STATE_UNINITIALIZED = 0;
const STATE_PREDEPOSITED = 1;
const STATE_FUNDING = 2;
const STATE_TOPPED_UP = 3;

const VALIDATOR_DEPOSIT = parseEther("32");
const PREDEPOSIT = parseEther("1");
const TOP_UP = parseEther("31");
const OPERATOR_TARGET = parseEther("2");
const ALICE_TARGET = parseEther("12");
const BOB_TARGET = parseEther("18");
const FUNDING_WINDOW = 3_600n;
const EXIT_FEE = 1_234n;
const DEFAULT_PUBKEY = fixedHex("11", 48);
const PREDEPOSIT_SIGNATURE = fixedHex("aa", 96);
const TOP_UP_SIGNATURE = fixedHex("bb", 96);
const PREDEPOSIT_ROOT = fixedHex("01", 32);
const TOP_UP_ROOT = fixedHex("02", 32);

function fixedHex(byte: string, length: number): Hex {
  return `0x${byte.repeat(length)}` as Hex;
}

function expectedWithdrawalCredentials(pool: Address): Hex {
  return `0x01${"00".repeat(11)}${pool.slice(2).toLowerCase()}` as Hex;
}

describe("ValidatorFundingPool", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  async function waitForReceipt(hash: Hex) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function wait(hash: Hex) {
    await waitForReceipt(hash);
  }

  function parsePoolEvents(pool: any, receipt: any) {
    const poolLogs = receipt.logs.filter((log: { address: Address }) => {
      return log.address.toLowerCase() === pool.address.toLowerCase();
    });
    return parseEventLogs({ abi: pool.abi, logs: poolLogs, strict: false }) as unknown as Array<{
      eventName: string;
      args: Record<string, unknown>;
    }>;
  }

  function numericArg(args: Record<string, unknown>, name: string) {
    const value = args[name];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error(`Expected numeric event arg ${name}`);
  }

  function bigintArg(args: Record<string, unknown>, name: string) {
    const value = args[name];
    if (typeof value !== "bigint") throw new Error(`Expected bigint event arg ${name}`);
    return value;
  }

  async function assertAccountingSnapshot(pool: any, receipt: any, expectedEventNames: string[]) {
    const events = parsePoolEvents(pool, receipt);
    assert.deepEqual(
      events.map((event) => event.eventName),
      expectedEventNames,
    );

    const snapshot = events.find((event) => event.eventName === "AccountingSnapshot");
    assert.ok(snapshot, "AccountingSnapshot event missing");
    const args = snapshot.args;

    const balance = await publicClient.getBalance({ address: pool.address });
    const state = Number(await pool.read.state());
    const fundingAttempt = await pool.read.fundingAttempt();
    const totalActiveFundedWei = await pool.read.totalActiveFundedWei();
    const totalRefundableWei = await pool.read.totalRefundableWei();
    const totalRefundedWei = await pool.read.totalRefundedWei();
    const totalCreditedWei = await pool.read.totalCreditedWei();
    const totalClaimedWei = await pool.read.totalClaimedWei();
    const grossPoolProceeds = await pool.read.grossPoolProceeds();

    assert.equal(numericArg(args, "state"), state);
    assert.equal(bigintArg(args, "fundingAttempt"), fundingAttempt);
    assert.equal(bigintArg(args, "balance"), balance);
    assert.equal(bigintArg(args, "totalActiveFundedWei"), totalActiveFundedWei);
    assert.equal(bigintArg(args, "totalRefundableWei"), totalRefundableWei);
    assert.equal(bigintArg(args, "totalRefundedWei"), totalRefundedWei);
    assert.equal(bigintArg(args, "totalCreditedWei"), totalCreditedWei);
    assert.equal(bigintArg(args, "totalClaimedWei"), totalClaimedWei);
    assert.equal(bigintArg(args, "grossPoolProceeds"), grossPoolProceeds);
    assert.equal(grossPoolProceeds, balance + totalClaimedWei - totalRefundableWei);

    return {
      state,
      fundingAttempt,
      balance,
      totalActiveFundedWei,
      totalRefundableWei,
      totalRefundedWei,
      totalCreditedWei,
      totalClaimedWei,
      grossPoolProceeds,
    };
  }

  function assertNoPoolEvents(pool: any, receipt: any) {
    assert.deepEqual(parsePoolEvents(pool, receipt), []);
  }

  async function poolAs(poolAddress: Address, wallet: Awaited<ReturnType<typeof viem.getWalletClients>>[number]) {
    return viem.getContractAt("ValidatorFundingPool", poolAddress, {
      client: { wallet },
    });
  }

  async function assertAccountingInvariants(poolAddress: Address, participants: Address[]) {
    const pool = await viem.getContractAt("ValidatorFundingPool", poolAddress);
    const balance = await publicClient.getBalance({ address: poolAddress });
    const totalRefundableWei = await pool.read.totalRefundableWei();
    const totalClaimedWei = await pool.read.totalClaimedWei();
    const gross = await pool.read.grossPoolProceeds();

    assert.equal(gross, balance + totalClaimedWei - totalRefundableWei);
    assert.ok(totalRefundableWei <= balance);

    let sumClaimed = 0n;
    let sumClaimable = 0n;
    for (const participant of participants) {
      sumClaimed += await pool.read.claimedWeiOf([participant]);
      sumClaimable += await pool.read.claimable([participant]);
    }

    assert.equal(sumClaimed, totalClaimedWei);
    assert.ok(sumClaimable <= balance - totalRefundableWei);
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
      operatorPool: await poolAs(pool.address, operator),
      alicePool: await poolAs(pool.address, alice),
      bobPool: await poolAs(pool.address, bob),
      charliePool: await poolAs(pool.address, charlie),
      outsiderPool: await poolAs(pool.address, outsider),
    };
  }

  async function predepositedFixture() {
    const fixture = await deployFixture();
    await wait(
      await fixture.pool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, PREDEPOSIT_SIGNATURE, PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
    );
    return fixture;
  }

  async function fundingFixture() {
    const fixture = await predepositedFixture();
    await wait(
      await fixture.pool.write.openFundingAttempt([
        [fixture.operator.account.address, fixture.alice.account.address, fixture.bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    const openedAt = BigInt(await networkHelpers.time.latest());
    const deadline = await fixture.pool.read.fundingDeadline();
    return { ...fixture, openedAt, deadline };
  }

  async function fullyFundedFixture() {
    const fixture = await fundingFixture();
    await wait(await fixture.operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await fixture.alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await fixture.bobPool.write.fund({ value: BOB_TARGET }));
    return fixture;
  }

  async function toppedUpFixture() {
    const fixture = await fullyFundedFixture();
    await wait(await fixture.pool.write.topUpValidator());
    return fixture;
  }

  it("deploys uninitialized with pool-owned 0x01 credentials and no funding attempt", async function () {
    const { pool, operator, outsiderPool } = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await pool.read.state(), STATE_UNINITIALIZED);
    assert.equal((await pool.read.operator()).toLowerCase(), operator.account.address.toLowerCase());
    assert.equal(await pool.read.VALIDATOR_DEPOSIT_WEI(), VALIDATOR_DEPOSIT);
    assert.equal(await pool.read.PREDEPOSIT_WEI(), PREDEPOSIT);
    assert.equal(await pool.read.TOP_UP_WEI(), TOP_UP);
    assert.equal(await pool.read.participantCount(), 0n);
    assert.equal(await pool.read.fundingDeadline(), 0n);
    assert.equal((await pool.read.withdrawalCredentials()).toLowerCase(), expectedWithdrawalCredentials(pool.address));

    await viem.assertions.revertWithCustomError(outsiderPool.write.fund({ value: 1n }), pool, "InvalidState");
  });

  it("rejects no-code system addresses", async function () {
    const wallets = await viem.getWalletClients();
    const [operator, outsider] = wallets;
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);

    await assert.rejects(
      viem.deployContract("ValidatorFundingPool", [
        outsider.account.address,
        withdrawal.address,
        operator.account.address,
        FUNDING_WINDOW,
      ]),
      /InvalidDepositContract/,
    );

    await assert.rejects(
      viem.deployContract("ValidatorFundingPool", [
        deposit.address,
        outsider.account.address,
        operator.account.address,
        FUNDING_WINDOW,
      ]),
      /InvalidWithdrawalRequestPredeploy/,
    );
  });

  it("operator commits validator data and submits exactly 1 ETH predeposit", async function () {
    const { pool, deposit, outsiderPool } = await networkHelpers.loadFixture(deployFixture);

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, PREDEPOSIT_SIGNATURE, PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
      pool,
      "NotOperator",
    );
    await viem.assertions.revertWithCustomError(
      pool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, PREDEPOSIT_SIGNATURE, PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT - 1n },
      ),
      pool,
      "InvalidPredepositValue",
    );

    const receipt = await waitForReceipt(
      await pool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, PREDEPOSIT_SIGNATURE, PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
    );
    await assertAccountingSnapshot(pool, receipt, ["ValidatorPredeposited", "AccountingSnapshot"]);

    assert.equal(await pool.read.state(), STATE_PREDEPOSITED);
    assert.equal(await pool.read.predepositSubmitted(), true);
    assert.equal(await pool.read.topUpSubmitted(), false);
    assert.equal(await pool.read.committedPubkey(), DEFAULT_PUBKEY);
    assert.equal(await pool.read.predepositSignature(), PREDEPOSIT_SIGNATURE);
    assert.equal(await pool.read.topUpSignature(), TOP_UP_SIGNATURE);
    assert.equal(await pool.read.committedPubkeyHash(), keccak256(DEFAULT_PUBKEY));
    assert.equal(await pool.read.predepositDataRoot(), PREDEPOSIT_ROOT);
    assert.equal(await pool.read.topUpDepositDataRoot(), TOP_UP_ROOT);
    assert.equal(await deposit.read.depositCount(), 1n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);

    const record = await deposit.read.depositAt([0n]);
    assert.equal(record[0], DEFAULT_PUBKEY);
    assert.equal(record[1].toLowerCase(), expectedWithdrawalCredentials(pool.address));
    assert.equal(record[2], PREDEPOSIT_SIGNATURE);
    assert.equal(record[3], PREDEPOSIT_ROOT);
    assert.equal(record[4], PREDEPOSIT);
  });

  it("rejects malformed validator data", async function () {
    const { pool } = await networkHelpers.loadFixture(deployFixture);

    await viem.assertions.revertWithCustomError(
      pool.write.commitAndPredeposit(
        [fixedHex("22", 47), PREDEPOSIT_SIGNATURE, PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
      pool,
      "InvalidPubkey",
    );
    await viem.assertions.revertWithCustomError(
      pool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, fixedHex("aa", 95), PREDEPOSIT_ROOT, TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
      pool,
      "InvalidSignature",
    );
    await viem.assertions.revertWithCustomError(
      pool.write.commitAndPredeposit(
        [DEFAULT_PUBKEY, PREDEPOSIT_SIGNATURE, fixedHex("00", 32), TOP_UP_SIGNATURE, TOP_UP_ROOT],
        { value: PREDEPOSIT },
      ),
      pool,
      "InvalidDepositDataRoot",
    );
  });

  it("opens fixed funding attempts with operator predeposit credit", async function () {
    const { pool, operator, alice, bob } = await networkHelpers.loadFixture(predepositedFixture);

    await viem.assertions.revertWithCustomError(
      pool.write.openFundingAttempt([
        [alice.account.address, bob.account.address],
        [ALICE_TARGET, BOB_TARGET + OPERATOR_TARGET],
      ]),
      pool,
      "OperatorTargetTooSmall",
    );
    await viem.assertions.revertWithCustomError(
      pool.write.openFundingAttempt([
        [operator.account.address, alice.account.address, bob.account.address],
        [PREDEPOSIT - 1n, ALICE_TARGET, BOB_TARGET + 1n],
      ]),
      pool,
      "OperatorTargetTooSmall",
    );
    await viem.assertions.revertWithCustomError(
      pool.write.openFundingAttempt([
        [operator.account.address, alice.account.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET - 1n],
      ]),
      pool,
      "FundingTargetsDoNotMatchValidator",
    );

    const receipt = await waitForReceipt(
      await pool.write.openFundingAttempt([
        [operator.account.address, alice.account.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    await assertAccountingSnapshot(pool, receipt, ["FundingAttemptOpened", "AccountingSnapshot"]);

    const openedAt = BigInt(await networkHelpers.time.latest());
    assert.equal(await pool.read.state(), STATE_FUNDING);
    assert.equal(await pool.read.fundingAttempt(), 1n);
    assert.equal(await pool.read.fundingDeadline(), openedAt + FUNDING_WINDOW);
    assert.equal(await pool.read.participantCount(), 3n);
    assert.equal(await pool.read.fundingTargetWeiOf([operator.account.address]), OPERATOR_TARGET);
    assert.equal(await pool.read.fundingRemainingWeiOf([operator.account.address]), OPERATOR_TARGET - PREDEPOSIT);
    assert.equal(await pool.read.fundingRemainingWeiOf([alice.account.address]), ALICE_TARGET);
    assert.equal(await pool.read.fundingRemainingWeiOf([bob.account.address]), BOB_TARGET);
  });

  it("funds only current fixed allocations and tops up exactly 31 ETH", async function () {
    const { pool, deposit, operatorPool, alicePool, bobPool, outsiderPool, operator, alice, bob } =
      await networkHelpers.loadFixture(fundingFixture);

    await viem.assertions.revertWithCustomError(outsiderPool.write.fund({ value: 1n }), pool, "NotParticipant");
    await viem.assertions.revertWithCustomError(
      operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT + 1n }),
      pool,
      "FundingCapExceeded",
    );
    await viem.assertions.revertWithCustomError(pool.write.topUpValidator(), pool, "FundingIncomplete");

    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));

    assert.equal(await pool.read.totalActiveFundedWei(), TOP_UP);
    assert.equal(await publicClient.getBalance({ address: pool.address }), TOP_UP);

    const receipt = await waitForReceipt(await pool.write.topUpValidator());
    const snapshot = await assertAccountingSnapshot(pool, receipt, [
      "ValidatorTopUpSubmitted",
      "PoolToppedUp",
      "AccountingSnapshot",
    ]);

    assert.equal(snapshot.state, STATE_TOPPED_UP);
    assert.equal(snapshot.balance, 0n);
    assert.equal(snapshot.totalCreditedWei, VALIDATOR_DEPOSIT);
    assert.equal(await pool.read.topUpSubmitted(), true);
    assert.equal(await pool.read.creditedWeiOf([operator.account.address]), OPERATOR_TARGET);
    assert.equal(await pool.read.creditedWeiOf([alice.account.address]), ALICE_TARGET);
    assert.equal(await pool.read.creditedWeiOf([bob.account.address]), BOB_TARGET);
    assert.equal(await deposit.read.depositCount(), 2n);

    const record = await deposit.read.depositAt([1n]);
    assert.equal(record[0], DEFAULT_PUBKEY);
    assert.equal(record[1].toLowerCase(), expectedWithdrawalCredentials(pool.address));
    assert.equal(record[2], TOP_UP_SIGNATURE);
    assert.equal(record[3], TOP_UP_ROOT);
    assert.equal(record[4], TOP_UP);
  });

  it("closes expired attempts into passive refunds and opens a fresh attempt without rollover", async function () {
    const { pool, operatorPool, alicePool, bobPool, charliePool, operator, alice, bob, charlie, outsider, deadline } =
      await networkHelpers.loadFixture(fundingFixture);

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    await networkHelpers.time.increaseTo(deadline + 1n);

    await viem.assertions.revertWithCustomError(alicePool.write.fund({ value: 1n }), pool, "FundingClosed");
    const closeReceipt = await waitForReceipt(await charliePool.write.closeExpiredFundingAttempt());
    const closeSnapshot = await assertAccountingSnapshot(pool, closeReceipt, [
      "FundingAttemptClosed",
      "AccountingSnapshot",
    ]);
    assert.equal(closeSnapshot.state, STATE_PREDEPOSITED);
    assert.equal(closeSnapshot.balance, parseEther("5"));
    assert.equal(closeSnapshot.totalActiveFundedWei, 0n);
    assert.equal(closeSnapshot.totalRefundableWei, parseEther("5"));
    assert.equal(await pool.read.fundingDeadline(), 0n);
    assert.equal(await pool.read.refundableWeiOf([alice.account.address]), parseEther("5"));
    assert.equal(await pool.read.participantCount(), 0n);

    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address, charlie.account.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    assert.equal(await pool.read.fundingAttempt(), 2n);
    assert.equal(await pool.read.isParticipant([alice.account.address]), false);
    assert.equal(await pool.read.fundingRemainingWeiOf([alice.account.address]), 0n);
    assert.equal(await pool.read.refundableWeiOf([alice.account.address]), parseEther("5"));
    await viem.assertions.revertWithCustomError(alicePool.write.fund({ value: 1n }), pool, "NotParticipant");

    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await charliePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());

    assert.equal(await pool.read.state(), STATE_TOPPED_UP);
    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await pool.read.grossPoolProceeds(), 0n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("5"));

    await viem.assertions.revertWithCustomError(charliePool.write.claim(), pool, "NothingToClaim");

    const outsiderBalanceBefore = await publicClient.getBalance({ address: outsider.account.address });
    await wait(await alicePool.write.refundTo([outsider.account.address]));
    assert.equal(
      await publicClient.getBalance({ address: outsider.account.address }),
      outsiderBalanceBefore + parseEther("5"),
    );
    assert.equal(await pool.read.totalRefundableWei(), 0n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("prevents deadline hostage while preserving deadline boundary behavior", async function () {
    const fundingAtDeadline = await networkHelpers.loadFixture(fundingFixture);
    await networkHelpers.time.setNextBlockTimestamp(fundingAtDeadline.deadline);
    await wait(await fundingAtDeadline.alicePool.write.fund({ value: 1n, gas: 100_000n }));
    assert.equal(await fundingAtDeadline.pool.read.activeFundedWeiOf([fundingAtDeadline.alice.account.address]), 1n);

    const closeAtDeadline = await networkHelpers.loadFixture(fundingFixture);
    await networkHelpers.time.setNextBlockTimestamp(closeAtDeadline.deadline);
    await viem.assertions.revertWithCustomError(
      closeAtDeadline.alicePool.write.closeExpiredFundingAttempt({ gas: 100_000n }),
      closeAtDeadline.pool,
      "FundingStillOpen",
    );

    const topUpAtDeadline = await networkHelpers.loadFixture(fullyFundedFixture);
    await networkHelpers.time.setNextBlockTimestamp(topUpAtDeadline.deadline);
    await wait(await topUpAtDeadline.pool.write.topUpValidator({ gas: 500_000n }));
    assert.equal(await topUpAtDeadline.pool.read.state(), STATE_TOPPED_UP);

    const closeAfterDeadline = await networkHelpers.loadFixture(fundingFixture);
    await networkHelpers.time.increaseTo(closeAfterDeadline.deadline + 1n);
    await wait(await closeAfterDeadline.alicePool.write.closeExpiredFundingAttempt());
    assert.equal(await closeAfterDeadline.pool.read.state(), STATE_PREDEPOSITED);
  });

  it("excludes failed-attempt refunds from topped-up proceeds", async function () {
    const { pool, operatorPool, alicePool, bobPool, charliePool, operator, alice, bob, charlie, outsider, deadline } =
      await networkHelpers.loadFixture(fundingFixture);

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await pool.write.closeExpiredFundingAttempt());

    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address, charlie.account.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await charliePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("32") }));
    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("32"));
    assert.equal(await pool.read.claimable([operator.account.address]), parseEther("2"));
    assert.equal(await pool.read.claimable([charlie.account.address]), parseEther("12"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("18"));

    await wait(await charliePool.write.claim());
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("32"));
    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("25"));

    await wait(await alicePool.write.refund());
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("32"));
    assert.equal(await pool.read.totalRefundableWei(), 0n);
    await assertAccountingInvariants(pool.address, [
      operator.account.address,
      charlie.account.address,
      bob.account.address,
    ]);
  });

  it("treats forced pre-top-up ETH as proceeds while excluding old refunds", async function () {
    const { pool, operatorPool, alicePool, bobPool, charliePool, operator, alice, bob, charlie, outsider, deadline } =
      await networkHelpers.loadFixture(fundingFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await wait(await alicePool.write.fund({ value: parseEther("5") }));
    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 32n }));
    const forcedReceipt = await waitForReceipt(await forceSend.write.forceSend([pool.address]));
    assertNoPoolEvents(pool, forcedReceipt);

    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await pool.write.closeExpiredFundingAttempt());

    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("5") + 32n);
    assert.equal(await pool.read.grossPoolProceeds(), 32n);

    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address, charlie.account.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await charliePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());

    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("5") + 32n);
    assert.equal(await pool.read.grossPoolProceeds(), 32n);
    assert.equal(await pool.read.claimable([operator.account.address]), 2n);
    assert.equal(await pool.read.claimable([charlie.account.address]), 12n);
    assert.equal(await pool.read.claimable([bob.account.address]), 18n);
    assert.equal(await pool.read.claimable([alice.account.address]), 0n);

    await wait(await charliePool.write.claim());
    assert.equal(await pool.read.totalRefundableWei(), parseEther("5"));
    assert.equal(await pool.read.grossPoolProceeds(), 32n);

    await wait(await alicePool.write.refund());
    assert.equal(await pool.read.totalRefundableWei(), 0n);
    assert.equal(await pool.read.grossPoolProceeds(), 32n);

    await wait(await operatorPool.write.claim());
    await wait(await bobPool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("treats post-top-up ETH as pro-rata proceeds with order-independent claims", async function () {
    const { pool, operatorPool, alicePool, bobPool, operator, alice, bob, charlie, outsider } =
      await networkHelpers.loadFixture(toppedUpFixture);
    const participants = [operator.account.address, alice.account.address, bob.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("16") }));

    assert.equal(await pool.read.grossPoolProceeds(), parseEther("16"));
    assert.equal(await pool.read.claimable([operator.account.address]), parseEther("1"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("6"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("9"));

    await viem.assertions.revertWithCustomError(alicePool.write.claimTo([zeroAddress]), pool, "InvalidRecipient");
    await viem.assertions.revertWithCustomError(alicePool.write.claimTo([pool.address]), pool, "InvalidRecipient");

    const grossBeforeClaim = await pool.read.grossPoolProceeds();
    const charlieBalanceBefore = await publicClient.getBalance({ address: charlie.account.address });
    await wait(await alicePool.write.claimTo([charlie.account.address]));
    assert.equal(await pool.read.grossPoolProceeds(), grossBeforeClaim);
    assert.equal(await pool.read.claimedWeiOf([alice.account.address]), parseEther("6"));
    assert.equal(await publicClient.getBalance({ address: charlie.account.address }), charlieBalanceBefore + parseEther("6"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("9"));

    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("16") }));
    assert.equal(await pool.read.grossPoolProceeds(), parseEther("32"));
    assert.equal(await pool.read.claimable([operator.account.address]), parseEther("2"));
    assert.equal(await pool.read.claimable([alice.account.address]), parseEther("6"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("18"));

    await wait(await bobPool.write.claim());
    await wait(await alicePool.write.claim());
    await wait(await operatorPool.write.claim());

    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
    assert.equal(await pool.read.totalClaimedWei(), parseEther("32"));
    await assertAccountingInvariants(pool.address, participants);
  });

  it("uses later proceeds to unlock rounding dust", async function () {
    const { pool, operatorPool, alicePool, bobPool, operator, alice, bob, outsider } =
      await networkHelpers.loadFixture(toppedUpFixture);
    const participants = [operator.account.address, alice.account.address, bob.account.address];

    await wait(await outsider.sendTransaction({ to: pool.address, value: 31n }));
    assert.equal(await pool.read.grossPoolProceeds(), 31n);
    assert.equal(await pool.read.claimable([operator.account.address]), 1n);
    assert.equal(await pool.read.claimable([alice.account.address]), 11n);
    assert.equal(await pool.read.claimable([bob.account.address]), 17n);
    await assertAccountingInvariants(pool.address, participants);

    await wait(await outsider.sendTransaction({ to: pool.address, value: 1n }));
    assert.equal(await pool.read.grossPoolProceeds(), 32n);
    assert.equal(await pool.read.claimable([operator.account.address]), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 12n);
    assert.equal(await pool.read.claimable([bob.account.address]), 18n);

    await wait(await operatorPool.write.claim());
    await wait(await alicePool.write.claim());
    await wait(await bobPool.write.claim());
    assert.equal(await publicClient.getBalance({ address: pool.address }), 0n);
  });

  it("treats forced ETH before top-up as proceeds after top-up", async function () {
    const { pool, operatorPool, alicePool, bobPool, operator, alice, bob, outsider } =
      await networkHelpers.loadFixture(fundingFixture);
    const forceSend = await viem.deployContract("ForceSend");

    await wait(await outsider.sendTransaction({ to: forceSend.address, value: 32n }));
    const forcedReceipt = await waitForReceipt(await forceSend.write.forceSend([pool.address]));
    assertNoPoolEvents(pool, forcedReceipt);
    assert.equal(await pool.read.grossPoolProceeds(), 32n);

    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());

    assert.equal(await pool.read.grossPoolProceeds(), 32n);
    assert.equal(await pool.read.claimable([operator.account.address]), 2n);
    assert.equal(await pool.read.claimable([alice.account.address]), 12n);
    assert.equal(await pool.read.claimable([bob.account.address]), 18n);
  });

  it("snapshots callable topped-up ETH and excludes EIP-7002 request attempts", async function () {
    const { pool, operatorPool, outsider, withdrawal } = await networkHelpers.loadFixture(toppedUpFixture);

    const receiveReceipt = await waitForReceipt(await outsider.sendTransaction({ to: pool.address, value: 6n }));
    const receiveSnapshot = await assertAccountingSnapshot(pool, receiveReceipt, [
      "EthReceivedViaCall",
      "AccountingSnapshot",
    ]);
    assert.equal(receiveSnapshot.state, STATE_TOPPED_UP);
    assert.equal(receiveSnapshot.balance, 6n);
    assert.equal(receiveSnapshot.grossPoolProceeds, 6n);

    const exitReceipt = await waitForReceipt(await operatorPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }));
    assert.deepEqual(
      parsePoolEvents(pool, exitReceipt).map((event) => event.eventName),
      ["ExitRequestSubmitted"],
    );
    assert.equal(await withdrawal.read.requestCount(), 1n);
    assert.equal(await pool.read.grossPoolProceeds(), 6n);
  });

  it("allows retryable exit requests from the operator and final credited participants only", async function () {
    const fixture = await networkHelpers.loadFixture(fundingFixture);
    const { pool, operatorPool, alicePool, bobPool, outsiderPool, withdrawal, deadline } = fixture;

    await viem.assertions.revertWithCustomError(
      outsiderPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );
    await viem.assertions.revertWithCustomError(
      alicePool.write.requestExit([EXIT_FEE - 1n], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );

    await wait(await operatorPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE + 100n }));
    assert.equal(await withdrawal.read.requestCount(), 1n);
    assert.equal((await withdrawal.read.lastSourceAddress()).toLowerCase(), pool.address.toLowerCase());
    assert.equal(await withdrawal.read.lastPubkey(), DEFAULT_PUBKEY);
    assert.equal(await withdrawal.read.lastAmountData(), "0x0000000000000000");
    assert.equal(await withdrawal.read.lastValue(), EXIT_FEE);
    assert.equal(await pool.read.exitRequestAttemptCount(), 1n);
    assert.equal(await pool.read.exitRequested(), true);

    await wait(await bobPool.write.fund({ value: parseEther("1") }));
    await networkHelpers.time.increaseTo(deadline + 1n);
    await wait(await pool.write.closeExpiredFundingAttempt());

    await viem.assertions.revertWithCustomError(
      bobPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );
    assert.equal(await withdrawal.read.requestCount(), 1n);

    await wait(
      await pool.write.openFundingAttempt([
        [fixture.operator.account.address, fixture.alice.account.address, fixture.bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    await viem.assertions.revertWithCustomError(
      bobPool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }),
      pool,
      "NotParticipant",
    );
    assert.equal(await withdrawal.read.requestCount(), 1n);

    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await alicePool.write.fund({ value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());
    await wait(await alicePool.write.requestExit([EXIT_FEE], { value: EXIT_FEE }));
    assert.equal(await withdrawal.read.requestCount(), 2n);
  });

  it("rolls claim accounting back if a credited participant cannot receive ETH", async function () {
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
    ]);
    const operatorPool = await poolAs(pool.address, operator);
    const bobPool = await poolAs(pool.address, bob);

    await wait(
      await pool.write.commitAndPredeposit(
        [fixedHex("66", 48), PREDEPOSIT_SIGNATURE, fixedHex("07", 32), TOP_UP_SIGNATURE, fixedHex("08", 32)],
        { value: PREDEPOSIT },
      ),
    );
    await wait(
      await pool.write.openFundingAttempt([
        [operator.account.address, rejectingParticipant.address, bob.account.address],
        [OPERATOR_TARGET, ALICE_TARGET, BOB_TARGET],
      ]),
    );
    await wait(await operatorPool.write.fund({ value: OPERATOR_TARGET - PREDEPOSIT }));
    await wait(await rejectingParticipant.write.fundPool([pool.address], { value: ALICE_TARGET }));
    await wait(await bobPool.write.fund({ value: BOB_TARGET }));
    await wait(await pool.write.topUpValidator());
    await wait(await outsider.sendTransaction({ to: pool.address, value: parseEther("8") }));

    assert.equal(await pool.read.claimable([rejectingParticipant.address]), parseEther("3"));
    assert.equal(await pool.read.claimable([bob.account.address]), parseEther("4.5"));

    await viem.assertions.revertWithCustomError(
      rejectingParticipant.write.claimPool([pool.address]),
      pool,
      "EthPayoutFailed",
    );
    assert.equal(await pool.read.claimedWeiOf([rejectingParticipant.address]), 0n);
    assert.equal(await pool.read.totalClaimedWei(), 0n);

    const outsiderBalanceBefore = await publicClient.getBalance({ address: outsider.account.address });
    await wait(await rejectingParticipant.write.claimPoolTo([pool.address, outsider.account.address]));
    assert.equal(await pool.read.claimedWeiOf([rejectingParticipant.address]), parseEther("3"));
    assert.equal(await pool.read.totalClaimedWei(), parseEther("3"));
    assert.equal(await publicClient.getBalance({ address: outsider.account.address }), outsiderBalanceBefore + parseEther("3"));
  });
});
