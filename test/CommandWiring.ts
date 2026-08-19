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
/// that guard exists to prevent — and it must NOT carry a fee preview, because it composes no
/// transaction and a fee line there would be describing nothing.
const NON_TRANSACTING = "status";

/// Every command that composes a transaction, and the label each one passes.
///
/// This list is asserted to be exactly the set of scripts on disk, minus `status`. That is
/// what makes it a wiring check rather than a list of examples: a command added without the
/// preview, or a command whose preview is deleted, fails here.
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

/// A structural scan of the script sources rather than a run of each command.
///
/// The choice is deliberate and it is about cost. Driving all eleven commands end to end for
/// this one property would mean building eleven chain states — the sweep needs a topped-up
/// pool, the exit needs an eligible validator — for a claim that is settled by whether one
/// call is present in one file. `test-e2e/Commands.e2e.ts` already drives each of these
/// commands for real and asserts the fee line and the `--no-compile` refusal on the ones it
/// reaches; what that suite does not have is a reason to fail when the wiring disappears from
/// a command it happens not to cover. This does.
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
    it(`${command} previews the fee and refuses --no-compile, under its own label`, function () {
      const source = scriptSource(command);

      // The label is part of the assertion. Every one of these lines is copied from a sibling
      // script, and a preview or a refusal printed under another command's name is a message
      // that names the wrong command at the moment an operator is reading it hardest.
      assert.ok(
        source.includes(`printSuggestedFees(publicClient, "${command}")`),
        `scripts/${command}.ts does not preview the fee under its own label. The keystore path ` +
          `signs whatever fee the endpoint supplies with no human in the loop; this line is the ` +
          `only place that path sees the number.`,
      );
      assert.ok(
        source.includes(`assertCompilationNotSkipped("${command}")`),
        `scripts/${command}.ts does not refuse --no-compile under its own label. Without it the ` +
          `runtime-code comparison prints a pass against whatever artifact was left on disk.`,
      );
      // Imported rather than shadowed by a local definition of the same name.
      assert.ok(source.includes(`from "./lib/common.js"`));
    });
  }

  it("wires status with the guard but no fee preview, because it composes nothing", function () {
    const source = scriptSource(NON_TRANSACTING);

    assert.ok(source.includes(`assertCompilationNotSkipped("${NON_TRANSACTING}")`));
    assert.ok(!source.includes("printSuggestedFees"));
  });
});
