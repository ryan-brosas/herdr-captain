import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLease,
  getGlobalLeaseRegistry,
  isSameProcessAlive,
  LeaseError,
  readOwnerRecord,
  readProcessStat,
  type EnqueueResult,
  type EnqueueStep,
  type OwnerLease,
} from "../../src/lease.ts";
import { createDeferred, type ProcessTracker } from "./process.ts";

export interface ControlFailureResult {
  error: Error;
  message: string;
}

/**
 * Runs a negative control and requires it to fail for its specific intended cause.
 * Any unrelated error or unexpected pass fails this assertion.
 */
export async function assertControlFailed(
  runControl: () => Promise<unknown>,
  expectedCause: RegExp,
  stageLabel: string,
): Promise<ControlFailureResult> {
  let caught: unknown = undefined;
  let threw = false;
  try {
    await runControl();
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.equal(
    threw,
    true,
    `Negative control unexpectedly passed (${stageLabel})`,
  );
  const error = caught instanceof Error ? caught : new Error(String(caught));
  const detail = `${error.name}: ${error.message}`;
  assert.match(
    detail,
    expectedCause,
    `Negative control failed for an unintended reason (${stageLabel}) — did not match expected cause ${expectedCause}; got: ${detail}`,
  );
  return { error, message: detail };
}

/**
 * Reusable Check-4 controlled-revocation verifier.
 * Runs against the real `src/lease.ts` lease (passes) and against a broken adapter
 * in `ctrl-1` that sets `revoked` after draining (must fail with the intended assertion).
 */
export async function verifyControlledRevocationDrain(
  lease: OwnerLease,
  opts: {
    stateRoot: string;
    projectKey: string;
    tracker: ProcessTracker;
    expectLockReleasedAfter?: boolean;
  },
): Promise<{ trace: string[] }> {
  const { stateRoot, projectKey, tracker, expectLockReleasedAfter = true } = opts;
  const item0WriteFile = path.join(stateRoot, "item0-write.ok");
  const forbiddenWriteMarker = path.join(stateRoot, "forbidden-write.marker");
  const forbiddenEffectMarker = path.join(stateRoot, "forbidden-effect.marker");

  const trace: string[] = [];
  const item0Entered = createDeferred();
  const releaseItem0Gate = createDeferred();
  const pendingSteps: Array<Promise<unknown>> = [];
  let pendingRevoke: Promise<void> | null = null;

  try {
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
    pendingSteps.push(p0);

    await item0Entered.promise;

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
    pendingSteps.push(...queuedPromises);

    const revokePromise = lease.revoke();
    pendingRevoke = revokePromise;

    // Rule (d): revoked MUST be set synchronously BEFORE queue drain completes.
    assert.equal(
      lease.isRevoked(),
      true,
      "revoked flag was not set synchronously before queue drain",
    );
    trace.push("revoke:flag_set");

    // Rule (d): owner.lock stays held during drain.
    assert.equal(
      isSameProcessAlive(lease.holderPid, lease.holderStartTime),
      true,
      "holder exited before queue drained",
    );
    const duringDrain = await tracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    assert.equal(
      duringDrain.event.code,
      "owner_conflict",
      "lock released prematurely before queue drained",
    );
    assert.equal(duringDrain.exit.code, 2);
    trace.push("during_drain:lock_still_held");

    // Item 4 enqueued AFTER revoke() started must also fail closed.
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
    pendingSteps.push(p4);

    releaseItem0Gate.resolve();

    const settled = await Promise.allSettled([p0, ...queuedPromises, p4]);
    await revokePromise;
    pendingSteps.length = 0;
    pendingRevoke = null;
    trace.push("revoke:drained_and_holder_exited");

    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      assert.ok(outcome !== undefined);
      assert.equal(outcome.status, "rejected", `item${i} unexpectedly succeeded after withdrawal`);
      assert.ok(outcome.reason instanceof LeaseError, `item${i} did not reject with LeaseError`);
      assert.equal(
        outcome.reason.code,
        "lease_revoked",
        `item${i} rejected with ${outcome.reason.code}`,
      );
    }

    assert.equal(fs.existsSync(item0WriteFile), true, "item0 pre-withdrawal write missing");
    assert.equal(fs.existsSync(forbiddenWriteMarker), false, "forbidden-write.marker appeared");
    assert.equal(fs.existsSync(forbiddenEffectMarker), false, "forbidden-effect.marker appeared");
    assert.equal(
      tracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime),
      true,
      "holder still alive after revoke resolved",
    );

    if (expectLockReleasedAfter) {
      const afterRevoke = await tracker.runTryOnce([
        "--state-root",
        stateRoot,
        "--project-key",
        projectKey,
      ]);
      assert.equal(afterRevoke.exit.code, 0);
      assert.equal(afterRevoke.event.event, "acquired");
      assert.equal(afterRevoke.event.epoch, lease.epoch + 1);
    }

    return { trace };
  } finally {
    releaseItem0Gate.resolve();
    if (pendingSteps.length > 0) {
      await Promise.allSettled(pendingSteps);
    }
    if (pendingRevoke !== null) {
      await pendingRevoke.catch(() => {});
    }
  }
}

