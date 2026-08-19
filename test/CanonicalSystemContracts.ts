import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Hex } from "viem";

import {
  CANONICAL_SYSTEM_CONTRACTS,
  DEFAULT_DEPOSIT_CONTRACT,
  DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY,
} from "../scripts/lib/common.js";
import {
  CANONICAL_DEPOSIT_CONTRACT_CODE_HASH,
  CANONICAL_PREDEPLOY_CODE_HASH,
  DEPOSIT_CONTRACT_ADDRESS,
  DEPOSIT_CONTRACT_FIXTURE_FILE,
  fixturePath,
  WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS,
  WITHDRAWAL_REQUEST_PREDEPLOY_FIXTURE_FILE,
} from "../test-e2e/local-chain.js";

/// The canonicity pin is written down in four places, on purpose, and this is what keeps the
/// four in agreement.
///
/// `CANONICAL_SYSTEM_CONTRACTS` is the pin every command applies on mainnet. The two
/// `test-e2e/fixtures/*.json` files carry the upstream artifacts the end-to-end harness
/// installs at the real mainnet addresses, each with its own expected runtime hash, and
/// `test-e2e/local-chain.ts` refuses to start unless the code it installed hashes to that
/// expectation. The literals in `local-chain.ts` are what the command tests require the
/// deployment record to carry.
///
/// None of those copies imports the pin, and that is deliberate: a harness that took the
/// value from the thing it is testing would agree with any value the pin happened to hold.
/// The cost of the independence is drift — a copy updated on one side and not the other
/// leaves a harness that proves nothing while reporting a pass — and this file is what makes
/// drift fail the unit suite instead. It needs no chain and no network: it is four string
/// comparisons and a read of two files already in the checkout.
///
/// `SECURITY.md` §5 ("The canonicity pin has never fired in anger") states the chain of
/// evidence this closes. If a value here has to change, re-derive it from the upstream source
/// named above `CANONICAL_SYSTEM_CONTRACTS` — never from what a chain reports.
interface FixtureExpectation {
  expectedRuntimeCodeHash: Hex;
  expectedRuntimeByteLength: number;
}

function fixture(name: string): FixtureExpectation {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as FixtureExpectation;
}

describe("the canonical system-contract pin and every copy of it", function () {
  const mainnet = CANONICAL_SYSTEM_CONTRACTS[1];

  it("is recorded for mainnet and for no other chain", function () {
    assert.deepEqual(Object.keys(CANONICAL_SYSTEM_CONTRACTS), ["1"]);
    assert.ok(mainnet !== undefined, "no canonical entry for chain id 1");
    // A pin for a second chain would silently change which rehearsals exercise the
    // comparison rather than the warning branch, which is the property the end-to-end
    // harness asserts.
    assert.equal(CANONICAL_SYSTEM_CONTRACTS[31337], undefined);
  });

  it("pins the two mainnet system contracts at the addresses the defaults name", function () {
    assert.equal(mainnet.depositContract, DEFAULT_DEPOSIT_CONTRACT);
    assert.equal(mainnet.withdrawalRequestPredeploy, DEFAULT_WITHDRAWAL_REQUEST_PREDEPLOY);
    // And the harness installs its fixtures at exactly those addresses, which is what makes
    // the code hashes it produces comparable to these at all.
    assert.equal(DEPOSIT_CONTRACT_ADDRESS, mainnet.depositContract);
    assert.equal(WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS, mainnet.withdrawalRequestPredeploy);
  });

  it("agrees with the end-to-end fixtures the harness installs and checks", function () {
    const deposit = fixture(DEPOSIT_CONTRACT_FIXTURE_FILE);
    const predeploy = fixture(WITHDRAWAL_REQUEST_PREDEPLOY_FIXTURE_FILE);

    assert.equal(deposit.expectedRuntimeCodeHash, mainnet.depositContractCodeHash);
    assert.equal(predeploy.expectedRuntimeCodeHash, mainnet.withdrawalRequestPredeployCodeHash);

    // The byte lengths the provenance comment above `CANONICAL_SYSTEM_CONTRACTS` quotes,
    // asserted rather than left as prose: a fixture of a different size is a different
    // artifact whatever it hashes to.
    assert.equal(deposit.expectedRuntimeByteLength, 6358);
    assert.equal(predeploy.expectedRuntimeByteLength, 504);
  });

  it("agrees with the literals the command tests hold the deployment record to", function () {
    assert.equal(CANONICAL_DEPOSIT_CONTRACT_CODE_HASH, mainnet.depositContractCodeHash);
    assert.equal(CANONICAL_PREDEPLOY_CODE_HASH, mainnet.withdrawalRequestPredeployCodeHash);
  });
});
