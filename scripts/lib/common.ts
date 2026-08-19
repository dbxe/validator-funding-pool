import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { PublicKey, Signature, verify } from "@chainsafe/blst";
import { DOMAIN_DEPOSIT } from "@lodestar/params";
import { ssz } from "@lodestar/types";
import {
  decodeEventLog,
  formatEther,
  isAddress,
  keccak256,
  type AccessList,
  type Address,
  type Hex,
  type PublicClient,
  type SignedAuthorizationList,
  type Transaction,
  type TransactionType,
} from "viem";

export const DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const DEFAULT_DEPOSIT_CONTRACT: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const DEFAULT_DEPOSIT_DATA_FILE = "deposit-data.json";
export const PREDEPOSIT_GWEI = 1_000_000_000n;
export const TOP_UP_GWEI = 31_000_000_000n;
export const VALIDATOR_DEPOSIT_GWEI = 32_000_000_000n;
export const PREDEPOSIT_WEI = PREDEPOSIT_GWEI * 1_000_000_000n;
export const VALIDATOR_DEPOSIT_WEI = VALIDATOR_DEPOSIT_GWEI * 1_000_000_000n;
const ZERO_ROOT = `0x${"00".repeat(32)}` as Hex;
/// The settled state the credential confirmation reads, before the same credentials are
/// re-confirmed at head. Fixed, with no environment variable behind it.
///
/// It used to be selectable through `BEACON_CONFIRMATION_STATE_ID`, restricted to
/// `finalized` or `justified`. The only thing that flag ever bought over the default was
/// `justified` — roughly one epoch, some six minutes of freshness — on a confirmation that
/// happens once per validator lifecycle and is followed by a head read anyway. That is not
/// worth a variable on the security surface: every configurable input is one more thing an
/// auditor has to reason about, and one more thing an operator can be talked into setting.
const CONFIRMATION_STATE_ID = "finalized";
const HEAD_STATE_ID = "head";
const UINT64_MAX = 2n ** 64n - 1n;
const FAR_FUTURE_EPOCH = UINT64_MAX.toString();
const CANONICAL_UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const BEACON_EPOCH_FIELDS = [
  "activation_eligibility_epoch",
  "activation_epoch",
  "exit_epoch",
  "withdrawable_epoch",
] as const;

export interface DepositData {
  pubkey: string;
  withdrawal_credentials: string;
  amount: string | number;
  signature: string;
  deposit_data_root: string;
  fork_version?: string;
  network_name?: string;
}

export interface DeploymentRecord {
  chainId: number;
  pool: Address;
  depositContract: Address;
  depositContractCodeHash: Hex;
  withdrawalRequestPredeploy: Address;
  withdrawalRequestPredeployCodeHash: Hex;
  operator: Address;
  fundingWindowDuration: string;
  withdrawalCredentials: Hex;
  feeRecipientForwarder?: Address;
}

export interface PoolDeploymentConfig {
  depositContract: Address;
  withdrawalRequestPredeploy: Address;
  operator: Address;
  withdrawalCredentials: Hex;
  fundingWindowDuration: bigint;
}

interface BeaconValidatorResponse {
  data: {
    index: string;
    balance: string;
    status: string;
    validator: {
      pubkey: string;
      withdrawal_credentials: string;
      effective_balance: string;
      slashed: boolean;
      activation_eligibility_epoch: string;
      activation_epoch: string;
      exit_epoch: string;
      withdrawable_epoch: string;
    };
  };
}

/// `is_optimistic` and `el_offline` are required, not optional. The preflight refuses to
/// rely on an optimistic head or on a node whose execution client is offline, so a
/// response that simply omits either field must be fatal rather than read as healthy.
interface BeaconSyncingResponse {
  data: {
    head_slot: string;
    sync_distance: string;
    is_syncing: boolean;
    is_optimistic: boolean;
    el_offline: boolean;
  };
}

interface BeaconGenesisResponse {
  data: {
    genesis_time: string;
    genesis_validators_root: string;
    genesis_fork_version: string;
  };
}

interface BeaconFinalityCheckpointsResponse {
  data: {
    previous_justified: { epoch: string; root: string };
    current_justified: { epoch: string; root: string };
    finalized: { epoch: string; root: string };
  };
}

interface BeaconSpecResponse {
  data: Record<string, string>;
}

interface BeaconDepositContractResponse {
  data: {
    chain_id: string;
    address: string;
  };
}

interface BeaconValidatorPreflight {
  stateId: string;
  genesis: BeaconGenesisResponse["data"];
  syncing: BeaconSyncingResponse["data"];
  finality: BeaconFinalityCheckpointsResponse["data"];
  validator: BeaconValidatorResponse["data"];
}

interface PoolDeploymentReader {
  read: {
    depositContract: () => Promise<Address>;
    withdrawalRequestPredeploy: () => Promise<Address>;
    operator: () => Promise<Address>;
    withdrawalCredentials: () => Promise<Hex>;
    fundingWindowDuration: () => Promise<bigint>;
  };
}

interface SystemCodeReader {
  getCode: (args: { address: Address }) => Promise<Hex | undefined>;
}

type DeploymentPublicClient = Pick<PublicClient, "getChainId" | "getCode" | "readContract">;

interface FeeRecipientForwarderReader {
  address: Address;
  read: {
    pool: () => Promise<Address>;
  };
}

interface CanonicalSystemContracts {
  depositContract: Address;
  depositContractCodeHash: Hex;
  withdrawalRequestPredeploy: Address;
  withdrawalRequestPredeployCodeHash: Hex;
}

// Canonical mainnet system contracts.
//
// These hashes are PINS, not observations. They are what live chain state must match, derived
// independently of any RPC endpoint, and they are the only thing separating a canonicity check
// from the weaker record-to-pool consistency check performed alongside it.
//
// Provenance and how to re-derive:
//
//   depositContractCodeHash
//     keccak256 of the runtime bytecode produced by deploying the creation bytecode in
//     consensus-specs solidity_deposit_contract/deposit_contract.json (v1.6.1, 5fa6edcca).
//     Deploy it on a local chain, read eth_getCode, keccak256 the result. Runtime is 6358 bytes.
//
//   withdrawalRequestPredeployCodeHash
//     keccak256 of the 504-byte EIP-7002 predeploy runtime shipped in go-ethereum v1.17.5
//     (9621c6ad1), cmd/devp2p/internal/ethtest/testdata/genesis.json, which matches
//     headstate.json byte-for-byte. Unchanged since v1.17.3.
//
// If assertDeploymentCanonicity fails, the pool is wired to a non-canonical system contract.
// That is the finding, and it is exactly what this table exists to surface. Do NOT update these
// constants to match what is observed on chain: doing so silently downgrades the canonicity pin
// to a consistency check and defeats the layer entirely. Re-derive from the sources above and
// change a value only when the upstream artifact itself has changed.
const CANONICAL_SYSTEM_CONTRACTS: Readonly<Record<number, CanonicalSystemContracts>> = {
  1: {
    depositContract: DEFAULT_DEPOSIT_CONTRACT,
    depositContractCodeHash: "0x6c029a231254fadb724d63be769f75eedd66362df034a3e663252b49d062a666",
    withdrawalRequestPredeploy: DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
    withdrawalRequestPredeployCodeHash:
      "0x0345a365d2f4c5975b9f1599abe0a2ee76b7a3a731bc68781bd04c84e4858f50",
  },
};

/// Minimal view of a resolved `network.create()` connection. Scripts pass the whole
/// connection; only these two fields are read.
export interface SignerConnection {
  networkName: string;
  networkConfig: { ledgerAccounts?: readonly string[] };
}

/// The receipt fields every post-broadcast check reads. `status` is `"success"` or
/// `"reverted"`; viem derives it from the receipt's `status` field
/// (`node_modules/viem/_esm/utils/formatters/transactionReceipt.js` lines 5-8 and 33-35).
interface SenderVerifiedReceipt {
  from: Address;
  blockNumber: bigint;
  status: "success" | "reverted";
}

/// The transaction fields the replacement policy compares. A subset of viem's
/// `Transaction`, so a real client's `onReplaced` payload satisfies it structurally.
///
/// It is EVERY non-fee semantic field viem's transaction objects carry, at the locked viem
/// 2.49.3 (`node_modules/viem/_types/types/transaction.d.ts`). `TransactionBase` (lines
/// 51-83) contributes `to`, `value`, and `input`; the five per-type variants (lines 84-129,
/// unioned into `Transaction` at line 130) each add `type` and exactly three further
/// semantic fields, present on some types and `?: undefined` on the rest — `accessList`
/// (eip2930, eip1559, eip4844, eip7702), `blobVersionedHashes` (eip4844), and
/// `authorizationList` (eip7702, `SignedAuthorizationList` from
/// `types/authorization.d.ts`).
///
/// That claim is not left to this comment: the block below compiles it against viem's own
/// types, and a field a future viem adds fails `npm run typecheck` rather than passing this
/// policy uncompared.
///
/// Everything on those types that is NOT compared is one of: a fee value (`gas`,
/// `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `maxFeePerBlobGas`, from the
/// `FeeValues*` mixins), a signature (`r`, `s`, `v`, `yParity`), inclusion metadata
/// (`blockHash`, `blockNumber`, `blockTimestamp`, `transactionIndex`, `hash`), the sender
/// and the nonce (identical by construction — viem locates the replacement by matching
/// `from` and `nonce`), `typeHex` (the hex spelling of `type`), or `chainId` (the chain
/// this client is watching, identical for both transactions by construction). A reprice may
/// change the fee values and, through them, the signature and the hash. It may change
/// nothing else.
interface ObservedTransaction {
  hash: Hex;
  to: Address | null;
  value: bigint;
  input: Hex;
  type?: TransactionType | undefined;
  accessList?: AccessList | undefined;
  blobVersionedHashes?: readonly Hex[] | undefined;
  authorizationList?: SignedAuthorizationList | undefined;
}

// ---------------------------------------------------------------------------
// Replacement-check exhaustiveness
//
// The comment above is a claim about a THIRD-PARTY type: that `ObservedTransaction`'s
// compared fields are every non-fee semantic field viem's `Transaction` carries. It was
// true when it was written and checked by hand. A viem release that adds a field to a
// transaction variant — a new transaction type's payload, the way EIP-4844 added
// `blobVersionedHashes` and EIP-7702 added `authorizationList` — would make it silently
// false, and the failure mode is the one this whole policy exists to prevent: a
// same-nonce substitute differing in exactly that field, compared on nothing, and
// reported as an acceptable reprice.
//
// So the claim is compiled instead of asserted in prose. The declarations below
// derive the union of keys across every variant of viem's `Transaction`, subtract an
// explicit allowlist of keys that are deliberately not compared, and require the
// remainder to be EXACTLY what `differingSemanticFields` compares. A new field in a
// future viem lands in neither set and fails `npm run typecheck`, naming itself, which
// forces the decision — compare it, or add it to the allowlist with a reason — to be
// made by a person.
// ---------------------------------------------------------------------------

/// `keyof` a union is the INTERSECTION of its members' keys. The distributive conditional
/// is what turns it into the union, which is what exhaustiveness needs: a field present on
/// one transaction type and absent from the rest must still be accounted for.
type UnionKeys<T> = T extends unknown ? keyof T : never;

/// Every key of viem's `Transaction` that the replacement policy deliberately does not
/// compare, with the reason it is exempt. Anything not on this list must be compared.
///
///   `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `maxFeePerBlobGas`
///     The price. Changing it is the definition of a reprice — the one substitution this
///     policy accepts — so comparing these would reject every acceptable case.
///
///   `r`, `s`, `v`, `yParity`
///     The signature. A repriced transaction is signed afresh over different fee values,
///     so these differ on every legitimate reprice.
///
///   `hash`
///     Derived from everything else, signature included, so it differs on every reprice.
///     It is carried on `ObservedTransaction` to be PRINTED — the mined hash is what the
///     operator needs to look the transaction up — and never compared.
///
///   `blockHash`, `blockNumber`, `blockTimestamp`, `transactionIndex`
///     Inclusion metadata, decided by the block that included the transaction and not by
///     what was signed. The replaced transaction was never included at all.
///
///   `from`, `nonce`
///     Identical by construction: viem locates the replacement by matching `from` and
///     `nonce` against the transaction being waited on
///     (`waitForTransactionReceipt.js` line 157), so a payload reaching this policy with
///     either one different cannot exist. `receipt.from` is separately required to equal
///     the intended signer in `waitForSenderVerifiedReceipt`, which is the check that
///     actually defends the sender.
///
///   `typeHex`
///     The hex spelling of `type`, which IS compared. Comparing both would report one
///     difference twice.
///
///   `chainId`
///     The chain this client is watching. Both transactions come from the same client's
///     view of the same chain, and `assertDeploymentChain` pins that chain against the
///     deployment record on every command.
type UncomparedTransactionKeys =
  | "gas"
  | "gasPrice"
  | "maxFeePerGas"
  | "maxPriorityFeePerGas"
  | "maxFeePerBlobGas"
  | "r"
  | "s"
  | "v"
  | "yParity"
  | "hash"
  | "blockHash"
  | "blockNumber"
  | "blockTimestamp"
  | "transactionIndex"
  | "from"
  | "nonce"
  | "typeHex"
  | "chainId";

/// What viem's transaction union carries that is not on the allowlist: the fields a
/// replacement is not allowed to change.
type SemanticTransactionKeys = Exclude<UnionKeys<Transaction>, UncomparedTransactionKeys>;

/// What `differingSemanticFields` actually compares. `hash` is on `ObservedTransaction` for
/// printing only, so it is excluded here and, correspondingly, allowlisted above.
type ComparedTransactionKeys = Exclude<keyof ObservedTransaction, "hash">;

/// Fails to compile unless `T` is empty, naming the members that are not.
type MustBeEmpty<T extends never> = T;

/// A semantic field viem's `Transaction` has that `ObservedTransaction` does not compare.
/// If this line fails, a substitution could change that field and still be accepted as a
/// reprice: add it to `ObservedTransaction` and to `differingSemanticFields`, or — if it is
/// genuinely a fee, a signature, or inclusion metadata — to `UncomparedTransactionKeys`
/// with the reason written down.
type _NoUncomparedSemanticField = MustBeEmpty<
  Exclude<SemanticTransactionKeys, ComparedTransactionKeys>
>;

/// The converse: a field this policy compares that viem's `Transaction` no longer has.
/// Such a comparison is dead code and its mention in the error messages is a lie about
/// what was checked.
type _NoComparedFieldMissingFromViem = MustBeEmpty<
  Exclude<ComparedTransactionKeys, SemanticTransactionKeys>
>;

/// The `onReplaced` payload, narrowed to what the policy below decides on.
/// `transactionReceipt` is deliberately absent: viem resolves the promise with the very
/// same receipt object it passes here (`waitForTransactionReceipt.js` lines 181-189), so
/// the resolved value is already the replacement's receipt and a second copy would only
/// invite the two to be confused.
interface ObservedReplacement {
  reason: string;
  replacedTransaction: ObservedTransaction;
  transaction: ObservedTransaction;
}

