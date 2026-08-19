import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { REPO_ROOT } from "./paths.js";

/// Every supported command is `hardhat run scripts/<name>.ts --network <network>`, which is
/// exactly what `package.json` runs. The tests drive that command line rather than importing
/// the script, so what they exercise is the wiring — argv, network selection, config
/// variable resolution, the `main().catch` path, and the text an operator reads — and not
/// just the helpers underneath it.
export interface CommandRun {
  /// Script base name, e.g. `"fund"`.
  script: string;
  /// Hardhat network name. Mirrors the package.json script: `read` for `status`, `rpc`
  /// otherwise.
  network?: string;
  /// Environment for the child. Only these variables plus the small inherited base below
  /// reach it; the parent's own secrets never do.
  env: Record<string, string | undefined>;
  /// Extra arguments appended after `--network <name>`, exactly where `npm run <script> --
  /// <args>` puts them. This is how the flag cases are driven in the form an operator would
  /// actually type.
  args?: readonly string[];
}

export interface CommandResult {
  commandLine: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /// stdout and stderr interleaved in arrival order, which is what a terminal shows.
  output: string;
}

/// The variables a child needs to be able to run `npx hardhat` at all. Everything the
/// commands themselves read — `RPC_URL`, `PRIVATE_KEY`, `BEACON_NODE_URL`, and the rest — is
/// supplied per run, so a variable that leaks in from the developer's shell cannot silently
/// decide a test.
const INHERITED = ["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "USER"] as const;

export async function runCommand(run: CommandRun): Promise<CommandResult> {
  const network = run.network ?? "rpc";
  const args = [
    "hardhat",
    "run",
    `scripts/${run.script}.ts`,
    "--network",
    network,
    ...(run.args ?? []),
  ];
  const env: Record<string, string> = {
    // Colour control codes would land in the middle of the exact lines these tests assert
    // on, so both conventions are set.
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(run.env)) {
    if (value !== undefined) env[name] = value;
  }

  const child = spawn("npx", args, {
    cwd: REPO_ROOT,
    env,
    // stdin is a pipe that is closed immediately: not a TTY. That is the state a cron job,
    // a CI runner, or a piped shell has, and it is what the excess-balance confirmation
    // must refuse.
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    output += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`${run.script} was killed by ${signal}`));
        return;
      }
      resolve(code);
    });
  });

  return {
    commandLine: `npx ${args.join(" ")}`,
    exitCode,
    stdout,
    stderr,
    output,
  };
}

export function expectSuccess(result: CommandResult): CommandResult {
  assert.equal(
    result.exitCode,
    0,
    `${result.commandLine} was expected to succeed but exited ${result.exitCode}:\n${result.output}`,
  );
  return result;
}

export function expectFailure(result: CommandResult): CommandResult {
  assert.notEqual(
    result.exitCode,
    0,
    `${result.commandLine} was expected to fail but exited 0:\n${result.output}`,
  );
  return result;
}

export function assertOutputContains(result: CommandResult, needle: string) {
  assert.ok(
    result.output.includes(needle),
    `${result.commandLine} output does not contain ${JSON.stringify(needle)}:\n${result.output}`,
  );
}

export function assertOutputLacks(result: CommandResult, needle: string) {
  assert.ok(
    !result.output.includes(needle),
    `${result.commandLine} output unexpectedly contains ${JSON.stringify(needle)}:\n${result.output}`,
  );
}

/// Requires both lines to be present AND `first` to come before `second` in the interleaved
/// output a terminal shows.
///
/// Order is the whole point for anything printed so it can be compared before an approval:
/// the same line after the transaction is a report, not a check.
export function assertOutputOrder(result: CommandResult, first: string, second: string) {
  const firstAt = result.output.indexOf(first);
  const secondAt = result.output.indexOf(second);
  assert.ok(
    firstAt >= 0,
    `${result.commandLine} output does not contain ${JSON.stringify(first)}:\n${result.output}`,
  );
  assert.ok(
    secondAt >= 0,
    `${result.commandLine} output does not contain ${JSON.stringify(second)}:\n${result.output}`,
  );
  assert.ok(
    firstAt < secondAt,
    `${result.commandLine} printed ${JSON.stringify(first)} AFTER ` +
      `${JSON.stringify(second)}:\n${result.output}`,
  );
}

/// The print-always invariant: every command that signs prints which account it is about to
/// sign with, on every network, before anything else happens.
export function assertActiveSignerPrinted(result: CommandResult, script: string, signer: string) {
  assertOutputContains(result, `${script} active signer: ${signer} (network `);
}
