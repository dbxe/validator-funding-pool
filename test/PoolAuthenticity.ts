import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, type Address, type Hex } from "viem";

import type { BuildArtifact, BuildCandidate } from "../scripts/lib/common.js";
import {
  assertDeploymentIntegrity,
  assertDeploymentMatchesPool,
  assertForwarderAuthenticity,
  assertRuntimeCodeMatchesLocalBuild,
  deriveWithdrawalCredentials,
  maskImmutableRanges,
  readLocalBuildArtifacts,
  VERIFIED_FORWARDER,
  VERIFIED_POOL,
} from "../scripts/lib/common.js";

const EXIT_FEE = 1_234n;
const POOL_ARTIFACT_FILE = path.join(
  "artifacts",
  "contracts",
  "ValidatorFundingPool.sol",
  "ValidatorFundingPool.json",
);

function localArtifact(): BuildArtifact {
  return JSON.parse(readFileSync(POOL_ARTIFACT_FILE, "utf8")) as BuildArtifact;
}

function candidateOf(artifact: BuildArtifact, profile = "test"): BuildCandidate[] {
  return [{ source: POOL_ARTIFACT_FILE, profile, artifact }];
}

/// Every byte offset the artifact declares as immutable, i.e. every offset the comparison
/// is entitled to ignore.
function immutableOffsets(artifact: BuildArtifact): Set<number> {
  const offsets = new Set<number>();
  for (const ranges of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of ranges) {
      for (let i = start; i < start + length; ++i) offsets.add(i);
    }
  }
  return offsets;
}

function toBytes(code: Hex): Buffer {
  return Buffer.from(code.slice(2), "hex");
}

function toHex(bytes: Buffer): Hex {
  return `0x${bytes.toString("hex")}` as Hex;
}

/// Offsets at which two equal-length runtime codes differ.
function differingOffsets(left: Hex, right: Hex): number[] {
  const a = toBytes(left);
  const b = toBytes(right);
  assert.equal(a.length, b.length, "runtime codes have different lengths");
  const offsets: number[] = [];
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) offsets.push(i);
  return offsets;
}

function codeReader(code: Hex | undefined) {
  return { getCode: async (_args: { address: Address }) => code };
}

async function silentlyAsync<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}

