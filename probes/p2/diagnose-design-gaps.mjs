#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFLICT_EXIT_CODE,
  formatError,
  isSameProcessAlive,
  readProcessStat,
  terminateExternalProcess,
} from "./lease.mjs";

const ownedChildren = new Set();
const trackedExternals = new Map();
let activeScratchRoot = null;
let fatalShutdownPromise = null;

function removeActiveScratchRoot() {
  if (activeScratchRoot !== null) {
    const target = activeScratchRoot;
    fs.rmSync(target, { recursive: true, force: true });
    activeScratchRoot = null;
  }
}

function trackChild(child) {
  let exitedFlag = false;
  let handle;
  const exited = new Promise((resolve) => {
    const settle = (info) => {
      if (exitedFlag) {
        return;
      }
      exitedFlag = true;
      ownedChildren.delete(handle);
      resolve(info);
    };
    child.once("error", (err) => {
      settle({ code: null, signal: null, error: err });
    });
    child.once("exit", (code, signal) => {
      settle({ code, signal });
    });
  });

  const ensureStopped = async () => {
    if (!exitedFlag) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore ESRCH if exited concurrently.
      }
      await exited;
    }
  };

  handle = {
    child,
    pid: child.pid,
    hasExited: () => exitedFlag,
    exited,
    ensureStopped,
  };
  ownedChildren.add(handle);
  return handle;
}

function trackExternal(pid, startTime, label) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
    return;
  }
  trackedExternals.set(`${pid}:${startTime}`, { pid, startTime, label });
}

function retireExternalIfDead(pid, startTime) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
    return false;
  }
  if (!isSameProcessAlive(pid, startTime)) {
    trackedExternals.delete(`${pid}:${startTime}`);
    return true;
  }
  return false;
}

