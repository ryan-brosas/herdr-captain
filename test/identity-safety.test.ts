import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  claimProject,
  MAX_PROJECT_RECORD_BYTES,
  PROJECT_RECORD_FILENAME,
  PROJECT_SCHEMA_VERSION,
  resolveProjectIdentity,
  type IdentityFsOps,
  type ProjectRecord,
} from "../src/identity.ts";
import { acquireLease, isSameProcessAlive, readOwnerRecord } from "../src/lease.ts";
import {
  addOrphanRootCommit,
  assertDirUnchanged,
  assertRawFileUnchanged,
  createIdentityTestContext,
  createUnbornHeadBesideBranch,
  expectErrorCode,
  initGitRepo,
  runGit,
  snapshotDirFiles,
  snapshotRawFile,
} from "./helpers/identity-fixtures.ts";
import { confirmProcessDead, isLockFreeNonBlocking } from "./helpers/process.ts";

describe("project identity safety, leftovers, refusal release, verification, and unborn repos (proofs 5-8)", () => {
  test("proof 5: colliding temporary fails exclusive creation, removes nothing, releases lease, and survives subsequent claims", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p5a-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-collide"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);
      const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);

      const collidingPayload = Buffer.from("existing-colliding-temp-do-not-delete\n", "utf8");
      let collidingPath: string | null = null;
      let unlinkCalls = 0;

      const collidingFs: Partial<IdentityFsOps> = {
        openSync(targetPath, flags, mode) {
          const pathStr = String(targetPath);
          if (
            collidingPath === null &&
            path.basename(pathStr).startsWith(`.${PROJECT_RECORD_FILENAME}.tmp.`)
          ) {
            // Place the colliding file at the exact name this claim uses before real O_EXCL open.
            fs.writeFileSync(pathStr, collidingPayload);
            collidingPath = pathStr;
          }
          return fs.openSync(targetPath, flags, mode);
        },
        unlinkSync(targetPath) {
          unlinkCalls += 1;
          fs.unlinkSync(targetPath);
        },
      };

      await expectErrorCode(
        () => claimProject(repoDir, stateBase, { fs: collidingFs }),
        "EEXIST",
        "Colliding temp name must fail O_EXCL creation with EEXIST",
      );

      assert.ok(collidingPath !== null, "Collision hook must observe exact temp filename");
      assert.equal(unlinkCalls, 0, "Failed exclusive creation must remove nothing");
      assert.equal(fs.existsSync(projectPath), false, "project.json must not be published");

      const collidingSnap = snapshotRawFile(collidingPath);
      assert.equal(Buffer.compare(collidingSnap.bytes, collidingPayload), 0);
      assert.equal(
        isLockFreeNonBlocking(path.join(stateRoot, "owner.lock")),
        true,
        "Lease must be released after failed exclusive temp creation",
      );

      // Next claim publishes project.json; colliding temp survives.
      const published = await claimProject(repoDir, stateBase);
      ctx.trackLease(published.lease, "post-collision-publish-holder");
      assert.equal(published.published, true);
      assertRawFileUnchanged(collidingPath, collidingSnap, "colliding temp after publish");
      await published.lease.release();

      // Repeat open verifies project.json; colliding temp still survives.
      const opened = await claimProject(repoDir, stateBase);
      ctx.trackLease(opened.lease, "post-collision-open-holder");
      assert.equal(opened.published, false);
      assertRawFileUnchanged(collidingPath, collidingSnap, "colliding temp after repeat open");
      await opened.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 5: leftover temporary and foreign file survive first publication and repeat open", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p5b-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-leftovers"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);

      // Create the project directory through the lease so it holds lease files before first publish.
      const prepLease = await acquireLease({ projectKey: live.projectKey, stateRoot });
      ctx.trackLease(prepLease, "prep-lease-holder");
      await prepLease.release();

      const leftoverTmpPath = path.join(stateRoot, ".project.json.tmp.99999.aabbccddeeff");
      const foreignFilePath = path.join(stateRoot, "foreign-note.txt");
      fs.writeFileSync(leftoverTmpPath, "leftover-temp-bytes\n", "utf8");
      fs.writeFileSync(foreignFilePath, "foreign-file-bytes\n", "utf8");
      const leftoverSnap = snapshotRawFile(leftoverTmpPath);
      const foreignSnap = snapshotRawFile(foreignFilePath);

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "leftovers-first-holder");
      assert.equal(first.published, true);
      assertRawFileUnchanged(leftoverTmpPath, leftoverSnap, "leftover temp after publish");
      assertRawFileUnchanged(foreignFilePath, foreignSnap, "foreign file after publish");
      await first.lease.release();

      const second = await claimProject(repoDir, stateBase);
      ctx.trackLease(second.lease, "leftovers-second-holder");
      assert.equal(second.published, false);
      assertRawFileUnchanged(leftoverTmpPath, leftoverSnap, "leftover temp after repeat open");
      assertRawFileUnchanged(foreignFilePath, foreignSnap, "foreign file after repeat open");
      await second.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: identity_mismatch refusal releases lease while refused process stays alive; second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-mismatch-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-mismatch"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "p6-mismatch-init");
      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      const tampered: ProjectRecord = {
        ...first.record,
        canonicalCommonDir: "/nonexistent/different/repo/.git",
      };
      fs.writeFileSync(projectPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      await first.lease.release();

      const refused = ctx.spawnIdentityWorker([
        "--worker-id",
        "refused-mismatch",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--stay-alive-on-error",
        "1",
      ]);
      const failEvent = await refused.nextEvent();
      assert.equal(failEvent.event, "claim_failed");
      assert.equal(failEvent.code, "identity_mismatch");

      // Refused process MUST stay alive while a second process acquires the lease at once.
      assert.equal(
        isSameProcessAlive(refused.pid, refused.startTime),
        true,
        "Refused worker must stay alive to prove lease.release() freed the lock",
      );

      const second = await ctx.runTryOnceAndTrack(first.stateRoot, first.projectKey);
      assert.equal(second.exit.code, 0);
      assert.equal(second.event.event, "acquired");
      assert.equal(isSameProcessAlive(refused.pid, refused.startTime), true);

      refused.sendCommand("exit");
      assert.equal((await refused.exited).code, 0);

      // Step 4 key change (cwd points to another repo inside lease queue) also refuses with
      // identity_mismatch and releases the lease while the refused process stays alive.
      const repoA = initGitRepo(path.join(ctx.scratchRoot, "repo-swap-a"));
      const repoB = initGitRepo(path.join(ctx.scratchRoot, "repo-swap-b"));
      const symlinkCwd = path.join(ctx.scratchRoot, "repo-swap-link");
      fs.symlinkSync(repoA, symlinkCwd);
      const liveA = resolveProjectIdentity(repoA);
      const stateRootA = path.join(stateBase, liveA.projectKey);

      const refusedStep4 = ctx.spawnIdentityWorker([
        "--worker-id",
        "refused-step4-mismatch",
        "--cwd",
        symlinkCwd,
        "--state-base",
        stateBase,
        "--pause-at",
        "step4-swap-cwd",
        "--swap-target",
        repoB,
        "--stay-alive-on-error",
        "1",
      ]);
      const mutated = await refusedStep4.nextEvent();
      assert.equal(mutated.event, "step4_mutated");
      const step4Fail = await refusedStep4.nextEvent();
      assert.equal(step4Fail.event, "claim_failed");
      assert.equal(step4Fail.code, "identity_mismatch");
      assert.equal(isSameProcessAlive(refusedStep4.pid, refusedStep4.startTime), true);
      assert.equal(
        confirmProcessDead(Number(mutated.holderPid), String(mutated.holderStartTime)),
        true,
        "Holder must exit on step 4 identity_mismatch refusal",
      );

      const secondStep4 = await ctx.runTryOnceAndTrack(stateRootA, liveA.projectKey);
      assert.equal(secondStep4.exit.code, 0);
      assert.equal(secondStep4.event.event, "acquired");
      assert.equal(isSameProcessAlive(refusedStep4.pid, refusedStep4.startTime), true);

      refusedStep4.sendCommand("exit");
      assert.equal((await refusedStep4.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: identity_relocated refusal releases lease while refused process stays alive; second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-relocated-");
    try {
      const origDir = initGitRepo(path.join(ctx.scratchRoot, "repo-orig"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(origDir, stateBase);
      ctx.trackLease(first.lease, "p6-relocated-init");
      await first.lease.release();

      const movedDir = path.join(ctx.scratchRoot, "repo-moved");
      fs.renameSync(origDir, movedDir);
      const movedLive = resolveProjectIdentity(movedDir);
      const movedStateRoot = path.join(stateBase, movedLive.projectKey);

      const refused = ctx.spawnIdentityWorker([
        "--worker-id",
        "refused-relocated",
        "--cwd",
        movedDir,
        "--state-base",
        stateBase,
        "--stay-alive-on-error",
        "1",
      ]);
      const failEvent = await refused.nextEvent();
      assert.equal(failEvent.event, "claim_failed");
      assert.equal(failEvent.code, "identity_relocated");
      assert.equal(isSameProcessAlive(refused.pid, refused.startTime), true);

      const second = await ctx.runTryOnceAndTrack(movedStateRoot, movedLive.projectKey);
      assert.equal(second.exit.code, 0);
      assert.equal(second.event.event, "acquired");
      assert.equal(isSameProcessAlive(refused.pid, refused.startTime), true);

      refused.sendCommand("exit");
      assert.equal((await refused.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: identity_unborn at step 4 releases lease while refused process stays alive; only lease files written and second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-unborn-step4-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-step4-unborn"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const live = resolveProjectIdentity(repoDir);
      const stateRoot = path.join(stateBase, live.projectKey);

      const refused = ctx.spawnIdentityWorker([
        "--worker-id",
        "refused-step4-unborn",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--pause-at",
        "step4-make-unborn",
        "--stay-alive-on-error",
        "1",
      ]);
      const mutated = await refused.nextEvent();
      assert.equal(mutated.event, "step4_mutated");
      const failEvent = await refused.nextEvent();
      assert.equal(failEvent.event, "claim_failed");
      assert.equal(failEvent.code, "identity_unborn");

      assert.equal(isSameProcessAlive(refused.pid, refused.startTime), true);
      assert.equal(
        confirmProcessDead(Number(mutated.holderPid), String(mutated.holderStartTime)),
        true,
        "Holder must exit on step 4 identity_unborn refusal",
      );
      assert.deepEqual(
        fs.readdirSync(stateRoot).sort(),
        ["owner.json", "owner.lock"],
        "Only lease files may exist after step 4 identity_unborn",
      );

      const second = await ctx.runTryOnceAndTrack(stateRoot, live.projectKey);
      assert.equal(second.exit.code, 0);
      assert.equal(second.event.event, "acquired");
      assert.equal(isSameProcessAlive(refused.pid, refused.startTime), true);

      refused.sendCommand("exit");
      assert.equal((await refused.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: lease_revoked while holder is alive because owner.json cannot be read releases lease, holder exits, and second process acquires at once", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p6-revoked-");
    try {
      // Sub-case A: owner.json removed (missing/unreadable) while holder is alive.
      const repoA = initGitRepo(path.join(ctx.scratchRoot, "repo-owner-missing"));
      const stateBaseA = path.join(ctx.scratchRoot, "state-a");
      const liveA = resolveProjectIdentity(repoA);
      const stateRootA = path.join(stateBaseA, liveA.projectKey);
      const ownerPathA = path.join(stateRootA, "owner.json");
      const lockPathA = path.join(stateRootA, "owner.lock");

      const workerA = ctx.spawnIdentityWorker([
        "--worker-id",
        "revoked-missing",
        "--cwd",
        repoA,
        "--state-base",
        stateBaseA,
        "--pause-at",
        "after-lease",
        "--stay-alive-on-error",
        "1",
      ]);
      const pausedA = await workerA.nextEvent();
      assert.equal(pausedA.event, "paused");
      const holderPidA = Number(pausedA.holderPid);
      const holderStartA = String(pausedA.holderStartTime);
      assert.equal(isSameProcessAlive(holderPidA, holderStartA), true, "Holder must be alive");
      assert.equal(isLockFreeNonBlocking(lockPathA), false, "Lock must be held before revocation");

      fs.unlinkSync(ownerPathA);
      workerA.resumePause("go");

      const failedA = await workerA.nextEvent();
      assert.equal(failedA.event, "claim_failed");
      assert.equal(failedA.code, "lease_revoked");
      assert.equal(isSameProcessAlive(workerA.pid, workerA.startTime), true);
      assert.equal(
        confirmProcessDead(holderPidA, holderStartA),
        true,
        "Holder must exit after lease_revoked release",
      );
      assert.equal(isLockFreeNonBlocking(lockPathA), true);

      const secondA = ctx.spawnIdentityWorker([
        "--worker-id",
        "acquirer-a",
        "--cwd",
        repoA,
        "--state-base",
        stateBaseA,
      ]);
      const claimedA = await secondA.nextEvent();
      assert.equal(claimedA.event, "claimed");
      assert.equal(claimedA.published, true);
      assert.equal((await secondA.nextEvent()).event, "released");
      assert.equal((await secondA.exited).code, 0);
      assert.equal(isSameProcessAlive(workerA.pid, workerA.startTime), true);
      workerA.sendCommand("exit");
      assert.equal((await workerA.exited).code, 0);

      // Sub-case B: owner.json unreadable (EACCES via chmod 0o000, or EISDIR if uid 0) while holder alive.
      const repoB = initGitRepo(path.join(ctx.scratchRoot, "repo-owner-unreadable"));
      const stateBaseB = path.join(ctx.scratchRoot, "state-b");
      const liveB = resolveProjectIdentity(repoB);
      const stateRootB = path.join(stateBaseB, liveB.projectKey);
      const ownerPathB = path.join(stateRootB, "owner.json");
      const lockPathB = path.join(stateRootB, "owner.lock");

      const workerB = ctx.spawnIdentityWorker([
        "--worker-id",
        "revoked-unreadable",
        "--cwd",
        repoB,
        "--state-base",
        stateBaseB,
        "--pause-at",
        "after-lease",
        "--stay-alive-on-error",
        "1",
      ]);
      const pausedB = await workerB.nextEvent();
      assert.equal(pausedB.event, "paused");
      const holderPidB = Number(pausedB.holderPid);
      const holderStartB = String(pausedB.holderStartTime);
      assert.equal(isSameProcessAlive(holderPidB, holderStartB), true, "Holder must be alive");

      const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
      const savedOwnerBytes = fs.readFileSync(ownerPathB);
      if (isRoot) {
        fs.unlinkSync(ownerPathB);
        fs.mkdirSync(ownerPathB);
      } else {
        fs.chmodSync(ownerPathB, 0o000);
      }
      try {
        workerB.resumePause("go");
        const failedB = await workerB.nextEvent();
        assert.equal(failedB.event, "claim_failed");
        assert.equal(failedB.code, "lease_revoked");
        assert.equal(isSameProcessAlive(workerB.pid, workerB.startTime), true);
        assert.equal(
          confirmProcessDead(holderPidB, holderStartB),
          true,
          "Holder must exit when owner.json cannot be read",
        );
        assert.equal(isLockFreeNonBlocking(lockPathB), true);
      } finally {
        if (isRoot) {
          fs.rmSync(ownerPathB, { recursive: true, force: true });
          fs.writeFileSync(ownerPathB, savedOwnerBytes);
        } else {
          fs.chmodSync(ownerPathB, 0o600);
        }
      }

      const secondB = ctx.spawnIdentityWorker([
        "--worker-id",
        "acquirer-b",
        "--cwd",
        repoB,
        "--state-base",
        stateBaseB,
      ]);
      const claimedB = await secondB.nextEvent();
      assert.equal(claimedB.event, "claimed");
      assert.equal(claimedB.published, true);
      assert.equal((await secondB.nextEvent()).event, "released");
      assert.equal((await secondB.exited).code, 0);
      assert.equal(isSameProcessAlive(workerB.pid, workerB.startTime), true);

      workerB.sendCommand("exit");
      assert.equal((await workerB.exited).code, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 7: path mismatch, directory-hash mismatch, no shared root, and empty stored roots each refuse with identity_mismatch and unchanged record bytes", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p7a-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-verify"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "p7-init");
      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      await first.lease.release();

      const cases: Array<{ label: string; record: ProjectRecord }> = [
        {
          label: "path mismatch",
          record: {
            ...first.record,
            canonicalCommonDir: "/different/canonical/path/.git",
          },
        },
        {
          label: "directory name does not match stored hash",
          record: {
            ...first.record,
            commonDirSha256: "f".repeat(64),
          },
        },
        {
          label: "no shared root commit",
          record: {
            ...first.record,
            rootCommitShas: ["a".repeat(40)],
          },
        },
        {
          label: "empty stored rootCommitShas",
          record: {
            ...first.record,
            rootCommitShas: [],
          },
        },
      ];

      let expectedEpoch = first.lease.epoch;
      for (const item of cases) {
        fs.writeFileSync(projectPath, `${JSON.stringify(item.record, null, 2)}\n`, "utf8");
        const beforeSnap = snapshotRawFile(projectPath);

        await expectErrorCode(
          () => claimProject(repoDir, stateBase),
          "identity_mismatch",
          item.label,
        );

        assertRawFileUnchanged(projectPath, beforeSnap, `${item.label}: project.json bytes`);
        expectedEpoch += 1;
        assert.equal(
          readOwnerRecord(first.stateRoot)?.epoch,
          expectedEpoch,
          `${item.label}: owner.json epoch is the only write`,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 7: added root commit and removed root commit while one stored root remains both open with record bytes unchanged", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p7b-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-roots"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const rootA = runGit(repoDir, ["rev-parse", "HEAD"]).trim();
      const rootB = addOrphanRootCommit(repoDir, "branch-b", "b.txt", "b\n", "main");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "p7b-first");
      assert.equal(first.published, true);
      assert.deepEqual(first.record.rootCommitShas, [rootA, rootB].sort());
      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      const publishedBytes = snapshotRawFile(projectPath);
      await first.lease.release();

      // Add a third root commit -> must open with bytes unchanged.
      addOrphanRootCommit(repoDir, "branch-c", "c.txt", "c\n", "main");
      const afterAdd = await claimProject(repoDir, stateBase);
      ctx.trackLease(afterAdd.lease, "p7b-add");
      assert.equal(afterAdd.published, false);
      assertRawFileUnchanged(projectPath, publishedBytes, "after adding root commit");
      await afterAdd.lease.release();

      // Remove branch-b and branch-c so one stored root (rootA) remains -> must open with bytes unchanged.
      runGit(repoDir, ["branch", "-D", "branch-b", "branch-c"]);
      const afterRemove = await claimProject(repoDir, stateBase);
      ctx.trackLease(afterRemove.lease, "p7b-remove");
      assert.equal(afterRemove.published, false);
      assertRawFileUnchanged(projectPath, publishedBytes, "after removing one root while one remains");
      await afterRemove.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 7: published project.json matches schema v1 under 2048 bytes and refuses oversized records", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p7c-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-schema"), {
        originUrl: "https://example.com/org/schema-test.git",
      });
      const stateBase = path.join(ctx.scratchRoot, "state");

      const claimed = await claimProject(repoDir, stateBase);
      ctx.trackLease(claimed.lease, "p7c-schema");
      const projectPath = path.join(claimed.stateRoot, PROJECT_RECORD_FILENAME);
      const raw = fs.readFileSync(projectPath);
      assert.equal(raw.byteLength < MAX_PROJECT_RECORD_BYTES, true);
      const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        "canonicalCommonDir",
        "commonDirSha256",
        "originUrl",
        "rootCommitShas",
        "schemaVersion",
        "slug",
      ]);
      assert.equal(parsed.schemaVersion, PROJECT_SCHEMA_VERSION);
      await claimed.lease.release();

      // Oversized stored project.json refuses with project_record_too_large and leaves bytes unchanged.
      const oversizeStored = `${JSON.stringify({ ...claimed.record, slug: "s".repeat(MAX_PROJECT_RECORD_BYTES) }, null, 2)}\n`;
      fs.writeFileSync(projectPath, oversizeStored, "utf8");
      const oversizeSnap = snapshotRawFile(projectPath);
      await expectErrorCode(
        () => claimProject(repoDir, stateBase),
        "project_record_too_large",
        "Oversized stored record must refuse on open",
      );
      assertRawFileUnchanged(projectPath, oversizeSnap, "oversized stored project.json bytes");

      // Symlink project.json refuses with invalid_project_record and releases lease.
      const symlinkTarget = path.join(ctx.scratchRoot, "symlink-target.json");
      fs.writeFileSync(symlinkTarget, `${JSON.stringify(claimed.record, null, 2)}\n`, "utf8");
      fs.unlinkSync(projectPath);
      fs.symlinkSync(symlinkTarget, projectPath);
      await expectErrorCode(
        () => claimProject(repoDir, stateBase),
        "invalid_project_record",
        "Symlink project.json must be refused",
      );
      assert.equal(isLockFreeNonBlocking(path.join(claimed.stateRoot, "owner.lock")), true);

      // Oversized record on first publish refuses with project_record_too_large and writes no project.json.
      const bigOrigin = `https://example.com/org/${"x".repeat(MAX_PROJECT_RECORD_BYTES)}.git`;
      const bigRepo = initGitRepo(path.join(ctx.scratchRoot, "repo-oversize"), {
        originUrl: bigOrigin,
      });
      const bigLive = resolveProjectIdentity(bigRepo);
      const bigStateRoot = path.join(stateBase, bigLive.projectKey);
      await expectErrorCode(
        () => claimProject(bigRepo, stateBase),
        "project_record_too_large",
        "Oversized record must refuse before publishing",
      );
      assert.equal(fs.existsSync(path.join(bigStateRoot, PROJECT_RECORD_FILENAME)), false);
      assert.equal(isLockFreeNonBlocking(path.join(bigStateRoot, "owner.lock")), true);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 8: repository with no commit on any ref refuses with identity_unborn and leaves state root unchanged even when absent", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p8a-");
    try {
      const unbornRepo = initGitRepo(path.join(ctx.scratchRoot, "repo-unborn"), {
        initialCommit: false,
      });

      // Case 1: stateBase does not exist at all -> must remain absent.
      const absentStateBase = path.join(ctx.scratchRoot, "absent-state-base");
      assert.equal(fs.existsSync(absentStateBase), false);
      await expectErrorCode(
        () => claimProject(unbornRepo, absentStateBase),
        "identity_unborn",
        "Unborn repo with absent stateBase",
      );
      assert.equal(
        fs.existsSync(absentStateBase),
        false,
        "State root must remain absent after identity_unborn",
      );

      // Case 2: stateBase already exists -> must remain completely unchanged.
      const existingStateBase = ctx.createDir("existing-state-base");
      const markerPath = path.join(existingStateBase, "keep.txt");
      fs.writeFileSync(markerPath, "untouched\n", "utf8");
      const beforeDir = snapshotDirFiles(existingStateBase);
      await expectErrorCode(
        () => claimProject(unbornRepo, existingStateBase),
        "identity_unborn",
        "Unborn repo with existing stateBase",
      );
      assertDirUnchanged(existingStateBase, beforeDir, "Existing stateBase must stay unchanged");
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 8: unborn HEAD beside a committed branch opens and publishes project.json", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p8b-");
    try {
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-unborn-head"));
      const mainRoot = runGit(repoDir, ["rev-parse", "HEAD"]).trim();
      createUnbornHeadBesideBranch(repoDir, "unborn-wip");

      const stateBase = path.join(ctx.scratchRoot, "state");
      const claimed = await claimProject(repoDir, stateBase);
      ctx.trackLease(claimed.lease, "p8b-unborn-head");
      assert.equal(claimed.published, true);
      assert.deepEqual(claimed.record.rootCommitShas, [mainRoot]);
      await claimed.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
