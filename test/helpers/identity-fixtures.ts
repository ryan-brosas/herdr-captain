import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { OwnerLease } from "../../src/identity.ts";
import { readProcessStat } from "../../src/lease.ts";
import {
  confirmProcessDead,
  ProcessTracker,
  terminateExternalProcess,
  type ChildExitInfo,
} from "./process.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IDENTITY_WORKER_PATH = path.join(HERE, "identity-worker.ts");

const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SUPER_PREFIX",
] as const;

export interface RawFileSnapshot {
  readonly bytes: Buffer;
  readonly ino: number;
  readonly size: number;
}

export interface DirSnapshot {
  readonly entries: readonly string[];
  readonly files: ReadonlyMap<string, RawFileSnapshot>;
}

export interface TrackedPid {
  readonly pid: number;
  readonly startTime: string;
  readonly label: string;
}

export interface IdentityWorkerHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startTime: string;
  readonly hasExited: () => boolean;
  readonly exited: Promise<ChildExitInfo>;
  readonly nextEvent: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  readonly sendCommand: (line: string) => void;
  readonly resumePause: (line?: string) => void;
  readonly killWithSigkill: () => Promise<ChildExitInfo>;
  readonly ensureStopped: () => Promise<void>;
}

export interface IdentityTestContext {
  readonly tracker: ProcessTracker;
  readonly scratchRoot: string;
  readonly trackedPids: TrackedPid[];
  readonly createDir: (...segments: string[]) => string;
  readonly trackLease: (lease: OwnerLease, label?: string) => OwnerLease;
  readonly trackPid: (pid: number, startTime: string, label: string) => void;
  readonly spawnIdentityWorker: (args: string[]) => IdentityWorkerHandle;
  readonly killHolderAndWaitDead: (
    holderPid: number,
    holderStartTime: string,
    timeoutMs?: number,
  ) => Promise<void>;
  readonly waitForProcessDead: (
    pid: number,
    startTime: string,
    timeoutMs?: number,
  ) => Promise<void>;
  readonly runTryOnceAndTrack: (
    stateRoot: string,
    projectKey: string,
  ) => Promise<{ event: Record<string, unknown>; exit: ChildExitInfo }>;
  readonly cleanup: () => Promise<void>;
}

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  env.GIT_AUTHOR_NAME = "Test User";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "Test User";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  return env;
}

export function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  });
}

export function initGitRepo(
  dir: string,
  options?: {
    readonly originUrl?: string | null;
    readonly initialCommit?: boolean;
    readonly branch?: string;
    readonly fileName?: string;
    readonly fileContent?: string;
  },
): string {
  const branch = options?.branch ?? "main";
  const initialCommit = options?.initialCommit ?? true;
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-b", branch]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  if (options?.originUrl !== undefined && options.originUrl !== null) {
    runGit(dir, ["remote", "add", "origin", options.originUrl]);
  }
  if (initialCommit) {
    addCommit(
      dir,
      options?.fileName ?? "README.md",
      options?.fileContent ?? "initial\n",
      "initial commit",
    );
  }
  return dir;
}

export function initBareRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

export function cloneGitRepo(sourceDir: string, targetDir: string): string {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  execFileSync("git", ["clone", sourceDir, targetDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  });
  runGit(targetDir, ["config", "user.name", "Test User"]);
  runGit(targetDir, ["config", "user.email", "test@example.com"]);
  return targetDir;
}

