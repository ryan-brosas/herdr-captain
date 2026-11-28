import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  acquireLease,
  getGlobalLeaseRegistry,
  isSameProcessAlive,
  MODULE_INSTANCE_ID,
  readOwnerRecord,
  REGISTRY_SYMBOL,
  type LeaseRegistryEntry,
} from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  LEASE_SOURCE_PATH,
  setupLeaseSuiteHooks,
  waitUntilCondition,
} from "./helpers/lease-fixtures.ts";
import { verifyReloadHandoffStep } from "./helpers/lease-verifiers.ts";
import {
  createDeferred,
  waitForKernelLockRelease,
  type FdInfo,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

let scratchRoot = "";
const suiteTracker = setupLeaseSuiteHooks((dir) => {
  scratchRoot = dir;
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

describe("Runtime version guard", () => {
  test("assertSupportedBunVersion requires Bun 1.4.0 or newer and parses versions numerically", () => {
    for (const older of ["1.2.14", "1.3.99"]) {
      const escaped = older.replaceAll(".", "\\.");
      expect(() => assertSupportedBunVersion(older)).toThrow(
        new RegExp(`1\\.4\\.0.*${escaped}`),
      );
    }

    for (const supported of ["1.4.0", "1.4.0-canary.1", "1.4.1", "1.10.0", "2.0.0"]) {
      expect(() => assertSupportedBunVersion(supported)).not.toThrow();
    }

    for (const malformed of ["1.4", "", "canary", "v1.4.0"]) {
      const escaped = JSON.stringify(malformed).replaceAll(".", "\\.");
      expect(() => assertSupportedBunVersion(malformed)).toThrow(
        new RegExp(`1\\.4\\.0.*${escaped}`),
      );
    }
  });
});
