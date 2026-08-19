import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { parseEther, type Address, type Hex } from "viem";

import {
  DEFAULT_DEPOSIT_CONTRACT,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
  deriveWithdrawalCredentials,
  formatWei,
  type DeploymentRecord,
} from "../scripts/lib/common.js";
import { buildDepositData, writeDepositDataFile, type GeneratedDepositData } from "./deposit-data.js";
import {
  DEPOSIT_CONTRACT_ADDRESS,
  LOCAL_CHAIN_ID,
  LocalChain,
  WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS,
  type LocalAccount,
} from "./local-chain.js";
import {
  absentValidator,
  activeValidator,
  freshPredepositValidator,
  GENESIS_FORK_VERSION,
  MockBeaconNode,
  type Malformation,
} from "./mock-beacon.js";
import { POOL_ABI } from "./pool.js";
import {
  assertActiveSignerPrinted,
  assertOutputContains,
  assertOutputLacks,
  expectFailure,
  expectSuccess,
  runCommand,
  type CommandResult,
} from "./run-command.js";

/// End-to-end coverage of the SUPPORTED COMMANDS.
///
/// Every case here runs a command the way `package.json` runs it — `hardhat run
/// scripts/<name>.ts --network <network>` as a real child process, with a controlled
/// environment — against a real local chain and a deterministic mock beacon node, and
/// decides on the exit code and on the exact lines the operator reads. The unit suite
/// exercises the helpers; this exercises the wiring: argv, network selection, config
/// variable resolution, branch selection, the shared failure path, and the output.
///
/// The order of the cases is deliberate. They share one chain and one pool, and each one
/// leaves the pool in the state the next one needs, which is also how a real deployment
/// runs. Cases that consume a pool irreversibly come last.
///
/// Two mainnet system contracts are installed at their real mainnet addresses with their
/// real code (`local-chain.ts`), and the chain id is left at Hardhat's 31337. That
/// combination is the honest one: the canonicity pin is only recorded for mainnet, so the
/// commands take the WARNING branch, and the tests assert that warning is printed rather
/// than arranging for it to disappear.

const PREDEPOSIT_WEI = parseEther("1");
const TARGET_GWEI = 16_000_000_000n;
const TARGET_WEI = parseEther("16");
const OPERATOR_REMAINING_WEI = TARGET_WEI - PREDEPOSIT_WEI;
const TOP_UP_WEI = parseEther("31");

/// The canonical mainnet code hashes, repeated here as literals on purpose. They are what
/// `scripts/lib/common.ts` pins, and asserting the deployment record carries exactly these
/// is what proves the chain under test is running the real system contracts and not a mock
/// standing in for them.
const CANONICAL_DEPOSIT_CODE_HASH =
  "0x6c029a231254fadb724d63be769f75eedd66362df034a3e663252b49d062a666";
const CANONICAL_PREDEPLOY_CODE_HASH =
  "0x0345a365d2f4c5975b9f1599abe0a2ee76b7a3a731bc68781bd04c84e4858f50";

const CANONICITY_WARNING =
  `WARNING: no canonical system-contract pin is recorded for chainId ${LOCAL_CHAIN_ID}`;

/// The ceiling the failure-presentation requirement sets: a failed capital operation must
/// fit on a screen, with the line that says why near the top.
const MAX_FAILURE_LINES = 30;
const ACTIONABLE_WITHIN_LINES = 6;

