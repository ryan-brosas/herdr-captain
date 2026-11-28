import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  acquireLease,
  CONFLICT_EXIT_CODE,
  getGlobalLeaseRegistry,
  isSameProcessAlive,
  LeaseError,
  MODULE_INSTANCE_ID,
  readOwnerRecord,
  readProcessStat,
  REGISTRY_SYMBOL,
  type LeaseRegistryEntry,
  type OwnerLease,
} from "../src/lease.ts";
import {
  assertControlFailed,
  acquireSkippingRegistryCleanup,
  createBrokenLivenessAdapter,
  createBrokenRevokedAfterDrainAdapter,
  MISSING_ZOMBIE_REJECTION_CAUSE,
  verifyControlledRevocationDrain,
  verifyReloadHandoffStep,
  verifyUnreapedZombiePreEffect,
} from "./helpers/lease-verifiers.ts";
import {
  confirmProcessDead,
  createDeferred,
  findProcessesByEnvToken,
  HARNESS_RUNNER_PATH,
  isLockFreeNonBlocking,
  OWNER_WORKER_PATH,
  ProcessTracker,
  readFirstLine,
  scanProcessesByEnvToken,
  snapshotFile,
  stopProcessesByEnvToken,
  waitForKernelLockRelease,
  type FdInfo,
} from "./helpers/process.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEASE_SOURCE_PATH = path.resolve(HERE, "..", "src", "lease.ts");

function makeStatLine(
  pid: number,
  comm: string,
  state: string,
  startTime: string,
  ppid = 0,
): string {
  // Linux /proc/<pid>/stat: fields 3..22 after ") " -> state is field[0], ppid is field[1], starttime is field[19].
  const middle = [String(ppid), ...Array.from({ length: 17 }, () => "0")].join(" ");
  return `${pid} (${comm}) ${state} ${middle} ${startTime} 0 0\n`;
}

interface FixtureProcEntry {
  pid: number;
  stat?: string;
  statMode?: number;
  environ?: string;
  environMode?: number;
  uids?: [number, number, number, number];
  statusRaw?: string;
  statusMode?: number;
  uidMap?: string;
}

function createFixtureProcRoot(
  procRoot: string,
  selfStartTime: string,
  entries: FixtureProcEntry[],
  selfUidMap?: string,
  selfPpid = 0,
): { procRoot: string; restoreModes: () => void } {
  const chmodPaths: string[] = [];
  const selfStatLine = makeStatLine(process.pid, "bun", "R", selfStartTime, selfPpid);
  fs.mkdirSync(path.join(procRoot, "self"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "self", "stat"), selfStatLine, "utf8");
  fs.writeFileSync(path.join(procRoot, "self", "environ"), "PATH=/usr/bin\0", "utf8");
  if (selfUidMap !== undefined) {
    fs.writeFileSync(path.join(procRoot, "self", "uid_map"), selfUidMap, "utf8");
  }
  if (selfPpid > 0) {
    const selfPidDir = path.join(procRoot, String(process.pid));
    fs.mkdirSync(selfPidDir, { recursive: true });
    fs.writeFileSync(path.join(selfPidDir, "stat"), selfStatLine, "utf8");
    fs.writeFileSync(path.join(selfPidDir, "environ"), "PATH=/usr/bin\0", "utf8");
    if (selfUidMap !== undefined) {
      fs.writeFileSync(path.join(selfPidDir, "uid_map"), selfUidMap, "utf8");
    }
  }

  for (const entry of entries) {
    const pidDir = path.join(procRoot, String(entry.pid));
    fs.mkdirSync(pidDir, { recursive: true });
    if (entry.statusRaw !== undefined || entry.uids !== undefined) {
      const statusPath = path.join(pidDir, "status");
      const statusContent =
        entry.statusRaw ?? `Name:\tfixture\nUid:\t${entry.uids?.join("\t")}\n`;
      fs.writeFileSync(statusPath, statusContent, "utf8");
      if (entry.statusMode !== undefined) {
        fs.chmodSync(statusPath, entry.statusMode);
        chmodPaths.push(statusPath);
      }
    }
    if (entry.uidMap !== undefined) {
      fs.writeFileSync(path.join(pidDir, "uid_map"), entry.uidMap, "utf8");
    }
    if (entry.stat !== undefined) {
      const statPath = path.join(pidDir, "stat");
      fs.writeFileSync(statPath, entry.stat, "utf8");
      if (entry.statMode !== undefined) {
        fs.chmodSync(statPath, entry.statMode);
        chmodPaths.push(statPath);
      }
    }
    if (entry.environ !== undefined) {
      const envPath = path.join(pidDir, "environ");
      fs.writeFileSync(envPath, entry.environ, "utf8");
      if (entry.environMode !== undefined) {
        fs.chmodSync(envPath, entry.environMode);
        chmodPaths.push(envPath);
      }
    }
  }

  return {
    procRoot,
    restoreModes: () => {
      for (const filePath of chmodPaths) {
        try {
          fs.chmodSync(filePath, 0o644);
        } catch {
          // Ignore if already removed.
        }
      }
    },
  };
}