/// Hostnames whose traffic never leaves the machine, so plaintext HTTP to them is not on
/// any wire an observer can sit on. `URL.hostname` keeps the brackets for an IPv6 literal.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/// Warns, loudly, when either endpoint is plaintext `http:` to a non-loopback host.
///
/// Not fatal: a node on the operator's own LAN over plain HTTP is a legitimate and common
/// setup, and refusing it would push people toward worse workarounds. But `SECURITY.md` §2
/// describes what a dishonest endpoint can do — lie about validator state, lie about pool
/// state, and on the plain-transfer path turn one ordinary funding transfer into a donation
/// — and over plaintext that entire capability belongs to anyone on the path, not just to
/// whoever runs the endpoint. TLS is what limits it to the operator of the URL.
export function warnOnPlaintextEndpoints() {
  for (const name of ["RPC_URL", "BEACON_NODE_URL"] as const) {
    const value = process.env[name];
    if (value === undefined || value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // Not this function's business: whatever consumes the value fails on it there.
      continue;
    }
    if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) continue;
    console.warn(
      `\nWARNING: ${name} is plaintext http:// to ${url.hostname}, which is not loopback.\n` +
        `  Anyone on the network path — not merely whoever runs that endpoint — can read every ` +
        `request and rewrite every response.\n` +
        `  That is the full lying-endpoint capability described in SECURITY.md §2: false ` +
        `validator state, false pool state, and on the plain-transfer funding path a single ` +
        `ordinary transfer turned into a donation.\n` +
        `  Use https://, or a node reached over loopback or an SSH tunnel.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command failure presentation
//
// Every command ends in `main().catch(...)`. What that catch prints is the last
// thing an operator reads about a capital operation that did not happen, and it
// used to be `console.error(error)` on a viem error object: 566 lines of ABI and
// stack frames with `Error: FundingStillOpen()` on line 13. The one actionable
// line was there; nobody was going to find it.
//
// So the catch path is shared, and it prints the walked cause chain's short
// messages instead. Nothing is hidden: `DEBUG=1` restores the complete object,
// and the exit code is unchanged either way. Errors this codebase raises itself
// are printed in full, because their whole text is the guidance.
// ---------------------------------------------------------------------------

/// How far down `cause` the description walks. viem nests three to four levels
/// (`ContractFunctionExecutionError` -> `ContractFunctionRevertedError` ->
/// `TransactionExecutionError` -> `RpcRequestError`); the bound is there so a cyclic or
/// pathological chain cannot turn the summary back into a wall of text.
const MAX_ERROR_CAUSE_DEPTH = 8;

/// Set to `1` or `true` to get the raw error object back.
const FULL_ERROR_DUMP_ENV = "DEBUG";

export function fullErrorDumpRequested(): boolean {
  const value = process.env[FULL_ERROR_DUMP_ENV];
  return value === "1" || value === "true";
}

/// The fields viem's error classes carry that say what actually failed. Structural rather
/// than an import of viem's `BaseError`, because the chain also contains plain `Error`s
/// raised by this file and by node's fetch, and every level is described the same way.
interface DescribableError {
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  reason?: unknown;
  signature?: unknown;
  data?: unknown;
  functionName?: unknown;
  contractAddress?: unknown;
  sender?: unknown;
  cause?: unknown;
}

/// Reduces an error, and everything it was caused by, to the lines worth reading.
///
/// Exported for the tests, which assert on the shape rather than on a screenful of output.
export function describeFatalError(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; ++depth) {
    if (current === undefined || current === null) break;
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    for (const line of describeOneError(current)) appendUnlessPresent(lines, line);
    if (typeof current !== "object") break;
    current = (current as DescribableError).cause;
  }

  if (lines.length === 0) appendUnlessPresent(lines, String(error));
  return hoistDecodedRevert(lines);
}

/// Moves the decoded revert — the custom error name, or the revert string — directly under
/// the first line.
///
/// viem splits one failure across the cause chain: the outer error names the function that
/// reverted, and the level below it holds the decoded `errorName`. Described in chain order,
/// `InvalidState()` therefore lands beneath the call context, which is the wrong way round.
/// The name of the error is what the operator is looking for.
function hoistDecodedRevert(lines: string[]): string[] {
  const isDecodedRevert = (line: string) =>
    line.startsWith("Contract error: ") || line.startsWith("Revert reason: ");
  const decoded = lines.filter(isDecodedRevert);
  if (decoded.length === 0) return lines;
  const rest = lines.filter((line) => !isDecodedRevert(line));
  return [...rest.slice(0, 1), ...decoded, ...rest.slice(1)];
}

function describeOneError(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [String(error)];
  const described = error as DescribableError;
  const lines: string[] = [];

  // viem's `shortMessage` is the one-line form of a message whose long form carries the
  // ABI. An error without one is this codebase's own, or node's: its `message` IS the
  // actionable text and is printed whole.
  if (typeof described.shortMessage === "string" && described.shortMessage !== "") {
    lines.push(...described.shortMessage.split("\n"));
  } else if (typeof described.message === "string" && described.message !== "") {
    lines.push(...described.message.split("\n"));
  }

  const customError = describeCustomError(described.data);
  if (customError !== undefined) lines.push(`Contract error: ${customError}`);
  if (typeof described.reason === "string" && described.reason !== "") {
    lines.push(`Revert reason: ${described.reason}`);
  }
  if (typeof described.signature === "string" && described.signature !== "") {
    lines.push(`Revert signature: ${described.signature}`);
  }
  if (typeof described.functionName === "string" && described.functionName !== "") {
    const address = typeof described.contractAddress === "string" ? described.contractAddress : "<unknown>";
    lines.push(`Contract call: ${described.functionName}() at ${address}`);
    if (typeof described.sender === "string" && described.sender !== "") {
      lines.push(`Sender: ${described.sender}`);
    }
  }
  if (typeof described.details === "string" && described.details !== "") {
    lines.push(`Details: ${described.details}`);
  }

  return lines.filter((line) => line.trim() !== "");
}

/// Renders a decoded custom error as it is declared in the contract, arguments included.
/// `ExitFeeTooHigh(fee, maxFee)` says which fee was too high; `ExitFeeTooHigh` alone does
/// not.
function describeCustomError(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { errorName, args } = data as { errorName?: unknown; args?: unknown };
  if (typeof errorName !== "string" || errorName === "") return undefined;
  if (!Array.isArray(args)) return `${errorName}()`;
  return `${errorName}(${args.map((argument) => String(argument)).join(", ")})`;
}

function appendUnlessPresent(lines: string[], line: string) {
  const trimmed = line.trimEnd();
  if (trimmed.trim() === "" || lines.includes(trimmed)) return;
  lines.push(trimmed);
}

/// The shared `main().catch` body for every command.
///
/// It sets `process.exitCode` rather than calling `process.exit`, exactly as the individual
/// catch blocks did, so buffered output still flushes before the process ends.
export function reportFatalError(error: unknown, label: string) {
  process.exitCode = 1;
  if (fullErrorDumpRequested()) {
    console.error(error);
    return;
  }
  console.error(`\nFATAL: ${label} did not complete.`);
  for (const line of describeFatalError(error)) console.error(`  ${line}`);
  console.error(
    `\nRe-run with ${FULL_ERROR_DUMP_ENV}=1 for the complete error object, including the ` +
      `contract ABI, the full cause chain, and stack traces.\n`,
  );
}

/// The pool's `State` enum, by ordinal. `ValidatorFundingPool.sol:39-44`.
///
/// One table, read everywhere a state is printed. `status` named the states while the
/// funding review printed the bare ordinal, so the same pool read two ways said `ToppedUp`
/// in one place and `3` in the other — and `3` is precisely the state in which a plain
/// transfer stops being funding and becomes a donation. The ordinal is kept alongside the
/// name because it is what the contract's own reverts and events carry.
export const POOL_STATE_NAMES = ["Uninitialized", "Predeposited", "Funding", "ToppedUp"] as const;

export function formatPoolState(state: number | bigint): string {
  const ordinal = Number(state);
  const name = POOL_STATE_NAMES[ordinal];
  return name === undefined ? `${ordinal} (unknown state)` : `${name} (${ordinal})`;
}

/// Asserts that the wallet a script is about to sign with is the wallet the operator
/// intended, and prints it on every network.
///
/// The Ledger connection is detected from the resolved connection rather than from
/// argv. `@nomicfoundation/hardhat-ledger` writes `ledgerAccounts` onto every resolved
/// network config at config-resolution time, defaulting to `[]`
/// (`node_modules/@nomicfoundation/hardhat-ledger/dist/src/internal/config/resolve-ledger-user-config.js`
/// lines 6-10), so the field is non-empty exactly for the network whose signing is
/// routed through the device. It describes the connection that was actually created,
/// which `--network` argv scanning does not: a script cannot see task-level network
/// overrides, and a second parse is a second place to get the spelling wrong.
/// `networkName` was rejected as the hook because it only names a config entry and
/// proves nothing about whether a device sits in the signing path.
///
/// On the Ledger path the active address must equal `LEDGER_ADDRESS`. This is the
/// account-confusion guard: `eth_accounts` on the ledger network returns the node's
/// own accounts first and the device account last
/// (`node_modules/@nomicfoundation/hardhat-ledger/dist/src/internal/hook-handlers/network.js`
/// lines 47-63), so a node that exposes unlocked accounts would otherwise have every
/// script sign with one of them.
///
/// Off the Ledger path there is nothing to compare against unless the operator says what
/// they expect, so `EXPECTED_SIGNER` is offered as a declare-and-verify check: set it and
/// the active address must equal it on ANY network, Ledger included. Unset, the address is
/// printed and nothing about it is asserted — an environment-supplied `PRIVATE_KEY` that
/// outranks a keystore entry is exactly the case this catches, and it is invisible without
/// a declaration to check against.
export function assertActiveSigner(
  connection: SignerConnection,
  activeAddress: Address,
  label: string,
): Address {
  warnOnPlaintextEndpoints();
  console.log(`${label} active signer: ${activeAddress} (network ${connection.networkName})`);

  const expectedSigner = process.env.EXPECTED_SIGNER ?? "";
  if (expectedSigner !== "") {
    if (!isAddress(expectedSigner, { strict: false })) {
      throw new Error(`EXPECTED_SIGNER ${expectedSigner} is not a 0x-prefixed 20-byte address`);
    }
    if (activeAddress.toLowerCase() !== expectedSigner.toLowerCase()) {
      throw new Error(
        `${label} would sign with ${activeAddress}, not the declared EXPECTED_SIGNER ` +
          `${expectedSigner}. Nothing has been sent. Check which key this network resolves — an ` +
          `environment PRIVATE_KEY outranks the keystore — and re-run`,
      );
    }
  }

  const ledgerAccounts = connection.networkConfig.ledgerAccounts ?? [];
  if (ledgerAccounts.length === 0) return activeAddress;

  const ledgerAddress = process.env.LEDGER_ADDRESS ?? "";
  if (ledgerAddress === "") {
    throw new Error(
      `${label} is connected to a Ledger-signing network but LEDGER_ADDRESS is unset; ` +
        `set it to the device account and re-run`,
    );
  }
  if (activeAddress.toLowerCase() !== ledgerAddress.toLowerCase()) {
    throw new Error(
      `${label} would sign with ${activeAddress}, not the Ledger account ${ledgerAddress}. ` +
        `The connected node exposes accounts of its own and they are ordered ahead of the ` +
        `device account; point RPC_URL at a node with no unlocked accounts and re-run`,
    );
  }
  return activeAddress;
}

/// Waits for a broadcast transaction and asserts the chain recorded the intended sender.
///
/// This is detection, not prevention: the transaction is already mined by the time the
/// mismatch is visible, and nothing here can undo it. It exists because
/// `@nomicfoundation/hardhat-ledger` caches an address-to-derivation-path mapping and
/// returns the cached path without re-deriving it on the connected device
/// (`node_modules/@nomicfoundation/hardhat-ledger/dist/src/internal/handler.js` lines
/// 190-192, cache file `<hardhat config dir>/ledger/accounts.json` per
/// `internal/cache.js`). A device or seed swapped since the mapping was written signs at
/// the cached path with a different key, and the plugin reports no error.
/// It also decides what a mined transaction is allowed to be. Three things are checked, in
/// this order, and each one is fatal:
///
///   1. The sender. See above.
///   2. Replacement. `waitForTransactionReceipt` does not only wait for `hash`: when a
///      same-nonce transaction from the same sender lands instead, it resolves with the
///      REPLACEMENT's receipt and reports the substitution through `onReplaced`
///      (`node_modules/viem/_esm/actions/public/waitForTransactionReceipt.js` lines
///      157-189 — the block is found by `from` + `nonce` at line 157, its receipt is
///      fetched at line 163, `onReplaced` is invoked at line 182 and the promise resolves
///      with that same receipt at line 188). Without capturing the callback, the resolved
///      receipt silently describes a different transaction than the one this script
///      signed. Only a reprice is acceptable, and a reprice means every non-fee semantic
///      field is unchanged — destination, value, calldata, transaction type, access list,
///      blob hashes, authorization list — with only the fee, and therefore the signature
///      and the hash, different. A `cancelled` or `replaced` transaction did something else
///      with the nonce, and the intended transaction never happened.
///   3. The status. A reverted transaction has a receipt, a block number, and the right
///      sender. Nothing below this line may report success for one.
///
/// Every success log line in every command is downstream of this function returning, so a
/// reverted or substituted transaction can never be printed as a success.
export async function waitForSenderVerifiedReceipt<T extends SenderVerifiedReceipt>(
  publicClient: {
    waitForTransactionReceipt: (args: {
      hash: Hex;
      onReplaced?: (replacement: ObservedReplacement) => void;
    }) => Promise<T>;
  },
  hash: Hex,
  intendedSender: Address,
  label: string,
): Promise<T> {
  let replacement: ObservedReplacement | undefined;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: (observed) => {
      replacement = observed;
    },
  });

  if (receipt.from.toLowerCase() !== intendedSender.toLowerCase()) {
    throw new Error(
      `FATAL SIGNER MISMATCH: ${label} transaction ${hash} was mined with from=${receipt.from}, ` +
        `but this script signed for ${intendedSender}. The transaction is already on chain: ` +
        `this check DETECTS a swapped signer, it cannot prevent one. A Ledger with a different ` +
        `device or seed than the one that populated the plugin's cached derivation path produces ` +
        `exactly this. Stop, run "npm run status", and reconcile pool state before sending anything else`,
    );
  }

  if (replacement !== undefined) {
    assertAcceptableReplacement(replacement, hash, label);
  }

  if (receipt.status !== "success") {
    throw new Error(
      `FATAL: ${label} transaction ${replacement?.transaction.hash ?? hash} was mined but ` +
        `REVERTED (receipt status ${receipt.status}) in block ${receipt.blockNumber}. Nothing it ` +
        `intended to do happened, and any gas it consumed is spent. Run "npm run status" to read ` +
        `the pool's actual state before retrying ${label}`,
    );
  }

  return receipt;
}

/// A reprice keeps the transaction's meaning and changes only its price, so the receipt
/// still describes what this script signed for. Anything else does not.
///
/// viem classifies the reason itself and only calls a replacement `repriced` when `to`,
/// `value`, and `input` all match the replaced transaction
/// (`waitForTransactionReceipt.js` lines 171-176). The content comparison is repeated here
/// rather than trusted, and it is deliberately WIDER than viem's: every non-fee semantic
/// field of `ObservedTransaction` must match, not just those three. viem's three leave a
/// same-to/value/input transaction free to change its `type`, attach an access list, or —
/// the one that redirects authority rather than ETH — carry an EIP-7702
/// `authorizationList` that delegates the sending EOA's code to an arbitrary contract.
/// viem would still label that "repriced". This is the check that decides whether a success
/// line may be printed, and it should not depend on a classification made elsewhere.
function assertAcceptableReplacement(
  replacement: ObservedReplacement,
  hash: Hex,
  label: string,
) {
  const { reason, replacedTransaction, transaction } = replacement;
  const differing = differingSemanticFields(replacedTransaction, transaction);

  if (reason === "repriced" && differing.length === 0) {
    console.log(
      `${label} transaction ${hash} was repriced and mined as ${transaction.hash} with ` +
        `identical destination, value, calldata, transaction type, access list, blob hashes, ` +
        `and authorization list`,
    );
    return;
  }

  throw new Error(
    `FATAL REPLACED TRANSACTION: ${label} transaction ${hash} never landed. A different ` +
      `transaction at the same nonce from the same sender was mined instead ` +
      `(${transaction.hash}, reason "${reason}"` +
      `${differing.length === 0 ? "" : `, differing semantic fields: ${differing.join(", ")}`}): ` +
      `to=${transaction.to ?? "<none>"} value=${transaction.value} instead of ` +
      `to=${replacedTransaction.to ?? "<none>"} value=${replacedTransaction.value}. ` +
      `What this script intended did NOT happen, and something else did. Run "npm run status", ` +
      `reconcile pool state against the mined transaction, and only then decide whether to re-run ${label}`,
  );
}

