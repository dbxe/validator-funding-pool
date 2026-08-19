import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseExpectedChainId } from "../hardhat.config.js";

/// The config module is testable because importing it starts nothing: it builds a plain
/// object, and the two environment reads it makes at import time (`EXPECTED_CHAIN_ID`,
/// `LEDGER_ADDRESS`) are both no-ops when unset. `parseExpectedChainId` takes the declaration
/// as an argument so the cases below need neither `process.env` nor a defeated module cache.
describe("parseExpectedChainId", function () {
  it("declares nothing for an empty declaration", function () {
    // Unset leaves hardhat's `chainId` field off the network entirely, which is what keeps
    // devnet and testnet runs working: the validator handler is installed only when it is set.
    assert.equal(parseExpectedChainId(""), undefined);
  });

  it("accepts canonical positive decimals, mainnet included", function () {
    assert.equal(parseExpectedChainId("1"), 1);
    assert.equal(parseExpectedChainId("31337"), 31337);
    assert.equal(parseExpectedChainId("11155111"), 11155111);
  });

  it("refuses every non-canonical spelling, naming the variable", function () {
    for (const value of ["0", "01", "0x1", "+1", "-1", "1.0", "1e3", "1_000", " 1", "1 ", "one"]) {
      assert.throws(
        () => parseExpectedChainId(value),
        new RegExp(
          `^Error: EXPECTED_CHAIN_ID ${value.replace(/[+.]/g, "\\$&")} is not a canonical ` +
            `positive decimal integer`,
        ),
      );
    }
  });

  it("accepts MAX_SAFE_INTEGER and refuses the integer above it", function () {
    // Both sides of the boundary, because the boundary is the whole point: `Number` converts
    // the value below exactly and the value above it to something else, with no error of its
    // own. 9007199254740993 becomes 9007199254740992, and a pin installed for a chain id the
    // operator did not declare is worse than no pin at all.
    assert.equal(parseExpectedChainId("9007199254740991"), Number.MAX_SAFE_INTEGER);
    assert.equal(Number("9007199254740993"), 9007199254740992);

    assert.throws(
      () => parseExpectedChainId("9007199254740993"),
      (error: Error) => {
        assert.match(error.message, /^EXPECTED_CHAIN_ID 9007199254740993 is above /);
        assert.match(error.message, /Number\.MAX_SAFE_INTEGER \(9007199254740991\)/);
        // The message says what it WOULD have pinned, which is the fact the operator needs.
        assert.match(error.message, /would pin 9007199254740992 instead/);
        assert.match(error.message, /Mainnet is EXPECTED_CHAIN_ID=1/);
        return true;
      },
    );
  });

  it("refuses declarations far above the boundary, where the loss is larger", function () {
    for (const value of ["9007199254740994", "18446744073709551617", "1".repeat(30)]) {
      assert.throws(
        () => parseExpectedChainId(value),
        new RegExp(`^Error: EXPECTED_CHAIN_ID ${value} is above Number\\.MAX_SAFE_INTEGER`),
      );
    }
  });
});