function makeFakeFlockScript(binDir: string, scriptBody: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const flockPath = path.join(binDir, "flock");
  fs.writeFileSync(flockPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return flockPath;
}

async function waitUntilCondition(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function runBunSubprocess(
  tracker: ProcessTracker,
  scratchRoot: string,
  scriptPath: string,
  args: string[] = [],
  options: {
    extraEnv?: Record<string, string>;
    timeoutMs?: number;
    killWhenFileExists?: string;
  } = {},
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  ctrlToken: string;
  runTmpDir: string | null;
  stoppedByController: Array<{ pid: number; startTime: string }>;
}> {
  const { extraEnv, timeoutMs = 15000, killWhenFileExists } = options;
  const ctrlToken = `herdr-s1a-ctrl-${crypto.randomUUID()}`;
  tracker.registerEnvToken("HERDR_S1A_CTRL_TOKEN", ctrlToken);

  const ownsTmpDir = !(extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, "TMPDIR"));
  const runTmpDir = ownsTmpDir ? fs.mkdtempSync(path.join(scratchRoot, "sub-tmp-")) : null;
  if (runTmpDir !== null) {
    tracker.registerScratchDir(runTmpDir);
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: Error } = {
    code: null,
    signal: null,
  };
  let stoppedByController: Array<{ pid: number; startTime: string }> = [];

  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(runTmpDir !== null ? { TMPDIR: runTmpDir } : {}),
      ...(extraEnv ?? {}),
      HERDR_S1A_CTRL_TOKEN: ctrlToken,
    },
  });
  const tracked = tracker.trackChild(child);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  let watcherActive = true;
  const killChildOnTimeout = (): void => {
    if (tracked.hasExited()) {
      return;
    }
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore ESRCH if exited concurrently.
    }
  };

  const timer = setTimeout(killChildOnTimeout, timeoutMs);

  let fileKillPromise: Promise<void> | undefined;
  if (killWhenFileExists) {
    fileKillPromise = (async () => {
      const deadline = performance.now() + timeoutMs;
      while (watcherActive && !tracked.hasExited() && performance.now() < deadline) {
        if (fs.existsSync(killWhenFileExists)) {
          try {
            const raw = fs.readFileSync(killWhenFileExists, "utf8");
            if (raw.endsWith("\n")) {
              killChildOnTimeout();
              return;
            }
          } catch {
            // File may still be finishing write.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
  }

  try {
    exitInfo = await tracked.exited;
  } finally {
    watcherActive = false;
    clearTimeout(timer);
    if (fileKillPromise) {
      await fileKillPromise;
    }
    await tracked.ensureStopped();
    stoppedByController = await tracker.stopAndRetireEnvToken("HERDR_S1A_CTRL_TOKEN", ctrlToken);
    if (runTmpDir !== null) {
      fs.rmSync(runTmpDir, { recursive: true, force: true });
      tracker.scratchDirs.delete(runTmpDir);
    }
  }

  if (exitInfo.error) {
    throw exitInfo.error;
  }

  return {
    status: exitInfo.code,
    signal: exitInfo.signal,
    timedOut,
    stdout,
    stderr,
    ctrlToken,
    runTmpDir,
    stoppedByController,
  };
}

const suiteTracker = new ProcessTracker();
let scratchRoot = "";

beforeEach(() => {
  scratchRoot = suiteTracker.createScratchDir("herdr-captain-s1a-");
});

afterEach(async () => {
  const registry = getGlobalLeaseRegistry();
  for (const [, entry] of [...registry.entries()]) {
    try {
      await entry.revokeAndClose();
    } catch {
      // Best-effort cleanup before strict tracker verification.
    }
  }
  registry.clear();
  await suiteTracker.cleanupAll();
  expect(suiteTracker.ownedChildren.size).toBe(0);
  expect(suiteTracker.trackedExternals.size).toBe(0);
  expect(suiteTracker.activeEnvTokens.size).toBe(0);
  expect(suiteTracker.scratchDirs.size).toBe(0);
});

afterAll(() => {
  suiteTracker.dispose();
});

describe("Rule (a): no stealing, conflict exit code, and owner.lock preservation", () => {
  test("P2 check-1: second owner fails with owner_conflict and leaves owner.json untouched", async () => {
    const stateRoot = path.join(scratchRoot, "check1");
    const projectKey = "0101010101010101";

    const owner1 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);

    const acquired1 = await owner1.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    const holderPid = acquired1.holderPid as number;
    const holderStartTime = acquired1.holderStartTime as string;
    expect(isSameProcessAlive(holderPid, holderStartTime)).toBe(true);

    const ownerJsonPath = path.join(stateRoot, "owner.json");
    const before = snapshotFile(ownerJsonPath);

    const attempt2 = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(attempt2.event.event).toBe("acquire_failed");
    expect(attempt2.event.code).toBe("owner_conflict");
    expect(attempt2.exit.code).toBe(2);

    const after = snapshotFile(ownerJsonPath);
    expect(after.sha256).toBe(before.sha256);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(isSameProcessAlive(holderPid, holderStartTime)).toBe(true);

    owner1.sendLine("write:owner1-proof.txt");
    const wrote = await owner1.nextEvent();
    if (wrote.event === "released" && wrote.reason === "stdin_eof") {
      assert.fail(
        `Command "write:owner1-proof.txt" never reached owner-worker: worker stdin ended before the command arrived (event=${JSON.stringify(wrote)})`,
      );
    }
    expect(wrote.event).toBe("wrote");
    expect(wrote.epoch).toBe(1);
    expect(fs.readFileSync(path.join(stateRoot, "owner1-proof.txt"), "utf8")).toBe("epoch=1\n");

    const exit1 = await owner1.releaseAndWait();
    expect(exit1.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holderPid, holderStartTime)).toBe(true);
  });

  test("owner-worker hold mode distinguishes stdin_eof from release_command on final released event", async () => {
    const stateRoot = path.join(scratchRoot, "worker-release-reason");
    const projectKey = "0101010101010102";

    // 1. Closing worker stdin without sending a `release` line reports reason="stdin_eof".
    const eofWorker = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired1 = await eofWorker.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    const holder1Pid = acquired1.holderPid as number;
    const holder1Start = acquired1.holderStartTime as string;

    eofWorker.child.stdin?.end();
    const releasedEof = await eofWorker.nextEvent();
    expect(releasedEof.event).toBe("released");
    expect(releasedEof.reason).toBe("stdin_eof");
    expect(releasedEof.epoch).toBe(1);

    const exit1 = await eofWorker.exited;
    expect(exit1.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holder1Pid, holder1Start)).toBe(true);

    // 2. Sending an explicit `release` line reports reason="release_command".
    const cmdWorker = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired2 = await cmdWorker.nextEvent();
    expect(acquired2.event).toBe("acquired");
    expect(acquired2.epoch).toBe(2);
    const holder2Pid = acquired2.holderPid as number;
    const holder2Start = acquired2.holderStartTime as string;

    cmdWorker.sendLine("release");
    const releasedCmd = await cmdWorker.nextEvent();
    expect(releasedCmd.event).toBe("released");
    expect(releasedCmd.reason).toBe("release_command");
    expect(releasedCmd.epoch).toBe(2);

    const exit2 = await cmdWorker.exited;
    expect(exit2.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holder2Pid, holder2Start)).toBe(true);
  });

  test("P2 gap-2: raw flock --conflict-exit-code 200 separates conflict from holder failure and missing directory", async () => {
    const lockPath = path.join(scratchRoot, "gap2.lock");
    const holder = suiteTracker.trackChild(
      spawn(
        "flock",
        [
          "--exclusive",
          "--nonblocking",
          "--no-fork",
          lockPath,
          "sh",
          "-c",
          'printf "ready\\n"; exec cat >/dev/null',
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    assert.ok(holder.child.stdout);
    expect(await readFirstLine(holder.child.stdout)).toBe("ready");

    const defaultConflict = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
    const explicitConflict = spawnSync("flock", [
      "--exclusive",
      "--nonblocking",
      "--conflict-exit-code",
      String(CONFLICT_EXIT_CODE),
      lockPath,
      "true",
    ]);

    holder.child.stdin?.end();
    await holder.exited;

    const defaultHolderFail = spawnSync("flock", [
      "--exclusive",
      "--nonblock",
      lockPath,
      "sh",
      "-c",
      "exit 1",
    ]);
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

    expect(defaultConflict.status).toBe(1);
    expect(defaultHolderFail.status).toBe(1);
    expect(explicitConflict.status).toBe(CONFLICT_EXIT_CODE);
    expect(explicitHolderFail.status).toBe(1);
    expect(missingDirFail.status).toBe(66);
  });

  test("non-200 exits, bad ready line, and acquire timeout before ready line fail with lease_acquire_error (not owner_conflict)", async () => {
    const cases: Array<{
      name: string;
      script: string;
      acquireTimeoutMs?: number;
      expectedMessage: RegExp;
    }> = [
      {
        name: "exit-1",
        script: 'echo "holder boom" >&2\nexit 1',
        expectedMessage: /Holder exited before ready \(code=1/,
      },
      {
        name: "exit-66",
        script: 'echo "cannot open lock" >&2\nexit 66',
        expectedMessage: /Holder exited before ready \(code=66/,
      },
      {
        name: "exit-0-without-ready",
        script: "exit 0",
        expectedMessage: /Holder exited before ready \(code=0/,
      },
      {
        name: "unexpected-ready-line",
        script: 'printf "not-ready\\n"\nexec cat >/dev/null',
        expectedMessage: /Unexpected holder ready line/,
      },
      {
        name: "acquire-timeout",
        script: "exec cat >/dev/null",
        acquireTimeoutMs: 120,
        expectedMessage: /Timed out waiting for holder ready line/,
      },
    ];

    const originalPath = process.env.PATH ?? "";
    for (const item of cases) {
      const binDir = path.join(scratchRoot, `fake-bin-${item.name}`);
      const stateRoot = path.join(scratchRoot, `state-${item.name}`);
      makeFakeFlockScript(binDir, item.script);

      process.env.PATH = `${binDir}:${originalPath}`;
      try {
        let caught: unknown;
        try {
          await acquireLease({
            projectKey: `a000000000000001`,
            stateRoot,
            acquireTimeoutMs: item.acquireTimeoutMs ?? 2000,
            releaseTimeoutMs: 500,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LeaseError);
        const leaseErr = caught as LeaseError;
        expect(leaseErr.code).toBe("lease_acquire_error");
        expect(leaseErr.code).not.toBe("owner_conflict");
        expect(leaseErr.message).toMatch(item.expectedMessage);
      } finally {
        process.env.PATH = originalPath;
      }
    }

    // Missing flock binary (ENOENT spawn error) also yields lease_acquire_error.
    const emptyBin = path.join(scratchRoot, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    try {
      let caught: unknown;
      try {
        await acquireLease({
          projectKey: "a000000000000002",
          stateRoot: path.join(scratchRoot, "state-no-flock"),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LeaseError);
      expect((caught as LeaseError).code).toBe("lease_acquire_error");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("owner.lock is never unlinked and src/lease.ts obeys static section 5 boundaries", async () => {
    const stateRoot = path.join(scratchRoot, "lock-inode");
    const projectKey = "a101010101010101";
    const lockPath = path.join(stateRoot, "owner.lock");

    const lease1 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "inode-holder-1");
    const ino1 = fs.statSync(lockPath).ino;
    await lease1.release();
    expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);

    // owner.lock must still exist with the exact same inode after release.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(ino1);

    const lease2 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease2.holderPid, lease2.holderStartTime, "inode-holder-2");
    expect(fs.statSync(lockPath).ino).toBe(ino1);
    expect(lease2.epoch).toBe(2);
    await lease2.release();
    expect(suiteTracker.retireExternalIfDead(lease2.holderPid, lease2.holderStartTime)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(ino1);

    // Boundary check on src/lease.ts: only node:* imports, no git, no kill(pid, 0), no unlink of owner.lock.
    const source = fs.readFileSync(LEASE_SOURCE_PATH, "utf8");
    const importSpecs = [...source.matchAll(/^\s*import\s+[^;]*?\s+from\s+["']([^"']+)["'];/gm)].map(
      (m) => m[1],
    );
    expect(importSpecs.length).toBeGreaterThan(0);
    for (const spec of importSpecs) {
      expect(spec?.startsWith("node:")).toBe(true);
    }
    expect(source).not.toMatch(/\bgit\b/);
    expect(source).not.toMatch(/\.kill\([^,]+,\s*0\s*\)/);
    expect(source).not.toMatch(/unlink(?:Sync)?\([^)]*lockPath|rm(?:Sync)?\([^)]*lockPath/);
  });
});

describe("Rule (b): --no-fork holder identity, atomic fencing epoch, and post-ready failure cleanup", () => {
  test("P2 gap-1: default flock forks two PIDs whose lock survives SIGKILL(flock), while --no-fork keeps one PID", async () => {
    const lockDefault = path.join(scratchRoot, "gap1-default.lock");
    const fifoDefault = path.join(scratchRoot, "gap1-default.fifo");
    const lockNoFork = path.join(scratchRoot, "gap1-nofork.lock");
    const fifoNoFork = path.join(scratchRoot, "gap1-nofork.fifo");

    execFileSync("mkfifo", [fifoDefault]);
    execFileSync("mkfifo", [fifoNoFork]);

    const writerDefault = suiteTracker.trackChild(
      spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoDefault], {
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );

    const flockDefault = suiteTracker.trackChild(
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

    assert.ok(flockDefault.child.stdout);
    const innerPidDefault = Number(await readFirstLine(flockDefault.child.stdout));
    const innerStartTime = readProcessStat(innerPidDefault)?.startTime ?? null;
    assert.ok(innerStartTime !== null);
    suiteTracker.trackExternal(innerPidDefault, innerStartTime, "orphaned-inner-holder");
    expect(flockDefault.pid).not.toBe(innerPidDefault);

    await flockDefault.ensureStopped();

    expect(isSameProcessAlive(innerPidDefault, innerStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(lockDefault)).toBe(false);

    writerDefault.child.stdin?.end();
    await writerDefault.exited;
    await waitForKernelLockRelease(lockDefault, 5, suiteTracker);
    expect(suiteTracker.retireExternalIfDead(innerPidDefault, innerStartTime)).toBe(true);

    // With --no-fork: single PID, SIGKILL releases the lock immediately even while pipe stays open.
    const writerNoFork = suiteTracker.trackChild(
      spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoNoFork], {
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );
    const flockNoFork = suiteTracker.trackChild(
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

    assert.ok(flockNoFork.child.stdout);
    const innerPidNoFork = Number(await readFirstLine(flockNoFork.child.stdout));
    expect(flockNoFork.pid).toBe(innerPidNoFork);

    await flockNoFork.ensureStopped();
    expect(isLockFreeNonBlocking(lockNoFork)).toBe(true);

    writerNoFork.child.stdin?.end();
    await writerNoFork.exited;
  });

  test("acquireLease holderPid is the lock holder itself (SIGKILL on holderPid immediately frees owner.lock)", async () => {
    const stateRoot = path.join(scratchRoot, "nofork-direct");
    const projectKey = "b101010101010101";
    const lockPath = path.join(stateRoot, "owner.lock");

    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "direct-holder");
    expect(isLockFreeNonBlocking(lockPath)).toBe(false);

    process.kill(lease.holderPid, "SIGKILL");
    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    expect(isLockFreeNonBlocking(lockPath)).toBe(true);
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    await lease.release();
  });

  test("P2 check-2: SIGKILL owner closes pipe, holder exits, kernel lock releases, new owner acquires epoch 2", async () => {
    const stateRoot = path.join(scratchRoot, "check2");
    const projectKey = "0202020202020202";
    const lockPath = path.join(stateRoot, "owner.lock");

    const owner1 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired1 = await owner1.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    assert.ok(typeof owner1.pid === "number");
    const owner1Start = readProcessStat(owner1.pid)?.startTime;
    assert.ok(owner1Start);
    expect(isSameProcessAlive(owner1.pid, owner1Start)).toBe(true);
    const holder1Pid = acquired1.holderPid as number;
    const holder1Start = acquired1.holderStartTime as string;
    expect(isSameProcessAlive(holder1Pid, holder1Start)).toBe(true);

    process.kill(owner1.pid, "SIGKILL");
    const exit1 = await owner1.exited;
    expect(exit1.signal).toBe("SIGKILL");

    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    expect(suiteTracker.retireExternalIfDead(holder1Pid, holder1Start)).toBe(true);

    const owner2 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired2 = await owner2.nextEvent();
    expect(acquired2.event).toBe("acquired");
    expect(acquired2.epoch).toBe(2);
    expect(acquired2.holderPid).not.toBe(holder1Pid);

    const diskOwner = readOwnerRecord(stateRoot);
    expect(diskOwner?.epoch).toBe(2);
    expect(diskOwner?.pid).toBe(owner2.pid);
    expect(diskOwner?.holderPid).toBe(acquired2.holderPid);

    const attempt3 = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(attempt3.event.code).toBe("owner_conflict");
    expect(attempt3.exit.code).toBe(2);

    const exit2 = await owner2.releaseAndWait();
    expect(exit2.code).toBe(0);
    expect(
      suiteTracker.retireExternalIfDead(
        acquired2.holderPid as number,
        acquired2.holderStartTime as string,
      ),
    ).toBe(true);
  });

  test("failure to read, check, or write owner.json after ready line closes stdin, awaits holder exit, and frees owner.lock", async () => {
    const projectKey = "b202020202020202";

    // Helper that observes the real spawned holder's PID & startTime right after ready line
    // and asserts acquireLease awaited that exact holder's exit before throwing.
    const expectAcquireRejectsAndAwaitsHolderExit = async (
      stateRoot: string,
      checkRejection: (err: unknown) => void,
      overrideStat?: string | Error,
    ): Promise<void> => {
      let observedHolderPid: number | null = null;
      let observedHolderStart: string | null = null;
      const origReadFileSync = fs.readFileSync.bind(fs);
      const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
        const filePath = String(args[0]);
        const match = filePath.match(/^\/proc\/(\d+)\/stat$/);
        if (match && observedHolderPid === null) {
          const pid = Number(match[1]);
          const realStat = origReadFileSync(filePath, "utf8");
          const closeParen = realStat.lastIndexOf(")");
          const fields = realStat.slice(closeParen + 2).trim().split(/\s+/);
          observedHolderPid = pid;
          observedHolderStart = fields[19] ?? null;
          if (overrideStat instanceof Error) {
            throw overrideStat;
          }
          if (typeof overrideStat === "string") {
            return overrideStat;
          }
          return realStat;
        }
        return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
      }) as typeof fs.readFileSync);

      let caught: unknown = undefined;
      let threw = false;
      try {
        await acquireLease({ projectKey, stateRoot });
      } catch (err) {
        threw = true;
        caught = err;
      } finally {
        spy.mockRestore();
        if (observedHolderPid !== null && observedHolderStart !== null) {
          suiteTracker.trackExternal(observedHolderPid, observedHolderStart, "post-ready-holder");
        }
      }

      expect(threw).toBe(true);
      checkRejection(caught);
      assert.ok(observedHolderPid !== null && observedHolderStart !== null);
      expect(suiteTracker.retireExternalIfDead(observedHolderPid, observedHolderStart)).toBe(true);
      expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
      expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
    };

    // 1. Read failure: owner.json is a directory (EISDIR).
    {
      const stateRoot = path.join(scratchRoot, "post-ready-eisdir");
      fs.mkdirSync(path.join(stateRoot, "owner.json"), { recursive: true });
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(Error);
      });
    }

    // 2. Read failure: malformed owner.json.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-malformed");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(path.join(stateRoot, "owner.json"), "{not-json", "utf8");
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 3. Check failure: projectKey mismatch in owner.json.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-key-mismatch");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey: "ffffffffffffffff",
          epoch: 1,
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 4. Check failure (weakness 2): non-safe-integer or invalid epochs fail closed in both readOwnerRecord and acquireLease.
    const badEpochs: unknown[] = [
      Number.MAX_SAFE_INTEGER + 1,
      1e20,
      1.5,
      0,
      -1,
      "1",
      null,
    ];
    for (let i = 0; i < badEpochs.length; i += 1) {
      const stateRoot = path.join(scratchRoot, `post-ready-bad-epoch-${i}`);
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey,
          epoch: badEpochs[i],
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(() => readOwnerRecord(stateRoot)).toThrow(LeaseError);
      try {
        readOwnerRecord(stateRoot);
      } catch (err) {
        expect((err as LeaseError).code).toBe("identity_mismatch");
      }
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 5. Check failure (weakness 2 overflow): epoch === Number.MAX_SAFE_INTEGER cannot safely increment.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-max-safe-epoch");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey,
          epoch: Number.MAX_SAFE_INTEGER,
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(readOwnerRecord(stateRoot)?.epoch).toBe(Number.MAX_SAFE_INTEGER);
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 6. Check failure (weakness 1 at acquire): truncated /proc/<holderPid>/stat (missing starttime) fails closed and frees lock.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-missing-starttime");
      await expectAcquireRejectsAndAwaitsHolderExit(
        stateRoot,
        (err) => {
          expect(err).toBeInstanceOf(LeaseError);
          expect((err as LeaseError).code).toBe("lease_acquire_error");
          expect((err as LeaseError).message).toMatch(/verify live holder identity/);
        },
        "99999 (cat) S 1 1 1\n",
      );
    }

    // 7. Write failure: injected renameSync error after ready line cleans temp file, awaits holder exit, and frees lock.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-write-rename-fail");
      fs.mkdirSync(stateRoot, { recursive: true });
      const origRename = fs.renameSync.bind(fs);
      const renameSpy = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        if (String(newPath) === path.join(stateRoot, "owner.json")) {
          const eio = Object.assign(new Error("forced EIO on owner.json rename"), { code: "EIO" });
          throw eio;
        }
        return origRename(oldPath, newPath);
      });
      try {
        await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(/forced EIO/);
        });
      } finally {
        renameSpy.mockRestore();
      }
      const leftoverTemps = fs
        .readdirSync(stateRoot)
        .filter((name) => name.startsWith(".owner.json.tmp."));
      expect(leftoverTemps).toEqual([]);
    }

    // 8. Write failure on read-only stateRoot (non-root): pre-created owner.lock succeeds, owner.json write fails EACCES.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const stateRoot = path.join(scratchRoot, "post-ready-readonly-dir");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(path.join(stateRoot, "owner.lock"), "", "utf8");
      fs.chmodSync(stateRoot, 0o555);
      try {
        await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
          expect(err).toBeInstanceOf(Error);
        });
      } finally {
        fs.chmodSync(stateRoot, 0o755);
      }
    }
  });

  test("P2 ctrl-5a (Part 2): /proc stat failure after ready line closes stdin, awaits holder exit, and frees owner.lock", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl5a-lease");
    const projectKey = "0505050505050502";
    const lockPath = path.join(stateRoot, "owner.lock");

    let observedHolderPid: number | null = null;
    let observedHolderStart: string | null = null;
    const origReadFileSync = fs.readFileSync.bind(fs);

    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      const filePath = String(args[0]);
      const match = filePath.match(/^\/proc\/(\d+)\/stat$/);
      if (match && observedHolderPid === null) {
        const pid = Number(match[1]);
        const realStat = origReadFileSync(filePath, "utf8");
        const closeParen = realStat.lastIndexOf(")");
        const fields = realStat.slice(closeParen + 2).trim().split(/\s+/);
        observedHolderPid = pid;
        observedHolderStart = fields[19] ?? null;
        throw Object.assign(new Error("forced_post_acquire_readProcessStat_error"), {
          code: "EACCES",
        });
      }
      return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);

    try {
      await expect(acquireLease({ projectKey, stateRoot })).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_acquire_error",
        message: "Failed to read holder /proc stat",
        details: { cause: "forced_post_acquire_readProcessStat_error" },
      });
    } finally {
      spy.mockRestore();
      if (observedHolderPid !== null && observedHolderStart !== null) {
        suiteTracker.trackExternal(observedHolderPid, observedHolderStart, "ctrl5a-holder");
      }
    }

    assert.ok(observedHolderPid !== null && observedHolderStart !== null);
    expect(suiteTracker.retireExternalIfDead(observedHolderPid, observedHolderStart)).toBe(true);
    expect(isLockFreeNonBlocking(lockPath)).toBe(true);
    expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
  });

  test("returned lease.ownerRecord is immutable so external mutation cannot corrupt localEpoch", async () => {
    const stateRoot = path.join(scratchRoot, "frozen-record");
    const projectKey = "b303030303030303";
    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "frozen-holder");

    expect(Object.isFrozen(lease.ownerRecord)).toBe(true);
    expect(() => {
      (lease.ownerRecord as { epoch: number }).epoch = 999;
    }).toThrow(TypeError);
    expect(lease.ownerRecord.epoch).toBe(1);
    lease.assertValid();

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });
});

