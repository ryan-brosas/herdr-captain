import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  claimProject,
  PROJECT_RECORD_FILENAME,
  resolveProjectIdentity,
  type IdentityFsOps,
} from "../src/identity.ts";
import { isSameProcessAlive, readOwnerRecord } from "../src/lease.ts";
import {
  assertDirUnchanged,
  assertNoFileDeleted,
  assertRawFileUnchanged,
  createIdentityTestContext,
  initGitRepo,
  snapshotDirFiles,
  snapshotRawFile,
} from "./helpers/identity-fixtures.ts";
import { confirmProcessDead } from "./helpers/process.ts";

describe("project identity concurrency, handoff, crashes, and fencing (proofs 1-4)", () => {
  test("proof 1: two processes race at a barrier; one publishes, the other gets owner_conflict and writes nothing, then later reads the winner record", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p1-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-a"), {
        originUrl: "https://example.com/org/repo-a.git",
      });
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const workerA = ctx.spawnIdentityWorker([
        "--worker-id",
        "A",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--wait-before-claim",
        "1",
        "--hold-after-claim",
        "1",
        "--stay-alive-on-error",
        "1",
      ]);
      const workerB = ctx.spawnIdentityWorker([
        "--worker-id",
        "B",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--wait-before-claim",
        "1",
        "--hold-after-claim",
        "1",
        "--stay-alive-on-error",
        "1",
      ]);

      const barrierRecord: string[] = [];
      const [barrierA, barrierB] = await Promise.all([workerA.nextEvent(), workerB.nextEvent()]);
      assert.equal(barrierA.event, "at_barrier");
      assert.equal(barrierB.event, "at_barrier");
      barrierRecord.push(String(barrierA.workerId), String(barrierB.workerId));
      assert.deepEqual(
        barrierRecord.sort(),
        ["A", "B"],
        "Both processes must be recorded at the barrier before either proceeds",
      );

      // Release both workers simultaneously after both are confirmed at the barrier.
      workerA.sendCommand("go");
      workerB.sendCommand("go");

      const [resA, resB] = await Promise.all([workerA.nextEvent(), workerB.nextEvent()]);
      const outcomes = [
        { worker: workerA, event: resA },
        { worker: workerB, event: resB },
      ];
      const winners = outcomes.filter((o) => o.event.event === "claimed");
      const losers = outcomes.filter((o) => o.event.event === "claim_failed");

      assert.equal(winners.length, 1, "Exactly one racing process must publish");
      assert.equal(losers.length, 1, "Exactly one racing process must fail with owner_conflict");

      const winner = winners[0]!;
      const loser = losers[0]!;
      assert.equal(winner.event.published, true, "Winner must publish project.json");
      assert.equal(loser.event.code, "owner_conflict", "Loser must fail with owner_conflict");

      // Only one project.json exists and holds the winner's bytes.
      const entries = fs.readdirSync(stateRoot);
      assert.deepEqual(
        entries.filter((name) => name === PROJECT_RECORD_FILENAME),
        [PROJECT_RECORD_FILENAME],
      );
      const winnerRecordBytes = snapshotRawFile(projectPath);
      assert.deepEqual(JSON.parse(winnerRecordBytes.bytes.toString("utf8")), winner.event.record);

      // Verify a conflicting claim writes nothing while the winner holds the lease.
      const beforeConflictDir = snapshotDirFiles(stateRoot);
      const third = ctx.spawnIdentityWorker([
        "--worker-id",
        "C",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
      ]);
      const thirdEvent = await third.nextEvent();
      const thirdExit = await third.exited;
      assert.equal(thirdEvent.event, "claim_failed");
      assert.equal(thirdEvent.code, "owner_conflict");
      assert.equal(thirdExit.code, 0);
      assertDirUnchanged(stateRoot, beforeConflictDir, "owner_conflict must write nothing");

      // Release the winner and let the loser process claim again.
      winner.worker.sendCommand("release");
      const released = await winner.worker.nextEvent();
      assert.equal(released.event, "released");
      winner.worker.sendCommand("exit");
      const winnerExit = await winner.worker.exited;
      assert.equal(winnerExit.code, 0);
      assert.equal(
        confirmProcessDead(
          Number(winner.event.holderPid),
          String(winner.event.holderStartTime),
        ),
        true,
        "Winner lock holder must exit on release",
      );

      loser.worker.sendCommand("claim_again");
      const loserSecond = await loser.worker.nextEvent();
      assert.equal(loserSecond.event, "claimed");
      assert.equal(loserSecond.published, false, "Loser later claim must verify, not publish");
      assert.deepEqual(loserSecond.record, winner.event.record);
      assertRawFileUnchanged(projectPath, winnerRecordBytes, "winner project.json bytes");

      loser.worker.sendCommand("release");
      const loserReleased = await loser.worker.nextEvent();
      assert.equal(loserReleased.event, "released");
      loser.worker.sendCommand("exit");
      const loserExit = await loser.worker.exited;
      assert.equal(loserExit.code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 2: one process claims twice; lease hands over, record is verified, and nothing is published a second time", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p2-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-handoff"), {
        originUrl: "https://example.com/org/handoff.git",
      });
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "first-claim-holder");
      assert.equal(first.published, true);
      assert.equal(first.lease.epoch, 1);
      assert.equal(first.originWarning, null);

      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      const beforeSnap = snapshotRawFile(projectPath);

      let createTempCalls = 0;
      let linkCalls = 0;
      const spyFs: Partial<IdentityFsOps> = {
        openSync(targetPath, flags, mode) {
          if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
            createTempCalls += 1;
          }
          return fs.openSync(targetPath, flags, mode);
        },
        linkSync(existingPath, newPath) {
          linkCalls += 1;
          return fs.linkSync(existingPath, newPath);
        },
      };

      const second = await claimProject(repoDir, stateBase, { fs: spyFs });
      ctx.trackLease(second.lease, "second-claim-holder");

      // Lease handed over inside one process (section 5 rule (e)).
      assert.equal(first.lease.isRevoked(), true, "First lease must be revoked on handoff");
      assert.equal(
        confirmProcessDead(first.lease.holderPid, first.lease.holderStartTime),
        true,
        "First lock holder must exit on handoff",
      );
      assert.equal(second.lease.epoch, first.lease.epoch + 1);
      assert.notEqual(second.lease.holderPid, first.lease.holderPid);
      assert.equal(
        isSameProcessAlive(second.lease.holderPid, second.lease.holderStartTime),
        true,
        "Second lock holder must be alive",
      );
      assert.equal(readOwnerRecord(second.stateRoot)?.epoch, second.lease.epoch);

      // Record verified and nothing published a second time.
      assert.equal(second.published, false);
      assert.deepEqual(second.record, first.record);
      assert.equal(second.originWarning, null);
      assert.equal(createTempCalls, 0, "Second claim must not create any temporary file");
      assert.equal(linkCalls, 0, "Second claim must not call linkSync");
      assertRawFileUnchanged(projectPath, beforeSnap, "project.json after second claim");

      await second.lease.release();
      assert.equal(
        confirmProcessDead(second.lease.holderPid, second.lease.holderStartTime),
        true,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 3: SIGKILL after lease leaves lease files intact; next claim publishes and deletes no file", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p3a-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-crash-lease"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const worker = ctx.spawnIdentityWorker([
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "after-lease",
      ]);
      const paused = await worker.nextEvent();
      assert.equal(paused.event, "paused");
      assert.equal(paused.point, "after-lease");
      assert.equal(fs.existsSync(projectPath), false, "project.json must not exist yet");

      const beforeKill = snapshotDirFiles(stateRoot);
      assert.equal(beforeKill.entries.includes("owner.lock"), true);
      assert.equal(beforeKill.entries.includes("owner.json"), true);

      const exit = await worker.killWithSigkill();
      assert.equal(exit.signal, "SIGKILL", "Crash test must assert SIGKILL signal");

      await ctx.waitForProcessDead(
        Number(paused.holderPid),
        String(paused.holderStartTime),
      );

      const next = await claimProject(repoDir, stateBase);
      ctx.trackLease(next.lease, "post-crash-after-lease-holder");
      assert.equal(next.published, true, "Next claim must publish project.json");
      assert.equal(fs.existsSync(projectPath), true);
      assertNoFileDeleted(stateRoot, beforeKill);
      await next.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 3: SIGKILL after temporary is written leaves temp intact; next claim publishes and deletes no file", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p3b-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-crash-temp"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const worker = ctx.spawnIdentityWorker([
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "before-link",
      ]);
      const paused = await worker.nextEvent();
      assert.equal(paused.event, "paused");
      assert.equal(paused.point, "before-link");
      const crashedTmpPath = String(paused.tmpPath);
      assert.equal(fs.existsSync(crashedTmpPath), true, "Temporary file must exist before link");
      assert.equal(fs.existsSync(projectPath), false, "project.json must not exist before link");

      const tmpBefore = snapshotRawFile(crashedTmpPath);
      const dirBefore = snapshotDirFiles(stateRoot);

      const exit = await worker.killWithSigkill();
      assert.equal(exit.signal, "SIGKILL", "Crash test must assert SIGKILL signal");

      await ctx.waitForProcessDead(
        Number(paused.holderPid),
        String(paused.holderStartTime),
      );

      const next = await claimProject(repoDir, stateBase);
      ctx.trackLease(next.lease, "post-crash-temp-holder");
      assert.equal(next.published, true, "Next claim must publish project.json");
      assert.equal(fs.existsSync(projectPath), true);
      assertRawFileUnchanged(crashedTmpPath, tmpBefore, "crashed temp file must survive");
      assertNoFileDeleted(stateRoot, dirBefore);
      await next.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 3: SIGKILL after link before temporary removal leaves project.json and temp intact; next claim opens and deletes no file", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p3c-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-crash-link"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const worker = ctx.spawnIdentityWorker([
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "before-unlink",
      ]);
      const paused = await worker.nextEvent();
      assert.equal(paused.event, "paused");
      assert.equal(paused.point, "before-unlink");
      const crashedTmpPath = String(paused.tmpPath);
      assert.equal(fs.existsSync(projectPath), true, "project.json must exist after link");
      assert.equal(fs.existsSync(crashedTmpPath), true, "Temporary file must still exist before unlink");

      const projectBefore = snapshotRawFile(projectPath);
      const tmpBefore = snapshotRawFile(crashedTmpPath);
      const dirBefore = snapshotDirFiles(stateRoot);

      const exit = await worker.killWithSigkill();
      assert.equal(exit.signal, "SIGKILL", "Crash test must assert SIGKILL signal");

      await ctx.waitForProcessDead(
        Number(paused.holderPid),
        String(paused.holderStartTime),
      );

      const next = await claimProject(repoDir, stateBase);
      ctx.trackLease(next.lease, "post-crash-link-holder");
      assert.equal(next.published, false, "Next claim must open existing project.json");
      assertRawFileUnchanged(projectPath, projectBefore, "project.json bytes must stay unchanged");
      assertRawFileUnchanged(crashedTmpPath, tmpBefore, "crashed temp file must survive");
      assertNoFileDeleted(stateRoot, dirBefore);
      await next.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 4: holder killed before link and second owner publishes first; resumed first owner link fails, claim fails with lease_revoked, second record unchanged", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p4a-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-p4a"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const owner1 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner1",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "before-link",
      ]);
      const paused1 = await owner1.nextEvent();
      assert.equal(paused1.event, "paused");
      assert.equal(paused1.point, "before-link");
      const holderPid1 = Number(paused1.holderPid);
      const holderStart1 = String(paused1.holderStartTime);

      // Kill the lock holder from outside by the PID the lease reported and wait until gone.
      await ctx.killHolderAndWaitDead(holderPid1, holderStart1);

      // Second owner acquires and publishes while first owner is paused before link.
      const owner2 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner2",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--hold-after-claim",
        "1",
      ]);
      const claimed2 = await owner2.nextEvent();
      assert.equal(claimed2.event, "claimed");
      assert.equal(claimed2.published, true);
      const owner2Bytes = snapshotRawFile(projectPath);

      // Resume first owner: its link fails with EEXIST, claim fails with lease_revoked, record unchanged.
      owner1.resumePause("go");
      const failed1 = await owner1.nextEvent();
      const exit1 = await owner1.exited;
      assert.equal(failed1.event, "claim_failed");
      assert.equal(failed1.linkErrno, "EEXIST", "First owner linkSync must fail with EEXIST");
      assert.equal(failed1.linkSucceeded, false);
      assert.equal(failed1.code, "lease_revoked", "First owner must fail with lease_revoked");
      assert.equal(exit1.code, 0);
      assertRawFileUnchanged(projectPath, owner2Bytes, "Second owner project.json must be unchanged");

      owner2.sendCommand("release");
      const rel2 = await owner2.nextEvent();
      assert.equal(rel2.event, "released");
      owner2.sendCommand("exit");
      assert.equal((await owner2.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 4: holder killed before link and first owner link lands first; first claim fails with lease_revoked, second owner verifies that record and opens", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p4b-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-p4b"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const owner1 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner1",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "before-link",
      ]);
      const paused1 = await owner1.nextEvent();
      assert.equal(paused1.event, "paused");
      assert.equal(paused1.point, "before-link");
      await ctx.killHolderAndWaitDead(Number(paused1.holderPid), String(paused1.holderStartTime));

      // Second owner acquires the lease and pauses before its own link so both stand at the barrier.
      const owner2 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner2",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "before-link",
        "--hold-after-claim",
        "1",
      ]);
      const paused2 = await owner2.nextEvent();
      assert.equal(paused2.event, "paused");
      assert.equal(paused2.point, "before-link");
      const barrierRecord = [
        `${String(paused1.workerId)}:${String(paused1.point)}`,
        `${String(paused2.workerId)}:${String(paused2.point)}`,
      ];
      assert.deepEqual(
        barrierRecord,
        ["owner1:before-link", "owner2:before-link"],
        "Both owners must be recorded at the pre-link barrier before either resumes",
      );

      // Resume first owner first: its link lands, yet step 7 rejects with lease_revoked.
      owner1.resumePause("go");
      const failed1 = await owner1.nextEvent();
      const exit1 = await owner1.exited;
      assert.equal(failed1.event, "claim_failed");
      assert.equal(failed1.linkSucceeded, true, "First owner link must land first");
      assert.equal(failed1.code, "lease_revoked", "First owner claim must still fail with lease_revoked");
      assert.equal(exit1.code, 0);
      assert.equal(fs.existsSync(projectPath), true);
      const firstLinkBytes = snapshotRawFile(projectPath);

      // Resume second owner: hits EEXIST, verifies first owner's linked record, and opens.
      owner2.resumePause("go");
      const claimed2 = await owner2.nextEvent();
      assert.equal(claimed2.event, "claimed");
      assert.equal(claimed2.linkErrno, "EEXIST");
      assert.equal(claimed2.published, false, "Second owner must verify existing record, not publish");
      assertRawFileUnchanged(projectPath, firstLinkBytes, "Linked project.json bytes must stay unchanged");

      owner2.sendCommand("release");
      const rel2 = await owner2.nextEvent();
      assert.equal(rel2.event, "released");
      owner2.sendCommand("exit");
      assert.equal((await owner2.exited).code, 0);

      // A fresh subsequent claim also finds, verifies, and opens the same record.
      const third = await claimProject(repoDir, stateBase);
      ctx.trackLease(third.lease, "post-p4b-holder");
      assert.equal(third.published, false);
      assertRawFileUnchanged(projectPath, firstLinkBytes);
      await third.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 4: holder killed during verification of existing record and second owner opens; first claim fails with lease_revoked and record bytes unchanged", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p4c-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-p4c"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const initial = await claimProject(repoDir, stateBase);
      ctx.trackLease(initial.lease, "p4c-initial-holder");
      assert.equal(initial.published, true);
      const projectPath = path.join(initial.stateRoot, PROJECT_RECORD_FILENAME);
      const initialBytes = snapshotRawFile(projectPath);
      await initial.lease.release();

      const owner1 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner1",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "during-verify",
      ]);
      const paused1 = await owner1.nextEvent();
      assert.equal(paused1.event, "paused");
      assert.equal(paused1.point, "during-verify");

      // Kill holder externally and confirm death.
      await ctx.killHolderAndWaitDead(Number(paused1.holderPid), String(paused1.holderStartTime));

      // Second owner opens and verifies the existing record.
      const owner2 = ctx.spawnIdentityWorker([
        "--worker-id",
        "owner2",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--hold-after-claim",
        "1",
      ]);
      const claimed2 = await owner2.nextEvent();
      assert.equal(claimed2.event, "claimed");
      assert.equal(claimed2.published, false);

      // Resume first owner: verification finishes, then step 7 fails with lease_revoked.
      owner1.resumePause("go");
      const failed1 = await owner1.nextEvent();
      const exit1 = await owner1.exited;
      assert.equal(failed1.event, "claim_failed");
      assert.equal(failed1.code, "lease_revoked");
      assert.equal(exit1.code, 0);
      assertRawFileUnchanged(projectPath, initialBytes, "Existing project.json bytes must stay unchanged");

      owner2.sendCommand("release");
      const rel2 = await owner2.nextEvent();
      assert.equal(rel2.event, "released");
      owner2.sendCommand("exit");
      assert.equal((await owner2.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });
});
