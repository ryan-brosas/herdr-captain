import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  appendCommitRecord,
  getTicketPaths,
  openTicketLog,
  readArtifact,
  writeArtifact,
  type StoreFsOps,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  assertNoFileDeletedInTree,
  assertRawFileUnchanged,
  createStoreTestContext,
  DEFAULT_PROJECT_KEY,
  expectErrorCode,
  makeIntentInput,
  makeReceiptInput,
  runWrite,
  sha256Hex,
  snapshotRawFile,
  snapshotTree,
} from "./helpers/store-fixtures.ts";

assertSupportedBunVersion(Bun.version);

const FOLDER_CRASH_STEPS = [
  "after-mkdir-tickets",
  "after-fsync-tickets-parent",
  "after-mkdir-issue",
  "after-fsync-issue-parent",
  "after-mkdir-leaf",
  "after-fsync-leaf-parent",
] as const;

const FILE_CRASH_STEPS = [
  "after-open-temp",
  "after-short-write",
  "after-full-write",
  "after-file-fsync",
  "after-file-close",
  "after-link",
  "after-unlink-temp",
  "after-dir-fsync",
] as const;

const STEPS_WITH_TEMP_ON_DISK = new Set<string>([
  "after-open-temp",
  "after-short-write",
  "after-full-write",
  "after-file-fsync",
  "after-file-close",
  "after-link",
]);

const STEPS_AFTER_LINK = new Set<string>([
  "after-link",
  "after-unlink-temp",
  "after-dir-fsync",
]);

