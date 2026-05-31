import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatEther, isAddress, type Address, type Hex } from "viem";

export const DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const DEFAULT_DEPOSIT_CONTRACT: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const DEFAULT_DEPOSIT_DATA_FILE = "deposit-data.json";

export interface DeploymentRecord {
  chainId: number;
  pool: Address;
  depositContract: Address;
  withdrawalRequestPredeploy: Address;
  validatorDepositWei: string;
  validatorCount: string;
  fundingDeadline: string;
  withdrawalCredentials: Hex;
  participants: Address[];
  fundingTargetsWei: string[];
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

export function defaultValidatorDepositGwei(): bigint {
  if (process.env.VALIDATOR_DEPOSIT_GWEI !== undefined) {
    return BigInt(process.env.VALIDATOR_DEPOSIT_GWEI);
  }

  const file = process.env.DEPOSIT_DATA_FILE ?? DEFAULT_DEPOSIT_DATA_FILE;
  if (existsSync(file)) {
    const deposits = JSON.parse(readFileSync(file, "utf8")) as Array<{ amount: string | number }>;
    if (deposits.length > 0) return BigInt(deposits[0].amount);
  }

  return 32_000_000_000n;
}

export function formatWei(value: bigint): string {
  return `${value} wei (${formatEther(value)} ETH)`;
}