/// Names every non-fee semantic field on which the two transactions disagree. An absent
/// field equals an absent field; absent against present is a difference, so a legacy
/// transaction replaced by an eip7702 one carrying an authorization list is reported on
/// both `type` and `authorizationList`.
function differingSemanticFields(
  replaced: ObservedTransaction,
  mined: ObservedTransaction,
): string[] {
  const differing: string[] = [];
  if (!sameAddress(mined.to, replaced.to)) differing.push("to");
  if (mined.value !== replaced.value) differing.push("value");
  if (mined.input.toLowerCase() !== replaced.input.toLowerCase()) differing.push("input");
  if (!sameOptionalStructure(mined.type, replaced.type)) differing.push("type");
  if (!sameOptionalStructure(mined.accessList, replaced.accessList)) differing.push("accessList");
  if (!sameOptionalStructure(mined.blobVersionedHashes, replaced.blobVersionedHashes)) {
    differing.push("blobVersionedHashes");
  }
  if (!sameOptionalStructure(mined.authorizationList, replaced.authorizationList)) {
    differing.push("authorizationList");
  }
  return differing;
}

function sameOptionalStructure(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalStructure(left) === canonicalStructure(right);
}

/// Deep structural equality by canonical rendering. Hex-bearing fields (addresses, storage
/// keys, blob hashes, authorization signature components) arrive with no guaranteed case, so
/// every string is compared case-insensitively; bigints are tagged so `1n` never equals
/// `"1"`; object keys are sorted and explicitly-undefined entries dropped so that key order
/// and an absent-versus-undefined property do not read as a difference.
function canonicalStructure(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "string") return `string:${value.toLowerCase()}`;
  if (Array.isArray(value)) return `[${value.map(canonicalStructure).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${key}:${canonicalStructure(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function sameAddress(left: Address | null, right: Address | null): boolean {
  if (left === null || right === null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

/// Confirms the mined deployment receipt created the contract at the address the
/// deployment helper predicted from sender and nonce.
export function assertDeployedAt(
  receiptContractAddress: Address | null | undefined,
  expected: Address,
  label: string,
) {
  if (
    receiptContractAddress === null ||
    receiptContractAddress === undefined ||
    receiptContractAddress.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(
      `${label} deployment receipt created a contract at ${receiptContractAddress ?? "<none>"}, ` +
        `not the expected ${expected}`,
    );
  }
}

export function asHex(value: string): Hex {
  return (/^0x/i.test(value) ? `0x${value.slice(2)}` : `0x${value}`) as Hex;
}

export function asAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return value as Address;
}

export function envAddress(name: string, fallback?: Address): Address {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback === undefined) {
      throw new Error(`Missing env ${name}`);
    }
    return fallback;
  }
  return asAddress(value);
}

/// Parses an integer that decides how much ETH moves. Only a canonical unsigned decimal
/// string is accepted, mirroring `parseBeaconUint64` minus its uint64 bound — wei amounts
/// legitimately exceed uint64.
///
/// `BigInt` on its own also accepts `"0x20"`, `"+5"`, `" 5 "`, and `"5_0"`. None of those
/// is a form anyone means to type into an amount, and `0x20` in particular reads as
/// thirty-two and is thirty-two only by coincidence of it also being valid hex. An amount
/// that does not look like the number it is meant to be is a parse error, not a value.
export function parseUnsignedDecimal(value: string, name: string): bigint {
  if (!CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(
      `${name} ${JSON.stringify(value)} is not a canonical unsigned decimal integer: no 0x ` +
        `prefix, no sign, no leading zeros, no separators, no surrounding whitespace`,
    );
  }
  return BigInt(value);
}

export function envBigInt(name: string, fallback?: bigint): bigint {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback === undefined) {
      throw new Error(`Missing env ${name}`);
    }
    return fallback;
  }
  return parseUnsignedDecimal(value, name);
}

/// A declare-and-verify pin: absent when the variable is unset or empty, and otherwise
/// parsed exactly as `envBigInt` parses an amount. Nothing here may fall back to a value —
/// the whole point of a pin is that the operator said what they expect — so an unparseable
/// declaration is fatal rather than silently ignored. `BigInt("")` is `0n` and `BigInt` on
/// its own accepts `"0x20"`, so the difference is not cosmetic: an expected attempt of
/// `"0x3"` compared as three would have read as a pass.
export function optionalEnvBigInt(name: string): bigint | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  return envBigInt(name);
}

/// Refuses a run whose environment declares a funding window this command cannot apply.
///
/// `FUNDING_WINDOW_SECONDS` is a DEPLOY-TIME variable and nothing else. `fundingWindowDuration`
/// is an `immutable` written once by the pool's constructor, `deploy.ts` is the only script that
/// reads the variable, and `openFundingAttempt(address[],uint256[])` takes no duration argument:
/// the deadline it sets is `block.timestamp + fundingWindowDuration`, read from the pool. So a
/// `FUNDING_WINDOW_SECONDS` in `open-funding-attempt`'s environment changes nothing at all.
///
/// That is fatal rather than a warning. The window is the whole mitigation for the free
/// liveness grief a listed participant can inflict (`SECURITY.md` §2, "Participants"): an
/// operator who sets it here believes they are bounding how long everyone else's capital can be
/// locked, and a warning on a security-relevant input that was silently ignored is a pass
/// reported for a decision that was never made.
export function assertFundingWindowNotDeclared(label: string) {
  const declared = process.env.FUNDING_WINDOW_SECONDS ?? "";
  if (declared === "") return;
  throw new Error(
    `${label}: FUNDING_WINDOW_SECONDS is set to ${JSON.stringify(declared)}, and this command ` +
      `cannot apply it. The funding window is the pool's immutable fundingWindowDuration, fixed ` +
      `in the constructor at deploy time and read from the environment by "npm run deploy" only; ` +
      `openFundingAttempt takes no duration, and the deadline it sets is block.timestamp plus the ` +
      `pool's own immutable. Changing the window means deploying a new pool, which strands this ` +
      `one's 1 ETH predeposit. Nothing has been sent. Unset FUNDING_WINDOW_SECONDS to open the ` +
      `attempt on the window this pool was deployed with, which this command prints`,
  );
}

export function parseAddressList(value: string): Address[] {
  return value.split(",").map((entry) => asAddress(entry.trim()));
}

/// Entries are parsed exactly as `envBigInt` parses a single value, with one difference:
/// surrounding whitespace between the commas is trimmed, because a comma-separated list is
/// routinely written with spaces after the commas.
export function parseBigIntList(value: string, name: string): bigint[] {
  return value
    .split(",")
    .map((entry, index) => parseUnsignedDecimal(entry.trim(), `${name} entry ${index}`));
}

export function deploymentPath(): string {
  return process.env.DEPLOYMENT_FILE ?? path.join("deployments", "latest.json");
}

export function writeDeployment(record: DeploymentRecord) {
  const file = deploymentPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote deployment: ${file}`);
}

/// Reads the deployment record, announcing which file it came from.
///
/// The path is printed BEFORE the file is opened, and it is printed unconditionally. This
/// is the one input that selects the SUBJECT of every other check: the record names the
/// pool, and chain id, immutables, code hashes, canonicity, the forwarder binding, and the
/// address capital is sent to are all read from — or compared against — whatever that
/// record says. `DEPLOYMENT_FILE` chooses it, silently, from the environment. An operator
/// who cannot see which record a command is acting on cannot tell a run against the pool
/// they mean from a run against a stale or swapped one, and every command would report a
/// clean pass either way. `EXPECTED_POOL` turns the printed line into an assertion.
export function readDeployment(): DeploymentRecord {
  const file = deploymentPath();
  console.log(`Deployment record: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as DeploymentRecord;
}

/// A declare-and-verify pin on the pool the deployment record names.
///
/// Follows `EXPECTED_SIGNER` exactly: unset or empty declares nothing, a value that is not
/// an address is fatal and names the variable, and a mismatch is fatal before anything is
/// sent. A pin that cannot be parsed has NOT been declared, so it is never silently
/// ignored — that would report a pass for a check which never ran.
///
/// It is evaluated at two moments, for the same reason the funding pins are: once when the
/// record is first verified against the chain, and again in the final on-chain re-read
/// immediately before a funding transaction is signed. On the Ledger path those two are
/// minutes apart.
export function assertExpectedPool(poolAddress: Address, where: string) {
  const expectedPool = process.env.EXPECTED_POOL ?? "";
  if (expectedPool === "") return;
  if (!isAddress(expectedPool, { strict: false })) {
    throw new Error(`EXPECTED_POOL ${expectedPool} is not a 0x-prefixed 20-byte address`);
  }
  if (poolAddress.toLowerCase() !== expectedPool.toLowerCase()) {
    throw new Error(
      `${where}: the deployment record ${deploymentPath()} names pool ${poolAddress}, not the ` +
        `declared EXPECTED_POOL ${expectedPool}. Nothing has been sent. DEPLOYMENT_FILE selects ` +
        `which record every check in this command is made against; point it at the record for ` +
        `the pool you mean and re-run`,
    );
  }
}

export function defaultDepositContract(): Address {
  return DEFAULT_DEPOSIT_CONTRACT;
}

export async function assertDeploymentChain(
  publicClient: { getChainId: () => Promise<number> },
  deployment: DeploymentRecord,
): Promise<number> {
  const chainId = await publicClient.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`Deployment chainId ${deployment.chainId} does not match connected chainId ${chainId}`);
  }
  return chainId;
}

export async function assertDeploymentSystemCodeHashes(
  publicClient: SystemCodeReader,
  deployment: DeploymentRecord,
  liveConfig: PoolDeploymentConfig,
): Promise<{ depositContractCodeHash: Hex; withdrawalRequestPredeployCodeHash: Hex }> {
  const currentDepositCodeHash = await codeHash(
    publicClient,
    liveConfig.depositContract,
    "pool depositContract",
  );
  if (currentDepositCodeHash.toLowerCase() !== deployment.depositContractCodeHash.toLowerCase()) {
    throw new Error(
      `Pool depositContract code hash ${currentDepositCodeHash} does not match deployment record ` +
        deployment.depositContractCodeHash,
    );
  }

  const currentWithdrawalCodeHash = await codeHash(
    publicClient,
    liveConfig.withdrawalRequestPredeploy,
    "pool withdrawalRequestPredeploy",
  );
  if (currentWithdrawalCodeHash.toLowerCase() !== deployment.withdrawalRequestPredeployCodeHash.toLowerCase()) {
    throw new Error(
      `Pool withdrawalRequestPredeploy code hash ${currentWithdrawalCodeHash} does not match deployment record ` +
        deployment.withdrawalRequestPredeployCodeHash,
    );
  }

  return {
    depositContractCodeHash: currentDepositCodeHash,
    withdrawalRequestPredeployCodeHash: currentWithdrawalCodeHash,
  };
}

export async function assertDeploymentMatchesPool(
  pool: PoolDeploymentReader,
  deployment: DeploymentRecord,
): Promise<PoolDeploymentConfig> {
  const [
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    withdrawalCredentials,
    fundingWindowDuration,
  ] = await Promise.all([
    pool.read.depositContract(),
    pool.read.withdrawalRequestPredeploy(),
    pool.read.operator(),
    pool.read.withdrawalCredentials(),
    pool.read.fundingWindowDuration(),
  ]);
  // The credentials are DERIVED from the pool's own address rather than taken from what
  // the pool reports, and the derived value is what the returned config carries. Every
  // capital path — deposit-data validation, both beacon credential comparisons — reads
  // `liveConfig.withdrawalCredentials`, so after this line none of them can be steered by
  // a contract that answers `withdrawalCredentials()` with someone else's address.
  const derivedCredentials = deriveWithdrawalCredentials(deployment.pool);
  if (withdrawalCredentials.toLowerCase() !== derivedCredentials.toLowerCase()) {
    throw new Error(
      `FATAL: the pool at ${deployment.pool} reports withdrawal credentials ` +
        `${withdrawalCredentials}, but credentials owned by that pool are ${derivedCredentials} ` +
        `(0x01 prefix, eleven zero bytes, the pool's own address — ` +
        `ValidatorFundingPool._makeEth1WithdrawalCredentials). A contract whose credentials are ` +
        `not derived from its own address does not receive this validator's consensus ` +
        `withdrawals. Do not send capital to this address`,
    );
  }

  const liveConfig = {
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    withdrawalCredentials: derivedCredentials,
    fundingWindowDuration,
  };

  assertDeploymentField("depositContract", depositContract, deployment.depositContract, true);
  assertDeploymentField(
    "withdrawalRequestPredeploy",
    withdrawalRequestPredeploy,
    deployment.withdrawalRequestPredeploy,
    true,
  );
  assertDeploymentField("operator", operator, deployment.operator, true);
  assertDeploymentField(
    "withdrawalCredentials",
    withdrawalCredentials,
    deployment.withdrawalCredentials,
    true,
  );
  assertDeploymentField(
    "fundingWindowDuration",
    fundingWindowDuration,
    BigInt(deployment.fundingWindowDuration),
    false,
  );
  return liveConfig;
}

export async function assertDeploymentCanonicity(
  chainId: number,
  liveConfig: Pick<PoolDeploymentConfig, "depositContract" | "withdrawalRequestPredeploy">,
  liveCodeHashes: { depositContractCodeHash: Hex; withdrawalRequestPredeployCodeHash: Hex },
) {
  const canonical = CANONICAL_SYSTEM_CONTRACTS[chainId];
  if (canonical === undefined) {
    console.warn(
      `WARNING: no canonical system-contract pin is recorded for chainId ${chainId}; ` +
        `canonicity is unverified and only deployment-record consistency is enforced`,
    );
    return;
  }

  assertCanonicalField("depositContract", liveConfig.depositContract, canonical.depositContract);
  assertCanonicalField(
    "withdrawalRequestPredeploy",
    liveConfig.withdrawalRequestPredeploy,
    canonical.withdrawalRequestPredeploy,
  );
  assertCanonicalField(
    "depositContract code hash",
    liveCodeHashes.depositContractCodeHash,
    canonical.depositContractCodeHash,
  );
  assertCanonicalField(
    "withdrawalRequestPredeploy code hash",
    liveCodeHashes.withdrawalRequestPredeployCodeHash,
    canonical.withdrawalRequestPredeployCodeHash,
  );
}

export async function assertDeploymentIntegrity(
  publicClient: DeploymentPublicClient,
  pool: PoolDeploymentReader,
  deployment: DeploymentRecord,
): Promise<PoolDeploymentConfig> {
  // First, before a single RPC read: everything below this line is about the pool this
  // record names, so a record naming the wrong pool has to be caught before any of it runs.
  assertExpectedPool(deployment.pool, "Deployment record");
  const chainId = await assertDeploymentChain(publicClient, deployment);
  await assertHasCode(publicClient, deployment.pool, "pool");
  const liveConfig = await assertDeploymentMatchesPool(pool, deployment);
  await assertRuntimeCodeMatchesLocalBuild(
    publicClient,
    deployment.pool,
    readLocalBuildArtifacts(VERIFIED_POOL),
    VERIFIED_POOL,
  );
  const liveCodeHashes = await assertDeploymentSystemCodeHashes(publicClient, deployment, liveConfig);
  await assertDeploymentCanonicity(chainId, liveConfig, liveCodeHashes);
  assertExpectedForwarderRecorded(deployment);
  if (deployment.feeRecipientForwarder !== undefined) {
    await assertForwarderAuthenticity(publicClient, deployment.feeRecipientForwarder, deployment.pool);
  }
  return liveConfig;
}

