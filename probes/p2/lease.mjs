import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODULE_INSTANCE_ID = crypto.randomUUID();
export const REGISTRY_SYMBOL = Symbol.for("herdr-captain.owner-lease.registry.v1");
export const CONFLICT_EXIT_CODE = 200;

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_RELEASE_TIMEOUT_MS = 2000;

export class LeaseError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.details = details;
  }
}

export function getGlobalLeaseRegistry() {
  let registry = globalThis[REGISTRY_SYMBOL];
  if (!(registry instanceof Map)) {
    registry = new Map();
    globalThis[REGISTRY_SYMBOL] = registry;
  }
  return registry;
}

export function resolveProjectIdentity(cwd) {
  let rawCommonDir;
  try {
    rawCommonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new LeaseError("not_git_repo", `Failed to resolve git common dir for ${cwd}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!rawCommonDir) {
    throw new LeaseError("not_git_repo", `Empty git common dir for ${cwd}`);
  }

  const resolvedCommonDir = path.resolve(cwd, rawCommonDir);
  const canonicalCommonDir = fs.realpathSync(resolvedCommonDir);
  const commonDirSha256 = crypto.createHash("sha256").update(canonicalCommonDir, "utf8").digest("hex");
  const projectKey = commonDirSha256.slice(0, 16);

  return {
    canonicalCommonDir,
    commonDirSha256,
    projectKey,
  };
}

export function readOwnerRecord(stateRoot) {
  const ownerJsonPath = path.join(stateRoot, "owner.json");
  let raw;
  try {
    raw = fs.readFileSync(ownerJsonPath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LeaseError("identity_mismatch", "Malformed owner.json", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.projectKey !== "string" ||
    !Number.isInteger(parsed.epoch) ||
    parsed.epoch < 1
  ) {
    throw new LeaseError("identity_mismatch", "Invalid owner.json schema");
  }

  return parsed;
}

function writeOwnerRecordAtomic(stateRoot, record) {
  const ownerJsonPath = path.join(stateRoot, "owner.json");
  const tmpName = `.owner.json.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(stateRoot, tmpName);
  const payload = `${JSON.stringify(record, null, 2)}\n`;

  let fd;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tmpPath, ownerJsonPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup path.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp removal error on cleanup path.
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

export function readProcessStat(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  let statRaw;
  try {
    statRaw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && (err.code === "ENOENT" || err.code === "ESRCH")) {
      return null;
    }
    throw err;
  }

  const closeParen = statRaw.lastIndexOf(")");
  if (closeParen === -1 || closeParen + 2 >= statRaw.length) {
    return null;
  }
  const fields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    return null;
  }
  return {
    state: fields[0],
    startTime: fields[19],
  };
}

export function isProcessAliveNonZombie(pid) {
  const info = readProcessStat(pid);
  if (info === null) {
    return false;
  }
  return info.state !== "Z" && info.state !== "X" && info.state !== "x";
}

export function isSameProcessAlive(pid, expectedStartTime) {
  if (typeof expectedStartTime !== "string" || expectedStartTime.length === 0) {
    return false;
  }
  const info = readProcessStat(pid);
  if (info === null || info.startTime !== expectedStartTime) {
    return false;
  }
  return info.state !== "Z" && info.state !== "X" && info.state !== "x";
}

export async function terminateExternalProcess(pid, expectedStartTime, timeoutMs = 2000) {
  if (!isSameProcessAlive(pid, expectedStartTime)) {
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ESRCH") {
      return true;
    }
    throw err;
  }
  const deadline = performance.now() + timeoutMs;
  while (isSameProcessAlive(pid, expectedStartTime)) {
    if (performance.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function safeEndStdin(child) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    return;
  }
  try {
    child.stdin.end();
  } catch {
    // Ignore pipe errors if holder already exited.
  }
}

async function closeHolderAndWait(child, exitedPromise, releaseTimeoutMs) {
  safeEndStdin(child);

  let timer;
  const timedOut = await Promise.race([
    exitedPromise.then(() => false),
    new Promise((resolve) => {
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

function spawnFlockHolder(lockPath, acquireTimeoutMs) {
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

    child.stdin.on("error", () => {
      // Suppress EPIPE/ECONNRESET if the holder exits unexpectedly.
    });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let exited = false;
    let exitInfo = null;

    let resolveExited;
    const exitedPromise = new Promise((res) => {
      resolveExited = res;
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if already gone.
        }
      }
      exitedPromise.then(() => {
        reject(new LeaseError("lease_acquire_error", `Timed out waiting for holder ready line after ${acquireTimeoutMs}ms`));
      });
    }, acquireTimeoutMs);

    const finishReject = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stderr.on("data", (chunk) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString("utf8");
      }
    });

    child.stdout.on("data", (chunk) => {
      if (settled) {
        return;
      }
      stdoutBuf += chunk.toString("utf8");
      const newlineIndex = stdoutBuf.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = stdoutBuf.slice(0, newlineIndex).replace(/\r$/, "");
      if (line !== "ready") {
        safeEndStdin(child);
        finishReject(new LeaseError("lease_acquire_error", `Unexpected holder ready line: ${JSON.stringify(line)}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.resume();
      child.stderr.resume();
      resolve({
        child,
        exitedPromise,
        isExited: () => exited,
        getExitInfo: () => exitInfo,
      });
    });

    child.once("error", (err) => {
      exited = true;
      exitInfo = { code: null, signal: null, error: err };
      resolveExited(exitInfo);
      finishReject(new LeaseError("lease_acquire_error", `Failed to spawn flock: ${err.message}`));
    });

    child.once("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolveExited(exitInfo);

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
}) {
  if (typeof projectKey !== "string" || projectKey.length === 0) {
    throw new LeaseError("lease_acquire_error", "projectKey must be a non-empty string");
  }
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    throw new LeaseError("lease_acquire_error", "stateRoot must be a non-empty string");
  }

  const registry = getGlobalLeaseRegistry();
  const existing = registry.get(projectKey);
  if (existing) {
    await existing.revokeAndClose();
  }

  fs.mkdirSync(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "owner.lock");
  const holder = await spawnFlockHolder(lockPath, acquireTimeoutMs);
  const holderStartTime = readProcessStat(holder.child.pid)?.startTime ?? null;

  let ownerRecord;
  try {
    const prev = readOwnerRecord(stateRoot);
    if (prev !== null && prev.projectKey !== projectKey) {
      throw new LeaseError(
        "identity_mismatch",
        `owner.json projectKey mismatch: expected ${projectKey}, found ${prev.projectKey}`,
      );
    }

    const epoch = (prev ? prev.epoch : 0) + 1;
    ownerRecord = {
      schemaVersion: 1,
      projectKey,
      epoch,
      pid: process.pid,
      holderPid: holder.child.pid,
      acquiredAt: new Date().toISOString(),
    };
    writeOwnerRecordAtomic(stateRoot, ownerRecord);
  } catch (err) {
    await closeHolderAndWait(holder.child, holder.exitedPromise, releaseTimeoutMs);
    throw err;
  }

  let revoked = false;
  let queueTail = Promise.resolve();
  let revokePromise = null;

  const isHolderAlive = () =>
    !holder.isExited() &&
    (holderStartTime !== null
      ? isSameProcessAlive(holder.child.pid, holderStartTime)
      : isProcessAliveNonZombie(holder.child.pid));

  const assertValid = () => {
    if (revoked) {
      throw new LeaseError("lease_revoked", "Owner lease has been revoked");
    }
    if (!isHolderAlive()) {
      revoked = true;
      throw new LeaseError("lease_revoked", "Owner lease holder is no longer alive");
    }
    const diskRecord = readOwnerRecord(stateRoot);
    if (
      diskRecord === null ||
      diskRecord.projectKey !== projectKey ||
      diskRecord.epoch !== ownerRecord.epoch
    ) {
      revoked = true;
      throw new LeaseError(
        "lease_revoked",
        `Owner lease epoch mismatch: local=${ownerRecord.epoch}, disk=${diskRecord ? diskRecord.epoch : "missing"}`,
      );
    }
  };

  const enqueue = ({ write, effect } = {}) => {
    const step = queueTail.then(async () => {
      assertValid();
      const writeResult = write ? await write() : undefined;
      assertValid();
      const effectResult = effect ? await effect(writeResult) : undefined;
      return { writeResult, effectResult };
    });

    queueTail = step.then(
      () => {},
      () => {},
    );
    return step;
  };

  let registryEntry;

  const revokeAndClose = () => {
    // Rule (d): set revoked synchronously first, drain serialized queue, then close holder stdin and await exit.
    revoked = true;
    if (revokePromise !== null) {
      return revokePromise;
    }

    revokePromise = (async () => {
      let drainedTail;
      do {
        drainedTail = queueTail;
        await drainedTail;
      } while (queueTail !== drainedTail);

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
    epoch: ownerRecord.epoch,
    holderPid: holder.child.pid,
    moduleInstanceId: MODULE_INSTANCE_ID,
    revokeAndClose,
  };
  registry.set(projectKey, registryEntry);

  holder.exitedPromise.then(() => {
    revoked = true;
    if (registry.get(projectKey) === registryEntry) {
      registry.delete(projectKey);
    }
  });

  return {
    projectKey,
    stateRoot,
    epoch: ownerRecord.epoch,
    pid: process.pid,
    holderPid: holder.child.pid,
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
}
