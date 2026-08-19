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
      url: configVariable("RPC_URL"),
    },
    // Hardware-wallet path. No `accounts` entry: the signing key never reaches
    // this process, and the Ledger plugin supplies the account and signature at
    // the JSON-RPC layer.
    [LEDGER_NETWORK]: {
      type: "http",
      chainType: "l1",
      url: configVariable("RPC_URL"),
      ledgerAccounts: ledgerAccounts(),
    },
  },
};

export default config;
