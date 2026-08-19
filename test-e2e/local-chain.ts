import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

import { REPO_ROOT } from "./paths.js";

/// Hardhat's built-in development mnemonic. The node started below funds its accounts from
/// it, so deriving the same accounts here is what lets the harness hand a real
/// `PRIVATE_KEY` to a child process AND drive the same account directly.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

/// Hardhat Network's default chain id. Deliberately left as it is rather than overridden to
/// 1: `assertDeploymentCanonicity` only holds a canonical pin for mainnet, so an
/// unrecognised chain id is what makes it take the WARNING branch — which the tests assert
/// rather than suppress. Pretending to be mainnet would silence the very branch a local
/// chain is honest about.
export const LOCAL_CHAIN_ID = 31337;

export const DEPOSIT_CONTRACT_ADDRESS: Address = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS: Address =
  "0x00000961Ef480Eb55e80D19ad83579A64c007002";

/// The canonical mainnet runtime code hashes, written out as literals a second time.
///
/// They are deliberately NOT imported from `scripts/lib/common.ts`: a harness that took the
/// pin from the thing it is testing would agree with any value the pin happened to hold, and
/// the whole point of installing the real system contracts here is to state independently
/// what the chain under test is running. The command tests assert the deployment record
/// carries exactly these, which is what makes the record's hashes evidence.
///
/// `test/CanonicalSystemContracts.ts` is what keeps the two statements honest: it requires
/// these literals, the two `test-e2e/fixtures/*.json` expectations, and
/// `CANONICAL_SYSTEM_CONTRACTS[1]` to be the same four values. A copy that drifts is a copy
/// that proves nothing, and it fails the unit suite rather than passing quietly.
export const CANONICAL_DEPOSIT_CONTRACT_CODE_HASH: Hex =
  "0x6c029a231254fadb724d63be769f75eedd66362df034a3e663252b49d062a666";
export const CANONICAL_PREDEPLOY_CODE_HASH: Hex =
  "0x0345a365d2f4c5975b9f1599abe0a2ee76b7a3a731bc68781bd04c84e4858f50";

/// Where the two upstream-derived fixtures live, so the unit test can read exactly the files
/// this harness installs from.
export const DEPOSIT_CONTRACT_FIXTURE_FILE = "deposit-contract.json";
export const WITHDRAWAL_REQUEST_PREDEPLOY_FIXTURE_FILE = "withdrawal-request-predeploy.json";

export function fixturePath(name: string): string {
  return path.join(REPO_ROOT, "test-e2e", "fixtures", name);
}

/// Storage slots the beacon deposit contract's constructor initialises: `branch[32]` at
/// 0..31, `deposit_count` at 32, and `zero_hashes[32]` at 33..64. `hardhat_setCode` copies
/// code and not storage, so these are copied across explicitly after the real creation
/// bytecode has been deployed and its constructor has run. Without them `get_deposit_root()`
/// at the canonical address would read an all-zero sparse-tree table — nothing on the tested
/// paths calls it, but a system contract that is only half-installed is the kind of detail a
/// harness should not leave to chance.
const DEPOSIT_CONTRACT_STORAGE_SLOTS = 65;

interface DepositContractFixture {
  creationBytecode: Hex;
  expectedRuntimeCodeHash: Hex;
  expectedRuntimeByteLength: number;
}

interface PredeployFixture {
  runtimeBytecode: Hex;
  expectedRuntimeCodeHash: Hex;
  expectedRuntimeByteLength: number;
}

export interface LocalAccount {
  address: Address;
  privateKey: Hex;
  account: HDAccount;
}

export class LocalChain {
  #process: ChildProcess | undefined;
  #log: string[] = [];
  readonly port: number;
  readonly url: string;
  readonly chain: ReturnType<typeof defineChain>;
  readonly accounts: LocalAccount[] = [];
  publicClient!: PublicClient;

