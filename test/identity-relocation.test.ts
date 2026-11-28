import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  claimProject,
  IdentityError,
  PROJECT_RECORD_FILENAME,
  resolveProjectIdentity,
} from "../src/identity.ts";
import {
  addLinkedWorktree,
  addOrphanRootCommit,
  assertRawFileUnchanged,
  cloneGitRepo,
  createIdentityTestContext,
  expectErrorCode,
  initBareRepo,
  initGitRepo,
  runGit,
  setOriginUrl,
  snapshotRawFile,
} from "./helpers/identity-fixtures.ts";

describe("project identity relocation, remedy, origin warning, and worktrees/clones (proofs 9-12)", () => {
  test("proof 9: moved clone refuses with identity_relocated naming old directory, also after adding a root and changing origin", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p9a-");
    try {
      const origDir = initGitRepo(path.join(ctx.scratchRoot, "clone-a"), {
        originUrl: "https://example.com/org/orig.git",
      });
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(origDir, stateBase);
      ctx.trackLease(first.lease, "p9a-first");
      const oldStateRoot = first.stateRoot;
      await first.lease.release();

      // Move the real clone directory, add a root commit, and change the origin URL.
      const movedDir = path.join(ctx.scratchRoot, "clone-b");
      fs.renameSync(origDir, movedDir);
      addOrphanRootCommit(movedDir, "extra-root", "extra.txt", "extra\n", "main");
      setOriginUrl(movedDir, "https://example.com/org/changed.git");

      const err = await expectErrorCode(
        () => claimProject(movedDir, stateBase),
        "identity_relocated",
        "Moved clone with added root and changed origin must refuse with identity_relocated",
      );
      assert.ok(err instanceof IdentityError);
      assert.ok(err.candidates !== undefined);
      assert.deepEqual(
        err.candidates.map((c) => c.stateRoot),
        [oldStateRoot],
      );
      assert.equal(
        err.message.includes(oldStateRoot),
        true,
        "Error message must name the matching state directory",
      );

      const movedLive = resolveProjectIdentity(movedDir);
      assert.equal(
        fs.existsSync(path.join(stateBase, movedLive.projectKey, PROJECT_RECORD_FILENAME)),
        false,
        "project.json must not be written on identity_relocated",
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 9: two matching old records are both named by identity_relocated", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p9b-");
    try {
      const bareDir = initBareRepo(path.join(ctx.scratchRoot, "origin.git"));
      const seedDir = initGitRepo(path.join(ctx.scratchRoot, "seed"), { originUrl: bareDir });
      runGit(seedDir, ["push", "-u", "origin", "main"]);
      fs.rmSync(seedDir, { recursive: true, force: true });

      const clone1 = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "clone-1"));
      const clone2 = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "clone-2"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const c1 = await claimProject(clone1, stateBase);
      ctx.trackLease(c1.lease, "p9b-c1");
      await c1.lease.release();

      const c2 = await claimProject(clone2, stateBase);
      ctx.trackLease(c2.lease, "p9b-c2");
      await c2.lease.release();

      // Move clone1 to clone3 and delete clone2 so both old paths are gone.
      const clone3 = path.join(ctx.scratchRoot, "clone-3");
      fs.renameSync(clone1, clone3);
      fs.rmSync(clone2, { recursive: true, force: true });

      const err = await expectErrorCode(
        () => claimProject(clone3, stateBase),
        "identity_relocated",
        "Two matching missing old clones must both be named",
      );
      assert.ok(err instanceof IdentityError);
      assert.ok(err.candidates !== undefined);
      const named = err.candidates.map((c) => c.stateRoot).sort();
      const expected = [c1.stateRoot, c2.stateRoot].sort();
      assert.deepEqual(named, expected);
      assert.equal(err.message.includes(c1.stateRoot), true);
      assert.equal(err.message.includes(c2.stateRoot), true);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 9: fresh clone after deleted clone refuses with identity_relocated", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p9c-");
    try {
      const bareDir = initBareRepo(path.join(ctx.scratchRoot, "origin.git"));
      const seedDir = initGitRepo(path.join(ctx.scratchRoot, "seed"), { originUrl: bareDir });
      runGit(seedDir, ["push", "-u", "origin", "main"]);
      fs.rmSync(seedDir, { recursive: true, force: true });

      const oldClone = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "old-clone"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const claimed = await claimProject(oldClone, stateBase);
      ctx.trackLease(claimed.lease, "p9c-old");
      const oldStateRoot = claimed.stateRoot;
      await claimed.lease.release();

      fs.rmSync(oldClone, { recursive: true, force: true });
      const freshClone = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "fresh-clone"));

      const err = await expectErrorCode(
        () => claimProject(freshClone, stateBase),
        "identity_relocated",
        "Fresh clone after deleted clone must refuse with identity_relocated",
      );
      assert.ok(err instanceof IdentityError);
      assert.deepEqual(
        err.candidates?.map((c) => c.stateRoot),
        [oldStateRoot],
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 9: second clone while first path still exists opens as its own project", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p9d-");
    try {
      const bareDir = initBareRepo(path.join(ctx.scratchRoot, "origin.git"));
      const seedDir = initGitRepo(path.join(ctx.scratchRoot, "seed"), { originUrl: bareDir });
      runGit(seedDir, ["push", "-u", "origin", "main"]);
      fs.rmSync(seedDir, { recursive: true, force: true });

      const clone1 = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "clone-live-1"));
      const clone2 = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "clone-live-2"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(clone1, stateBase);
      ctx.trackLease(first.lease, "p9d-first");
      await first.lease.release();

      const second = await claimProject(clone2, stateBase);
      ctx.trackLease(second.lease, "p9d-second");
      assert.equal(second.published, true);
      assert.notEqual(second.projectKey, first.projectKey);
      assert.notEqual(second.stateRoot, first.stateRoot);
      await second.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 9: moved clone whose old path exists again opens with a new ledger", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p9e-");
    try {
      const origDir = initGitRepo(path.join(ctx.scratchRoot, "clone-reused-path"));
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(origDir, stateBase);
      ctx.trackLease(first.lease, "p9e-first");
      const oldProjectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      const oldRecordBytes = snapshotRawFile(oldProjectPath);
      await first.lease.release();

      // Move the clone, then create another repository at the old path so old canonicalCommonDir exists again.
      const movedDir = path.join(ctx.scratchRoot, "clone-moved-away");
      fs.renameSync(origDir, movedDir);
      initGitRepo(origDir);

      const second = await claimProject(movedDir, stateBase);
      ctx.trackLease(second.lease, "p9e-second");
      assert.equal(second.published, true, "Moved clone whose old path exists again opens a new ledger");
      assert.notEqual(second.projectKey, first.projectKey);
      assertRawFileUnchanged(oldProjectPath, oldRecordBytes, "Old ledger stays untouched on disk");
      await second.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 10: after named relocation directories are moved out, claim publishes even though refused claim left a lease-only directory", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p10-");
    try {
      const origDir = initGitRepo(path.join(ctx.scratchRoot, "repo-remedy-a"));
      const stateBase = path.join(ctx.scratchRoot, "state");
      const archiveDir = ctx.createDir("archived-state");

      const first = await claimProject(origDir, stateBase);
      ctx.trackLease(first.lease, "p10-first");
      await first.lease.release();

      const movedDir = path.join(ctx.scratchRoot, "repo-remedy-b");
      fs.renameSync(origDir, movedDir);
      const movedLive = resolveProjectIdentity(movedDir);
      const movedStateRoot = path.join(stateBase, movedLive.projectKey);

      const err = await expectErrorCode(
        () => claimProject(movedDir, stateBase),
        "identity_relocated",
        "Initial claim after move must refuse with identity_relocated",
      );
      assert.ok(err instanceof IdentityError);
      assert.ok(err.candidates !== undefined && err.candidates.length === 1);

      // The refused claim itself created movedStateRoot with only lease files (never mkdirSync by hand).
      assert.equal(fs.existsSync(movedStateRoot), true);
      assert.deepEqual(
        fs.readdirSync(movedStateRoot).sort(),
        ["owner.json", "owner.lock"],
        "Refused claim must leave only the lease's files in the new state directory",
      );

      // Manual remedy step 3: move every directory named by the error out of stateBase.
      for (const candidate of err.candidates) {
        fs.renameSync(candidate.stateRoot, path.join(archiveDir, candidate.projectKey));
      }

      // Claim again without touching the lease-only directory left by the refused claim.
      const published = await claimProject(movedDir, stateBase);
      ctx.trackLease(published.lease, "p10-published");
      assert.equal(published.published, true);
      assert.equal(published.projectKey, movedLive.projectKey);
      assert.equal(fs.existsSync(path.join(movedStateRoot, PROJECT_RECORD_FILENAME)), true);
      await published.lease.release();

      // A sibling lease-only directory left by an earlier refused claim also never blocks a later move.
      const movedAgainDir = path.join(ctx.scratchRoot, "repo-remedy-c");
      fs.renameSync(movedDir, movedAgainDir);
      const errSecond = await expectErrorCode(
        () => claimProject(movedAgainDir, stateBase),
        "identity_relocated",
        "Second move must refuse naming the active moved record",
      );
      assert.ok(errSecond instanceof IdentityError && errSecond.candidates !== undefined);
      const movedAgainStateRoot = path.join(
        stateBase,
        resolveProjectIdentity(movedAgainDir).projectKey,
      );
      assert.deepEqual(fs.readdirSync(movedAgainStateRoot).sort(), ["owner.json", "owner.lock"]);

      const thirdLocDir = path.join(ctx.scratchRoot, "repo-remedy-d");
      fs.renameSync(movedAgainDir, thirdLocDir);
      for (const candidate of errSecond.candidates) {
        fs.renameSync(candidate.stateRoot, path.join(archiveDir, `${candidate.projectKey}-2`));
      }
      // movedAgainStateRoot still sits in stateBase with only owner.lock and owner.json; must not block!
      const publishedThird = await claimProject(thirdLocDir, stateBase);
      ctx.trackLease(publishedThird.lease, "p10-published-third");
      assert.equal(publishedThird.published, true);
      assert.deepEqual(fs.readdirSync(movedAgainStateRoot).sort(), ["owner.json", "owner.lock"]);
      await publishedThird.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 11: origin is stored at publication; changed, removed, or added live origin gives a warning and opens with record bytes unchanged", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p11-");
    try {
      const initialOrigin = "https://example.com/org/initial.git";
      const changedOrigin = "https://example.com/org/changed.git";
      const repoDir = initGitRepo(path.join(ctx.scratchRoot, "repo-origin"), {
        originUrl: initialOrigin,
      });
      const stateBase = path.join(ctx.scratchRoot, "state");

      const first = await claimProject(repoDir, stateBase);
      ctx.trackLease(first.lease, "p11-first");
      assert.equal(first.published, true);
      assert.equal(first.record.originUrl, initialOrigin);
      assert.equal(first.originWarning, null);
      const projectPath = path.join(first.stateRoot, PROJECT_RECORD_FILENAME);
      const publishedBytes = snapshotRawFile(projectPath);
      await first.lease.release();

      // Changed live origin -> warning attached, claim opens, record bytes unchanged.
      setOriginUrl(repoDir, changedOrigin);
      const afterChange = await claimProject(repoDir, stateBase);
      ctx.trackLease(afterChange.lease, "p11-change");
      assert.equal(afterChange.published, false);
      assert.deepEqual(afterChange.originWarning, {
        stored: initialOrigin,
        live: changedOrigin,
      });
      assertRawFileUnchanged(projectPath, publishedBytes, "after origin change");
      await afterChange.lease.release();

      // Removed live origin -> warning attached, claim opens, record bytes unchanged.
      setOriginUrl(repoDir, null);
      const afterRemove = await claimProject(repoDir, stateBase);
      ctx.trackLease(afterRemove.lease, "p11-remove");
      assert.equal(afterRemove.published, false);
      assert.deepEqual(afterRemove.originWarning, {
        stored: initialOrigin,
        live: null,
      });
      assertRawFileUnchanged(projectPath, publishedBytes, "after origin removal");
      await afterRemove.lease.release();

      // Null stored origin that later gains an origin -> warning attached, claim opens.
      const localRepo = initGitRepo(path.join(ctx.scratchRoot, "repo-no-origin"), {
        originUrl: null,
      });
      const localFirst = await claimProject(localRepo, stateBase);
      ctx.trackLease(localFirst.lease, "p11-local-first");
      assert.equal(localFirst.record.originUrl, null);
      assert.equal(localFirst.originWarning, null);
      const localProjectPath = path.join(localFirst.stateRoot, PROJECT_RECORD_FILENAME);
      const localBytes = snapshotRawFile(localProjectPath);
      await localFirst.lease.release();

      setOriginUrl(localRepo, "https://example.com/org/added.git");
      const localAfterAdd = await claimProject(localRepo, stateBase);
      ctx.trackLease(localAfterAdd.lease, "p11-local-add");
      assert.equal(localAfterAdd.published, false);
      assert.deepEqual(localAfterAdd.originWarning, {
        stored: null,
        live: "https://example.com/org/added.git",
      });
      assertRawFileUnchanged(localProjectPath, localBytes, "after adding origin");
      await localAfterAdd.lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 12: linked worktrees and symlinked paths share one key; separate clones and same-basename repos get different keys; non-git fails closed", async () => {
    const ctx = createIdentityTestContext("herdr-s1b-p12-");
    try {
      const bareDir = initBareRepo(path.join(ctx.scratchRoot, "origin.git"));
      const seedDir = initGitRepo(path.join(ctx.scratchRoot, "seed"), { originUrl: bareDir });
      runGit(seedDir, ["push", "-u", "origin", "main"]);
      fs.rmSync(seedDir, { recursive: true, force: true });

      const cloneA = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "workspace-a", "app"));
      const cloneB = cloneGitRepo(bareDir, path.join(ctx.scratchRoot, "workspace-b", "app"));
      const worktreeDir = addLinkedWorktree(
        cloneA,
        path.join(ctx.scratchRoot, "linked-wt-different-name"),
        "feature-wt",
      );
      const symlinkToCloneA = path.join(ctx.scratchRoot, "symlink-to-clone-a");
      fs.symlinkSync(cloneA, symlinkToCloneA);
      const symlinkToWorktree = path.join(ctx.scratchRoot, "symlink-to-wt");
      fs.symlinkSync(worktreeDir, symlinkToWorktree);

      const idCloneA = resolveProjectIdentity(cloneA);
      const idWorktree = resolveProjectIdentity(worktreeDir);
      const idSymlinkA = resolveProjectIdentity(symlinkToCloneA);
      const idSymlinkWt = resolveProjectIdentity(symlinkToWorktree);
      const idCloneB = resolveProjectIdentity(cloneB);

      assert.match(idCloneA.projectKey, /^[0-9a-f]{16}$/);
      assert.equal(idWorktree.projectKey, idCloneA.projectKey, "Linked worktree must share key");
      assert.equal(idWorktree.canonicalCommonDir, idCloneA.canonicalCommonDir);
      assert.equal(idSymlinkA.projectKey, idCloneA.projectKey, "Symlink to repo must share key");
      assert.equal(idSymlinkWt.projectKey, idCloneA.projectKey, "Symlink to worktree must share key");
      assert.notEqual(idCloneB.projectKey, idCloneA.projectKey, "Separate clones must differ");

      // Distinct repositories with identical folder basename also get distinct keys.
      const distinctA = initGitRepo(path.join(ctx.scratchRoot, "dir-1", "same-name"));
      const distinctB = initGitRepo(path.join(ctx.scratchRoot, "dir-2", "same-name"));
      assert.notEqual(
        resolveProjectIdentity(distinctA).projectKey,
        resolveProjectIdentity(distinctB).projectKey,
      );

      // Claiming through the main clone and a linked worktree shares one record and one lease.
      const stateBase = path.join(ctx.scratchRoot, "state");
      const mainClaim = await claimProject(cloneA, stateBase);
      ctx.trackLease(mainClaim.lease, "p12-main");
      assert.equal(mainClaim.published, true);

      const conflictWt = ctx.spawnIdentityWorker([
        "--worker-id",
        "wt-conflict",
        "--cwd",
        worktreeDir,
        "--state-base",
        stateBase,
      ]);
      const wtConflictEvent = await conflictWt.nextEvent();
      assert.equal(wtConflictEvent.event, "claim_failed");
      assert.equal(wtConflictEvent.code, "owner_conflict");
      assert.equal((await conflictWt.exited).code, 0);
      await mainClaim.lease.release();

      const wtClaim = await claimProject(worktreeDir, stateBase);
      ctx.trackLease(wtClaim.lease, "p12-wt");
      assert.equal(wtClaim.published, false);
      assert.equal(wtClaim.projectKey, mainClaim.projectKey);
      assert.equal(wtClaim.stateRoot, mainClaim.stateRoot);
      await wtClaim.lease.release();

      const symClaim = await claimProject(symlinkToCloneA, stateBase);
      ctx.trackLease(symClaim.lease, "p12-sym");
      assert.equal(symClaim.published, false);
      assert.equal(symClaim.projectKey, mainClaim.projectKey);
      await symClaim.lease.release();

      // stateBase is required (no default path).
      await expectErrorCode(
        () => claimProject(cloneA, "   "),
        "invalid_argument",
        "Empty stateBase must be refused with invalid_argument",
      );

      // Non-git directory fails closed with not_git_repo and leaves an absent stateBase untouched.
      const nonGitDir = ctx.createDir("not-a-repo");
      const untouchedStateBase = path.join(ctx.scratchRoot, "untouched-state");
      await expectErrorCode(
        () => claimProject(nonGitDir, untouchedStateBase),
        "not_git_repo",
        "Non-git directory must fail closed with not_git_repo",
      );
      assert.equal(fs.existsSync(untouchedStateBase), false);
    } finally {
      await ctx.cleanup();
    }
  });
});
