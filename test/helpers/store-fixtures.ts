import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { acquireLease, readProcessStat, type OwnerLease } from "../../src/lease.ts";
import type {
  AppendCommitRecordInput,
  CountersAfter,
  EvidenceRef,
  IntentPayload,
  OpenTicketLogResult,
  ReceiptPayload,
} from "../../src/store.ts";
import {
  confirmProcessDead,
  ProcessTracker,
  terminateExternalProcess,
  type ChildExitInfo,
} from "./process.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORE_WORKER_PATH = path.join(HERE, "store-worker.ts");

export const DEFAULT_PROJECT_KEY = "0123456789abcdef";
export const DEFAULT_ISSUE_REF = "example/repo#8";

export interface RawFileSnapshot {
  readonly bytes: Buffer;
  readonly ino: number;
  readonly size: number;
}

export interface TreeFileSnapshot {
  readonly bytes: Buffer | null;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
}

export interface TreeOtherSnapshot {
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
}

export interface TreeSnapshot {
  readonly exists: boolean;
  readonly dirs: readonly string[];
  readonly files: ReadonlyMap<string, TreeFileSnapshot>;
  readonly symlinks: ReadonlyMap<string, string>;
  readonly others: ReadonlyMap<string, TreeOtherSnapshot>;
}

export interface TrackedPid {
  readonly pid: number;
  readonly startTime: string;
  readonly label: string;
}

export interface StoreWorkerHandle {
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

export interface StoreTestContext {
  readonly tracker: ProcessTracker;
  readonly scratchRoot: string;
  readonly trackedPids: TrackedPid[];
  readonly createDir: (...segments: string[]) => string;
  readonly trackLease: (lease: OwnerLease, label?: string) => OwnerLease;
  readonly acquireTrackedLease: (
    stateRoot: string,
    projectKey?: string,
    label?: string,
  ) => Promise<OwnerLease>;
  readonly trackPid: (pid: number, startTime: string, label: string) => void;
  readonly spawnStoreWorker: (args: string[]) => StoreWorkerHandle;
  readonly runFreshOpen: (
    stateRoot: string,
    projectKey: string,
    issueRef: string,
  ) => Promise<OpenTicketLogResult>;
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
  readonly cleanup: () => Promise<void>;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
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
  assert.equal(Buffer.compare(after.bytes, before.bytes), 0, `${label}: raw file bytes changed`);
  assert.equal(after.ino, before.ino, `${label}: file inode changed`);
}

export function snapshotTree(rootDir: string): TreeSnapshot {
  if (!fs.existsSync(rootDir)) {
    return {
      exists: false,
      dirs: [],
      files: new Map(),
      symlinks: new Map(),
      others: new Map(),
    };
  }
  const dirs: string[] = [];
  const files = new Map<string, TreeFileSnapshot>();
  const symlinks = new Map<string, string>();
  const others = new Map<string, TreeOtherSnapshot>();

  const walk = (currentDir: string, relPrefix: string): void => {
    const entries = fs.readdirSync(currentDir).sort();
    for (const name of entries) {
      const fullPath = path.join(currentDir, name);
      const relPath = relPrefix.length === 0 ? name : `${relPrefix}/${name}`;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        symlinks.set(relPath, fs.readlinkSync(fullPath));
      } else if (stat.isDirectory()) {
        dirs.push(relPath);
        walk(fullPath, relPath);
      } else if (stat.isFile()) {
        let bytes: Buffer | null = null;
        try {
          bytes = Buffer.from(fs.readFileSync(fullPath));
        } catch (err) {
          const code =
            typeof err === "object" && err !== null && "code" in err
              ? (err as { code?: unknown }).code
              : null;
          if (code !== "EACCES" && code !== "EPERM") {
            throw err;
          }
        }
        files.set(relPath, {
          bytes,
          ino: stat.ino,
          size: stat.size,
          mode: stat.mode,
        });
      } else {
        others.set(relPath, {
          ino: stat.ino,
          size: stat.size,
          mode: stat.mode,
        });
      }
    }
  };

  walk(rootDir, "");
  dirs.sort();
  return { exists: true, dirs, files, symlinks, others };
}

