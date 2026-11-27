#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONFLICT_EXIT_CODE,
  findProcessesByEnvToken,
  formatError,
  isSameProcessAlive,
  stopProcessesByEnvToken,
  stopProcessesByEnvTokenSync,
} from "./lease.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPY_FILES = ["lease.mjs", "owner-worker.mjs", "run.mjs"];

const activeControllerChildren = new Set();
const activeControllerTokens = new Set();
const activeRunTmpDirs = new Set();
let activeScratchRoot = null;
let fatalErrorOccurred = false;
let fatalShutdownPromise = null;

function removeActiveScratchRoot() {
  if (activeScratchRoot !== null) {
    const target = activeScratchRoot;
    fs.rmSync(target, { recursive: true, force: true });
    activeScratchRoot = null;
  }
}

async function cleanupControllerResources() {
  const errors = [];

  for (const childEntry of [...activeControllerChildren]) {
    try {
      await childEntry.ensureStopped();
    } catch (err) {
      errors.push(err);
    }
  }

  for (const token of [...activeControllerTokens]) {
    try {
      await stopProcessesByEnvToken("HERDR_P2_CTRL_TOKEN", token, 3000);
      activeControllerTokens.delete(token);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const dir of [...activeRunTmpDirs]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      activeRunTmpDirs.delete(dir);
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Controller cleanup failed for ${errors.length} resource(s)`);
  }
}

function handleFatalError(label, err) {
  fatalErrorOccurred = true;
  console.error(`${label}: ${formatError(err)}`);
  if (fatalShutdownPromise !== null) {
    return fatalShutdownPromise;
  }
  fatalShutdownPromise = (async () => {
    try {
      await cleanupControllerResources();
    } catch (cleanupErr) {
      console.error(formatError(cleanupErr));
    }
    try {
      removeActiveScratchRoot();
    } catch (rmErr) {
      console.error(formatError(rmErr));
    }
    process.exit(1);
  })();
  return fatalShutdownPromise;
}

process.on("uncaughtException", (err) => {
  void handleFatalError("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  void handleFatalError("Unhandled rejection", reason);
});

process.on("exit", () => {
  for (const childEntry of [...activeControllerChildren]) {
    if (!childEntry.hasExited()) {
      try {
        childEntry.child.kill("SIGKILL");
      } catch {
        // Ignore ESRCH on exit fallback.
      }
    }
  }
  for (const token of [...activeControllerTokens]) {
    stopProcessesByEnvTokenSync("HERDR_P2_CTRL_TOKEN", token);
  }
  for (const dir of [...activeRunTmpDirs]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore exit fallback removal error.
    }
  }
  try {
    removeActiveScratchRoot();
  } catch {
    // Ignore exit fallback removal error.
  }
});

function copyProbeToScratch(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of COPY_FILES) {
    fs.copyFileSync(path.join(HERE, name), path.join(destDir, name));
  }
}

function mutateFile(filePath, target, replacement, label) {
  const original = fs.readFileSync(filePath, "utf8");
  if (!original.includes(target)) {
    throw new Error(`Mutation target not found for ${label} in ${path.basename(filePath)}`);
  }
  const mutated = original.replace(target, replacement);
  assert.notEqual(mutated, original, `Mutation produced no change for ${label}`);
  fs.writeFileSync(filePath, mutated, "utf8");
}

async function runBun(scratchRoot, scriptPath, args = [], options = {}) {
  const { extraEnv = undefined, timeoutMs = 20000 } = options;
  const ctrlToken = `herdr-p2-ctrl-${crypto.randomUUID()}`;
  activeControllerTokens.add(ctrlToken);

  const ownsTmpDir = !(extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, "TMPDIR"));
  const runTmpDir = ownsTmpDir ? fs.mkdtempSync(path.join(scratchRoot, "run-tmp-")) : null;
  if (runTmpDir !== null) {
    activeRunTmpDirs.add(runTmpDir);
  }

  let childEntry = null;
  let spawnError = null;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  let exitInfo = { code: null, signal: null };
  let stoppedByController = [];

  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(runTmpDir !== null ? { TMPDIR: runTmpDir } : {}),
        ...(extraEnv || {}),
        HERDR_P2_CTRL_TOKEN: ctrlToken,
      },
    });

    let exitedFlag = false;
    let resolveExited;
    const exitedPromise = new Promise((resolve) => {
      resolveExited = resolve;
    });

    const settle = (info) => {
      if (exitedFlag) {
        return;
      }
      exitedFlag = true;
      if (childEntry !== null) {
        activeControllerChildren.delete(childEntry);
      }
      resolveExited(info);
    };

    childEntry = {
      child,
      hasExited: () => exitedFlag,
      async ensureStopped() {
        if (!exitedFlag) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore ESRCH if exited concurrently.
          }
          await exitedPromise;
        }
      },
    };
    activeControllerChildren.add(childEntry);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      spawnError = err;
      settle({ code: null, signal: null, error: err });
    });
    child.once("exit", (code, signal) => {
      settle({ code, signal });
    });

    const timer = setTimeout(() => {
      if (exitedFlag) {
        return;
      }
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore ESRCH if exited right as timeout fired.
      }
    }, timeoutMs);

    try {
      exitInfo = await exitedPromise;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (childEntry !== null) {
      await childEntry.ensureStopped();
    }
    stoppedByController = await stopProcessesByEnvToken("HERDR_P2_CTRL_TOKEN", ctrlToken, 3000);
    activeControllerTokens.delete(ctrlToken);
    if (runTmpDir !== null) {
      fs.rmSync(runTmpDir, { recursive: true, force: true });
      activeRunTmpDirs.delete(runTmpDir);
    }
  }

  if (spawnError !== null) {
    throw spawnError;
  }

  return {
    status: exitInfo.code,
    signal: exitInfo.signal,
    timedOut,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    ctrlToken,
    runTmpDir,
    stoppedByController,
  };
}

function extractCheckFailureBlock(stderrText, expectedCheckId) {
  const lines = stderrText.split("\n");
  const header = `FAIL [${expectedCheckId}]`;
  const startIdx = lines.findIndex((line) => line.startsWith(header));
  if (startIdx === -1) {
    return null;
  }
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^(PASS|FAIL) \[/.test(lines[i]) || /^Summary:/.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block.join("\n");
}

function assertCheckFailed(result, expectedCheckId, expectedCausePattern, expectedStageLabel) {
  assert.equal(result.timedOut, false, `unexpected controller timeout while checking ${expectedCheckId}`);
  assert.notEqual(result.status, 0, `expected non-zero exit when ${expectedCheckId} is broken`);
  assert.match(
    result.combined,
    /Summary: 5 passed, 1 failed \(total 6\)/,
    `expected only ${expectedCheckId} to fail, got:\n${result.combined}`,
  );

  const block = extractCheckFailureBlock(result.stderr, expectedCheckId);
  assert.ok(block !== null, `expected FAIL [${expectedCheckId}] block in stderr, got:\n${result.stderr}`);
  assert.match(
    block,
    expectedCausePattern,
    `FAIL [${expectedCheckId}] did not match expected cause (${expectedStageLabel}); got:\n${block}`,
  );

  const matchedLine =
    block
      .split("\n")
      .map((line) => line.trim())
      .find((line) => expectedCausePattern.test(line)) || block.split("\n")[1]?.trim() || block.trim();
  return { matchedLine };
}

const EXPECTED_CAUSES = {
  ctrl1: {
    checkId: "check-4",
    pattern: /revoked flag was not set synchronously before queue drain/,
    stage: "check-4 synchronous revoked-before-drain assertion",
  },
  ctrl2: {
    checkId: "check-3",
    pattern: /LeaseError:\s*Owner lease already held for <scratch>\/check3\/owner\.lock/,
    stage: "check-3 reload owner_conflict from uncleaned prior holder",
  },
  ctrl3: {
    checkId: "check-6",
    pattern: /main-clone projectKey did not match sha256\(realpath\(git common dir\)\)/,
    stage: "check-6 projectKey mismatch against git common dir",
  },
  ctrl4a: {
    checkId: "check-4",
    pattern: /expected pre-effect check to reject dead unreaped holder with no longer alive/,
    stage: "check-4 pre-effect dead-holder rejection",
  },
  ctrl4b: {
    checkId: "check-4",
    pattern: /expected pre-effect check to reject dead unreaped holder with no longer alive/,
    stage: "check-4 pre-effect unreaped-zombie rejection",
  },
  ctrl5b: {
    checkId: "check-5",
    pattern: /Timed out waiting for worker event/,
    stage: "check-5 worker event timeout before PID publication",
  },
};

async function ctrl1RevokedAfterDrain(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-1");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "revoked = true;\n      if (revokePromise !== null)",
    "if (revokePromise !== null)",
    "ctrl-1 remove early revoked",
  );
  mutateFile(
    path.join(dir, "lease.mjs"),
    "} while (queueTail !== drainedTail);",
    "} while (queueTail !== drainedTail);\n        revoked = true;",
    "ctrl-1 set revoked after drain",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl1.checkId,
    EXPECTED_CAUSES.ctrl1.pattern,
    EXPECTED_CAUSES.ctrl1.stage,
  );
  return `exit=${res.status} | check-4 | matched cause: ${matchedLine}`;
}

async function ctrl2SkipRegistryCleanup(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-2");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "if (existing) {\n    await existing.revokeAndClose();\n  }",
    "if (false && existing) {\n    await existing.revokeAndClose();\n  }",
    "ctrl-2 skip registry cleanup",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl2.checkId,
    EXPECTED_CAUSES.ctrl2.pattern,
    EXPECTED_CAUSES.ctrl2.stage,
  );
  return `exit=${res.status} | check-3 | matched cause: ${matchedLine}`;
}

async function ctrl3HashWorkingFolder(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-3");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "const resolvedCommonDir = path.resolve(cwd, rawCommonDir);",
    "const resolvedCommonDir = path.resolve(cwd);",
    "ctrl-3 hash cwd",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl3.checkId,
    EXPECTED_CAUSES.ctrl3.pattern,
    EXPECTED_CAUSES.ctrl3.stage,
  );
  return `exit=${res.status} | check-6 | matched cause: ${matchedLine}`;
}

async function ctrl4aRemoveLivenessGuard(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-4a");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    'if (!isHolderAlive()) {\n        revoked = true;\n        throw new LeaseError("lease_revoked", "Owner lease holder is no longer alive");\n      }',
    "// liveness guard removed for S1 negative control",
    "ctrl-4a remove liveness guard",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl4a.checkId,
    EXPECTED_CAUSES.ctrl4a.pattern,
    EXPECTED_CAUSES.ctrl4a.stage,
  );
  return `exit=${res.status} | check-4 | matched cause: ${matchedLine}`;
}

async function ctrl4bWeakenLivenessToKillZero(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-4b");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "const isHolderAlive = () =>\n      !holder.isExited() &&\n      (holderStartTime !== null\n        ? isSameProcessAlive(holder.child.pid, holderStartTime)\n        : isProcessAliveNonZombie(holder.child.pid));",
    "const isHolderAlive = () => {\n      if (holder.isExited()) return false;\n      try { process.kill(holder.child.pid, 0); return true; } catch { return false; }\n    };",
    "ctrl-4b weaken liveness to kill(pid, 0)",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl4b.checkId,
    EXPECTED_CAUSES.ctrl4b.pattern,
    EXPECTED_CAUSES.ctrl4b.stage,
  );
  return `exit=${res.status} | check-4 | matched cause: ${matchedLine}`;
}

async function ctrl5aForcedPrePublishAndPostAcquireErrors(scratchRoot) {
  // Part 1 (owner-worker.mjs): force readProcessStat to throw right after raw-handle install,
  // BEFORE childPidFile is written and BEFORE child_spawned or acquired_with_child is emitted.
  const dirWorker = path.join(scratchRoot, "ctrl-5a-worker");
  const stateRootWorker = path.join(scratchRoot, "ctrl-5a-worker-state");
  const childPidFile = path.join(scratchRoot, "ctrl-5a-child.json");
  const workerObservedFile = path.join(scratchRoot, "ctrl-5a-worker-observed.json");
  copyProbeToScratch(dirWorker);

  mutateFile(
    path.join(dirWorker, "owner-worker.mjs"),
    "      handle.startTime = readProcessStat(child.pid)?.startTime ?? null;\n      onChildTracked(handle);",
    `      const observedStart = readProcessStat(child.pid)?.startTime ?? null;\n      fs.writeFileSync(${JSON.stringify(workerObservedFile)}, JSON.stringify({ pid: child.pid, startTime: observedStart }) + "\\n", "utf8");\n      throw new Error("forced_readProcessStat_failure_after_spawn");\n      handle.startTime = observedStart;\n      onChildTracked(handle);`,
    "ctrl-5a force readProcessStat error after spawn",
  );

  const workerRes = await runBun(scratchRoot, path.join(dirWorker, "owner-worker.mjs"), [
    "--mode",
    "hold-with-child",
    "--state-root",
    stateRootWorker,
    "--project-key",
    "0505050505050501",
    "--child-pid-file",
    childPidFile,
  ]);

  assert.equal(workerRes.timedOut, false);
  assert.deepEqual(
    workerRes.stoppedByController,
    [],
    `owner-worker leaked process(es) to controller sweep: ${JSON.stringify(workerRes.stoppedByController)}`,
  );
  assert.equal(workerRes.status, 1, `expected worker exit 1, got ${workerRes.status}`);
  assert.match(workerRes.stderr, /forced_readProcessStat_failure_after_spawn/);
  assert.equal(workerRes.stdout.trim(), "", "no child_spawned or acquired_with_child event should be emitted");
  assert.equal(fs.existsSync(childPidFile), false, "childPidFile must not exist when readProcessStat throws");
  assert.equal(fs.existsSync(workerObservedFile), true, "expected spawned child identity before forced throw");

  const workerObserved = JSON.parse(fs.readFileSync(workerObservedFile, "utf8"));
  assert.equal(Number.isInteger(workerObserved.pid) && workerObserved.pid > 0, true);
  assert.equal(typeof workerObserved.startTime === "string" && workerObserved.startTime.length > 0, true);
  assert.equal(
    isSameProcessAlive(workerObserved.pid, workerObserved.startTime),
    false,
    `detached child pid=${workerObserved.pid} survived forced readProcessStat failure`,
  );

  const workerLockFree = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    path.join(stateRootWorker, "owner.lock"),
    "true",
  ]);
  assert.equal(workerLockFree.status, 0, "owner.lock remained held after worker cleanup");

  // Part 2 (lease.mjs): force readProcessStat to throw right after spawnFlockHolder resolves;
  // verify acquireLease rejects and closes + awaits holder exit so owner.lock is free.
  const dirLease = path.join(scratchRoot, "ctrl-5a-lease");
  const stateRootLease = path.join(scratchRoot, "ctrl-5a-lease-state");
  const leaseObservedFile = path.join(scratchRoot, "ctrl-5a-lease-observed.json");
  copyProbeToScratch(dirLease);

  mutateFile(
    path.join(dirLease, "lease.mjs"),
    "    const holderStartTime = readProcessStat(holder.child.pid)?.startTime ?? null;",
    `    const observedHolderStart = readProcessStat(holder.child.pid)?.startTime ?? null;\n    fs.writeFileSync(${JSON.stringify(leaseObservedFile)}, JSON.stringify({ pid: holder.child.pid, startTime: observedHolderStart }) + "\\n", "utf8");\n    throw new Error("forced_post_acquire_readProcessStat_error");\n    const holderStartTime = observedHolderStart;`,
    "ctrl-5a force post-acquire readProcessStat error in lease.mjs",
  );

  const mutatedLeaseMod = await import(pathToFileURL(path.join(dirLease, "lease.mjs")).href);
  await assert.rejects(
    () => mutatedLeaseMod.acquireLease({ projectKey: "0505050505050502", stateRoot: stateRootLease }),
    /forced_post_acquire_readProcessStat_error/,
  );
  assert.equal(fs.existsSync(leaseObservedFile), true, "expected holder identity before forced post-acquire throw");
  const leaseObserved = JSON.parse(fs.readFileSync(leaseObservedFile, "utf8"));
  assert.equal(
    isSameProcessAlive(leaseObserved.pid, leaseObserved.startTime),
    false,
    `holder pid=${leaseObserved.pid} survived forced post-acquire readProcessStat failure`,
  );
  const leaseLockFree = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    path.join(stateRootLease, "owner.lock"),
    "true",
  ]);
  assert.equal(leaseLockFree.status, 0, "owner.lock remained held after acquireLease cleanup");

  return `worker readProcessStat throw (exit=${workerRes.status}, pidFile=false, child pid=${workerObserved.pid} stopped) + lease.mjs post-acquire throw (holder pid=${leaseObserved.pid} stopped, locks free)`;
}

async function ctrl5bTimeoutBeforePidPublication(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-5b");
  const observedFile = path.join(scratchRoot, "ctrl-5b-observed-child.json");
  copyProbeToScratch(dir);

  // Hang owner-worker AFTER spawning detached sleep 60, BEFORE writePidFileAtomic and BEFORE any stdout event.
  // This proves runner cleanup via HERDR_P2_CHILD_TOKEN stops the unpublished child even when childPidFile is absent.
  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    "        (handle) => {\n          if (childPidFile) {",
    `        (handle) => {\n          handle.child.stdout.resume();\n          handle.child.stdout.once("end", () => {\n            fs.writeFileSync(\n              ${JSON.stringify(observedFile)},\n              JSON.stringify({\n                pid: handle.pid,\n                startTime: handle.startTime,\n                childPidFileExists: childPidFile ? fs.existsSync(childPidFile) : false,\n              }) + "\\n",\n              "utf8",\n            );\n          });\n          return;\n          if (childPidFile) {`,
    "ctrl-5b skip PID file and child_spawned before hang",
  );
  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    '      emit({\n        event: "acquired_with_child",',
    '      await new Promise(() => {});\n      emit({\n        event: "acquired_with_child",',
    "ctrl-5b hang before acquired_with_child",
  );
  mutateFile(
    path.join(dir, "run.mjs"),
    '    const spawnedEvt = await owner1.nextEvent();\n    assert.equal(spawnedEvt.event, "child_spawned");',
    '    const spawnedEvt = await owner1.nextEvent(250);\n    assert.equal(spawnedEvt.event, "child_spawned");',
    "ctrl-5b shorten check5 nextEvent timeout",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  const { matchedLine } = assertCheckFailed(
    res,
    EXPECTED_CAUSES.ctrl5b.checkId,
    EXPECTED_CAUSES.ctrl5b.pattern,
    EXPECTED_CAUSES.ctrl5b.stage,
  );
  assert.equal(fs.existsSync(observedFile), true, "expected detached child to start before runner timeout");

  const observed = JSON.parse(fs.readFileSync(observedFile, "utf8"));
  assert.equal(observed.childPidFileExists, false, "childPidFile must NOT have been published before timeout");
  assert.equal(Number.isInteger(observed.pid) && observed.pid > 0, true);
  assert.equal(typeof observed.startTime === "string" && observed.startTime.length > 0, true);
  assert.equal(
    isSameProcessAlive(observed.pid, observed.startTime),
    false,
    `unpublished detached child pid=${observed.pid} survived runner timeout`,
  );

  return `exit=${res.status} | check-5 | pidFile=false | unpublished child(pid=${observed.pid}) stopped via HERDR_P2_CHILD_TOKEN | matched cause: ${matchedLine}`;
}

async function ctrl6PrerequisiteFailureRemovesScratch(scratchRoot) {
  const isolatedTmp = path.join(scratchRoot, "ctrl-6-tmp");
  const fakeBin = path.join(scratchRoot, "ctrl-6-bin");
  const seenFile = path.join(scratchRoot, "ctrl-6-seen.txt");
  fs.mkdirSync(isolatedTmp, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const fakeFlock = path.join(fakeBin, "flock");
  fs.writeFileSync(
    fakeFlock,
    `#!/bin/sh\nls -1 "$TMPDIR" > ${JSON.stringify(seenFile)}\necho "simulated flock prerequisite failure" >&2\nexit 127\n`,
    { mode: 0o755 },
  );

  const res = await runBun(scratchRoot, path.join(HERE, "run.mjs"), [], {
    extraEnv: {
      TMPDIR: isolatedTmp,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
    },
  });

  assert.equal(res.timedOut, false);
  assert.notEqual(res.status, 0, "expected run.mjs to exit non-zero on failing flock prerequisite");
  assert.match(res.combined, /simulated flock prerequisite failure|Command failed|flock/);

  const seenDuringPrereq = fs
    .readFileSync(seenFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(
    seenDuringPrereq.some((name) => name.startsWith("herdr-captain-p2-")),
    true,
    `expected scratch dir to exist during prerequisite command, saw: ${JSON.stringify(seenDuringPrereq)}`,
  );

  const leftover = fs.readdirSync(isolatedTmp);
  assert.deepEqual(leftover, [], `expected empty TMPDIR after prerequisite failure, found: ${JSON.stringify(leftover)}`);

  return `exit=${res.status} | observed ${seenDuringPrereq.length} scratch dir created before failure and 0 leftover after exit`;
}

async function ctrl7ForcedControllerTimeoutCleansTreeAndScratch(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-7");
  const observedFile = path.join(scratchRoot, "ctrl-7-observed.json");
  copyProbeToScratch(dir);

  // Run check-5 first with a long worker-event timeout so runBun's own controller timeout (1200ms)
  // deterministically kills run.mjs mid-check while owner1, holder1, detached sleep 60, and scratch dir exist.
  mutateFile(
    path.join(dir, "run.mjs"),
    '  const checks = [\n    { id: "check-1", name: "second owner fails with owner_conflict and leaves owner.json untouched", fn: check1OwnerConflict },',
    '  const checks = [\n    { id: "check-5", name: "post-acquisition child does not inherit pipe (O_CLOEXEC + SIGKILL release)", fn: check5NonInheritance },\n    { id: "check-1", name: "second owner fails with owner_conflict and leaves owner.json untouched", fn: check1OwnerConflict },',
    "ctrl-7 run check-5 first",
  );
  mutateFile(
    path.join(dir, "run.mjs"),
    '    const acquired1 = await owner1.nextEvent();\n    assert.equal(acquired1.event, "acquired_with_child");',
    '    const acquired1 = await owner1.nextEvent(30000);\n    assert.equal(acquired1.event, "acquired_with_child");',
    "ctrl-7 extend runner nextEvent timeout past controller timeout",
  );
  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    '      emit({\n        event: "acquired_with_child",',
    `      fs.writeFileSync(\n        ${JSON.stringify(observedFile)},\n        JSON.stringify({\n          ownerPid: process.pid,\n          ownerStartTime: readProcessStat(process.pid)?.startTime ?? null,\n          holderPid: lease.holderPid,\n          holderStartTime: lease.holderStartTime,\n          childPid: childHandle.pid,\n          childStartTime: childHandle.startTime,\n          runScratchDir: path.dirname(stateRoot),\n        }) + "\\n",\n        "utf8",\n      );\n      await new Promise(() => {});\n      emit({\n        event: "acquired_with_child",`,
    "ctrl-7 record live process tree and hang before acquired_with_child",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"), [], { timeoutMs: 1200 });
  assert.equal(res.timedOut, true, "expected controller timeout to fire and kill run.mjs");
  assert.equal(fs.existsSync(observedFile), true, "expected live process tree snapshot before controller timeout");

  const observed = JSON.parse(fs.readFileSync(observedFile, "utf8"));
  assert.equal(
    res.stoppedByController.some((p) => p.pid === observed.childPid && p.startTime === observed.childStartTime),
    true,
    `expected controller sweep to stop detached child pid=${observed.childPid}, stopped=${JSON.stringify(res.stoppedByController)}`,
  );
  assert.equal(isSameProcessAlive(observed.ownerPid, observed.ownerStartTime), false, "owner1 survived controller timeout");
  assert.equal(isSameProcessAlive(observed.holderPid, observed.holderStartTime), false, "holder1 survived controller timeout");
  assert.equal(
    isSameProcessAlive(observed.childPid, observed.childStartTime),
    false,
    `detached child pid=${observed.childPid} survived controller timeout`,
  );
  assert.equal(
    findProcessesByEnvToken("HERDR_P2_CTRL_TOKEN", res.ctrlToken).length,
    0,
    "remaining processes found for controller token after timeout cleanup",
  );
  assert.equal(fs.existsSync(observed.runScratchDir), false, "run.mjs scratch dir survived controller timeout");
  assert.equal(fs.existsSync(res.runTmpDir), false, "controller runTmpDir survived timeout cleanup");

  return `controller timeout (1200ms) bypassed run.mjs finally; owner(pid=${observed.ownerPid}), holder(pid=${observed.holderPid}), detached child(pid=${observed.childPid}) all terminated and scratch dir removed`;
}

async function ctrl8CollectorRejectsUnrelatedFixtureErrors(scratchRoot) {
  const cases = [
    {
      label: "check-3",
      target: "async function check3SimulatedReload(scratchRoot) {",
      replacement: 'async function check3SimulatedReload(scratchRoot) {\n  throw new Error("unrelated_fixture_error_check3");',
      rejectAgainst: [EXPECTED_CAUSES.ctrl2],
    },
    {
      label: "check-4",
      target: "async function check4WithdrawalQueuedWork(scratchRoot) {",
      replacement: 'async function check4WithdrawalQueuedWork(scratchRoot) {\n  throw new Error("unrelated_fixture_error_check4");',
      rejectAgainst: [EXPECTED_CAUSES.ctrl1, EXPECTED_CAUSES.ctrl4a],
    },
    {
      label: "check-6",
      target: "async function check6LinkedWorktrees(scratchRoot) {",
      replacement: 'async function check6LinkedWorktrees(scratchRoot) {\n  throw new Error("unrelated_fixture_error_check6");',
      rejectAgainst: [EXPECTED_CAUSES.ctrl3],
    },
  ];

  const rejectedLabels = [];
  for (const item of cases) {
    const dir = path.join(scratchRoot, `ctrl-8-${item.label}`);
    copyProbeToScratch(dir);
    mutateFile(path.join(dir, "run.mjs"), item.target, item.replacement, `ctrl-8 inject unrelated ${item.label}`);

    const res = await runBun(scratchRoot, path.join(dir, "run.mjs"));
    assert.equal(res.timedOut, false);
    assert.notEqual(res.status, 0);
    assert.match(res.combined, /Summary: 5 passed, 1 failed \(total 6\)/);
    assert.match(res.stderr, new RegExp(`unrelated_fixture_error_${item.label.replace("-", "")}`));

    for (const expected of item.rejectAgainst) {
      assert.throws(
        () => assertCheckFailed(res, expected.checkId, expected.pattern, expected.stage),
        /did not match expected cause/,
        `collector falsely accepted unrelated fixture error in ${item.label} for ${expected.stage}`,
      );
    }
    rejectedLabels.push(item.label);
  }

  return `collector rejected unrelated fixture failures in [${rejectedLabels.join(", ")}] (all failed only their target check, none matched mutation-specific causes)`;
}

async function ctrl9UncaughtRunnerErrorCleansScratchAndProcesses(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-9");
  const isolatedTmp = path.join(scratchRoot, "ctrl-9-tmp");
  const observedFile = path.join(scratchRoot, "ctrl-9-observed.json");
  fs.mkdirSync(isolatedTmp, { recursive: true });
  copyProbeToScratch(dir);

  // Inject an uncaught exception outside the awaited check path right after check-1 acquires a live owner/holder.
  mutateFile(
    path.join(dir, "run.mjs"),
    '    const ownerJsonPath = path.join(stateRoot, "owner.json");',
    `    fs.writeFileSync(\n      ${JSON.stringify(observedFile)},\n      JSON.stringify({\n        ownerPid: owner1.pid,\n        ownerStartTime: readProcessStat(owner1.pid)?.startTime ?? null,\n        holderPid: acquired1.holderPid,\n        holderStartTime: acquired1.holderStartTime,\n        runScratchDir: scratchRoot,\n      }) + "\\n",\n      "utf8",\n    );\n    setTimeout(() => {\n      throw new Error("forced_uncaught_runner_error_outside_await");\n    }, 10);\n    await new Promise(() => {});\n    const ownerJsonPath = path.join(stateRoot, "owner.json");`,
    "ctrl-9 inject uncaught exception outside awaited path",
  );

  const res = await runBun(scratchRoot, path.join(dir, "run.mjs"), [], {
    extraEnv: { TMPDIR: isolatedTmp },
  });

  assert.equal(res.timedOut, false);
  assert.deepEqual(
    res.stoppedByController,
    [],
    `run.mjs uncaughtException handler leaked process(es) to controller sweep: ${JSON.stringify(res.stoppedByController)}`,
  );
  assert.notEqual(res.status, 0, `expected non-zero exit on uncaught error, got ${res.status}`);
  assert.match(res.stderr, /forced_uncaught_runner_error_outside_await/);
  assert.equal(fs.existsSync(observedFile), true, "expected check-1 live owner/holder snapshot before uncaught error");

  const observed = JSON.parse(fs.readFileSync(observedFile, "utf8"));
  assert.equal(isSameProcessAlive(observed.ownerPid, observed.ownerStartTime), false, "owner1 survived uncaught runner error");
  assert.equal(isSameProcessAlive(observed.holderPid, observed.holderStartTime), false, "holder1 survived uncaught runner error");
  assert.equal(fs.existsSync(observed.runScratchDir), false, "run.mjs scratch dir survived uncaught runner error");

  const leftover = fs.readdirSync(isolatedTmp);
  assert.deepEqual(leftover, [], `expected empty TMPDIR after uncaught runner error, found: ${JSON.stringify(leftover)}`);

  return `uncaught error exited code=${res.status} with original error printed; owner(pid=${observed.ownerPid}) and holder(pid=${observed.holderPid}) stopped, 0 leftover scratch dirs`;
}

async function main() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-p2-neg-"));
  activeScratchRoot = scratchRoot;
  let passed = 0;
  let failed = 0;

  const controls = [
    { id: "ctrl-1", name: "revoked set after drain fails check-4", fn: ctrl1RevokedAfterDrain },
    { id: "ctrl-2", name: "skipped registry cleanup fails check-3", fn: ctrl2SkipRegistryCleanup },
    { id: "ctrl-3", name: "key hashed from working folder fails check-6", fn: ctrl3HashWorkingFolder },
    { id: "ctrl-4a", name: "removed holder-liveness guard fails check-4 (S1)", fn: ctrl4aRemoveLivenessGuard },
    { id: "ctrl-4b", name: "kill(pid, 0) liveness fails check-4 on zombie (S1)", fn: ctrl4bWeakenLivenessToKillZero },
    { id: "ctrl-5a", name: "forced readProcessStat throws in worker and lease clean up (S2)", fn: ctrl5aForcedPrePublishAndPostAcquireErrors },
    { id: "ctrl-5b", name: "runner timeout before PID-file publication stops unpublished child (S2)", fn: ctrl5bTimeoutBeforePidPublication },
    { id: "ctrl-6", name: "failing prerequisite command leaves no scratch folder (S3)", fn: ctrl6PrerequisiteFailureRemovesScratch },
    { id: "ctrl-7", name: "forced controller timeout stops process tree and removes scratch (S7)", fn: ctrl7ForcedControllerTimeoutCleansTreeAndScratch },
    { id: "ctrl-8", name: "collector rejects unrelated fixture errors in checks 3, 4, and 6 (S6)", fn: ctrl8CollectorRejectsUnrelatedFixtureErrors },
    { id: "ctrl-9", name: "uncaught runner error exits non-zero and leaves no scratch or processes (V1)", fn: ctrl9UncaughtRunnerErrorCleansScratchAndProcesses },
  ];

  try {
    console.log("Probe P2: runnable negative controls (scratch copies only)");
    console.log("scratchRoot: <scratch>");
    console.log("");

    for (const control of controls) {
      if (fatalErrorOccurred) {
        break;
      }
      const start = performance.now();
      try {
        const detail = await control.fn(scratchRoot);
        const ms = (performance.now() - start).toFixed(1);
        console.log(`PASS [${control.id}] (${ms}ms) ${control.name}`);
        console.log(`  ${detail}`);
        passed += 1;
      } catch (err) {
        const ms = (performance.now() - start).toFixed(1);
        console.error(`FAIL [${control.id}] (${ms}ms) ${control.name}`);
        console.error(`  ${formatError(err)}`);
        failed += 1;
      }
    }
  } finally {
    await cleanupControllerResources();
    removeActiveScratchRoot();
  }

  if (fatalShutdownPromise !== null) {
    await fatalShutdownPromise;
    return;
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed (total ${controls.length})`);
  process.exit(failed === 0 && !fatalErrorOccurred ? 0 : 1);
}

main().catch(async (err) => {
  try {
    await cleanupControllerResources();
  } catch (cleanupErr) {
    console.error(formatError(cleanupErr));
  }
  try {
    removeActiveScratchRoot();
  } catch (rmErr) {
    console.error(formatError(rmErr));
  }
  console.error(formatError(err));
  process.exit(1);
});