const FORWARDER_POOL_ABI = [
  {
    type: "function",
    name: "pool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/// Everything that can be established about a fee-recipient forwarder without trusting it.
///
/// The forwarder used to be checked for code and for a `pool()` that answers with this pool,
/// which is a BINDING check and not an authenticity one: `pool()` is whatever the deployed
/// code chooses to return, so a contract that reports the right pool and sends its balance
/// somewhere else passes it. That matters because the forwarder is the address an operator
/// configures as their validator client's `fee_recipient`: every block that validator
/// proposes pays its execution-layer rewards there, continuously, with no per-payment
/// decision to check.
///
/// So the same three layers the pool gets are applied here: the operator's optional
/// `EXPECTED_FORWARDER` declaration, the binding to this pool, and — the one that is not
/// circular — the deployed runtime code against the participant's own build of
/// `contracts/FeeRecipientForwarder.sol`, with the single `pool` immutable's byte ranges
/// masked on both sides.
export async function assertForwarderAuthenticity(
  publicClient: DeploymentPublicClient,
  forwarder: Address,
  poolAddress: Address,
): Promise<void> {
  assertExpectedForwarder(forwarder);
  await assertHasCode(publicClient, forwarder, VERIFIED_FORWARDER.role);
  const forwarderPool = (await publicClient.readContract({
    address: forwarder,
    abi: FORWARDER_POOL_ABI,
    functionName: "pool",
  })) as Address;
  assertForwarderPool(forwarderPool, poolAddress);
  await assertRuntimeCodeMatchesLocalBuild(
    publicClient,
    forwarder,
    readLocalBuildArtifacts(VERIFIED_FORWARDER),
    VERIFIED_FORWARDER,
  );
}

/// The declared forwarder pin, parsed: absent when unset or empty, fatal when it is not an
/// address. A declaration that cannot be parsed has NOT been made, and silently ignoring it
/// would report a pass for a check that never ran.
function declaredExpectedForwarder(): Address | undefined {
  const expectedForwarder = process.env.EXPECTED_FORWARDER ?? "";
  if (expectedForwarder === "") return undefined;
  if (!isAddress(expectedForwarder, { strict: false })) {
    throw new Error(`EXPECTED_FORWARDER ${expectedForwarder} is not a 0x-prefixed 20-byte address`);
  }
  return expectedForwarder;
}

/// Evaluates the `EXPECTED_FORWARDER` pin against the record, INCLUDING the case where the
/// record names no forwarder at all.
///
/// `assertExpectedForwarder` can only compare a forwarder that exists, so for a record with no
/// `feeRecipientForwarder` the pin used to be unreachable: `EXPECTED_FORWARDER` was set, the
/// command reported a clean pass, and nothing had been checked. The declaration is a statement
/// about which forwarder this run is about, and a record that names none does not satisfy it —
/// most often because `DEPLOYMENT_FILE` points at the pre-`deploy-forwarder` record, which is
/// exactly the confusion the pin exists to catch. This runs wherever a record is read, on the
/// `assertExpectedPool` pattern: it costs one string comparison and depends on no artifact.
export function assertExpectedForwarderRecorded(
  deployment: Pick<DeploymentRecord, "feeRecipientForwarder">,
) {
  const expectedForwarder = declaredExpectedForwarder();
  if (expectedForwarder === undefined) return;
  if (deployment.feeRecipientForwarder === undefined) {
    throw new Error(
      `EXPECTED_FORWARDER ${expectedForwarder} is declared, but the deployment record ` +
        `${deploymentPath()} names no fee-recipient forwarder at all, so the declaration cannot ` +
        `be checked and nothing about the forwarder has been verified. Nothing has been sent. ` +
        `Either this record predates "npm run deploy-forwarder" and DEPLOYMENT_FILE should point ` +
        `at the record that has one, or this pool has no forwarder and EXPECTED_FORWARDER should ` +
        `not be set for it`,
    );
  }
  assertExpectedForwarder(deployment.feeRecipientForwarder);
}

/// A declare-and-verify pin on the forwarder the deployment record names.
///
/// The same shape as `assertExpectedPool`, for the same reason: `DEPLOYMENT_FILE` selects the
/// record, and the record names the forwarder as freely as it names the pool. Unset or empty
/// declares nothing; a value that is not an address is fatal naming the variable; a mismatch
/// is fatal before anything is sent. Reach it through `assertExpectedForwarderRecorded` when
/// the record may name no forwarder, which is the case this one cannot see.
export function assertExpectedForwarder(forwarderAddress: Address) {
  const expectedForwarder = declaredExpectedForwarder();
  if (expectedForwarder === undefined) return;
  if (forwarderAddress.toLowerCase() !== expectedForwarder.toLowerCase()) {
    throw new Error(
      `The deployment record ${deploymentPath()} names fee-recipient forwarder ` +
        `${forwarderAddress}, not the declared EXPECTED_FORWARDER ${expectedForwarder}. Nothing ` +
        `has been sent. DEPLOYMENT_FILE selects that record; point it at the record for the ` +
        `forwarder you mean and re-run`,
    );
  }
}

export async function assertFeeRecipientForwarderMatchesDeployment(
  publicClient: SystemCodeReader,
  forwarder: FeeRecipientForwarderReader,
  deployment: DeploymentRecord,
): Promise<Address> {
  if (deployment.feeRecipientForwarder === undefined) {
    throw new Error("Deployment record has no feeRecipientForwarder");
  }
  if (forwarder.address.toLowerCase() !== deployment.feeRecipientForwarder.toLowerCase()) {
    throw new Error(
      `FeeRecipientForwarder address ${forwarder.address} does not match deployment record ` +
        deployment.feeRecipientForwarder,
    );
  }
  await assertHasCode(
    publicClient,
    deployment.feeRecipientForwarder,
    "feeRecipientForwarder",
  );
  const livePool = await forwarder.read.pool();
  assertForwarderPool(livePool, deployment.pool);
  return livePool;
}

function assertForwarderPool(livePool: Address, deploymentPool: Address) {
  if (livePool.toLowerCase() !== deploymentPool.toLowerCase()) {
    throw new Error(
      `FeeRecipientForwarder pool ${livePool} does not match deployment pool ${deploymentPool}`,
    );
  }
}

function assertDeploymentField(
  field: string,
  liveValue: string | bigint,
  recordedValue: string | bigint,
  caseInsensitive: boolean,
) {
  const live = liveValue.toString();
  const recorded = recordedValue.toString();
  const matches = caseInsensitive ? live.toLowerCase() === recorded.toLowerCase() : live === recorded;
  if (!matches) {
    throw new Error(`Pool ${field} ${live} does not match deployment record ${recorded}`);
  }
}

function assertCanonicalField(field: string, liveValue: string, canonicalValue: string) {
  if (liveValue.toLowerCase() !== canonicalValue.toLowerCase()) {
    throw new Error(`Pool ${field} ${liveValue} does not match canonical chain value ${canonicalValue}`);
  }
}

export async function assertHasCode(
  publicClient: { getCode: (args: { address: Address }) => Promise<Hex | undefined> },
  address: Address,
  label: string,
): Promise<Hex> {
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`${label} has no code at ${address}`);
  }
  return code;
}

export async function codeHash(
  publicClient: { getCode: (args: { address: Address }) => Promise<Hex | undefined> },
  address: Address,
  label: string,
): Promise<Hex> {
  return keccak256(await assertHasCode(publicClient, address, label));
}

// ---------------------------------------------------------------------------
// Pool authenticity
//
// Everything else in this file compares an operator-supplied deployment record
// against the live contract that record names. Those two can agree perfectly and
// still describe a pool nobody audited: the record is written by whoever ran
// `deploy`, and the pool answers whatever its own code says. Neither side is
// independent of the operator.
//
// The two checks below are the ones that are. The first derives the withdrawal
// credentials from the pool's own address instead of asking the pool for them.
// The second compares the pool's runtime code against the participant's OWN
// local build of `contracts/ValidatorFundingPool.sol` — the audited source, in
// the participant's checkout, compiled on the participant's machine.
// ---------------------------------------------------------------------------

/// The withdrawal credentials a pool at `poolAddress` must have: `bytes32((1 << 248) |
/// uint160(poolAddress))`, i.e. the `0x01` prefix, eleven zero bytes, and the pool's own
/// address. This is what the contract itself computes — `_makeEth1WithdrawalCredentials`
/// at `contracts/ValidatorFundingPool.sol:669-673`, and identically
/// `contracts/FeeRecipientForwarder.sol:20-32` when it validates its destination.
///
/// Deriving them locally is what makes them evidence. A pool that reports credentials
/// belonging to some other address — a pool whose consensus withdrawals would pay someone
/// else — is caught here, before any capital path can use the reported value.
export function deriveWithdrawalCredentials(poolAddress: Address): Hex {
  return `0x01${"00".repeat(11)}${asAddress(poolAddress).slice(2).toLowerCase()}` as Hex;
}

/// One range of bytes in a deployed runtime code that holds an immutable's value.
interface ImmutableRange {
  start: number;
  length: number;
}

/// The parts of a Hardhat build artifact this verification reads. `immutableReferences`
/// maps solc's AST id for each immutable to every byte range in the deployed bytecode
/// where its value is written at construction time.
export interface BuildArtifact {
  deployedBytecode: Hex;
  immutableReferences?: Record<string, readonly ImmutableRange[]>;
  buildInfoId?: string;
}

/// A local build artifact together with where it came from and which solidity build
/// profile produced it.
export interface BuildCandidate {
  source: string;
  profile: string;
  artifact: BuildArtifact;
}

/// A contract this repository deploys and then verifies against the participant's own build.
///
/// The masking machinery below is written once and applied to both: the pool, whose runtime
/// code is the thing capital is sent to, and the fee-recipient forwarder, whose runtime code
/// decides where a validator's execution-layer rewards actually go. Only the artifact path
/// and the operator-facing labels differ.
export interface VerifiedContract {
  /// The solidity contract name, used in the "no artifact" instruction.
  name: string;
  /// What the address is called in output and error messages, matching the label the
  /// deployment-record checks already use for it.
  role: string;
  /// Where hardhat writes this contract's build artifact in this checkout.
  artifactFile: string;
  /// How many bytes a real build declares immutable, under either solidity profile. Quoted
  /// in the plausibility failure so the number the ceiling is sized against is visible.
  observedImmutableBytes: number;
}

const ARTIFACTS_ROOT = "artifacts";

function artifactFile(contractName: string): string {
  return path.join(ARTIFACTS_ROOT, "contracts", `${contractName}.sol`, `${contractName}.json`);
}

/// solc emits one 32-byte range per immutable *reference site*, not one per immutable. The
/// pool's five immutables are read at 19 sites (608 bytes) and the forwarder's single `pool`
/// at 2 (64 bytes), identically under both build profiles.
export const VERIFIED_POOL: VerifiedContract = {
  name: "ValidatorFundingPool",
  role: "pool",
  artifactFile: artifactFile("ValidatorFundingPool"),
  observedImmutableBytes: 608,
};

export const VERIFIED_FORWARDER: VerifiedContract = {
  name: "FeeRecipientForwarder",
  role: "feeRecipientForwarder",
  artifactFile: artifactFile("FeeRecipientForwarder"),
  observedImmutableBytes: 64,
};

/// The ceiling on how many bytes an artifact may declare immutable.
///
/// It exists because the ranges are taken from the CANDIDATE artifact and applied to the
/// chain's code as well as to the artifact's. A candidate that declares most or all of the
/// runtime immutable masks both sides to zeroes and then "matches" any contract at all —
/// the comparison would be checking nothing while printing that it passed. A total that
/// large is not a plausible immutable layout, so it is fatal rather than a match.
///
/// Sized from the real artifact, not from the number of immutables. solc emits one 32-byte
/// range per *reference site*, and one immutable is read at several sites: the pool's five
/// immutables produce 19 sites, 608 bytes, identically under both build profiles
/// (`artifacts/contracts/ValidatorFundingPool.sol/ValidatorFundingPool.json`,
/// `immutableReferences`; 16861 bytes of runtime under `default`, 10002 under
/// `production`). The forwarder's single `pool` immutable produces 2 sites, 64 bytes, again
/// under both profiles. 2048 is roughly three times the larger observed total, room for a
/// contract with materially more immutable reads, and still far below the point where
/// masking could hide a different contract — every unmasked byte, metadata hash included,
/// must match exactly.
const MAX_MASKED_IMMUTABLE_BYTES = 2048;

/// Masks every immutable's byte range with zeroes.
///
/// Runtime code is identical across deployments of the same source and settings EXCEPT at
/// these ranges, which hold constructor-supplied values: the deposit contract, the
/// withdrawal-request predeploy, the operator, the funding window, and the pool's own
/// withdrawal credentials. Masking them on BOTH sides is what lets a byte-for-byte
/// comparison mean "same code" rather than "same deployment". Every other byte, including
/// solc's trailing metadata hash, still has to match exactly.
///
/// The ranges come from the artifact and are applied to the artifact and the chain code
/// alike, so a range the artifact does not declare is a range that must match — and a range
/// set that is too broad is a range set that checks nothing. Two plausibility bounds are
/// enforced before a single byte is masked: solc emits disjoint ranges, so an overlapping
/// set is rejected, and the total is capped at `MAX_MASKED_IMMUTABLE_BYTES`.
export function maskImmutableRanges(
  code: Hex,
  immutableReferences: Record<string, readonly ImmutableRange[]>,
  what: string,
): { masked: Hex; maskedBytes: number } {
  const body = code.startsWith("0x") ? code.slice(2) : code;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error(`${what} is not a whole number of hex-encoded bytes`);
  }
  const bytes = Buffer.from(body, "hex");

  const declared: { astId: string; start: number; length: number }[] = [];
  for (const [astId, ranges] of Object.entries(immutableReferences)) {
    for (const range of ranges) {
      const { start, length } = range;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < 0 ||
        length < 0 ||
        start + length > bytes.length
      ) {
        throw new Error(
          `${what}: immutable reference ${astId} declares the byte range ` +
            `[${start}, ${start + length}) which is outside the ${bytes.length}-byte code`,
        );
      }
      declared.push({ astId, start, length });
    }
  }

  const ordered = [...declared].sort((left, right) => left.start - right.start);
  for (let i = 1; i < ordered.length; ++i) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (current.start < previous.start + previous.length) {
      throw new Error(
        `${what}: immutable references ${previous.astId} ` +
          `[${previous.start}, ${previous.start + previous.length}) and ${current.astId} ` +
          `[${current.start}, ${current.start + current.length}) overlap. solc emits disjoint ` +
          `ranges for distinct immutables, so this artifact's immutable layout is implausible; ` +
          `masking it would zero out more of the code than the immutables occupy. Delete ` +
          `artifacts/ and run "npm run build"`,
      );
    }
  }

  const maskedBytes = declared.reduce((total, range) => total + range.length, 0);
  if (maskedBytes > MAX_MASKED_IMMUTABLE_BYTES) {
    throw new Error(
      `${what}: the immutable ranges cover ${maskedBytes} of the ${bytes.length} bytes of code, ` +
        `above the ${MAX_MASKED_IMMUTABLE_BYTES}-byte ceiling. A real build of this repository's ` +
        `contracts declares far less — ${VERIFIED_POOL.observedImmutableBytes} bytes for ` +
        `${VERIFIED_POOL.name} and ${VERIFIED_FORWARDER.observedImmutableBytes} for ` +
        `${VERIFIED_FORWARDER.name}, under either solidity profile — so this artifact's ` +
        `immutable layout is implausible. The ranges are ` +
        `masked on the chain's code too: a range set this broad would zero out the very bytes the ` +
        `comparison exists to check and match any contract at all. Delete artifacts/ and run ` +
        `"npm run build"`,
    );
  }

  for (const { start, length } of declared) bytes.fill(0, start, start + length);

  return { masked: `0x${bytes.toString("hex")}` as Hex, maskedBytes };
}

