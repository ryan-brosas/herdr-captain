import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  claimProject,
  PROJECT_RECORD_FILENAME,
  resolveProjectIdentity,
} from "../src/identity.ts";
import { isSameProcessAlive, readOwnerRecord } from "../src/lease.ts";
import {
  assertRawFileUnchanged,
  createIdentityTestContext,
  initGitRepo,
  snapshotRawFile,
} from "./helpers/identity-fixtures.ts";
import { confirmProcessDead, isLockFreeNonBlocking } from "./helpers/process.ts";

describe("project identity owner lease release after malformed record and primary write error (proof 6)", () => {
  test("proof 6: malformed JSON project.json refuses with invalid_project_record, leaves bytes unchanged, and releases owner lease while refused process stays alive; second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-malformed-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-malformed-json"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "p6-malformed-init");
      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      await first.lease.release();

      const malformedBytes = Buffer.from("{not valid json\n", "utf8");
      fs.writeFileSync(projectPath, malformedBytes);
      const beforeSnap = snapshotRawFile(projectPath);
      assert.equal(Buffer.compare(beforeSnap.bytes, malformedBytes), 0);

      const refused = ctx.spawnIdentityWorker([
        "--worker-id",
        "refused-malformed-json",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--stay-alive-on-error",
        "1",
      ]);
      const failEvent = await refused.nextEvent();
      assert.equal(failEvent.event, "claim_failed");
      assert.equal(failEvent.code, "invalid_project_record");
      if (typeof failEvent.message !== "string") {
        assert.fail(`Expected string message in claim_failed, got: ${String(failEvent.message)}`);
      }
      assert.ok(
        failEvent.message.includes("Malformed JSON"),
        `Expected Malformed JSON message, got: ${failEvent.message}`,
      );

      const ownerAfterRefusal = readOwnerRecord(first.stateRoot);
      assert.equal(
        ownerAfterRefusal?.epoch,
        first.lease.epoch + 1,
        "Refused claim must have acquired the owner lease before reading project.json",
      );
      assert.equal(ownerAfterRefusal?.pid, refused.pid);

      assertRawFileUnchanged(projectPath, beforeSnap, "malformed project.json bytes");

      // Refused worker MUST stay alive while a second process acquires the lease at once.
      assert.equal(
        isSameProcessAlive(refused.pid, refused.startTime),
        true,
        "Refused worker must stay alive to prove lease.release() freed the lock",
      );

      const second = await ctx.runTryOnceAndTrack(first.stateRoot, first.projectKey);
      assert.equal(
        second.exit.code,
        0,
        `Second process must acquire lease at once (got event=${String(second.event.event)} code=${String(second.event.code)})`,
      );
      assert.equal(second.event.event, "acquired");
      assert.equal(
        isSameProcessAlive(refused.pid, refused.startTime),
        true,
        "Refused worker must still be alive after second process acquires the lease",
      );

      refused.sendCommand("exit");
      assert.equal((await refused.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: primary write error with valid owner lease removes temporary, leaves no project.json, and releases owner lease while worker stays alive; second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-write-error-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-primary-write-error"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);
      const lockPath = path.join(stateRoot, "owner.lock");

      const worker = ctx.spawnIdentityWorker([
        "--worker-id",
        "primary-write-error",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "fail-write-paused",
        "--stay-alive-on-error",
        "1",
      ]);

      const paused = await worker.nextEvent();
      assert.equal(paused.event, "paused");
      assert.equal(paused.point, "fail-write-paused");
      if (
        typeof paused.holderPid !== "number" ||
        typeof paused.holderStartTime !== "string" ||
        typeof paused.tmpPath !== "string"
      ) {
        assert.fail("Pause event must report holderPid, holderStartTime, and tmpPath");
      }
      const { holderPid, holderStartTime, tmpPath } = paused;
      assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0, "holderPid must be positive");
      assert.ok(holderStartTime.length > 0, "holderStartTime must be non-empty");
      assert.ok(tmpPath.length > 0, "tmpPath must be non-empty");
      assert.equal(fs.existsSync(tmpPath), true, "Temporary file must exist at pause");
      assert.equal(
        isSameProcessAlive(holderPid, holderStartTime),
        true,
        "Lock holder must be alive at pause",
      );
      assert.equal(isLockFreeNonBlocking(lockPath), false, "Lock must be held at pause");

      worker.resumePause("go");
      const failed = await worker.nextEvent();
      assert.equal(failed.event, "claim_failed");
      assert.equal(failed.code, "ENOSPC");
      assert.equal(failed.tmpPath, tmpPath);
      assert.equal(failed.unlinksAfterPause, 1, "Valid lease must remove its own temporary");

      // Worker MUST stay alive while a second process acquires the lease at once.
      assert.equal(
        isSameProcessAlive(worker.pid, worker.startTime),
        true,
        "Worker must stay alive to prove lease.release() freed the lock",
      );

      const second = await ctx.runTryOnceAndTrack(stateRoot, live.projectKey);
      assert.equal(
        second.exit.code,
        0,
        `Second process must acquire lease at once (got event=${String(second.event.event)} code=${String(second.event.code)})`,
      );
      assert.equal(second.event.event, "acquired");
      assert.equal(
        isSameProcessAlive(worker.pid, worker.startTime),
        true,
        "Worker must still be alive after second process acquires the lease",
      );
      assert.equal(
        confirmProcessDead(holderPid, holderStartTime),
        true,
        "Lock holder reported at pause must be confirmed dead while first worker stays alive",
      );

      assert.equal(
        fs.existsSync(projectPath),
        false,
        "No project.json may exist after primary write error",
      );
      assert.equal(fs.existsSync(tmpPath), false, "Temporary file reported at pause must be gone");

      worker.sendCommand("exit");
      assert.equal((await worker.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });
});
