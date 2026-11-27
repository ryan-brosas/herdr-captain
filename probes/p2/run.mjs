#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireLease,
  formatError,
  getGlobalLeaseRegistry,
  isProcessAliveNonZombie,
  isSameProcessAlive,
  LeaseError,
  readOwnerRecord,
  readProcessStat,
  resolveProjectIdentity,
  stopProcessesByEnvToken,
  stopProcessesByEnvTokenSync,
  terminateExternalProcess,
} from "./lease.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(HERE, "owner-worker.mjs");
const LEASE_SOURCE_PATH = path.join(HERE, "lease.mjs");

const ownedChildren = new Set();
const trackedExternals = new Map();
const activeEnvTokens = new Map();
let activeScratchRoot = null;
let fatalErrorOccurred = false;
let fatalShutdownPromise = null;

function registerEnvToken(envName, token) {
  activeEnvTokens.set(`${envName}=${token}`, { envName, token });
}

async function stopAndRetireEnvToken(envName, token) {
  await stopProcessesByEnvToken(envName, token, 3000);
  activeEnvTokens.delete(`${envName}=${token}`);
}

function removeActiveScratchRoot() {
  if (activeScratchRoot !== null) {
    const target = activeScratchRoot;
    fs.rmSync(target, { recursive: true, force: true });
    activeScratchRoot = null;
  }
}

function externalKey(pid, startTime) {
  return `${pid}:${startTime}`;
}

function trackExternal(pid, startTime, label) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
    return;
  }
  trackedExternals.set(externalKey(pid, startTime), { pid, startTime, label });
}

function retireExternalIfDead(pid, startTime) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
    return false;
  }
  if (!isSameProcessAlive(pid, startTime)) {
    trackedExternals.delete(externalKey(pid, startTime));
    return true;
  }
  return false;
}

async function stopExternalAndRetire(pid, startTime, label = "external") {
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
    return;
  }
  const key = externalKey(pid, startTime);
  const stopped = await terminateExternalProcess(pid, startTime, 2000);
  if (!stopped) {
    throw new Error(`Failed to confirm termination of ${label} process pid=${pid}`);
  }
  trackedExternals.delete(key);
}

