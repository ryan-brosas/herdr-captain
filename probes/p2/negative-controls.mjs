#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFLICT_EXIT_CODE, isSameProcessAlive, terminateExternalProcess } from "./lease.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPY_FILES = ["lease.mjs", "owner-worker.mjs", "run.mjs"];

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

function runBun(scriptPath, args = [], extraEnv = undefined) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    timeout: 20000,
  });
  if (res.error) {
    throw res.error;
  }
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    combined: `${res.stdout || ""}\n${res.stderr || ""}`,
  };
}

function assertCheckFailed(result, expectedCheckId) {
  assert.notEqual(result.status, 0, `expected non-zero exit when ${expectedCheckId} is broken`);
  assert.match(
    result.combined,
    new RegExp(`FAIL \\[${expectedCheckId}\\]`),
    `expected FAIL [${expectedCheckId}] in output, got:\n${result.combined}`,
  );
  assert.match(
    result.combined,
    /Summary: 5 passed, 1 failed \(total 6\)/,
    `expected only ${expectedCheckId} to fail, got:\n${result.combined}`,
  );
}

async function ctrl1RevokedAfterDrain(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-1");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "revoked = true;\n    if (revokePromise !== null)",
    "if (revokePromise !== null)",
    "ctrl-1 remove early revoked",
  );
  mutateFile(
    path.join(dir, "lease.mjs"),
    "} while (queueTail !== drainedTail);",
    "} while (queueTail !== drainedTail);\n      revoked = true;",
    "ctrl-1 set revoked after drain",
  );

  const res = runBun(path.join(dir, "run.mjs"));
  assertCheckFailed(res, "check-4");
  return `mutated scratch lease.mjs (revoked set after drain) failed check-4 with exit=${res.status}`;
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

  const res = runBun(path.join(dir, "run.mjs"));
  assertCheckFailed(res, "check-3");
  return `mutated scratch lease.mjs (skipped process-global registry cleanup) failed check-3 with exit=${res.status}`;
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

  const res = runBun(path.join(dir, "run.mjs"));
  assertCheckFailed(res, "check-6");
  return `mutated scratch lease.mjs (hashed cwd instead of git common dir) failed check-6 with exit=${res.status}`;
}

async function ctrl4aRemoveLivenessGuard(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-4a");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    'if (!isHolderAlive()) {\n      revoked = true;\n      throw new LeaseError("lease_revoked", "Owner lease holder is no longer alive");\n    }',
    "// liveness guard removed for S1 negative control",
    "ctrl-4a remove liveness guard",
  );

  const res = runBun(path.join(dir, "run.mjs"));
  assertCheckFailed(res, "check-4");
  return `mutated scratch lease.mjs (removed !isHolderAlive() guard) failed check-4 with exit=${res.status}`;
}

async function ctrl4bWeakenLivenessToKillZero(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-4b");
  copyProbeToScratch(dir);
  mutateFile(
    path.join(dir, "lease.mjs"),
    "const isHolderAlive = () =>\n    !holder.isExited() &&\n    (holderStartTime !== null\n      ? isSameProcessAlive(holder.child.pid, holderStartTime)\n      : isProcessAliveNonZombie(holder.child.pid));",
    "const isHolderAlive = () => {\n    if (holder.isExited()) return false;\n    try { process.kill(holder.child.pid, 0); return true; } catch { return false; }\n  };",
    "ctrl-4b weaken liveness to kill(pid, 0)",
  );

  const res = runBun(path.join(dir, "run.mjs"));
  assertCheckFailed(res, "check-4");
  return `mutated scratch lease.mjs (weakened holder liveness to kill(pid, 0)) failed check-4 on unreaped zombie with exit=${res.status}`;
}

async function ctrl5aForcedWorkerFailureBeforeReport(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-5a");
  const stateRoot = path.join(scratchRoot, "ctrl-5a-state");
  const childPidFile = path.join(scratchRoot, "ctrl-5a-child.json");
  copyProbeToScratch(dir);

  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    '      emit({\n        event: "acquired_with_child",',
    '      throw new Error("forced_failure_before_acquired_with_child");\n      emit({\n        event: "acquired_with_child",',
    "ctrl-5a inject failure before acquired_with_child",
  );

  let spawnedPid = null;
  let spawnedStartTime = null;
  try {
    const res = runBun(path.join(dir, "owner-worker.mjs"), [
      "--mode",
      "hold-with-child",
      "--state-root",
      stateRoot,
      "--project-key",
      "0505050505050501",
      "--child-pid-file",
      childPidFile,
    ]);

    assert.equal(res.status, 1, `expected worker exit 1, got ${res.status}`);
    assert.match(res.stderr, /forced_failure_before_acquired_with_child/);

    const events = res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const spawned = events.find((e) => e.event === "child_spawned");
    const acquired = events.find((e) => e.event === "acquired_with_child");
    assert.ok(spawned, "expected child_spawned event before forced failure");
    assert.equal(acquired, undefined, "acquired_with_child must not be emitted");

    spawnedPid = spawned.childPid;
    spawnedStartTime = spawned.childStartTime;
    assert.equal(Number.isInteger(spawnedPid) && spawnedPid > 0, true);
    assert.equal(typeof spawnedStartTime === "string" && spawnedStartTime.length > 0, true);

    assert.equal(
      isSameProcessAlive(spawnedPid, spawnedStartTime),
      false,
      `detached child pid=${spawnedPid} survived forced failure before acquired_with_child`,
    );
    assert.equal(fs.existsSync(childPidFile), false, "childPidFile was not removed after worker cleanup");

    const lockFree = spawnSync("flock", [
      "--exclusive",
      "--nonblocking",
      "--conflict-exit-code",
      String(CONFLICT_EXIT_CODE),
      path.join(stateRoot, "owner.lock"),
      "true",
    ]);
    assert.equal(lockFree.status, 0, "owner.lock remained held after worker cleanup");

    return `forced worker exception before acquired_with_child exited code=${res.status}; child(pid=${spawnedPid}) stopped, childPidFile removed, owner.lock released`;
  } finally {
    if (spawnedPid !== null && spawnedStartTime !== null) {
      await terminateExternalProcess(spawnedPid, spawnedStartTime, 2000);
    }
  }
}

