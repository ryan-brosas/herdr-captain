import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFLICT_EXIT_CODE,
  isSameProcessAlive,
  type ProcessStat,
} from "../../src/lease.ts";

const DEAD_PROCESS_STATES = new Set(["Z", "X", "x"]);
const INVALID_LINUX_UID = "4294967295";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OWNER_WORKER_PATH = path.join(HERE, "owner-worker.ts");
export const HARNESS_RUNNER_PATH = path.join(HERE, "harness-runner.ts");

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface TrackedProcessIdentity {
  pid: number;
  startTime: string;
}

export type UncertainProcessReason =
  | "unreadable_stat"
  | "malformed_stat"
  | "unreadable_environ"
  | "unreadable_stat_after"
  | "malformed_stat_after";

export interface UncertainProcessEntry {
  pid: number;
  startTime?: string;
  reason: UncertainProcessReason;
}

export interface EnvTokenScanOptions {
  minStartTime?: string;
}

export interface EnvTokenScanResult {
  matches: TrackedProcessIdentity[];
  uncertain: UncertainProcessEntry[];
}

type ProcessStatReadResult =
  | { status: "ok"; stat: ProcessStat }
  | { status: "absent" }
  | { status: "malformed"; raw: string };

export interface FdInfo {
  fd: string;
  target: string;
  flagsOct: string | null;
  cloexec: boolean;
}

export interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
}

export interface TrackedChild {
  child: ChildProcess;
  pid: number | undefined;
  hasExited: () => boolean;
  exited: Promise<ChildExitInfo>;
  ensureStopped: () => Promise<void>;
}

export interface WorkerHandle extends TrackedChild {
  nextEvent: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  sendLine: (text: string) => void;
  releaseAndWait: () => Promise<ChildExitInfo>;
}

export interface FileSnapshot {
  sha256: string;
  ino: number;
  mtimeMs: number;
  text: string;
}

function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

export function formatError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const header = `${err.name}: ${err.message}`;
  if (typeof err.stack !== "string" || err.stack.length === 0) {
    return header;
  }
  const firstNewline = err.stack.indexOf("\n");
  const firstLine = firstNewline === -1 ? err.stack : err.stack.slice(0, firstNewline);
  if (err.message.length === 0 || firstLine.includes(err.message)) {
    return err.stack;
  }
  return firstNewline === -1 ? header : `${header}\n${err.stack.slice(firstNewline + 1)}`;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function readProcessStatStrict(
  pid: number | "self",
  procRoot = "/proc",
): ProcessStatReadResult {
  if (pid !== "self" && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`Invalid pid for readProcessStatStrict: ${String(pid)}`);
  }
  let statRaw: string;
  try {
    statRaw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ENOENT" || code === "ESRCH") {
      return { status: "absent" };
    }
    throw err;
  }
  const openParen = statRaw.indexOf("(");
  const closeParen = statRaw.lastIndexOf(")");
  if (
    openParen <= 1 ||
    closeParen <= openParen ||
    closeParen + 2 >= statRaw.length ||
    statRaw[openParen - 1] !== " " ||
    statRaw[closeParen + 1] !== " "
  ) {
    return { status: "malformed", raw: statRaw };
  }
  const pidField = statRaw.slice(0, openParen - 1);
  if (!/^\d+$/.test(pidField)) {
    return { status: "malformed", raw: statRaw };
  }
  const fields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    return { status: "malformed", raw: statRaw };
  }
  const state = fields[0];
  const startTime = fields[19];
  if (!state || !/^[A-Za-z]$/.test(state) || !startTime || !/^\d+$/.test(startTime)) {
    return { status: "malformed", raw: statRaw };
  }
  return { status: "ok", stat: { state, startTime } };
}

export function assertProcReadable(procRoot = "/proc"): ProcessStat {
  fs.readdirSync(procRoot);
  const selfResult = readProcessStatStrict("self", procRoot);
  if (selfResult.status !== "ok") {
    throw new Error(`Unusable self/stat under ${procRoot}: ${selfResult.status}`);
  }
  return selfResult.stat;
}

