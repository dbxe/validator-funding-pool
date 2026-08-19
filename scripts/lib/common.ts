import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
const HEAD_STATE_ID = "head";
const FAR_FUTURE_EPOCH = (2n ** 64n - 1n).toString();

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

interface BeaconSyncingResponse {
  data: {
    head_slot: string;
    sync_distance: string;
    is_syncing: boolean;
    is_optimistic?: boolean;
    el_offline?: boolean;
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

export function envBigInt(name: string, fallback?: bigint): bigint {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback === undefined) {
      throw new Error(`Missing env ${name}`);
    }
    return fallback;
  }
  return BigInt(value);
}

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return Number(value);
}

export function parseAddressList(value: string): Address[] {
  return value.split(",").map((entry) => asAddress(entry.trim()));
}

export function parseBigIntList(value: string): bigint[] {
  return value.split(",").map((entry) => BigInt(entry.trim()));
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
  const liveConfig = {
    depositContract,
    withdrawalRequestPredeploy,
    operator,
    withdrawalCredentials,
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
  const liveConfig = await assertDeploymentMatchesPool(pool, deployment);
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
  let beaconChainId: bigint;
  try {
    beaconChainId = BigInt(config.data.chain_id);
  } catch {
    throw new Error(`${label} beacon deposit chain_id ${config.data.chain_id} is invalid`);
  }
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

export async function assertBeaconValidatorAbsent(pubkey: Hex, label: string) {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  await assertBeaconNodeHealthy(beaconNodeUrl, label);
  const url = new URL(`/eth/v1/beacon/states/head/validators/${pubkey}`, beaconNodeUrl);
  const response = await fetch(url);
  if (response.status === 404) {
    console.log(`${label} beacon preflight passed: validator pubkey is not in head state`);
    return;
  }
  if (!response.ok) {
    throw new Error(`${label} beacon validator lookup failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as BeaconValidatorResponse;
  throw new Error(
    `${label} beacon preflight failed: validator ${pubkey} already exists with status ${
      body.data.status
    } and withdrawal_credentials ${body.data.validator.withdrawal_credentials}`,
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

export async function assertBeaconValidatorHasWithdrawalCredentials(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
): Promise<BeaconValidatorPreflight> {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  return assertBeaconValidatorHasWithdrawalCredentialsAtUrl(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    label,
  );
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
    process.env.BEACON_CONFIRMATION_STATE_ID ?? DEFAULT_CONFIRMATION_STATE_ID,
    label,
  );
  assertBeaconValidatorWithdrawalCredentials(preflight, expectedWithdrawalCredentials, label);
  printBeaconPreflight(label, preflight);
  console.log(`${label} beacon confirmation passed: validator has pool withdrawal credentials`);
  return preflight;
}

// The fund and top-up legs run the identical preflight. Both names are kept so call sites stay
// labeled with the operation the operator actually ran.
export async function assertBeaconValidatorReadyForTopUp(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
) {
  return assertBeaconValidatorIsFreshPredeposit(pubkey, expectedWithdrawalCredentials, label);
}

export async function assertBeaconValidatorReadyForFunding(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
) {
  return assertBeaconValidatorIsFreshPredeposit(pubkey, expectedWithdrawalCredentials, label);
}

async function assertBeaconValidatorIsFreshPredeposit(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
) {
  const beaconNodeUrl = requireBeaconNodeUrl(label);
  await assertBeaconValidatorHasWithdrawalCredentialsAtUrl(
    beaconNodeUrl,
    pubkey,
    expectedWithdrawalCredentials,
    label,
  );

  const headPreflight = await readBeaconValidatorPreflight(
    beaconNodeUrl,
    pubkey,
    HEAD_STATE_ID,
    `${label} head`,
  );
  assertBeaconValidatorWithdrawalCredentials(headPreflight, expectedWithdrawalCredentials, `${label} head`);

  assertFreshPredepositMutableState(headPreflight, label);

  printBeaconPreflight(`${label} head`, headPreflight);
  console.log(`${label} head beacon fresh-predeposit preflight passed`);
}

function assertFreshPredepositMutableState(preflight: BeaconValidatorPreflight, label: string) {
  const { balance, validator } = preflight.validator;
  if (balance !== PREDEPOSIT_GWEI.toString()) {
    throw new Error(
      `${label} head beacon validator balance ${balance} is not exactly ${PREDEPOSIT_GWEI} Gwei`,
    );
  }
  if (validator.slashed) {
    throw new Error(`${label} head beacon validator is slashed`);
  }
  if (validator.activation_epoch !== FAR_FUTURE_EPOCH) {
    throw new Error(
      `${label} head beacon validator activation_epoch ${validator.activation_epoch} is not FAR_FUTURE_EPOCH`,
    );
  }
  if (validator.activation_eligibility_epoch !== FAR_FUTURE_EPOCH) {
    throw new Error(
      `${label} head beacon validator activation_eligibility_epoch ` +
        `${validator.activation_eligibility_epoch} is not FAR_FUTURE_EPOCH`,
    );
  }
  if (validator.exit_epoch !== FAR_FUTURE_EPOCH) {
    throw new Error(
      `${label} head beacon validator exit_epoch ${validator.exit_epoch} is not FAR_FUTURE_EPOCH`,
    );
  }
  if (validator.withdrawable_epoch !== FAR_FUTURE_EPOCH) {
    throw new Error(
      `${label} head beacon validator withdrawable_epoch ${validator.withdrawable_epoch} ` +
        `is not FAR_FUTURE_EPOCH`,
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

  const slotsPerEpoch = beaconSpecUint(spec, "SLOTS_PER_EPOCH");
  const shardCommitteePeriod = beaconSpecUint(spec, "SHARD_COMMITTEE_PERIOD");
  const currentEpoch = BigInt(preflight.syncing.head_slot) / slotsPerEpoch;
  const exitEligibleEpoch = BigInt(validator.activation_epoch) + shardCommitteePeriod;
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

function beaconSpecUint(spec: BeaconSpecResponse, key: string): bigint {
  const value = spec.data[key];
  if (value === undefined) {
    throw new Error(`Beacon spec is missing ${key}`);
  }
  return BigInt(value);
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
    validator: validator.data,
  };
}

async function assertBeaconNodeHealthy(beaconNodeUrl: string, label: string): Promise<BeaconSyncingResponse["data"]> {
  const syncing = await fetchBeaconJson<BeaconSyncingResponse>(beaconNodeUrl, "/eth/v1/node/syncing", label);
  if (syncing.data.is_syncing) {
    throw new Error(`${label} beacon node is syncing: distance ${syncing.data.sync_distance}`);
  }
  if (syncing.data.is_optimistic) {
    throw new Error(`${label} beacon node is optimistic; refusing to rely on beacon confirmation`);
  }
  if (syncing.data.el_offline) {
    throw new Error(`${label} beacon node reports execution layer offline`);
  }
  return syncing.data;
}

async function fetchBeaconJson<T>(beaconNodeUrl: string, pathname: string, label: string): Promise<T> {
  const url = new URL(pathname, beaconNodeUrl);
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

export function readSingleDepositData(file = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE): DepositData {
  const deposits = readDepositDataFile(file);
  if (deposits.length !== 1) {
    throw new Error(`Expected exactly one validator deposit entry, got ${deposits.length}`);
  }
  return deposits[0];
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
