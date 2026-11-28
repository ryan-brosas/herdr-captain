import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODULE_INSTANCE_ID: string = crypto.randomUUID();
export const REGISTRY_SYMBOL: symbol = Symbol.for("herdr-captain.owner-lease.registry.v1");
export const CONFLICT_EXIT_CODE = 200;

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_RELEASE_TIMEOUT_MS = 2000;
const MAX_READY_LINE_BYTES = 1024;
const DEAD_PROCESS_STATES = new Set(["Z", "X", "x"]);

export type LeaseErrorCode =
  | "owner_conflict"
  | "lease_acquire_error"
  | "lease_revoked"
  | "identity_mismatch";

export interface OwnerRecord {
  readonly schemaVersion: 1;
  readonly projectKey: string;
  readonly epoch: number;
  readonly pid: number;
  readonly holderPid: number;
  readonly acquiredAt: string;
}

export interface ProcessStat {
  readonly state: string;
  readonly startTime: string;
}

export interface LeaseRegistryEntry {
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly epoch: number;
  readonly holderPid: number;
  readonly moduleInstanceId: string;
  readonly revokeAndClose: () => Promise<void>;
}

export interface AcquireLeaseOptions {
  projectKey: string;
  stateRoot: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
}

export interface EnqueueStep<TWrite = unknown, TEffect = unknown> {
  write?: () => TWrite | Promise<TWrite>;
  effect?: (writeResult: TWrite) => TEffect | Promise<TEffect>;
}

export interface EnqueueResult<TWrite = unknown, TEffect = unknown> {
  writeResult: TWrite;
  effectResult: TEffect;
}

export interface OwnerLease {
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly epoch: number;
  readonly pid: number;
  readonly holderPid: number;
  readonly holderStartTime: string;
  readonly moduleInstanceId: string;
  readonly ownerRecord: OwnerRecord;
  isRevoked: () => boolean;
  isHolderAlive: () => boolean;
  assertValid: () => void;
  enqueue: <TWrite = unknown, TEffect = unknown>(
    step?: EnqueueStep<TWrite, TEffect>,
  ) => Promise<EnqueueResult<TWrite, TEffect>>;
  revoke: () => Promise<void>;
  release: () => Promise<void>;
}

interface HolderExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface SpawnedHolder {
  child: ChildProcess;
  pid: number;
  exitedPromise: Promise<HolderExitInfo>;
  isExited: () => boolean;
  getExitInfo: () => HolderExitInfo | null;
}

type GlobalWithLeaseRegistry = typeof globalThis & Record<symbol, unknown>;

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;
  readonly details: unknown;

  constructor(code: LeaseErrorCode, message: string, details: unknown = undefined) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.details = details;
  }
}

export function getGlobalLeaseRegistry(): Map<string, LeaseRegistryEntry> {
  const globalObj = globalThis as GlobalWithLeaseRegistry;
  let registry = globalObj[REGISTRY_SYMBOL];
  if (!(registry instanceof Map)) {
    registry = new Map<string, LeaseRegistryEntry>();
    globalObj[REGISTRY_SYMBOL] = registry;
  }
  return registry as Map<string, LeaseRegistryEntry>;
}

function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

export function readOwnerRecord(stateRoot: string): OwnerRecord | null {
  const ownerJsonPath = path.join(stateRoot, "owner.json");
  let raw: string;
  try {
    raw = fs.readFileSync(ownerJsonPath, "utf8");
  } catch (err: unknown) {
    if (getErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new LeaseError("identity_mismatch", "Malformed owner.json", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LeaseError("identity_mismatch", "Invalid owner.json schema");
  }

  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.projectKey !== "string" ||
    record.projectKey.length === 0 ||
    typeof record.epoch !== "number" ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 1 ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.holderPid !== "number" ||
    !Number.isSafeInteger(record.holderPid) ||
    record.holderPid <= 0 ||
    typeof record.acquiredAt !== "string" ||
    record.acquiredAt.length === 0
  ) {
    throw new LeaseError("identity_mismatch", "Invalid owner.json schema");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    projectKey: record.projectKey,
    epoch: record.epoch,
    pid: record.pid,
    holderPid: record.holderPid,
    acquiredAt: record.acquiredAt,
  });
}