async function cleanupAll() {
  const errors = [];
  for (const entry of [...ownedChildren]) {
    try {
      await entry.ensureStopped();
    } catch (err) {
      errors.push(err);
    }
  }
  for (const entry of [...trackedExternals.values()]) {
    try {
      const stopped = await terminateExternalProcess(entry.pid, entry.startTime, 2000);
      if (!stopped) {
        throw new Error(`Failed to confirm termination of ${entry.label} pid=${entry.pid}`);
      }
      trackedExternals.delete(`${entry.pid}:${entry.startTime}`);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Cleanup failed for ${errors.length} tracked process(es)`);
  }
}

function handleFatalError(label, err) {
  console.error(`${label}: ${formatError(err)}`);
  if (fatalShutdownPromise !== null) {
    return fatalShutdownPromise;
  }
  fatalShutdownPromise = (async () => {
    try {
      await cleanupAll();
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
  for (const entry of [...ownedChildren]) {
    if (!entry.hasExited()) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // Ignore ESRCH on exit fallback.
      }
    }
  }
  for (const entry of [...trackedExternals.values()]) {
    if (isSameProcessAlive(entry.pid, entry.startTime)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // Ignore ESRCH on exit fallback.
      }
    }
  }
  try {
    removeActiveScratchRoot();
  } catch {
    // Ignore exit fallback removal error.
  }
});

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        stream.off("data", onData);
        resolve(buf.slice(0, idx).replace(/\r$/, ""));
      }
    };
    stream.on("data", onData);
    stream.once("end", () => reject(new Error("Stream ended before newline")));
    stream.once("error", reject);
  });
}

async function diagnoseNoForkGap(scratchRoot) {
  const lockDefault = path.join(scratchRoot, "gap1-default.lock");
  const fifoDefault = path.join(scratchRoot, "gap1-default.fifo");
  const lockNoFork = path.join(scratchRoot, "gap1-nofork.lock");
  const fifoNoFork = path.join(scratchRoot, "gap1-nofork.fifo");

  execFileSync("mkfifo", [fifoDefault]);
  execFileSync("mkfifo", [fifoNoFork]);

  // Keep stdin write-end open via a FIFO writer so SIGKILL(flock) does not auto-close the holder's stdin.
  // Note: this exercises wrapper/holder PID divergence, not owner-death EOF release.
  const writerDefault = trackChild(
    spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoDefault], {
      stdio: ["pipe", "ignore", "ignore"],
    }),
  );

  const flockDefault = trackChild(
    spawn(
      "sh",
      [
        "-c",
        'exec flock --exclusive --nonblock "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
        "_",
        lockDefault,
        fifoDefault,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
  );

  const innerPidDefault = Number(await readFirstLine(flockDefault.child.stdout));
  const innerStartTime = readProcessStat(innerPidDefault)?.startTime ?? null;
  trackExternal(innerPidDefault, innerStartTime, "orphaned-inner-holder");
  assert.notEqual(flockDefault.pid, innerPidDefault, "expected default flock to fork a distinct inner holder PID");

  // Kill flock wrapper directly while pipe stays open.
  await flockDefault.ensureStopped();

  const innerAliveAfterFlockKill = isSameProcessAlive(innerPidDefault, innerStartTime);
  const lockCheckAfterFlockKill = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockDefault,
    "true",
  ]);
  assert.equal(innerAliveAfterFlockKill, true, "expected inner holder to survive SIGKILL(flock)");
  assert.equal(lockCheckAfterFlockKill.status, CONFLICT_EXIT_CODE, "expected orphaned inner holder to keep lock held");

  // Clean up writer and wait for orphaned inner holder to exit via kernel lock wait.
  writerDefault.child.stdin.end();
  await writerDefault.exited;
  spawnSync("flock", ["--exclusive", "--timeout", "5", lockDefault, "true"]);
  assert.equal(retireExternalIfDead(innerPidDefault, innerStartTime), true);

  // Contrast with --no-fork: single PID, SIGKILL releases lock immediately even while pipe stays open.
  const writerNoFork = trackChild(
    spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoNoFork], {
      stdio: ["pipe", "ignore", "ignore"],
    }),
  );
  const flockNoFork = trackChild(
    spawn(
      "sh",
      [
        "-c",
        'exec flock --exclusive --nonblocking --no-fork "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
        "_",
        lockNoFork,
        fifoNoFork,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
  );

  const innerPidNoFork = Number(await readFirstLine(flockNoFork.child.stdout));
  assert.equal(flockNoFork.pid, innerPidNoFork, "expected --no-fork to keep single holder PID");

  await flockNoFork.ensureStopped();

  const lockCheckNoFork = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockNoFork,
    "true",
  ]);
  assert.equal(lockCheckNoFork.status, 0, "expected --no-fork lock to release immediately on SIGKILL");

  writerNoFork.child.stdin.end();
  await writerNoFork.exited;

  return `default flock forked two PIDs (flock=${flockDefault.pid}, inner=${innerPidDefault}): SIGKILL(flock) left inner alive=${innerAliveAfterFlockKill} and lock STILL HELD (exit=${lockCheckAfterFlockKill.status}); with --no-fork single PID (${flockNoFork.pid}===${innerPidNoFork}): SIGKILL released lock immediately (exit=${lockCheckNoFork.status})`;
}

async function diagnoseConflictExitCodeGap(scratchRoot) {
  const lockPath = path.join(scratchRoot, "gap2.lock");
  const holder = trackChild(
    spawn(
      "flock",
      ["--exclusive", "--nonblocking", "--no-fork", lockPath, "sh", "-c", 'printf "ready\\n"; exec cat >/dev/null'],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  await readFirstLine(holder.child.stdout);

  const defaultConflict = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
  const explicitConflict = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockPath,
    "true",
  ]);

  holder.child.stdin.end();
  await holder.exited;

  const defaultHolderFail = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "sh", "-c", "exit 1"]);
  const explicitHolderFail = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockPath,
    "sh",
    "-c",
    "exit 1",
  ]);
  const missingDirFail = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    path.join(scratchRoot, "missing", "owner.lock"),
    "true",
  ]);

  assert.equal(defaultConflict.status, 1);
  assert.equal(defaultHolderFail.status, 1);
  assert.equal(explicitConflict.status, CONFLICT_EXIT_CODE);
  assert.equal(explicitHolderFail.status, 1);
  assert.equal(missingDirFail.status, 66);

  return `default flock returns exit=1 for BOTH conflict (${defaultConflict.status}) and holder failure (${defaultHolderFail.status}); with --conflict-exit-code ${CONFLICT_EXIT_CODE}, conflict=${explicitConflict.status}, holder_fail=${explicitHolderFail.status}, missing_dir=${missingDirFail.status}`;
}

async function diagnoseCloseWithoutAwaitExitRace(scratchRoot) {
  const lockPath = path.join(scratchRoot, "gap3.lock");
  const rounds = 40;

  function acquireRaw() {
    return new Promise((resolve, reject) => {
      const handle = trackChild(
        spawn(
          "flock",
          [
            "--exclusive",
            "--nonblocking",
            "--no-fork",
            "--conflict-exit-code",
            String(CONFLICT_EXIT_CODE),
            lockPath,
            "sh",
            "-c",
            'printf "ready\\n"; exec cat >/dev/null',
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
      );
      handle.child.stdin.on("error", () => {});

      let settled = false;
      let buf = "";
      handle.child.stdout.on("data", (chunk) => {
        if (settled) return;
        buf += chunk.toString("utf8");
        if (buf.includes("\n")) {
          settled = true;
          resolve(handle);
        }
      });
      handle.exited.then(({ code, signal }) => {
        if (!settled) {
          settled = true;
          reject(new Error(code === CONFLICT_EXIT_CODE ? "owner_conflict" : `exit=${code} sig=${signal}`));
        }
      });
    });
  }

  let conflictsWithoutAwait = 0;
  let current = await acquireRaw();
  for (let i = 0; i < rounds; i += 1) {
    current.child.stdin.end();
    try {
      const next = await acquireRaw();
      await current.exited;
      current = next;
    } catch (err) {
      if (err instanceof Error && err.message === "owner_conflict") {
        conflictsWithoutAwait += 1;
      } else {
        throw err;
      }
      await current.exited;
      current = await acquireRaw();
    }
  }
  current.child.stdin.end();
  await current.exited;

  let conflictsWithAwait = 0;
  current = await acquireRaw();
  for (let i = 0; i < rounds; i += 1) {
    current.child.stdin.end();
    await current.exited;
    try {
      current = await acquireRaw();
    } catch (err) {
      if (err instanceof Error && err.message === "owner_conflict") {
        conflictsWithAwait += 1;
      }
      throw err;
    }
  }
  current.child.stdin.end();
  await current.exited;

  assert.equal(conflictsWithAwait, 0, "expected zero conflicts when awaiting holder exit");
  return `timing sample across ${rounds} back-to-back handoffs: closing stdin WITHOUT awaiting holder exit observed owner_conflict ${conflictsWithoutAwait}/${rounds} times (not asserted >0 because OS scheduling varies); closing stdin AND awaiting holder exit (zero sleep) asserted ${conflictsWithAwait}/${rounds} conflicts`;
}

async function main() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-p2-gaps-"));
  activeScratchRoot = scratchRoot;
  try {
    console.log("Probe P2: design-gap reproduction diagnostics");
    console.log("scratchRoot: <scratch>");
    console.log("");

    console.log(`DIAG [gap-1: --no-fork] ${await diagnoseNoForkGap(scratchRoot)}`);
    console.log(`DIAG [gap-2: --conflict-exit-code] ${await diagnoseConflictExitCodeGap(scratchRoot)}`);
    console.log(`DIAG [gap-3: await holder exit on close] ${await diagnoseCloseWithoutAwaitExitRace(scratchRoot)}`);
  } finally {
    await cleanupAll();
    removeActiveScratchRoot();
  }
  if (fatalShutdownPromise !== null) {
    await fatalShutdownPromise;
  }
}

main().catch(async (err) => {
  try {
    await cleanupAll();
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