describe("commands, end to end", { timeout: 900_000 }, () => {
  let chain: LocalChain;
  let beacon: MockBeaconNode;
  let workdir: string;

  let operator: LocalAccount;
  let participant: LocalAccount;
  let outsider: LocalAccount;

  let deploymentFile: string;
  let depositDataFile: string;
  let pool: Address;
  let withdrawalCredentials: Hex;
  let deposits: GeneratedDepositData;

  before(async () => {
    chain = await LocalChain.start();
    beacon = new MockBeaconNode(LOCAL_CHAIN_ID, DEPOSIT_CONTRACT_ADDRESS);
    await beacon.start();
    workdir = mkdtempSync(path.join(tmpdir(), "validator-funding-pool-e2e-"));
    operator = chain.accounts[0];
    participant = chain.accounts[1];
    outsider = chain.accounts[2];
    deploymentFile = path.join(workdir, "deployment.json");
    depositDataFile = path.join(workdir, "deposit-data.json");
  });

  after(async () => {
    await beacon.stop();
    await chain.stop();
  });

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  function baseEnv(extra: Record<string, string | undefined> = {}) {
    return {
      RPC_URL: chain.url,
      BEACON_NODE_URL: beacon.url,
      DEPLOYMENT_FILE: deploymentFile,
      DEPOSIT_DATA_FILE: depositDataFile,
      ...extra,
    };
  }

  function asOperator(extra: Record<string, string | undefined> = {}) {
    return baseEnv({ PRIVATE_KEY: operator.privateKey, ...extra });
  }

  function asParticipant(extra: Record<string, string | undefined> = {}) {
    return baseEnv({ PRIVATE_KEY: participant.privateKey, ...extra });
  }

  // -------------------------------------------------------------------------
  // Chain reads
  // -------------------------------------------------------------------------

  async function readPool<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await chain.publicClient.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName,
      args: args as never,
    })) as T;
  }

  async function fundingDeadline(): Promise<bigint> {
    return readPool<bigint>("fundingDeadline");
  }

  // -------------------------------------------------------------------------
  // Failure-shape assertions
  // -------------------------------------------------------------------------

  /// Every failure must be readable: the shared handler's header, the whole thing inside
  /// `MAX_FAILURE_LINES`, and the line that says what to do about it within the first few.
  function assertReadableFailure(result: CommandResult, script: string, actionable: string) {
    const header = `FATAL: ${script} did not complete.`;
    const lines = result.stderr.split("\n");
    const start = lines.findIndex((line) => line.includes(header));
    assert.ok(
      start >= 0,
      `${result.commandLine} did not print the shared failure header:\n${result.stderr}`,
    );
    assert.ok(
      lines.length <= MAX_FAILURE_LINES,
      `${result.commandLine} printed ${lines.length} lines of failure, above the ` +
        `${MAX_FAILURE_LINES}-line ceiling:\n${result.stderr}`,
    );
    const opening = lines.slice(start, start + ACTIONABLE_WITHIN_LINES).join("\n");
    assert.ok(
      opening.includes(actionable),
      `${result.commandLine} does not name ${JSON.stringify(actionable)} within the first ` +
        `${ACTIONABLE_WITHIN_LINES} lines of the failure:\n${result.stderr}`,
    );
    assertOutputContains(result, "Re-run with DEBUG=1 for the complete error object");
  }

  // -------------------------------------------------------------------------
  // 1. deploy
  // -------------------------------------------------------------------------

  it("deploy writes a record for a pool whose runtime code it verified", async () => {
    const result = expectSuccess(
      await runCommand({
        script: "deploy",
        // No BEACON_NODE_URL: `deploy` touches no beacon endpoint, and a test that supplied
        // one would not notice if it started to.
        env: {
          RPC_URL: chain.url,
          PRIVATE_KEY: operator.privateKey,
          DEPLOYMENT_FILE: deploymentFile,
        },
      }),
    );

    assertActiveSignerPrinted(result, "deploy", operator.address.toLowerCase());
    // `DEPLOYMENT_FILE` selects the record every later command's checks are made about, so
    // the resolved path is printed here too, next to the signer line.
    assertOutputContains(result, `Deployment record: ${deploymentFile} (to be written by this command)`);
    // The canonicity pin exists only for mainnet, so an unrecognised chain id must WARN and
    // fall back to record-to-pool consistency. Asserted, not suppressed.
    assertOutputContains(result, CANONICITY_WARNING);
    assertOutputContains(result, `Deposit contract code hash: ${CANONICAL_DEPOSIT_CODE_HASH}`);
    assertOutputContains(
      result,
      `Withdrawal request predeploy code hash: ${CANONICAL_PREDEPLOY_CODE_HASH}`,
    );
    assertOutputContains(
      result,
      "Pool runtime code matches the local build artifacts/contracts/ValidatorFundingPool.sol/" +
        "ValidatorFundingPool.json",
    );
    assertOutputContains(result, `Wrote deployment: ${deploymentFile}`);

    const record = JSON.parse(readFileSync(deploymentFile, "utf8")) as DeploymentRecord;
    pool = record.pool;
    withdrawalCredentials = deriveWithdrawalCredentials(pool);

    assert.equal(record.chainId, LOCAL_CHAIN_ID);
    assert.equal(record.depositContract, DEFAULT_DEPOSIT_CONTRACT);
    assert.equal(record.withdrawalRequestPredeploy, DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY);
    assert.equal(record.depositContractCodeHash, CANONICAL_DEPOSIT_CODE_HASH);
    assert.equal(record.withdrawalRequestPredeployCodeHash, CANONICAL_PREDEPLOY_CODE_HASH);
    assert.equal(record.operator.toLowerCase(), operator.address.toLowerCase());
    assert.equal(record.fundingWindowDuration, "86400");
    assert.equal(record.withdrawalCredentials.toLowerCase(), withdrawalCredentials);
    assertOutputContains(result, `Pool deployed: ${pool}`);

    // The default addresses in the record are the ones the harness installed the real
    // system contracts at, which is what makes the record's code hashes mean anything.
    assert.equal(record.depositContract, DEPOSIT_CONTRACT_ADDRESS);
    assert.equal(record.withdrawalRequestPredeploy, WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS);

    // The deposit data can only be written now: the withdrawal credentials are derived from
    // the pool's own address.
    deposits = buildDepositData(7, withdrawalCredentials, GENESIS_FORK_VERSION as Hex);
    writeDepositDataFile(depositDataFile, deposits);
    beacon.setValidator(deposits.pubkey, absentValidator());
  });

  // -------------------------------------------------------------------------
  // 2. commit-predeposit
  // -------------------------------------------------------------------------

  it("commit-predeposit refuses a pubkey the head state already knows", async () => {
    const result = await beacon.withScenario(
      () => beacon.setValidator(deposits.pubkey, freshPredepositValidator(withdrawalCredentials)),
      () => runCommand({ script: "commit-predeposit", env: asOperator() }),
    );

    expectFailure(result);
    assertActiveSignerPrinted(result, "commit-predeposit", operator.address.toLowerCase());
    assertReadableFailure(
      result,
      "commit-predeposit",
      `commit-predeposit beacon preflight failed: validator ${deposits.pubkey} already exists in ` +
        `head state with status "pending_initialized"`,
    );
    assertOutputLacks(result, "Predeposited in block");
    assert.equal(await readPool<number>("state"), 0);
  });

  it("commit-predeposit submits the 1 ETH predeposit once absence is proven", async () => {
    const result = expectSuccess(
      await runCommand({ script: "commit-predeposit", env: asOperator() }),
    );

    assertActiveSignerPrinted(result, "commit-predeposit", operator.address.toLowerCase());
    assertOutputContains(result, `Deployment record: ${deploymentFile}`);
    // The other variable that selects a subject rather than waiving a check. This command
    // commits whatever pubkey that file names, forever, so the file is named in the output.
    assertOutputContains(result, `Deposit data file: ${depositDataFile}`);
    assertOutputContains(
      result,
      "commit-predeposit beacon preflight passed: the head state validator list is empty for this pubkey",
    );
    assertOutputContains(result, `Committing validator ${deposits.pubkey} to ${pool}`);
    assertOutputContains(result, "Submitting operator-funded predeposit: 1 ETH");
    assertOutputContains(result, "Predeposited in block ");

    assert.equal(await readPool<number>("state"), 1);
    assert.equal(await readPool<boolean>("predepositSubmitted"), true);
    assert.equal((await readPool<Hex>("committedPubkey")).toLowerCase(), deposits.pubkey);
    // The real deposit contract accepted it, which means it recomputed the deposit data root
    // from the calldata and got the same answer the deposit-data file carries.
    assert.equal(await chain.publicClient.getBalance({ address: DEPOSIT_CONTRACT_ADDRESS }), PREDEPOSIT_WEI);

    // From here on the validator exists on the beacon chain with the pool's credentials.
    beacon.setValidator(deposits.pubkey, freshPredepositValidator(withdrawalCredentials));
  });

  // -------------------------------------------------------------------------
  // 3. open-funding-attempt
  // -------------------------------------------------------------------------

  it("open-funding-attempt opens the declared participant set", async () => {
    const result = expectSuccess(
      await runCommand({
        script: "open-funding-attempt",
        env: asOperator({
          PARTICIPANTS: `${operator.address},${participant.address}`,
          FUNDING_TARGETS_GWEI: `${TARGET_GWEI},${TARGET_GWEI}`,
        }),
      }),
    );

    assertActiveSignerPrinted(result, "open-funding-attempt", operator.address.toLowerCase());
    assertOutputContains(result, `Opening funding attempt for ${pool}`);
    assertOutputContains(result, `Participant 0: ${operator.address} target=${TARGET_GWEI} Gwei`);
    assertOutputContains(result, `Participant 1: ${participant.address} target=${TARGET_GWEI} Gwei`);
    assertOutputContains(result, "Opened in block ");
    assertOutputContains(result, `Funding deadline: ${await fundingDeadline()}`);

    assert.equal(await readPool<number>("state"), 2);
    assert.equal(await readPool<bigint>("fundingAttempt"), 1n);
    assert.equal(
      await readPool<bigint>("fundingRemainingWeiOf", [operator.address]),
      OPERATOR_REMAINING_WEI,
    );
    assert.equal(await readPool<bigint>("fundingRemainingWeiOf", [participant.address]), TARGET_WEI);
  });

  // -------------------------------------------------------------------------
  // 4. The negative sweep, all against a live, fundable pool
  // -------------------------------------------------------------------------

  it("close-expired-funding-attempt refuses before the deadline, pre-broadcast", async () => {
    const result = expectFailure(
      await runCommand({ script: "close-expired-funding-attempt", env: asOperator() }),
    );

    assertActiveSignerPrinted(
      result,
      "close-expired-funding-attempt",
      operator.address.toLowerCase(),
    );
    // The revert is caught at gas estimation, before anything is broadcast, so there is no
    // receipt and no mined transaction — the estimation error IS the expected shape here.
    // The mined-and-reverted branch is exercised separately, further down.
    assertReadableFailure(
      result,
      "close-expired-funding-attempt",
      "Contract error: FundingStillOpen()",
    );
    assertOutputLacks(result, "Closed in block");
    assert.equal(await readPool<number>("state"), 2);
  });

  it("a declared EXPECTED_SIGNER that is not the active one stops the command dead", async () => {
    const result = expectFailure(
      await runCommand({
        script: "fund",
        env: asParticipant({ EXPECTED_SIGNER: outsider.address }),
      }),
    );

    assertReadableFailure(
      result,
      "fund",
      `fund would sign with ${participant.address.toLowerCase()}, not the declared EXPECTED_SIGNER ` +
        outsider.address,
    );
    // It fails inside `assertActiveSigner`, so nothing after it ran: no beacon read, no
    // funding review, and above all no transaction.
    assertOutputLacks(result, "Funding review for pool");
    assertOutputLacks(result, "Funded in block");
  });

  it("a declared EXPECTED_POOL that the record does not name stops the command dead", async () => {
    // `DEPLOYMENT_FILE` selects the record, and a record for a different pool is internally
    // consistent — chain id, immutables, code hashes and runtime code all agree — so this
    // declaration is the only thing that catches it.
    const result = expectFailure(
      await runCommand({
        script: "fund",
        env: asParticipant({ EXPECTED_POOL: outsider.address }),
      }),
    );

    assertOutputContains(result, `Deployment record: ${deploymentFile}`);
    assertReadableFailure(
      result,
      "fund",
      `Deployment record: the deployment record ${deploymentFile} names pool ${pool}, not the ` +
        `declared EXPECTED_POOL ${outsider.address}`,
    );
    // It fails at the head of `assertDeploymentIntegrity`, before any other check runs: no
    // beacon read, no funding review, and no transaction.
    assertOutputLacks(result, "fund beacon");
    assertOutputLacks(result, "Funding review for pool");
    assertOutputLacks(result, "Funded in block");
  });

  it("an excess head balance is refused outright when stdin is not a terminal", async () => {
    const excess = "2000000000";
    const result = await beacon.withScenario(
      () =>
        beacon.setValidator(deposits.pubkey, {
          ...freshPredepositValidator(withdrawalCredentials),
          balanceGwei: excess,
        }),
      () => runCommand({ script: "fund", env: asParticipant() }),
    );

    expectFailure(result);
    // The whole explanation is printed before the refusal, because a refusal without it is
    // just an obstacle.
    assertOutputContains(result, `HEAD BEACON VALIDATOR HAS AN EXCESS BALANCE OF ${excess} Gwei`);
    assertOutputContains(result, "Custody impact: none.");
    assertReadableFailure(
      result,
      "fund",
      `fund excess head beacon balance ${excess} Gwei requires an interactive typed ` +
        "confirmation, but stdin is not a TTY",
    );
    assertOutputLacks(result, "Funded in block");
  });

  it("a malformed beacon field is fatal and names the field", async () => {
    const cases: { malformation: Malformation; actionable: string }[] = [
      {
        malformation: "balance-as-number",
        actionable: "beacon validator balance 1000000000 is not a canonical unsigned decimal string",
      },
      {
        malformation: "syncing-missing-is-optimistic",
        actionable: "beacon node is_optimistic <missing> is not the boolean true or false",
      },
      {
        malformation: "short-withdrawal-credentials",
        actionable: "is not a 32-byte 0x-prefixed hex string",
      },
      {
        malformation: "no-data-envelope",
        actionable: "response has no data field",
      },
    ];

    for (const { malformation, actionable } of cases) {
      const result = await beacon.withScenario(
        (scenario) => {
          scenario.malformation = malformation;
        },
        () => runCommand({ script: "fund", env: asParticipant() }),
      );
      expectFailure(result);
      assertReadableFailure(result, "fund", actionable);
      assertOutputLacks(result, "Funded in block");
    }
  });

  it("a slashed or wrongly-credentialed validator is fatal", async () => {
    const slashed = await beacon.withScenario(
      () =>
        beacon.setValidator(deposits.pubkey, {
          ...freshPredepositValidator(withdrawalCredentials),
          slashed: true,
        }),
      () => runCommand({ script: "fund", env: asParticipant() }),
    );
    expectFailure(slashed);
    // `fund head`, not `fund`: the finalized-state confirmation only compares credentials,
    // so the slashing flag is caught by the head-state preflight that follows it, and the
    // label says which of the two states the finding came from.
    assertReadableFailure(slashed, "fund", "fund head beacon validator is slashed");

    const someoneElsesCredentials = deriveWithdrawalCredentials(outsider.address);
    const wrongCredentials = await beacon.withScenario(
      () =>
        beacon.setValidator(deposits.pubkey, {
          ...freshPredepositValidator(withdrawalCredentials),
          withdrawalCredentials: someoneElsesCredentials,
        }),
      () => runCommand({ script: "fund", env: asParticipant() }),
    );
    expectFailure(wrongCredentials);
    assertReadableFailure(
      wrongCredentials,
      "fund",
      `fund beacon withdrawal_credentials ${someoneElsesCredentials} != pool ${withdrawalCredentials}`,
    );
    assertOutputLacks(wrongCredentials, "Funded in block");
  });

  it("AMOUNT_WEI above the remaining cap is refused before signing", async () => {
    const result = expectFailure(
      await runCommand({
        script: "fund",
        env: asParticipant({ AMOUNT_WEI: (TARGET_WEI + 1n).toString() }),
      }),
    );

    assertReadableFailure(
      result,
      "fund",
      `AMOUNT_WEI exceeds remaining cap: ${TARGET_WEI} wei (16 ETH)`,
    );
    // The refusal happens after the funding review is printed, which is the point: the
    // operator sees the numbers the refusal is about.
    assertOutputContains(result, `Funding review for pool ${pool}`);
    assertOutputContains(result, "State: Funding (2)");
    assertOutputLacks(result, "Funded in block");
    assert.equal(await readPool<bigint>("totalActiveFundedWei"), 0n);
  });

  // -------------------------------------------------------------------------
  // 5. Zero-balance claim and refund
  // -------------------------------------------------------------------------

  it("claim and refund say plainly that they sent nothing, and exit 0", async () => {
    const claim = expectSuccess(await runCommand({ script: "claim", env: asParticipant() }));
    assertActiveSignerPrinted(claim, "claim", participant.address.toLowerCase());
    assertOutputContains(claim, `Claimable for ${participant.address.toLowerCase()}: 0 wei (0 ETH)`);
    assertOutputContains(claim, "Nothing to claim; no transaction was sent.");
    assertOutputLacks(claim, "Claimed to");

    const refund = expectSuccess(await runCommand({ script: "refund", env: asParticipant() }));
    assertActiveSignerPrinted(refund, "refund", participant.address.toLowerCase());
    assertOutputContains(refund, `Refundable for ${participant.address.toLowerCase()}: 0 wei (0 ETH)`);
    assertOutputContains(refund, "Nothing to refund; no transaction was sent.");
    assertOutputLacks(refund, "Refunded to");
  });

  // -------------------------------------------------------------------------
  // 6. Funding, the calldata path
  // -------------------------------------------------------------------------

  it("fund credits a participant over the fund() calldata path", async () => {
    const result = expectSuccess(
      await runCommand({ script: "fund", env: asParticipant({ FUND_VIA_TRANSFER: "0" }) }),
    );

    assertActiveSignerPrinted(result, "fund", participant.address.toLowerCase());
    assertOutputContains(result, `Deposit data file: ${depositDataFile}`);
    assertOutputContains(
      result,
      `Funding ${pool} from ${participant.address.toLowerCase()}: ${TARGET_WEI} wei (16 ETH) via fund() calldata`,
    );
    assertOutputContains(result, "fund head beacon fresh-predeposit preflight passed");
    assertOutputContains(result, "fund pre-broadcast head recheck passed");
    assertOutputContains(
      result,
      `fund credit confirmed from the receipt: the pool emitted ParticipantFunded for ` +
        `${participant.address.toLowerCase()} with exactly ${TARGET_WEI} wei (16 ETH)`,
    );
    assertOutputContains(result, "Funded in block ");

    assert.equal(await readPool<bigint>("activeFundedWeiOf", [participant.address]), TARGET_WEI);
    assert.equal(await readPool<bigint>("fundingRemainingWeiOf", [participant.address]), 0n);
  });

  // -------------------------------------------------------------------------
  // 7. The mined-and-reverted branch
  // -------------------------------------------------------------------------

  it("a funding transaction mined after the deadline is reported as a reverted receipt", async () => {
    // Everything up to broadcast passes: the pool is open, the caller has an allocation, and
    // the beacon state is fresh. The deadline is crossed AFTER the transaction is in the
    // mempool and BEFORE the block that includes it, which is the one arrangement that
    // reaches `waitForSenderVerifiedReceipt`'s status branch — with automine on, the node
    // rejects a failing transaction at send and nothing is ever mined.
    const deadline = await fundingDeadline();
    await chain.setAutomine(false);
    try {
      const pending = runCommand({
        script: "fund",
        env: asOperator({ FUND_VIA_TRANSFER: "0", AMOUNT_WEI: OPERATOR_REMAINING_WEI.toString() }),
      });
      await chain.waitForPendingTransactions(1);
      await chain.setNextBlockTimestamp(deadline + 1n);
      await chain.mine();
      const result = expectFailure(await pending);

      assertActiveSignerPrinted(result, "fund", operator.address.toLowerCase());
      assertReadableFailure(result, "fund", "was mined but REVERTED (receipt status reverted)");
      assertOutputContains(result, 'Run "npm run status" to read the pool\'s actual state');
      assertOutputLacks(result, "Funded in block");
      assertOutputLacks(result, "credit confirmed from the receipt");
    } finally {
      await chain.setAutomine(true);
    }

    // The operator's 15 ETH never landed, and the participant's 16 ETH is now stranded in an
    // expired attempt.
    assert.equal(await readPool<bigint>("activeFundedWeiOf", [operator.address]), 0n);
    assert.equal(await readPool<bigint>("totalActiveFundedWei"), TARGET_WEI);
  });

  // -------------------------------------------------------------------------
  // 8. Closing the expired attempt, and refunding out of it
  // -------------------------------------------------------------------------

  it("close-expired-funding-attempt converts active funding into refund claims", async () => {
    const result = expectSuccess(
      await runCommand({ script: "close-expired-funding-attempt", env: asOperator() }),
    );

    assertActiveSignerPrinted(
      result,
      "close-expired-funding-attempt",
      operator.address.toLowerCase(),
    );
    assertOutputContains(result, `Closing expired funding attempt for ${pool}`);
    assertOutputContains(result, "Closed in block ");

    assert.equal(await readPool<number>("state"), 1);
    assert.equal(await readPool<bigint>("refundableWeiOf", [participant.address]), TARGET_WEI);
  });

  it("refund pays out a real refundable balance", async () => {
    const before = await chain.publicClient.getBalance({ address: participant.address });
    const result = expectSuccess(await runCommand({ script: "refund", env: asParticipant() }));

    assertActiveSignerPrinted(result, "refund", participant.address.toLowerCase());
    assertOutputContains(
      result,
      `Refundable for ${participant.address.toLowerCase()}: ${TARGET_WEI} wei (16 ETH)`,
    );
    assertOutputContains(result, `Refunded to ${participant.address.toLowerCase()} in block `);

    assert.equal(await readPool<bigint>("refundableWeiOf", [participant.address]), 0n);
    const after = await chain.publicClient.getBalance({ address: participant.address });
    assert.ok(
      after > before + TARGET_WEI - parseEther("0.01"),
      `refund did not move 16 ETH: ${before} -> ${after}`,
    );
  });

  // -------------------------------------------------------------------------
  // 9. A second attempt, funded to completion over both paths
  // -------------------------------------------------------------------------

  it("open-funding-attempt reopens after a closed attempt", async () => {
    const result = expectSuccess(
      await runCommand({
        script: "open-funding-attempt",
        env: asOperator({
          PARTICIPANTS: `${operator.address},${participant.address}`,
          FUNDING_TARGETS_GWEI: `${TARGET_GWEI}, ${TARGET_GWEI}`,
        }),
      }),
    );

    assertOutputContains(result, "Opened in block ");
    assert.equal(await readPool<bigint>("fundingAttempt"), 2n);
    assert.equal(await readPool<number>("state"), 2);
  });

  it("fund credits a participant over the plain-transfer path too", async () => {
    const result = expectSuccess(
      await runCommand({ script: "fund", env: asParticipant({ FUND_VIA_TRANSFER: "1" }) }),
    );

    assertOutputContains(
      result,
      `Funding ${pool} from ${participant.address.toLowerCase()}: ${TARGET_WEI} wei (16 ETH) ` +
        `via plain transfer (zero calldata)`,
    );
    // The receipt's own logs, not the receipt's status, are what say the transfer was
    // credited rather than accepted as proceeds.
    assertOutputContains(
      result,
      `fund credit confirmed from the receipt: the pool emitted ParticipantFunded for ` +
        `${participant.address.toLowerCase()} with exactly ${TARGET_WEI} wei (16 ETH)`,
    );
    assertOutputContains(result, "Funded in block ");
    assert.equal(await readPool<bigint>("activeFundedWeiOf", [participant.address]), TARGET_WEI);
  });

  it("fund completes the operator's own allocation, net of the predeposit credit", async () => {
    const result = expectSuccess(
      await runCommand({ script: "fund", env: asOperator({ FUND_VIA_TRANSFER: "0" }) }),
    );

    // No AMOUNT_WEI: the default is the whole remaining cap, which for the operator is the
    // target less the 1 ETH predeposit already credited.
    assertOutputContains(
      result,
      `Funding ${pool} from ${operator.address.toLowerCase()}: ${OPERATOR_REMAINING_WEI} wei (15 ETH) ` +
        `via fund() calldata`,
    );
    assertOutputContains(result, "Funded in block ");
    assert.equal(await readPool<bigint>("totalActiveFundedWei"), TOP_UP_WEI);
  });

  // -------------------------------------------------------------------------
  // 10. top-up
  // -------------------------------------------------------------------------

  it("top-up refuses a deposit-data file that is not about the committed validator", async () => {
    // `committedPubkey()` comes from the EL RPC, and the beacon preflight decides on
    // whatever pubkey it is handed. Without a local value to compare it against, a wrong or
    // dishonest endpoint chooses which validator gets checked. The deposit-data file is that
    // local value.
    const otherValidatorFile = path.join(workdir, "deposit-data-other-validator.json");
    const otherValidator = buildDepositData(11, withdrawalCredentials, GENESIS_FORK_VERSION as Hex);
    writeDepositDataFile(otherValidatorFile, otherValidator);

    const result = expectFailure(
      await runCommand({
        script: "top-up",
        env: asOperator({ DEPOSIT_DATA_FILE: otherValidatorFile }),
      }),
    );

    // The printed path is what makes this diagnosable: the failure names two pubkeys, and the
    // line above it names the file the second one came from.
    assertOutputContains(result, `Deposit data file: ${otherValidatorFile}`);
    assertReadableFailure(
      result,
      "top-up",
      `top-up: the pool reports committedPubkey ${deposits.pubkey}, but the local deposit-data ` +
        `file's 1 ETH predeposit entry is for ${otherValidator.pubkey}`,
    );
    // It fails before the preflight, so the other validator is never the subject of a single
    // beacon read, and no transaction is sent.
    assertOutputLacks(result, "top-up beacon");
    assertOutputLacks(result, "Topped up in block");
    assert.equal(await readPool<boolean>("topUpSubmitted"), false);
  });

  it("top-up submits the 31 ETH deposit", async () => {
    const result = expectSuccess(await runCommand({ script: "top-up", env: asOperator() }));

    assertActiveSignerPrinted(result, "top-up", operator.address.toLowerCase());
    assertOutputContains(result, `Deposit data file: ${depositDataFile}`);
    assertOutputContains(result, `Submitting 31 ETH top-up through ${pool}`);
    assertOutputContains(result, `Validator pubkey: ${deposits.pubkey}`);
    assertOutputContains(result, "top-up head beacon fresh-predeposit preflight passed");
    assertOutputContains(result, "top-up pre-broadcast head recheck passed");
    assertOutputContains(result, "Topped up in block ");

    assert.equal(await readPool<number>("state"), 3);
    assert.equal(await readPool<boolean>("topUpSubmitted"), true);
    assert.equal(
      await chain.publicClient.getBalance({ address: DEPOSIT_CONTRACT_ADDRESS }),
      PREDEPOSIT_WEI + TOP_UP_WEI,
    );
  });

  // -------------------------------------------------------------------------
  // 11. status, with no private key anywhere
  // -------------------------------------------------------------------------

  it("status reads the pool on the read-only network with no PRIVATE_KEY set", async () => {
    const env = {
      RPC_URL: chain.url,
      DEPLOYMENT_FILE: deploymentFile,
      // Named explicitly rather than merely omitted: this is the Ledger-only operator's
      // case, and the `read` network exists because the `rpc` network cannot answer a single
      // `eth_call` without a resolvable PRIVATE_KEY.
      PRIVATE_KEY: undefined,
    };
    const result = expectSuccess(await runCommand({ script: "status", network: "read", env }));

    // `status` signs nothing, so the record path is the only thing it prints about where it
    // is looking. It is printed there too.
    assertOutputContains(result, `Deployment record: ${deploymentFile}`);
    assertOutputContains(result, `Pool: ${pool}`);
    assertOutputContains(result, "State: ToppedUp (3)");
    assertOutputContains(result, `Operator: ${operator.address}`);
    assertOutputContains(result, "Funding attempt: 2");
    assertOutputContains(result, `Validator pubkey: ${deposits.pubkey}`);
    assertOutputContains(result, "Top-up submitted: true");
    assertOutputContains(result, "Fee recipient forwarder: not configured");
    // `status` signs nothing, so it is the one command with no active-signer line to print.
    assertOutputLacks(result, "active signer:");
  });

  it("claim after top-up reports nothing claimable while the pool holds no proceeds", async () => {
    const result = expectSuccess(await runCommand({ script: "claim", env: asOperator() }));
    assertOutputContains(result, `Claimable for ${operator.address.toLowerCase()}: 0 wei (0 ETH)`);
    assertOutputContains(result, "Nothing to claim; no transaction was sent.");
    assertOutputLacks(result, "Claimed to");
  });

  // -------------------------------------------------------------------------
  // 12. request-exit, against the real EIP-7002 predeploy
  // -------------------------------------------------------------------------

  it("request-exit sends a full-exit request once the validator is exit-eligible", async () => {
    // The fee comes from the real predeploy runtime, not a mock: `currentExitRequestFee`
    // staticcalls it with empty calldata and requires exactly 32 bytes back, and
    // `requestExit` forwards the live fee and refunds the rest in the same transaction.
    const fee = await readPool<bigint>("currentExitRequestFee");
    assert.ok(fee > 0n, "the EIP-7002 predeploy reported a zero fee");

    const belowFee = await beacon.withScenario(
      () => beacon.setValidator(deposits.pubkey, activeValidator(withdrawalCredentials)),
      () =>
        runCommand({ script: "request-exit", env: asOperator({ MAX_FEE_WEI: (fee - 1n).toString() }) }),
    );
    expectFailure(belowFee);
    assertReadableFailure(
      belowFee,
      "request-exit",
      `MAX_FEE_WEI ${formatWei(fee - 1n)} is below the current EIP-7002 fee ${formatWei(fee)}`,
    );
    assertOutputLacks(belowFee, "Exit requested in block");
    assert.equal(await readPool<bigint>("exitRequestAttemptCount"), 0n);

    const result = await beacon.withScenario(
      () => beacon.setValidator(deposits.pubkey, activeValidator(withdrawalCredentials)),
      () => runCommand({ script: "request-exit", env: asOperator() }),
    );

    expectSuccess(result);
    assertActiveSignerPrinted(result, "request-exit", operator.address.toLowerCase());
    assertOutputContains(result, "request-exit beacon exit preflight passed");
    assertOutputContains(result, "request-exit beacon SHARD_COMMITTEE_PERIOD: 256");
    assertOutputContains(result, `Requesting full exit for ${deposits.pubkey}`);
    assertOutputContains(result, `EIP-7002 fee: ${fee} wei`);
    assertOutputContains(result, "Exit requested in block ");

    assert.equal(await readPool<bigint>("exitRequestAttemptCount"), 1n);
    assert.equal(await readPool<bigint>("lastExitRequestFeePaid"), fee);
  });

  // -------------------------------------------------------------------------
  // 13. The ToppedUp plain-transfer race, on a pool of its own
  // -------------------------------------------------------------------------

  it("a plain transfer that lands after the pool tops up is reported as uncredited", async () => {
    // The scenario `SECURITY.md` §5 calls "the `ToppedUp` plain-transfer race". Every
    // pre-broadcast check passes against a pool that is still `Funding`; the pool reaches
    // `ToppedUp` before the transfer is mined; the transfer succeeds and is accepted as pool
    // proceeds instead of being credited. Only the receipt's own logs tell the two apart.
    //
    // It needs a pool of its own, because reproducing it consumes one: the funding that
    // completes the attempt and the top-up that follows both have to be sent by the harness,
    // in the same block as the command's transfer and ahead of it.
    const raceDeploymentFile = path.join(workdir, "deployment-race.json");
    const raceDepositDataFile = path.join(workdir, "deposit-data-race.json");
    const raceEnv = (extra: Record<string, string | undefined> = {}) => ({
      RPC_URL: chain.url,
      BEACON_NODE_URL: beacon.url,
      DEPLOYMENT_FILE: raceDeploymentFile,
      DEPOSIT_DATA_FILE: raceDepositDataFile,
      PRIVATE_KEY: operator.privateKey,
      ...extra,
    });

    expectSuccess(
      await runCommand({
        script: "deploy",
        env: {
          RPC_URL: chain.url,
          PRIVATE_KEY: operator.privateKey,
          DEPLOYMENT_FILE: raceDeploymentFile,
        },
      }),
    );
    const raceRecord = JSON.parse(readFileSync(raceDeploymentFile, "utf8")) as DeploymentRecord;
    const racePool = raceRecord.pool;
    const raceCredentials = deriveWithdrawalCredentials(racePool);
    const raceDeposits = buildDepositData(8, raceCredentials, GENESIS_FORK_VERSION as Hex);
    writeDepositDataFile(raceDepositDataFile, raceDeposits);
    beacon.setValidator(raceDeposits.pubkey, absentValidator());

    expectSuccess(await runCommand({ script: "commit-predeposit", env: raceEnv() }));
    beacon.setValidator(raceDeposits.pubkey, freshPredepositValidator(raceCredentials));

    // No PARTICIPANTS and no FUNDING_TARGETS_GWEI: the default single-participant attempt,
    // operator at the full 32 ETH target.
    const opened = expectSuccess(
      await runCommand({ script: "open-funding-attempt", env: raceEnv() }),
    );
    assertOutputContains(opened, `Participant 0: ${operator.address} target=32000000000 Gwei`);

    const wallet = chain.walletFor(operator);
    const nonce = await chain.publicClient.getTransactionCount({ address: operator.address });
    await chain.setAutomine(false);
    try {
      // Both are queued before the command runs, so the command's own transaction takes the
      // next nonce after them and the node includes all three in one block, in nonce order.
      await wallet.writeContract({
        address: racePool,
        abi: POOL_ABI,
        functionName: "fund",
        value: TOP_UP_WEI,
        nonce,
        gas: 300_000n,
        account: operator.account,
        chain: chain.chain,
      });
      await wallet.writeContract({
        address: racePool,
        abi: POOL_ABI,
        functionName: "topUpValidator",
        nonce: nonce + 1,
        gas: 400_000n,
        account: operator.account,
        chain: chain.chain,
      });
      await chain.waitForPendingTransactions(2);

      const donation = parseEther("1");
      const pending = runCommand({
        script: "fund",
        env: raceEnv({ FUND_VIA_TRANSFER: "1", AMOUNT_WEI: donation.toString() }),
      });
      await chain.waitForPendingTransactions(3);
      await chain.mine();
      const result = expectFailure(await pending);

      assertOutputContains(
        result,
        `Funding ${racePool} from ${operator.address.toLowerCase()}: ${donation} wei (1 ETH) ` +
          `via plain transfer (zero calldata)`,
      );
      assertReadableFailure(
        result,
        "fund",
        `FATAL: fund transaction succeeded but the ${donation} wei (1 ETH) it sent was NOT ` +
          `credited as funding`,
      );
      assertOutputContains(
        result,
        `the pool emitted EthReceivedViaCall for ${operator.address.toLowerCase()}`,
      );
      assertOutputContains(result, "The ETH was accepted as POST-TOP-UP PROCEEDS");
      assertOutputLacks(result, "Funded in block");
      assertOutputLacks(result, "credit confirmed from the receipt");
    } finally {
      await chain.setAutomine(true);
    }

    // And the receipt was right: the pool is topped up and holds the 1 ETH as proceeds.
    const state = (await chain.publicClient.readContract({
      address: racePool,
      abi: POOL_ABI,
      functionName: "state",
    })) as number;
    assert.equal(state, 3);
    assert.equal(
      await chain.publicClient.getBalance({ address: racePool }),
      parseEther("1"),
    );
  });
});