/**
 * Broken adapter (in tests only, never in src/) for ctrl-1:
 * wraps a real lease's holder, but sets `revoked` only AFTER draining the queue.
 */
export function createBrokenRevokedAfterDrainAdapter(realLease: OwnerLease): OwnerLease {
  let brokenRevoked = false;
  let queueTail: Promise<void> = Promise.resolve();
  let revokePromise: Promise<void> | null = null;

  const assertValidBroken = (): void => {
    if (brokenRevoked) {
      throw new LeaseError("lease_revoked", "Owner lease has been revoked");
    }
    realLease.assertValid();
  };

  const enqueueBroken = <TWrite = unknown, TEffect = unknown>({
    write,
    effect,
  }: EnqueueStep<TWrite, TEffect> = {}): Promise<EnqueueResult<TWrite, TEffect>> => {
    const step = queueTail.then(async () => {
      assertValidBroken();
      const writeResult = write ? await write() : (undefined as TWrite);
      if (effect) {
        assertValidBroken();
        const effectResult = await effect(writeResult);
        return { writeResult, effectResult };
      }
      return { writeResult, effectResult: undefined as TEffect };
    });
    queueTail = step.then(
      () => {},
      () => {},
    );
    return step;
  };

  const revokeBroken = (): Promise<void> => {
    if (revokePromise !== null) {
      return revokePromise;
    }
    revokePromise = (async () => {
      // Defect: drains queue BEFORE setting brokenRevoked = true.
      let drainedTail: Promise<void>;
      do {
        drainedTail = queueTail;
        await drainedTail;
      } while (queueTail !== drainedTail);
      brokenRevoked = true;
      await realLease.revoke();
    })();
    return revokePromise;
  };

  return {
    ...realLease,
    isRevoked: () => brokenRevoked,
    assertValid: assertValidBroken,
    enqueue: enqueueBroken,
    revoke: revokeBroken,
    release: revokeBroken,
  };
}

/**
 * Reusable Check-3 reload-handoff verifier.
 * Runs against distinct evaluations of `src/lease.ts` (passes) and against a broken
 * reload adapter in `ctrl-2` that skips awaiting the prior registry handle (fails with owner_conflict).
 */
export async function verifyReloadHandoffStep(opts: {
  lease1: OwnerLease;
  acquireNext: () => Promise<OwnerLease>;
  stateRoot: string;
  projectKey: string;
  tracker: ProcessTracker;
}): Promise<OwnerLease> {
  const { lease1, acquireNext, stateRoot, projectKey, tracker } = opts;
  const lease2 = await acquireNext();
  tracker.trackExternal(lease2.holderPid, lease2.holderStartTime, "reload-holder");

  assert.equal(lease1.isRevoked(), true, "lease1 not marked revoked on reload handoff");
  assert.equal(
    tracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime),
    true,
    "lease1 holder still alive after reload handoff",
  );
  assert.equal(
    isSameProcessAlive(lease2.holderPid, lease2.holderStartTime),
    true,
    "lease2 holder not alive",
  );
  assert.notEqual(lease2.holderPid, lease1.holderPid);
  assert.equal(lease2.epoch, lease1.epoch + 1);

  const registry = getGlobalLeaseRegistry();
  assert.equal(registry.get(projectKey)?.holderPid, lease2.holderPid);

  const diskOwner = readOwnerRecord(stateRoot);
  assert.equal(diskOwner?.epoch, lease2.epoch);
  return lease2;
}

/**
 * Broken adapter (in tests only) for ctrl-2:
 * attempts to acquire a second lease on the same `stateRoot` WITHOUT revoking the
 * existing global registry entry first (simulating skipped reload cleanup).
 */
export async function acquireSkippingRegistryCleanup(
  stateRoot: string,
  realProjectKey: string,
): Promise<OwnerLease> {
  const registry = getGlobalLeaseRegistry();
  const saved = registry.get(realProjectKey);
  registry.delete(realProjectKey);
  try {
    return await acquireLease({ projectKey: realProjectKey, stateRoot });
  } finally {
    if (saved && !registry.has(realProjectKey)) {
      registry.set(realProjectKey, saved);
    }
  }
}