describe("pool authenticity", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  /// Two pools from the same source, with every constructor argument different. Their
  /// runtime codes differ, and the only thing that may differ is the immutables.
  async function twoPoolsFixture() {
    const [first, second] = await viem.getWalletClients();
    const depositA = await viem.deployContract("MockDepositContract");
    const depositB = await viem.deployContract("MockDepositContract");
    const withdrawalA = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const withdrawalB = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE + 1n]);

    const poolA = await viem.deployContract("ValidatorFundingPool", [
      depositA.address,
      withdrawalA.address,
      first.account.address,
      3_600n,
    ]);
    const poolB = await viem.deployContract("ValidatorFundingPool", [
      depositB.address,
      withdrawalB.address,
      second.account.address,
      7_200n,
    ]);
    return { poolA, poolB, depositA, withdrawalA, first };
  }

  it("derives withdrawal credentials exactly as the contract does", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);

    assert.equal(
      (await poolA.read.withdrawalCredentials()).toLowerCase(),
      deriveWithdrawalCredentials(poolA.address),
    );
    assert.equal(
      deriveWithdrawalCredentials("0x00000000219ab540356cBB839Cbe05303d7705Fa"),
      "0x01000000000000000000000000000000219ab540356cbb839cbe05303d7705fa",
    );
  });

  it("refuses a pool that reports another address's withdrawal credentials", async function () {
    const pool = "0x1111111111111111111111111111111111111111" as Address;
    const impostor = "0x2222222222222222222222222222222222222222" as Address;
    const deployment = {
      pool,
      depositContract: "0x3333333333333333333333333333333333333333" as Address,
      withdrawalRequestPredeploy: "0x4444444444444444444444444444444444444444" as Address,
      operator: "0x5555555555555555555555555555555555555555" as Address,
      // The record agrees with the pool perfectly. That is the point: both sides are the
      // operator's, so agreement between them proves nothing about ownership.
      withdrawalCredentials: deriveWithdrawalCredentials(impostor),
      fundingWindowDuration: "3600",
      chainId: 31337,
      depositContractCodeHash: `0x${"11".repeat(32)}` as Hex,
      withdrawalRequestPredeployCodeHash: `0x${"22".repeat(32)}` as Hex,
    };
    const reader = {
      read: {
        depositContract: async () => deployment.depositContract,
        withdrawalRequestPredeploy: async () => deployment.withdrawalRequestPredeploy,
        operator: async () => deployment.operator,
        withdrawalCredentials: async () => deployment.withdrawalCredentials,
        fundingWindowDuration: async () => 3_600n,
      },
    };

    await assert.rejects(
      assertDeploymentMatchesPool(reader, deployment),
      (error: Error) => {
        assert.match(error.message, /reports withdrawal credentials/);
        assert.match(error.message, new RegExp(deriveWithdrawalCredentials(pool)));
        assert.match(error.message, /Do not send capital to this address/);
        return true;
      },
    );

    // The same reader with credentials derived from its own address is accepted, and the
    // returned config carries the derived value.
    const honest = { ...deployment, withdrawalCredentials: deriveWithdrawalCredentials(pool) };
    const liveConfig = await assertDeploymentMatchesPool(
      { read: { ...reader.read, withdrawalCredentials: async () => honest.withdrawalCredentials } },
      honest,
    );
    assert.equal(liveConfig.withdrawalCredentials, deriveWithdrawalCredentials(pool));
  });

  it("returns the derived credentials even when the pool reports a differently cased copy", async function () {
    const pool = "0x1111111111111111111111111111111111111111" as Address;
    const derived = deriveWithdrawalCredentials(pool);
    const deployment = {
      pool,
      depositContract: "0x3333333333333333333333333333333333333333" as Address,
      withdrawalRequestPredeploy: "0x4444444444444444444444444444444444444444" as Address,
      operator: "0x5555555555555555555555555555555555555555" as Address,
      withdrawalCredentials: derived.toUpperCase().replace("0X", "0x") as Hex,
      fundingWindowDuration: "3600",
      chainId: 31337,
      depositContractCodeHash: `0x${"11".repeat(32)}` as Hex,
      withdrawalRequestPredeployCodeHash: `0x${"22".repeat(32)}` as Hex,
    };
    const reader = {
      read: {
        depositContract: async () => deployment.depositContract,
        withdrawalRequestPredeploy: async () => deployment.withdrawalRequestPredeploy,
        operator: async () => deployment.operator,
        withdrawalCredentials: async () => deployment.withdrawalCredentials,
        fundingWindowDuration: async () => 3_600n,
      },
    };

    assert.equal((await assertDeploymentMatchesPool(reader, deployment)).withdrawalCredentials, derived);
  });

  it("accepts two deployments whose runtime codes differ only in their immutables", async function () {
    const { poolA, poolB } = await networkHelpers.loadFixture(twoPoolsFixture);
    const artifact = localArtifact();
    const codeA = (await publicClient.getCode({ address: poolA.address })) as Hex;
    const codeB = (await publicClient.getCode({ address: poolB.address })) as Hex;

    // The premise of the whole check: same code, different constructor arguments, and the
    // raw bytes really do differ. If this ever stops being true the masking below is
    // proving nothing.
    assert.notEqual(codeA, codeB);
    const differences = differingOffsets(codeA, codeB);
    assert.ok(differences.length > 0);
    const masked = immutableOffsets(artifact);
    assert.deepEqual(
      differences.filter((offset) => !masked.has(offset)),
      [],
      "two deployments of the same source differ outside their immutable ranges",
    );

    // ... and masking exactly those ranges makes the two identical.
    const references = artifact.immutableReferences ?? {};
    assert.equal(
      maskImmutableRanges(codeA, references, "A").masked,
      maskImmutableRanges(codeB, references, "B").masked,
    );

    for (const pool of [poolA, poolB]) {
      const matched = await silentlyAsync(() =>
        assertRuntimeCodeMatchesLocalBuild(publicClient, pool.address, candidateOf(artifact)),
      );
      assert.equal(matched.source, POOL_ARTIFACT_FILE);
    }
  });

  it("reports which local build artifact and solidity profile matched", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);
    const candidates = readLocalBuildArtifacts();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    try {
      const matched = await assertRuntimeCodeMatchesLocalBuild(
        publicClient,
        poolA.address,
        candidates,
      );
      assert.equal(matched.source, POOL_ARTIFACT_FILE);
      assert.match(matched.profile, /^(default \(optimizer disabled\)|production \(optimizer enabled)/);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /Pool runtime code matches the local build/);
      assert.match(lines[0], new RegExp(`solidity profile ${matched.profile.split(" ")[0]}`));
      assert.match(lines[0], /immutable bytes masked, masked code hash 0x[0-9a-f]{64}/);
    } finally {
      console.log = originalLog;
    }
  });

  it("is fatal when a single non-immutable byte of the deployed code differs", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);
    const artifact = localArtifact();
    const masked = immutableOffsets(artifact);
    const bytes = toBytes(artifact.deployedBytecode);

    // Every byte the comparison is not allowed to ignore, sampled across the code: the
    // dispatcher at the front, something in the middle, and the metadata hash at the end.
    const tamperOffsets = [0, Math.floor(bytes.length / 2), bytes.length - 1].map((offset) => {
      let candidate = offset;
      while (masked.has(candidate)) candidate += 1;
      return candidate;
    });

    for (const offset of tamperOffsets) {
      assert.ok(!masked.has(offset));
      const tampered = Buffer.from(bytes);
      tampered[offset] ^= 0x01;
      const tamperedArtifact = { ...artifact, deployedBytecode: toHex(tampered) };

      await assert.rejects(
        assertRuntimeCodeMatchesLocalBuild(
          publicClient,
          poolA.address,
          candidateOf(tamperedArtifact),
        ),
        (error: Error) => {
          assert.match(error.message, /does not run the code this checkout builds/);
          assert.match(error.message, /masked code hash 0x[0-9a-f]{64} != chain 0x[0-9a-f]{64}/);
          assert.match(error.message, /Do not send capital to this address/);
          return true;
        },
      );
    }
  });

  it("ignores a byte difference inside an immutable range, and only there", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);
    const artifact = localArtifact();
    const masked = [...immutableOffsets(artifact)];
    assert.ok(masked.length > 0);

    const bytes = toBytes(artifact.deployedBytecode);
    for (const offset of [masked[0], masked[masked.length - 1]]) {
      const altered = Buffer.from(bytes);
      altered[offset] ^= 0xff;
      await silentlyAsync(() =>
        assertRuntimeCodeMatchesLocalBuild(publicClient, poolA.address, [
          { source: POOL_ARTIFACT_FILE, profile: "test", artifact: { ...artifact, deployedBytecode: toHex(altered) } },
        ]),
      );
    }
  });

  it("is fatal when the deployed code is a different length", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);
    const artifact = localArtifact();
    const truncated = {
      ...artifact,
      deployedBytecode: toHex(toBytes(artifact.deployedBytecode).subarray(0, 100)),
      immutableReferences: {},
    };

    await assert.rejects(
      assertRuntimeCodeMatchesLocalBuild(publicClient, poolA.address, candidateOf(truncated)),
      /100 bytes of runtime code, chain has \d+/,
    );
  });

  it("is fatal when the pool address holds no code at all", async function () {
    const artifact = localArtifact();

    for (const code of ["0x" as Hex, undefined]) {
      await assert.rejects(
        assertRuntimeCodeMatchesLocalBuild(
          codeReader(code),
          "0x1111111111111111111111111111111111111111",
          candidateOf(artifact),
        ),
        /pool has no code at 0x1111111111111111111111111111111111111111/,
      );
    }
  });

  it("is fatal, with a build instruction, when no local artifact exists", function () {
    assert.throws(
      () =>
        readLocalBuildArtifacts(
          VERIFIED_POOL,
          path.join("artifacts", "nowhere", "ValidatorFundingPool.json"),
        ),
      (error: Error) => {
        assert.match(error.message, /no local build artifact for ValidatorFundingPool was found/);
        assert.match(error.message, /run "npm run build" and re-run this command/);
        return true;
      },
    );
  });

  it("reads only the hardhat build output; no environment variable adds a candidate", function () {
    const original = process.env.POOL_ARTIFACT_FILES;
    process.env.POOL_ARTIFACT_FILES = path.join("artifacts", "saved-production.json");

    try {
      // The variable is gone. A named file — existing or not — changes nothing, and the
      // one candidate is still the build output in this checkout.
      const candidates = readLocalBuildArtifacts();
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].source, POOL_ARTIFACT_FILE);

      assert.throws(
        () => readLocalBuildArtifacts(VERIFIED_POOL, path.join("artifacts", "nowhere", "Pool.json")),
        /no local build artifact for ValidatorFundingPool was found/,
      );
    } finally {
      if (original === undefined) delete process.env.POOL_ARTIFACT_FILES;
      else process.env.POOL_ARTIFACT_FILES = original;
    }
  });

  it("rejects an immutable range that falls outside the code", function () {
    const code = `0x${"ab".repeat(10)}` as Hex;

    assert.throws(
      () => maskImmutableRanges(code, { "42": [{ start: 8, length: 4 }] }, "sample"),
      /sample: immutable reference 42 declares the byte range \[8, 12\) which is outside the 10-byte code/,
    );
    assert.throws(
      () => maskImmutableRanges(code, { "7": [{ start: -1, length: 2 }] }, "sample"),
      /immutable reference 7 declares the byte range/,
    );
    assert.throws(
      () => maskImmutableRanges("0xabc" as Hex, {}, "sample"),
      /sample is not a whole number of hex-encoded bytes/,
    );
    assert.equal(
      maskImmutableRanges(code, { "1": [{ start: 2, length: 2 }] }, "sample").maskedBytes,
      2,
    );
  });

  it("rejects overlapping immutable ranges", function () {
    const code = `0x${"ab".repeat(64)}` as Hex;

    const overlapping: Record<string, readonly { start: number; length: number }[]>[] = [
      { "1": [{ start: 0, length: 32 }], "2": [{ start: 31, length: 4 }] },
      { "1": [{ start: 10, length: 8 }, { start: 12, length: 2 }] },
      // Identical ranges declared twice are the degenerate overlap.
      { "1": [{ start: 4, length: 4 }], "2": [{ start: 4, length: 4 }] },
    ];
    for (const references of overlapping) {
      assert.throws(
        () => maskImmutableRanges(code, references, "sample"),
        (error: Error) => {
          assert.match(error.message, /sample: immutable references .* overlap/);
          assert.match(error.message, /implausible/);
          return true;
        },
      );
    }

    // Adjacent, non-overlapping ranges are the normal case and stay accepted.
    assert.equal(
      maskImmutableRanges(code, { "1": [{ start: 0, length: 32 }], "2": [{ start: 32, length: 32 }] }, "sample")
        .maskedBytes,
      64,
    );
  });

  it("rejects an artifact whose immutable ranges exceed the masking budget", function () {
    const code = `0x${"ab".repeat(4_000)}` as Hex;

    // The whole-code mask: the candidate declares every byte immutable, which would zero
    // both sides and match any contract at all. It used to be accepted.
    assert.throws(
      () => maskImmutableRanges(code, { "1": [{ start: 0, length: 4_000 }] }, "sample"),
      (error: Error) => {
        assert.match(error.message, /the immutable ranges cover 4000 of the 4000 bytes of code/);
        assert.match(error.message, /above the 2048-byte ceiling/);
        assert.match(error.message, /implausible/);
        return true;
      },
    );

    // The budget is a total, not a per-range bound: many small disjoint ranges add up.
    const many = Array.from({ length: 65 }, (_unused, index) => ({ start: index * 32, length: 32 }));
    assert.throws(
      () => maskImmutableRanges(code, { "1": many }, "sample"),
      /cover 2080 of the 4000 bytes of code, above the 2048-byte ceiling/,
    );
    assert.equal(
      maskImmutableRanges(code, { "1": many.slice(0, 64) }, "sample").maskedBytes,
      2_048,
    );
  });

  it("leaves the real artifact's immutable layout comfortably inside both bounds", function () {
    const artifact = localArtifact();
    const { maskedBytes } = maskImmutableRanges(
      artifact.deployedBytecode,
      artifact.immutableReferences ?? {},
      "local artifact",
    );

    // The budget is sized against this number, so record it: solc emits one 32-byte range
    // per reference site, not one per immutable, and the five immutables are read at 19
    // sites under both build profiles.
    assert.equal(maskedBytes, 608);
    assert.equal(maskedBytes % 32, 0);
  });

  it("refuses a candidate that masks the whole runtime instead of matching it", async function () {
    const { poolA } = await networkHelpers.loadFixture(twoPoolsFixture);
    const chainCode = (await publicClient.getCode({ address: poolA.address })) as Hex;
    const length = toBytes(chainCode).length;

    // The authenticity hole this test exists for: a candidate artifact controls BOTH the
    // bytecode it is compared against and the ranges the comparison is allowed to ignore.
    // Declaring the entire runtime immutable masks the chain's code to zeroes too, so
    // completely unrelated bytecode "matches". It must be fatal, not a pass.
    const impostor = {
      deployedBytecode: toHex(Buffer.alloc(length, 0x5b)),
      immutableReferences: { "1": [{ start: 0, length }] },
    };

    await assert.rejects(
      assertRuntimeCodeMatchesLocalBuild(publicClient, poolA.address, candidateOf(impostor)),
      (error: Error) => {
        assert.match(error.message, /above the 2048-byte ceiling/);
        return true;
      },
    );
  });

  it("runs the runtime-code check as part of assertDeploymentIntegrity", async function () {
    const { poolA, depositA, withdrawalA, first } = await networkHelpers.loadFixture(twoPoolsFixture);
    const depositCode = (await publicClient.getCode({ address: depositA.address })) as Hex;
    const withdrawalCode = (await publicClient.getCode({ address: withdrawalA.address })) as Hex;
    const deployment = {
      chainId: await publicClient.getChainId(),
      pool: poolA.address,
      depositContract: depositA.address,
      depositContractCodeHash: keccak256(depositCode),
      withdrawalRequestPredeploy: withdrawalA.address,
      withdrawalRequestPredeployCodeHash: keccak256(withdrawalCode),
      operator: first.account.address,
      fundingWindowDuration: "3600",
      withdrawalCredentials: await poolA.read.withdrawalCredentials(),
    };

    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.warn = () => {};
    try {
      await assertDeploymentIntegrity(publicClient, poolA, deployment);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(lines.filter((line) => line.includes("Pool runtime code matches")).length, 1);

    // An address with no code fails before any of it: the pool used to be the one address
    // in the record that was never checked for code.
    await assert.rejects(
      assertDeploymentIntegrity(publicClient, poolA, {
        ...deployment,
        pool: "0x1111111111111111111111111111111111111111",
      }),
      /pool has no code at 0x1111111111111111111111111111111111111111/,
    );
  });

  // -------------------------------------------------------------------------
  // The fee-recipient forwarder, held to the same standard
  //
  // Its `pool()` binding proves only what the deployed code chooses to report. The forwarder
  // is what a validator client pays every proposal's execution-layer rewards to, so the same
  // runtime-code comparison the pool gets is applied to it.
  // -------------------------------------------------------------------------

  const FORWARDER_ARTIFACT_FILE = path.join(
    "artifacts",
    "contracts",
    "FeeRecipientForwarder.sol",
    "FeeRecipientForwarder.json",
  );

  function forwarderArtifact(): BuildArtifact {
    return JSON.parse(readFileSync(FORWARDER_ARTIFACT_FILE, "utf8")) as BuildArtifact;
  }

  function forwarderCandidateOf(artifact: BuildArtifact): BuildCandidate[] {
    return [{ source: FORWARDER_ARTIFACT_FILE, profile: "test", artifact }];
  }

  async function forwarderFixture() {
    const [first] = await viem.getWalletClients();
    const deposit = await viem.deployContract("MockDepositContract");
    const withdrawal = await viem.deployContract("MockWithdrawalRequestPredeploy", [EXIT_FEE]);
    const pool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      first.account.address,
      3_600n,
    ]);
    const otherPool = await viem.deployContract("ValidatorFundingPool", [
      deposit.address,
      withdrawal.address,
      first.account.address,
      7_200n,
    ]);
    const forwarder = await viem.deployContract("FeeRecipientForwarder", [pool.address]);
    const otherForwarder = await viem.deployContract("FeeRecipientForwarder", [otherPool.address]);
    return { pool, otherPool, forwarder, otherForwarder, deposit, withdrawal, first };
  }

  it("authenticates a deployed forwarder against the local FeeRecipientForwarder build", async function () {
    const { pool, forwarder } = await networkHelpers.loadFixture(forwarderFixture);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    try {
      await assertForwarderAuthenticity(publicClient, forwarder.address, pool.address);
    } finally {
      console.log = originalLog;
    }

    assert.equal(
      lines.filter((line) =>
        line.startsWith(`FeeRecipientForwarder runtime code matches the local build ${FORWARDER_ARTIFACT_FILE}`),
      ).length,
      1,
      `no forwarder code-match line in ${JSON.stringify(lines)}`,
    );
  });

  it("is fatal when the forwarder's code is not the contract this checkout builds", async function () {
    const { pool, forwarder } = await networkHelpers.loadFixture(forwarderFixture);
    const artifact = forwarderArtifact();
    const masked = immutableOffsets(artifact);
    const bytes = toBytes(artifact.deployedBytecode);

    // A byte the comparison is not allowed to ignore. The forwarder is small, so this is the
    // whole difference between the audited sidecar and something that answers `pool()`
    // correctly and sends the balance elsewhere.
    let offset = 0;
    while (masked.has(offset)) offset += 1;
    const tampered = Buffer.from(bytes);
    tampered[offset] ^= 0x01;

    await assert.rejects(
      assertRuntimeCodeMatchesLocalBuild(
        publicClient,
        forwarder.address,
        forwarderCandidateOf({ ...artifact, deployedBytecode: toHex(tampered) }),
        VERIFIED_FORWARDER,
      ),
      (error: Error) => {
        assert.match(
          error.message,
          new RegExp(`the feeRecipientForwarder at ${forwarder.address} does not run the code this checkout builds`),
        );
        assert.match(error.message, /masked code hash 0x[0-9a-f]{64} != chain 0x[0-9a-f]{64}/);
        assert.match(error.message, /Do not send capital to this address/);
        return true;
      },
    );

    // The pool's own artifact is a different contract entirely, and is rejected on length
    // before a single byte is compared.
    await assert.rejects(
      assertRuntimeCodeMatchesLocalBuild(
        publicClient,
        forwarder.address,
        candidateOf(localArtifact()),
        VERIFIED_FORWARDER,
      ),
      /bytes of runtime code, chain has \d+/,
    );

    // And a forwarder bound to some other pool fails the binding check that precedes it.
    await assert.rejects(
      assertForwarderAuthenticity(publicClient, forwarder.address, "0x1111111111111111111111111111111111111111"),
      /FeeRecipientForwarder pool .* does not match deployment pool 0x1111111111111111111111111111111111111111/,
    );
    await assert.rejects(
      assertForwarderAuthenticity(publicClient, "0x2222222222222222222222222222222222222222", pool.address),
      /feeRecipientForwarder has no code at 0x2222222222222222222222222222222222222222/,
    );
  });

  it("leaves the forwarder's immutable layout comfortably inside both bounds", function () {
    const artifact = forwarderArtifact();
    const { maskedBytes } = maskImmutableRanges(
      artifact.deployedBytecode,
      artifact.immutableReferences ?? {},
      "local forwarder artifact",
    );

    // One immutable, `pool`, read at two sites. The number the masking budget's failure
    // message quotes, so it is recorded here the way the pool's 608 is.
    assert.equal(maskedBytes, VERIFIED_FORWARDER.observedImmutableBytes);
    assert.equal(maskedBytes, 64);
  });

  it("authenticates the forwarder as part of assertDeploymentIntegrity, when the record names one", async function () {
    const { pool, forwarder, otherForwarder, deposit, withdrawal, first } =
      await networkHelpers.loadFixture(forwarderFixture);
    const depositCode = (await publicClient.getCode({ address: deposit.address })) as Hex;
    const withdrawalCode = (await publicClient.getCode({ address: withdrawal.address })) as Hex;
    const deployment = {
      chainId: await publicClient.getChainId(),
      pool: pool.address,
      depositContract: deposit.address,
      depositContractCodeHash: keccak256(depositCode),
      withdrawalRequestPredeploy: withdrawal.address,
      withdrawalRequestPredeployCodeHash: keccak256(withdrawalCode),
      operator: first.account.address,
      fundingWindowDuration: "3600",
      withdrawalCredentials: await pool.read.withdrawalCredentials(),
      feeRecipientForwarder: forwarder.address,
    };

    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.warn = () => {};
    try {
      await assertDeploymentIntegrity(publicClient, pool, deployment);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(lines.filter((line) => line.includes("Pool runtime code matches")).length, 1);
    assert.equal(
      lines.filter((line) => line.includes("FeeRecipientForwarder runtime code matches")).length,
      1,
    );

    // A record naming a forwarder that points at a different pool is fatal for every command
    // that reads it, not only for the two that hold a forwarder instance.
    await silentlyAsync(async () =>
      assert.rejects(
        assertDeploymentIntegrity(publicClient, pool, {
          ...deployment,
          feeRecipientForwarder: otherForwarder.address,
        }),
        /FeeRecipientForwarder pool .* does not match deployment pool/,
      ),
    );

    // And the declaration that catches a record naming a forwarder the operator did not mean.
    const original = process.env.EXPECTED_FORWARDER;
    try {
      process.env.EXPECTED_FORWARDER = otherForwarder.address;
      await silentlyAsync(async () =>
        assert.rejects(
          assertDeploymentIntegrity(publicClient, pool, deployment),
          new RegExp(`names fee-recipient forwarder ${forwarder.address}, not the declared EXPECTED_FORWARDER`),
        ),
      );

      // The case the pin could not see: a record with no forwarder at all. The comparison
      // has nothing to run against, so before this it reported a clean pass with
      // EXPECTED_FORWARDER set and unevaluated.
      const { feeRecipientForwarder: _dropped, ...withoutForwarder } = deployment;
      await silentlyAsync(async () =>
        assert.rejects(
          assertDeploymentIntegrity(publicClient, pool, withoutForwarder),
          new RegExp(
            `EXPECTED_FORWARDER ${otherForwarder.address} is declared, but the deployment ` +
              `record .* names no fee-recipient forwarder at all`,
          ),
        ),
      );

      // Unset, the same record passes: the pin is a declaration, not a requirement to have
      // deployed the optional sidecar.
      delete process.env.EXPECTED_FORWARDER;
      await silentlyAsync(async () =>
        assertDeploymentIntegrity(publicClient, pool, withoutForwarder),
      );
    } finally {
      if (original === undefined) delete process.env.EXPECTED_FORWARDER;
      else process.env.EXPECTED_FORWARDER = original;
    }
  });
});