/// Compares a deployed contract's on-chain runtime code against the participant's own local
/// build.
///
/// This is the check that is not circular: the deployment record and the live contract are
/// both downstream of whoever deployed, but `artifacts/` is downstream of the audited
/// source in this checkout. A contract that is not this source fails here even when every
/// record-to-chain comparison passes.
///
/// It runs against both contracts this repository deploys. For the pool it decides whether
/// capital may be sent at all. For the fee-recipient forwarder it decides something narrower
/// and still worth having: the forwarder is what a validator client is configured to pay its
/// execution-layer rewards to, and its `pool()` binding proves only what the contract chooses
/// to report. Code that answers `pool()` honestly and sweeps somewhere else passes the
/// binding check and fails this one.
///
/// It is not a substitute for source verification. It proves the deployed code is the code
/// this checkout builds; it says nothing about whether this checkout is the audited one.
/// Verify the repository's provenance and the contracts on Sourcify as well.
export async function assertRuntimeCodeMatchesLocalBuild(
  publicClient: { getCode: (args: { address: Address }) => Promise<Hex | undefined> },
  address: Address,
  candidates: readonly BuildCandidate[],
  subject: VerifiedContract = VERIFIED_POOL,
): Promise<BuildCandidate> {
  if (candidates.length === 0) {
    throw new Error(missingArtifactMessage([], subject));
  }

  const chainCode = await assertHasCode(publicClient, address, subject.role);
  const rejections: string[] = [];

  for (const candidate of candidates) {
    const artifactCode = candidate.artifact.deployedBytecode;
    if (typeof artifactCode !== "string" || !/^0x[0-9a-fA-F]*$/.test(artifactCode)) {
      throw new Error(
        `${candidate.source} has no usable deployedBytecode; delete artifacts/ and run "npm run build"`,
      );
    }
    if (artifactCode.length !== chainCode.length) {
      rejections.push(
        `${candidate.source} (profile ${candidate.profile}): ${(artifactCode.length - 2) / 2} bytes ` +
          `of runtime code, chain has ${(chainCode.length - 2) / 2}`,
      );
      continue;
    }

    const references = candidate.artifact.immutableReferences ?? {};
    const artifact = maskImmutableRanges(artifactCode, references, `${candidate.source} deployedBytecode`);
    const chain = maskImmutableRanges(chainCode, references, `${subject.role} ${address} runtime code`);
    if (artifact.masked.toLowerCase() === chain.masked.toLowerCase()) {
      console.log(
        `${capitalizeFirst(subject.role)} runtime code matches the local build ${candidate.source} ` +
          `(solidity profile ${candidate.profile}); ${artifact.maskedBytes} immutable bytes masked, ` +
          `masked code hash ${keccak256(chain.masked)}`,
      );
      return candidate;
    }
    rejections.push(
      `${candidate.source} (profile ${candidate.profile}): masked code hash ` +
        `${keccak256(artifact.masked)} != chain ${keccak256(chain.masked)}`,
    );
  }

  throw new Error(
    `FATAL: the ${subject.role} at ${address} does not run the code this checkout builds. Its ` +
      `runtime code matches no local build artifact, with all ` +
      `${candidates.length === 1 ? "its" : "their"} immutable ranges masked on both sides: ` +
      `${rejections.join("; ")}. This is the check that the deployment record cannot make for ` +
      `you — a record and a contract can agree with each other and still describe something ` +
      `nobody audited. Do not send capital to this address. If it was built with the other ` +
      `solidity profile, re-run this command with "--build-profile production"; hardhat compiles ` +
      `before it runs a script and keeps only the last-built profile's artifacts, so the profile ` +
      `has to be chosen on the command itself rather than by a separate compile`,
  );
}

/// Collects the local build artifacts a deployed contract's runtime code may match.
///
/// There is exactly one source: the hardhat build output in this checkout. No environment
/// variable adds a candidate. An added candidate controls both sides of the comparison —
/// its `deployedBytecode` is what the chain code is compared against AND its
/// `immutableReferences` decide which bytes are ignored on both sides — so an
/// externally-supplied artifact can always be made to match, which makes the whole check
/// decorative. Hardhat 3 writes every build profile to the same `artifacts/` tree and
/// recompiles with the profile of the command being run, so verifying against the other
/// profile means passing `--build-profile` to the command itself; that is what the mismatch
/// error says.
export function readLocalBuildArtifacts(
  subject: VerifiedContract = VERIFIED_POOL,
  buildOutput: string = subject.artifactFile,
): BuildCandidate[] {
  if (!existsSync(buildOutput)) {
    throw new Error(missingArtifactMessage([buildOutput], subject));
  }
  return [readBuildCandidate(buildOutput)];
}

function readBuildCandidate(file: string): BuildCandidate {
  const artifact = JSON.parse(readFileSync(file, "utf8")) as BuildArtifact;
  return { source: file, profile: describeBuildProfile(artifact), artifact };
}

function missingArtifactMessage(files: readonly string[], subject: VerifiedContract): string {
  return (
    `FATAL: no local build artifact for ${subject.name} was found` +
    `${files.length === 0 ? "" : ` (looked for ${files.join(", ")})`}. The ${subject.role}'s ` +
    `runtime code is verified against the contract this checkout builds, and that comparison ` +
    `cannot be skipped: run "npm run build" and re-run this command`
  );
}

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/// Names the solidity build profile that produced an artifact, by reading the optimizer
/// settings out of the build-info file the artifact points at. Reported alongside a match
/// so the participant knows which of `hardhat.config.ts`'s two profiles they just verified
/// against. Purely descriptive: a wrong or missing label cannot make a mismatch pass.
function describeBuildProfile(artifact: BuildArtifact): string {
  const buildInfoId = artifact.buildInfoId;
  if (buildInfoId === undefined) return "unknown (artifact records no buildInfoId)";
  const file = path.join(ARTIFACTS_ROOT, "build-info", `${buildInfoId}.json`);
  if (!existsSync(file)) return `unknown (no build-info at ${file})`;

  const buildInfo = JSON.parse(readFileSync(file, "utf8")) as {
    input?: { settings?: { optimizer?: { enabled?: boolean; runs?: number } } };
  };
  const optimizer = buildInfo.input?.settings?.optimizer;
  if (optimizer === undefined || optimizer.enabled !== true) return "default (optimizer disabled)";
  return `production (optimizer enabled, runs ${optimizer.runs ?? "unset"})`;
}

export async function assertBeaconMatchesExecutionChain(
  deployment: Pick<DeploymentRecord, "chainId">,
  liveConfig: Pick<PoolDeploymentConfig, "depositContract">,
  label: string,
  options: { optional?: boolean } = {},
): Promise<boolean> {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    if (options.optional) return false;
    throw new Error(`${label} requires BEACON_NODE_URL for mandatory beacon confirmation`);
  }

  const config = await fetchBeaconJson<BeaconDepositContractResponse>(
    beaconNodeUrl,
    "/eth/v1/config/deposit_contract",
    label,
  );
  requireBeaconDataEnvelope(config, "deposit contract config", label);
  const beaconChainId = parseBeaconUint64(config.data.chain_id, "deposit chain_id", label);
  if (beaconChainId !== BigInt(deployment.chainId)) {
    throw new Error(
      `${label} beacon deposit chain_id ${config.data.chain_id} does not match deployment chainId ` +
        deployment.chainId,
    );
  }

  if (!isAddress(config.data.address)) {
    throw new Error(`${label} beacon deposit contract address ${config.data.address} is invalid`);
  }
  if (config.data.address.toLowerCase() !== liveConfig.depositContract.toLowerCase()) {
    throw new Error(
      `${label} beacon deposit contract ${config.data.address} does not match pool depositContract ` +
        liveConfig.depositContract,
    );
  }

  // This catches endpoint misconfiguration; it does not authenticate a dishonest beacon node.
  return true;
}

/// Establishes that the head state contains NO validator for `pubkey`.
///
/// Absence has to be proven positively. The single-validator endpoint answers 404 for a
/// pubkey it does not know, but it also answers 404 for a misspelled path, a URL whose
/// base path was discarded, a state id the node has pruned, a proxy that does not route
/// this method, and an endpoint that is not a beacon node at all. Reading any of those as
/// "the pubkey is free" is how the operator ends up predepositing to a validator that
/// already exists with somebody else's withdrawal credentials.
///
/// So this queries the LIST endpoint, which answers 200 with an entry per validator it
/// knows, and requires an empty `data` array. A non-empty array is the existing fatal. A
/// non-200, a body that is not a list, or anything else is fatal as INCONCLUSIVE — the
/// question was not answered, which is not the same as answered "no".
export async function assertBeaconValidatorAbsent(pubkey: Hex, label: string) {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  await assertBeaconNodeHealthy(beaconNodeUrl, label);

  const url = beaconApiUrl(beaconNodeUrl, `/eth/v1/beacon/states/${HEAD_STATE_ID}/validators`);
  url.searchParams.set("id", pubkey);
  const response = await fetchBeacon(url, label);
  if (!response.ok) {
    throw new Error(
      `${label} beacon validator lookup returned ${response.status} ${response.statusText}; the ` +
        `head state's validator list was not read, so the pubkey's absence is INCONCLUSIVE. A ` +
        `404 in particular is not proof of absence — it is also what a wrong path, a wrong base ` +
        `URL, or an endpoint that is not a beacon node returns. Fix BEACON_NODE_URL and re-run`,
    );
  }

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(
      `${label} beacon validator list response has no data array (${describeBeaconValue(body.data)}); ` +
        `the pubkey's absence is inconclusive`,
    );
  }
  if (body.data.length !== 0) {
    const first = asBeaconObject(body.data[0], "validator list entry", label);
    const validator = asBeaconObject(first.validator, "validator list entry validator", label);
    throw new Error(
      `${label} beacon preflight failed: validator ${pubkey} already exists in head state with ` +
        `status ${describeBeaconValue(first.status)} and withdrawal_credentials ` +
        describeBeaconValue(validator.withdrawal_credentials),
    );
  }

  console.log(
    `${label} beacon preflight passed: the head state validator list is empty for this pubkey`,
  );
}

export async function readBeaconGenesisForkVersion(label: string): Promise<Hex> {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  await assertBeaconNodeHealthy(beaconNodeUrl, label);
  const genesis = await fetchBeaconJson<BeaconGenesisResponse>(
    beaconNodeUrl,
    "/eth/v1/beacon/genesis",
    label,
  );
  requireBeaconDataEnvelope(genesis, "genesis", label);
  return normalizeHexLength(genesis.data.genesis_fork_version, 4, "genesis_fork_version").toLowerCase() as Hex;
}

async function assertBeaconValidatorHasWithdrawalCredentialsAtUrl(
  beaconNodeUrl: string,
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
): Promise<BeaconValidatorPreflight> {
  const preflight = await readBeaconValidatorPreflight(
    beaconNodeUrl,
    pubkey,
    CONFIRMATION_STATE_ID,
    label,
  );
  assertBeaconValidatorWithdrawalCredentials(preflight, expectedWithdrawalCredentials, label);
  printBeaconPreflight(label, preflight);
  console.log(`${label} beacon confirmation passed: validator has pool withdrawal credentials`);
  return preflight;
}

// The fund and top-up legs run the identical preflight. Both names are kept so call sites stay
// labeled with the operation the operator actually ran.
//
// `testOnlyConfirmationReader` exists so the tests can drive the interactive excess-balance
// confirmation without a terminal. It is not an authority boundary and grants a caller nothing:
// any importer of this module could skip the preflight altogether. The supported commands never
// pass it, so a real run always reads a real TTY.
/// Both return the head-state balance in Gwei the preflight settled on, which is what
/// `assertBeaconValidatorStillFresh` requires to still hold immediately before broadcast.
export async function assertBeaconValidatorReadyForTopUp(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  testOnlyConfirmationReader?: ExcessBalanceConfirmationReader,
): Promise<bigint> {
  return assertBeaconValidatorIsFreshPredeposit(
    pubkey,
    expectedWithdrawalCredentials,
    label,
    testOnlyConfirmationReader,
  );
}

export async function assertBeaconValidatorReadyForFunding(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  testOnlyConfirmationReader?: ExcessBalanceConfirmationReader,
): Promise<bigint> {
  return assertBeaconValidatorIsFreshPredeposit(
    pubkey,
    expectedWithdrawalCredentials,
    label,
    testOnlyConfirmationReader,
  );
}

/// Re-runs the head-state preflight immediately before a transaction is broadcast, and
/// requires the balance to be exactly what the full preflight settled on.
///
/// Between that preflight and the broadcast sit the funding review, the final on-chain
/// re-read, and — on the Ledger path — however long the operator takes to approve on the
/// device. That is minutes during which anyone may deposit to the committed pubkey, or the
/// validator may be slashed or activated. This shrinks the window to seconds. It cannot
/// close it: see the residual-risk entry in `SECURITY.md` §5 for the remainder, which runs
/// from this check to inclusion and cannot be checked from here at all.
///
/// A changed balance is fatal rather than a fresh prompt. An excess balance is resolvable,
/// but only by a person reading the current number, which is what re-running the command
/// gives them.
export async function assertBeaconValidatorStillFresh(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  expectedBalanceGwei: bigint,
): Promise<void> {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  const balanceGwei = await assertFreshPredepositHeadState(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    `${label} pre-broadcast`,
    { compact: true },
  );
  if (balanceGwei !== expectedBalanceGwei) {
    throw new Error(
      `${label} head beacon validator balance changed from ${expectedBalanceGwei} Gwei at the ` +
        `preflight to ${balanceGwei} Gwei immediately before broadcast; nothing was sent. Re-run ` +
        `this command so the preflight decides on the state that exists now`,
    );
  }
  console.log(
    `${label} pre-broadcast head recheck passed: balance still ${balanceGwei} Gwei, credentials, ` +
      `slashing flag, and all four epochs unchanged`,
  );
}

async function assertBeaconValidatorIsFreshPredeposit(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  testOnlyConfirmationReader: ExcessBalanceConfirmationReader = stdinConfirmationReader(),
): Promise<bigint> {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  await assertBeaconValidatorHasWithdrawalCredentialsAtUrl(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    label,
  );

  const balanceGwei = await assertFreshPredepositHeadState(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    `${label} head`,
  );
  if (balanceGwei <= PREDEPOSIT_GWEI) {
    console.log(`${label} head beacon fresh-predeposit preflight passed`);
    return balanceGwei;
  }

  await confirmExcessBalance(balanceGwei, label, testOnlyConfirmationReader);

  // The operator can sit at that prompt for minutes, and the validator's consensus state
  // does not hold still while they do. Re-run the entire head-state preflight against a
  // fresh fetch — node health, credentials, slashing, all four epochs, balance — and then
  // require the balance to be exactly the value that was confirmed. Anything else means the
  // confirmation was about a state that no longer exists.
  const reReadBalanceGwei = await assertFreshPredepositHeadState(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    `${label} head re-read`,
  );
  if (reReadBalanceGwei !== balanceGwei) {
    throw new Error(
      `${label} head beacon validator balance changed from the confirmed ${balanceGwei} Gwei to ` +
        `${reReadBalanceGwei} Gwei between the confirmation and the re-read; nothing was sent. ` +
        `Re-run this command and confirm the balance it observes then`,
    );
  }

  console.log(
    `${label} head beacon fresh-predeposit preflight passed WITH an interactively confirmed ` +
      `excess balance of ${balanceGwei} Gwei`,
  );
  return balanceGwei;
}

/// Fetches head state fresh and runs the whole fresh-predeposit preflight over it, returning
/// the head-state balance in Gwei. `compact` skips the field-by-field printout; it asserts
/// exactly the same things.
async function assertFreshPredepositHeadState(
  beaconNodeUrl: string,
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  options: { compact?: boolean } = {},
): Promise<bigint> {
  const preflight = await readBeaconValidatorPreflight(beaconNodeUrl, pubkey, HEAD_STATE_ID, label);
  assertBeaconValidatorWithdrawalCredentials(preflight, expectedWithdrawalCredentials, label);
  const balanceGwei = assertFreshPredepositMutableState(preflight, label);
  if (options.compact !== true) printBeaconPreflight(label, preflight);
  return balanceGwei;
}

// Returns the head-state balance in Gwei. A balance above the 1 ETH predeposit is not returned as
// an anomaly: it is the one condition the caller may resolve with an interactive typed
// confirmation, and only once every other assertion here has passed.
function assertFreshPredepositMutableState(
  preflight: BeaconValidatorPreflight,
  label: string,
): bigint {
  const { balance, validator } = preflight.validator;
  const balanceGwei = parseBeaconUint64(balance, "validator balance", label);
  if (balanceGwei < PREDEPOSIT_GWEI) {
    throw new Error(
      `${label} beacon validator balance ${balance} is below the ${PREDEPOSIT_GWEI} Gwei predeposit`,
    );
  }
  if (requireBeaconBoolean(validator.slashed, "validator slashed", label)) {
    throw new Error(`${label} beacon validator is slashed`);
  }
  for (const field of BEACON_EPOCH_FIELDS) {
    const value = validator[field];
    parseBeaconUint64(value, `validator ${field}`, label);
    if (value !== FAR_FUTURE_EPOCH) {
      throw new Error(`${label} beacon validator ${field} ${value} is not FAR_FUTURE_EPOCH`);
    }
  }
  return balanceGwei;
}

/// Terminal interface behind the excess-balance confirmation. Injectable for tests only; see
/// `assertBeaconValidatorReadyForTopUp`.
export interface ExcessBalanceConfirmationReader {
  isTty: () => boolean;
  readLine: (prompt: string) => Promise<string>;
}

