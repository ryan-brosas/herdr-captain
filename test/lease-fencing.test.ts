import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
  acquireLease,
  CONFLICT_EXIT_CODE,
  getGlobalLeaseRegistry,
  isSameProcessAlive,
  readOwnerRecord,
  readProcessStat,
  type OwnerLease,
} from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  makeFakeFlockScript,
  makeStatLine,
  setupLeaseSuiteHooks,
  waitUntilCondition,
} from "./helpers/lease-fixtures.ts";
import {
  verifyControlledRevocationDrain,
  verifyUnreapedZombiePreEffect,
} from "./helpers/lease-verifiers.ts";
import {
  createDeferred,
  isLockFreeNonBlocking,
  waitForKernelLockRelease,
  type ProcessTracker,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

let scratchRoot = "";
const suiteTracker = setupLeaseSuiteHooks((dir) => {
  scratchRoot = dir;
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
