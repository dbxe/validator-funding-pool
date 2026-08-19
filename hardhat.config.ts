import type { HardhatUserConfig } from "hardhat/config";

import hardhatLedgerPlugin from "@nomicfoundation/hardhat-ledger";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";

const LEDGER_NETWORK = "ledger";

/// Network selected for this process, mirroring Hardhat's own precedence: the
/// `--network` CLI option wins over the `HARDHAT_NETWORK` environment variable.
///
/// Both CLI spellings must be recognised. Hardhat's own argv preprocessing splits
/// `--option=value` into two arguments before any option is matched
/// (`hardhat/dist/src/internal/cli/parser.js` `parseRawArguments`, lines 137-147),
/// so `--network=ledger` selects the ledger network just as `--network ledger`
/// does. Scanning only for the bare `--network` token missed that spelling and
/// let the `LEDGER_ADDRESS` guard below be bypassed.
///
/// A `--network` with no usable value (`--network` as the last argument, or
/// `--network=`) is treated identically: the CLI option is present and therefore
/// wins over `HARDHAT_NETWORK`, but it names no network. Hardhat rejects both
/// spellings on its own before any task runs.
function selectedNetwork(): string | undefined {
  const NETWORK_FLAG = "--network";
  for (let i = 0; i < process.argv.length; ++i) {
    const argument = process.argv[i];
    if (argument === NETWORK_FLAG) {
      const value = process.argv[i + 1];
      return value === undefined || value === "" ? undefined : value;
    }
    if (argument.startsWith(`${NETWORK_FLAG}=`)) {
      const value = argument.slice(NETWORK_FLAG.length + 1);
      return value === "" ? undefined : value;
    }
  }
  return process.env.HARDHAT_NETWORK;
}

/// The Ledger plugin takes plain address strings, not `configVariable()`
/// handles, so `LEDGER_ADDRESS` is read eagerly here. It is a public address,
/// not a secret, so it does not belong in the keystore. Networks other than
/// `ledger` must keep loading when it is unset, so an unset value is only fatal
/// when the ledger network is the one being used.
function ledgerAccounts(): string[] {
  const address = process.env.LEDGER_ADDRESS ?? "";
  if (address === "") {
    if (selectedNetwork() === LEDGER_NETWORK) {
      throw new Error(`LEDGER_ADDRESS must be set to use --network ${LEDGER_NETWORK}`);
    }
    return [];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`LEDGER_ADDRESS ${address} is not a 0x-prefixed 20-byte address`);
  }
  return [address];
}

/// The chain id every http network is pinned to, or `undefined` when nothing is
/// declared.
///
/// Hardhat installs a `ChainIdValidatorHandler` as the FIRST request handler of an
/// http network whose config carries a `chainId`
/// (`hardhat/dist/src/internal/builtin-plugins/network-manager/request-handlers/handlers-array.js`
/// lines 20-22). It answers the first request that is not `eth_chainId` or
/// `net_version` by fetching the connection's chain id and throwing
/// `HHE708: Hardhat was set to use chain id "<pinned>", but connected to a chain
/// with id "<actual>"` on a mismatch
/// (`.../handlers/chain-id/chain-id-handler.js`). Verified by experiment on
/// hardhat 3.12.0 against a local chain: pinned `1` against chain 31337 threw
/// HHE708 before the wallet client was even obtained — nothing signed, nothing
/// sent — and the matching pin ran the command normally. `SECURITY.md` §5 records
/// the measurement, including what the pin does NOT close.
///
/// Read eagerly from the environment rather than through `configVariable()`,
/// exactly like `LEDGER_ADDRESS`: the field is a plain number, not a
/// `SensitiveString`, and a chain id is public. Unset leaves the field off
/// entirely, which is what keeps devnet and testnet runs working — the handler is
/// installed only when the field is present.
/// Exported for the unit test in `test/HardhatConfig.ts`. The config module builds a plain
/// object on import and starts nothing, so a test may import it; the parser is separated from
/// the environment read so the test can drive both sides of the boundary below without
/// touching `process.env` or defeating the module cache.
export function parseExpectedChainId(declared: string): number | undefined {
  if (declared === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(declared)) {
    throw new Error(
      `EXPECTED_CHAIN_ID ${declared} is not a canonical positive decimal integer: no 0x ` +
        `prefix, no sign, no leading zeros, no separators, no surrounding whitespace. ` +
        `Mainnet is EXPECTED_CHAIN_ID=1`,
    );
  }
  // Hardhat's `chainId` field is a `number`, so the declaration has to survive the conversion
  // to one. Above `Number.MAX_SAFE_INTEGER` it does not: `Number("9007199254740993")` is
  // 9007199254740992, and the pin would then be installed for a chain id the operator did not
  // declare — silently, which is the one thing a declare-and-verify pin may never be. The
  // round trip back to a string is the check; `Number.isSafeInteger` is stated alongside it
  // because it is what the round trip is really asserting, and the regex above has already
  // ruled out every other spelling that could round-trip differently.
  const chainId = Number(declared);
  if (!Number.isSafeInteger(chainId) || String(chainId) !== declared) {
    throw new Error(
      `EXPECTED_CHAIN_ID ${declared} is above Number.MAX_SAFE_INTEGER ` +
        `(${Number.MAX_SAFE_INTEGER}) and cannot be represented exactly. Hardhat's chainId ` +
        `field is a number, so pinning it would pin ${chainId} instead — a different chain ` +
        `id than the one declared, with nothing said about the difference. Refusing rather ` +
        `than pinning something you did not declare. Mainnet is EXPECTED_CHAIN_ID=1`,
    );
  }
  return chainId;
}

function expectedChainId(): number | undefined {
  return parseExpectedChainId(process.env.EXPECTED_CHAIN_ID ?? "");
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatLedgerPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    rpc: {
      type: "http",
      chainType: "l1",
      chainId: expectedChainId(),
      url: configVariable("RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
    // Read-only path. Hardhat resolves an http network's `accounts` array on the
    // connection's first JSON-RPC request
    // (`hardhat/dist/src/internal/builtin-plugins/network-manager/request-handlers/handlers-array.js`
    // line 55, reached from `hook-handlers/network.js` line 23), so the `rpc`
    // network cannot answer a single `eth_call` without a resolvable
    // `PRIVATE_KEY`. Omitting `accounts` entirely leaves it at Hardhat's
    // `"remote"` default, which resolves no configuration variable at all, so
    // `status` works for a Ledger-only operator who has no private key anywhere.
    read: {
      type: "http",
      chainType: "l1",
      chainId: expectedChainId(),
      url: configVariable("RPC_URL"),
    },
    // Hardware-wallet path. No `accounts` entry: the signing key never reaches
    // this process, and the Ledger plugin supplies the account and signature at
    // the JSON-RPC layer.
    [LEDGER_NETWORK]: {
      type: "http",
      chainType: "l1",
      chainId: expectedChainId(),
      url: configVariable("RPC_URL"),
      ledgerAccounts: ledgerAccounts(),
    },
  },
};

export default config;
