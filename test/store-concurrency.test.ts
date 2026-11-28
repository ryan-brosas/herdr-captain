import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import type { OwnerLease } from "../src/lease.ts";
import {
  appendCommitRecord,
  getTicketPaths,
  openTicketLog,
  type OpenTicketLogResult,
  type StoreFsOps,
  type VerifiedCommitEntry,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  assertRawFileUnchanged,
  assertTreeUnchanged,
  createStoreTestContext,
  DEFAULT_ISSUE_REF,
  DEFAULT_PROJECT_KEY,
  makeIntentInput,
  runWrite,
  sha256Hex,
  snapshotRawFile,
  snapshotTree,
} from "./helpers/store-fixtures.ts";

assertSupportedBunVersion(Bun.version);

function createCleanGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;

  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe", env });
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test repo\n", "utf8");
  git("add", "README.md");
  git("commit", "-m", "initial commit");
}

describe("commit-log store concurrency, fencing, and cross-module integration (proofs 1, 5, and 12)", () => {
  test("proof 1: two processes stand at pre-link barrier with same seq and different bytes; Order A (owner 2 lands first) rejects stale owner 1 with EEXIST and preserves owner 2 bytes", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p1a-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);
      const barrierRecord: string[] = [];

      const owner1 = ctx.spawnStoreWorker([
        "--mode",
        "append",
        "--worker-id",
        "owner1",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        DEFAULT_ISSUE_REF,
        "--pause-at",
        "before-link",
        "--record-kind",
        "intent",
        "--tag",
        "owner1-alpha",
      ]);

      const p1Paused = await owner1.nextEvent(8000);
      assert.equal(p1Paused.event, "paused");
      assert.equal(p1Paused.point, "before-link");
      barrierRecord.push("owner1:arrived");

      // Kill owner 1's lock holder externally after owner 1 passed its pre-link lease check.
      await ctx.killHolderAndWaitDead(Number(p1Paused.holderPid), String(p1Paused.holderStartTime));

      // Owner 2 acquires the freed lease and stops at the same pre-link barrier.
      const owner2 = ctx.spawnStoreWorker([
        "--mode",
        "append",
        "--worker-id",
        "owner2",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        DEFAULT_ISSUE_REF,
        "--pause-at",
        "before-link",
        "--hold-after",
        "1",
        "--record-kind",
        "intent",
        "--tag",
        "owner2-beta",
      ]);

      const p2Paused = await owner2.nextEvent(8000);
      assert.equal(p2Paused.event, "paused");
      assert.equal(p2Paused.point, "before-link");
      barrierRecord.push("owner2:arrived");

      // Prove both processes overlapped at the barrier with same target path and different bytes.
      assert.deepEqual(barrierRecord, ["owner1:arrived", "owner2:arrived"]);
      assert.equal(owner1.hasExited(), false, "owner 1 must still be alive at barrier");
      assert.equal(owner2.hasExited(), false, "owner 2 must still be alive at barrier");
      assert.equal(p1Paused.targetPath, path.join(paths.logDir, "000001.json"));
      assert.equal(p2Paused.targetPath, path.join(paths.logDir, "000001.json"));

      const owner1Bytes = Buffer.from(String(p1Paused.writtenBytesBase64), "base64");
      const owner2Bytes = Buffer.from(String(p2Paused.writtenBytesBase64), "base64");
      assert.notEqual(
        Buffer.compare(owner1Bytes, owner2Bytes),
        0,
        "Both owners must carry distinct record bytes",
      );

      // Order A: release owner 2 first so owner 2's link lands first.
      barrierRecord.push("owner2:resumed");
      owner2.resumePause("go");
      const p2Ok = await owner2.nextEvent(8000);
      assert.equal(p2Ok.event, "append_ok");
      assert.equal(p2Ok.linkSucceeded, true);
      assert.equal((p2Ok.result as VerifiedCommitEntry).seq, 1);

      const finalPath = path.join(paths.logDir, "000001.json");
      const winnerSnap = snapshotRawFile(finalPath);
      assert.equal(Buffer.compare(winnerSnap.bytes, owner2Bytes), 0);

      // Now release stale owner 1: its link hits EEXIST, fails with record_exists, and removes nothing.
      barrierRecord.push("owner1:resumed");
      owner1.resumePause("go");
      const p1Failed = await owner1.nextEvent(8000);
      assert.equal(p1Failed.event, "append_failed");
      assert.equal(p1Failed.linkErrno, "EEXIST");
      assert.equal(p1Failed.code, "record_exists");
      assert.equal(p1Failed.unlinksAfterPause, 0);

      const p1Exit = await owner1.exited;
      assert.equal(p1Exit.code, 0);

      // Owner 1's temp stays untouched, and owner 2's committed file keeps its exact bytes and inode.
      const owner1Tmp = String(p1Paused.tmpPath);
      assert.equal(fs.existsSync(owner1Tmp), true);
      assertRawFileUnchanged(finalPath, winnerSnap, "owner 2 winning record bytes");

      owner2.sendCommand("release");
      const p2Released = await owner2.nextEvent(8000);
      assert.equal(p2Released.event, "released");
      const p2Exit = await owner2.exited;
      assert.equal(p2Exit.code, 0);

      const opened = await ctx.runFreshOpen(stateRoot, DEFAULT_PROJECT_KEY, DEFAULT_ISSUE_REF);
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 1);
      assert.equal(opened.records[0]?.sha256, sha256Hex(owner2Bytes));
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 1: two processes stand at pre-link barrier; Order B (owner 1 stale link lands first) fails owner 1 with lease_revoked, rejects owner 2 with record_exists, keeps owner 1 bytes, and owner 2 next append gets seq 2", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p1b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);
      const barrierRecord: string[] = [];

      const owner1 = ctx.spawnStoreWorker([
        "--mode",
        "append",
        "--worker-id",
        "owner1",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        DEFAULT_ISSUE_REF,
        "--pause-at",
        "before-link",
        "--record-kind",
        "intent",
        "--tag",
        "owner1-stale",
      ]);

      const p1Paused = await owner1.nextEvent(8000);
      assert.equal(p1Paused.event, "paused");
      assert.equal(p1Paused.point, "before-link");
      barrierRecord.push("owner1:arrived");

      await ctx.killHolderAndWaitDead(Number(p1Paused.holderPid), String(p1Paused.holderStartTime));

      const owner2 = ctx.spawnStoreWorker([
        "--mode",
        "append",
        "--worker-id",
        "owner2",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        DEFAULT_ISSUE_REF,
        "--pause-at",
        "before-link",
        "--stay-alive-on-error",
        "1",
        "--record-kind",
        "intent",
        "--tag",
        "owner2-live",
      ]);

      const p2Paused = await owner2.nextEvent(8000);
      assert.equal(p2Paused.event, "paused");
      assert.equal(p2Paused.point, "before-link");
      barrierRecord.push("owner2:arrived");

      assert.deepEqual(barrierRecord, ["owner1:arrived", "owner2:arrived"]);
      assert.equal(owner1.hasExited(), false);
      assert.equal(owner2.hasExited(), false);
      assert.equal(p1Paused.targetPath, path.join(paths.logDir, "000001.json"));
      assert.equal(p2Paused.targetPath, path.join(paths.logDir, "000001.json"));

      const owner1Bytes = Buffer.from(String(p1Paused.writtenBytesBase64), "base64");
      const owner2Bytes = Buffer.from(String(p2Paused.writtenBytesBase64), "base64");
      assert.notEqual(Buffer.compare(owner1Bytes, owner2Bytes), 0);

      // Order B: release stale owner 1 first -> link lands, then pre-unlink lease check fails with lease_revoked.
      barrierRecord.push("owner1:resumed");
      owner1.resumePause("go");
      const p1Failed = await owner1.nextEvent(8000);
      assert.equal(p1Failed.event, "append_failed");
      assert.equal(p1Failed.linkSucceeded, true);
      assert.equal(p1Failed.code, "lease_revoked");
      assert.equal(p1Failed.unlinksAfterPause, 0);
      const p1Exit = await owner1.exited;
      assert.equal(p1Exit.code, 0);

      const finalPath = path.join(paths.logDir, "000001.json");
      const owner1Snap = snapshotRawFile(finalPath);
      assert.equal(Buffer.compare(owner1Snap.bytes, owner1Bytes), 0);
      assert.equal(fs.existsSync(String(p1Paused.tmpPath)), true, "stale owner 1 temp stays");

      // Release owner 2 -> its link hits EEXIST, fails with record_exists, removes its own temp, preserves owner 1 bytes.
      barrierRecord.push("owner2:resumed");
      owner2.resumePause("go");
      const p2Failed = await owner2.nextEvent(8000);
      assert.equal(p2Failed.event, "append_failed");
      assert.equal(p2Failed.linkErrno, "EEXIST");
      assert.equal(p2Failed.code, "record_exists");
      assert.equal(fs.existsSync(String(p2Paused.tmpPath)), false, "live owner 2 cleans its own temp");
      assertRawFileUnchanged(finalPath, owner1Snap, "owner 1 winning record bytes must stay intact");

      // Owner 2 retries append: re-reads log and gets seq 2 chained to owner 1's record!
      owner2.sendCommand("append_again");
      const p2Next = await owner2.nextEvent(8000);
      assert.equal(p2Next.event, "append_ok");
      const nextEntry = p2Next.result as VerifiedCommitEntry;
      assert.equal(nextEntry.seq, 2);
      assert.equal(nextEntry.record.prevRecordSha256, sha256Hex(owner1Bytes));

      owner2.sendCommand("release");
      const p2Released = await owner2.nextEvent(8000);
      assert.equal(p2Released.event, "released");
      const p2Exit = await owner2.exited;
      assert.equal(p2Exit.code, 0);

      const opened = await ctx.runFreshOpen(stateRoot, DEFAULT_PROJECT_KEY, DEFAULT_ISSUE_REF);
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 2);
      assert.equal(opened.records[0]?.sha256, sha256Hex(owner1Bytes));
      assert.equal(opened.records[1]?.sha256, nextEntry.sha256);
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 5: external holder SIGKILL at after-open-temp, after-full-write, and after-link fails with lease_revoked, writes nothing further, and leaves temp; primary write error wins over dead holder; dead holder before call writes nothing including folders", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p5a-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");

      // 1. Holder killed externally while paused at after-open-temp, after-full-write, after-link.
      const pauseCases = [
        { point: "after-open-temp", issueRef: "example/repo#501" },
        { point: "after-full-write", issueRef: "example/repo#502" },
        { point: "after-link", issueRef: "example/repo#503" },
      ] as const;

      for (const tc of pauseCases) {
        const paths = getTicketPaths(stateRoot, tc.issueRef);
        const worker = ctx.spawnStoreWorker([
          "--mode",
          "append",
          "--worker-id",
          `p5-${tc.point}`,
          "--state-root",
          stateRoot,
          "--project-key",
          DEFAULT_PROJECT_KEY,
          "--issue-ref",
          tc.issueRef,
          "--pause-at",
          tc.point,
          "--tag",
          tc.point,
        ]);

        const paused = await worker.nextEvent(8000);
        assert.equal(paused.event, "paused");
        assert.equal(paused.point, tc.point);
        const tmpPath = String(paused.tmpPath);
        assert.equal(fs.existsSync(tmpPath), true);

        await ctx.killHolderAndWaitDead(Number(paused.holderPid), String(paused.holderStartTime));
        const snapAtPause = snapshotTree(paths.ticketDir);
        const tmpSnap = snapshotRawFile(tmpPath);

        worker.resumePause("go");
        const failed = await worker.nextEvent(8000);
        assert.equal(failed.event, "append_failed", `${tc.point}: expected append_failed`);
        assert.equal(failed.code, "lease_revoked", `${tc.point}: expected lease_revoked`);
        assert.equal(failed.mkdirsAfterPause, 0, `${tc.point}: no mkdir after pause`);
        assert.equal(failed.opensCreateAfterPause, 0, `${tc.point}: no temp open after pause`);
        assert.equal(failed.writesAfterPause, 0, `${tc.point}: no write after pause`);
        assert.equal(failed.linksAfterPause, 0, `${tc.point}: no link after pause`);
        assert.equal(failed.unlinksAfterPause, 0, `${tc.point}: no unlink after pause`);

        const exit = await worker.exited;
        assert.equal(exit.code, 0);

        assertTreeUnchanged(paths.ticketDir, snapAtPause, `${tc.point}: zero disk changes after revocation`);
        assertRawFileUnchanged(tmpPath, tmpSnap, `${tc.point}: temp file must stay untouched`);
      }

      // 2. Primary write error (ENOSPC) still reaches caller when holder is dead, and temp stays.
      {
        const issueRef = "example/repo#504";
        const paths = getTicketPaths(stateRoot, issueRef);
        const worker = ctx.spawnStoreWorker([
          "--mode",
          "append",
          "--worker-id",
          "p5-primary-write-err",
          "--state-root",
          stateRoot,
          "--project-key",
          DEFAULT_PROJECT_KEY,
          "--issue-ref",
          issueRef,
          "--pause-at",
          "fail-write-paused",
          "--tag",
          "enospc",
        ]);
        const paused = await worker.nextEvent(8000);
        assert.equal(paused.event, "paused");
        assert.equal(paused.point, "fail-write-paused");
        const tmpPath = String(paused.tmpPath);
        assert.equal(fs.existsSync(tmpPath), true);

        await ctx.killHolderAndWaitDead(Number(paused.holderPid), String(paused.holderStartTime));
        const snapAtPause = snapshotTree(paths.ticketDir);

        worker.resumePause("go");
        const failed = await worker.nextEvent(8000);
        assert.equal(failed.event, "append_failed");
        assert.equal(
          failed.code,
          "ENOSPC",
          "primary write error must reach caller even when holder is dead",
        );
        assert.equal(failed.unlinksAfterPause, 0, "dead holder must not unlink temp");
        const exit = await worker.exited;
        assert.equal(exit.code, 0);

        assert.equal(fs.existsSync(tmpPath), true, "temp file must stay when holder is dead");
        assertTreeUnchanged(paths.ticketDir, snapAtPause, "primary write error with dead holder");
      }

      // 3. Holder dead before writeArtifact and appendCommitRecord start -> lease_revoked, nothing written, not even a folder.
      for (const mode of ["append", "artifact"] as const) {
        const subRoot = path.join(ctx.scratchRoot, `p5-dead-before-${mode}`);
        const issueRef = mode === "append" ? "example/repo#505" : "example/repo#506";
        const worker = ctx.spawnStoreWorker([
          "--mode",
          mode,
          "--worker-id",
          `p5-dead-before-${mode}`,
          "--state-root",
          subRoot,
          "--project-key",
          DEFAULT_PROJECT_KEY,
          "--issue-ref",
          issueRef,
          "--pause-at",
          "before-store-call",
          "--tag",
          "dead-before",
        ]);
        const paused = await worker.nextEvent(8000);
        assert.equal(paused.event, "paused");
        assert.equal(paused.point, "before-store-call");

        await ctx.killHolderAndWaitDead(Number(paused.holderPid), String(paused.holderStartTime));
        const snapBefore = snapshotTree(subRoot);

        worker.resumePause("go");
        const failed = await worker.nextEvent(8000);
        assert.equal(failed.event, mode === "artifact" ? "artifact_failed" : "append_failed");
        assert.equal(failed.code, "lease_revoked");
        assert.equal(failed.mkdirsAfterPause, 0);
        assert.equal(failed.opensCreateAfterPause, 0);
        assert.equal(failed.writesAfterPause, 0);
        assert.equal(failed.linksAfterPause, 0);
        assert.equal(failed.unlinksAfterPause, 0);
        const exit = await worker.exited;
        assert.equal(exit.code, 0);

        assert.equal(
          fs.existsSync(path.join(subRoot, "tickets")),
          false,
          `${mode}: tickets/ folder must not be created when holder is dead before call`,
        );
        assertTreeUnchanged(subRoot, snapBefore, `${mode}: zero writes when holder is dead before call`);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 5: ruling 8 lease-check placement places assertValid right before every mutating op and never right before fsync or close", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p5b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p5b-holder");
      const issueRef = "example/repo#510";

      const trace: string[] = [];
      const observedLease: OwnerLease = {
        ...lease,
        assertValid() {
          trace.push("assertValid");
          lease.assertValid();
        },
      };

      const tempFds = new Set<number>();
      const dirFds = new Set<number>();
      let forcedShortWrite = false;
      const tracedFs: Partial<StoreFsOps> = {
        mkdirSync(targetPath, options) {
          trace.push(`mkdir:${path.basename(String(targetPath))}`);
          return fs.mkdirSync(targetPath, options as never);
        },
        openSync(targetPath, flags, mode) {
          const fd = fs.openSync(targetPath, flags, mode);
          if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
            tempFds.add(fd);
            trace.push("openTemp");
          } else if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
            dirFds.add(fd);
            trace.push("openDir");
          }
          return fd;
        },
        writeSync: ((
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset?: number | null,
          length?: number | null,
          position?: fs.ReadPosition | null,
        ): number => {
          const off = offset ?? 0;
          let len = length ?? buffer.byteLength - off;
          if (tempFds.has(fd)) {
            trace.push("writeTemp");
            if (!forcedShortWrite && len > 1) {
              forcedShortWrite = true;
              len = Math.max(1, Math.floor(len / 2));
            }
          }
          return fs.writeSync(fd, buffer, off, len, position ?? null);
        }) as typeof fs.writeSync,
        fsyncSync(fd) {
          trace.push(tempFds.has(fd) ? "fsyncTemp" : "fsyncDir");
          fs.fsyncSync(fd);
        },
        closeSync(fd) {
          if (tempFds.has(fd)) {
            tempFds.delete(fd);
            trace.push("closeTemp");
          } else if (dirFds.has(fd)) {
            dirFds.delete(fd);
            trace.push("closeDir");
          }
          fs.closeSync(fd);
        },
        linkSync(existingPath, newPath) {
          trace.push("link");
          fs.linkSync(existingPath, newPath);
        },
        removeTemp(targetPath) {
          trace.push("removeTemp");
          fs.unlinkSync(targetPath);
        },
      };

      const rec = await runWrite(lease, () =>
        appendCommitRecord(observedLease, makeIntentInput({ issueRef }), { fs: tracedFs }),
      );
      assert.equal(rec.seq, 1);

      // Every expected operation must appear in the trace before judging order.
      const expectedOps = [
        "mkdir:tickets",
        "mkdir:510",
        "mkdir:log",
        "openTemp",
        "writeTemp",
        "fsyncTemp",
        "closeTemp",
        "link",
        "removeTemp",
        "openDir",
        "fsyncDir",
        "closeDir",
      ];
      for (const expectedOp of expectedOps) {
        assert.ok(
          trace.includes(expectedOp),
          `Expected operation ${expectedOp} in trace; trace=${trace.join(" -> ")}`,
        );
      }
      const writeTempCount = trace.filter((op) => op === "writeTemp").length;
      assert.ok(
        writeTempCount >= 2,
        `Expected >= 2 writeTemp calls with short write, got ${writeTempCount}; trace=${trace.join(" -> ")}`,
      );
      const fsyncDirCount = trace.filter((op) => op === "fsyncDir").length;
      assert.ok(
        fsyncDirCount >= 4,
        `Expected >= 4 fsyncDir calls (3 parent dirs + post-link dir), got ${fsyncDirCount}; trace=${trace.join(" -> ")}`,
      );

      // Every mutating step must be immediately preceded by assertValid.
      const mutatingSteps = new Set([
        "mkdir:tickets",
        "mkdir:510",
        "mkdir:log",
        "openTemp",
        "writeTemp",
        "link",
        "removeTemp",
      ]);
      for (let i = 0; i < trace.length; i += 1) {
        const op = trace[i]!;
        if (mutatingSteps.has(op)) {
          assert.equal(
            trace[i - 1],
            "assertValid",
            `Expected assertValid immediately before ${op}; trace=${trace.join(" -> ")}`,
          );
        }
        if (op === "fsyncTemp" || op === "fsyncDir" || op === "closeTemp" || op === "closeDir") {
          assert.notEqual(
            trace[i - 1],
            "assertValid",
            `Sync/close (${op}) must not have an assertValid of its own; trace=${trace.join(" -> ")}`,
          );
        }
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 12: identity, lease, and store work together across two processes with claimProject, enqueue write+effect, release after queue drain, readback, higher ownerEpoch, and projectKey/issueRef on every record", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p12-");
    try {
      const repoDir = path.join(ctx.scratchRoot, "repo");
      const stateBase = path.join(ctx.scratchRoot, "state-base");
      const issueRef = "example/repo#12";
      createCleanGitRepo(repoDir);

      // Process 1: claimProject -> writeArtifact -> enqueue(write: intent, effect: stand-in) -> enqueue(write: receipt) -> release.
      const p1 = ctx.spawnStoreWorker([
        "--mode",
        "integration-p1",
        "--worker-id",
        "p1",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--issue-ref",
        issueRef,
      ]);
      const p1Done = await p1.nextEvent(10_000);
      assert.equal(p1Done.event, "integration_p1_done");
      const p1Exit = await p1.exited;
      assert.equal(p1Exit.code, 0);

      assert.equal(p1Done.published, true);
      assert.deepEqual(p1Done.stepOrder, ["write_intent", "run_effect"]);
      const p1ProjectKey = String(p1Done.projectKey);
      const p1StateRoot = String(p1Done.stateRoot);
      const p1Epoch = Number(p1Done.epoch);
      const p1Intent = p1Done.intentEntry as VerifiedCommitEntry;
      const p1Receipt = p1Done.receiptEntry as VerifiedCommitEntry;
      assert.equal(p1Intent.seq, 1);
      assert.equal(p1Receipt.seq, 2);
      assert.equal(p1Intent.record.projectKey, p1ProjectKey);
      assert.equal(p1Intent.record.issueRef, issueRef);
      assert.equal(p1Intent.record.ownerEpoch, p1Epoch);
      assert.deepEqual(p1Receipt.record.receipt?.intentRef, {
        seq: p1Intent.seq,
        sha256: p1Intent.sha256,
      });

      // Process 2: claimProject on the same repo -> openTicketLog -> read same records -> append seq 3 with higher ownerEpoch -> release.
      const p2 = ctx.spawnStoreWorker([
        "--mode",
        "integration-p2",
        "--worker-id",
        "p2",
        "--cwd",
        repoDir,
        "--state-base",
        stateBase,
        "--issue-ref",
        issueRef,
      ]);
      const p2Done = await p2.nextEvent(10_000);
      assert.equal(p2Done.event, "integration_p2_done");
      const p2Exit = await p2.exited;
      assert.equal(p2Exit.code, 0);

      assert.equal(p2Done.published, false);
      assert.equal(p2Done.projectKey, p1ProjectKey);
      assert.equal(p2Done.stateRoot, p1StateRoot);
      const p2Epoch = Number(p2Done.epoch);
      assert.equal(p2Epoch > p1Epoch, true, `Expected p2 epoch (${p2Epoch}) > p1 epoch (${p1Epoch})`);

      const p2Opened = p2Done.opened as OpenTicketLogResult;
      assert.equal(p2Opened.status, "clean");
      assert.equal(p2Opened.records.length, 2);
      assert.deepEqual(p2Opened.records[0]?.record, p1Intent.record);
      assert.deepEqual(p2Opened.records[1]?.record, p1Receipt.record);
      assert.equal(p2Opened.records[0]?.sha256, p1Intent.sha256);
      assert.equal(p2Opened.records[1]?.sha256, p1Receipt.sha256);

      const p2Next = p2Done.nextEntry as VerifiedCommitEntry;
      assert.equal(p2Next.seq, 3);
      assert.equal(p2Next.record.prevRecordSha256, p1Receipt.sha256);
      assert.equal(p2Next.record.ownerEpoch, p2Epoch);
      assert.equal(p2Next.record.ownerEpoch > p1Intent.record.ownerEpoch, true);

      // Final read-only open confirms all 3 records carry projectKey and issueRef.
      const finalOpen = openTicketLog({
        stateRoot: p1StateRoot,
        projectKey: p1ProjectKey,
        issueRef,
      });
      assert.equal(finalOpen.status, "clean");
      assert.equal(finalOpen.records.length, 3);
      for (const entry of finalOpen.records) {
        assert.equal(entry.record.projectKey, p1ProjectKey);
        assert.equal(entry.record.issueRef, issueRef);
      }
    } finally {
      await ctx.cleanup();
    }
  });
});