function writeOwnerRecordAtomic(stateRoot: string, record: OwnerRecord): void {
  const ownerJsonPath = path.join(stateRoot, "owner.json");
  const tmpName = `.owner.json.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(stateRoot, tmpName);
  const payload = `${JSON.stringify(record, null, 2)}\n`;

  let fd: number | undefined;
  let createdTmp = false;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    createdTmp = true;
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tmpPath, ownerJsonPath);
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup path.
      }
    }
    if (createdTmp) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore temp removal error on cleanup path.
      }
    }
    throw err;
  }

  const dirFd = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

export function readProcessStat(pid: number): ProcessStat | null {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  let statRaw: string;
  try {
    statRaw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ENOENT" || code === "ESRCH") {
      return null;
    }
    throw err;
  }

  const closeParen = statRaw.lastIndexOf(")");
  if (closeParen === -1 || closeParen + 2 >= statRaw.length || statRaw[closeParen + 1] !== " ") {
    return null;
  }
  const fields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    return null;
  }
  const state = fields[0];
  const startTime = fields[19];
  if (typeof state !== "string" || state.length === 0) {
    return null;
  }
  if (typeof startTime !== "string" || !/^\d+$/.test(startTime)) {
    return null;
  }
  return { state, startTime };
}

export function isSameProcessAlive(
  pid: number,
  expectedStartTime: string | null | undefined,
): boolean {
  if (typeof expectedStartTime !== "string" || !/^\d+$/.test(expectedStartTime)) {
    return false;
  }
  let info: ProcessStat | null;
  try {
    info = readProcessStat(pid);
  } catch {
    // Unreadable /proc fails closed: never treat an unreadable process stat as alive.
    return false;
  }
  if (info === null || info.startTime !== expectedStartTime) {
    return false;
  }
  return !DEAD_PROCESS_STATES.has(info.state);
}

function safeEndStdin(child: ChildProcess): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    return;
  }
  try {
    stdin.end();
  } catch {
    // Ignore pipe errors if holder already exited.
  }
}

async function closeHolderAndWait(
  child: ChildProcess,
  exitedPromise: Promise<HolderExitInfo>,
  releaseTimeoutMs: number,
): Promise<void> {
  safeEndStdin(child);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    exitedPromise.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), releaseTimeoutMs);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  if (timedOut) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore ESRCH if child exited right as timer fired.
    }
    await exitedPromise;
  }
}

function spawnFlockHolder(
  lockPath: string,
  acquireTimeoutMs: number,
  releaseTimeoutMs: number,
): Promise<SpawnedHolder> {
  return new Promise((resolve, reject) => {
    // --no-fork executes the non-forking holder in-place so one PID owns the lock fd.
    // --conflict-exit-code separates owner_conflict from holder or filesystem errors.
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
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if not started.
      }
      reject(new LeaseError("lease_acquire_error", "Holder process did not open piped stdio"));
      return;
    }

    stdin.on("error", () => {
      // Suppress EPIPE/ECONNRESET if the holder exits unexpectedly.
    });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let exited = false;
    let exitInfo: HolderExitInfo | null = null;

    let resolveExited!: (info: HolderExitInfo) => void;
    const exitedPromise = new Promise<HolderExitInfo>((res) => {
      resolveExited = res;
    });

    const markExited = (info: HolderExitInfo): void => {
      if (!exited) {
        exited = true;
        exitInfo = info;
        resolveExited(info);
      }
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      safeEndStdin(child);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if already gone.
        }
      }
      void exitedPromise.then(() => {
        reject(
          new LeaseError(
            "lease_acquire_error",
            `Timed out waiting for holder ready line after ${acquireTimeoutMs}ms`,
          ),
        );
      });
    }, acquireTimeoutMs);

    const finishReject = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const closeAndReject = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void closeHolderAndWait(child, exitedPromise, releaseTimeoutMs).finally(() => {
        reject(err);
      });
    };

    stderr.on("data", (chunk: Buffer | string) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    });

    stdout.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newlineIndex = stdoutBuf.indexOf("\n");
      if (newlineIndex === -1) {
        if (stdoutBuf.length > MAX_READY_LINE_BYTES) {
          closeAndReject(
            new LeaseError("lease_acquire_error", "Holder stdout exceeded ready line limit"),
          );
        }
        return;
      }
      const line = stdoutBuf.slice(0, newlineIndex).replace(/\r$/, "");
      if (line !== "ready") {
        closeAndReject(
          new LeaseError("lease_acquire_error", `Unexpected holder ready line: ${JSON.stringify(line)}`),
        );
        return;
      }
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        closeAndReject(new LeaseError("lease_acquire_error", "Holder process has no valid PID"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.resume();
      stderr.resume();
      resolve({
        child,
        pid,
        exitedPromise,
        isExited: () => exited,
        getExitInfo: () => exitInfo,
      });
    });

    child.once("error", (err: Error) => {
      markExited({ code: null, signal: null, error: err });
      finishReject(new LeaseError("lease_acquire_error", `Failed to spawn flock: ${err.message}`));
    });

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      markExited({ code, signal });

      if (!settled) {
        if (code === CONFLICT_EXIT_CODE) {
          finishReject(new LeaseError("owner_conflict", `Owner lease already held for ${lockPath}`));
        } else {
          finishReject(
            new LeaseError(
              "lease_acquire_error",
              `Holder exited before ready (code=${code}, signal=${signal}): ${stderrBuf.trim()}`,
              { code, signal, stderr: stderrBuf.trim() },
            ),
          );
        }
      }
    });
  });
}

export async function acquireLease({
  projectKey,
  stateRoot,
  acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
  releaseTimeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
}: AcquireLeaseOptions): Promise<OwnerLease> {
  if (typeof projectKey !== "string" || projectKey.length === 0) {
    throw new LeaseError("lease_acquire_error", "projectKey must be a non-empty string");
  }
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    throw new LeaseError("lease_acquire_error", "stateRoot must be a non-empty string");
  }
  if (
    typeof acquireTimeoutMs !== "number" ||
    !Number.isFinite(acquireTimeoutMs) ||
    acquireTimeoutMs <= 0
  ) {
    throw new LeaseError("lease_acquire_error", "acquireTimeoutMs must be a positive finite number");
  }
  if (
    typeof releaseTimeoutMs !== "number" ||
    !Number.isFinite(releaseTimeoutMs) ||
    releaseTimeoutMs <= 0
  ) {
    throw new LeaseError("lease_acquire_error", "releaseTimeoutMs must be a positive finite number");
  }

  const registry = getGlobalLeaseRegistry();
  const existing = registry.get(projectKey);
  if (existing) {
    await existing.revokeAndClose();
  }

  fs.mkdirSync(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "owner.lock");
  const holder = await spawnFlockHolder(lockPath, acquireTimeoutMs, releaseTimeoutMs);

  let registryEntry: LeaseRegistryEntry | null = null;
  try {
    let holderStat: ProcessStat | null;
    try {
      holderStat = readProcessStat(holder.pid);
    } catch (err: unknown) {
      throw new LeaseError("lease_acquire_error", "Failed to read holder /proc stat", {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    if (
      holder.isExited() ||
      holderStat === null ||
      DEAD_PROCESS_STATES.has(holderStat.state) ||
      holderStat.startTime.length === 0
    ) {
      throw new LeaseError(
        "lease_acquire_error",
        "Failed to verify live holder identity from /proc stat",
      );
    }

    const holderStartTime = holderStat.startTime;
    const prev = readOwnerRecord(stateRoot);
    if (prev !== null && prev.projectKey !== projectKey) {
      throw new LeaseError(
        "identity_mismatch",
        `owner.json projectKey mismatch: expected ${projectKey}, found ${prev.projectKey}`,
      );
    }

    const epoch = (prev ? prev.epoch : 0) + 1;
    if (!Number.isSafeInteger(epoch)) {
      throw new LeaseError("identity_mismatch", "owner.json epoch exceeds Number.MAX_SAFE_INTEGER");
    }

    if (holder.isExited() || !isSameProcessAlive(holder.pid, holderStartTime)) {
      throw new LeaseError("lease_acquire_error", "Owner lease holder exited before owner.json write");
    }

    const ownerRecord: OwnerRecord = Object.freeze({
      schemaVersion: 1 as const,
      projectKey,
      epoch,
      pid: process.pid,
      holderPid: holder.pid,
      acquiredAt: new Date().toISOString(),
    });
    writeOwnerRecordAtomic(stateRoot, ownerRecord);

    const localEpoch = ownerRecord.epoch;
    let revoked = false;
    let queueTail: Promise<void> = Promise.resolve();
    let revokePromise: Promise<void> | null = null;

    const drainQueue = async (): Promise<void> => {
      let drainedTail: Promise<void>;
      do {
        drainedTail = queueTail;
        await drainedTail;
      } while (queueTail !== drainedTail);
    };

    const isHolderAlive = (): boolean =>
      !holder.isExited() && isSameProcessAlive(holder.pid, holderStartTime);

    const assertValid = (): void => {
      if (revoked) {
        throw new LeaseError("lease_revoked", "Owner lease has been revoked");
      }
      if (!isHolderAlive()) {
        revoked = true;
        throw new LeaseError("lease_revoked", "Owner lease holder is no longer alive");
      }
      let diskRecord: OwnerRecord | null;
      try {
        diskRecord = readOwnerRecord(stateRoot);
      } catch (err: unknown) {
        revoked = true;
        if (err instanceof LeaseError) {
          throw err;
        }
        throw new LeaseError("lease_revoked", "Failed to read owner.json", {
          cause: err instanceof Error ? err.message : String(err),
        });
      }
      if (
        diskRecord === null ||
        diskRecord.projectKey !== projectKey ||
        diskRecord.epoch !== localEpoch
      ) {
        revoked = true;
        throw new LeaseError(
          "lease_revoked",
          `Owner lease epoch mismatch: local=${localEpoch}, disk=${diskRecord ? diskRecord.epoch : "missing"}`,
        );
      }
    };

    const enqueue = <TWrite = unknown, TEffect = unknown>({
      write,
      effect,
    }: EnqueueStep<TWrite, TEffect> = {}): Promise<EnqueueResult<TWrite, TEffect>> => {
      const step = queueTail.then(async (): Promise<EnqueueResult<TWrite, TEffect>> => {
        if (write) {
          assertValid();
          const writeResult = await write();
          if (effect) {
            assertValid();
            const effectResult = await effect(writeResult);
            return { writeResult, effectResult };
          }
          return { writeResult, effectResult: undefined as TEffect };
        }
        assertValid();
        const effectResult = effect
          ? await effect(undefined as TWrite)
          : (undefined as TEffect);
        return { writeResult: undefined as TWrite, effectResult };
      });

      queueTail = step.then(
        () => {},
        () => {},
      );
      return step;
    };

    const revokeAndClose = (): Promise<void> => {
      // Rule (d): set revoked synchronously first, drain serialized queue,
      // then close holder stdin and await exit.
      revoked = true;
      if (revokePromise !== null) {
        return revokePromise;
      }

      revokePromise = (async () => {
        await drainQueue();
        await closeHolderAndWait(holder.child, holder.exitedPromise, releaseTimeoutMs);

        if (registry.get(projectKey) === registryEntry) {
          registry.delete(projectKey);
        }
      })();

      return revokePromise;
    };

    registryEntry = {
      projectKey,
      stateRoot,
      epoch: localEpoch,
      holderPid: holder.pid,
      moduleInstanceId: MODULE_INSTANCE_ID,
      revokeAndClose,
    };
    registry.set(projectKey, registryEntry);

    void holder.exitedPromise.then(async () => {
      revoked = true;
      await drainQueue();
      if (registry.get(projectKey) === registryEntry) {
        registry.delete(projectKey);
      }
    });

    return {
      projectKey,
      stateRoot,
      epoch: localEpoch,
      pid: process.pid,
      holderPid: holder.pid,
      holderStartTime,
      moduleInstanceId: MODULE_INSTANCE_ID,
      ownerRecord,
      isRevoked: () => revoked,
      isHolderAlive,
      assertValid,
      enqueue,
      revoke: revokeAndClose,
      release: revokeAndClose,
    };
  } catch (err: unknown) {
    if (registryEntry !== null && registry.get(projectKey) === registryEntry) {
      registry.delete(projectKey);
    }
    await closeHolderAndWait(holder.child, holder.exitedPromise, releaseTimeoutMs);
    throw err;
  }
}
