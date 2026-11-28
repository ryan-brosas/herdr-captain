import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { acquireLease, LeaseError, type OwnerLease } from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  makeFakeFlockScript,
  runBunSubprocess,
  setupLeaseSuiteHooks,
  waitUntilCondition,
} from "./helpers/lease-fixtures.ts";
import {
  acquireSkippingRegistryCleanup,
  assertControlFailed,
  createBrokenLivenessAdapter,
  createBrokenRevokedAfterDrainAdapter,
  MISSING_ZOMBIE_REJECTION_CAUSE,
  verifyControlledRevocationDrain,
  verifyReloadHandoffStep,
  verifyUnreapedZombiePreEffect,
} from "./helpers/lease-verifiers.ts";
import {
  confirmProcessDead,
  findProcessesByEnvToken,
  HARNESS_RUNNER_PATH,
  isLockFreeNonBlocking,
  OWNER_WORKER_PATH,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

let scratchRoot = "";
const suiteTracker = setupLeaseSuiteHooks((dir) => {
  scratchRoot = dir;
});

describe("Ported P2 negative controls (broken adapters and injected failures, zero source rewrites)", () => {
  test("P2 ctrl-1: broken adapter setting revoked after drain fails revocation verifier for the intended cause", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl1");
    const projectKey = "f101010101010101";
    const realLease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(realLease.holderPid, realLease.holderStartTime, "ctrl1-holder");
    const brokenLease = createBrokenRevokedAfterDrainAdapter(realLease);

    try {
      await assertControlFailed(
        () =>
          verifyControlledRevocationDrain(brokenLease, {
            stateRoot,
            projectKey,
            tracker: suiteTracker,
          }),
        /revoked flag was not set synchronously before queue drain/,
        "ctrl-1 revoked set after drain",
      );
    } finally {
      await realLease.release();
      expect(suiteTracker.retireExternalIfDead(realLease.holderPid, realLease.holderStartTime)).toBe(
        true,
      );
    }
  });

  test("P2 ctrl-2: broken reload adapter skipping global registry cleanup fails with owner_conflict", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl2");
    const projectKey = "f202020202020202";
    const lease1 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "ctrl2-holder");

    try {
      const failure = await assertControlFailed(
        () =>
          verifyReloadHandoffStep({
            lease1,
            acquireNext: () => acquireSkippingRegistryCleanup(stateRoot, projectKey),
            stateRoot,
            projectKey,
            tracker: suiteTracker,
          }),
        /LeaseError: Owner lease already held/,
        "ctrl-2 skipped registry cleanup",
      );
      expect(failure.error).toBeInstanceOf(LeaseError);
      expect((failure.error as LeaseError).code).toBe("owner_conflict");
    } finally {
      await lease1.release();
      expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);
    }
  });

  test("P2 ctrl-4a: broken adapter omitting holder-liveness guard fails on both reaped dead PID and unreaped zombie", async () => {
    // 1. On an unreaped zombie: broken adapter fails to reject pre-effect.
    const stateRoot = path.join(scratchRoot, "ctrl4a-zombie");
    const realLease = await acquireLease({ projectKey: "f4a1010101010101", stateRoot });
    suiteTracker.trackExternal(realLease.holderPid, realLease.holderStartTime, "ctrl4a-holder");
    const brokenNoGuard = createBrokenLivenessAdapter(realLease, "none");

    try {
      await assertControlFailed(
        () => verifyUnreapedZombiePreEffect(brokenNoGuard, stateRoot),
        MISSING_ZOMBIE_REJECTION_CAUSE,
        "ctrl-4a removed holder-liveness guard on zombie",
      );
      expect(fs.existsSync(path.join(stateRoot, "forbidden-after-holder-kill.marker"))).toBe(true);
    } finally {
      await realLease.release();
      expect(suiteTracker.retireExternalIfDead(realLease.holderPid, realLease.holderStartTime)).toBe(
        true,
      );
    }

    // 2. Distinguishes ctrl-4a from ctrl-4b: even on a fully reaped/nonexistent PID, ctrl-4a still says alive.
    const stateRootReaped = path.join(scratchRoot, "ctrl4a-reaped");
    const realLease2 = await acquireLease({ projectKey: "f4a2020202020202", stateRoot: stateRootReaped });
    suiteTracker.trackExternal(realLease2.holderPid, realLease2.holderStartTime, "ctrl4a-holder-2");
    const brokenNoGuard2 = createBrokenLivenessAdapter(realLease2, "none");
    await realLease2.release();
    expect(suiteTracker.retireExternalIfDead(realLease2.holderPid, realLease2.holderStartTime)).toBe(
      true,
    );
    expect(brokenNoGuard2.isHolderAlive()).toBe(true);
  });

  test("P2 ctrl-4b: broken adapter using kill(pid, 0) rejects reaped PID (distinct from ctrl-4a) but fails on unreaped zombie", async () => {
    // 1. On an unreaped zombie: kill(pid, 0) succeeds on Linux zombies, so pre-effect check fails.
    const stateRoot = path.join(scratchRoot, "ctrl4b-zombie");
    const realLease = await acquireLease({ projectKey: "f4b1010101010101", stateRoot });
    suiteTracker.trackExternal(realLease.holderPid, realLease.holderStartTime, "ctrl4b-holder");
    const brokenKillZero = createBrokenLivenessAdapter(realLease, "kill-zero");

    try {
      await assertControlFailed(
        () => verifyUnreapedZombiePreEffect(brokenKillZero, stateRoot),
        MISSING_ZOMBIE_REJECTION_CAUSE,
        "ctrl-4b kill(pid, 0) liveness on zombie",
      );
      expect(fs.existsSync(path.join(stateRoot, "forbidden-after-holder-kill.marker"))).toBe(true);
    } finally {
      await realLease.release();
      expect(suiteTracker.retireExternalIfDead(realLease.holderPid, realLease.holderStartTime)).toBe(
        true,
      );
    }

    // 2. Distinguishes ctrl-4b from ctrl-4a: once reaped, kill(pid, 0) gets ESRCH and returns false.
    expect(brokenKillZero.isHolderAlive()).toBe(false);
  });

  test("P2 ctrl-5a (Part 1): worker post-spawn failure stops detached child and releases lease before PID-file publication", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl5a-worker-state");
    const childPidFile = path.join(scratchRoot, "ctrl5a-child.json");
    const observedFile = path.join(scratchRoot, "ctrl5a-observed.json");

    const res = await runBunSubprocess(suiteTracker, scratchRoot, OWNER_WORKER_PATH, [
      "--mode",
      "hold-with-child",
      "--state-root",
      stateRoot,
      "--project-key",
      "0505050505050501",
      "--child-pid-file",
      childPidFile,
      "--fault",
      "fail-after-child-spawn",
      "--observed-file",
      observedFile,
    ]);

    expect(res.timedOut).toBe(false);
    expect(res.stoppedByController).toEqual([]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/forced_readProcessStat_failure_after_spawn/);
    expect(res.stdout.trim()).toBe("");
    expect(fs.existsSync(childPidFile)).toBe(false);
    expect(fs.existsSync(observedFile)).toBe(true);

    const observed = JSON.parse(fs.readFileSync(observedFile, "utf8")) as {
      pid: number;
      startTime: string;
    };
    expect(confirmProcessDead(observed.pid, observed.startTime)).toBe(true);
    expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
  });

  test("P2 ctrl-5b: runner timeout before PID-file publication stops unpublished detached child via env token", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl5b-state");
    const childPidFile = path.join(scratchRoot, "ctrl5b-child.json");
    const observedFile = path.join(scratchRoot, "ctrl5b-observed.json");
    const childToken = `herdr-s1a-ctrl5b-${crypto.randomUUID()}`;
    suiteTracker.registerEnvToken("HERDR_S1A_CHILD_TOKEN", childToken);

    const worker = suiteTracker.spawnWorker(
      [
        "--mode",
        "hold-with-child",
        "--state-root",
        stateRoot,
        "--project-key",
        "0505050505050509",
        "--child-pid-file",
        childPidFile,
        "--fault",
        "hang-before-publish",
        "--observed-file",
        observedFile,
      ],
      { HERDR_S1A_CHILD_TOKEN: childToken },
    );

    // Wait until detached child has actually exec'd and written observedFile (without PID file).
    await waitUntilCondition(
      () => fs.existsSync(observedFile) && fs.readFileSync(observedFile, "utf8").endsWith("\n"),
      5000,
      "ctrl-5b observed child startup",
    );

    await assertControlFailed(
      () => worker.nextEvent(150),
      /Timed out waiting for worker event/,
      "ctrl-5b worker event timeout before PID publication",
    );

    await worker.ensureStopped();
    const swept = await suiteTracker.stopAndRetireEnvToken("HERDR_S1A_CHILD_TOKEN", childToken);

    const observed = JSON.parse(fs.readFileSync(observedFile, "utf8")) as {
      pid: number;
      startTime: string;
      childPidFileExists: boolean;
    };
    expect(observed.childPidFileExists).toBe(false);
    expect(swept.some((p) => p.pid === observed.pid && p.startTime === observed.startTime)).toBe(
      true,
    );
    expect(confirmProcessDead(observed.pid, observed.startTime)).toBe(true);
  });

  test("P2 ctrl-6: failing flock prerequisite leaves zero leftover scratch folders", async () => {
    const isolatedTmp = path.join(scratchRoot, "ctrl6-tmp");
    const fakeBin = path.join(scratchRoot, "ctrl6-bin");
    const seenFile = path.join(scratchRoot, "ctrl6-seen.txt");
    fs.mkdirSync(isolatedTmp, { recursive: true });
    makeFakeFlockScript(
      fakeBin,
      `ls -1 "$TMPDIR" > ${JSON.stringify(seenFile)}\necho "simulated flock prerequisite failure" >&2\nexit 127`,
    );

    const res = await runBunSubprocess(
      suiteTracker,
      scratchRoot,
      HARNESS_RUNNER_PATH,
      ["--scenario", "prereq-check"],
      {
        extraEnv: {
          TMPDIR: isolatedTmp,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/simulated flock prerequisite failure/);

    const seenDuring = fs
      .readFileSync(seenFile, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(seenDuring.some((name) => name.startsWith("herdr-captain-harness-"))).toBe(true);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);
  });

  test("P2 ctrl-7: forced controller timeout stops owner, holder, and detached child and removes scratch folder", async () => {
    const observedFile = path.join(scratchRoot, "ctrl7-observed.json");

    const res = await runBunSubprocess(
      suiteTracker,
      scratchRoot,
      HARNESS_RUNNER_PATH,
      ["--scenario", "hang-with-child", "--observed-file", observedFile],
      {
        timeoutMs: 5000,
        killWhenFileExists: observedFile,
      },
    );

    expect(res.timedOut).toBe(true);
    expect(fs.existsSync(observedFile)).toBe(true);

    const observed = JSON.parse(fs.readFileSync(observedFile, "utf8")) as {
      ownerPid: number;
      ownerStartTime: string;
      holderPid: number;
      holderStartTime: string;
      childPid: number;
      childStartTime: string;
      runScratchDir: string;
    };

    expect(
      res.stoppedByController.some(
        (p) => p.pid === observed.childPid && p.startTime === observed.childStartTime,
      ),
    ).toBe(true);
    expect(confirmProcessDead(observed.ownerPid, observed.ownerStartTime)).toBe(true);
    expect(confirmProcessDead(observed.holderPid, observed.holderStartTime)).toBe(true);
    expect(confirmProcessDead(observed.childPid, observed.childStartTime)).toBe(true);
    expect(findProcessesByEnvToken("HERDR_S1A_CTRL_TOKEN", res.ctrlToken)).toEqual([]);
    expect(fs.existsSync(observed.runScratchDir)).toBe(false);
    assert.ok(res.runTmpDir !== null);
    expect(fs.existsSync(res.runTmpDir)).toBe(false);
  });

  test("P2 ctrl-8: negative-control collector rejects unrelated fixture errors", async () => {
    const unrelatedCases = [
      {
        label: "check-3",
        expected: /LeaseError: Owner lease already held/,
      },
      {
        label: "check-4-revoke",
        expected: /revoked flag was not set synchronously before queue drain/,
      },
      {
        label: "check-4-liveness",
        expected: MISSING_ZOMBIE_REJECTION_CAUSE,
      },
    ];

    for (const item of unrelatedCases) {
      await assert.rejects(
        () =>
          assertControlFailed(
            async () => {
              throw new Error(`unrelated_fixture_error_${item.label}`);
            },
            item.expected,
            item.label,
          ),
        /did not match expected cause/,
      );
    }

    // Also verify assertControlFailed fails when a negative control unexpectedly passes.
    await assert.rejects(
      () => assertControlFailed(async () => "unexpected-ok", /expected/, "unexpected-pass"),
      /Negative control unexpectedly passed/,
    );

    // Go through verifyUnreapedZombiePreEffect itself with an unrelated rejection:
    // the verifier must rethrow the rejection as itself, and the collector must reject it.
    const stateRoot = path.join(scratchRoot, "ctrl8-verifier-unrelated");
    const realLease = await acquireLease({ projectKey: "f801010101010101", stateRoot });
    suiteTracker.trackExternal(realLease.holderPid, realLease.holderStartTime, "ctrl8-holder");
    try {
      const unrelatedErr = new Error("unrelated_fixture_error_from_enqueue");
      const brokenUnrelated: OwnerLease = {
        ...realLease,
        enqueue: async () => {
          throw unrelatedErr;
        },
      };

      await assert.rejects(
        () =>
          assertControlFailed(
            () => verifyUnreapedZombiePreEffect(brokenUnrelated, stateRoot),
            MISSING_ZOMBIE_REJECTION_CAUSE,
            "ctrl-8 verifier unrelated rejection",
          ),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("did not match expected cause") &&
          err.message.includes("unrelated_fixture_error_from_enqueue"),
      );

      await assert.rejects(
        () => verifyUnreapedZombiePreEffect(brokenUnrelated, stateRoot),
        (err: unknown) => err === unrelatedErr,
      );

      // A LeaseError with the wrong message must also reach the caller as itself and fail the collector.
      const wrongReasonLeaseErr = new LeaseError("lease_revoked", "Owner lease has been revoked");
      const brokenWrongLeaseErr: OwnerLease = {
        ...realLease,
        enqueue: async () => {
          throw wrongReasonLeaseErr;
        },
      };

      await assert.rejects(
        () =>
          assertControlFailed(
            () => verifyUnreapedZombiePreEffect(brokenWrongLeaseErr, stateRoot),
            MISSING_ZOMBIE_REJECTION_CAUSE,
            "ctrl-8 verifier wrong LeaseError message",
          ),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("did not match expected cause") &&
          err.message.includes("Owner lease has been revoked"),
      );

      await assert.rejects(
        () => verifyUnreapedZombiePreEffect(brokenWrongLeaseErr, stateRoot),
        (err: unknown) => err === wrongReasonLeaseErr,
      );

      // A no-op enqueue that resolves without running write/effect must not match the zombie-control cause.
      const brokenNoOp: OwnerLease = {
        ...realLease,
        enqueue: async <TWrite = unknown, TEffect = unknown>() => ({
          writeResult: undefined as TWrite,
          effectResult: undefined as TEffect,
        }),
      };

      await assert.rejects(
        () =>
          assertControlFailed(
            () => verifyUnreapedZombiePreEffect(brokenNoOp, stateRoot),
            MISSING_ZOMBIE_REJECTION_CAUSE,
            "ctrl-8 verifier no-op enqueue",
          ),
        /did not match expected cause/,
      );
    } finally {
      await realLease.release();
      expect(suiteTracker.retireExternalIfDead(realLease.holderPid, realLease.holderStartTime)).toBe(
        true,
      );
    }
  });

  test("P2 ctrl-9: uncaught harness error prints original error, stops live processes, removes scratch, and exits non-zero", async () => {
    const isolatedTmp = path.join(scratchRoot, "ctrl9-tmp");
    const observedFile = path.join(scratchRoot, "ctrl9-observed.json");
    fs.mkdirSync(isolatedTmp, { recursive: true });

    const res = await runBunSubprocess(
      suiteTracker,
      scratchRoot,
      HARNESS_RUNNER_PATH,
      ["--scenario", "uncaught-after-acquire", "--observed-file", observedFile],
      {
        extraEnv: { TMPDIR: isolatedTmp },
      },
    );

    expect(res.timedOut).toBe(false);
    expect(res.stoppedByController).toEqual([]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/forced_uncaught_runner_error_outside_await/);
    expect(fs.existsSync(observedFile)).toBe(true);

    const observed = JSON.parse(fs.readFileSync(observedFile, "utf8")) as {
      ownerPid: number;
      ownerStartTime: string;
      holderPid: number;
      holderStartTime: string;
      runScratchDir: string;
    };
    expect(confirmProcessDead(observed.ownerPid, observed.ownerStartTime)).toBe(true);
    expect(confirmProcessDead(observed.holderPid, observed.holderStartTime)).toBe(true);
    expect(fs.existsSync(observed.runScratchDir)).toBe(false);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);
  });
});
