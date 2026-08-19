import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { PublicKey, Signature, verify } from "@chainsafe/blst";
import { DOMAIN_DEPOSIT } from "@lodestar/params";
import { ssz } from "@lodestar/types";
import {
  formatEther,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const DEFAULT_DEPOSIT_CONTRACT: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const DEFAULT_DEPOSIT_DATA_FILE = "deposit-data.json";
export const PREDEPOSIT_GWEI = 1_000_000_000n;
export const TOP_UP_GWEI = 31_000_000_000n;
export const VALIDATOR_DEPOSIT_GWEI = 32_000_000_000n;
export const VALIDATOR_DEPOSIT_WEI = VALIDATOR_DEPOSIT_GWEI * 1_000_000_000n;
const ZERO_ROOT = `0x${"00".repeat(32)}` as Hex;
const DEFAULT_CONFIRMATION_STATE_ID = "finalized";
const ALLOWED_CONFIRMATION_STATE_IDS = ["finalized", "justified"];
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
interface ObservedTransaction {
  hash: Hex;
  to: Address | null;
  value: bigint;
  input: Hex;
}

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
///      signed. Only a reprice is acceptable: same destination, same value, same calldata,
///      higher fee. A `cancelled` or `replaced` transaction did something else with the
///      nonce, and the intended transaction never happened.
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
/// rather than trusted: this is the check that decides whether a success line may be
/// printed, and it should not depend on a classification made elsewhere.
function assertAcceptableReplacement(
  replacement: ObservedReplacement,
  hash: Hex,
  label: string,
) {
  const { reason, replacedTransaction, transaction } = replacement;
  const sameContent =
    sameAddress(transaction.to, replacedTransaction.to) &&
    transaction.value === replacedTransaction.value &&
    transaction.input.toLowerCase() === replacedTransaction.input.toLowerCase();

  if (reason === "repriced" && sameContent) {
    console.log(
      `${label} transaction ${hash} was repriced and mined as ${transaction.hash} with ` +
        `identical destination, value, and calldata`,
    );
    return;
  }

  throw new Error(
    `FATAL REPLACED TRANSACTION: ${label} transaction ${hash} never landed. A different ` +
      `transaction at the same nonce from the same sender was mined instead ` +
      `(${transaction.hash}, reason "${reason}"${sameContent ? "" : ", different destination, value, or calldata"}): ` +
      `to=${transaction.to ?? "<none>"} value=${transaction.value} instead of ` +
      `to=${replacedTransaction.to ?? "<none>"} value=${replacedTransaction.value}. ` +
      `What this script intended did NOT happen, and something else did. Run "npm run status", ` +
      `reconcile pool state against the mined transaction, and only then decide whether to re-run ${label}`,
  );
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

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return Number(value);
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

export function readDeployment(): DeploymentRecord {
  const file = deploymentPath();
  return JSON.parse(readFileSync(file, "utf8")) as DeploymentRecord;
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
  const chainId = await assertDeploymentChain(publicClient, deployment);
  await assertHasCode(publicClient, deployment.pool, "pool");
  const liveConfig = await assertDeploymentMatchesPool(pool, deployment);
  await assertPoolRuntimeCodeMatchesLocalBuild(
    publicClient,
    deployment.pool,
    readLocalPoolBuildArtifacts(),
  );
  const liveCodeHashes = await assertDeploymentSystemCodeHashes(publicClient, deployment, liveConfig);
  await assertDeploymentCanonicity(chainId, liveConfig, liveCodeHashes);
  if (deployment.feeRecipientForwarder !== undefined) {
    await assertHasCode(
      publicClient,
      deployment.feeRecipientForwarder,
      "feeRecipientForwarder",
    );
    const forwarderPool = await publicClient.readContract({
      address: deployment.feeRecipientForwarder,
      abi: [
        {
          type: "function",
          name: "pool",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "address" }],
        },
      ] as const,
      functionName: "pool",
    }) as Address;
    assertForwarderPool(forwarderPool, deployment.pool);
  }
  return liveConfig;
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
export interface PoolBuildArtifact {
  deployedBytecode: Hex;
  immutableReferences?: Record<string, readonly ImmutableRange[]>;
  buildInfoId?: string;
}

/// A local build artifact together with where it came from and which solidity build
/// profile produced it.
export interface PoolBuildCandidate {
  source: string;
  profile: string;
  artifact: PoolBuildArtifact;
}

const ARTIFACTS_ROOT = "artifacts";
const POOL_ARTIFACT_FILE = path.join(
  ARTIFACTS_ROOT,
  "contracts",
  "ValidatorFundingPool.sol",
  "ValidatorFundingPool.json",
);

/// The ceiling on how many bytes an artifact may declare immutable.
///
/// It exists because the ranges are taken from the CANDIDATE artifact and applied to the
/// chain's code as well as to the artifact's. A candidate that declares most or all of the
/// runtime immutable masks both sides to zeroes and then "matches" any contract at all —
/// the comparison would be checking nothing while printing that it passed. A total that
/// large is not a plausible immutable layout, so it is fatal rather than a match.
///
/// Sized from the real artifact, not from the number of immutables. solc emits one 32-byte
/// range per *reference site*, and one immutable is read at several sites: this contract's
/// five immutables produce 19 sites, 608 bytes, identically under both build profiles
/// (`artifacts/contracts/ValidatorFundingPool.sol/ValidatorFundingPool.json`,
/// `immutableReferences`; 16861 bytes of runtime under `default`, 10002 under
/// `production`). 2048 is roughly three times the observed total, room for a contract with
/// materially more immutable reads, and still far below the point where masking could hide
/// a different contract — every unmasked byte, metadata hash included, must match exactly.
const MAX_MASKED_IMMUTABLE_BYTES = 2048;
const OBSERVED_POOL_IMMUTABLE_BYTES = 608;

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
        `above the ${MAX_MASKED_IMMUTABLE_BYTES}-byte ceiling. A real build of ` +
        `ValidatorFundingPool declares ${OBSERVED_POOL_IMMUTABLE_BYTES} bytes under either ` +
        `solidity profile, so this artifact's immutable layout is implausible. The ranges are ` +
        `masked on the chain's code too: a range set this broad would zero out the very bytes the ` +
        `comparison exists to check and match any contract at all. Delete artifacts/ and run ` +
        `"npm run build"`,
    );
  }

  for (const { start, length } of declared) bytes.fill(0, start, start + length);

  return { masked: `0x${bytes.toString("hex")}` as Hex, maskedBytes };
}

