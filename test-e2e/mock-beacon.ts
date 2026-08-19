import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { Address, Hex } from "viem";

/// A deterministic stand-in for a beacon node, serving exactly the routes the preflights in
/// `scripts/lib/common.ts` fetch.
///
/// The response bodies mirror the shapes a real consensus client returns, field for field:
/// every integer is a decimal STRING, every root and credential is a 0x-prefixed hex string
/// of the right byte length, and the `data` envelope carries the same `execution_optimistic`
/// / `finalized` siblings a real client sends alongside it. That fidelity is the point — the
/// strict shape validators (`assertBeaconValidatorResponseShape`,
/// `assertBeaconSyncingResponseShape`, `parseBeaconUint64`, `requireBeaconHex`) reject
/// anything looser, so a mock that answered with JSON numbers or bare objects would prove
/// nothing about the commands and everything about the mock.
///
/// Every scenario the tests need is a mutation of the state below, applied between command
/// runs. Nothing here is time-dependent or random.

const FAR_FUTURE_EPOCH = "18446744073709551615";

/// Mainnet's genesis fork version and validators root. The deposit data the harness signs
/// uses this fork version, so `validateDepositData`'s fork-version comparison and the BLS
/// domain both run against a real value rather than a placeholder.
export const GENESIS_FORK_VERSION = "0x00000000";
const GENESIS_VALIDATORS_ROOT =
  "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95";
const GENESIS_TIME = "1606824023";

/// What the head and finalized states say about one validator. `present: false` is the
/// fresh-pubkey case: the list endpoint answers 200 with an empty array and the
/// single-validator endpoint answers 404, exactly as a real client does for a pubkey it has
/// never seen.
export interface ValidatorState {
  present: boolean;
  index: string;
  status: string;
  balanceGwei: string;
  effectiveBalanceGwei: string;
  slashed: boolean;
  withdrawalCredentials: Hex;
  activationEligibilityEpoch: string;
  activationEpoch: string;
  exitEpoch: string;
  withdrawableEpoch: string;
}

/// Named mutations that make one field of one response wrong in a way a strict validator
/// must reject. Each is a single field, so the assertion the test makes names the field the
/// command rejected rather than "the mock was broken somehow".
export type Malformation =
  /// A JSON number where the beacon API specifies a decimal string.
  | "balance-as-number"
  /// `is_optimistic` absent from the syncing response. The interface declares it required
  /// precisely so an omission cannot be read as healthy.
  | "syncing-missing-is-optimistic"
  /// Credentials truncated to 31 bytes.
  | "short-withdrawal-credentials"
  /// A body with no `data` envelope at all, as a proxy's error page would produce.
  | "no-data-envelope";

export interface BeaconScenario {
  /// Keyed by lowercase 0x-prefixed pubkey.
  validators: Map<string, ValidatorState>;
  chainId: string;
  depositContractAddress: Address;
  headSlot: string;
  isSyncing: boolean;
  isOptimistic: boolean;
  elOffline: boolean;
  malformation?: Malformation;
}

export function freshPredepositValidator(withdrawalCredentials: Hex): ValidatorState {
  return {
    present: true,
    index: "1863048",
    status: "pending_initialized",
    balanceGwei: "1000000000",
    effectiveBalanceGwei: "1000000000",
    slashed: false,
    withdrawalCredentials,
    activationEligibilityEpoch: FAR_FUTURE_EPOCH,
    activationEpoch: FAR_FUTURE_EPOCH,
    exitEpoch: FAR_FUTURE_EPOCH,
    withdrawableEpoch: FAR_FUTURE_EPOCH,
  };
}

/// A validator the exit preflight will accept: active, unexited, unslashed, and activated
/// long enough ago to be past `SHARD_COMMITTEE_PERIOD` at the head slot below.
export function activeValidator(withdrawalCredentials: Hex): ValidatorState {
  return {
    present: true,
    index: "1863048",
    status: "active_ongoing",
    balanceGwei: "32000000000",
    effectiveBalanceGwei: "32000000000",
    slashed: false,
    withdrawalCredentials,
    activationEligibilityEpoch: "356100",
    activationEpoch: "356200",
    exitEpoch: FAR_FUTURE_EPOCH,
    withdrawableEpoch: FAR_FUTURE_EPOCH,
  };
}

export function absentValidator(): ValidatorState {
  return { ...freshPredepositValidator(`0x${"00".repeat(32)}`), present: false };
}

export class MockBeaconNode {
  readonly scenario: BeaconScenario;
  #server: Server;
  #port = 0;

  constructor(chainId: number, depositContractAddress: Address) {
    this.scenario = {
      validators: new Map(),
      chainId: chainId.toString(),
      depositContractAddress,
      headSlot: "11419328",
      isSyncing: false,
      isOptimistic: false,
      elOffline: false,
      // Declared explicitly, not left off: `withScenario` restores by copying own
      // properties back, and a key that was absent before the mutation would not be
      // restored at all — one test's malformed response would then leak into every test
      // after it.
      malformation: undefined,
    };
    this.#server = createServer((request, response) => this.#handle(request, response));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  setValidator(pubkey: Hex, state: ValidatorState) {
    this.scenario.validators.set(pubkey.toLowerCase(), state);
  }