export function assertTreeUnchanged(
  rootDir: string,
  before: TreeSnapshot,
  label = rootDir,
): void {
  const after = snapshotTree(rootDir);
  assert.equal(after.exists, before.exists, `${label}: root existence changed`);
  assert.deepEqual(after.dirs, before.dirs, `${label}: directory structure changed`);
  assert.deepEqual(
    Array.from(after.files.keys()).sort(),
    Array.from(before.files.keys()).sort(),
    `${label}: file names changed`,
  );
  assert.deepEqual(
    Array.from(after.symlinks.entries()).sort(),
    Array.from(before.symlinks.entries()).sort(),
    `${label}: symlinks changed`,
  );
  assert.deepEqual(
    Array.from(after.others.keys()).sort(),
    Array.from(before.others.keys()).sort(),
    `${label}: special entry names changed`,
  );
  for (const [relPath, snap] of before.files) {
    const afterSnap = after.files.get(relPath);
    assert.ok(afterSnap !== undefined, `${label}: file ${relPath} missing`);
    assert.equal(afterSnap.ino, snap.ino, `${label}: file ${relPath} inode changed`);
    assert.equal(afterSnap.size, snap.size, `${label}: file ${relPath} size changed`);
    assert.equal(afterSnap.mode, snap.mode, `${label}: file ${relPath} mode changed`);
    assert.equal(
      afterSnap.bytes === null,
      snap.bytes === null,
      `${label}: file ${relPath} readability changed`,
    );
    if (snap.bytes !== null && afterSnap.bytes !== null) {
      assert.equal(
        Buffer.compare(afterSnap.bytes, snap.bytes),
        0,
        `${label}: file ${relPath} bytes changed`,
      );
    }
  }
  for (const [relPath, snap] of before.others) {
    const afterSnap = after.others.get(relPath);
    assert.ok(afterSnap !== undefined, `${label}: special entry ${relPath} missing`);
    assert.equal(afterSnap.ino, snap.ino, `${label}: special entry ${relPath} inode changed`);
    assert.equal(afterSnap.size, snap.size, `${label}: special entry ${relPath} size changed`);
    assert.equal(afterSnap.mode, snap.mode, `${label}: special entry ${relPath} mode changed`);
  }
}

export function assertNoFileDeletedInTree(
  rootDir: string,
  before: TreeSnapshot,
  mutableRelPaths: ReadonlySet<string> = new Set(["owner.json", "owner.lock"]),
  label = rootDir,
): void {
  const after = snapshotTree(rootDir);
  if (!before.exists) {
    return;
  }
  assert.equal(after.exists, true, `${label}: root directory disappeared`);
  const afterDirSet = new Set(after.dirs);
  for (const dir of before.dirs) {
    assert.equal(afterDirSet.has(dir), true, `${label}: directory was deleted: ${dir}`);
  }
  for (const [relPath, snap] of before.files) {
    const afterSnap = after.files.get(relPath);
    assert.ok(afterSnap !== undefined, `${label}: file was deleted: ${relPath}`);
    if (!mutableRelPaths.has(relPath)) {
      assert.equal(afterSnap.ino, snap.ino, `${label}: pre-existing file ${relPath} inode changed`);
      assert.equal(afterSnap.size, snap.size, `${label}: pre-existing file ${relPath} size changed`);
      if (snap.bytes !== null && afterSnap.bytes !== null) {
        assert.equal(
          Buffer.compare(afterSnap.bytes, snap.bytes),
          0,
          `${label}: pre-existing file ${relPath} bytes changed`,
        );
      }
    }
  }
}

export function makeIntentInput(overrides?: {
  readonly issueRef?: string;
  readonly event?: string;
  readonly attemptId?: string;
  readonly intent?: IntentPayload;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly countersAfter?: CountersAfter;
  readonly phaseAfter?: Readonly<Record<string, unknown>>;
}): AppendCommitRecordInput {
  return {
    issueRef: overrides?.issueRef ?? DEFAULT_ISSUE_REF,
    event: overrides?.event ?? "attempt_intent",
    ...(overrides?.attemptId !== undefined ? { attemptId: overrides.attemptId } : {}),
    intent: overrides?.intent ?? {
      kind: "dispatch",
      version: 1,
      data: { role: "implementer", task: "run slice" },
    },
    evidenceRefs: overrides?.evidenceRefs ?? [],
    countersAfter: overrides?.countersAfter ?? {
      attemptSeq: 1,
      totalAttemptsUsed: 1,
      fixRoundsUsed: 0,
    },
    phaseAfter: overrides?.phaseAfter ?? { phase: "building", attemptState: "intent" },
  };
}