describe("Rule (c): serialized queue, synchronous /proc liveness, and fail-closed checks", () => {
  test("readProcessStat and isSameProcessAlive fail closed on Z, X, x, changed starttime, missing starttime, and unreadable /proc", () => {
    // Real live current process.
    const selfStat = readProcessStat(process.pid);
    assert.ok(selfStat !== null);
    expect(isSameProcessAlive(process.pid, selfStat.startTime)).toBe(true);

    // Invalid pids and missing/malformed expectedStartTime fail closed.
    expect(readProcessStat(0)).toBeNull();
    expect(readProcessStat(-1)).toBeNull();
    expect(readProcessStat(1.5)).toBeNull();
    expect(readProcessStat(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(isSameProcessAlive(process.pid, "")).toBe(false);
    expect(isSameProcessAlive(process.pid, null)).toBe(false);
    expect(isSameProcessAlive(process.pid, undefined)).toBe(false);
    expect(isSameProcessAlive(process.pid, "not-a-number")).toBe(false);
    expect(isSameProcessAlive(process.pid, `${selfStat.startTime}9`)).toBe(false);

    // Inject /proc/<fakePid>/stat edge cases via fs.readFileSync spy.
    const fakePid = 424242;
    const origReadFileSync = fs.readFileSync.bind(fs);
    let injectedStat: string | Error = makeStatLine(fakePid, "my ) (proc)", "S", "77777");
    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === `/proc/${fakePid}/stat`) {
        if (injectedStat instanceof Error) {
          throw injectedStat;
        }
        return injectedStat;
      }
      return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);

    try {
      // Tricky (comm) containing spaces and parentheses parses cleanly.
      expect(readProcessStat(fakePid)).toEqual({ state: "S", startTime: "77777" });
      expect(isSameProcessAlive(fakePid, "77777")).toBe(true);

      // Dead states Z, X, and x all fail closed.
      for (const deadState of ["Z", "X", "x"]) {
        injectedStat = makeStatLine(fakePid, "cat", deadState, "77777");
        expect(isSameProcessAlive(fakePid, "77777")).toBe(false);
      }

      // Changed starttime (PID reuse) fails closed.
      injectedStat = makeStatLine(fakePid, "cat", "S", "88888");
      expect(isSameProcessAlive(fakePid, "77777")).toBe(false);

      // Truncated stat / missing starttime fails closed.
      injectedStat = `${fakePid} (cat) S 1 1 1\n`;
      expect(readProcessStat(fakePid)).toBeNull();
      expect(isSameProcessAlive(fakePid, "77777")).toBe(false);

      // Non-numeric starttime fails closed.
      injectedStat = makeStatLine(fakePid, "cat", "S", "NaN");
      expect(readProcessStat(fakePid)).toBeNull();
      expect(isSameProcessAlive(fakePid, "NaN")).toBe(false);

      // Unreadable /proc (EACCES, EPERM, ENOTDIR): readProcessStat throws, isSameProcessAlive returns false.
      for (const code of ["EACCES", "EPERM", "ENOTDIR"]) {
        injectedStat = Object.assign(new Error(`forced ${code}`), { code });
        expect(() => readProcessStat(fakePid)).toThrow(new RegExp(`forced ${code}`));
        expect(isSameProcessAlive(fakePid, "77777")).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("FIFO serialization executes queued steps strictly one at a time", async () => {
    const stateRoot = path.join(scratchRoot, "fifo");
    const lease = await acquireLease({ projectKey: "c101010101010101", stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "fifo-holder");

    const gate = createDeferred();
    const trace: string[] = [];

    const pA = lease.enqueue({
      write: async () => {
        trace.push("A:write");
        await gate.promise;
        return "a";
      },
      effect: (val) => {
        trace.push(`A:effect:${val}`);
      },
    });
    const pB = lease.enqueue({
      write: () => {
        trace.push("B:write");
        return "b";
      },
      effect: (val) => {
        trace.push(`B:effect:${val}`);
      },
    });

    gate.resolve();
    await Promise.all([pA, pB]);
    expect(trace).toEqual(["A:write", "A:effect:a", "B:write", "B:effect:b"]);

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });

  test("P2 check-4 (Sub-proof B): real unreaped zombie holder caught synchronously before exit callback runs", async () => {
    const stateRoot = path.join(scratchRoot, "check4-zombie");
    const lease = await acquireLease({ projectKey: "0404040404040405", stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "zombie-holder");

    const proof = await verifyUnreapedZombiePreEffect(lease, stateRoot);
    expect(proof).toEqual({
      sawRevokedFalseBeforePreEffect: true,
      sawZombieState: true,
      sawKillZeroOnZombie: true,
    });

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });

  test("states Z, X, x, changed starttime, missing starttime, and unreadable /proc fail closed before write and before effect", async () => {
    const scenarios: Array<{
      name: string;
      buildResult: (pid: number, realStart: string) => string | Error;
    }> = [
      { name: "state-Z", buildResult: (pid, s) => makeStatLine(pid, "cat", "Z", s) },
      { name: "state-X", buildResult: (pid, s) => makeStatLine(pid, "cat", "X", s) },
      { name: "state-x", buildResult: (pid, s) => makeStatLine(pid, "cat", "x", s) },
      {
        name: "changed-starttime",
        buildResult: (pid, s) => makeStatLine(pid, "cat", "S", `${s}9`),
      },
      {
        name: "missing-starttime",
        buildResult: (pid) => `${pid} (cat) S 1 1 1\n`,
      },
      {
        name: "unreadable-proc",
        buildResult: () => Object.assign(new Error("forced EACCES on /proc"), { code: "EACCES" }),
      },
    ];

    const origReadFileSync = fs.readFileSync.bind(fs);

    for (const scenario of scenarios) {
      // Sub-case 1: fault active right before write -> neither write nor effect runs.
      {
        const stateRoot = path.join(scratchRoot, `liveness-prewrite-${scenario.name}`);
        const lease = await acquireLease({
          projectKey: `c2${scenario.name}`,
          stateRoot,
        });
        suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, `holder-${scenario.name}`);
        const targetPath = `/proc/${lease.holderPid}/stat`;
        const injected = scenario.buildResult(lease.holderPid, lease.holderStartTime);
        let writeRan = false;
        let effectRan = false;

        const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
          if (args[0] === targetPath) {
            if (injected instanceof Error) {
              throw injected;
            }
            return injected;
          }
          return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof fs.readFileSync);

        try {
          await expect(
            lease.enqueue({
              write: () => {
                writeRan = true;
              },
              effect: () => {
                effectRan = true;
              },
            }),
          ).rejects.toMatchObject({
            name: "LeaseError",
            code: "lease_revoked",
            message: expect.stringContaining("no longer alive"),
          });
        } finally {
          spy.mockRestore();
        }

        expect(writeRan).toBe(false);
        expect(effectRan).toBe(false);
        expect(lease.isRevoked()).toBe(true);
        await lease.release();
        expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
      }

      // Sub-case 2: fault injected inside write (right before effect) -> write ran, effect does NOT run.
      {
        const stateRoot = path.join(scratchRoot, `liveness-preeffect-${scenario.name}`);
        const lease = await acquireLease({
          projectKey: `c3${scenario.name}`,
          stateRoot,
        });
        suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, `holder-e-${scenario.name}`);
        const targetPath = `/proc/${lease.holderPid}/stat`;
        const injected = scenario.buildResult(lease.holderPid, lease.holderStartTime);
        let faultActive = false;
        let writeRan = false;
        let effectRan = false;

        const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
          if (faultActive && args[0] === targetPath) {
            if (injected instanceof Error) {
              throw injected;
            }
            return injected;
          }
          return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof fs.readFileSync);

        try {
          await expect(
            lease.enqueue({
              write: () => {
                writeRan = true;
                faultActive = true;
              },
              effect: () => {
                effectRan = true;
              },
            }),
          ).rejects.toMatchObject({
            name: "LeaseError",
            code: "lease_revoked",
            message: expect.stringContaining("no longer alive"),
          });
        } finally {
          spy.mockRestore();
        }

        expect(writeRan).toBe(true);
        expect(effectRan).toBe(false);
        expect(lease.isRevoked()).toBe(true);
        await lease.release();
        expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
      }
    }
  });

  test("P2 check-4 (Sub-proofs C1 & C2) + weakness 2: epoch drift and non-safe-integer owner.json block pre-effect and pre-write", async () => {
    // C1: epoch drift between write and effect blocks effect.
    {
      const stateRoot = path.join(scratchRoot, "check4-epoch-effect");
      const okFile = path.join(stateRoot, "authorized-write.ok");
      const marker = path.join(stateRoot, "forbidden-effect.marker");
      const lease = await acquireLease({ projectKey: "0404040404040406", stateRoot });
      suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "epoch-effect-holder");

      await expect(
        lease.enqueue({
          write: () => {
            fs.writeFileSync(okFile, `epoch=${lease.epoch}\n`, "utf8");
            const current = readOwnerRecord(stateRoot);
            assert.ok(current !== null);
            fs.writeFileSync(
              path.join(stateRoot, "owner.json"),
              `${JSON.stringify({ ...current, epoch: lease.epoch + 1 }, null, 2)}\n`,
              "utf8",
            );
          },
          effect: () => {
            fs.writeFileSync(marker, "should-not-effect\n", "utf8");
          },
        }),
      ).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_revoked",
        message: expect.stringContaining("epoch mismatch"),
      });
      expect(fs.existsSync(okFile)).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(lease.isRevoked()).toBe(true);
      await lease.release();
      expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    }

    // C2: epoch drift before write blocks both write and effect.
    {
      const stateRoot = path.join(scratchRoot, "check4-epoch-write");
      const marker = path.join(stateRoot, "forbidden-write.marker");
      const lease = await acquireLease({ projectKey: "0404040404040407", stateRoot });
      suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "epoch-write-holder");

      const current = readOwnerRecord(stateRoot);
      assert.ok(current !== null);
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        `${JSON.stringify({ ...current, epoch: lease.epoch + 1 }, null, 2)}\n`,
        "utf8",
      );

      await expect(
        lease.enqueue({
          write: () => fs.writeFileSync(marker, "should-not-write\n", "utf8"),
          effect: () => fs.writeFileSync(marker, "should-not-effect\n", "utf8"),
        }),
      ).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_revoked",
        message: expect.stringContaining("epoch mismatch"),
      });
      expect(fs.existsSync(marker)).toBe(false);
      expect(lease.isRevoked()).toBe(true);
      await lease.release();
      expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    }

    // Weakness 2 during active lease: non-safe-integer epoch on disk fails closed and revokes lease.
    {
      const stateRoot = path.join(scratchRoot, "active-unsafe-epoch");
      const lease = await acquireLease({ projectKey: "0404040404040408", stateRoot });
      suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "unsafe-epoch-holder");
      const current = readOwnerRecord(stateRoot);
      assert.ok(current !== null);

      let effectRan = false;
      let queuedWriteRan = false;
      const p0 = lease.enqueue({
        write: () => {
          fs.writeFileSync(
            path.join(stateRoot, "owner.json"),
            `${JSON.stringify({ ...current, epoch: Number.MAX_SAFE_INTEGER + 1 }, null, 2)}\n`,
            "utf8",
          );
        },
        effect: () => {
          effectRan = true;
        },
      });
      const p1 = lease.enqueue({
        write: () => {
          queuedWriteRan = true;
        },
      });

      await expect(p0).rejects.toMatchObject({
        name: "LeaseError",
        code: "identity_mismatch",
      });
      await expect(p1).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_revoked",
      });
      expect(effectRan).toBe(false);
      expect(queuedWriteRan).toBe(false);
      expect(lease.isRevoked()).toBe(true);
      await lease.release();
      expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    }
  });
});

