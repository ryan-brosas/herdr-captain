#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFLICT_EXIT_CODE, isProcessAliveNonZombie } from "./lease.mjs";

const trackedPids = new Set();

function cleanup() {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already exited processes.
    }
  }
  trackedPids.clear();
}

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
  const writerDefault = spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoDefault], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  trackedPids.add(writerDefault.pid);

  const flockDefault = spawn(
    "sh",
    [
      "-c",
      'exec flock --exclusive --nonblock "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
      "_",
      lockDefault,
      fifoDefault,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  trackedPids.add(flockDefault.pid);

  const innerPidDefault = Number(await readFirstLine(flockDefault.stdout));
  trackedPids.add(innerPidDefault);
  assert.notEqual(flockDefault.pid, innerPidDefault, "expected default flock to fork a distinct inner holder PID");

  // Kill flock wrapper directly while pipe stays open.
  process.kill(flockDefault.pid, "SIGKILL");
  await new Promise((r) => flockDefault.once("exit", r));
  trackedPids.delete(flockDefault.pid);

  const innerAliveAfterFlockKill = isProcessAliveNonZombie(innerPidDefault);
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
  writerDefault.stdin.end();
  await new Promise((r) => writerDefault.once("exit", r));
  trackedPids.delete(writerDefault.pid);
  spawnSync("flock", ["--exclusive", "--timeout", "5", lockDefault, "true"]);
  trackedPids.delete(innerPidDefault);

  // Contrast with --no-fork: single PID, SIGKILL releases lock immediately even while pipe stays open.
  const writerNoFork = spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoNoFork], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  trackedPids.add(writerNoFork.pid);
  const flockNoFork = spawn(
    "sh",
    [
      "-c",
      'exec flock --exclusive --nonblocking --no-fork "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
      "_",
      lockNoFork,
      fifoNoFork,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  trackedPids.add(flockNoFork.pid);

  const innerPidNoFork = Number(await readFirstLine(flockNoFork.stdout));
  assert.equal(flockNoFork.pid, innerPidNoFork, "expected --no-fork to keep single holder PID");

  process.kill(flockNoFork.pid, "SIGKILL");
  await new Promise((r) => flockNoFork.once("exit", r));
  trackedPids.delete(flockNoFork.pid);

  const lockCheckNoFork = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockNoFork,
    "true",
  ]);
  assert.equal(lockCheckNoFork.status, 0, "expected --no-fork lock to release immediately on SIGKILL");

  writerNoFork.stdin.end();
  await new Promise((r) => writerNoFork.once("exit", r));
  trackedPids.delete(writerNoFork.pid);

  return `default flock forked two PIDs (flock=${flockDefault.pid}, inner=${innerPidDefault}): SIGKILL(flock) left inner alive=${innerAliveAfterFlockKill} and lock STILL HELD (exit=${lockCheckAfterFlockKill.status}); with --no-fork single PID (${flockNoFork.pid}===${innerPidNoFork}): SIGKILL released lock immediately (exit=${lockCheckNoFork.status})`;
}

async function diagnoseConflictExitCodeGap(scratchRoot) {
  const lockPath = path.join(scratchRoot, "gap2.lock");
  const holder = spawn(
    "flock",
    ["--exclusive", "--nonblocking", "--no-fork", lockPath, "sh", "-c", 'printf "ready\\n"; exec cat >/dev/null'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  trackedPids.add(holder.pid);
  await readFirstLine(holder.stdout);

  const defaultConflict = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
  const explicitConflict = spawnSync(
    "flock",
    ["--exclusive", "--nonblocking", "--conflict-exit-code", String(CONFLICT_EXIT_CODE), lockPath, "true"],
  );

  holder.stdin.end();
  await new Promise((r) => holder.once("exit", r));
  trackedPids.delete(holder.pid);

  const defaultHolderFail = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "sh", "-c", "exit 1"]);
  const explicitHolderFail = spawnSync(
    "flock",
    ["--exclusive", "--nonblocking", "--conflict-exit-code", String(CONFLICT_EXIT_CODE), lockPath, "sh", "-c", "exit 1"],
  );
  const missingDirFail = spawnSync(
    "flock",
    ["--exclusive", "--nonblocking", "--conflict-exit-code", String(CONFLICT_EXIT_CODE), path.join(scratchRoot, "missing", "owner.lock"), "true"],
  );

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
      const child = spawn(
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
      );
      trackedPids.add(child.pid);
      child.stdin.on("error", () => {});
      const exited = new Promise((r) =>
        child.once("exit", (code, signal) => {
          trackedPids.delete(child.pid);
          r({ code, signal });
        }),
      );

      let settled = false;
      let buf = "";
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        buf += chunk.toString("utf8");
        if (buf.includes("\n")) {
          settled = true;
          resolve({ child, exited });
        }
      });
      exited.then(({ code, signal }) => {
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
  return `across ${rounds} back-to-back handoffs: closing stdin WITHOUT awaiting holder exit hit owner_conflict ${conflictsWithoutAwait}/${rounds} times; closing stdin AND awaiting holder exit (zero sleep) hit owner_conflict ${conflictsWithAwait}/${rounds} times`;
}

async function main() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-p2-gaps-"));
  console.log("Probe P2: design-gap reproduction diagnostics");
  console.log("scratchRoot: <scratch>");
  console.log("");

  try {
    console.log(`DIAG [gap-1: --no-fork] ${await diagnoseNoForkGap(scratchRoot)}`);
    console.log(`DIAG [gap-2: --conflict-exit-code] ${await diagnoseConflictExitCodeGap(scratchRoot)}`);
    console.log(`DIAG [gap-3: await holder exit on close] ${await diagnoseCloseWithoutAwaitExitRace(scratchRoot)}`);
  } finally {
    cleanup();
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  cleanup();
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