function stdinConfirmationReader(): ExcessBalanceConfirmationReader {
  return {
    isTty: () => process.stdin.isTTY === true,
    readLine: async (prompt: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}

// The excess-balance confirmation has no non-interactive form. There is no environment
// variable, flag, or acknowledgement string that stands in for it: a human must read the
// observed balance and type it back on a terminal. Ordinary non-TTY execution — a pipe, cron,
// CI — is rejected outright. It is not proof against the machine's owner: a deliberate PTY
// wrapper (expect, script) can drive any interactive program. The check stops accidents and
// ambient automation, which is what it is for.
async function confirmExcessBalance(
  balanceGwei: bigint,
  label: string,
  reader: ExcessBalanceConfirmationReader,
) {
  console.warn(
    `\n${label}: HEAD BEACON VALIDATOR HAS AN EXCESS BALANCE OF ${balanceGwei} Gwei ` +
      `(expected the ${PREDEPOSIT_GWEI} Gwei predeposit).\n` +
      `  Cause: anyone may deposit to a committed pubkey permissionlessly, so a third party can ` +
      `raise this balance at will.\n` +
      `  Custody impact: none. Withdrawal credentials are fixed at validator creation and every ` +
      `later deposit for an existing pubkey only increases balance, so all of this ETH is ` +
      `withdrawable solely to the pool.\n` +
      `  Remaining impact: activation timing and economics only. An excess balance is uncredited ` +
      `external capital that this pool never distributes to the depositor.\n` +
      `  Every other assertion passed: credentials match at both states, the validator is ` +
      `unslashed, and all four epochs are FAR_FUTURE_EPOCH.\n`,
  );

  if (!reader.isTty()) {
    throw new Error(
      `${label} excess head beacon balance ${balanceGwei} Gwei requires an interactive typed ` +
        `confirmation, but stdin is not a TTY; re-run this command on a terminal`,
    );
  }

  const answer = (
    await reader.readLine(`${label}: type the exact balance in Gwei to continue: `)
  ).trim();
  if (answer !== balanceGwei.toString()) {
    throw new Error(
      `${label} excess-balance confirmation failed: expected the exact observed balance ` +
        `${balanceGwei}, got "${answer}"`,
    );
  }
}

export async function assertBeaconValidatorReadyForExit(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
) {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    // Both documents call this a warning, and it is one: the exit request will be sent
    // without any check that the validator is active, unexited, unslashed, and old enough
    // for consensus to honour it. A `console.log` put that on the same channel as every
    // routine success line.
    console.warn(
      `WARNING: skipping ${label} beacon exit preflight because BEACON_NODE_URL is not set. ` +
        `The exit request will be sent with the validator's consensus state unchecked; the ` +
        `EIP-7002 fee is spent either way`,
    );
    return;
  }

  const [preflight, spec] = await Promise.all([
    readBeaconValidatorPreflight(beaconNodeUrl, pubkey, HEAD_STATE_ID, label),
    fetchBeaconJson<BeaconSpecResponse>(beaconNodeUrl, "/eth/v1/config/spec", label),
  ]);
  assertBeaconValidatorWithdrawalCredentials(preflight, expectedWithdrawalCredentials, label);

  const { validator } = preflight.validator;
  if (validator.slashed) {
    throw new Error(`${label} beacon validator is slashed`);
  }
  if (validator.exit_epoch !== FAR_FUTURE_EPOCH) {
    throw new Error(`${label} beacon validator exit_epoch ${validator.exit_epoch} is not FAR_FUTURE_EPOCH`);
  }
  if (preflight.validator.status !== "active_ongoing") {
    throw new Error(`${label} beacon validator status is ${preflight.validator.status}, expected active_ongoing`);
  }

  const slotsPerEpoch = beaconSpecUint(spec, "SLOTS_PER_EPOCH", label);
  if (slotsPerEpoch === 0n) {
    throw new Error(`${label} beacon spec SLOTS_PER_EPOCH is 0; no epoch can be derived from it`);
  }
  const shardCommitteePeriod = beaconSpecUint(spec, "SHARD_COMMITTEE_PERIOD", label);
  const headSlot = parseBeaconUint64(preflight.syncing.head_slot, "node head_slot", label);
  const activationEpoch = parseBeaconUint64(validator.activation_epoch, "validator activation_epoch", label);
  const currentEpoch = headSlot / slotsPerEpoch;
  const exitEligibleEpoch = activationEpoch + shardCommitteePeriod;
  if (currentEpoch < exitEligibleEpoch) {
    throw new Error(
      `${label} beacon validator is not exit-eligible until epoch ${exitEligibleEpoch} ` +
        `(current epoch ${currentEpoch})`,
    );
  }

  printBeaconPreflight(label, preflight);
  console.log(`${label} beacon current epoch: ${currentEpoch}`);
  console.log(`${label} beacon SHARD_COMMITTEE_PERIOD: ${shardCommitteePeriod}`);
  console.log(`${label} beacon exit preflight passed`);
}

function assertBeaconValidatorWithdrawalCredentials(
  preflight: BeaconValidatorPreflight,
  expectedWithdrawalCredentials: Hex,
  label: string,
) {
  const actualCredentials = preflight.validator.validator.withdrawal_credentials.toLowerCase();
  if (actualCredentials !== expectedWithdrawalCredentials.toLowerCase()) {
    throw new Error(
      `${label} beacon withdrawal_credentials ${actualCredentials} != pool ${expectedWithdrawalCredentials}`,
    );
  }
}

/// Spec constants are decided on exactly like validator fields are, so they are parsed
/// exactly like validator fields: canonical unsigned decimal, within uint64. A bare
/// `BigInt` here accepted `"0x20"` and `" 32 "`, and `""` — which is `0n` — would have made
/// `SLOTS_PER_EPOCH` a division by zero.
function beaconSpecUint(spec: BeaconSpecResponse, key: string, label: string): bigint {
  const value = spec.data?.[key];
  if (value === undefined) {
    throw new Error(`${label} beacon spec is missing ${key}`);
  }
  return parseBeaconUint64(value, `spec ${key}`, label);
}

async function readBeaconValidatorPreflight(
  beaconNodeUrl: string,
  pubkey: Hex,
  stateId: string,
  label: string,
): Promise<BeaconValidatorPreflight> {
  const [syncing, genesis, finality, validator] = await Promise.all([
    assertBeaconNodeHealthy(beaconNodeUrl, label),
    fetchBeaconJson<BeaconGenesisResponse>(beaconNodeUrl, "/eth/v1/beacon/genesis", label),
    fetchBeaconJson<BeaconFinalityCheckpointsResponse>(
      beaconNodeUrl,
      `/eth/v1/beacon/states/${stateId}/finality_checkpoints`,
      label,
    ),
    fetchBeaconJson<BeaconValidatorResponse>(
      beaconNodeUrl,
      `/eth/v1/beacon/states/${stateId}/validators/${pubkey}`,
      label,
    ),
  ]);

  requireBeaconDataEnvelope(genesis, "genesis", label);
  requireBeaconDataEnvelope(finality, `${stateId} finality checkpoints`, label);
  requireBeaconDataEnvelope(validator, `${stateId} validator`, label);

  return {
    stateId,
    genesis: genesis.data,
    syncing,
    finality: finality.data,
    validator: assertBeaconValidatorResponseShape(validator.data, label, pubkey),
  };
}

async function assertBeaconNodeHealthy(beaconNodeUrl: string, label: string): Promise<BeaconSyncingResponse["data"]> {
  const response = await fetchBeaconJson<BeaconSyncingResponse>(beaconNodeUrl, "/eth/v1/node/syncing", label);
  const syncing = assertBeaconSyncingResponseShape(response.data, label);
  if (syncing.is_syncing) {
    throw new Error(`${label} beacon node is syncing: distance ${syncing.sync_distance}`);
  }
  if (syncing.is_optimistic) {
    throw new Error(`${label} beacon node is optimistic; refusing to rely on beacon confirmation`);
  }
  if (syncing.el_offline) {
    throw new Error(`${label} beacon node reports execution layer offline`);
  }
  return syncing;
}

// ---------------------------------------------------------------------------
// Beacon response shape validation
//
// The declared TypeScript interfaces above describe what a conforming beacon node
// returns; they are erased at runtime and assert nothing about what an endpoint
// actually sends. Every beacon field a preflight makes a decision on is therefore
// validated here, at the parse boundary, and any violation is fatal and names the
// field. Fail closed: a missing, null, or wrongly typed value is never read as the
// safe value.
// ---------------------------------------------------------------------------

function describeBeaconValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  const described = JSON.stringify(value);
  return described ?? String(value);
}

function asBeaconObject(value: unknown, what: string, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} beacon ${what} ${describeBeaconValue(value)} is not an object`);
  }
  return value as Record<string, unknown>;
}

/// Beacon API integers arrive as JSON strings. Only a canonical unsigned decimal string
/// within uint64 is accepted. `BigInt` on its own also accepts `"0x3b9aca00"`,
/// `"+1000000000"` and `" 1000000000 "`; no conforming beacon node emits those, and each
/// compares unequal to the canonical form that the FAR_FUTURE_EPOCH and typed-confirmation
/// comparisons rely on.
function parseBeaconUint64(value: unknown, field: string, label: string): bigint {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(
      `${label} beacon ${field} ${describeBeaconValue(value)} is not a canonical unsigned ` +
        `decimal string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) {
    throw new Error(`${label} beacon ${field} ${value} exceeds the uint64 maximum ${UINT64_MAX}`);
  }
  return parsed;
}

function requireBeaconBoolean(value: unknown, field: string, label: string): boolean {
  if (value !== true && value !== false) {
    throw new Error(
      `${label} beacon ${field} ${describeBeaconValue(value)} is not the boolean true or false`,
    );
  }
  return value;
}

function requireBeaconString(value: unknown, field: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} beacon ${field} ${describeBeaconValue(value)} is not a string`);
  }
  return value;
}

function requireBeaconHex(value: unknown, bytes: number, field: string, label: string): string {
  const hex = requireBeaconString(value, field, label);
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(hex)) {
    throw new Error(`${label} beacon ${field} ${hex} is not a ${bytes}-byte 0x-prefixed hex string`);
  }
  return hex;
}

/// `requestedPubkey` is the pubkey the URL asked about. The response must echo it.
///
/// Nothing else in a preflight looks at which validator the body describes: credentials,
/// balance, slashing, and all four epochs are read from whatever came back. A proxy or a
/// misrouted endpoint that answers every validator query with one particular validator's
/// record therefore passes every one of those checks while describing a different
/// validator entirely.
function assertBeaconValidatorResponseShape(
  data: unknown,
  label: string,
  requestedPubkey: Hex,
): BeaconValidatorResponse["data"] {
  const response = asBeaconObject(data, "validator response", label);
  const validator = asBeaconObject(response.validator, "validator response validator", label);

  requireBeaconString(response.index, "validator index", label);
  requireBeaconString(response.status, "validator status", label);
  parseBeaconUint64(response.balance, "validator balance", label);
  const pubkey = requireBeaconHex(validator.pubkey, 48, "validator pubkey", label);
  if (pubkey.toLowerCase() !== requestedPubkey.toLowerCase()) {
    throw new Error(
      `${label} beacon validator response describes pubkey ${pubkey}, but ${requestedPubkey} was ` +
        `requested. Every other assertion in this preflight reads whatever validator came back, ` +
        `so a response about a different validator proves nothing about the one being funded`,
    );
  }
  requireBeaconHex(validator.withdrawal_credentials, 32, "validator withdrawal_credentials", label);
  requireBeaconBoolean(validator.slashed, "validator slashed", label);
  parseBeaconUint64(validator.effective_balance, "validator effective_balance", label);
  for (const field of BEACON_EPOCH_FIELDS) {
    parseBeaconUint64(validator[field], `validator ${field}`, label);
  }
  return data as BeaconValidatorResponse["data"];
}

function assertBeaconSyncingResponseShape(
  data: unknown,
  label: string,
): BeaconSyncingResponse["data"] {
  const syncing = asBeaconObject(data, "node syncing response", label);
  parseBeaconUint64(syncing.head_slot, "node head_slot", label);
  parseBeaconUint64(syncing.sync_distance, "node sync_distance", label);
  requireBeaconBoolean(syncing.is_syncing, "node is_syncing", label);
  requireBeaconBoolean(syncing.is_optimistic, "node is_optimistic", label);
  requireBeaconBoolean(syncing.el_offline, "node el_offline", label);
  return data as BeaconSyncingResponse["data"];
}

/// Builds a beacon API URL that preserves BOTH the path component and the query of
/// `BEACON_NODE_URL`.
///
/// Two ways to lose the endpoint, and both were live. `new URL("/eth/v1/...", base)` is
/// root-anchored and silently discards the base's path, so a hosted endpoint of the form
/// `https://host/eth-beacon-node/<key>` was rewritten to `https://host/eth/v1/...`.
/// Resolving a relative reference against a base ALSO discards the base's query, so
/// `https://host/prefix?apikey=<key>` lost the credential that makes the request work at
/// all — and a provider that authenticates by query parameter answers 401 or 404, which the
/// positive-absence check is explicitly written not to read as "the pubkey is free".
///
/// So the base is parsed first and the route is appended to its `pathname`, leaving
/// `searchParams` in place for route parameters like `id` to merge into. Only the fragment
/// is dropped: it is never sent to a server, and carrying it would put it after the query
/// of a URL it does not belong to.
export function beaconApiUrl(beaconNodeUrl: string, pathname: string): URL {
  const url = new URL(beaconNodeUrl);
  url.hash = "";
  const prefix = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}${pathname.replace(/^\/+/, "")}`;
  return url;
}

/// Every beacon read is on a capital path and every one of them blocks the command. An
/// endpoint that accepts the connection and then never answers would hang `fund` forever
/// with no output — indistinguishable, to the operator, from a slow node — so each request
/// is bounded and a timeout is a named failure.
const BEACON_REQUEST_TIMEOUT_MS = 30_000;

/// The identity of a request, for an error message. Deliberately origin and path only: the
/// query is where hosted providers put the API key, and an error message ends up in
/// terminals, logs, and pasted issue reports.
function describeBeaconRequest(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function fetchBeacon(url: URL, label: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(BEACON_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `${label} beacon request to ${describeBeaconRequest(url)} did not complete within ` +
        `${BEACON_REQUEST_TIMEOUT_MS}ms or failed outright (${
          error instanceof Error ? error.message : String(error)
        }); nothing was read, so nothing this preflight decides is established. Check ` +
        `BEACON_NODE_URL and the node's reachability, and re-run`,
    );
  }
}