/// Compares the pool's on-chain runtime code against the participant's own local build.
///
/// This is the check that is not circular: the deployment record and the live pool are
/// both downstream of whoever deployed, but `artifacts/` is downstream of the audited
/// source in this checkout. A pool that is not this contract fails here even when every
/// record-to-pool comparison passes.
///
/// It is not a substitute for source verification. It proves the deployed code is the code
/// this checkout builds; it says nothing about whether this checkout is the audited one.
/// Verify the repository's provenance and the pool on Sourcify as well.
export async function assertPoolRuntimeCodeMatchesLocalBuild(
  publicClient: { getCode: (args: { address: Address }) => Promise<Hex | undefined> },
  poolAddress: Address,
  candidates: readonly PoolBuildCandidate[],
): Promise<PoolBuildCandidate> {
  if (candidates.length === 0) {
    throw new Error(missingArtifactMessage([]));
  }

  const chainCode = await assertHasCode(publicClient, poolAddress, "pool");
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
    const chain = maskImmutableRanges(chainCode, references, `pool ${poolAddress} runtime code`);
    if (artifact.masked.toLowerCase() === chain.masked.toLowerCase()) {
      console.log(
        `Pool runtime code matches the local build ${candidate.source} (solidity profile ` +
          `${candidate.profile}); ${artifact.maskedBytes} immutable bytes masked, masked code hash ` +
          keccak256(chain.masked),
      );
      return candidate;
    }
    rejections.push(
      `${candidate.source} (profile ${candidate.profile}): masked code hash ` +
        `${keccak256(artifact.masked)} != chain ${keccak256(chain.masked)}`,
    );
  }

  throw new Error(
    `FATAL: the pool at ${poolAddress} does not run the code this checkout builds. Its runtime ` +
      `code matches no local build artifact, with all ${candidates.length === 1 ? "its" : "their"} ` +
      `immutable ranges masked on both sides: ${rejections.join("; ")}. This is the check that the ` +
      `deployment record cannot make for you — a record and a pool can agree with each other and ` +
      `still describe a contract nobody audited. Do not send capital to this address. If the pool ` +
      `was built with the other solidity profile, rebuild locally with "npm run build" (default) or ` +
      `"npx hardhat compile --build-profile production" and re-run; hardhat keeps only the ` +
      `last-built profile's artifacts, so verifying against the other one means rebuilding`,
  );
}

/// Collects the local build artifacts the pool's runtime code may match.
///
/// There is exactly one source: the hardhat build output in this checkout. No environment
/// variable adds a candidate. An added candidate controls both sides of the comparison —
/// its `deployedBytecode` is what the chain code is compared against AND its
/// `immutableReferences` decide which bytes are ignored on both sides — so an
/// externally-supplied artifact can always be made to match, which makes the whole check
/// decorative. Hardhat 3 writes every build profile to the same `artifacts/` tree, so
/// verifying against the profile that is not on disk means rebuilding with that profile and
/// re-running; that is what the mismatch error says.
export function readLocalPoolBuildArtifacts(
  buildOutput: string = POOL_ARTIFACT_FILE,
): PoolBuildCandidate[] {
  if (!existsSync(buildOutput)) {
    throw new Error(missingArtifactMessage([buildOutput]));
  }
  return [readPoolBuildCandidate(buildOutput)];
}