function makeErrno(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected error in ${syscall}`), {
    code,
    syscall,
  });
}

describe("commit-log store crash recovery and syscall failure handling (proofs 3 and 4)", () => {
  test(
    "proof 3: SIGKILL at every folder and publication step for artifact, intent, and receipt leaves clean log, complete files, untouched leftovers, and valid next append",
    async () => {
      const ctx = createStoreTestContext("herdr-s1c-p3a-");
      try {
        let issueNum = 300;

        const runCrashCase = async (params: {
          readonly kind: "artifact" | "intent" | "receipt";
          readonly step: string;
          readonly preSeedIntent: boolean;
        }): Promise<void> => {
          issueNum += 1;
          const stateRoot = path.join(ctx.scratchRoot, `state-${issueNum}`);
          const issueRef = `example/repo#${issueNum}`;
          const paths = getTicketPaths(stateRoot, issueRef);
          const baselineCount = params.preSeedIntent ? 1 : 0;

          if (params.preSeedIntent) {
            const seedLease = await ctx.acquireTrackedLease(
              stateRoot,
              DEFAULT_PROJECT_KEY,
              `p3-seed-${issueNum}`,
            );
            await runWrite(seedLease, () =>
              appendCommitRecord(
                seedLease,
                makeIntentInput({ issueRef, event: "pre_seed_intent", attemptId: "att-seed" }),
              ),
            );
            await seedLease.release();
          }

          const treeBefore = snapshotTree(paths.ticketDir);
          const artifactContent = `crash test artifact ${issueNum}\nsecond line for short write split\n`;
          const expectedArtSha = sha256Hex(artifactContent);
          const expectedArtPath = path.join(paths.artifactsDir, `${expectedArtSha}.md`);

          const workerArgs = [
            "--mode",
            params.kind === "artifact" ? "artifact" : "append",
            "--worker-id",
            `${params.kind}-${params.step}`,
            "--state-root",
            stateRoot,
            "--project-key",
            DEFAULT_PROJECT_KEY,
            "--issue-ref",
            issueRef,
            "--pause-at",
            params.step,
            "--tag",
            `case-${issueNum}`,
          ];
          if (params.kind === "artifact") {
            workerArgs.push("--content", artifactContent);
          } else {
            workerArgs.push("--record-kind", params.kind);
          }

          const worker = ctx.spawnStoreWorker(workerArgs);
          const paused = await worker.nextEvent(8000);
          assert.equal(paused.event, "paused", `${params.kind}/${params.step}: expected paused`);
          assert.equal(paused.point, params.step, `${params.kind}/${params.step}: wrong pause point`);

          const holderPid = Number(paused.holderPid);
          const holderStartTime = String(paused.holderStartTime);
          const tmpPath = typeof paused.tmpPath === "string" ? paused.tmpPath : null;
          const writtenBase64 =
            typeof paused.writtenBytesBase64 === "string" ? paused.writtenBytesBase64 : null;

          // Kill worker with SIGKILL and assert it died by SIGKILL, not by itself.
          const exit = await worker.killWithSigkill();
          assert.equal(
            exit.signal,
            "SIGKILL",
            `${params.kind}/${params.step}: child must die by SIGKILL`,
          );
          await ctx.waitForProcessDead(holderPid, holderStartTime);

          // Snapshot leftover temp if one is expected on disk at this crash step.
          let leftoverSnap = null;
          if (STEPS_WITH_TEMP_ON_DISK.has(params.step)) {
            assert.ok(tmpPath !== null, `${params.kind}/${params.step}: expected tmpPath`);
            assert.equal(
              fs.existsSync(tmpPath),
              true,
              `${params.kind}/${params.step}: leftover temp file must remain on disk`,
            );
            leftoverSnap = snapshotRawFile(tmpPath);
          }

          // Fresh OS process opens the ticket.
          const opened = await ctx.runFreshOpen(stateRoot, DEFAULT_PROJECT_KEY, issueRef);
          assert.equal(
            opened.status,
            "clean",
            `${params.kind}/${params.step}: log must open clean after crash`,
          );

          const publishedNewRecord =
            params.kind !== "artifact" && STEPS_AFTER_LINK.has(params.step);
          const expectedCount = baselineCount + (publishedNewRecord ? 1 : 0);
          assert.equal(
            opened.records.length,
            expectedCount,
            `${params.kind}/${params.step}: expected ${expectedCount} record(s)`,
          );
          assertNoFileDeletedInTree(
            paths.ticketDir,
            treeBefore,
            new Set(),
            `${params.kind}/${params.step}: no pre-existing file may be deleted`,
          );

          if (params.kind === "artifact") {
            if (STEPS_AFTER_LINK.has(params.step)) {
              assert.ok(
                writtenBase64 !== null && writtenBase64.length > 0,
                `${params.kind}/${params.step}: worker must report written byte evidence after link`,
              );
              assert.equal(fs.existsSync(expectedArtPath), true);
              const expectedBytes = Buffer.from(writtenBase64, "base64");
              const actualBytes = fs.readFileSync(expectedArtPath);
              assert.equal(
                Buffer.compare(actualBytes, expectedBytes),
                0,
                `${params.kind}/${params.step}: published artifact bytes must match worker evidence`,
              );
              const readBack = readArtifact({ stateRoot, issueRef, sha256: expectedArtSha });
              assert.equal(readBack.content.toString("utf8"), artifactContent);
            } else {
              assert.equal(fs.existsSync(expectedArtPath), false);
            }
          } else if (publishedNewRecord) {
            const lastEntry = opened.records[opened.records.length - 1]!;
            assert.equal(lastEntry.seq, expectedCount);
            assert.ok(
              writtenBase64 !== null && writtenBase64.length > 0,
              `${params.kind}/${params.step}: worker must report written byte evidence after link`,
            );
            const expectedBytes = Buffer.from(writtenBase64, "base64");
            const actualBytes = fs.readFileSync(lastEntry.path);
            assert.equal(
              Buffer.compare(actualBytes, expectedBytes),
              0,
              `${params.kind}/${params.step}: published record bytes must be complete`,
            );
          }

          // Next append under a new lease gets the right sequence number and leaves leftover temp intact.
          const nextLease = await ctx.acquireTrackedLease(
            stateRoot,
            DEFAULT_PROJECT_KEY,
            `p3-next-${issueNum}`,
          );
          const nextRec = await runWrite(nextLease, () =>
            appendCommitRecord(nextLease, makeIntentInput({ issueRef, event: "after_crash" })),
          );
          assert.equal(
            nextRec.seq,
            expectedCount + 1,
            `${params.kind}/${params.step}: next append must get seq ${expectedCount + 1}`,
          );
          await nextLease.release();

          if (tmpPath !== null && leftoverSnap !== null) {
            assertRawFileUnchanged(
              tmpPath,
              leftoverSnap,
              `${params.kind}/${params.step}: leftover temp must stay untouched`,
            );
          }
        };

        // Artifact: every folder step + every publication step.
        for (const step of [...FOLDER_CRASH_STEPS, ...FILE_CRASH_STEPS]) {
          await runCrashCase({ kind: "artifact", step, preSeedIntent: false });
        }

        // Intent: every folder step + every publication step.
        for (const step of [...FOLDER_CRASH_STEPS, ...FILE_CRASH_STEPS]) {
          await runCrashCase({ kind: "intent", step, preSeedIntent: false });
        }

        // Receipt: folder steps on a fresh ticket, and file publication steps after an intent (n = 1).
        for (const step of FOLDER_CRASH_STEPS) {
          await runCrashCase({ kind: "receipt", step, preSeedIntent: false });
        }
        for (const step of FILE_CRASH_STEPS) {
          await runCrashCase({ kind: "receipt", step, preSeedIntent: true });
        }
      } finally {
        await ctx.cleanup();
      }
    },
    30_000,
  );

  test("proof 3: SIGKILL between intent and receipt leaves clean log ending in intent, and non-crashing short write finishes cleanly", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p3b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");

      // Part A: crash between intent and receipt.
      const issueRefA = "example/repo#350";
      const workerA = ctx.spawnStoreWorker([
        "--mode",
        "intent-then-receipt",
        "--worker-id",
        "between-crash",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        issueRefA,
        "--tag",
        "gap",
      ]);
      const pausedA = await workerA.nextEvent(8000);
      assert.equal(pausedA.event, "paused");
      assert.equal(pausedA.point, "between-intent-and-receipt");
      const exitA = await workerA.killWithSigkill();
      assert.equal(exitA.signal, "SIGKILL");
      await ctx.waitForProcessDead(Number(pausedA.holderPid), String(pausedA.holderStartTime));

      const openedA = await ctx.runFreshOpen(stateRoot, DEFAULT_PROJECT_KEY, issueRefA);
      assert.equal(openedA.status, "clean");
      assert.equal(openedA.records.length, 1);
      assert.equal(openedA.lastSeq, 1);
      assert.equal(openedA.records[0]?.sha256, pausedA.intentSha256);
      assert.ok(openedA.records[0]?.record.intent !== undefined);
      assert.equal(openedA.records[0]?.record.receipt, undefined);

      const leaseA = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p3b-next");
      const rec2 = await runWrite(leaseA, () =>
        appendCommitRecord(leaseA, makeReceiptInput({ issueRef: issueRefA })),
      );
      assert.equal(rec2.seq, 2);
      assert.equal(rec2.record.prevRecordSha256, pausedA.intentSha256);
      await leaseA.release();

      // Part B: resuming after a short write writes remaining bytes cleanly and publishes full record.
      const issueRefB = "example/repo#351";
      const workerB = ctx.spawnStoreWorker([
        "--mode",
        "append",
        "--worker-id",
        "short-write-resume",
        "--state-root",
        stateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        issueRefB,
        "--pause-at",
        "after-short-write",
        "--record-kind",
        "intent",
        "--tag",
        "short-ok",
      ]);
      const pausedB = await workerB.nextEvent(8000);
      assert.equal(pausedB.event, "paused");
      assert.equal(pausedB.point, "after-short-write");
      workerB.resumePause("go");
      const okB = await workerB.nextEvent(8000);
      assert.equal(okB.event, "append_ok");
      const exitB = await workerB.exited;
      assert.equal(exitB.code, 0);

      const openedB = await ctx.runFreshOpen(stateRoot, DEFAULT_PROJECT_KEY, issueRefB);
      assert.equal(openedB.status, "clean");
      assert.equal(openedB.records.length, 1);
      assert.equal(openedB.records[0]?.record.event, "intent_short-ok");
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 4: injected syscall errors at folder creation, exclusive create, write, file sync, link, and dir sync surface their errno codes, clean up temp with valid lease, and allow the next append", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p4a-");
    try {
      const listTempFiles = (dir: string): string[] =>
        fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(".")) : [];

      // 1. Folder creation error at tickets/, <issue>/, and log/.
      for (const [idx, stage] of (["tickets", "issue", "log"] as const).entries()) {
        const subRoot = path.join(ctx.scratchRoot, `state-mkdir-${idx}`);
        const subLease = await ctx.acquireTrackedLease(
          subRoot,
          DEFAULT_PROJECT_KEY,
          `p4-mkdir-${stage}`,
        );
        const issueRef = `example/repo#${401 + idx}`;
        const paths = getTicketPaths(subRoot, issueRef);
        const failTarget =
          stage === "tickets"
            ? path.resolve(path.dirname(paths.ticketDir))
            : stage === "issue"
              ? path.resolve(paths.ticketDir)
              : path.resolve(paths.logDir);

        const failFs: Partial<StoreFsOps> = {
          mkdirSync(targetPath, options) {
            if (path.resolve(String(targetPath)) === failTarget) {
              throw makeErrno("EACCES", "mkdir");
            }
            return fs.mkdirSync(targetPath, options as never);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(subLease, () =>
              appendCommitRecord(subLease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EACCES",
          `mkdir failure at ${stage}`,
        );
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);

        const next = await runWrite(subLease, () =>
          appendCommitRecord(subLease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
        await subLease.release();
      }

      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p4a-holder");

      // 2. Parent folder sync error after creating log/.
      {
        const issueRef = "example/repo#410";
        const paths = getTicketPaths(stateRoot, issueRef);
        const dirFds = new Map<number, string>();
        let createdLog = false;
        const failFs: Partial<StoreFsOps> = {
          mkdirSync(targetPath, options) {
            const res = fs.mkdirSync(targetPath, options as never);
            if (path.resolve(String(targetPath)) === path.resolve(paths.logDir)) {
              createdLog = true;
            }
            return res;
          },
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
              dirFds.set(fd, path.resolve(String(targetPath)));
            }
            return fd;
          },
          fsyncSync(fd) {
            if (createdLog && dirFds.get(fd) === path.resolve(paths.ticketDir)) {
              throw makeErrno("EIO", "fsync");
            }
            fs.fsyncSync(fd);
          },
          closeSync(fd) {
            dirFds.delete(fd);
            fs.closeSync(fd);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EIO",
          "parent folder fsync error",
        );
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
        assert.deepEqual(listTempFiles(paths.logDir), []);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // 3. Exclusive creation error (openSync O_CREAT|O_EXCL fails -> removeTemp not called).
      {
        const issueRef = "example/repo#411";
        const paths = getTicketPaths(stateRoot, issueRef);
        let removeCalls = 0;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              throw makeErrno("ENOSPC", "open");
            }
            return fs.openSync(targetPath, flags, mode);
          },
          removeTemp(targetPath) {
            removeCalls += 1;
            fs.unlinkSync(targetPath);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "ENOSPC",
          "exclusive temp creation error",
        );
        assert.equal(removeCalls, 0);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // 4. Write error (ENOSPC) and zero-byte short_write -> own temp removed, nothing published.
      for (const writeMode of ["enospc", "zero"] as const) {
        const issueRef = writeMode === "enospc" ? "example/repo#412" : "example/repo#413";
        const paths = getTicketPaths(stateRoot, issueRef);
        let createdTmp: string | null = null;
        let removedTmp: string | null = null;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmp = String(targetPath);
            }
            return fd;
          },
          writeSync: (() => {
            if (writeMode === "enospc") {
              throw makeErrno("ENOSPC", "write");
            }
            return 0;
          }) as typeof fs.writeSync,
          removeTemp(targetPath) {
            removedTmp = String(targetPath);
            fs.unlinkSync(targetPath);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          writeMode === "enospc" ? "ENOSPC" : "short_write",
          `write failure (${writeMode})`,
        );
        assert.ok(createdTmp !== null);
        assert.equal(removedTmp, createdTmp);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // 5. File fsync error (EIO) -> own temp removed, nothing published.
      {
        const issueRef = "example/repo#414";
        const paths = getTicketPaths(stateRoot, issueRef);
        let tempFd: number | null = null;
        let createdTmp: string | null = null;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              tempFd = fd;
              createdTmp = String(targetPath);
            }
            return fd;
          },
          fsyncSync(fd) {
            if (fd === tempFd) {
              throw makeErrno("EIO", "fsync");
            }
            fs.fsyncSync(fd);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EIO",
          "file fsync error",
        );
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // 6. Link error (non-EEXIST: EXDEV) -> own temp removed, nothing published.
      {
        const issueRef = "example/repo#415";
        const paths = getTicketPaths(stateRoot, issueRef);
        let createdTmp: string | null = null;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmp = String(targetPath);
            }
            return fd;
          },
          linkSync() {
            throw makeErrno("EXDEV", "link");
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EXDEV",
          "linkSync non-EEXIST error",
        );
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // 7. Folder fsync error after link succeeded -> EIO reaches caller, temp removed, record 1 IS published, next append gets seq 2.
      {
        const issueRef = "example/repo#416";
        const paths = getTicketPaths(stateRoot, issueRef);
        const dirFds = new Map<number, string>();
        let linked = false;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
              dirFds.set(fd, path.resolve(String(targetPath)));
            }
            return fd;
          },
          linkSync(existingPath, newPath) {
            fs.linkSync(existingPath, newPath);
            linked = true;
          },
          fsyncSync(fd) {
            if (linked && dirFds.get(fd) === path.resolve(paths.logDir)) {
              throw makeErrno("EIO", "fsync");
            }
            fs.fsyncSync(fd);
          },
          closeSync(fd) {
            dirFds.delete(fd);
            fs.closeSync(fd);
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EIO",
          "post-link dir fsync error",
        );
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), true);
        assert.deepEqual(listTempFiles(paths.logDir), []);
        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeReceiptInput({ issueRef })),
        );
        assert.equal(next.seq, 2);
      }

      // 8. Artifact write syscall error (writeSync ENOSPC) -> cleans own temp, publishes nothing, next artifact write works.
      {
        const issueRef = "example/repo#417";
        const paths = getTicketPaths(stateRoot, issueRef);
        const artBody = "artifact-retry-body\n";
        const artSha = sha256Hex(artBody);
        let createdTmp: string | null = null;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmp = String(targetPath);
            }
            return fd;
          },
          writeSync: (() => {
            throw makeErrno("ENOSPC", "write");
          }) as typeof fs.writeSync,
        };
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, artBody, { fs: failFs })),
          "ENOSPC",
          "artifact writeSync ENOSPC",
        );
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.artifactsDir, `${artSha}.md`)), false);
        const okArt = await runWrite(lease, () => writeArtifact(lease, issueRef, artBody));
        assert.equal(okArt.created, true);
        assert.equal(okArt.sha256, artSha);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 4: closeSync and removeTemp errors never hide an earlier error; normal closeSync error aborts before link and cleans temp; normal removeTemp error keeps publication and syncs dir", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p4b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p4b-holder");

      // Case 1: Normal-path closeSync error on temp fd -> reaches caller with EIO, cleans temp, nothing published, next append gets seq 1.
      {
        const issueRef = "example/repo#420";
        const paths = getTicketPaths(stateRoot, issueRef);
        let tempFd: number | null = null;
        let createdTmp: string | null = null;
        let closeCallsOnTemp = 0;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              tempFd = fd;
              createdTmp = String(targetPath);
            }
            return fd;
          },
          closeSync(fd) {
            fs.closeSync(fd);
            if (fd === tempFd) {
              closeCallsOnTemp += 1;
              throw makeErrno("EIO", "close");
            }
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EIO",
          "normal-path closeSync error",
        );
        assert.equal(closeCallsOnTemp, 1, "temp fd must not be double-closed");
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // Case 2: Unwind-path closeSync error after writeSync ENOSPC -> ENOSPC reaches caller (never hidden by close error), cleans temp, nothing published.
      {
        const issueRef = "example/repo#421";
        const paths = getTicketPaths(stateRoot, issueRef);
        let tempFd: number | null = null;
        let createdTmp: string | null = null;
        let unwindCloseTriggered = false;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              tempFd = fd;
              createdTmp = String(targetPath);
            }
            return fd;
          },
          writeSync: (() => {
            throw makeErrno("ENOSPC", "write");
          }) as typeof fs.writeSync,
          closeSync(fd) {
            fs.closeSync(fd);
            if (fd === tempFd) {
              unwindCloseTriggered = true;
              throw makeErrno("EIO", "close");
            }
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "ENOSPC",
          "unwind closeSync must not hide writeSync ENOSPC",
        );
        assert.equal(unwindCloseTriggered, true);
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), false);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      // Case 3: Normal-path removeTemp error after link -> swallowed (like publishProjectRecord), dir fsync still runs, call succeeds, temp stays ignored, next append gets seq 2.
      {
        const issueRef = "example/repo#422";
        const paths = getTicketPaths(stateRoot, issueRef);
        let createdTmp: string | null = null;
        let postLinkDirFsyncRan = false;
        let linked = false;
        const dirFds = new Map<number, string>();
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmp = String(targetPath);
            } else if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
              dirFds.set(fd, path.resolve(String(targetPath)));
            }
            return fd;
          },
          linkSync(existingPath, newPath) {
            fs.linkSync(existingPath, newPath);
            linked = true;
          },
          removeTemp() {
            throw makeErrno("EACCES", "unlink");
          },
          fsyncSync(fd) {
            fs.fsyncSync(fd);
            if (linked && dirFds.get(fd) === path.resolve(paths.logDir)) {
              postLinkDirFsyncRan = true;
            }
          },
          closeSync(fd) {
            dirFds.delete(fd);
            fs.closeSync(fd);
          },
        };
        const rec1 = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
        );
        assert.equal(rec1.seq, 1);
        assert.equal(postLinkDirFsyncRan, true, "log/ dir fsync must still run after failed temp removal");
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), true, "failed temp removal leaves dot-file on disk");

        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 1);

        const rec2 = await runWrite(lease, () =>
          appendCommitRecord(lease, makeReceiptInput({ issueRef })),
        );
        assert.equal(rec2.seq, 2);
      }

      // Case 4: Unwind-path removeTemp error after linkSync EXDEV -> primary EXDEV reaches caller (never hidden), temp stays ignored, next append gets seq 1.
      {
        const issueRef = "example/repo#423";
        const paths = getTicketPaths(stateRoot, issueRef);
        let createdTmp: string | null = null;
        let removeAttempted = false;
        const failFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmp = String(targetPath);
            }
            return fd;
          },
          linkSync() {
            throw makeErrno("EXDEV", "link");
          },
          removeTemp() {
            removeAttempted = true;
            throw makeErrno("EACCES", "unlink");
          },
        };
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef }), { fs: failFs }),
            ),
          "EXDEV",
          "unwind removeTemp error must not hide primary linkSync EXDEV",
        );
        assert.equal(removeAttempted, true);
        assert.ok(createdTmp !== null);
        assert.equal(fs.existsSync(createdTmp), true);
        assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef })),
        );
        assert.equal(next.seq, 1);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