async function fetchBeaconJson<T>(beaconNodeUrl: string, pathname: string, label: string): Promise<T> {
  const url = beaconApiUrl(beaconNodeUrl, pathname);
  const response = await fetchBeacon(url, label);
  if (!response.ok) {
    throw new Error(`${label} beacon request ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/// Fatal, naming the field, when a beacon response has no `data` object at all.
///
/// The per-field shape validators below start from `data`, so a body without one reached
/// them as `undefined` and produced a TypeError rather than a beacon-preflight failure —
/// and the three responses that had no field validation at all (the deposit-contract
/// config, genesis, and finality checkpoints) dereferenced it directly. An HTML error page,
/// a proxy's `{"error": ...}`, and an empty body all land here.
function requireBeaconDataEnvelope(response: unknown, what: string, label: string): void {
  const body = asBeaconObject(response, `${what} response`, label);
  if (!("data" in body)) {
    throw new Error(`${label} beacon ${what} response has no data field`);
  }
  asBeaconObject(body.data, `${what} response data`, label);
}

function requireBeaconNodeUrl(label: string): string {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    throw new Error(`${label} requires BEACON_NODE_URL for mandatory beacon confirmation`);
  }
  return beaconNodeUrl;
}

function printBeaconPreflight(label: string, preflight: BeaconValidatorPreflight) {
  const { genesis, syncing, finality, validator, stateId } = preflight;
  console.log(`${label} beacon state id: ${stateId}`);
  console.log(`${label} beacon genesis fork version: ${genesis.genesis_fork_version}`);
  console.log(`${label} beacon genesis validators root: ${genesis.genesis_validators_root}`);
  console.log(`${label} beacon head slot: ${syncing.head_slot}`);
  console.log(
    `${label} beacon finalized checkpoint: epoch ${finality.finalized.epoch} root ${finality.finalized.root}`,
  );
  console.log(`${label} validator index: ${validator.index}`);
  console.log(`${label} validator status: ${validator.status}`);
  console.log(`${label} validator balance: ${validator.balance} Gwei`);
  console.log(`${label} validator effective balance: ${validator.validator.effective_balance} Gwei`);
  console.log(`${label} validator slashed: ${validator.validator.slashed}`);
  console.log(
    `${label} validator activation eligibility epoch: ${validator.validator.activation_eligibility_epoch}`,
  );
  console.log(`${label} validator activation epoch: ${validator.validator.activation_epoch}`);
  console.log(`${label} validator exit epoch: ${validator.validator.exit_epoch}`);
  console.log(`${label} validator withdrawable epoch: ${validator.validator.withdrawable_epoch}`);
}

export function depositDataPath(): string {
  return process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE;
}

/// Reads the deposit-data file, announcing which file it came from.
///
/// The path is printed BEFORE the file is opened and it is printed unconditionally, exactly
/// as `readDeployment` announces the record. These are the two environment variables that
/// select the SUBJECT of the checks rather than waiving one: `DEPLOYMENT_FILE` chooses which
/// pool every check is about, and `DEPOSIT_DATA_FILE` chooses which validator. The file
/// supplies the pubkey `commit-predeposit` commits FOREVER, and the pubkey `fund` and
/// `top-up` require the on-chain commitment to equal — so a run against the wrong file is a
/// run about the wrong validator, and every check still reports a clean pass. An operator who
/// cannot see which file a command opened cannot tell the two apart.
export function readDepositDataFile(file = depositDataPath()): DepositData[] {
  console.log(`Deposit data file: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as DepositData[];
}

export function readPredepositAndTopUpDepositData(
  file = depositDataPath(),
): { predeposit: DepositData; topUp: DepositData } {
  const deposits = readDepositDataFile(file);
  const predeposit = deposits.find((deposit) => BigInt(deposit.amount) === PREDEPOSIT_GWEI);
  const topUp = deposits.find((deposit) => BigInt(deposit.amount) === TOP_UP_GWEI);
  if (predeposit === undefined || topUp === undefined) {
    throw new Error(
      `Expected deposit data entries for ${PREDEPOSIT_GWEI} Gwei and ${TOP_UP_GWEI} Gwei in ${file}`,
    );
  }
  return { predeposit, topUp };
}

/// Requires the pool's own `PREDEPOSIT_WEI` to equal the local constant.
///
/// `commit-predeposit` used to send `{ value: await pool.read.PREDEPOSIT_WEI() }`, which
/// let the amount of ETH the transaction carries be chosen by an RPC response. It was safe
/// only because `assertDeploymentIntegrity` had already compared the pool's runtime code
/// against the local build — an argument about a different check, made about a value on the
/// capital path, one refactor away from not holding.
///
/// The amount is now the local constant and the chain's value is asserted against it. A
/// divergence is fatal rather than followed: the audited contract declares
/// `PREDEPOSIT_WEI = 1 ether`, so a pool reporting anything else is not that contract, and
/// the deployment record names something other than what the operator thinks it does.
export function assertContractPredepositWei(chainPredepositWei: bigint, label: string) {
  if (chainPredepositWei === PREDEPOSIT_WEI) return;
  throw new Error(
    `${label}: the pool reports PREDEPOSIT_WEI ${formatWei(chainPredepositWei)}, but the audited ` +
      `contract declares ${formatWei(PREDEPOSIT_WEI)}. Nothing has been sent. A pool that does ` +
      `not agree on the predeposit amount is not the contract this checkout builds, so the ` +
      `deployment record ${deploymentPath()} names something else; do not send capital to it`,
  );
}

/// Requires the pool's committed pubkey to equal the local deposit-data file's predeposit
/// pubkey, and returns the LOCAL value for the caller's preflight to run against.
///
/// `top-up` reads `committedPubkey()` from the EL RPC and used to hand that value straight
/// to the beacon preflight with nothing local to check it against. That let the untrusted
/// endpoint choose the preflight's SUBJECT: an RPC answering with some other validator's
/// pubkey gets that validator checked for credentials, slashing, epochs and balance, every
/// assertion passes, and the 31 ETH goes to a validator none of it was about. `fund` never
/// had the gap — it validates the deposit-data file and requires the on-chain commitment to
/// match it before any participant capital moves — and this is that same comparison at the
/// one remaining command that sends capital without it.
///
/// Which side is returned does not change what is asserted: they are equal by the time this
/// returns. Returning the local one is what makes the preflight's subject a file on the
/// operator's disk rather than a value the endpoint chose.
export function assertCommittedPubkeyMatchesLocal(
  committedPubkey: Hex,
  localPredeposit: DepositData,
  label: string,
): Hex {
  const localPubkey = normalizeHexLength(
    localPredeposit.pubkey,
    48,
    "deposit-data predeposit pubkey",
  );
  if (committedPubkey.toLowerCase() !== localPubkey.toLowerCase()) {
    throw new Error(
      `${label}: the pool reports committedPubkey ${committedPubkey}, but the local deposit-data ` +
        `file's 1 ETH predeposit entry is for ${localPubkey}. Nothing has been sent. One of the ` +
        `two does not describe this validator: check that DEPOSIT_DATA_FILE and DEPLOYMENT_FILE ` +
        `name the pair that belong together, and re-run`,
    );
  }
  return localPubkey;
}

/// Announces the validator `commit-predeposit` is about to bind this pool to, and evaluates
/// the one declaration that can independently check it.
///
/// `EXPECTED_PUBKEY` is to `DEPOSIT_DATA_FILE` exactly what `EXPECTED_POOL` is to
/// `DEPLOYMENT_FILE`, and for the same reason: the variable selects the SUBJECT of every
/// later check, silently, from the environment. On `fund` and `top-up` the file is pinned by
/// comparison instead — `assertCommittedPubkeyMatchesLocal` and `fund.ts`'s commitment
/// comparison require it to equal what the pool already committed. `commit-predeposit` is the
/// command that CREATES that commitment, so it has nothing on chain to compare against:
/// `committedPubkey()` is zero until this transaction lands, and whichever pubkey the file
/// names becomes the validator this pool funds for the rest of its life. A declaration is the
/// only independent check that exists here.
///
/// Unset it warns rather than refuses. The command is irreversible and it is the one an
/// operator runs immediately after generating keys, with the file in front of them; a
/// mandatory variable there buys a habit of setting it to whatever the file says, which
/// checks nothing. A malformed declaration is fatal naming the variable, because a pin that
/// cannot be parsed has not been declared and silently ignoring it reports a pass for a check
/// that never ran.
///
/// Returns the local file's pubkey, normalized — the value the caller commits.
export function assertExpectedPubkey(localPredepositPubkey: string, label: string): Hex {
  const pubkey = normalizeHexLength(
    localPredepositPubkey,
    48,
    "deposit-data predeposit pubkey",
  ).toLowerCase() as Hex;
  const file = depositDataPath();

  console.log(
    `\n${label} WILL COMMIT VALIDATOR ${pubkey}\n` +
      `  read from ${file}. The pool commits one pubkey and no path rewrites it.\n`,
  );

  const declared = process.env.EXPECTED_PUBKEY ?? "";
  if (declared === "") {
    console.warn(
      `WARNING: EXPECTED_PUBKEY is not set, so nothing independent of ${file} says that is the ` +
        `right validator.\n` +
        `  This command is IRREVERSIBLE: it creates the commitment, so unlike fund and top-up ` +
        `there is no on-chain value to compare the file against — committedPubkey() does not ` +
        `exist yet.\n` +
        `  DEPOSIT_DATA_FILE chose that file from the environment, and the pubkey in it selects ` +
        `this pool's validator forever. A stale or swapped file binds the pool to a validator ` +
        `whose keys you may not hold, and the operator's 1 ETH predeposit is not recoverable.\n` +
        `  Set EXPECTED_PUBKEY to the pubkey you generated and re-run to have it checked.\n`,
    );
    return pubkey;
  }

  const expected = parseExpectedPubkey(declared);
  if (pubkey !== expected) {
    throw new Error(
      `${label}: the deposit-data file ${file} would commit validator ${pubkey}, not the ` +
        `declared EXPECTED_PUBKEY ${expected}. Nothing has been sent. DEPOSIT_DATA_FILE selects ` +
        `which validator this pool is bound to for the rest of its life; point it at the file ` +
        `for the validator you mean and re-run`,
    );
  }
  console.log(`${label}: the pubkey above equals the declared EXPECTED_PUBKEY`);
  return pubkey;
}

/// The declaration itself: 48 bytes of hex, `0x` prefix optional because deposit-data files
/// are routinely written without one and the operator copies the value out of theirs.
function parseExpectedPubkey(declared: string): Hex {
  const pubkey = asHex(declared);
  if (!/^0x[0-9a-fA-F]{96}$/.test(pubkey)) {
    throw new Error(
      `EXPECTED_PUBKEY ${declared} is not a 48-byte BLS public key: 96 hex characters, with the ` +
        `0x prefix optional`,
    );
  }
  return pubkey.toLowerCase() as Hex;
}

/// The same comparison as `assertCommittedPubkeyMatchesLocal`, made only when there is a
/// local file to make it against.
///
/// `request-exit` reads `committedPubkey()` from the EL RPC and hands it to the beacon exit
/// preflight, so the endpoint chooses that preflight's SUBJECT exactly as it did on `top-up`
/// before that command gained the comparison. The deposit-data file is the local value to
/// check it against, and where the file is there this makes the identical check.
///
/// It does not become a hard dependency. `request-exit` is the recovery path — the one
/// command deliberately carved out of §4's "a live beacon endpoint is available" assumption,
/// because refusing there lets an unavailable dependency disable the escape hatch — and a
/// deposit-data file that is missing, unreadable, or malformed is the same class of
/// unavailability. So an unreadable file is a warning naming the reason, and the command
/// continues with the RPC's value. A file that IS readable and names a different validator is
/// fatal: that is not unavailability, it is two inputs that do not describe the same thing.
export function assertCommittedPubkeyMatchesLocalIfReadable(
  committedPubkey: Hex,
  label: string,
): Hex {
  let predeposit: DepositData;
  try {
    predeposit = readPredepositAndTopUpDepositData().predeposit;
  } catch (error) {
    console.warn(
      `WARNING: ${label} could not read the deposit-data file ${depositDataPath()} ` +
        `(${error instanceof Error ? error.message : String(error)}).\n` +
        `  Continuing with the committedPubkey() the EL RPC reported, unchecked. That value ` +
        `chooses which validator the exit preflight is about, so a wrong or dishonest endpoint ` +
        `chooses it here.\n` +
        `  This is a warning and not a refusal because ${label} is the recovery path: a missing ` +
        `local file must not be able to disable it. The EIP-7002 fee is spent either way.\n` +
        `  Point DEPOSIT_DATA_FILE at this validator's file and re-run to have the comparison ` +
        `made.\n`,
    );
    return committedPubkey;
  }
  return assertCommittedPubkeyMatchesLocal(committedPubkey, predeposit, label);
}

export function validateDepositData(
  deposit: DepositData,
  expectedWithdrawalCredentials: Hex,
  chainForkVersion: Hex,
  expectedPubkey?: Hex,
  expectedAmountGwei = VALIDATOR_DEPOSIT_GWEI,
) {
  const pubkey = normalizeHexLength(deposit.pubkey, 48, "pubkey");
  const withdrawalCredentials = normalizeHexLength(deposit.withdrawal_credentials, 32, "withdrawal_credentials");
  const signature = normalizeHexLength(deposit.signature, 96, "signature");
  const depositDataRoot = normalizeHexLength(deposit.deposit_data_root, 32, "deposit_data_root");
  const forkVersion = normalizeHexLength(deposit.fork_version ?? "", 4, "fork_version");
  const normalizedChainForkVersion = normalizeHexLength(chainForkVersion, 4, "genesis_fork_version");
  const amountGwei = BigInt(deposit.amount);

  if (amountGwei !== expectedAmountGwei) {
    throw new Error(`Deposit amount ${amountGwei} != expected ${expectedAmountGwei}`);
  }
  if (withdrawalCredentials.toLowerCase() !== expectedWithdrawalCredentials.toLowerCase()) {
    throw new Error(`Deposit withdrawal_credentials ${withdrawalCredentials} != pool ${expectedWithdrawalCredentials}`);
  }
  if (expectedPubkey !== undefined && pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) {
    throw new Error(`Deposit pubkey ${pubkey} != expected ${expectedPubkey}`);
  }

  const recomputedRoot = computeDepositDataRoot(pubkey, withdrawalCredentials, amountGwei, signature);
  if (recomputedRoot.toLowerCase() !== depositDataRoot.toLowerCase()) {
    throw new Error(`Deposit data root ${depositDataRoot} != recomputed ${recomputedRoot}`);
  }
  if (forkVersion.toLowerCase() !== normalizedChainForkVersion.toLowerCase()) {
    throw new Error(
      `Deposit fork_version ${forkVersion} != beacon genesis_fork_version ${normalizedChainForkVersion}`,
    );
  }
  if (!verifyDepositSignature(pubkey, withdrawalCredentials, amountGwei, signature, normalizedChainForkVersion)) {
    throw new Error("Invalid BLS deposit signature");
  }

  const expectedNetworkName = process.env.DEPOSIT_NETWORK_NAME;
  if (expectedNetworkName && deposit.network_name !== expectedNetworkName) {
    throw new Error(`Deposit network_name ${deposit.network_name ?? "<missing>"} != expected ${expectedNetworkName}`);
  }

  return {
    pubkey,
    withdrawalCredentials,
    signature,
    depositDataRoot,
    amountGwei,
    forkVersion: normalizedChainForkVersion,
  };
}

function normalizeHexLength(value: string, bytes: number, field: string): Hex {
  const hex = asHex(value);
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${field} is not hex`);
  }
  if ((hex.length - 2) / 2 !== bytes) {
    throw new Error(`${field} must be ${bytes} bytes`);
  }
  return hex;
}

export function computeDepositDataRoot(pubkey: Hex, withdrawalCredentials: Hex, amountGwei: bigint, signature: Hex): Hex {
  return toHex(
    ssz.phase0.DepositData.hashTreeRoot({
      pubkey: fromHex(pubkey),
      withdrawalCredentials: fromHex(withdrawalCredentials),
      amount: gweiToNumber(amountGwei),
      signature: fromHex(signature),
    }),
  );
}

export function computeDepositSigningRoot(
  pubkey: Hex,
  withdrawalCredentials: Hex,
  amountGwei: bigint,
  forkVersion: Hex,
): Hex {
  const depositMessageRoot = ssz.phase0.DepositMessage.hashTreeRoot({
    pubkey: fromHex(pubkey),
    withdrawalCredentials: fromHex(withdrawalCredentials),
    amount: gweiToNumber(amountGwei),
  });
  const domain = computeDepositDomain(forkVersion);
  return toHex(ssz.phase0.SigningData.hashTreeRoot({ objectRoot: depositMessageRoot, domain }));
}

function verifyDepositSignature(
  pubkey: Hex,
  withdrawalCredentials: Hex,
  amountGwei: bigint,
  signature: Hex,
  forkVersion: Hex,
): boolean {
  const signingRoot = computeDepositSigningRoot(pubkey, withdrawalCredentials, amountGwei, forkVersion);
  try {
    const publicKey = PublicKey.fromBytes(fromHex(pubkey), true);
    const depositSignature = Signature.fromBytes(fromHex(signature), true);
    return verify(fromHex(signingRoot), publicKey, depositSignature);
  } catch {
    return false;
  }
}

function computeDepositDomain(forkVersion: Hex): Uint8Array {
  const forkDataRoot = ssz.phase0.ForkData.hashTreeRoot({
    currentVersion: fromHex(forkVersion),
    genesisValidatorsRoot: fromHex(ZERO_ROOT),
  });
  const domain = new Uint8Array(32);
  domain.set(DOMAIN_DEPOSIT, 0);
  domain.set(forkDataRoot.subarray(0, 28), 4);
  return domain;
}

function fromHex(value: Hex): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function toHex(value: Uint8Array): Hex {
  return `0x${Buffer.from(value).toString("hex")}` as Hex;
}

function gweiToNumber(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Gwei amount ${value} is too large for SSZ number encoding`);
  }
  return amount;
}

export function formatWei(value: bigint): string {
  return `${value} wei (${formatEther(value)} ETH)`;
}

// ---------------------------------------------------------------------------
// Funding path selection and the final on-chain re-read
//
// These two live here rather than in `scripts/fund.ts` so they can be tested:
// every script file runs `main()` on import, so importing one from a test would
// execute the command.
// ---------------------------------------------------------------------------