async function ctrl5bForcedRunnerTimeoutBeforeReport(scratchRoot) {
  const dir = path.join(scratchRoot, "ctrl-5b");
  const observedFile = path.join(scratchRoot, "ctrl-5b-observed-child.json");
  copyProbeToScratch(dir);

  // Suppress child_spawned and hang before acquired_with_child so survivingChildPid stays null
  // when the runner's nextEvent timeout kills owner1; runner must recover and stop child via childPidFile.
  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    `        emit({
          event: "child_spawned",
          pid: lease.pid,
          holderPid: lease.holderPid,
          holderStartTime: lease.holderStartTime,
          childPid: handle.pid,
          childStartTime: handle.startTime,
        });`,
    `        // child_spawned suppressed to exercise runner timeout while survivingChildPid is still null`,
    "ctrl-5b suppress child_spawned",
  );
  mutateFile(
    path.join(dir, "owner-worker.mjs"),
    '      emit({\n        event: "acquired_with_child",',
    `      fs.writeFileSync(${JSON.stringify(observedFile)}, JSON.stringify({ pid: childHandle.pid, startTime: childHandle.startTime }) + "\\n", "utf8");\n      await new Promise(() => {});\n      emit({\n        event: "acquired_with_child",`,
    "ctrl-5b hang worker before acquired_with_child",
  );
  mutateFile(
    path.join(dir, "run.mjs"),
    '    const spawnedEvt = await owner1.nextEvent();\n    assert.equal(spawnedEvt.event, "child_spawned");',
    '    const spawnedEvt = await owner1.nextEvent(250);\n    assert.equal(spawnedEvt.event, "child_spawned");',
    "ctrl-5b shorten check5 nextEvent timeout",
  );

  let observed = null;
  try {
    const res = runBun(path.join(dir, "run.mjs"));
    assertCheckFailed(res, "check-5");
    assert.match(res.combined, /Timed out waiting for worker event/);
    assert.equal(fs.existsSync(observedFile), true, "expected worker to spawn child before runner timeout");

    observed = JSON.parse(fs.readFileSync(observedFile, "utf8"));
    assert.equal(Number.isInteger(observed.pid) && observed.pid > 0, true);
    assert.equal(typeof observed.startTime === "string" && observed.startTime.length > 0, true);
    assert.equal(
      isSameProcessAlive(observed.pid, observed.startTime),
      false,
      `detached child pid=${observed.pid} survived runner timeout before acquired_with_child`,
    );

    return `forced runner timeout (250ms) before any child event reached runner failed check-5 with exit=${res.status}; child(pid=${observed.pid}) confirmed terminated via childPidFile fallback`;
  } finally {
    if (observed && Number.isInteger(observed.pid) && typeof observed.startTime === "string") {
      await terminateExternalProcess(observed.pid, observed.startTime, 2000);
    }
  }
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

  const res = runBun(path.join(HERE, "run.mjs"), [], {
    TMPDIR: isolatedTmp,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
  });

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

  return `failing flock prerequisite exited code=${res.status}; observed ${seenDuringPrereq.length} scratch dir created before failure and 0 leftover after exit`;
}

async function main() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-p2-neg-"));
  let passed = 0;
  let failed = 0;

  const controls = [
    { id: "ctrl-1", name: "revoked set after drain fails check-4", fn: ctrl1RevokedAfterDrain },
    { id: "ctrl-2", name: "skipped registry cleanup fails check-3", fn: ctrl2SkipRegistryCleanup },
    { id: "ctrl-3", name: "key hashed from working folder fails check-6", fn: ctrl3HashWorkingFolder },
    { id: "ctrl-4a", name: "removed holder-liveness guard fails check-4 (S1)", fn: ctrl4aRemoveLivenessGuard },
    { id: "ctrl-4b", name: "kill(pid, 0) liveness fails check-4 on zombie (S1)", fn: ctrl4bWeakenLivenessToKillZero },
    { id: "ctrl-5a", name: "forced worker failure before acquired_with_child leaves no child (S2)", fn: ctrl5aForcedWorkerFailureBeforeReport },
    { id: "ctrl-5b", name: "forced runner timeout before acquired_with_child leaves no child (S2)", fn: ctrl5bForcedRunnerTimeoutBeforeReport },
    { id: "ctrl-6", name: "failing prerequisite command leaves no scratch folder (S3)", fn: ctrl6PrerequisiteFailureRemovesScratch },
  ];

  try {
    console.log("Probe P2: runnable negative controls (scratch copies only)");
    console.log("scratchRoot: <scratch>");
    console.log("");

    for (const control of controls) {
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
        console.error(`  ${err instanceof Error ? err.stack || err.message : String(err)}`);
        failed += 1;
      }
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed (total ${controls.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