async function cleanupAllTracked() {
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
      await stopExternalAndRetire(entry.pid, entry.startTime, entry.label);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const entry of [...activeEnvTokens.values()]) {
    try {
      await stopAndRetireEnvToken(entry.envName, entry.token);
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Cleanup failed for ${errors.length} tracked process(es)`);
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
      await cleanupAllTracked();
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
        // Ignore ESRCH on last-resort exit hook.
      }
    }
  }
  for (const entry of [...activeEnvTokens.values()]) {
    stopProcessesByEnvTokenSync(entry.envName, entry.token);
  }
  try {
    removeActiveScratchRoot();
  } catch {
    // Ignore last-resort cleanup error on exit.
  }
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function spawnWorker(args, extraEnv = undefined) {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  child.stdin.on("error", () => {
    // Suppress EPIPE/ECONNRESET if worker exits while stdin is closing.
  });

  let exitedFlag = false;
  const lines = [];
  const lineWaiters = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
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
      const parsed = JSON.parse(rawLine);
      if (parsed.holderPid && parsed.holderStartTime) {
        trackExternal(parsed.holderPid, parsed.holderStartTime, "holder");
      }
      if (parsed.childPid && parsed.childStartTime) {
        trackExternal(parsed.childPid, parsed.childStartTime, "detached-child");
      }
      if (lineWaiters.length > 0) {
        const waiter = lineWaiters.shift();
        waiter.resolve(parsed);
      } else {
        lines.push(parsed);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  let ownerHandle;

  const exited = new Promise((resolve) => {
    const settleExit = (info, message) => {
      if (exitedFlag) {
        return;
      }
      exitedFlag = true;
      ownedChildren.delete(ownerHandle);
      while (lineWaiters.length > 0) {
        const waiter = lineWaiters.shift();
        waiter.reject(new Error(message));
      }
      resolve(info);
    };

    child.once("error", (err) => {
      settleExit(
        { code: null, signal: null, error: err, stderr: stderrBuf.trim() },
        `Worker spawn error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    child.once("exit", (code, signal) => {
      settleExit(
        { code, signal, stderr: stderrBuf.trim() },
        `Worker exited before emitting expected line (code=${code}, signal=${signal}, stderr=${stderrBuf.trim()})`,
      );
    });
  });

  const nextEvent = (timeoutMs = 5000) => {
    if (lines.length > 0) {
      return Promise.resolve(lines.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = lineWaiters.indexOf(entry);
        if (idx !== -1) {
          lineWaiters.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for worker event after ${timeoutMs}ms (stderr=${stderrBuf.trim()})`));
      }, timeoutMs);
      const entry = {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      lineWaiters.push(entry);
    });
  };

  const sendLine = (text) => {
    child.stdin.write(`${text}\n`);
  };

  const releaseAndWait = async () => {
    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write("release\n");
        child.stdin.end();
      }
    } catch {
      // Ignore if already closed.
    }
    return exited;
  };

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

  ownerHandle = {
    child,
    pid: child.pid,
    hasExited: () => exitedFlag,
    nextEvent,
    sendLine,
    releaseAndWait,
    ensureStopped,
    exited,
  };
  ownedChildren.add(ownerHandle);

  return ownerHandle;
}

async function runTryOnce(args) {
  const worker = spawnWorker(["--mode", "try-once", ...args]);
  try {
    const event = await worker.nextEvent();
    const exit = await worker.exited;
    if (event.holderPid && event.holderStartTime) {
      retireExternalIfDead(event.holderPid, event.holderStartTime);
    }
    return { event, exit };
  } finally {
    await worker.ensureStopped();
  }
}

function waitForKernelLockRelease(lockPath, timeoutSec = 5) {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--timeout", String(timeoutSec), lockPath, "true"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
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

function snapshotFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    text: raw.toString("utf8"),
  };
}

function runGit(args, cwd = undefined) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sanitize(text, scratchRoot) {
  return String(text).split(scratchRoot).join("<scratch>");
}

async function check1OwnerConflict(scratchRoot) {
  const stateRoot = path.join(scratchRoot, "check1");
  const projectKey = "0101010101010101";

  const owner1 = spawnWorker(["--mode", "hold", "--state-root", stateRoot, "--project-key", projectKey]);
  try {
    const acquired1 = await owner1.nextEvent();
    assert.equal(acquired1.event, "acquired");
    assert.equal(acquired1.epoch, 1);
    assert.equal(isSameProcessAlive(acquired1.holderPid, acquired1.holderStartTime), true);

    const ownerJsonPath = path.join(stateRoot, "owner.json");
    const before = snapshotFile(ownerJsonPath);

    const attempt2 = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(attempt2.event.event, "acquire_failed");
    assert.equal(attempt2.event.code, "owner_conflict");
    assert.equal(attempt2.exit.code, 2);

    const after = snapshotFile(ownerJsonPath);
    assert.equal(after.sha256, before.sha256, "owner.json content changed on owner_conflict");
    assert.equal(after.ino, before.ino, "owner.json inode changed on owner_conflict");
    assert.equal(after.mtimeMs, before.mtimeMs, "owner.json mtime changed on owner_conflict");
    assert.equal(isSameProcessAlive(acquired1.holderPid, acquired1.holderStartTime), true, "owner1 holder died after conflict");

    // Prove owner1 still actively holds its lease and can commit queued writes.
    owner1.sendLine("write:owner1-proof.txt");
    const wrote = await owner1.nextEvent();
    assert.equal(wrote.event, "wrote");
    assert.equal(wrote.epoch, 1);
    assert.equal(fs.readFileSync(path.join(stateRoot, "owner1-proof.txt"), "utf8"), "epoch=1\n");

    const exit1 = await owner1.releaseAndWait();
    assert.equal(exit1.code, 0);
    assert.equal(retireExternalIfDead(acquired1.holderPid, acquired1.holderStartTime), true);

    return `owner1(pid=${owner1.pid}, holderPid=${acquired1.holderPid}, epoch=1) held lease; owner2 exited code=${attempt2.exit.code} with code=${attempt2.event.code}; owner.json sha256 unchanged (${before.sha256.slice(0, 12)}); owner1 queued write succeeded after conflict`;
  } finally {
    await owner1.ensureStopped();
  }
}

async function check2Kill9Release(scratchRoot) {
  const stateRoot = path.join(scratchRoot, "check2");
  const projectKey = "0202020202020202";
  const lockPath = path.join(stateRoot, "owner.lock");

  const owner1 = spawnWorker(["--mode", "hold", "--state-root", stateRoot, "--project-key", projectKey]);
  let owner2 = null;
  try {
    const acquired1 = await owner1.nextEvent();
    assert.equal(acquired1.event, "acquired");
    assert.equal(acquired1.epoch, 1);
    assert.equal(isProcessAliveNonZombie(owner1.pid), true);
    assert.equal(isSameProcessAlive(acquired1.holderPid, acquired1.holderStartTime), true);

    const killStart = performance.now();
    process.kill(owner1.pid, "SIGKILL");
    const exit1 = await owner1.exited;
    assert.equal(exit1.signal, "SIGKILL", `expected owner1 SIGKILL, got code=${exit1.code} signal=${exit1.signal}`);

    // Wait via Linux flock(2) kernel waitqueue (zero sleep polling).
    await waitForKernelLockRelease(lockPath, 5);
    const releaseMs = Number((performance.now() - killStart).toFixed(2));

    assert.equal(
      retireExternalIfDead(acquired1.holderPid, acquired1.holderStartTime),
      true,
      `holder1 (pid=${acquired1.holderPid}) still alive after lock release`,
    );

    // Immediately launch owner2 with zero sleep; must acquire on first attempt.
    owner2 = spawnWorker(["--mode", "hold", "--state-root", stateRoot, "--project-key", projectKey]);
    const acquired2 = await owner2.nextEvent();
    const reacquireMs = Number((performance.now() - killStart).toFixed(2));

    assert.equal(acquired2.event, "acquired");
    assert.equal(acquired2.epoch, 2);
    assert.notEqual(acquired2.holderPid, acquired1.holderPid);

    const diskOwner = readOwnerRecord(stateRoot);
    assert.equal(diskOwner.epoch, 2);
    assert.equal(diskOwner.pid, owner2.pid);
    assert.equal(diskOwner.holderPid, acquired2.holderPid);

    // Confirm owner2 really holds the OS lock against a third process.
    const attempt3 = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(attempt3.event.code, "owner_conflict");
    assert.equal(attempt3.exit.code, 2);

    const exit2 = await owner2.releaseAndWait();
    assert.equal(exit2.code, 0);
    assert.equal(retireExternalIfDead(acquired2.holderPid, acquired2.holderStartTime), true);

    return `SIGKILL owner1(pid=${owner1.pid}) -> holder1(pid=${acquired1.holderPid}) exited & kernel lock released in ${releaseMs}ms; owner2(pid=${owner2.pid}, holderPid=${acquired2.holderPid}) acquired epoch=2 (total ${reacquireMs}ms); owner3 blocked with owner_conflict`;
  } finally {
    await owner1.ensureStopped();
    if (owner2) {
      await owner2.ensureStopped();
    }
  }
}

async function loadFreshLeaseModuleInstance(moduleDir, generation) {
  const targetPath = path.join(moduleDir, `lease-instance-${generation}.mjs`);
  fs.copyFileSync(LEASE_SOURCE_PATH, targetPath);
  return import(pathToFileURL(targetPath).href);
}

async function check3SimulatedReload(scratchRoot) {
  const stateRoot = path.join(scratchRoot, "check3");
  const moduleDir = path.join(scratchRoot, "check3-modules");
  fs.mkdirSync(moduleDir, { recursive: true });
  const projectKey = "0303030303030303";

  // Bun strips query strings from file:// ESM specifiers, so copy lease.mjs to distinct
  // scratch module paths to force genuinely separate module evaluations in one process
  // (simulating Pi's jiti moduleCache:false reload).
  const mod1 = await loadFreshLeaseModuleInstance(moduleDir, 1);
  const mod2 = await loadFreshLeaseModuleInstance(moduleDir, 2);
  assert.notEqual(mod1, mod2, "simulated reload failed to produce distinct module bindings");
  assert.notEqual(
    mod1.MODULE_INSTANCE_ID,
    mod2.MODULE_INSTANCE_ID,
    "simulated reload did not re-evaluate module scope",
  );
  assert.notEqual(mod1.LeaseError, mod2.LeaseError, "expected distinct class constructors per module instance");
  assert.equal(mod1.REGISTRY_SYMBOL, mod2.REGISTRY_SYMBOL, "Symbol.for registry key must match across instances");

  let activeLease = null;
  try {
    const lease1 = await mod1.acquireLease({ projectKey, stateRoot });
    activeLease = lease1;
    trackExternal(lease1.holderPid, lease1.holderStartTime, "reload-holder");
    assert.equal(lease1.epoch, 1);

    const registry = getGlobalLeaseRegistry();
    assert.equal(registry.get(projectKey)?.holderPid, lease1.holderPid);

    const conflictBefore = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(conflictBefore.event.code, "owner_conflict");
    assert.equal(conflictBefore.exit.code, 2);

    // Reload: acquire from second module instance WITHOUT calling lease1.release().
    const lease2 = await mod2.acquireLease({ projectKey, stateRoot });
    activeLease = lease2;
    trackExternal(lease2.holderPid, lease2.holderStartTime, "reload-holder");

    assert.equal(lease1.isRevoked(), true, "lease1 not marked revoked on reload handoff");
    assert.equal(retireExternalIfDead(lease1.holderPid, lease1.holderStartTime), true, "lease1 holder still alive after reload handoff");
    assert.equal(isSameProcessAlive(lease2.holderPid, lease2.holderStartTime), true, "lease2 holder not alive");
    assert.notEqual(lease2.holderPid, lease1.holderPid);
    assert.equal(lease2.epoch, 2);
    assert.equal(registry.get(projectKey)?.holderPid, lease2.holderPid);

    // Stale lease1 must fail closed and write nothing.
    const staleMarker = path.join(stateRoot, "stale-reload-write.marker");
    await assert.rejects(
      () =>
        lease1.enqueue({
          write: () => fs.writeFileSync(staleMarker, "stale"),
          effect: () => fs.writeFileSync(staleMarker, "stale"),
        }),
      (err) => err instanceof mod1.LeaseError && err.code === "lease_revoked",
    );
    assert.equal(fs.existsSync(staleMarker), false);

    // External process still gets owner_conflict against reloaded lease2.
    const conflictAfter = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(conflictAfter.event.code, "owner_conflict");
    assert.equal(conflictAfter.exit.code, 2);

    // Stress 10 consecutive simulated reloads with zero sleeps to prove no close-vs-acquire race.
    let prevHolderPid = lease2.holderPid;
    let prevHolderStartTime = lease2.holderStartTime;
    for (let round = 3; round <= 12; round += 1) {
      const nextMod = await loadFreshLeaseModuleInstance(moduleDir, round);
      assert.notEqual(nextMod.MODULE_INSTANCE_ID, activeLease.moduleInstanceId);
      const nextLease = await nextMod.acquireLease({ projectKey, stateRoot });
      trackExternal(nextLease.holderPid, nextLease.holderStartTime, "reload-holder");
      assert.equal(retireExternalIfDead(prevHolderPid, prevHolderStartTime), true);
      assert.equal(nextLease.epoch, round);
      assert.equal(registry.get(projectKey)?.holderPid, nextLease.holderPid);
      prevHolderPid = nextLease.holderPid;
      prevHolderStartTime = nextLease.holderStartTime;
      activeLease = nextLease;
    }

    const diskOwner = readOwnerRecord(stateRoot);
    assert.equal(diskOwner.epoch, 12);
    assert.equal(diskOwner.holderPid, activeLease.holderPid);

    const finalPid = activeLease.holderPid;
    const finalStartTime = activeLease.holderStartTime;
    await activeLease.release();
    assert.equal(retireExternalIfDead(finalPid, finalStartTime), true);
    assert.equal(registry.has(projectKey), false);
    activeLease = null;

    // External process can acquire cleanly once released.
    const externalAfterRelease = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(externalAfterRelease.exit.code, 0);
    assert.equal(externalAfterRelease.event.event, "acquired");
    assert.equal(externalAfterRelease.event.epoch, 13);

    return `[simulated reload; real Pi /reload is another ticket] distinct module instances (${mod1.MODULE_INSTANCE_ID.slice(0, 8)} -> ${mod2.MODULE_INSTANCE_ID.slice(0, 8)}, separate LeaseError constructors) handed off via process-global registry; 12/12 back-to-back reloads succeeded with zero sleeps (epoch 1 -> 12, stale lease1 rejected with lease_revoked)`;
  } finally {
    if (activeLease) {
      const pid = activeLease.holderPid;
      const startTime = activeLease.holderStartTime;
      await activeLease.release();
      retireExternalIfDead(pid, startTime);
    }
  }
}

async function check4WithdrawalQueuedWork(scratchRoot) {
  const stateRoot = path.join(scratchRoot, "check4");
  const projectKey = "0404040404040404";

  const item0WriteFile = path.join(stateRoot, "item0-write.ok");
  const forbiddenWriteMarker = path.join(stateRoot, "forbidden-write.marker");
  const forbiddenEffectMarker = path.join(stateRoot, "forbidden-effect.marker");

  const lease = await acquireLease({ projectKey, stateRoot });
  trackExternal(lease.holderPid, lease.holderStartTime, "check4-holder");

  const seqGate = createDeferred();
  const releaseItem0Gate = createDeferred();

  try {
    // Sub-proof A: verify FIFO serialization (item B never starts before item A finishes).
    const serialTrace = [];
    const seqA = lease.enqueue({
      write: async () => {
        serialTrace.push("A:write");
        await seqGate.promise;
      },
      effect: () => {
        serialTrace.push("A:effect");
      },
    });
    const seqB = lease.enqueue({
      write: () => {
        serialTrace.push("B:write");
      },
      effect: () => {
        serialTrace.push("B:effect");
      },
    });
    seqGate.resolve();
    await Promise.all([seqA, seqB]);
    assert.deepEqual(serialTrace, ["A:write", "A:effect", "B:write", "B:effect"]);

    const trace = [];
    const item0Entered = createDeferred();

    // Item 0 performs its pre-withdrawal write, then pauses before its pre-effect re-check.
    const p0 = lease.enqueue({
      write: async () => {
        fs.writeFileSync(item0WriteFile, `epoch=${lease.epoch}\n`, "utf8");
        trace.push("item0:write");
        item0Entered.resolve();
        await releaseItem0Gate.promise;
        return "item0-wrote";
      },
      effect: () => {
        fs.writeFileSync(forbiddenEffectMarker, "item0-effect-should-not-run\n", "utf8");
        trace.push("item0:effect");
      },
    });

    await item0Entered.promise;

    // Queue items 1..3 behind in-flight item 0.
    const queuedPromises = [1, 2, 3].map((idx) =>
      lease.enqueue({
        write: () => {
          fs.writeFileSync(forbiddenWriteMarker, `item${idx}-write-should-not-run\n`, "utf8");
          trace.push(`item${idx}:write`);
        },
        effect: () => {
          fs.writeFileSync(forbiddenEffectMarker, `item${idx}-effect-should-not-run\n`, "utf8");
          trace.push(`item${idx}:effect`);
        },
      }),
    );

    // Trigger withdrawal while item 0 is in flight and items 1..3 are queued.
    const revokePromise = lease.revoke();

    // Verify revoked flag is set synchronously FIRST, BEFORE drain completes.
    assert.equal(lease.isRevoked(), true, "revoked flag was not set synchronously before queue drain");
    trace.push("revoke:flag_set");

    // Verify holder pipe is NOT closed before queue drains: external owner still gets owner_conflict.
    assert.equal(isSameProcessAlive(lease.holderPid, lease.holderStartTime), true, "holder exited before queue drained");
    const duringDrain = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(duringDrain.event.code, "owner_conflict", "lock released prematurely before queue drained");
    assert.equal(duringDrain.exit.code, 2);
    trace.push("during_drain:lock_still_held");

    // Enqueue item 4 AFTER revoke() started.
    const p4 = lease.enqueue({
      write: () => {
        fs.writeFileSync(forbiddenWriteMarker, "item4-write-should-not-run\n", "utf8");
        trace.push("item4:write");
      },
      effect: () => {
        fs.writeFileSync(forbiddenEffectMarker, "item4-effect-should-not-run\n", "utf8");
        trace.push("item4:effect");
      },
    });

    // Release item 0 so queue drains.
    releaseItem0Gate.resolve();

    const settled = await Promise.allSettled([p0, ...queuedPromises, p4]);
    await revokePromise;
    trace.push("revoke:drained_and_holder_exited");

    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      assert.equal(outcome.status, "rejected", `item${i} unexpectedly succeeded after withdrawal`);
      assert.ok(outcome.reason instanceof LeaseError, `item${i} did not reject with LeaseError`);
      assert.equal(outcome.reason.code, "lease_revoked", `item${i} rejected with ${outcome.reason.code}`);
    }

    assert.equal(fs.existsSync(item0WriteFile), true, "item0 pre-withdrawal write missing");
    assert.equal(fs.existsSync(forbiddenWriteMarker), false, "forbidden-write.marker appeared!");
    assert.equal(fs.existsSync(forbiddenEffectMarker), false, "forbidden-effect.marker appeared!");
    assert.equal(retireExternalIfDead(lease.holderPid, lease.holderStartTime), true, "holder still alive after revoke resolved");

    // Confirm another owner process can now acquire cleanly.
    const afterRevoke = await runTryOnce(["--state-root", stateRoot, "--project-key", projectKey]);
    assert.equal(afterRevoke.exit.code, 0);
    assert.equal(afterRevoke.event.event, "acquired");
    assert.equal(afterRevoke.event.epoch, 2);

    // Sub-proof B (S1): deterministic dead, unreaped zombie holder caught BEFORE exit callback runs.
    const stateRootKill = path.join(scratchRoot, "check4-holder-kill");
    const killWriteOk = path.join(stateRootKill, "pre-kill-write.ok");
    const killMarker = path.join(stateRootKill, "forbidden-after-holder-kill.marker");
    const killLease = await acquireLease({ projectKey: "0404040404040405", stateRoot: stateRootKill });
    trackExternal(killLease.holderPid, killLease.holderStartTime, "check4-kill-holder");
    let sawRevokedFalseBeforePreEffect = false;
    let sawZombieState = false;
    let sawKillZeroOnZombie = false;
    try {
      const lockPathKill = path.join(stateRootKill, "owner.lock");
      await assert.rejects(
        () =>
          killLease.enqueue({
            write: () => {
              fs.writeFileSync(killWriteOk, `epoch=${killLease.epoch}\n`, "utf8");
              // Kill holder and synchronously block in Linux flock(2) waitqueue WITHOUT yielding
              // to the JS event loop so holder exit callbacks have not run yet.
              process.kill(killLease.holderPid, "SIGKILL");
              const waitRes = spawnSync("flock", ["--exclusive", "--timeout", "5", lockPathKill, "true"]);
              assert.equal(waitRes.status, 0, `synchronous flock release wait failed: ${waitRes.status}`);
              // Finish the microsecond kernel exit_files -> exit_notify transition synchronously
              // without yielding to the JS event loop so holder is deterministically in state Z.
              let stat = readProcessStat(killLease.holderPid);
              const zDeadline = performance.now() + 500;
              while (stat !== null && stat.state !== "Z" && performance.now() < zDeadline) {
                stat = readProcessStat(killLease.holderPid);
              }
              sawRevokedFalseBeforePreEffect = killLease.isRevoked() === false;
              sawZombieState = stat !== null && stat.state === "Z";
              try {
                process.kill(killLease.holderPid, 0);
                sawKillZeroOnZombie = true;
              } catch {
                sawKillZeroOnZombie = false;
              }
            },
            effect: () => {
              fs.writeFileSync(killMarker, "should-not-effect\n", "utf8");
            },
          }),
        (err) =>
          err instanceof LeaseError &&
          err.code === "lease_revoked" &&
          err.message.includes("no longer alive"),
        "expected pre-effect check to reject dead unreaped holder with no longer alive",
      );
      assert.equal(sawRevokedFalseBeforePreEffect, true, "exit callback ran before pre-effect liveness guard");
      assert.equal(sawZombieState, true, "expected unreaped zombie state Z before event loop poll");
      assert.equal(sawKillZeroOnZombie, true, "expected kill(pid, 0) to succeed on Linux zombie");
      assert.equal(fs.existsSync(killWriteOk), true);
      assert.equal(fs.existsSync(killMarker), false, "effect ran after dead unreaped holder");
      assert.equal(killLease.isRevoked(), true);
    } finally {
      const pid = killLease.holderPid;
      const startTime = killLease.holderStartTime;
      await killLease.release();
      retireExternalIfDead(pid, startTime);
    }

    // Sub-proof C1 (S1): epoch drift between an authorized write and its effect blocks the effect.
    const stateRootEpochEffect = path.join(scratchRoot, "check4-epoch-effect");
    const epochWriteOk = path.join(stateRootEpochEffect, "authorized-write.ok");
    const epochEffectMarker = path.join(stateRootEpochEffect, "forbidden-effect-after-epoch-drift.marker");
    const epochEffectLease = await acquireLease({ projectKey: "0404040404040406", stateRoot: stateRootEpochEffect });
    trackExternal(epochEffectLease.holderPid, epochEffectLease.holderStartTime, "check4-epoch-effect-holder");
    try {
      await assert.rejects(
        () =>
          epochEffectLease.enqueue({
            write: () => {
              fs.writeFileSync(epochWriteOk, `epoch=${epochEffectLease.epoch}\n`, "utf8");
              const drifted = { ...readOwnerRecord(stateRootEpochEffect), epoch: epochEffectLease.epoch + 1 };
              fs.writeFileSync(
                path.join(stateRootEpochEffect, "owner.json"),
                `${JSON.stringify(drifted, null, 2)}\n`,
                "utf8",
              );
            },
            effect: () => {
              fs.writeFileSync(epochEffectMarker, "should-not-effect\n", "utf8");
            },
          }),
        (err) =>
          err instanceof LeaseError &&
          err.code === "lease_revoked" &&
          err.message.includes("epoch mismatch"),
      );
      assert.equal(fs.existsSync(epochWriteOk), true);
      assert.equal(fs.existsSync(epochEffectMarker), false, "effect ran despite epoch drift after write");
      assert.equal(epochEffectLease.isRevoked(), true);
    } finally {
      const pid = epochEffectLease.holderPid;
      const startTime = epochEffectLease.holderStartTime;
      await epochEffectLease.release();
      retireExternalIfDead(pid, startTime);
    }

    // Sub-proof C2: epoch drift before write blocks both write and effect.
    const stateRootEpochWrite = path.join(scratchRoot, "check4-epoch-write");
    const epochWriteMarker = path.join(stateRootEpochWrite, "forbidden-write-after-epoch-drift.marker");
    const epochWriteLease = await acquireLease({ projectKey: "0404040404040407", stateRoot: stateRootEpochWrite });
    trackExternal(epochWriteLease.holderPid, epochWriteLease.holderStartTime, "check4-epoch-write-holder");
    try {
      const drifted = { ...readOwnerRecord(stateRootEpochWrite), epoch: epochWriteLease.epoch + 1 };
      fs.writeFileSync(
        path.join(stateRootEpochWrite, "owner.json"),
        `${JSON.stringify(drifted, null, 2)}\n`,
        "utf8",
      );
      await assert.rejects(
        () =>
          epochWriteLease.enqueue({
            write: () => fs.writeFileSync(epochWriteMarker, "should-not-write\n", "utf8"),
            effect: () => fs.writeFileSync(epochWriteMarker, "should-not-effect\n", "utf8"),
          }),
        (err) =>
          err instanceof LeaseError &&
          err.code === "lease_revoked" &&
          err.message.includes("epoch mismatch"),
      );
      assert.equal(fs.existsSync(epochWriteMarker), false);
      assert.equal(epochWriteLease.isRevoked(), true);
    } finally {
      const pid = epochWriteLease.holderPid;
      const startTime = epochWriteLease.holderStartTime;
      await epochWriteLease.release();
      retireExternalIfDead(pid, startTime);
    }

    return `FIFO order verified; revoked set synchronously before drain; lock stayed held during drain (owner_conflict); 5/5 post-revocation steps rejected with lease_revoked; forbidden-write.marker and forbidden-effect.marker absent; unreaped zombie holder (stat=Z, kill(0)=true, revoked=false) caught synchronously before exit callback; epoch drift blocked both pre-effect (after authorized write) and pre-write; trace=[${trace.join(" -> ")}]`;
  } finally {
    seqGate.resolve();
    releaseItem0Gate.resolve();
    const pid = lease.holderPid;
    const startTime = lease.holderStartTime;
    await lease.release();
    retireExternalIfDead(pid, startTime);
  }
}

async function check5NonInheritance(scratchRoot) {
  const stateRoot = path.join(scratchRoot, "check5");
  const childPidFile = path.join(scratchRoot, "check5-child.json");
  const projectKey = "0505050505050505";
  const lockPath = path.join(stateRoot, "owner.lock");
  // Pre-assign a unique process-ownership token inherited from fork across detached setsid(),
  // so runner cleanup stops the child even if owner1 dies before publishing anything.
  const childOwnershipToken = `herdr-p2-check5-${crypto.randomUUID()}`;
  registerEnvToken("HERDR_P2_CHILD_TOKEN", childOwnershipToken);

  const owner1 = spawnWorker(
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
    { HERDR_P2_CHILD_TOKEN: childOwnershipToken },
  );
  let owner2 = null;
  let survivingChildPid = null;
  let survivingChildStartTime = null;

  try {
    const spawnedEvt = await owner1.nextEvent();
    assert.equal(spawnedEvt.event, "child_spawned");
    survivingChildPid = spawnedEvt.childPid;
    survivingChildStartTime = spawnedEvt.childStartTime;

    const acquired1 = await owner1.nextEvent();
    assert.equal(acquired1.event, "acquired_with_child");
    assert.equal(acquired1.epoch, 1);
    assert.equal(acquired1.childPid, survivingChildPid);
    assert.equal(acquired1.childStartTime, survivingChildStartTime);

    // Kernel-level proof: every new fd created by acquireLease in parent has O_CLOEXEC.
    const ioFds = acquired1.newParentFds.filter((f) => f.target.startsWith("socket:") || f.target.startsWith("pipe:"));
    assert.ok(ioFds.length > 0, "expected at least one socket/pipe fd opened by holder spawn");
    for (const fdInfo of acquired1.newParentFds) {
      assert.equal(
        fdInfo.cloexec,
        true,
        `parent fd ${fdInfo.fd} (${fdInfo.target}, flags=${fdInfo.flagsOct}) lacked O_CLOEXEC`,
      );
    }

    // Kernel-level proof: surviving child inherited none of the parent's holder fds or any pipe/socket.
    const parentTargets = new Set(acquired1.newParentFds.map((f) => f.target));
    const childStdioByFd = new Map(acquired1.childFds.map((f) => [f.fd, f.target]));
    assert.equal(childStdioByFd.get("0"), "/dev/null", "expected child fd 0 -> /dev/null");
    assert.equal(childStdioByFd.get("1"), "/dev/null", "expected child fd 1 -> /dev/null");
    assert.equal(childStdioByFd.get("2"), "/dev/null", "expected child fd 2 -> /dev/null");
    for (const childFd of acquired1.childFds) {
      assert.equal(
        parentTargets.has(childFd.target),
        false,
        `child inherited parent holder fd target ${childFd.target}`,
      );
      assert.equal(
        childFd.target.startsWith("socket:") || childFd.target.startsWith("pipe:"),
        false,
        `child inherited unexpected socket/pipe fd ${childFd.fd} -> ${childFd.target}`,
      );
    }

    assert.equal(isProcessAliveNonZombie(owner1.pid), true);
    assert.equal(isSameProcessAlive(acquired1.holderPid, acquired1.holderStartTime), true);
    assert.equal(isSameProcessAlive(survivingChildPid, survivingChildStartTime), true);

    // Kill owner1 with real SIGKILL while child stays alive.
    const killStart = performance.now();
    process.kill(owner1.pid, "SIGKILL");
    const exit1 = await owner1.exited;
    assert.equal(exit1.signal, "SIGKILL");

    assert.equal(
      isSameProcessAlive(survivingChildPid, survivingChildStartTime),
      true,
      "child died with owner1; cannot prove non-inheritance",
    );

    await waitForKernelLockRelease(lockPath, 5);
    const releaseMs = Number((performance.now() - killStart).toFixed(2));

    assert.equal(
      retireExternalIfDead(acquired1.holderPid, acquired1.holderStartTime),
      true,
      "holder1 did not exit while child remained alive",
    );
    assert.equal(
      isSameProcessAlive(survivingChildPid, survivingChildStartTime),
      true,
      "child exited before owner2 check",
    );

    owner2 = spawnWorker(["--mode", "hold", "--state-root", stateRoot, "--project-key", projectKey]);
    const acquired2 = await owner2.nextEvent();
    assert.equal(acquired2.event, "acquired");
    assert.equal(acquired2.epoch, 2);
    assert.equal(
      isSameProcessAlive(survivingChildPid, survivingChildStartTime),
      true,
      "child must still be alive when owner2 acquires",
    );

    const exit2 = await owner2.releaseAndWait();
    assert.equal(exit2.code, 0);
    assert.equal(retireExternalIfDead(acquired2.holderPid, acquired2.holderStartTime), true);

    return `parent opened ${ioFds.length} holder socket/pipe fd(s) all with O_CLOEXEC (flags=${ioFds[0].flagsOct}); child(pid=${survivingChildPid}) fds=[${acquired1.childFds.map((f) => `${f.fd}:${f.target}`).join(",")}]; SIGKILL owner1(pid=${owner1.pid}) released lock in ${releaseMs}ms and owner2 acquired epoch=2 while child remained alive`;
  } finally {
    await owner1.ensureStopped();
    if (owner2) {
      await owner2.ensureStopped();
    }
    if (survivingChildPid === null && fs.existsSync(childPidFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(childPidFile, "utf8"));
        survivingChildPid = saved.pid;
        survivingChildStartTime = saved.startTime;
      } catch {
        // Ignore partial or removed pid file.
      }
    }
    if (survivingChildPid !== null && survivingChildStartTime !== null) {
      await stopExternalAndRetire(survivingChildPid, survivingChildStartTime, "detached-child");
    }
    await stopAndRetireEnvToken("HERDR_P2_CHILD_TOKEN", childOwnershipToken);
    fs.rmSync(childPidFile, { force: true });
  }
}

async function check6LinkedWorktrees(scratchRoot) {
  const gitRoot = path.join(scratchRoot, "check6");
  const originRepo = path.join(gitRoot, "origin-repo");
  const mainClone = path.join(gitRoot, "main-clone");
  const wtAlpha = path.join(gitRoot, "wt-alpha");
  const wtBeta = path.join(gitRoot, "completely-different-name");
  const wtBetaLink = path.join(gitRoot, "wt-beta-symlink");
  const separateClone = path.join(gitRoot, "separate-clone");
  const stateBase = path.join(gitRoot, "state-base");

  fs.mkdirSync(originRepo, { recursive: true });
  runGit(["init", "-b", "main"], originRepo);
  fs.writeFileSync(path.join(originRepo, "README.md"), "scratch repo\n", "utf8");
  runGit(["add", "README.md"], originRepo);
  runGit(
    ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "init"],
    originRepo,
  );

  runGit(["clone", originRepo, mainClone]);
  runGit(["worktree", "add", "-b", "branch-alpha", wtAlpha], mainClone);
  runGit(["worktree", "add", "-b", "branch-beta", wtBeta], mainClone);
  fs.symlinkSync(wtBeta, wtBetaLink);
  runGit(["clone", originRepo, separateClone]);

  const idMain = resolveProjectIdentity(mainClone);
  const idAlpha = resolveProjectIdentity(wtAlpha);
  const idBeta = resolveProjectIdentity(wtBeta);
  const idBetaLink = resolveProjectIdentity(wtBetaLink);
  const idSeparate = resolveProjectIdentity(separateClone);

  const expectedCommonDir = fs.realpathSync(path.join(mainClone, ".git"));
  const expectedKey = crypto.createHash("sha256").update(expectedCommonDir, "utf8").digest("hex").slice(0, 16);

  assert.match(idAlpha.projectKey, /^[0-9a-f]{16}$/);
  assert.equal(idMain.projectKey, expectedKey, "main-clone projectKey did not match sha256(realpath(git common dir))");
  assert.equal(idAlpha.projectKey, expectedKey, "wt-alpha projectKey did not match sha256(realpath(git common dir))");
  assert.equal(idBeta.projectKey, expectedKey, "wt-beta projectKey did not match sha256(realpath(git common dir))");
  assert.equal(idBetaLink.projectKey, expectedKey, "wt-beta-symlink projectKey did not match sha256(realpath(git common dir))");
  assert.equal(idAlpha.canonicalCommonDir, idBeta.canonicalCommonDir);
  assert.notEqual(idSeparate.projectKey, expectedKey, "separate clone collided with main clone projectKey");

  const ownerAlpha = spawnWorker(["--mode", "hold", "--cwd", wtAlpha, "--state-base", stateBase]);
  let ownerSeparate = null;
  try {
    const acquiredAlpha = await ownerAlpha.nextEvent();
    assert.equal(acquiredAlpha.event, "acquired");
    assert.equal(acquiredAlpha.projectKey, expectedKey);
    assert.equal(acquiredAlpha.epoch, 1);

    const ownerJsonPath = path.join(stateBase, expectedKey, "owner.json");
    const before = snapshotFile(ownerJsonPath);

    // Second owner from differently named linked worktree must contend for the SAME lease.
    const conflictBeta = await runTryOnce(["--cwd", wtBeta, "--state-base", stateBase]);
    assert.equal(conflictBeta.event.event, "acquire_failed");
    assert.equal(conflictBeta.event.code, "owner_conflict");
    assert.equal(conflictBeta.event.projectKey, expectedKey);
    assert.equal(conflictBeta.exit.code, 2);

    // Symlinked path to wtBeta must also resolve to the exact same key and fail with owner_conflict.
    const conflictLink = await runTryOnce(["--cwd", wtBetaLink, "--state-base", stateBase]);
    assert.equal(conflictLink.event.code, "owner_conflict");
    assert.equal(conflictLink.event.projectKey, expectedKey);
    assert.equal(conflictLink.exit.code, 2);

    const after = snapshotFile(ownerJsonPath);
    assert.equal(after.sha256, before.sha256, "owner.json changed during worktree contention");

    // Separate clone must resolve to a distinct key and acquire without conflict.
    ownerSeparate = spawnWorker(["--mode", "hold", "--cwd", separateClone, "--state-base", stateBase]);
    const acquiredSep = await ownerSeparate.nextEvent();
    assert.equal(acquiredSep.event, "acquired");
    assert.equal(acquiredSep.projectKey, idSeparate.projectKey);
    assert.equal(acquiredSep.epoch, 1);

    const exitAlpha = await ownerAlpha.releaseAndWait();
    assert.equal(exitAlpha.code, 0);
    assert.equal(retireExternalIfDead(acquiredAlpha.holderPid, acquiredAlpha.holderStartTime), true);

    const exitSep = await ownerSeparate.releaseAndWait();
    assert.equal(exitSep.code, 0);
    assert.equal(retireExternalIfDead(acquiredSep.holderPid, acquiredSep.holderStartTime), true);
    ownerSeparate = null;

    // After alpha releases, beta acquires the shared lease cleanly at epoch=2.
    const betaAfterRelease = await runTryOnce(["--cwd", wtBeta, "--state-base", stateBase]);
    assert.equal(betaAfterRelease.exit.code, 0);
    assert.equal(betaAfterRelease.event.event, "acquired");
    assert.equal(betaAfterRelease.event.projectKey, expectedKey);
    assert.equal(betaAfterRelease.event.epoch, 2);

    return `wt-alpha, completely-different-name, wt-beta-symlink, and main-clone all resolved to projectKey=${expectedKey}; beta and symlink both failed with owner_conflict (exit 2) while alpha held lease; separate-clone resolved to distinct key=${idSeparate.projectKey} and acquired independently; after alpha released, beta acquired epoch=2`;
  } finally {
    await ownerAlpha.ensureStopped();
    if (ownerSeparate) {
      await ownerSeparate.ensureStopped();
    }
  }
}

async function main() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-p2-"));
  activeScratchRoot = scratchRoot;
  let passed = 0;
  let failed = 0;

  const checks = [
    { id: "check-1", name: "second owner fails with owner_conflict and leaves owner.json untouched", fn: check1OwnerConflict },
    { id: "check-2", name: "SIGKILL owner closes pipe, holder exits, new owner acquires", fn: check2Kill9Release },
    { id: "check-3", name: "simulated reload in one process closes prior holder via global registry", fn: check3SimulatedReload },
    { id: "check-4", name: "withdrawal sets revoked first, queued work fails closed with lease_revoked", fn: check4WithdrawalQueuedWork },
    { id: "check-5", name: "post-acquisition child does not inherit pipe (O_CLOEXEC + SIGKILL release)", fn: check5NonInheritance },
    { id: "check-6", name: "differently named linked worktrees share projectKey and contend for one lease", fn: check6LinkedWorktrees },
  ];

  try {
    const bunVersion = typeof Bun !== "undefined" ? Bun.version : "not-bun";
    const flockVersion = execFileSync("flock", ["--version"], { encoding: "utf8" }).trim();
    const gitVersion = runGit(["--version"]);
    const platform = `${os.type()} ${os.arch()}`;

    console.log("Probe P2: owner lease lifecycle faults");
    console.log(`runtime: bun ${bunVersion} | ${flockVersion} | ${gitVersion} | ${platform}`);
    console.log("scratchRoot: <scratch>");
    console.log("");

    for (const check of checks) {
      if (fatalErrorOccurred) {
        break;
      }
      const start = performance.now();
      try {
        const detail = await check.fn(scratchRoot);
        const ms = (performance.now() - start).toFixed(1);
        console.log(`PASS [${check.id}] (${ms}ms) ${check.name}`);
        console.log(`  ${sanitize(detail, scratchRoot)}`);
        passed += 1;
      } catch (err) {
        const ms = (performance.now() - start).toFixed(1);
        console.error(`FAIL [${check.id}] (${ms}ms) ${check.name}`);
        console.error(`  ${sanitize(formatError(err), scratchRoot)}`);
        failed += 1;
      }
    }
  } finally {
    await cleanupAllTracked();
    removeActiveScratchRoot();
  }

  if (fatalShutdownPromise !== null) {
    await fatalShutdownPromise;
    return;
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed (total ${checks.length})`);
  process.exit(failed === 0 && !fatalErrorOccurred ? 0 : 1);
}

main().catch(async (err) => {
  try {
    await cleanupAllTracked();
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