const STATE_FUNDING = 2;

/// Plain transfers are the clear-signing path: a Ledger renders destination and
/// amount for a zero-calldata transfer, where `fund()` calldata is blind-signed.
/// Defaults on whenever the connection signs with a Ledger; `FUND_VIA_TRANSFER`
/// forces it on (`1`) or off (`0`) on any network.
///
/// The two paths are identical in every pool state but one; see "Plain-Transfer Funding —
/// The One Divergence" in `README.md` for the window in which the transfer path is
/// accepted as pool proceeds where `fund()` would have reverted.
export function fundViaPlainTransfer(networkConfig: { ledgerAccounts?: readonly string[] }): boolean {
  const override = process.env.FUND_VIA_TRANSFER;
  if (override === "1") return true;
  if (override === "0") return false;
  if (override !== undefined && override !== "") {
    throw new Error(`FUND_VIA_TRANSFER must be 0 or 1, got ${override}`);
  }
  return (networkConfig.ledgerAccounts ?? []).length > 0;
}

/// The two pool events that tell apart the only two things the pool can do with ETH sent to
/// it on the funding path. `ValidatorFundingPool.sol:117-123` and `:139`; `_fund` emits the
/// first (`:586-592`) on both the `fund()` and the plain-transfer route, and `receive()`
/// emits the second (`:256`) when it accepts ETH as post-top-up proceeds instead.
const POOL_FUNDING_EVENTS_ABI = [
  {
    type: "event",
    name: "ParticipantFunded",
    inputs: [
      { name: "attempt", type: "uint256", indexed: true },
      { name: "participant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "participantTotal", type: "uint256", indexed: false },
      { name: "attemptTotal", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EthReceivedViaCall",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/// The receipt fields the funding credit check reads. A subset of viem's
/// `TransactionReceipt`, so a real receipt satisfies it structurally.
export interface ObservedLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

/// Requires the mined funding receipt to prove the ETH was CREDITED, not merely accepted.
///
/// A successful receipt from the right sender is not evidence that funding happened. The
/// pool's `receive()` accepts ETH in the `ToppedUp` state as pool proceeds and emits
/// `EthReceivedViaCall` instead of crediting the sender — the transaction succeeds, the
/// balance moves, and the sender recovers only their pro-rata share. Both plain-transfer
/// routes into that state (the double-send race and the lying-EL-RPC route, `SECURITY.md`
/// §5, "The `ToppedUp` plain-transfer race") end in exactly this receipt, and every
/// pre-broadcast check read the same endpoint that let it happen. The receipt itself is the
/// one piece of evidence that does not come from a fresh read: it is authoritative about
/// what the pool did, and immune to an endpoint that would lie about it afterwards.
///
/// This is detection, not prevention — the ETH has already moved. It converts a silent
/// donation into a loud, named failure at the moment it happens.
export function assertFundingWasCredited(
  receipt: { logs: readonly ObservedLog[] },
  poolAddress: Address,
  signer: Address,
  amount: bigint,
  label: string,
): void {
  const credited: bigint[] = [];
  const acceptedAsProceeds: bigint[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
    let decoded: ReturnType<typeof decodeEventLog<typeof POOL_FUNDING_EVENTS_ABI>>;
    try {
      decoded = decodeEventLog({
        abi: POOL_FUNDING_EVENTS_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      // Any other pool event, `AccountingSnapshot` above all, is not this decision's
      // business.
      continue;
    }
    if (
      decoded.eventName === "ParticipantFunded" &&
      decoded.args.participant.toLowerCase() === signer.toLowerCase()
    ) {
      credited.push(decoded.args.amount);
    }
    if (
      decoded.eventName === "EthReceivedViaCall" &&
      decoded.args.sender.toLowerCase() === signer.toLowerCase()
    ) {
      acceptedAsProceeds.push(decoded.args.amount);
    }
  }

  if (credited.length === 1 && credited[0] === amount) {
    console.log(
      `${label} credit confirmed from the receipt: the pool emitted ParticipantFunded for ` +
        `${signer} with exactly ${formatWei(amount)}`,
    );
    return;
  }

  const whatHappened =
    acceptedAsProceeds.length > 0
      ? `the pool emitted EthReceivedViaCall for ${signer} (${acceptedAsProceeds
          .map(formatWei)
          .join(", ")}) and no ParticipantFunded. The ETH was accepted as POST-TOP-UP ` +
        `PROCEEDS, not as credited funding: it is now shared pro rata by final credited ` +
        `weight, and ${signer} recovers only their own share of it through claim()`
      : credited.length === 0
        ? `the pool emitted no ParticipantFunded for ${signer} at all`
        : `the pool credited ${credited.map(formatWei).join(", ")} to ${signer}, not the ` +
          `${formatWei(amount)} that was sent`;

  throw new Error(
    `FATAL: ${label} transaction succeeded but the ${formatWei(amount)} it sent was NOT ` +
      `credited as funding. Reading the receipt's own logs, ${whatHappened}. The transaction is ` +
      `already on chain: this check DETECTS an uncredited transfer, it cannot prevent one. Run ` +
      `"npm run status" and reconcile the pool's actual state — activeFundedWeiOf, ` +
      `refundableWeiOf, and claimable for ${signer} — before sending anything else`,
  );
}

/// `FeeRecipientForwarder.sol:13`. `sweep()` emits it with the whole balance it is about to
/// forward, immediately before the transfer, so a receipt carrying it states the amount the
/// forwarder actually sent — a fact that does not come from a fresh read of the endpoint.
const FORWARDER_SWEPT_EVENT_ABI = [
  {
    type: "event",
    name: "Swept",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface SweepBalances {
  /// The forwarder's balance in the block before the sweep: what the sweep had to move.
  forwarderBefore: bigint;
  /// The pool's balance in the block before the sweep, and in the sweep's own block.
  poolBefore: bigint;
  poolAfter: bigint;
}

/// Requires the mined sweep to prove the ETH REACHED THE POOL, not merely that a transaction
/// succeeded.
///
/// `sweep` is the second command that moves ETH into the pool, and until now it was the only
/// one that took the receipt's success as the end of the story: it printed the forwarder's
/// balance before, the pool's balance after, and asserted nothing about the relationship
/// between them. `assertFundingWasCredited` is the pattern this follows — a successful
/// receipt from the right sender says a transaction executed, not that it did what the
/// command was for.
///
/// Two independent pieces of evidence are used, and both come from the chain's own record of
/// the transaction rather than from a later read. The receipt's `Swept` log says what the
/// forwarder sent. The pool's balance across the sweep's own block says what the pool
/// received. Comparing the second against the forwarder's pre-sweep balance is what catches a
/// forwarder whose `sweep()` sends somewhere else, or sends part.
///
/// A delta ABOVE the pre-sweep balance is not a failure: the forwarder is a validator's
/// `fee_recipient` and a block it proposed may pay into it between the balance read and the
/// sweep. That case is reported, with both numbers, rather than passed silently.
///
/// This is detection, not prevention — the ETH has already moved.
export function assertSweepWasCredited(
  receipt: { logs: readonly ObservedLog[] },
  forwarderAddress: Address,
  poolAddress: Address,
  signer: Address,
  balances: SweepBalances,
  label: string,
): void {
  const swept = sweptAmounts(receipt, forwarderAddress, signer);
  if (swept.length !== 1) {
    throw new Error(
      `FATAL: ${label} transaction succeeded but the forwarder at ${forwarderAddress} emitted ` +
        `${swept.length === 0 ? "no Swept event for" : `${swept.length} Swept events for`} ` +
        `${signer}. sweep() emits exactly one, with the whole balance it forwards, immediately ` +
        `before the transfer, so this transaction did not do what the command is for. Run ` +
        `"npm run status" and reconcile the forwarder's and the pool's balances before ` +
        `re-running ${label}`,
    );
  }

  const sweptAmount = swept[0];
  const delta = balances.poolAfter - balances.poolBefore;
  if (delta < balances.forwarderBefore) {
    throw new Error(
      `FATAL: ${label} transaction succeeded but the pool at ${poolAddress} is only ` +
        `${formatWei(delta)} richer across the block that included it, against the ` +
        `${formatWei(balances.forwarderBefore)} the forwarder at ${forwarderAddress} held going ` +
        `in (its Swept event says it forwarded ${formatWei(sweptAmount)}). The ETH is already ` +
        `gone from the forwarder: this check DETECTS a sweep that did not land in the pool, it ` +
        `cannot prevent one. Either the forwarder's code sends somewhere other than the pool it ` +
        `reports — which is what the runtime-code check exists to catch, so treat a shortfall ` +
        `here as a finding about this deployment — or something else in the same block moved ETH ` +
        `out of the pool. Run "npm run status", reconcile the pool's balance and ` +
        `grossPoolProceeds against the mined transaction, and do not re-run ${label} until you ` +
        `know which`,
    );
  }

  if (delta > balances.forwarderBefore) {
    console.log(
      `${label} credited ${formatWei(delta)} to the pool, more than the ` +
        `${formatWei(balances.forwarderBefore)} the forwarder held when this command read it: ` +
        `${formatWei(sweptAmount)} was forwarded, so ETH arrived at the forwarder between the ` +
        `read and the sweep, which is exactly what a fee recipient does`,
    );
    return;
  }

  console.log(
    `${label} credit confirmed: the forwarder's Swept event reports ${formatWei(sweptAmount)} ` +
      `forwarded, and the pool's balance rose by exactly the ` +
      `${formatWei(balances.forwarderBefore)} it was holding`,
  );
}

/// Every `Swept` this signer caused at this forwarder, in the receipt's own logs.
function sweptAmounts(
  receipt: { logs: readonly ObservedLog[] },
  forwarderAddress: Address,
  signer: Address,
): bigint[] {
  const amounts: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== forwarderAddress.toLowerCase()) continue;
    let decoded: ReturnType<typeof decodeEventLog<typeof FORWARDER_SWEPT_EVENT_ABI>>;
    try {
      decoded = decodeEventLog({
        abi: FORWARDER_SWEPT_EVENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.args.caller.toLowerCase() === signer.toLowerCase()) amounts.push(decoded.args.amount);
  }
  return amounts;
}

const GWEI_WEI = 1_000_000_000n;

/// The four values the operator may pin with an `EXPECTED_*` variable, read together so
/// they can be asserted at more than one moment.
export interface FundingPinnedValues {
  fundingAttempt: bigint;
  fundingDeadline: bigint;
  callerTargetWei: bigint;
  operatorTargetWei: bigint;
}

/// Evaluates every declare-and-verify pin the operator set, against values read now.
///
/// `where` names the moment, because these run twice: once in the funding review the
/// operator reads, and again in the final on-chain re-read immediately before signing. A
/// pin that only ran in the review asserts what was true minutes ago, which on the Ledger
/// path is minutes before the device is even touched.
export function assertFundingPins(pinned: FundingPinnedValues, where: string) {
  const expectedAttempt = optionalEnvBigInt("EXPECTED_FUNDING_ATTEMPT");
  if (expectedAttempt !== undefined && expectedAttempt !== pinned.fundingAttempt) {
    throw new Error(
      `${where}: funding attempt ${pinned.fundingAttempt} != EXPECTED_FUNDING_ATTEMPT ${expectedAttempt}`,
    );
  }

  const expectedDeadlineBefore = optionalEnvBigInt("EXPECTED_DEADLINE_BEFORE");
  if (expectedDeadlineBefore !== undefined && pinned.fundingDeadline > expectedDeadlineBefore) {
    throw new Error(
      `${where}: funding deadline ${pinned.fundingDeadline} is after EXPECTED_DEADLINE_BEFORE ` +
        expectedDeadlineBefore,
    );
  }

  const expectedCallerTargetGwei = optionalEnvBigInt("EXPECTED_MY_TARGET_GWEI");
  if (
    expectedCallerTargetGwei !== undefined &&
    pinned.callerTargetWei !== expectedCallerTargetGwei * GWEI_WEI
  ) {
    throw new Error(
      `${where}: caller target ${formatWei(pinned.callerTargetWei)} != EXPECTED_MY_TARGET_GWEI ` +
        expectedCallerTargetGwei,
    );
  }

  const expectedOperatorTargetGwei = optionalEnvBigInt("EXPECTED_OPERATOR_TARGET_GWEI");
  if (
    expectedOperatorTargetGwei !== undefined &&
    pinned.operatorTargetWei !== expectedOperatorTargetGwei * GWEI_WEI
  ) {
    throw new Error(
      `${where}: operator target ${formatWei(pinned.operatorTargetWei)} != ` +
        `EXPECTED_OPERATOR_TARGET_GWEI ${expectedOperatorTargetGwei}`,
    );
  }
}

interface FundingStateReader {
  address: Address;
  read: {
    state: () => Promise<number>;
    fundingAttempt: () => Promise<bigint>;
    fundingDeadline: () => Promise<bigint>;
    fundingRemainingWeiOf: (args: readonly [Address]) => Promise<bigint>;
    fundingTargetWeiOf: (args: readonly [Address]) => Promise<bigint>;
    operator: () => Promise<Address>;
  };
}

interface LatestBlockReader {
  getBlock: () => Promise<{ number: bigint | null; timestamp: bigint }>;
}

/// The last on-chain read before a funding transaction is signed: the attempt is still
/// open, the deadline has not passed, and the caller's remaining allocation still covers
/// the amount. It narrows the race between deciding to fund and being mined; it cannot
/// close it, and on the plain-transfer path the contract's own revert is not there to
/// catch what slips through.
///
/// `reviewedAttempt` is the funding attempt number the review printed, and it must still be
/// the live one. Everything the operator read in that review — the participant list, every
/// target, their own allocation — belongs to that attempt and to no other. An attempt that
/// expires, is closed, and is reopened with a different participant set between the review
/// and the signature leaves state, deadline, and remaining allocation all looking perfectly
/// fundable while describing a completely different agreement. On the Ledger path that gap
/// is however long the operator takes at the device. The counter is the one value that
/// cannot be reused, so it is what the reviewed state is pinned to; every `EXPECTED_*` pin
/// the operator set is re-evaluated here as well, against values read now.
export async function assertStillFundable(
  pool: FundingStateReader,
  publicClient: LatestBlockReader,
  caller: Address,
  amount: bigint,
  reviewedAttempt: bigint,
) {
  const [state, fundingAttempt, fundingDeadline, remaining, callerTargetWei, operator, block] =
    await Promise.all([
      pool.read.state(),
      pool.read.fundingAttempt(),
      pool.read.fundingDeadline(),
      pool.read.fundingRemainingWeiOf([caller]),
      pool.read.fundingTargetWeiOf([caller]),
      pool.read.operator(),
      publicClient.getBlock(),
    ]);
  const operatorTargetWei = await pool.read.fundingTargetWeiOf([operator]);

  // Re-evaluated here for the same reason the funding pins are: the record was checked
  // minutes ago, and on the Ledger path the device has not been touched yet. The address
  // compared is the contract instance the transaction is about to go to.
  assertExpectedPool(pool.address, "Final re-read");
  if (Number(state) !== STATE_FUNDING) {
    throw new Error(`Pool state changed to ${state}; funding is no longer open`);
  }
  if (fundingAttempt !== reviewedAttempt) {
    throw new Error(
      `Funding attempt changed from ${reviewedAttempt} at the funding review to ${fundingAttempt} ` +
        `before signing; nothing was sent. The participant set, every funding target, and your own ` +
        `allocation all belong to an attempt, so the review you just read describes an agreement ` +
        `that is no longer the live one. Re-run "npm run fund" and read the review it prints`,
    );
  }
  if (block.timestamp >= fundingDeadline) {
    throw new Error(`Funding deadline ${fundingDeadline} has passed at block timestamp ${block.timestamp}`);
  }
  if (amount > remaining) {
    throw new Error(`Remaining funding cap dropped to ${formatWei(remaining)}; ${formatWei(amount)} would revert`);
  }
  assertFundingPins(
    { fundingAttempt, fundingDeadline, callerTargetWei, operatorTargetWei },
    "Final re-read",
  );

  console.log(`Final re-read at block ${block.number}: state=${state} remaining=${formatWei(remaining)}`);
  console.log(`Final re-read attempt: ${fundingAttempt} (unchanged since the funding review)`);
  console.log(`Final re-read deadline margin: ${fundingDeadline - block.timestamp}s`);
}
