import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatEther, isAddress, type Address, type Hex } from "viem";

export const DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const DEFAULT_DEPOSIT_CONTRACT: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const DEFAULT_DEPOSIT_DATA_FILE = "deposit-data.json";
export const VALIDATOR_DEPOSIT_GWEI = 32_000_000_000n;
export const VALIDATOR_DEPOSIT_WEI = VALIDATOR_DEPOSIT_GWEI * 1_000_000_000n;

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
  withdrawalRequestPredeploy: Address;
  operator: Address;
  fundingWindowDuration: string;
  withdrawalCredentials: Hex;
  participants: Address[];
  fundingTargetsWei: string[];
}

interface BeaconValidatorResponse {
  data: {
    status: string;
    validator: {
      pubkey: string;
      withdrawal_credentials: string;
    };
  };
}

export function asHex(value: string): Hex {
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
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
) {
  const chainId = await publicClient.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`Deployment chainId ${deployment.chainId} does not match connected chainId ${chainId}`);
  }
}

export async function assertHasCode(
  publicClient: { getCode: (args: { address: Address }) => Promise<Hex | undefined> },
  address: Address,
  label: string,
) {
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`${label} has no code at ${address}`);
  }
}

export async function assertBeaconValidatorAbsent(pubkey: Hex, label: string) {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    console.log(`Skipping ${label} beacon preflight: BEACON_NODE_URL not set`);
    return;
  }

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

export function readSingleDepositData(file = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE): DepositData {
  const deposits = JSON.parse(readFileSync(file, "utf8")) as DepositData[];
  if (deposits.length !== 1) {
    throw new Error(`Expected exactly one validator deposit entry, got ${deposits.length}`);
  }
  return deposits[0];
}

export function validateDepositData(
  deposit: DepositData,
  expectedWithdrawalCredentials: Hex,
  expectedPubkey?: Hex,
) {
  const pubkey = normalizeHexLength(deposit.pubkey, 48, "pubkey");
  const withdrawalCredentials = normalizeHexLength(deposit.withdrawal_credentials, 32, "withdrawal_credentials");
  const signature = normalizeHexLength(deposit.signature, 96, "signature");
  const depositDataRoot = normalizeHexLength(deposit.deposit_data_root, 32, "deposit_data_root");
  const amountGwei = BigInt(deposit.amount);

  if (amountGwei !== VALIDATOR_DEPOSIT_GWEI) {
    throw new Error(`Deposit amount ${amountGwei} != expected ${VALIDATOR_DEPOSIT_GWEI}`);
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

  const expectedNetworkName = process.env.DEPOSIT_NETWORK_NAME;
  if (expectedNetworkName && deposit.network_name !== expectedNetworkName) {
    throw new Error(`Deposit network_name ${deposit.network_name ?? "<missing>"} != expected ${expectedNetworkName}`);
  }

  const expectedForkVersion = process.env.DEPOSIT_FORK_VERSION;
  if (expectedForkVersion && asHex(deposit.fork_version ?? "").toLowerCase() !== asHex(expectedForkVersion).toLowerCase()) {
    throw new Error(`Deposit fork_version ${deposit.fork_version ?? "<missing>"} != expected ${expectedForkVersion}`);
  }

  return { pubkey, withdrawalCredentials, signature, depositDataRoot, amountGwei };
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

function computeDepositDataRoot(pubkey: Hex, withdrawalCredentials: Hex, amountGwei: bigint, signature: Hex): Hex {
  const pubkeyRoot = sha256(Buffer.concat([fromHex(pubkey), Buffer.alloc(16)]));
  const signatureBytes = fromHex(signature);
  const signatureRoot = sha256(
    Buffer.concat([
      sha256(signatureBytes.subarray(0, 64)),
      sha256(Buffer.concat([signatureBytes.subarray(64), Buffer.alloc(32)])),
    ]),
  );
  const left = sha256(Buffer.concat([pubkeyRoot, fromHex(withdrawalCredentials)]));
  const right = sha256(Buffer.concat([uint64LittleEndian(amountGwei), Buffer.alloc(24), signatureRoot]));
  return toHex(sha256(Buffer.concat([left, right])));
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function fromHex(value: Hex): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function toHex(value: Buffer): Hex {
  return `0x${value.toString("hex")}` as Hex;
}

function uint64LittleEndian(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(value);
  return encoded;
}

export function formatWei(value: bigint): string {
  return `${value} wei (${formatEther(value)} ETH)`;
}