export function addCommit(
  repoDir: string,
  fileName: string,
  content: string,
  message: string,
): string {
  const targetPath = path.join(repoDir, fileName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  runGit(repoDir, ["add", fileName]);
  runGit(repoDir, ["commit", "-m", message]);
  return runGit(repoDir, ["rev-parse", "HEAD"]).trim();
}

export function addOrphanRootCommit(
  repoDir: string,
  branchName: string,
  fileName: string,
  content: string,
  returnToBranch = "main",
): string {
  runGit(repoDir, ["checkout", "--orphan", branchName]);
  runGit(repoDir, ["rm", "-rf", "--quiet", "--ignore-unmatch", "."]);
  const sha = addCommit(repoDir, fileName, content, `orphan root ${branchName}`);
  if (returnToBranch.length > 0) {
    runGit(repoDir, ["checkout", returnToBranch]);
  }
  return sha;
}

export function createUnbornHeadBesideBranch(repoDir: string, unbornBranch: string): void {
  runGit(repoDir, ["symbolic-ref", "HEAD", `refs/heads/${unbornBranch}`]);
}

export function makeRepoUnborn(repoDir: string): void {
  runGit(repoDir, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
  const refsRaw = runGit(repoDir, ["for-each-ref", "--format=%(refname)"]).trim();
  if (refsRaw.length > 0) {
    for (const ref of refsRaw.split(/\r?\n/)) {
      const trimmed = ref.trim();
      if (trimmed.length > 0) {
        runGit(repoDir, ["update-ref", "-d", trimmed]);
      }
    }
  }
}

export function setOriginUrl(repoDir: string, originUrl: string | null): void {
  if (originUrl === null) {
    try {
      runGit(repoDir, ["config", "--unset-all", "remote.origin.url"]);
    } catch {
      // Ignore if remote.origin.url was already absent.
    }
    return;
  }
  runGit(repoDir, ["config", "remote.origin.url", originUrl]);
}

export function addLinkedWorktree(
  repoDir: string,
  worktreeDir: string,
  branchName: string,
): string {
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
  runGit(repoDir, ["worktree", "add", "-b", branchName, worktreeDir]);
  return worktreeDir;
}

export function snapshotRawFile(filePath: string): RawFileSnapshot {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    bytes: Buffer.from(bytes),
    ino: stat.ino,
    size: stat.size,
  };
}

export function assertRawFileUnchanged(
  filePath: string,
  before: RawFileSnapshot,
  label = filePath,
): void {
  const after = snapshotRawFile(filePath);
  assert.equal(
    Buffer.compare(after.bytes, before.bytes),
    0,
    `${label}: raw file bytes changed`,
  );
  assert.equal(after.ino, before.ino, `${label}: file inode changed`);
}

export function snapshotDirFiles(dirPath: string): DirSnapshot {
  const entries = fs.readdirSync(dirPath).sort();
  const files = new Map<string, RawFileSnapshot>();
  for (const name of entries) {
    const fullPath = path.join(dirPath, name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isFile()) {
      files.set(name, snapshotRawFile(fullPath));
    }
  }
  return { entries, files };
}

export function assertDirUnchanged(
  dirPath: string,
  before: DirSnapshot,
  label = dirPath,
): void {
  const after = snapshotDirFiles(dirPath);
  assert.deepEqual(after.entries, before.entries, `${label}: directory entries changed`);
  for (const [name, snap] of before.files) {
    const afterSnap = after.files.get(name);
    assert.ok(afterSnap !== undefined, `${label}: file ${name} missing`);
    assert.equal(
      Buffer.compare(afterSnap.bytes, snap.bytes),
      0,
      `${label}: file ${name} raw bytes changed`,
    );
    assert.equal(afterSnap.ino, snap.ino, `${label}: file ${name} inode changed`);
  }
}

export function assertNoFileDeleted(
  dirPath: string,
  before: DirSnapshot,
  mutableFileNames: ReadonlySet<string> = new Set(["owner.json", "owner.lock"]),
): void {
  const afterEntries = new Set(fs.readdirSync(dirPath));
  for (const name of before.entries) {
    assert.equal(afterEntries.has(name), true, `Pre-existing file was deleted: ${name}`);
    if (!mutableFileNames.has(name)) {
      const beforeSnap = before.files.get(name);
      if (beforeSnap !== undefined) {
        assertRawFileUnchanged(path.join(dirPath, name), beforeSnap, name);
      }
    }
  }
}

export async function expectErrorCode(
  fn: () => Promise<unknown>,
  expectedCode: string,
  label: string,
): Promise<Error & { code: string; candidates?: readonly unknown[]; details?: unknown }> {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.equal(threw, true, `${label}: expected error with code ${expectedCode}, but call succeeded`);
  assert.ok(caught instanceof Error, `${label}: expected Error instance`);
  const code =
    "code" in caught && typeof (caught as { code?: unknown }).code === "string"
      ? (caught as { code: string }).code
      : undefined;
  assert.equal(
    code,
    expectedCode,
    `${label}: expected code ${expectedCode}, got ${String(code)} (${caught.message})`,
  );
  return caught as Error & { code: string; candidates?: readonly unknown[]; details?: unknown };
}

export function createIdentityTestContext(prefix = "herdr-captain-s1b-"): IdentityTestContext {
  const tracker = new ProcessTracker();
  const scratchRoot = tracker.createScratchDir(prefix);
  const openLeases = new Set<OwnerLease>();
  const trackedPids: TrackedPid[] = [];
  const seenPidKeys = new Set<string>();

  const trackPid = (pid: number, startTime: string, label: string): void => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || startTime.length === 0) {
      return;
    }
    const key = `${pid}:${startTime}`;
    if (!seenPidKeys.has(key)) {
      seenPidKeys.add(key);
      trackedPids.push({ pid, startTime, label });
    }
    tracker.trackExternal(pid, startTime, label);
  };

  const trackLease = (lease: OwnerLease, label = "in-process-holder"): OwnerLease => {
    openLeases.add(lease);
    trackPid(lease.holderPid, lease.holderStartTime, label);
    return lease;
  };

  const createDir = (...segments: string[]): string => {
    const dir = path.join(scratchRoot, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const spawnIdentityWorker = (args: string[]): IdentityWorkerHandle => {
    const child = spawn(process.execPath, [IDENTITY_WORKER_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: process.env,
    });
    const tracked = tracker.trackChild(child);
    const pid = child.pid;
    assert.ok(typeof pid === "number" && pid > 0, "worker did not produce a valid PID");
    const startTime = readProcessStat(pid)?.startTime ?? "";
    if (startTime.length > 0) {
      trackPid(pid, startTime, "identity-worker");
    }

    const controlStream = child.stdio[3] as Writable | null;
    child.stdin?.on("error", () => {});
    controlStream?.on("error", () => {});

    let stdoutBuf = "";
    let stderrBuf = "";
    const queuedEvents: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      resolve: (ev: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }> = [];

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const idx = stdoutBuf.indexOf("\n");
        if (idx === -1) {
          break;
        }
        const rawLine = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (rawLine.length === 0) {
          continue;
        }
        const parsed = JSON.parse(rawLine) as Record<string, unknown>;
        if (typeof parsed.pid === "number" && typeof parsed.startTime === "string") {
          trackPid(parsed.pid, parsed.startTime, "identity-worker");
        }
        if (typeof parsed.holderPid === "number" && typeof parsed.holderStartTime === "string") {
          trackPid(parsed.holderPid, parsed.holderStartTime, "worker-holder");
        }
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(parsed);
        } else {
          queuedEvents.push(parsed);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    void tracked.exited.then((info) => {
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.reject(
          new Error(
            `Worker pid=${pid} exited before expected event (code=${info.code}, signal=${info.signal}, stderr=${stderrBuf.trim()})`,
          ),
        );
      }
    });

    const nextEvent = (timeoutMs = 5000): Promise<Record<string, unknown>> => {
      const existing = queuedEvents.shift();
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: (val: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
          }
          reject(
            new Error(
              `Timed out waiting for worker pid=${pid} event after ${timeoutMs}ms (stderr=${stderrBuf.trim()})`,
            ),
          );
        }, timeoutMs);
        waiters.push(entry);
      });
    };

    const sendCommand = (line: string): void => {
      child.stdin?.write(`${line}\n`);
    };

    const resumePause = (line = "go"): void => {
      controlStream?.write(`${line}\n`);
    };

    const killWithSigkill = async (): Promise<ChildExitInfo> => {
      child.kill("SIGKILL");
      return tracked.exited;
    };

    return {
      child,
      pid,
      startTime,
      hasExited: tracked.hasExited,
      exited: tracked.exited,
      nextEvent,
      sendCommand,
      resumePause,
      killWithSigkill,
      ensureStopped: tracked.ensureStopped,
    };
  };

  const killHolderAndWaitDead = async (
    holderPid: number,
    holderStartTime: string,
    timeoutMs = 3000,
  ): Promise<void> => {
    trackPid(holderPid, holderStartTime, "killed-holder");
    const dead = await terminateExternalProcess(holderPid, holderStartTime, timeoutMs);
    assert.equal(dead, true, `Holder pid=${holderPid} did not terminate after SIGKILL`);
    tracker.retireExternalIfDead(holderPid, holderStartTime);
  };

  const waitForProcessDead = async (
    pid: number,
    startTime: string,
    timeoutMs = 3000,
  ): Promise<void> => {
    trackPid(pid, startTime, "awaited-holder");
    const deadline = performance.now() + timeoutMs;
    while (!confirmProcessDead(pid, startTime)) {
      if (performance.now() >= deadline) {
        assert.fail(`Process pid=${pid} did not exit within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    tracker.retireExternalIfDead(pid, startTime);
  };

  const runTryOnceAndTrack = async (
    stateRoot: string,
    projectKey: string,
  ): Promise<{ event: Record<string, unknown>; exit: ChildExitInfo }> => {
    const res = await tracker.runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    if (typeof res.event.holderPid === "number" && typeof res.event.holderStartTime === "string") {
      trackPid(res.event.holderPid, res.event.holderStartTime, "try-once-holder");
      await waitForProcessDead(res.event.holderPid, res.event.holderStartTime);
    }
    return res;
  };

  const cleanup = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const lease of [...openLeases]) {
      try {
        await lease.release();
      } catch (err) {
        errors.push(err);
      }
      openLeases.delete(lease);
    }

    try {
      await tracker.cleanupAll();
    } catch (err) {
      errors.push(err);
    } finally {
      tracker.dispose();
    }

    for (const item of trackedPids) {
      try {
        assert.equal(
          confirmProcessDead(item.pid, item.startTime),
          true,
          `Leftover process detected after test cleanup: ${item.label} pid=${item.pid}`,
        );
      } catch (err) {
        errors.push(err);
      }
    }

    assert.equal(
      fs.existsSync(scratchRoot),
      false,
      `Scratch directory was not removed: ${scratchRoot}`,
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, `Identity test cleanup failed (${errors.length} error(s))`);
    }
  };

  return {
    tracker,
    scratchRoot,
    trackedPids,
    createDir,
    trackLease,
    trackPid,
    spawnIdentityWorker,
    killHolderAndWaitDead,
    waitForProcessDead,
    runTryOnceAndTrack,
    cleanup,
  };
}
