import { readFileSync } from "node:fs";
import path from "node:path";

import type { Abi } from "viem";

import { REPO_ROOT } from "./paths.js";

/// The pool ABI, read from the same build artifact the commands verify the deployed runtime
/// code against. The harness needs it to drive the pool directly — to set up a state a
/// command must then react to, and to check afterwards that the command actually moved the
/// chain rather than merely printing that it had.
export const POOL_ABI = readAbi("ValidatorFundingPool");

function readAbi(name: string): Abi {
  const file = path.join(REPO_ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { abi: Abi }).abi;
}