/**
 * Reusable Check-4 unreaped-zombie pre-effect verifier.
 * Kills holder synchronously inside write() without yielding to the JS event loop,
 * waits for kernel lock release and Linux zombie state Z, confirms kill(pid, 0) succeeds,
 * and asserts that the pre-effect guard rejects with LeaseError("lease_revoked", /no longer alive/).
 */
export async function verifyUnreapedZombiePreEffect(
  lease: OwnerLease,
  stateRoot: string,
): Promise<{
  sawRevokedFalseBeforePreEffect: boolean;
  sawZombieState: boolean;
  sawKillZeroOnZombie: boolean;
}> {
  const killWriteOk = path.join(stateRoot, "pre-kill-write.ok");
  const killMarker = path.join(stateRoot, "forbidden-after-holder-kill.marker");
  const lockPath = path.join(stateRoot, "owner.lock");

  let sawRevokedFalseBeforePreEffect = false;
  let sawZombieState = false;
  let sawKillZeroOnZombie = false;

  await assert.rejects(
    () =>
      lease.enqueue({
        write: () => {
          fs.writeFileSync(killWriteOk, `epoch=${lease.epoch}\n`, "utf8");
          process.kill(lease.holderPid, "SIGKILL");
          const waitRes = spawnSync("flock", ["--exclusive", "--timeout", "5", lockPath, "true"]);
          assert.equal(waitRes.status, 0, `synchronous flock release wait failed: ${waitRes.status}`);

          let stat = readProcessStat(lease.holderPid);
          const zDeadline = performance.now() + 500;
          while (stat !== null && stat.state !== "Z" && performance.now() < zDeadline) {
            stat = readProcessStat(lease.holderPid);
          }
          sawRevokedFalseBeforePreEffect = lease.isRevoked() === false;
          sawZombieState = stat !== null && stat.state === "Z";
          try {
            process.kill(lease.holderPid, 0);
            sawKillZeroOnZombie = true;
          } catch {
            sawKillZeroOnZombie = false;
          }
        },
        effect: () => {
          fs.writeFileSync(killMarker, "should-not-effect\n", "utf8");
        },
      }),
    (err: unknown) =>
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
  assert.equal(lease.isRevoked(), true);

  return { sawRevokedFalseBeforePreEffect, sawZombieState, sawKillZeroOnZombie };
}

/**
 * Broken adapter (in tests only) for ctrl-4a / ctrl-4b:
 * replaces ONLY the holder-liveness check in assertValid with either:
 * - "none": omits holder liveness completely (ctrl-4a)
 * - "kill-zero": checks liveness via process.kill(holderPid, 0) (ctrl-4b)
 */
export function createBrokenLivenessAdapter(
  realLease: OwnerLease,
  mode: "none" | "kill-zero",
): OwnerLease {
  let brokenRevoked = false;
  let queueTail: Promise<void> = Promise.resolve();

  const isAliveBroken = (): boolean => {
    if (mode === "none") {
      return true;
    }
    try {
      process.kill(realLease.holderPid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const assertValidBroken = (): void => {
    if (brokenRevoked || realLease.isRevoked()) {
      throw new LeaseError("lease_revoked", "Owner lease has been revoked");
    }
    if (!isAliveBroken()) {
      brokenRevoked = true;
      throw new LeaseError("lease_revoked", "Owner lease holder is no longer alive");
    }
    const diskRecord = readOwnerRecord(realLease.stateRoot);
    if (
      diskRecord === null ||
      diskRecord.projectKey !== realLease.projectKey ||
      diskRecord.epoch !== realLease.epoch
    ) {
      brokenRevoked = true;
      throw new LeaseError("lease_revoked", "Owner lease epoch mismatch");
    }
  };

  const enqueueBroken = <TWrite = unknown, TEffect = unknown>({
    write,
    effect,
  }: EnqueueStep<TWrite, TEffect> = {}): Promise<EnqueueResult<TWrite, TEffect>> => {
    const step = queueTail.then(async () => {
      if (write) {
        assertValidBroken();
        const writeResult = await write();
        if (effect) {
          assertValidBroken();
          const effectResult = await effect(writeResult);
          return { writeResult, effectResult };
        }
        return { writeResult, effectResult: undefined as TEffect };
      }
      assertValidBroken();
      const effectResult = effect ? await effect(undefined as TWrite) : (undefined as TEffect);
      return { writeResult: undefined as TWrite, effectResult };
    });
    queueTail = step.then(
      () => {},
      () => {},
    );
    return step;
  };

  return {
    ...realLease,
    isRevoked: () => brokenRevoked || realLease.isRevoked(),
    isHolderAlive: isAliveBroken,
    assertValid: assertValidBroken,
    enqueue: enqueueBroken,
  };
}