  private constructor(port: number) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.chain = defineChain({
      id: LOCAL_CHAIN_ID,
      name: "validator-funding-pool-e2e",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.url] } },
    });
    for (let index = 0; index < 20; ++index) {
      const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index });
      const privateKey = account.getHdKey().privateKey;
      if (privateKey === null) throw new Error(`account ${index} has no private key`);
      this.accounts.push({ address: account.address, privateKey: toHex(privateKey), account });
    }
  }

  static async start(): Promise<LocalChain> {
    const chain = new LocalChain(await freePort());
    await chain.#spawnNode();
    chain.publicClient = createPublicClient({
      chain: chain.chain,
      transport: http(chain.url),
    }) as PublicClient;
    await chain.#installCanonicalSystemContracts();
    return chain;
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    this.#process = undefined;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });
  }

  walletFor(account: LocalAccount): WalletClient {
    return createWalletClient({ account: account.account, chain: this.chain, transport: http(this.url) });
  }

  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method} failed: ${body.error.message}`);
    return body.result as T;
  }

  setAutomine(enabled: boolean): Promise<boolean> {
    return this.rpc<boolean>("evm_setAutomine", [enabled]);
  }

  mine(): Promise<string> {
    return this.rpc<string>("evm_mine", []);
  }

  setNextBlockTimestamp(timestamp: bigint): Promise<string> {
    return this.rpc<string>("evm_setNextBlockTimestamp", [Number(timestamp)]);
  }

  /// Blocks until the mempool holds `count` transactions. Used to sequence the harness
  /// against a command running as a child process: the child broadcasts, this returns, and
  /// only then does the harness mutate state and mine.
  async waitForPendingTransactions(count: number, timeoutMs = 60_000): Promise<Hex[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const block = await this.rpc<{ transactions: Hex[] } | null>("eth_getBlockByNumber", [
        "pending",
        false,
      ]);
      const transactions = block?.transactions ?? [];
      if (transactions.length >= count) return transactions;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count} pending transaction(s); saw ${transactions.length}`,
        );
      }
      await sleep(50);
    }
  }

  async #spawnNode(): Promise<void> {
    const child = spawn(
      "npx",
      ["hardhat", "node", "--port", this.port.toString(), "--hostname", "127.0.0.1"],
      { cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#process = child;
    child.stdout?.on("data", (chunk: Buffer) => this.#log.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.#log.push(chunk.toString()));
    child.on("exit", (code) => this.#log.push(`\n[hardhat node exited with ${code}]\n`));

    const deadline = Date.now() + 120_000;
    for (;;) {
      if (this.#process === undefined) throw new Error("chain stopped while starting");
      try {
        const chainId = await this.rpc<Hex>("eth_chainId");
        if (BigInt(chainId) !== BigInt(LOCAL_CHAIN_ID)) {
          throw new Error(`local chain reports chain id ${chainId}`);
        }
        return;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(
            `hardhat node did not become reachable on ${this.url}: ${String(error)}\n` +
              this.#log.join(""),
          );
        }
        await sleep(200);
      }
    }
  }

  /// Installs the real mainnet system contracts at their real mainnet addresses.
  ///
  /// The deposit contract is DEPLOYED from the canonical creation bytecode so its
  /// constructor runs, then its runtime code and constructor-initialised storage are copied
  /// to the canonical address. The EIP-7002 predeploy has no constructor — it is shipped as
  /// genesis allocation on every network that has it — so its runtime is written directly.
  ///
  /// Both are checked against the code hashes `scripts/lib/common.ts` pins for mainnet
  /// before anything else happens. That comparison is what makes the fixtures evidence
  /// rather than a blob: if a byte of either fixture were wrong, the hash would not match a
  /// constant that was derived independently, and setup would fail here rather than silently
  /// testing against something that is not the system contract.
  async #installCanonicalSystemContracts(): Promise<void> {
    const deployer = this.accounts[0];
    const wallet = this.walletFor(deployer);

    const deposit = readFixture<DepositContractFixture>(DEPOSIT_CONTRACT_FIXTURE_FILE);
    const deploymentHash = await wallet.deployContract({
      abi: [],
      bytecode: deposit.creationBytecode,
      account: deployer.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
      throw new Error("deposit contract deployment produced no contract address");
    }
    const depositRuntime = await this.publicClient.getCode({ address: receipt.contractAddress });
    assertFixtureRuntime(depositRuntime, deposit, "beacon deposit contract");

    await this.rpc("hardhat_setCode", [DEPOSIT_CONTRACT_ADDRESS, depositRuntime]);
    for (let slot = 0; slot < DEPOSIT_CONTRACT_STORAGE_SLOTS; ++slot) {
      const key = toHex(slot);
      const value = await this.publicClient.getStorageAt({
        address: receipt.contractAddress,
        slot: key,
      });
      if (value === undefined || BigInt(value) === 0n) continue;
      await this.rpc("hardhat_setStorageAt", [DEPOSIT_CONTRACT_ADDRESS, key, value]);
    }

    const predeploy = readFixture<PredeployFixture>(WITHDRAWAL_REQUEST_PREDEPLOY_FIXTURE_FILE);
    assertFixtureRuntime(predeploy.runtimeBytecode, predeploy, "EIP-7002 withdrawal request predeploy");
    await this.rpc("hardhat_setCode", [
      WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS,
      predeploy.runtimeBytecode,
    ]);

    const installedDeposit = await this.publicClient.getCode({ address: DEPOSIT_CONTRACT_ADDRESS });
    const installedPredeploy = await this.publicClient.getCode({
      address: WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS,
    });
    assertFixtureRuntime(installedDeposit, deposit, "installed beacon deposit contract");
    assertFixtureRuntime(installedPredeploy, predeploy, "installed EIP-7002 predeploy");
  }
}

function assertFixtureRuntime(
  code: Hex | undefined,
  fixture: { expectedRuntimeCodeHash: Hex; expectedRuntimeByteLength: number },
  what: string,
) {
  if (code === undefined || code === "0x") throw new Error(`${what} has no runtime code`);
  const byteLength = (code.length - 2) / 2;
  if (byteLength !== fixture.expectedRuntimeByteLength) {
    throw new Error(
      `${what} runtime is ${byteLength} bytes, expected ${fixture.expectedRuntimeByteLength}`,
    );
  }
  const hash = keccak256(code);
  if (hash.toLowerCase() !== fixture.expectedRuntimeCodeHash.toLowerCase()) {
    throw new Error(
      `${what} runtime code hash ${hash} does not match the canonical mainnet hash ` +
        fixture.expectedRuntimeCodeHash,
    );
  }
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