function readPoolBuildCandidate(file: string): PoolBuildCandidate {
  const artifact = JSON.parse(readFileSync(file, "utf8")) as PoolBuildArtifact;
  return { source: file, profile: describeBuildProfile(artifact), artifact };
}

function missingArtifactMessage(files: readonly string[]): string {
  return (
    `FATAL: no local build artifact for ValidatorFundingPool was found` +
    `${files.length === 0 ? "" : ` (looked for ${files.join(", ")})`}. The pool's runtime code is ` +
    `verified against the contract this checkout builds, and that comparison cannot be skipped: ` +
    `run "npm run build" and re-run this command`
  );
}

/// Names the solidity build profile that produced an artifact, by reading the optimizer
/// settings out of the build-info file the artifact points at. Reported alongside a match
/// so the participant knows which of `hardhat.config.ts`'s two profiles they just verified
/// against. Purely descriptive: a wrong or missing label cannot make a mismatch pass.
function describeBuildProfile(artifact: PoolBuildArtifact): string {
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
  const response = await fetch(url);
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
    confirmationStateId(label),
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
    console.log(`Skipping ${label} beacon exit preflight: BEACON_NODE_URL not set`);
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

/// Builds a beacon API URL that PRESERVES any path component of `BEACON_NODE_URL`.
///
/// `new URL("/eth/v1/...", base)` is root-anchored and silently discards the base's path,
/// so a hosted endpoint of the form `https://host/eth-beacon-node/<key>` was rewritten to
/// `https://host/eth/v1/...` — a different endpoint, on which every preflight would have
/// been deciding from whatever that URL happened to answer. Appending relative to a base
/// with a trailing slash keeps the prefix.
export function beaconApiUrl(beaconNodeUrl: string, pathname: string): URL {
  const base = beaconNodeUrl.endsWith("/") ? beaconNodeUrl : `${beaconNodeUrl}/`;
  return new URL(pathname.replace(/^\/+/, ""), base);
}

async function fetchBeaconJson<T>(beaconNodeUrl: string, pathname: string, label: string): Promise<T> {
  const url = beaconApiUrl(beaconNodeUrl, pathname);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} beacon request ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function requireBeaconNodeUrl(label: string): string {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    throw new Error(`${label} requires BEACON_NODE_URL for mandatory beacon confirmation`);
  }
  return beaconNodeUrl;
}

// Credential confirmation reads a settled state and is then re-confirmed at head. Allowing "head"
// here would collapse those two reads into one, so the state id is restricted to settled states.
function confirmationStateId(label: string): string {
  const stateId = process.env.BEACON_CONFIRMATION_STATE_ID ?? DEFAULT_CONFIRMATION_STATE_ID;
  if (!ALLOWED_CONFIRMATION_STATE_IDS.includes(stateId)) {
    throw new Error(
      `${label} BEACON_CONFIRMATION_STATE_ID ${stateId} is not allowed; use one of ` +
        ALLOWED_CONFIRMATION_STATE_IDS.join(", "),
    );
  }
  return stateId;
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

export function readDepositDataFile(file = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE): DepositData[] {
  return JSON.parse(readFileSync(file, "utf8")) as DepositData[];
}

export function readPredepositAndTopUpDepositData(
  file = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE,
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

interface FundingStateReader {
  read: {
    state: () => Promise<number>;
    fundingDeadline: () => Promise<bigint>;
    fundingRemainingWeiOf: (args: readonly [Address]) => Promise<bigint>;
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
export async function assertStillFundable(
  pool: FundingStateReader,
  publicClient: LatestBlockReader,
  caller: Address,
  amount: bigint,
) {
  const [state, fundingDeadline, remaining, block] = await Promise.all([
    pool.read.state(),
    pool.read.fundingDeadline(),
    pool.read.fundingRemainingWeiOf([caller]),
    publicClient.getBlock(),
  ]);

  if (Number(state) !== STATE_FUNDING) {
    throw new Error(`Pool state changed to ${state}; funding is no longer open`);
  }
  if (block.timestamp >= fundingDeadline) {
    throw new Error(`Funding deadline ${fundingDeadline} has passed at block timestamp ${block.timestamp}`);
  }
  if (amount > remaining) {
    throw new Error(`Remaining funding cap dropped to ${formatWei(remaining)}; ${formatWei(amount)} would revert`);
  }

  console.log(`Final re-read at block ${block.number}: state=${state} remaining=${formatWei(remaining)}`);
  console.log(`Final re-read deadline margin: ${fundingDeadline - block.timestamp}s`);
}