  /// Applies a scenario for the duration of one command run and restores it afterwards.
  async withScenario<T>(mutate: (scenario: BeaconScenario) => void, run: () => Promise<T>): Promise<T> {
    const savedValidators = new Map(this.scenario.validators);
    const saved = { ...this.scenario };
    mutate(this.scenario);
    try {
      return await run();
    } finally {
      Object.assign(this.scenario, saved);
      this.scenario.validators = savedValidators;
    }
  }

  #handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", this.url);
    const route = url.pathname;

    if (route === "/eth/v1/node/syncing") return this.#json(response, 200, this.#syncing());
    if (route === "/eth/v1/config/deposit_contract") {
      return this.#json(response, 200, {
        data: {
          chain_id: this.scenario.chainId,
          address: this.scenario.depositContractAddress,
        },
      });
    }
    if (route === "/eth/v1/config/spec") return this.#json(response, 200, { data: SPEC });
    if (route === "/eth/v1/beacon/genesis") {
      return this.#json(response, 200, {
        data: {
          genesis_time: GENESIS_TIME,
          genesis_validators_root: GENESIS_VALIDATORS_ROOT,
          genesis_fork_version: GENESIS_FORK_VERSION,
        },
      });
    }

    const checkpoints = /^\/eth\/v1\/beacon\/states\/([^/]+)\/finality_checkpoints$/.exec(route);
    if (checkpoints !== null) {
      return this.#json(response, 200, {
        execution_optimistic: false,
        finalized: checkpoints[1] === "finalized",
        data: FINALITY_CHECKPOINTS,
      });
    }

    const listing = /^\/eth\/v1\/beacon\/states\/([^/]+)\/validators$/.exec(route);
    if (listing !== null) {
      const entries: unknown[] = [];
      for (const id of url.searchParams.getAll("id")) {
        const state = this.scenario.validators.get(id.toLowerCase());
        if (state === undefined || !state.present) continue;
        entries.push(this.#validatorEntry(id as Hex, state));
      }
      return this.#json(response, 200, {
        execution_optimistic: false,
        finalized: listing[1] === "finalized",
        data: entries,
      });
    }

    const single = /^\/eth\/v1\/beacon\/states\/([^/]+)\/validators\/([^/]+)$/.exec(route);
    if (single !== null) {
      const pubkey = single[2] as Hex;
      const state = this.scenario.validators.get(pubkey.toLowerCase());
      if (state === undefined || !state.present) {
        // The shape Lighthouse and Nimbus answer with for an unknown validator.
        return this.#json(response, 404, {
          code: 404,
          message: "NOT_FOUND: beacon state does not contain the requested validator",
        });
      }
      if (this.scenario.malformation === "no-data-envelope") {
        return this.#json(response, 200, { code: 500, message: "INTERNAL_SERVER_ERROR" });
      }
      return this.#json(response, 200, {
        execution_optimistic: false,
        finalized: single[1] === "finalized",
        data: this.#validatorEntry(pubkey, state),
      });
    }

    return this.#json(response, 404, { code: 404, message: `NOT_FOUND: no route ${route}` });
  }

  #syncing(): unknown {
    const data: Record<string, unknown> = {
      head_slot: this.scenario.headSlot,
      sync_distance: "0",
      is_syncing: this.scenario.isSyncing,
      is_optimistic: this.scenario.isOptimistic,
      el_offline: this.scenario.elOffline,
    };
    if (this.scenario.malformation === "syncing-missing-is-optimistic") delete data.is_optimistic;
    return { data };
  }

  #validatorEntry(pubkey: Hex, state: ValidatorState): unknown {
    const credentials =
      this.scenario.malformation === "short-withdrawal-credentials"
        ? state.withdrawalCredentials.slice(0, 64)
        : state.withdrawalCredentials;
    return {
      index: state.index,
      balance:
        this.scenario.malformation === "balance-as-number"
          ? Number(state.balanceGwei)
          : state.balanceGwei,
      status: state.status,
      validator: {
        pubkey,
        withdrawal_credentials: credentials,
        effective_balance: state.effectiveBalanceGwei,
        slashed: state.slashed,
        activation_eligibility_epoch: state.activationEligibilityEpoch,
        activation_epoch: state.activationEpoch,
        exit_epoch: state.exitEpoch,
        withdrawable_epoch: state.withdrawableEpoch,
      },
    };
  }

  #json(response: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload).toString(),
    });
    response.end(payload);
  }
}

/// Mainnet finality checkpoints, shaped as a real client returns them. Nothing in the
/// preflights decides on these values; they are printed, and their envelope is validated.
const FINALITY_CHECKPOINTS = {
  previous_justified: {
    epoch: "356853",
    root: "0x3f4d1a37e2f2fd3c1cbb0a4f5e0f4a2b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f",
  },
  current_justified: {
    epoch: "356854",
    root: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
  },
  finalized: {
    epoch: "356853",
    root: "0x1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a",
  },
};

/// The subset of `/eth/v1/config/spec` the exit preflight reads, plus enough neighbours that
/// the response looks like the real one rather than a two-key stub.
const SPEC: Record<string, string> = {
  CONFIG_NAME: "mainnet",
  DEPOSIT_CHAIN_ID: "1",
  DEPOSIT_NETWORK_ID: "1",
  SECONDS_PER_SLOT: "12",
  SLOTS_PER_EPOCH: "32",
  SHARD_COMMITTEE_PERIOD: "256",
  MIN_DEPOSIT_AMOUNT: "1000000000",
  MAX_EFFECTIVE_BALANCE: "32000000000",
  FAR_FUTURE_EPOCH,
};