describe("Rule (d): controlled revocation drain, SIGKILL fallback, and unexpected holder exit", () => {
  test("P2 check-4 (main): controlled revocation sets revoked first, keeps lock held during drain, fails queued items, and resolves after holder exit", async () => {
    const stateRoot = path.join(scratchRoot, "check4-main");
    const projectKey = "0404040404040404";
    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "check4-holder");

    const { trace } = await verifyControlledRevocationDrain(lease, {
      stateRoot,
      projectKey,
      tracker: suiteTracker,
    });
    expect(trace).toEqual([
      "item0:write",
      "revoke:flag_set",
      "during_drain:lock_still_held",
      "revoke:drained_and_holder_exited",
    ]);
  });

  test("weakness 3: revocation while queued effect callback is awaited blocks every write and effect behind it", async () => {
    const stateRoot = path.join(scratchRoot, "revoke-during-effect");
    const projectKey = "d101010101010101";
    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "revoke-effect-holder");

    const effectEntered = createDeferred();
    const effectRelease = createDeferred();
    let queuedWriteRan = false;
    let queuedEffectRan = false;
    let writeOnlyRan = false;
    let effectOnlyRan = false;
    let postRevokeRan = false;

    const p0 = lease.enqueue({
      write: () => "written-before-revoke",
      effect: async () => {
        effectEntered.resolve();
        await effectRelease.promise;
        return "in-flight-effect-done";
      },
    });
    const p1 = lease.enqueue({
      write: () => {
        queuedWriteRan = true;
      },
      effect: () => {
        queuedEffectRan = true;
      },
    });
    const p2 = lease.enqueue({
      write: () => {
        writeOnlyRan = true;
      },
    });
    const p3 = lease.enqueue({
      effect: () => {
        effectOnlyRan = true;
      },
    });

    await effectEntered.promise;
    let revokeResolved = false;
    const revokePromise = lease.revoke().then(() => {
      revokeResolved = true;
    });

    const p4 = lease.enqueue({
      write: () => {
        postRevokeRan = true;
      },
      effect: () => {
        postRevokeRan = true;
      },
    });

    expect(lease.isRevoked()).toBe(true);
    expect(revokeResolved).toBe(false);

    // Lock must remain held while p0's in-flight effect is still awaited.
    const duringEffect = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(duringEffect.event.code).toBe("owner_conflict");
    expect(duringEffect.exit.code).toBe(2);
    expect(revokeResolved).toBe(false);

    effectRelease.resolve();
    const res0 = await p0;
    expect(res0).toEqual({
      writeResult: "written-before-revoke",
      effectResult: "in-flight-effect-done",
    });
    for (const queued of [p1, p2, p3, p4]) {
      await expect(queued).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_revoked",
      });
    }
    await revokePromise;

    expect(queuedWriteRan).toBe(false);
    expect(queuedEffectRan).toBe(false);
    expect(writeOnlyRan).toBe(false);
    expect(effectOnlyRan).toBe(false);
    expect(postRevokeRan).toBe(false);
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
  });

  test("weakness 3: synchronous revocation right after enqueue on idle queue writes nothing and runs no effect", async () => {
    const stateRoot = path.join(scratchRoot, "revoke-idle-sync");
    const lease = await acquireLease({ projectKey: "d202020202020202", stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "idle-revoke-holder");

    let writeRan = false;
    let effectRan = false;
    const step = lease.enqueue({
      write: () => {
        writeRan = true;
      },
      effect: () => {
        effectRan = true;
      },
    });
    const revokePromise = lease.revoke();

    await expect(step).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
    });
    await revokePromise;
    expect(writeRan).toBe(false);
    expect(effectRan).toBe(false);
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });

  test("controlled revocation kills a holder that ignores closed stdin within bounded releaseTimeoutMs", async () => {
    const realFlock = execFileSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).trim();
    const fakeBin = path.join(scratchRoot, "stubborn-flock-bin");
    const stateRoot = path.join(scratchRoot, "stubborn-holder");
    const lockPath = path.join(stateRoot, "owner.lock");

    // Uses real flock --no-fork to hold owner.lock, but runs `sleep 60` so closing stdin does NOT exit.
    makeFakeFlockScript(
      fakeBin,
      `exec ${JSON.stringify(realFlock)} --exclusive --nonblocking --no-fork --conflict-exit-code 200 ${JSON.stringify(lockPath)} sh -c 'printf "ready\\n"; exec sleep 60 >/dev/null 2>&1'`,
    );

    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${fakeBin}:${originalPath}`;
    let lease: OwnerLease;
    try {
      lease = await acquireLease({
        projectKey: "d303030303030303",
        stateRoot,
        releaseTimeoutMs: 150,
      });
    } finally {
      process.env.PATH = originalPath;
    }
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "stubborn-holder");
    expect(isLockFreeNonBlocking(lockPath)).toBe(false);

    const start = performance.now();
    await lease.revoke();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(1500);
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(lockPath)).toBe(true);
  });

  test("unexpected holder exit (Order 1 — no exit callback yet): liveness check blocks effect and every queued item behind it", async () => {
    const stateRoot = path.join(scratchRoot, "unexpected-exit-order1");
    const lockPath = path.join(stateRoot, "owner.lock");
    const lease = await acquireLease({ projectKey: "d404040404040404", stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "order1-holder");

    let sawRevokedFalse = false;
    let sawZombie = false;
    let item0EffectRan = false;
    let item1WriteRan = false;
    let item1EffectRan = false;
    let item2WriteRan = false;
    let item2EffectRan = false;

    const p0 = lease.enqueue({
      write: () => {
        process.kill(lease.holderPid, "SIGKILL");
        const waitRes = spawnSync("flock", ["--exclusive", "--timeout", "5", lockPath, "true"]);
        assert.equal(waitRes.status, 0);
        let stat = readProcessStat(lease.holderPid);
        const deadline = performance.now() + 500;
        while (stat !== null && stat.state !== "Z" && performance.now() < deadline) {
          stat = readProcessStat(lease.holderPid);
        }
        sawRevokedFalse = lease.isRevoked() === false;
        sawZombie = stat !== null && stat.state === "Z";
      },
      effect: () => {
        item0EffectRan = true;
      },
    });
    const p1 = lease.enqueue({
      write: () => {
        item1WriteRan = true;
      },
      effect: () => {
        item1EffectRan = true;
      },
    });
    const p2 = lease.enqueue({
      write: () => {
        item2WriteRan = true;
      },
      effect: () => {
        item2EffectRan = true;
      },
    });

    await expect(p0).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
      message: expect.stringContaining("no longer alive"),
    });
    await expect(p1).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
    });
    await expect(p2).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
    });

    expect(sawRevokedFalse).toBe(true);
    expect(sawZombie).toBe(true);
    expect(item0EffectRan).toBe(false);
    expect(item1WriteRan).toBe(false);
    expect(item1EffectRan).toBe(false);
    expect(item2WriteRan).toBe(false);
    expect(item2EffectRan).toBe(false);
    expect(lease.isRevoked()).toBe(true);

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });

  test("unexpected holder exit (Order 2 — exit handler runs first while callback is awaited): revoked guard blocks effect and every queued item", async () => {
    const stateRoot = path.join(scratchRoot, "unexpected-exit-order2");
    const lockPath = path.join(stateRoot, "owner.lock");
    const lease = await acquireLease({ projectKey: "d505050505050505", stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "order2-holder");

    const writeEntered = createDeferred();
    const writeRelease = createDeferred();
    let item0EffectRan = false;
    let item1WriteRan = false;
    let item1EffectRan = false;
    let item2WriteRan = false;
    let item2EffectRan = false;

    const p0 = lease.enqueue({
      write: async () => {
        writeEntered.resolve();
        await writeRelease.promise;
        return "w0";
      },
      effect: () => {
        item0EffectRan = true;
      },
    });
    const p1 = lease.enqueue({
      write: () => {
        item1WriteRan = true;
      },
      effect: () => {
        item1EffectRan = true;
      },
    });
    const p2 = lease.enqueue({
      write: () => {
        item2WriteRan = true;
      },
      effect: () => {
        item2EffectRan = true;
      },
    });

    await writeEntered.promise;

    // Kill holder while p0's write callback is awaited, and wait for the exit handler to set revoked=true FIRST.
    process.kill(lease.holderPid, "SIGKILL");
    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    await waitUntilCondition(() => lease.isRevoked() === true, 2000, "exit handler setting revoked=true");

    expect(lease.isRevoked()).toBe(true);
    // Registry entry stays registered until the in-flight queue drains so reloads await drain.
    expect(getGlobalLeaseRegistry().has("d505050505050505")).toBe(true);
    writeRelease.resolve();

    // Order 2 hits the `if (revoked)` guard ("Owner lease has been revoked"), NOT the liveness check ("no longer alive").
    await expect(p0).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
      message: "Owner lease has been revoked",
    });
    await expect(p1).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
      message: "Owner lease has been revoked",
    });
    await expect(p2).rejects.toMatchObject({
      name: "LeaseError",
      code: "lease_revoked",
      message: "Owner lease has been revoked",
    });

    expect(item0EffectRan).toBe(false);
    expect(item1WriteRan).toBe(false);
    expect(item1EffectRan).toBe(false);
    expect(item2WriteRan).toBe(false);
    expect(item2EffectRan).toBe(false);
    await waitUntilCondition(
      () => !getGlobalLeaseRegistry().has("d505050505050505"),
      2000,
      "exit handler removing registry entry after drain",
    );

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });

  test("P2 gap-3: awaiting holder exit on close yields 0/40 owner_conflict with zero sleeps", async () => {
    const lockPath = path.join(scratchRoot, "gap3.lock");
    const rounds = 40;

    const acquireRaw = (): Promise<ReturnType<ProcessTracker["trackChild"]>> =>
      new Promise((resolve, reject) => {
        const handle = suiteTracker.trackChild(
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
        handle.child.stdin?.on("error", () => {});
        let settled = false;
        let buf = "";
        handle.child.stdout?.on("data", (chunk: Buffer | string) => {
          if (settled) {
            return;
          }
          buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
          if (buf.includes("\n")) {
            settled = true;
            resolve(handle);
          }
        });
        void handle.exited.then(({ code, signal }) => {
          if (!settled) {
            settled = true;
            reject(
              new Error(
                code === CONFLICT_EXIT_CODE ? "owner_conflict" : `exit=${code} sig=${signal}`,
              ),
            );
          }
        });
      });

    // Awaited arm: must observe 0/40 owner_conflict with zero sleeps.
    let conflictsWithAwait = 0;
    let current = await acquireRaw();
    for (let i = 0; i < rounds; i += 1) {
      current.child.stdin?.end();
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
    current.child.stdin?.end();
    await current.exited;
    expect(conflictsWithAwait).toBe(0);

    // Also verify acquireLease + release back-to-back handoffs: 0/20 conflicts, epoch 1 -> 20.
    const stateRoot = path.join(scratchRoot, "gap3-lease");
    for (let round = 1; round <= 20; round += 1) {
      const lease = await acquireLease({ projectKey: "d606060606060606", stateRoot });
      suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "gap3-holder");
      expect(lease.epoch).toBe(round);
      await lease.release();
      expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    }
  });
});

describe("Rule (e): process-global reload cleanup and compare-and-delete", () => {
  async function loadFreshLeaseModule(
    moduleDir: string,
    generation: number,
  ): Promise<typeof import("../src/lease.ts")> {
    const targetPath = path.join(moduleDir, `lease-instance-${generation}.ts`);
    fs.copyFileSync(LEASE_SOURCE_PATH, targetPath);
    return (await import(pathToFileURL(targetPath).href)) as typeof import("../src/lease.ts");
  }

  test("P2 check-3: simulated reload across distinct module instances hands off 12 times via globalThis registry", async () => {
    const stateRoot = path.join(scratchRoot, "check3");
    const moduleDir = path.join(scratchRoot, "check3-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    const projectKey = "0303030303030303";

    const mod1 = await loadFreshLeaseModule(moduleDir, 1);
    const mod2 = await loadFreshLeaseModule(moduleDir, 2);
    expect(mod1).not.toBe(mod2);
    expect(mod1.MODULE_INSTANCE_ID).not.toBe(mod2.MODULE_INSTANCE_ID);
    expect(mod1.MODULE_INSTANCE_ID).not.toBe(MODULE_INSTANCE_ID);
    expect(mod1.LeaseError).not.toBe(mod2.LeaseError);
    expect(mod1.REGISTRY_SYMBOL).toBe(mod2.REGISTRY_SYMBOL);
    expect(mod1.REGISTRY_SYMBOL).toBe(REGISTRY_SYMBOL);

    let activeLease = await mod1.acquireLease({ projectKey, stateRoot });
    const lease1 = activeLease;
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "reload-holder-1");
    expect(lease1.epoch).toBe(1);

    const registry = getGlobalLeaseRegistry();
    expect(registry.get(projectKey)?.holderPid).toBe(lease1.holderPid);

    const conflictBefore = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(conflictBefore.event.code).toBe("owner_conflict");
    expect(conflictBefore.exit.code).toBe(2);

    // Reload: acquire from second module instance without releasing lease1 first.
    activeLease = await verifyReloadHandoffStep({
      lease1,
      acquireNext: () => mod2.acquireLease({ projectKey, stateRoot }),
      stateRoot,
      projectKey,
      tracker: suiteTracker,
    });

    // Stale lease1 must fail closed and write nothing.
    const staleMarker = path.join(stateRoot, "stale-reload-write.marker");
    await assert.rejects(
      () =>
        lease1.enqueue({
          write: () => fs.writeFileSync(staleMarker, "stale"),
          effect: () => fs.writeFileSync(staleMarker, "stale"),
        }),
      (err: unknown) => err instanceof mod1.LeaseError && err.code === "lease_revoked",
    );
    expect(fs.existsSync(staleMarker)).toBe(false);

    const conflictAfter = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(conflictAfter.event.code).toBe("owner_conflict");
    expect(conflictAfter.exit.code).toBe(2);

    // Back-to-back simulated reloads 3..12 with zero sleeps.
    for (let round = 3; round <= 12; round += 1) {
      const nextMod = await loadFreshLeaseModule(moduleDir, round);
      expect(nextMod.MODULE_INSTANCE_ID).not.toBe(activeLease.moduleInstanceId);
      activeLease = await verifyReloadHandoffStep({
        lease1: activeLease,
        acquireNext: () => nextMod.acquireLease({ projectKey, stateRoot }),
        stateRoot,
        projectKey,
        tracker: suiteTracker,
      });
      expect(activeLease.epoch).toBe(round);
    }

    const diskOwner = readOwnerRecord(stateRoot);
    expect(diskOwner?.epoch).toBe(12);
    expect(diskOwner?.holderPid).toBe(activeLease.holderPid);

    const finalPid = activeLease.holderPid;
    const finalStart = activeLease.holderStartTime;
    await activeLease.release();
    expect(suiteTracker.retireExternalIfDead(finalPid, finalStart)).toBe(true);
    expect(registry.has(projectKey)).toBe(false);

    const externalAfter = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(externalAfter.exit.code).toBe(0);
    expect(externalAfter.event.event).toBe("acquired");
    expect(externalAfter.event.epoch).toBe(13);
  });

  test("reload while queued work is in flight awaits old drain and holder exit before acquiring", async () => {
    const stateRoot = path.join(scratchRoot, "reload-inflight");
    const moduleDir = path.join(scratchRoot, "reload-inflight-mods");
    fs.mkdirSync(moduleDir, { recursive: true });
    const projectKey = "e101010101010101";

    const mod1 = await loadFreshLeaseModule(moduleDir, 1);
    const mod2 = await loadFreshLeaseModule(moduleDir, 2);

    const lease1 = await mod1.acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "inflight-holder-1");

    const entered = createDeferred();
    const releaseWrite = createDeferred();
    let p0EffectRan = false;
    let p1WriteRan = false;
    let p1EffectRan = false;

    const p0 = lease1.enqueue({
      write: async () => {
        entered.resolve();
        await releaseWrite.promise;
        return "old-write";
      },
      effect: () => {
        p0EffectRan = true;
      },
    });
    const p1 = lease1.enqueue({
      write: () => {
        p1WriteRan = true;
      },
      effect: () => {
        p1EffectRan = true;
      },
    });

    await entered.promise;

    let mod2Acquired = false;
    const mod2Promise = mod2.acquireLease({ projectKey, stateRoot }).then((l) => {
      mod2Acquired = true;
      return l;
    });

    // Reload must revoke lease1 immediately and wait for drain before acquiring.
    expect(lease1.isRevoked()).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mod2Acquired).toBe(false);
    expect(isSameProcessAlive(lease1.holderPid, lease1.holderStartTime)).toBe(true);

    releaseWrite.resolve();
    const lease2 = await mod2Promise;
    suiteTracker.trackExternal(lease2.holderPid, lease2.holderStartTime, "inflight-holder-2");

    await assert.rejects(
      () => p0,
      (err: unknown) => err instanceof mod1.LeaseError && err.code === "lease_revoked",
    );
    await assert.rejects(
      () => p1,
      (err: unknown) => err instanceof mod1.LeaseError && err.code === "lease_revoked",
    );

    expect(p0EffectRan).toBe(false);
    expect(p1WriteRan).toBe(false);
    expect(p1EffectRan).toBe(false);
    expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);
    expect(lease2.epoch).toBe(2);
    expect(getGlobalLeaseRegistry().get(projectKey)?.holderPid).toBe(lease2.holderPid);

    await lease2.release();
    expect(suiteTracker.retireExternalIfDead(lease2.holderPid, lease2.holderStartTime)).toBe(true);
  });

  test("late exit of old holder does not delete a newer global registry entry (compare-and-delete)", async () => {
    const stateRoot = path.join(scratchRoot, "compare-and-delete");
    const projectKey = "e202020202020202";
    const lockPath = path.join(stateRoot, "owner.lock");

    // Case A: old holder exits unexpectedly after a newer registry entry is installed.
    const lease1 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "cad-holder-1");
    const registry = getGlobalLeaseRegistry();
    const entry1 = registry.get(projectKey);
    assert.ok(entry1 !== undefined);

    const newerEntry: LeaseRegistryEntry = {
      projectKey,
      stateRoot,
      epoch: 2,
      holderPid: lease1.holderPid + 1,
      moduleInstanceId: "newer-module-sentinel",
      revokeAndClose: async () => {},
    };
    registry.set(projectKey, newerEntry);

    process.kill(lease1.holderPid, "SIGKILL");
    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    await waitUntilCondition(() => lease1.isRevoked() === true, 2000, "old holder exit callback");
    // Flush microtasks for drain + compare-and-delete.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registry.get(projectKey)).toBe(newerEntry);
    expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);

    // Case B: calling release() on old lease1 also compare-and-deletes without touching newerEntry.
    await lease1.release();
    expect(registry.get(projectKey)).toBe(newerEntry);
    registry.delete(projectKey);

    // Case C: when the registry still holds the exiting lease's own entry, unexpected exit DOES remove it.
    const ownProjectKey = "e303030303030303";
    const ownStateRoot = path.join(scratchRoot, "compare-and-delete-own");
    const leaseOwn = await acquireLease({ projectKey: ownProjectKey, stateRoot: ownStateRoot });
    suiteTracker.trackExternal(leaseOwn.holderPid, leaseOwn.holderStartTime, "cad-holder-own");
    expect(registry.get(ownProjectKey)?.holderPid).toBe(leaseOwn.holderPid);
    process.kill(leaseOwn.holderPid, "SIGKILL");
    await waitForKernelLockRelease(path.join(ownStateRoot, "owner.lock"), 5, suiteTracker);
    await waitUntilCondition(
      () => !registry.has(ownProjectKey),
      2000,
      "own entry compare-and-delete on unexpected exit",
    );
    expect(suiteTracker.retireExternalIfDead(leaseOwn.holderPid, leaseOwn.holderStartTime)).toBe(true);
    await leaseOwn.release();
  });
});

describe("Rule (f): post-acquisition child non-inheritance (/proc O_CLOEXEC and surviving child)", () => {
  test("P2 check-5: detached child inherits no holder descriptors and SIGKILL owner releases lock while child stays alive", async () => {
    const stateRoot = path.join(scratchRoot, "check5");
    const childPidFile = path.join(scratchRoot, "check5-child.json");
    const projectKey = "0505050505050505";
    const lockPath = path.join(stateRoot, "owner.lock");
    const childToken = `herdr-s1a-check5-${crypto.randomUUID()}`;
    suiteTracker.registerEnvToken("HERDR_S1A_CHILD_TOKEN", childToken);

    const owner1 = suiteTracker.spawnWorker(
      [
        "--mode",
        "hold-with-child",
        "--state-root",
        stateRoot,
        "--project-key",
        projectKey,
        "--child-pid-file",
        childPidFile,
      ],
      { HERDR_S1A_CHILD_TOKEN: childToken },
    );

    const spawnedEvt = await owner1.nextEvent();
    expect(spawnedEvt.event).toBe("child_spawned");
    const childPid = spawnedEvt.childPid as number;
    const childStartTime = spawnedEvt.childStartTime as string;

    const acquired1 = await owner1.nextEvent();
    expect(acquired1.event).toBe("acquired_with_child");
    expect(acquired1.epoch).toBe(1);
    expect(acquired1.childPid).toBe(childPid);
    expect(acquired1.childStartTime).toBe(childStartTime);

    const newParentFds = acquired1.newParentFds as FdInfo[];
    const childFds = acquired1.childFds as FdInfo[];

    const ioFds = newParentFds.filter(
      (f) => f.target.startsWith("socket:") || f.target.startsWith("pipe:"),
    );
    expect(ioFds.length).toBeGreaterThan(0);
    for (const fdInfo of newParentFds) {
      expect(fdInfo.cloexec).toBe(true);
    }

    const parentTargets = new Set(newParentFds.map((f) => f.target));
    const childStdioByFd = new Map(childFds.map((f) => [f.fd, f.target]));
    expect(childStdioByFd.get("0")).toBe("/dev/null");
    expect(childStdioByFd.get("1")).toBe("/dev/null");
    expect(childStdioByFd.get("2")).toBe("/dev/null");
    for (const childFd of childFds) {
      expect(parentTargets.has(childFd.target)).toBe(false);
      expect(childFd.target.startsWith("socket:") || childFd.target.startsWith("pipe:")).toBe(false);
    }

    assert.ok(typeof owner1.pid === "number");
    const holder1Pid = acquired1.holderPid as number;
    const holder1Start = acquired1.holderStartTime as string;
    expect(isSameProcessAlive(holder1Pid, holder1Start)).toBe(true);
    expect(isSameProcessAlive(childPid, childStartTime)).toBe(true);

    process.kill(owner1.pid, "SIGKILL");
    const exit1 = await owner1.exited;
    expect(exit1.signal).toBe("SIGKILL");

    expect(isSameProcessAlive(childPid, childStartTime)).toBe(true);

    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    expect(suiteTracker.retireExternalIfDead(holder1Pid, holder1Start)).toBe(true);
    expect(isSameProcessAlive(childPid, childStartTime)).toBe(true);

    const owner2 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired2 = await owner2.nextEvent();
    expect(acquired2.event).toBe("acquired");
    expect(acquired2.epoch).toBe(2);
    expect(isSameProcessAlive(childPid, childStartTime)).toBe(true);

    const exit2 = await owner2.releaseAndWait();
    expect(exit2.code).toBe(0);
    expect(
      suiteTracker.retireExternalIfDead(
        acquired2.holderPid as number,
        acquired2.holderStartTime as string,
      ),
    ).toBe(true);

    await suiteTracker.stopExternalAndRetire(childPid, childStartTime, "detached-child");
    expect(await suiteTracker.stopAndRetireEnvToken("HERDR_S1A_CHILD_TOKEN", childToken)).toEqual(
      [],
    );
  });
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

  test("cleanup helpers throw instead of reporting success when /proc is unreadable", async () => {
    const selfStat = readProcessStat(process.pid);
    assert.ok(selfStat !== null);

    // Regular file as procRoot triggers ENOTDIR for every user (including root).
    const fileProc = path.join(scratchRoot, "not-a-proc-dir");
    fs.writeFileSync(fileProc, "not a directory\n", "utf8");
    expect(() => confirmProcessDead(process.pid, selfStat.startTime, fileProc)).toThrow();
    expect(() => findProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", fileProc)).toThrow();
    await expect(stopProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", 200, fileProc)).rejects.toThrow();

    // Unreadable chmod 0o000 directory as procRoot triggers EACCES for non-root users.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const noAccessProc = path.join(scratchRoot, "no-access-proc");
      fs.mkdirSync(noAccessProc, { recursive: true });
      fs.chmodSync(noAccessProc, 0o000);
      try {
        expect(() => confirmProcessDead(process.pid, selfStat.startTime, noAccessProc)).toThrow();
        expect(() => findProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", noAccessProc)).toThrow();
        await expect(
          stopProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", 200, noAccessProc),
        ).rejects.toThrow();
      } finally {
        fs.chmodSync(noAccessProc, 0o755);
      }
    }
  });

  test("fixture proc root: unreadable entry that may be ours is reported uncertain and fails cleanup", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const otherUid = 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-unreadable-ours"),
      "50000",
      [
        {
          pid: 9000001,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000001, "worker", "S", "50000"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          pid: 9000002,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000002, "worker", "S", "50010"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          // Setuid-like process where real UID is ours and effective/saved/fs UIDs are root: still may be ours.
          pid: 9000003,
          uids: [myUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000003, "helper", "S", "50020"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          // Unreadable stat without status file (unknown owner stays maybe_ours).
          pid: 9000004,
          stat: makeStatLine(9000004, "worker", "S", "50030"),
          statMode: 0o000,
          environ: "PATH=/usr/bin\0",
        },
      ],
      sameNsUidMap,
    );

    try {
      const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", fixture.procRoot);
      expect(scan.matches).toEqual([]);
      const uncertainSorted = [...scan.uncertain].sort((a, b) => a.pid - b.pid);
      expect(uncertainSorted).toEqual([
        { pid: 9000001, startTime: "50000", reason: "unreadable_environ" },
        { pid: 9000002, startTime: "50010", reason: "unreadable_environ" },
        { pid: 9000003, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000004, reason: "unreadable_stat" },
      ]);

      expect(() =>
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", fixture.procRoot),
      ).toThrow(/Uncertain process cleanup.*pid=9000001/);
      await expect(
        stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", 200, fixture.procRoot),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);
      expect(() => confirmProcessDead(9000004, "50030", fixture.procRoot)).toThrow();
    } finally {
      fixture.restoreModes();
    }
  });

  test("fixture proc root: unreadable entry proven not ours (other user or older start time) is skipped cleanly", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const otherUid = myUid === 0 ? 65534 : 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-unreadable-not-ours"),
      "50000",
      [
        {
          // Proof 1: owned by another user (all 4 UIDs != myUid), even though started after us.
          pid: 9000011,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000011, "daemon", "S", "50050"),
          environ: "SECRET=1\0",
          environMode: 0o000,
        },
        {
          // Proof 1 with unreadable stat: owned by another user.
          pid: 9000012,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000012, "daemon", "S", "50050"),
          statMode: 0o000,
          environ: "SECRET=1\0",
          environMode: 0o000,
        },
        {
          // Proof 2: same user, but started strictly before our run's token existed (e.g. a key agent).
          pid: 9000013,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000013, "ssh-agent", "S", "49999"),
          environ: "SSH_AUTH_SOCK=/tmp/agent\0",
          environMode: 0o000,
        },
        {
          // Ancestor/host user namespace viewed from inside `unshare -c -n`: lower UID 4294967295 (unmapped).
          pid: 9000015,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: "0 4294967295 4294967295\n",
          stat: makeStatLine(9000015, "host-proc", "S", "50050"),
          environ: "HOST=1\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
    );

    const minStartFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-min-start-time"),
      "50000",
      [
        {
          pid: 9000014,
          uids: [myUid, myUid, myUid, myUid],
          stat: makeStatLine(9000014, "agent", "S", "50005"),
          environ: "AGENT=1\0",
          environMode: 0o000,
        },
      ],
    );

    const selfAncestorPid = 9000100;
    const ancestorEntries: FixtureProcEntry[] = [
      {
        pid: 1,
        uids: [otherUid, otherUid, otherUid, otherUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(1, "init", "S", "1", 0),
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: selfAncestorPid,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(selfAncestorPid, "shell", "S", "10000", 1),
        environ: "PATH=/usr/bin\0",
      },
    ];

    // Proof 4 (parent chain), cases (a) and (d): proven not ours and skipped cleanly.
    const parentChainSkippedFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-skipped"),
      "50000",
      [
        ...ancestorEntries,
        {
          // Older non-ancestor parent (e.g. browser running before the test started).
          pid: 9000110,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000110, "browser", "S", "20000", 1),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Newer intermediate parent whose own parent is the older non-ancestor 9000110.
          pid: 9000111,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000111, "zygote", "S", "50010", 9000110),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Case (a): newer unreadable entry whose parent is older than self and not an ancestor.
          pid: 9000051,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000051, "sandbox-a", "S", "50020", 9000110),
          environ: "SANDBOX=1\0",
          environMode: 0o000,
        },
        {
          // Case (d): newer unreadable entry whose parent is newer and grandparent is older non-ancestor.
          pid: 9000054,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000054, "sandbox-d", "S", "50030", 9000111),
          environ: "SANDBOX=1\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), cases (b), (c), (e), and (f): must stay uncertain and fail cleanup.
    const parentChainUncertainFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-uncertain"),
      "50000",
      [
        ...ancestorEntries,
        {
          // Newer direct child of the test process (grandparent for case (e)).
          pid: 9000120,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000120, "worker", "S", "50010", process.pid),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Malformed-stat parent (otherUid so outer scan skips 9000132 itself while child 9000058 stays uncertain).
          pid: 9000132,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: "9000132 (broken) S 1 2 3\n",
          environ: "PATH=/usr/bin\0",
        },
        {
          // Unreadable-stat parent (otherUid so outer scan skips 9000133 itself while child 9000059 stays uncertain).
          pid: 9000133,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000133, "locked", "S", "20000", 1),
          statMode: 0o000,
          environ: "PATH=/usr/bin\0",
        },
        {
          // Case (b): parent is the test process.
          pid: 9000052,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000052, "child-b", "S", "50020", process.pid),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (c): parent is an intermediate ancestor of the test process.
          pid: 9000053,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000053, "child-c-anc", "S", "50021", selfAncestorPid),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (c): parent is pid 1 (ancestor of the test process).
          pid: 9000055,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000055, "child-c-pid1", "S", "50022", 1),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (e): parent is newer than the test process and grandparent is the test process.
          pid: 9000056,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000056, "grandchild-e", "S", "50023", 9000120),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is absent (pid 9000131 does not exist).
          pid: 9000057,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000057, "orphan-f-absent", "S", "50024", 9000131),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is malformed.
          pid: 9000058,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000058, "child-f-malformed", "S", "50025", 9000132),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is unreadable.
          pid: 9000059,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000059, "child-f-unreadable", "S", "50026", 9000133),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), changed ppid on re-read after parent stat stays uncertain.
    const parentChainChangedPpidFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-changed-ppid"),
      "50000",
      [
        ...ancestorEntries,
        {
          pid: 9000110,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000110, "browser", "S", "20000", 1),
          environ: "PATH=/usr/bin\0",
        },
        {
          pid: 9000060,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000060, "reparented", "S", "50040", 9000110),
          environ: "HERDR_TEST_TOKEN=tok-parent-reparented\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), 64-step walk cap: 64 steps skips, 65 steps stays uncertain.
    const depthChainEntries: FixtureProcEntry[] = [
      ...ancestorEntries,
      {
        pid: 9000200,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000200, "older-root", "S", "20000", 1),
        environ: "PATH=/usr/bin\0",
      },
    ];
    for (let i = 1; i <= 64; i += 1) {
      const nodePid = 9000200 + i;
      depthChainEntries.push({
        pid: nodePid,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(nodePid, `hop-${i}`, "S", "50010", nodePid - 1),
        environ: "PATH=/usr/bin\0",
      });
    }
    depthChainEntries.push(
      {
        // 65 steps to older non-ancestor 9000200: exceeds 64-step limit -> uncertain.
        pid: 9000061,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000061, "too-deep", "S", "50050", 9000264),
        environ: "HERDR_TEST_TOKEN=tok-parent-depth\0",
        environMode: 0o000,
      },
      {
        // Exact 64 steps to older non-ancestor 9000200: skipped cleanly.
        pid: 9000062,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000062, "at-limit", "S", "50051", 9000263),
        environ: "HERDR_TEST_TOKEN=tok-parent-depth\0",
        environMode: 0o000,
      },
    );
    const parentChainDepthLimitFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-depth-limit"),
      "50000",
      depthChainEntries,
      sameNsUidMap,
      selfAncestorPid,
    );

    try {
      expect(scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", fixture.procRoot)).toEqual({
        matches: [],
        uncertain: [],
      });
      expect(findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", fixture.procRoot)).toEqual(
        [],
      );
      expect(
        await stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", 200, fixture.procRoot),
      ).toEqual([]);

      // Explicit minStartTime boundary: 50005 >= 50000 is uncertain, 50005 < 50010 is proven older.
      expect(
        scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-min", minStartFixture.procRoot).uncertain,
      ).toEqual([{ pid: 9000014, startTime: "50005", reason: "unreadable_environ" }]);
      expect(
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-min", minStartFixture.procRoot, {
          minStartTime: "50010",
        }),
      ).toEqual([]);

      // Proof 4 cases (a) and (d): older non-ancestor parent or grandparent skips cleanly.
      const parentSkippedScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-skip",
        parentChainSkippedFixture.procRoot,
      );
      expect(parentSkippedScan.matches).toEqual([]);
      expect(
        parentSkippedScan.uncertain
          .map((u) => u.pid)
          .sort((a, b) => a - b)
          .join(","),
      ).toBe("");
      expect(parentSkippedScan.uncertain).toEqual([]);
      expect(
        findProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-skip",
          parentChainSkippedFixture.procRoot,
        ),
      ).toEqual([]);
      expect(
        await stopProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-skip",
          200,
          parentChainSkippedFixture.procRoot,
        ),
      ).toEqual([]);

      // Proof 4 cases (b), (c), (e), and (f): must stay uncertain and fail cleanup.
      const parentUncertainScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-uncertain",
        parentChainUncertainFixture.procRoot,
      );
      expect(parentUncertainScan.matches).toEqual([]);
      const parentUncertainSorted = [...parentUncertainScan.uncertain].sort(
        (a, b) => a.pid - b.pid,
      );
      expect(parentUncertainSorted).toEqual([
        { pid: 9000052, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000053, startTime: "50021", reason: "unreadable_environ" },
        { pid: 9000055, startTime: "50022", reason: "unreadable_environ" },
        { pid: 9000056, startTime: "50023", reason: "unreadable_environ" },
        { pid: 9000057, startTime: "50024", reason: "unreadable_environ" },
        { pid: 9000058, startTime: "50025", reason: "unreadable_environ" },
        { pid: 9000059, startTime: "50026", reason: "unreadable_environ" },
      ]);
      expect(() =>
        findProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-uncertain",
          parentChainUncertainFixture.procRoot,
        ),
      ).toThrow(/Uncertain process cleanup.*pid=9000052/);
      await expect(
        stopProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-uncertain",
          200,
          parentChainUncertainFixture.procRoot,
        ),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);

      // Proof 4 changed-ppid re-read check: child's ppid changes after parent's stat is read.
      const childStatPath = path.join(parentChainChangedPpidFixture.procRoot, "9000060", "stat");
      const parentDirPrefix = `${path.join(parentChainChangedPpidFixture.procRoot, "9000110")}${path.sep}`;
      const parentStatPath = path.join(parentChainChangedPpidFixture.procRoot, "9000110", "stat");
      let childStatReads = 0;
      let nonStatParentReadsDuringWalk = 0;
      const origReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
        const target = String(args[0]);
        if (target === childStatPath) {
          childStatReads += 1;
          if (childStatReads === 2) {
            return makeStatLine(9000060, "reparented", "S", "50040", 1);
          }
        } else if (
          childStatReads === 1 &&
          target.startsWith(parentDirPrefix) &&
          target !== parentStatPath
        ) {
          nonStatParentReadsDuringWalk += 1;
        }
        return origReadFileSync(...(args as Parameters<typeof fs.readFileSync>));
      }) as typeof fs.readFileSync);
      try {
        const changedPpidScan = scanProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-reparented",
          parentChainChangedPpidFixture.procRoot,
        );
        expect(childStatReads).toBe(2);
        expect(nonStatParentReadsDuringWalk).toBe(0);
        expect(changedPpidScan).toEqual({
          matches: [],
          uncertain: [{ pid: 9000060, startTime: "50040", reason: "unreadable_environ" }],
        });
      } finally {
        readSpy.mockRestore();
      }

      // Proof 4 64-step limit: 64 steps skips (9000062), 65 steps stays uncertain (9000061).
      const depthLimitScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-depth",
        parentChainDepthLimitFixture.procRoot,
      );
      expect(depthLimitScan).toEqual({
        matches: [],
        uncertain: [{ pid: 9000061, startTime: "50050", reason: "unreadable_environ" }],
      });
    } finally {
      fixture.restoreModes();
      minStartFixture.restoreModes();
      parentChainSkippedFixture.restoreModes();
      parentChainUncertainFixture.restoreModes();
      parentChainChangedPpidFixture.restoreModes();
      parentChainDepthLimitFixture.restoreModes();
    }
  });

  test("fixture proc root: malformed or cut-off stat throws in confirmProcessDead and fails env-token cleanup", async () => {
    const myUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const fixture = createFixtureProcRoot(path.join(scratchRoot, "proc-malformed-stat"), "50000", [
      {
        pid: 9000021,
        uids: [myUid, myUid, myUid, myUid],
        stat: "9000021 (sleep) S 1 2 3 4\n",
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000022,
        uids: [myUid, myUid, myUid, myUid],
        stat: "9000022 (broken S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20\n",
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000023,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000023, "sleep", "S", "notanumber"),
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000024,
        uids: [myUid, myUid, myUid, myUid],
        stat: "",
        environ: "PATH=/usr/bin\0",
      },
    ]);

    for (const pid of [9000021, 9000022, 9000023, 9000024]) {
      expect(() => confirmProcessDead(pid, "50000", fixture.procRoot)).toThrow(
        /Malformed \/proc stat/,
      );
    }

    const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", fixture.procRoot);
    expect(scan.matches).toEqual([]);
    expect(
      scan.uncertain.map((u) => ({ pid: u.pid, reason: u.reason })).sort((a, b) => a.pid - b.pid),
    ).toEqual([
      { pid: 9000021, reason: "malformed_stat" },
      { pid: 9000022, reason: "malformed_stat" },
      { pid: 9000023, reason: "malformed_stat" },
      { pid: 9000024, reason: "malformed_stat" },
    ]);
    expect(() =>
      findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", fixture.procRoot),
    ).toThrow(/Uncertain process cleanup.*malformed_stat/);
    await expect(
      stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", 200, fixture.procRoot),
    ).rejects.toThrow(/Uncertain process cleanup.*malformed_stat/);
  });

  test("fixture proc root: absent entry or different startTime confirms death while live matching entry stays alive", async () => {
    const myUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const fixture = createFixtureProcRoot(path.join(scratchRoot, "proc-absent-and-live"), "50000", [
      {
        // Directory exists but stat is absent (ENOENT on stat).
        pid: 9000032,
        uids: [myUid, myUid, myUid, myUid],
      },
      {
        // Valid live stat, absent environ (ENOENT on environ).
        pid: 9000033,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000033, "exiting", "S", "50020"),
      },
      {
        // Different startTime (PID reused).
        pid: 9000034,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000034, "reused", "S", "60000"),
        environ: "PATH=/usr/bin\0",
      },
      {
        // Same startTime, live state S.
        pid: 9000035,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000035, "alive", "S", "50020"),
        environ: "PATH=/usr/bin\0",
      },
      {
        // Same startTime, dead zombie state Z.
        pid: 9000036,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000036, "zombie", "Z", "50020"),
        environ: "PATH=/usr/bin\0",
      },
    ]);

    // 9000031 has no directory at all (ENOENT).
    expect(confirmProcessDead(9000031, "50020", fixture.procRoot)).toBe(true);
    // 9000032 has directory but no stat file (ENOENT).
    expect(confirmProcessDead(9000032, "50020", fixture.procRoot)).toBe(true);
    // 9000034 has a different startTime (PID reused).
    expect(confirmProcessDead(9000034, "50020", fixture.procRoot)).toBe(true);
    // 9000035 has matching startTime and live state S.
    expect(confirmProcessDead(9000035, "50020", fixture.procRoot)).toBe(false);
    // 9000036 has matching startTime and dead state Z.
    expect(confirmProcessDead(9000036, "50020", fixture.procRoot)).toBe(true);

    // Absent stat/environ entries are skipped cleanly (not uncertain) during env-token scans.
    expect(scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", fixture.procRoot)).toEqual({
      matches: [],
      uncertain: [],
    });
    expect(findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", fixture.procRoot)).toEqual([]);
    expect(
      await stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", 200, fixture.procRoot),
    ).toEqual([]);
  });

  test("fixture proc root: root-owned pid directory without readable status UIDs is reported uncertain and fails cleanup", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const rootUid = 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-root-owned-dir"),
      "50000",
      [
        {
          // Non-dumpable same-namespace process: root owns /proc/<pid>, status and environ are denied.
          pid: 9000041,
          uids: [myUid, myUid, myUid, myUid],
          statusMode: 0o000,
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000041, "nondump", "S", "50020"),
          environ: "HERDR_TEST_TOKEN=tok-nondump\0",
          environMode: 0o000,
        },
        {
          // Same-namespace process: root owns /proc/<pid>, status omits the four Uid fields.
          pid: 9000042,
          statusRaw: "Name:\tnondump\nState:\tS (sleeping)\n",
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000042, "nondump", "S", "50025"),
          environ: "HERDR_TEST_TOKEN=tok-nondump\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
    );

    const rootOwnedDirs = new Set([
      path.join(fixture.procRoot, "9000041"),
      path.join(fixture.procRoot, "9000042"),
    ]);
    const origStatSync = fs.statSync.bind(fs);
    const statSpy = spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
      const real = origStatSync(...(args as Parameters<typeof fs.statSync>));
      if (
        rootOwnedDirs.has(String(args[0])) &&
        real !== undefined &&
        real !== null &&
        typeof real === "object" &&
        "uid" in real
      ) {
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: rootUid });
      }
      return real;
    }) as typeof fs.statSync);

    try {
      const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", fixture.procRoot);
      expect(scan.matches).toEqual([]);
      const uncertainSorted = [...scan.uncertain].sort((a, b) => a.pid - b.pid);
      expect(uncertainSorted).toEqual([
        { pid: 9000041, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000042, startTime: "50025", reason: "unreadable_environ" },
      ]);
      expect(() =>
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", fixture.procRoot),
      ).toThrow(/Uncertain process cleanup.*pid=9000041/);
      await expect(
        stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", 200, fixture.procRoot),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);
    } finally {
      statSpy.mockRestore();
      fixture.restoreModes();
    }
  });
});