export function makeReceiptInput(overrides?: {
  readonly issueRef?: string;
  readonly event?: string;
  readonly attemptId?: string;
  readonly receipt?: ReceiptPayload;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly countersAfter?: CountersAfter;
  readonly phaseAfter?: Readonly<Record<string, unknown>>;
}): AppendCommitRecordInput {
  return {
    issueRef: overrides?.issueRef ?? DEFAULT_ISSUE_REF,
    event: overrides?.event ?? "attempt_receipt",
    ...(overrides?.attemptId !== undefined ? { attemptId: overrides.attemptId } : {}),
    receipt: overrides?.receipt ?? {
      kind: "dispatch_receipt",
      version: 1,
      data: { status: "delivered" },
    },
    evidenceRefs: overrides?.evidenceRefs ?? [],
    countersAfter: overrides?.countersAfter ?? {
      attemptSeq: 1,
      totalAttemptsUsed: 1,
      fixRoundsUsed: 0,
    },
    phaseAfter: overrides?.phaseAfter ?? { phase: "building", attemptState: "delivered" },
  };
}

export async function runWrite<T>(lease: OwnerLease, fn: () => T | Promise<T>): Promise<T> {
  const { writeResult } = await lease.enqueue<T, void>({ write: fn });
  return writeResult;
}

export async function expectErrorCode(
  fn: () => unknown | Promise<unknown>,
  expectedCode: string,
  label: string,
): Promise<Error & { code: string; details?: unknown }> {
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
  return caught as Error & { code: string; details?: unknown };
}

export function createStoreTestContext(prefix = "herdr-captain-s1c-"): StoreTestContext {
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

  const acquireTrackedLease = async (
    stateRoot: string,
    projectKey = DEFAULT_PROJECT_KEY,
    label = "store-lease-holder",
  ): Promise<OwnerLease> => {
    const lease = await acquireLease({ projectKey, stateRoot });
    return trackLease(lease, label);
  };

  const createDir = (...segments: string[]): string => {
    const dir = path.join(scratchRoot, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const spawnStoreWorker = (args: string[]): StoreWorkerHandle => {
    const child = spawn(process.execPath, [STORE_WORKER_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: process.env,
    });
    const tracked = tracker.trackChild(child);
    const pid = child.pid;
    assert.ok(typeof pid === "number" && pid > 0, "store worker did not produce a valid PID");
    const startTime = readProcessStat(pid)?.startTime ?? "";
    if (startTime.length > 0) {
      trackPid(pid, startTime, "store-worker");
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
          trackPid(parsed.pid, parsed.startTime, "store-worker");
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
            `Store worker pid=${pid} exited before expected event (code=${info.code}, signal=${info.signal}, stderr=${stderrBuf.trim()})`,
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
              `Timed out waiting for store worker pid=${pid} event after ${timeoutMs}ms (stderr=${stderrBuf.trim()})`,
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

  const runFreshOpen = async (
    stateRoot: string,
    projectKey: string,
    issueRef: string,
  ): Promise<OpenTicketLogResult> => {
    const worker = spawnStoreWorker([
      "--mode",
      "open",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
      "--issue-ref",
      issueRef,
    ]);
    const ev = await worker.nextEvent();
    const exit = await worker.exited;
    assert.equal(exit.code, 0, `Fresh open worker exited with ${String(exit.code)}`);
    assert.equal(ev.event, "opened", `Unexpected event from fresh open worker: ${String(ev.event)}`);
    return ev.result as OpenTicketLogResult;
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
    trackPid(pid, startTime, "awaited-process");
    const deadline = performance.now() + timeoutMs;
    while (!confirmProcessDead(pid, startTime)) {
      if (performance.now() >= deadline) {
        assert.fail(`Process pid=${pid} did not exit within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    tracker.retireExternalIfDead(pid, startTime);
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
      throw new AggregateError(errors, `Store test cleanup failed (${errors.length} error(s))`);
    }
  };

  return {
    tracker,
    scratchRoot,
    trackedPids,
    createDir,
    trackLease,
    acquireTrackedLease,
    trackPid,
    spawnStoreWorker,
    runFreshOpen,
    killHolderAndWaitDead,
    waitForProcessDead,
    cleanup,
  };
}