/**
 * Confirms a tracked process identity is no longer running.
 * Distinguishes process absence (ENOENT/ESRCH) from malformed /proc/<pid>/stat data:
 * malformed or unreadable records throw rather than reporting the process dead.
 */
export function confirmProcessDead(
  pid: number,
  expectedStartTime: string,
  procRoot = "/proc",
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for confirmProcessDead: ${String(pid)}`);
  }
  if (typeof expectedStartTime !== "string" || !/^\d+$/.test(expectedStartTime)) {
    throw new Error(`Invalid expectedStartTime for confirmProcessDead: ${String(expectedStartTime)}`);
  }
  assertProcReadable(procRoot);
  const result = readProcessStatStrict(pid, procRoot);
  if (result.status === "absent") {
    return true;
  }
  if (result.status === "malformed") {
    throw new Error(`Malformed /proc stat for pid=${pid} under ${procRoot}`);
  }
  if (result.stat.startTime !== expectedStartTime) {
    return true;
  }
  return DEAD_PROCESS_STATES.has(result.stat.state);
}

export async function terminateExternalProcess(
  pid: number,
  expectedStartTime: string,
  timeoutMs = 2000,
  procRoot = "/proc",
): Promise<boolean> {
  if (confirmProcessDead(pid, expectedStartTime, procRoot)) {
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (err: unknown) {
    if (getErrorCode(err) === "ESRCH") {
      return confirmProcessDead(pid, expectedStartTime, procRoot);
    }
    throw err;
  }
  const deadline = performance.now() + timeoutMs;
  while (!confirmProcessDead(pid, expectedStartTime, procRoot)) {
    if (performance.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function hasUnmappedLowerUid(uidMapRaw: string): boolean {
  for (const rawLine of uidMapRaw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length === 3 && parts[1] === INVALID_LINUX_UID) {
      return true;
    }
  }
  return false;
}

function readSelfUidMapUsable(procRoot: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(procRoot, "self", "uid_map"), "utf8");
    return raw.trim().length > 0 && !hasUnmappedLowerUid(raw);
  } catch {
    return false;
  }
}

function getProcessOwnerProof(
  pid: number,
  procRoot: string,
  myUid: number | null,
  canCheckUidMap: boolean,
): "other_user" | "maybe_ours" | "absent" {
  const pidDir = path.join(procRoot, String(pid));
  if (!fs.existsSync(pidDir)) {
    return "absent";
  }

  // Inside an unshared user namespace (e.g. `unshare -c -n`), processes in an
  // ancestor/host user namespace show lower UID 4294967295 (INVALID_UID) in
  // `/proc/<pid>/uid_map`. No child of our process can live in an ancestor
  // user namespace, whereas same-namespace non-dumpable children keep our map.
  if (canCheckUidMap) {
    try {
      const uidMapRaw = fs.readFileSync(path.join(pidDir, "uid_map"), "utf8");
      if (hasUnmappedLowerUid(uidMapRaw)) {
        return "other_user";
      }
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if ((code === "ENOENT" || code === "ESRCH") && !fs.existsSync(pidDir)) {
        return "absent";
      }
    }
  }

  if (myUid === null) {
    return "maybe_ours";
  }

  try {
    const statusRaw = fs.readFileSync(path.join(pidDir, "status"), "utf8");
    const uidMatch = statusRaw.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
    if (uidMatch) {
      const uids = [
        Number(uidMatch[1]),
        Number(uidMatch[2]),
        Number(uidMatch[3]),
        Number(uidMatch[4]),
      ];
      return uids.every((uid) => uid !== myUid) ? "other_user" : "maybe_ours";
    }
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if ((code === "ENOENT" || code === "ESRCH") && !fs.existsSync(pidDir)) {
      return "absent";
    }
  }

  return "maybe_ours";
}

function formatUncertainProcesses(uncertain: UncertainProcessEntry[], procRoot: string): string {
  const details = uncertain
    .map((u) => `pid=${u.pid}${u.startTime ? ` startTime=${u.startTime}` : ""} (${u.reason})`)
    .join(", ");
  return `Uncertain process cleanup under ${procRoot}: could not rule out ${uncertain.length} process(es) [${details}]`;
}

export function scanProcessesByEnvToken(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): EnvTokenScanResult {
  if (
    typeof envName !== "string" ||
    envName.length === 0 ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return { matches: [], uncertain: [] };
  }

  // Fail closed (throw) if /proc, own stat, or own environ is unreadable so sweeps never
  // treat an unreadable /proc as "zero leftover processes".
  const entries = fs.readdirSync(procRoot);
  const selfStat = assertProcReadable(procRoot);
  fs.readFileSync(path.join(procRoot, "self", "environ"), "utf8");

  const minStartTimeRaw = options?.minStartTime ?? selfStat.startTime;
  if (typeof minStartTimeRaw !== "string" || !/^\d+$/.test(minStartTimeRaw)) {
    throw new Error(`Invalid minStartTime for env-token scan: ${String(minStartTimeRaw)}`);
  }
  const minStartTicks = BigInt(minStartTimeRaw);
  const myUid = typeof process.getuid === "function" ? process.getuid() : null;
  const canCheckUidMap = readSelfUidMapUsable(procRoot);

  const needle = `${envName}=${token}`;
  const matches: TrackedProcessIdentity[] = [];
  const uncertain: UncertainProcessEntry[] = [];

  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }

    let statBefore: ProcessStatReadResult;
    try {
      statBefore = readProcessStatStrict(pid, procRoot);
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
        if (owner === "other_user" || owner === "absent") {
          continue;
        }
        uncertain.push({ pid, reason: "unreadable_stat" });
        continue;
      }
      throw err;
    }
    if (statBefore.status === "absent") {
      continue;
    }
    if (statBefore.status === "malformed") {
      const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
      if (owner === "other_user" || owner === "absent") {
        continue;
      }
      uncertain.push({ pid, reason: "malformed_stat" });
      continue;
    }
    if (DEAD_PROCESS_STATES.has(statBefore.stat.state)) {
      continue;
    }

    let envRaw: string;
    try {
      envRaw = fs.readFileSync(path.join(procRoot, String(pid), "environ"), "utf8");
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "ENOENT" || code === "ESRCH") {
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
        if (owner === "other_user" || owner === "absent") {
          continue;
        }
        if (BigInt(statBefore.stat.startTime) < minStartTicks) {
          continue;
        }
        uncertain.push({
          pid,
          startTime: statBefore.stat.startTime,
          reason: "unreadable_environ",
        });
        continue;
      }
      throw err;
    }
    if (!envRaw.split("\0").includes(needle)) {
      continue;
    }

    let statAfter: ProcessStatReadResult;
    try {
      statAfter = readProcessStatStrict(pid, procRoot);
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        uncertain.push({
          pid,
          startTime: statBefore.stat.startTime,
          reason: "unreadable_stat_after",
        });
        continue;
      }
      throw err;
    }
    if (statAfter.status === "absent") {
      continue;
    }
    if (statAfter.status === "malformed") {
      uncertain.push({
        pid,
        startTime: statBefore.stat.startTime,
        reason: "malformed_stat_after",
      });
      continue;
    }
    if (
      statAfter.stat.startTime !== statBefore.stat.startTime ||
      DEAD_PROCESS_STATES.has(statAfter.stat.state)
    ) {
      continue;
    }
    matches.push({ pid, startTime: statAfter.stat.startTime });
  }

  return { matches, uncertain };
}

export function findProcessesByEnvToken(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): TrackedProcessIdentity[] {
  const { matches, uncertain } = scanProcessesByEnvToken(envName, token, procRoot, options);
  if (uncertain.length > 0) {
    throw new Error(formatUncertainProcesses(uncertain, procRoot));
  }
  return matches;
}

export async function stopProcessesByEnvToken(
  envName: string,
  token: string,
  timeoutMs = 3000,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): Promise<TrackedProcessIdentity[]> {
  const stopped: TrackedProcessIdentity[] = [];
  const seen = new Set<string>();
  const deadline = performance.now() + timeoutMs;

  while (true) {
    const { matches, uncertain } = scanProcessesByEnvToken(envName, token, procRoot, options);
    if (matches.length === 0) {
      if (uncertain.length > 0) {
        throw new Error(formatUncertainProcesses(uncertain, procRoot));
      }
      return stopped;
    }
    for (const proc of matches) {
      const remaining = Math.max(200, Math.ceil(deadline - performance.now()));
      const ok = await terminateExternalProcess(proc.pid, proc.startTime, remaining, procRoot);
      if (!ok) {
        throw new Error(`Failed to confirm termination of token-owned process pid=${proc.pid}`);
      }
      const key = `${proc.pid}:${proc.startTime}`;
      if (!seen.has(key)) {
        seen.add(key);
        stopped.push(proc);
      }
    }
    if (performance.now() >= deadline) {
      const remaining = scanProcessesByEnvToken(envName, token, procRoot, options);
      if (remaining.matches.length > 0) {
        throw new Error(
          `Timed out waiting for token-owned processes to terminate: ${remaining.matches.map((m) => m.pid).join(",")}`,
        );
      }
      if (remaining.uncertain.length > 0) {
        throw new Error(formatUncertainProcesses(remaining.uncertain, procRoot));
      }
      return stopped;
    }
  }
}

export function stopProcessesByEnvTokenSync(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): void {
  let matches: TrackedProcessIdentity[];
  try {
    matches = scanProcessesByEnvToken(envName, token, procRoot, options).matches;
  } catch {
    return;
  }
  for (const proc of matches) {
    if (!isSameProcessAlive(proc.pid, proc.startTime)) {
      continue;
    }
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // Ignore ESRCH if already exited.
    }
  }
}

export function inspectFds(pid: number | "self" = "self"): FdInfo[] {
  const result: FdInfo[] = [];
  const entries = fs.readdirSync(`/proc/${pid}/fd`);
  for (const fd of entries) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
      const match = info.match(/^flags:\s*([0-7]+)/m);
      const flagsOct = match ? match[1] ?? null : null;
      const flagsNum = flagsOct !== null ? Number.parseInt(flagsOct, 8) : 0;
      result.push({
        fd,
        target,
        flagsOct,
        cloexec: (flagsNum & 0o2000000) !== 0,
      });
    } catch {
      // Skip transient procfs descriptors (e.g. the readdir fd itself).
    }
  }
  return result;
}

export function isLockFreeNonBlocking(lockPath: string): boolean {
  const res = spawnSync("flock", [
    "--exclusive",
    "--nonblocking",
    "--conflict-exit-code",
    String(CONFLICT_EXIT_CODE),
    lockPath,
    "true",
  ]);
  if (res.error) {
    throw res.error;
  }
  return res.status === 0;
}

export function snapshotFile(filePath: string): FileSnapshot {
  const raw = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    text: raw.toString("utf8"),
  };
}

export function waitForKernelLockRelease(
  lockPath: string,
  timeoutSec = 5,
  tracker?: ProcessTracker,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--timeout", String(timeoutSec), lockPath, "true"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const tracked = tracker?.trackChild(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    if (tracked) {
      void tracked.exited.then((info) => {
        if (info.error) {
          reject(info.error);
        } else if (info.code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `flock wait failed (code=${info.code}, signal=${info.signal}): ${stderr.trim()}`,
            ),
          );
        }
      });
      return;
    }

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`flock wait failed (code=${code}, signal=${signal}): ${stderr.trim()}`));
      }
    });
  });
}

export function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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

export class ProcessTracker {
  readonly ownedChildren = new Set<TrackedChild>();
  readonly trackedExternals = new Map<string, { pid: number; startTime: string; label: string }>();
  readonly activeEnvTokens = new Map<string, { envName: string; token: string }>();
  readonly scratchDirs = new Set<string>();
  private readonly exitHandler: () => void;

  constructor() {
    this.exitHandler = () => {
      this.cleanupSyncLastResort();
    };
    process.on("exit", this.exitHandler);
  }

  dispose(): void {
    process.off("exit", this.exitHandler);
  }

  createScratchDir(prefix = "herdr-captain-s1a-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.scratchDirs.add(dir);
    return dir;
  }

  registerScratchDir(dir: string): void {
    this.scratchDirs.add(dir);
  }

  trackChild(child: ChildProcess): TrackedChild {
    let exitedFlag = false;
    let handle!: TrackedChild;

    const exited = new Promise<ChildExitInfo>((resolve) => {
      const settle = (info: ChildExitInfo): void => {
        if (exitedFlag) {
          return;
        }
        exitedFlag = true;
        this.ownedChildren.delete(handle);
        resolve(info);
      };
      child.once("error", (err) => {
        settle({ code: null, signal: null, error: err });
      });
      child.once("exit", (code, signal) => {
        settle({ code, signal });
      });
    });

    const ensureStopped = async (): Promise<void> => {
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
    this.ownedChildren.add(handle);
    return handle;
  }

  trackExternal(pid: number, startTime: string | null | undefined, label: string): void {
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof startTime !== "string" ||
      startTime.length === 0
    ) {
      return;
    }
    this.trackedExternals.set(`${pid}:${startTime}`, { pid, startTime, label });
  }

  retireExternalIfDead(pid: number, startTime: string): boolean {
    if (confirmProcessDead(pid, startTime)) {
      this.trackedExternals.delete(`${pid}:${startTime}`);
      return true;
    }
    return false;
  }

  async stopExternalAndRetire(pid: number, startTime: string, label = "external"): Promise<void> {
    const stopped = await terminateExternalProcess(pid, startTime, 2000);
    if (!stopped) {
      throw new Error(`Failed to confirm termination of ${label} process pid=${pid}`);
    }
    this.trackedExternals.delete(`${pid}:${startTime}`);
  }

  registerEnvToken(envName: string, token: string): void {
    this.activeEnvTokens.set(`${envName}=${token}`, { envName, token });
  }

  async stopAndRetireEnvToken(envName: string, token: string): Promise<TrackedProcessIdentity[]> {
    const stopped = await stopProcessesByEnvToken(envName, token, 3000);
    this.activeEnvTokens.delete(`${envName}=${token}`);
    return stopped;
  }

  spawnWorker(args: string[], extraEnv?: Record<string, string>): WorkerHandle {
    const child = spawn(process.execPath, [OWNER_WORKER_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

    child.stdin?.on("error", () => {
      // Suppress EPIPE if worker exits before stdin closes.
    });

    let exitedFlag = false;
    const lines: Array<Record<string, unknown>> = [];
    const lineWaiters: Array<{
      resolve: (val: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }> = [];
    let stdoutBuf = "";
    let stderrBuf = "";

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
        if (typeof parsed.holderPid === "number" && typeof parsed.holderStartTime === "string") {
          this.trackExternal(parsed.holderPid, parsed.holderStartTime, "holder");
        }
        if (typeof parsed.childPid === "number" && typeof parsed.childStartTime === "string") {
          this.trackExternal(parsed.childPid, parsed.childStartTime, "detached-child");
        }
        const waiter = lineWaiters.shift();
        if (waiter) {
          waiter.resolve(parsed);
        } else {
          lines.push(parsed);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    let handle!: WorkerHandle;

    const exited = new Promise<ChildExitInfo>((resolve) => {
      const settleExit = (info: ChildExitInfo, message: string): void => {
        if (exitedFlag) {
          return;
        }
        exitedFlag = true;
        this.ownedChildren.delete(handle);
        while (lineWaiters.length > 0) {
          const waiter = lineWaiters.shift();
          waiter?.reject(new Error(message));
        }
        resolve(info);
      };

      child.once("error", (err) => {
        settleExit(
          { code: null, signal: null, error: err, stderr: stderrBuf.trim() },
          `Worker spawn error: ${err.message}`,
        );
      });

      child.once("exit", (code, signal) => {
        settleExit(
          { code, signal, stderr: stderrBuf.trim() },
          `Worker exited before emitting expected line (code=${code}, signal=${signal}, stderr=${stderrBuf.trim()})`,
        );
      });
    });

    const nextEvent = (timeoutMs = 5000): Promise<Record<string, unknown>> => {
      const existing = lines.shift();
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
          const idx = lineWaiters.indexOf(entry);
          if (idx !== -1) {
            lineWaiters.splice(idx, 1);
          }
          reject(
            new Error(
              `Timed out waiting for worker event after ${timeoutMs}ms (stderr=${stderrBuf.trim()})`,
            ),
          );
        }, timeoutMs);
        lineWaiters.push(entry);
      });
    };

    const sendLine = (text: string): void => {
      child.stdin?.write(`${text}\n`);
    };

    const releaseAndWait = async (): Promise<ChildExitInfo> => {
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.write("release\n");
          child.stdin.end();
        }
      } catch {
        // Ignore if already closed.
      }
      return exited;
    };

    const ensureStopped = async (): Promise<void> => {
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
      nextEvent,
      sendLine,
      releaseAndWait,
      ensureStopped,
      exited,
    };
    this.ownedChildren.add(handle);
    return handle;
  }

  async runTryOnce(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ event: Record<string, unknown>; exit: ChildExitInfo }> {
    const worker = this.spawnWorker(["--mode", "try-once", ...args], extraEnv);
    try {
      const event = await worker.nextEvent();
      const exit = await worker.exited;
      if (typeof event.holderPid === "number" && typeof event.holderStartTime === "string") {
        this.retireExternalIfDead(event.holderPid, event.holderStartTime);
      }
      return { event, exit };
    } finally {
      await worker.ensureStopped();
    }
  }

  async cleanupAll(): Promise<void> {
    const errors: unknown[] = [];

    for (const entry of [...this.ownedChildren]) {
      try {
        await entry.ensureStopped();
      } catch (err) {
        errors.push(err);
      }
    }

    for (const entry of [...this.trackedExternals.values()]) {
      try {
        await this.stopExternalAndRetire(entry.pid, entry.startTime, entry.label);
      } catch (err) {
        errors.push(err);
      }
    }

    for (const entry of [...this.activeEnvTokens.values()]) {
      try {
        await this.stopAndRetireEnvToken(entry.envName, entry.token);
      } catch (err) {
        errors.push(err);
      }
    }

    for (const dir of [...this.scratchDirs]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        this.scratchDirs.delete(dir);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Cleanup failed for ${errors.length} tracked resource(s)`);
    }
  }

  cleanupSyncLastResort(): void {
    for (const entry of [...this.ownedChildren]) {
      if (!entry.hasExited()) {
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // Ignore ESRCH on last-resort exit hook.
        }
      }
    }
    for (const entry of [...this.trackedExternals.values()]) {
      if (isSameProcessAlive(entry.pid, entry.startTime)) {
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch {
          // Ignore ESRCH on last-resort exit hook.
        }
      }
    }
    for (const entry of [...this.activeEnvTokens.values()]) {
      stopProcessesByEnvTokenSync(entry.envName, entry.token);
    }
    for (const dir of [...this.scratchDirs]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore last-resort cleanup error on exit.
      }
    }
  }
}
