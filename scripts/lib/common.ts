import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PublicKey, Signature, verify } from "@chainsafe/blst";
import { DOMAIN_DEPOSIT } from "@lodestar/params";
import { ssz } from "@lodestar/types";
import { formatEther, isAddress, keccak256, type Address, type Hex } from "viem";

export const DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const DEFAULT_DEPOSIT_CONTRACT: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const DEFAULT_DEPOSIT_DATA_FILE = "deposit-data.json";
export const PREDEPOSIT_GWEI = 1_000_000_000n;
export const TOP_UP_GWEI = 31_000_000_000n;
export const VALIDATOR_DEPOSIT_GWEI = 32_000_000_000n;
export const VALIDATOR_DEPOSIT_WEI = VALIDATOR_DEPOSIT_GWEI * 1_000_000_000n;
export const UNSAFE_SKIP_BEACON_CONFIRMATION = "UNSAFE_SKIP_BEACON_CONFIRMATION";
const ZERO_ROOT = `0x${"00".repeat(32)}` as Hex;

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

export async function assertBeaconValidatorHasWithdrawalCredentials(
  pubkey: Hex,
  expectedWithdrawalCredentials: Hex,
  label: string,
  required = false,
) {
  const beaconNodeUrl = process.env.BEACON_NODE_URL;
  if (!beaconNodeUrl) {
    if (required && process.env[UNSAFE_SKIP_BEACON_CONFIRMATION] !== "1") {
      throw new Error(
        `${label} requires BEACON_NODE_URL to confirm pool withdrawal credentials. ` +
          `Set ${UNSAFE_SKIP_BEACON_CONFIRMATION}=1 only for unsafe local/devnet bypasses.`,
      );
    }
    console.log(`Skipping ${label} beacon confirmation: BEACON_NODE_URL not set`);
    return;
  }

  const url = new URL(`/eth/v1/beacon/states/head/validators/${pubkey}`, beaconNodeUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} beacon validator lookup failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as BeaconValidatorResponse;
  const actualCredentials = body.data.validator.withdrawal_credentials.toLowerCase();
  if (actualCredentials !== expectedWithdrawalCredentials.toLowerCase()) {
    throw new Error(
      `${label} beacon withdrawal_credentials ${actualCredentials} != pool ${expectedWithdrawalCredentials}`,
    );
  }
  console.log(`${label} beacon confirmation passed: validator has pool withdrawal credentials`);
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
  expectedPubkey?: Hex,
  expectedAmountGwei = VALIDATOR_DEPOSIT_GWEI,
) {
  const pubkey = normalizeHexLength(deposit.pubkey, 48, "pubkey");
  const withdrawalCredentials = normalizeHexLength(deposit.withdrawal_credentials, 32, "withdrawal_credentials");
  const signature = normalizeHexLength(deposit.signature, 96, "signature");
  const depositDataRoot = normalizeHexLength(deposit.deposit_data_root, 32, "deposit_data_root");
  const forkVersion = normalizeHexLength(
    deposit.fork_version ?? process.env.DEPOSIT_FORK_VERSION ?? "",
    4,
    "fork_version",
  );
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
  if (!verifyDepositSignature(pubkey, withdrawalCredentials, amountGwei, signature, forkVersion)) {
    throw new Error("Invalid BLS deposit signature");
  }

  const expectedNetworkName = process.env.DEPOSIT_NETWORK_NAME;
  if (expectedNetworkName && deposit.network_name !== expectedNetworkName) {
    throw new Error(`Deposit network_name ${deposit.network_name ?? "<missing>"} != expected ${expectedNetworkName}`);
  }

  const expectedForkVersion = process.env.DEPOSIT_FORK_VERSION;
  if (expectedForkVersion && forkVersion.toLowerCase() !== asHex(expectedForkVersion).toLowerCase()) {
    throw new Error(`Deposit fork_version ${deposit.fork_version ?? "<missing>"} != expected ${expectedForkVersion}`);
  }

  return { pubkey, withdrawalCredentials, signature, depositDataRoot, amountGwei, forkVersion };
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
