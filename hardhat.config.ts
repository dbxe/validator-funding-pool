import type { HardhatUserConfig } from "hardhat/config";

import hardhatLedgerPlugin from "@nomicfoundation/hardhat-ledger";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";

const LEDGER_NETWORK = "ledger";

/// Network selected for this process, mirroring Hardhat's own precedence: the
/// `--network` CLI option wins over the `HARDHAT_NETWORK` environment variable.
function selectedNetwork(): string | undefined {
  const flagIndex = process.argv.indexOf("--network");
  if (flagIndex !== -1) return process.argv[flagIndex + 1];
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
