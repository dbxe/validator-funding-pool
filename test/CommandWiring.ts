import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
);

/// The one command that signs nothing. It carries the `--no-compile` guard like every other —
/// it prints a runtime-code pass, and a pass reported against a stale artifact is the thing
/// that guard exists to prevent — and it must NOT resolve transaction fields, because it
/// composes no transaction and a fee line there would be describing nothing.
const NON_TRANSACTING = "status";

/// Every command that composes a transaction, and the label each one passes.
///
/// This list is asserted to be exactly the set of scripts on disk, minus `status`. That is
/// what makes it a wiring check rather than a list of examples: a command added without the
/// transaction fields, or a command whose fields are dropped from a write, fails here.
const TRANSACTING_COMMANDS = [
  "claim",
  "close-expired-funding-attempt",
  "commit-predeposit",
  "deploy",
  "deploy-forwarder",
  "fund",
  "open-funding-attempt",
  "refund",
  "request-exit",
  "sweep",
  "top-up",
];

function scriptSource(command: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, `${command}.ts`), "utf8");
}

/// Every call in a script that hands a transaction to the signer — a contract write, a plain
/// `sendTransaction`, or a `sendDeploymentTransaction` — with its full argument text, found by
/// matching parentheses from the opening one.
function signingCalls(source: string): string[] {
  return callsMatching(source, /(\.write\.\w+|\.sendTransaction|\.sendDeploymentTransaction)\(/g);
}

/// Every call whose opening matches `opener` (which must end at the opening parenthesis), with
/// its full argument text.
function callsMatching(source: string, opener: RegExp): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(opener)) {
    let depth = 0;
    const start = match.index + match[0].length - 1;
    for (let i = start; i < source.length; ++i) {
      if (source[i] === "(") depth += 1;
      if (source[i] === ")") depth -= 1;
      if (depth === 0) {
        calls.push(source.slice(match.index, i + 1));
        break;
      }
    }
  }
  return calls;
}

/// A structural scan of the script sources rather than a run of each command.
///
/// The choice is deliberate and it is about cost. Driving all eleven commands end to end for
/// this one property would mean building eleven chain states — the sweep needs a topped-up
/// pool, the exit needs an eligible validator — for a claim that is settled by whether one
/// call is present in one file. `test-e2e/Commands.e2e.ts` already drives each of these
/// commands for real and asserts the fee line, the signed fields, and the `--no-compile`
/// refusal on the ones it reaches; what that suite does not have is a reason to fail when the
/// wiring disappears from a command it happens not to cover. This does.
///
/// The limitation, stated rather than hidden: source text is not behavior. A call present but
/// unreachable would pass here. The e2e suite is what establishes the calls actually fire; the
/// job of this file is to make deleting one from ANY command fail the suite.
describe("transacting-command wiring", function () {
  it("enumerates exactly the scripts on disk, so a new command cannot skip the table", function () {
    const onDisk = readdirSync(SCRIPTS_DIR)
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => entry.slice(0, -".ts".length))
      .sort();

    assert.deepEqual(onDisk, [...TRANSACTING_COMMANDS, NON_TRANSACTING].sort());
  });

  for (const command of TRANSACTING_COMMANDS) {
    it(`${command} sets and prints its transaction fields and refuses --no-compile, under its own label`, function () {
      const source = scriptSource(command);

      // The label is part of the assertion. Every one of these lines is copied from a sibling
      // script, and a fee line or a refusal printed under another command's name is a message
      // that names the wrong command at the moment an operator is reading it hardest.
      assert.ok(
        source.includes(`resolveTransactionFields(publicClient, "${command}",`),
        `scripts/${command}.ts does not resolve its transaction fields under its own label. The ` +
          `Ledger plugin refuses a transaction without gas and fee fields (HHE713), and the ` +
          `keystore path would otherwise sign a fee nobody was shown.`,
      );
      // And every write carries them. A write without `fields` is one the Ledger plugin
      // refuses, and on the keystore path one whose fee was never printed.
      const calls = signingCalls(source);
      assert.ok(calls.length > 0, `scripts/${command}.ts has no signing call this scan recognises`);
      for (const call of calls) {
        assert.ok(
          /\bfields\b/.test(call),
          `scripts/${command}.ts sends a transaction without the resolved fields: ${call}`,
        );
      }

      // The signer is chosen by `resolveSigningWallet` and nowhere else. `getWalletClients()`
      // taken positionally, or a contract or deployment helper left to hardhat-viem's default
      // wallet, is the first account `eth_accounts` lists — on the Ledger path, the node's.
      assert.ok(
        source.includes(`resolveSigningWallet(connection, "${command}")`),
        `scripts/${command}.ts does not choose its wallet through resolveSigningWallet under its own label`,
      );
      assert.ok(
        !source.includes("getWalletClients("),
        `scripts/${command}.ts takes a wallet client by position`,
      );
      const clientTaking = callsMatching(source, /\.(getContractAt|sendDeploymentTransaction)\(/g);
      assert.ok(clientTaking.length > 0);
      for (const call of clientTaking) {
        assert.ok(
          /client: \{ wallet(: \w+)? \}/.test(call),
          `scripts/${command}.ts leaves hardhat-viem to pick the wallet: ${call}`,
        );
      }
      assert.ok(
        source.includes(`assertCompilationNotSkipped("${command}")`),
        `scripts/${command}.ts does not refuse --no-compile under its own label. Without it the ` +
          `runtime-code comparison prints a pass against whatever artifact was left on disk.`,
      );
      // Imported rather than shadowed by a local definition of the same name.
      assert.ok(source.includes(`from "./lib/common.js"`));
    });
  }

  it("wires status with the guard but no transaction fields, because it composes nothing", function () {
    const source = scriptSource(NON_TRANSACTING);

    assert.ok(source.includes(`assertCompilationNotSkipped("${NON_TRANSACTING}")`));
    assert.ok(!source.includes("resolveTransactionFields"));
    assert.deepEqual(signingCalls(source), []);
  });
});
