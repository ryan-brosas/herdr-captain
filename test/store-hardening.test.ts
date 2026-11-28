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
  readArtifact,
  StoreError,
  writeArtifact,
  type CountersAfter,
  type EvidenceRef,
  type OpenTicketLogResult,
  type StoreFsOps,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import { confirmProcessDead } from "./helpers/process.ts";
import {
  assertRawFileUnchanged,
  assertTreeUnchanged,
  createStoreTestContext,
  DEFAULT_PROJECT_KEY,
  expectErrorCode,
  makeIntentInput,
  makeReceiptInput,
  runWrite,
  sha256Hex,
  snapshotRawFile,
  snapshotTree,
  type StoreTestContext,
} from "./helpers/store-fixtures.ts";

assertSupportedBunVersion(Bun.version);

interface FifoWorkerOutcome {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly result?: unknown;
}

async function runFifoWorkerWithDeadline(
  ctx: StoreTestContext,
  workerArgs: string[],
  label: string,
  deadlineMs = 3000,
): Promise<FifoWorkerOutcome> {
  const worker = ctx.spawnStoreWorker(["--mode", "fifo-op", ...workerArgs]);
  let holderPid: number | null = null;
  let holderStartTime: string | null = null;
  const startedAt = performance.now();

  try {
    while (true) {
      const remainingMs = Math.max(1, Math.floor(deadlineMs - (performance.now() - startedAt)));
      let ev: Record<string, unknown>;
      try {
        ev = await worker.nextEvent(remainingMs);
      } catch (err) {
        await worker.killWithSigkill();
        if (holderPid !== null && holderStartTime !== null) {
          await ctx.killHolderAndWaitDead(holderPid, holderStartTime);
        }
        assert.equal(
          confirmProcessDead(worker.pid, worker.startTime),
          true,
          `${label}: timed-out worker pid=${worker.pid} must be confirmed dead`,
        );
        throw new Error(`${label}: blocked or failed within ${deadlineMs}ms: ${String(err)}`);
      }

      if (ev.event === "lease_acquired") {
        holderPid = Number(ev.holderPid);
        holderStartTime = String(ev.holderStartTime);
        ctx.trackPid(holderPid, holderStartTime, `${label}-holder`);
        continue;
      }

      if (ev.event === "op_result") {
        const exitRemaining = Math.max(200, Math.floor(deadlineMs - (performance.now() - startedAt)));
        const exit = await Promise.race([
          worker.exited,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label}: worker did not exit after op_result`)), exitRemaining),
          ),
        ]);
        assert.equal(exit.code, 0, `${label}: worker exited with ${String(exit.code)}`);
        assert.equal(
          confirmProcessDead(worker.pid, worker.startTime),
          true,
          `${label}: worker pid=${worker.pid} must be dead after exit`,
        );
        if (holderPid !== null && holderStartTime !== null) {
          await ctx.waitForProcessDead(holderPid, holderStartTime);
          assert.equal(
            confirmProcessDead(holderPid, holderStartTime),
            true,
            `${label}: holder pid=${holderPid} must be dead after exit`,
          );
        }
        return {
          ok: Boolean(ev.ok),
          code: typeof ev.code === "string" ? ev.code : null,
          message: typeof ev.message === "string" ? ev.message : undefined,
          result: ev.result,
        };
      }
    }
  } finally {
    if (!worker.hasExited()) {
      await worker.killWithSigkill();
    }
    if (holderPid !== null && holderStartTime !== null && !confirmProcessDead(holderPid, holderStartTime)) {
      await ctx.killHolderAndWaitDead(holderPid, holderStartTime);
    }
    assert.equal(
      confirmProcessDead(worker.pid, worker.startTime),
      true,
      `${label}: worker pid=${worker.pid} must be dead in finally`,
    );
  }
}

describe("commit-log store hardening (fix round 1: C1 to C6)", () => {
  test("proof 2: appendCommitRecord validates the serialized envelope and parsed evidenceRefs before publishing", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c1-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c1-holder");
      const issueRef = "example/repo#601";

      const art = await runWrite(lease, () =>
        writeArtifact(lease, issueRef, "valid-c1-artifact-body\n"),
      );

      // Case 1: payload data with own toJSON returning null -> refused, tree unchanged, next append works.
      {
        const before = snapshotTree(stateRoot);
        const badData = {
          note: "looks-plain",
          toJSON() {
            return null;
          },
        } as unknown as Record<string, unknown>;
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(
                lease,
                makeIntentInput({
                  issueRef,
                  intent: { kind: "dispatch", version: 1, data: badData },
                }),
              ),
            ),
          "invalid_argument",
          "payload data.toJSON() returning null",
        );
        assertTreeUnchanged(stateRoot, before, "data.toJSON() -> null must write nothing");

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef, event: "after_c1_tojson" })),
        );
        assert.equal(next.seq, 1);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 1);
      }

      // Case 2: counter getter returning 0 on first read and -1 on second read -> refused, tree unchanged.
      {
        const before = snapshotTree(stateRoot);
        let counterReads = 0;
        const shiftingCounters = {
          get attemptSeq(): number {
            counterReads += 1;
            return counterReads === 1 ? 0 : -1;
          },
          totalAttemptsUsed: 0,
          fixRoundsUsed: 0,
        } as CountersAfter;
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(
                lease,
                makeIntentInput({
                  issueRef,
                  countersAfter: shiftingCounters,
                }),
              ),
            ),
          "invalid_argument",
          "counter getter switching from 0 to -1",
        );
        assert.ok(counterReads >= 2, `expected getter to be read at least twice, got ${counterReads}`);
        assertTreeUnchanged(stateRoot, before, "shifting counter getter must write nothing");

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeReceiptInput({ issueRef, event: "after_c1_counter" })),
        );
        assert.equal(next.seq, 2);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 2);
      }

      // Case 3a: evidenceRefs entry whose sha256 getter changes from valid digest to invalid format.
      {
        const before = snapshotTree(stateRoot);
        let shaReads = 0;
        const shiftingInvalidRef = {
          kind: "brief",
          get sha256(): string {
            shaReads += 1;
            return shaReads === 1 ? art.sha256 : "not-a-valid-sha256";
          },
          bytes: art.bytes,
          truncated: false,
        } as EvidenceRef;
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(
                lease,
                makeIntentInput({ issueRef, evidenceRefs: [shiftingInvalidRef] }),
              ),
            ),
          "invalid_argument",
          "evidenceRef sha256 getter switching to invalid hex",
        );
        assert.ok(shaReads >= 2, `expected sha256 getter to be read at least twice, got ${shaReads}`);
        assertTreeUnchanged(stateRoot, before, "shifting evidenceRef invalid sha256 must write nothing");

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef, event: "after_c1_ref_invalid" })),
        );
        assert.equal(next.seq, 3);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 3);
      }

      // Case 3b: evidenceRefs entry whose sha256 getter changes from existing digest to missing digest.
      {
        const before = snapshotTree(stateRoot);
        let shaReads = 0;
        const missingSha = "f".repeat(64);
        const shiftingMissingRef = {
          kind: "brief",
          get sha256(): string {
            shaReads += 1;
            return shaReads === 1 ? art.sha256 : missingSha;
          },
          bytes: art.bytes,
          truncated: false,
        } as EvidenceRef;
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(
                lease,
                makeIntentInput({ issueRef, evidenceRefs: [shiftingMissingRef] }),
              ),
            ),
          "artifact_missing",
          "evidenceRef sha256 getter switching to missing artifact",
        );
        assert.ok(shaReads >= 2, `expected sha256 getter to be read at least twice, got ${shaReads}`);
        assertTreeUnchanged(stateRoot, before, "shifting evidenceRef missing sha256 must write nothing");

        const next = await runWrite(lease, () =>
          appendCommitRecord(lease, makeReceiptInput({ issueRef, event: "after_c1_ref_missing" })),
        );
        assert.equal(next.seq, 4);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 4);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: writeArtifact copies Uint8Array and Buffer bytes before hashing so post-hash mutation cannot corrupt publication", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c2-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c2-holder");
      const issueRef = "example/repo#602";

      const backing = new Uint8Array(Buffer.from("PREFIX-sliced-uint8array-artifact-body!\nSUFFIX", "utf8"));
      const inputs: Array<{ readonly label: string; readonly data: Uint8Array | Buffer }> = [
        { label: "plain Uint8Array", data: new Uint8Array(Buffer.from("plain-uint8-artifact-body\n", "utf8")) },
        { label: "subarray Uint8Array", data: backing.subarray(7, backing.byteLength - 6) },
        { label: "Buffer", data: Buffer.from("buffer-artifact-body\n", "utf8") },
      ];

      for (const tc of inputs) {
        const expectedBytes = Buffer.from(tc.data);
        const expectedSha = sha256Hex(expectedBytes);
        let mutated = false;

        const mutateOnCreateFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0 && !mutated) {
              mutated = true;
              tc.data.fill(0x58);
            }
            return fs.openSync(targetPath, flags, mode);
          },
        };

        const published = await runWrite(lease, () =>
          writeArtifact(lease, issueRef, tc.data, { fs: mutateOnCreateFs }),
        );
        assert.equal(mutated, true, `${tc.label}: openSync mutation hook must have run`);
        assert.equal(published.created, true, `${tc.label}: expected new artifact`);
        assert.equal(published.sha256, expectedSha, `${tc.label}: sha256 must match call-time bytes`);
        assert.equal(published.bytes, expectedBytes.byteLength);

        const diskBytes = fs.readFileSync(published.path);
        assert.equal(
          Buffer.compare(diskBytes, expectedBytes),
          0,
          `${tc.label}: published file bytes must equal bytes at call time`,
        );
        assert.equal(
          sha256Hex(diskBytes),
          published.sha256,
          `${tc.label}: published file bytes must hash to its filename`,
        );

        const readBack = readArtifact({ stateRoot, issueRef, sha256: expectedSha });
        assert.equal(Buffer.compare(readBack.content, expectedBytes), 0);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: writeArtifact syncs artifacts folder on both first-look hit and EEXIST race without a lease check before sync", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c3-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c3-holder");
      const issueRef = "example/repo#603";
      const paths = getTicketPaths(stateRoot, issueRef);
      const resolvedArtifactsDir = path.resolve(paths.artifactsDir);

      // Path A: first-look hit on already-present artifact.
      {
        const body = Buffer.from("c3-first-look-artifact\n", "utf8");
        const first = await runWrite(lease, () => writeArtifact(lease, issueRef, body));
        assert.equal(first.created, true);

        const treeBefore = snapshotTree(paths.artifactsDir);
        const fileBefore = snapshotRawFile(first.path);

        const trace: string[] = [];
        const observedLease: OwnerLease = {
          ...lease,
          assertValid() {
            trace.push("assertValid");
            lease.assertValid();
          },
        };
        const dirFdMap = new Map<number, string>();
        let openCreateCount = 0;
        let linkCount = 0;
        let artifactsDirFsyncs = 0;

        const spyFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              openCreateCount += 1;
              trace.push("openCreate");
            }
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
              dirFdMap.set(fd, path.resolve(String(targetPath)));
              trace.push("openDir");
            }
            return fd;
          },
          linkSync(existingPath, newPath) {
            linkCount += 1;
            trace.push("link");
            return fs.linkSync(existingPath, newPath);
          },
          fsyncSync(fd) {
            const dirPath = dirFdMap.get(fd);
            if (dirPath === resolvedArtifactsDir) {
              artifactsDirFsyncs += 1;
              trace.push("fsyncArtifactsDir");
            } else {
              trace.push("fsyncOther");
            }
            fs.fsyncSync(fd);
          },
          closeSync(fd) {
            if (dirFdMap.delete(fd)) {
              trace.push("closeDir");
            }
            fs.closeSync(fd);
          },
        };

        const second = await runWrite(lease, () =>
          writeArtifact(observedLease, issueRef, body, { fs: spyFs }),
        );
        assert.equal(second.created, false);
        assert.equal(second.sha256, first.sha256);
        assert.equal(openCreateCount, 0, "first-look hit must create no temp file");
        assert.equal(linkCount, 0, "first-look hit must not link");
        assert.equal(
          artifactsDirFsyncs,
          1,
          `first-look hit must sync artifacts folder once; trace=${trace.join(" -> ")}`,
        );
        for (let i = 0; i < trace.length; i += 1) {
          if (trace[i] === "fsyncArtifactsDir" || trace[i] === "closeDir") {
            assert.notEqual(
              trace[i - 1],
              "assertValid",
              `first-look ${trace[i]} must not get its own lease check; trace=${trace.join(" -> ")}`,
            );
          }
        }
        assertTreeUnchanged(paths.artifactsDir, treeBefore, "first-look hit changes nothing on disk");
        assertRawFileUnchanged(first.path, fileBefore, "first-look artifact file untouched");
      }

      // Path B: EEXIST at linkSync against matching bytes -> temp file removed and artifacts dir synced.
      {
        const raceBody = Buffer.from("c3-eexist-race-artifact\n", "utf8");
        const raceSha = sha256Hex(raceBody);
        const raceFinalPath = path.join(paths.artifactsDir, `${raceSha}.md`);

        const trace: string[] = [];
        const observedLease: OwnerLease = {
          ...lease,
          assertValid() {
            trace.push("assertValid");
            lease.assertValid();
          },
        };
        const dirFdMap = new Map<number, string>();
        let createdTmpPath: string | null = null;
        let artifactsDirFsyncs = 0;

        const raceFs: Partial<StoreFsOps> = {
          openSync(targetPath, flags, mode) {
            const fd = fs.openSync(targetPath, flags, mode);
            if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
              createdTmpPath = String(targetPath);
              trace.push("openTemp");
            } else if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
              dirFdMap.set(fd, path.resolve(String(targetPath)));
              trace.push("openDir");
            }
            return fd;
          },
          linkSync(existingPath, newPath) {
            trace.push("link");
            if (String(newPath) === raceFinalPath && !fs.existsSync(raceFinalPath)) {
              fs.writeFileSync(raceFinalPath, raceBody);
            }
            return fs.linkSync(existingPath, newPath);
          },
          removeTemp(targetPath) {
            trace.push("removeTemp");
            fs.unlinkSync(targetPath);
          },
          fsyncSync(fd) {
            const dirPath = dirFdMap.get(fd);
            if (dirPath === resolvedArtifactsDir) {
              artifactsDirFsyncs += 1;
              trace.push("fsyncArtifactsDir");
            } else {
              trace.push("fsyncOther");
            }
            fs.fsyncSync(fd);
          },
          closeSync(fd) {
            if (dirFdMap.delete(fd)) {
              trace.push("closeDir");
            }
            fs.closeSync(fd);
          },
        };

        const raced = await runWrite(lease, () =>
          writeArtifact(observedLease, issueRef, raceBody, { fs: raceFs }),
        );
        assert.equal(raced.created, false);
        assert.equal(raced.sha256, raceSha);
        assert.ok(createdTmpPath !== null, "expected temp file path to be created before EEXIST");
        assert.equal(
          fs.existsSync(createdTmpPath),
          false,
          `EEXIST race must remove call's temporary file: ${createdTmpPath}`,
        );
        assert.equal(
          artifactsDirFsyncs,
          1,
          `EEXIST race must sync artifacts folder once; trace=${trace.join(" -> ")}`,
        );
        assert.ok(trace.includes("removeTemp"), `expected removeTemp in trace=${trace.join(" -> ")}`);
        assert.ok(
          trace.indexOf("removeTemp") < trace.indexOf("fsyncArtifactsDir"),
          `EEXIST artifacts dir sync must run after removeTemp; trace=${trace.join(" -> ")}`,
        );
        for (let i = 0; i < trace.length; i += 1) {
          if (trace[i] === "removeTemp") {
            assert.equal(
              trace[i - 1],
              "assertValid",
              `removeTemp must have assertValid right before it; trace=${trace.join(" -> ")}`,
            );
          }
          if (trace[i] === "fsyncArtifactsDir" || trace[i] === "closeDir") {
            assert.notEqual(
              trace[i - 1],
              "assertValid",
              `EEXIST ${trace[i]} must not get its own lease check; trace=${trace.join(" -> ")}`,
            );
          }
        }
        assert.equal(Buffer.compare(fs.readFileSync(raceFinalPath), raceBody), 0);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: readArtifact and writeArtifact refuse symlinked or non-directory tickets and ticket ancestors without writing on either side", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c4-");
    try {
      const validBody = Buffer.from("valid-external-artifact-body\n", "utf8");
      const validSha = sha256Hex(validBody);

      // Case 1: tickets/ itself is a symlink pointing outside stateRoot.
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-linked-tickets");
        const externalRoot = path.join(ctx.scratchRoot, "external-tickets-target");
        const issueRef = "example/repo#604";
        const extArtifacts = path.join(externalRoot, "604", "artifacts");
        fs.mkdirSync(extArtifacts, { recursive: true });
        fs.writeFileSync(path.join(extArtifacts, `${validSha}.md`), validBody);

        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c4-tickets");
        fs.symlinkSync(externalRoot, path.join(stateRoot, "tickets"));

        const stateSnap = snapshotTree(stateRoot);
        const extSnap = snapshotTree(externalRoot);

        await expectErrorCode(
          () => readArtifact({ stateRoot, issueRef, sha256: validSha }),
          "artifact_corrupt",
          "readArtifact through symlinked tickets/",
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, validBody)),
          "artifact_corrupt",
          "writeArtifact existing bytes through symlinked tickets/",
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, "new-bytes-blocked\n")),
          "artifact_corrupt",
          "writeArtifact new bytes through symlinked tickets/",
        );

        assertTreeUnchanged(stateRoot, stateSnap, "symlinked tickets/ must write nothing in stateRoot");
        assertTreeUnchanged(externalRoot, extSnap, "symlinked tickets/ must write nothing outside stateRoot");
        await lease.release();
      }

      // Case 2: tickets/<issue>/ is a symlink pointing outside stateRoot.
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-linked-issue");
        const externalRoot = path.join(ctx.scratchRoot, "external-issue-target");
        const issueRef = "example/repo#605";
        const extArtifacts = path.join(externalRoot, "artifacts");
        fs.mkdirSync(extArtifacts, { recursive: true });
        fs.writeFileSync(path.join(extArtifacts, `${validSha}.md`), validBody);

        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c4-issue");
        const ticketsDir = path.join(stateRoot, "tickets");
        fs.mkdirSync(ticketsDir, { recursive: true });
        fs.symlinkSync(externalRoot, path.join(ticketsDir, "605"));

        const stateSnap = snapshotTree(stateRoot);
        const extSnap = snapshotTree(externalRoot);

        await expectErrorCode(
          () => readArtifact({ stateRoot, issueRef, sha256: validSha }),
          "artifact_corrupt",
          "readArtifact through symlinked tickets/<issue>/",
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, validBody)),
          "artifact_corrupt",
          "writeArtifact existing bytes through symlinked tickets/<issue>/",
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, "new-bytes-blocked-2\n")),
          "artifact_corrupt",
          "writeArtifact new bytes through symlinked tickets/<issue>/",
        );

        assertTreeUnchanged(stateRoot, stateSnap, "symlinked tickets/<issue>/ must write nothing in stateRoot");
        assertTreeUnchanged(externalRoot, extSnap, "symlinked tickets/<issue>/ must write nothing outside stateRoot");
        await lease.release();
      }

      // Case 3: tickets/<issue> is a regular file (non-directory ancestor).
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-file-issue");
        const issueRef = "example/repo#606";
        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c4-file");
        const ticketsDir = path.join(stateRoot, "tickets");
        fs.mkdirSync(ticketsDir, { recursive: true });
        fs.writeFileSync(path.join(ticketsDir, "606"), "not a directory\n", "utf8");

        const stateSnap = snapshotTree(stateRoot);

        await expectErrorCode(
          () => readArtifact({ stateRoot, issueRef, sha256: validSha }),
          "artifact_corrupt",
          "readArtifact with non-directory tickets/<issue>",
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, issueRef, validBody)),
          "artifact_corrupt",
          "writeArtifact with non-directory tickets/<issue>",
        );
        assertTreeUnchanged(stateRoot, stateSnap, "non-directory ancestor must write nothing");
        await lease.release();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 8: FIFOs at log record and artifact paths never block and are rejected cleanly in deadline-bounded child processes", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c5-");
    try {
      // Case A: FIFO named 000001.json -> quarantined open without blocking.
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-fifo-log");
        const issueRef = "example/repo#607";
        const paths = getTicketPaths(stateRoot, issueRef);
        fs.mkdirSync(paths.logDir, { recursive: true });
        const fifoLogPath = path.join(paths.logDir, "000001.json");
        execFileSync("mkfifo", [fifoLogPath]);

        const before = snapshotTree(stateRoot);
        const outcome = await runFifoWorkerWithDeadline(
          ctx,
          [
            "--op", "open",
            "--state-root", stateRoot,
            "--project-key", DEFAULT_PROJECT_KEY,
            "--issue-ref", issueRef,
          ],
          "fifo log 000001.json open",
        );
        assert.equal(outcome.ok, true);
        const opened = outcome.result as OpenTicketLogResult;
        assert.equal(opened.status, "quarantined");
        assert.equal(opened.reason, "record_unreadable");
        assert.equal(opened.seq, 1);
        assert.equal(opened.path, fifoLogPath);
        assert.equal(opened.verifiedPrefix.length, 0);
        assertTreeUnchanged(stateRoot, before, "FIFO 000001.json open must write nothing");
      }

      // Case B1: FIFO at referenced artifact path -> quarantined open without blocking.
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-fifo-art-open");
        const issueRef = "example/repo#608";
        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c5-seed");
        const body = "fifo-referenced-artifact\n";
        const art = await runWrite(lease, () => writeArtifact(lease, issueRef, body));
        await runWrite(lease, () =>
          appendCommitRecord(
            lease,
            makeIntentInput({
              issueRef,
              evidenceRefs: [{ kind: "brief", sha256: art.sha256, bytes: art.bytes, truncated: false }],
            }),
          ),
        );
        await lease.release();

        fs.unlinkSync(art.path);
        execFileSync("mkfifo", [art.path]);

        const before = snapshotTree(stateRoot);
        const outcome = await runFifoWorkerWithDeadline(
          ctx,
          [
            "--op", "open",
            "--state-root", stateRoot,
            "--project-key", DEFAULT_PROJECT_KEY,
            "--issue-ref", issueRef,
          ],
          "fifo referenced artifact open",
        );
        assert.equal(outcome.ok, true);
        const opened = outcome.result as OpenTicketLogResult;
        assert.equal(opened.status, "quarantined");
        assert.equal(opened.reason, "artifact_unreadable");
        assert.equal(opened.seq, 1);
        assert.equal(opened.path, art.path);
        assert.equal(opened.verifiedPrefix.length, 0);
        assertTreeUnchanged(stateRoot, before, "FIFO artifact open must write nothing");
      }

      // Case B2: FIFO at artifact path -> refused readArtifact, writeArtifact, and appendCommitRecord without blocking.
      {
        const stateRoot = path.join(ctx.scratchRoot, "state-fifo-art-ops");
        const issueRef = "example/repo#609";
        const paths = getTicketPaths(stateRoot, issueRef);
        fs.mkdirSync(paths.artifactsDir, { recursive: true });
        const body = "fifo-artifact-ops-payload\n";
        const bodySha = sha256Hex(body);
        const bodyBytes = Buffer.byteLength(body, "utf8");
        const fifoArtPath = path.join(paths.artifactsDir, `${bodySha}.md`);
        execFileSync("mkfifo", [fifoArtPath]);

        const ticketBefore = snapshotTree(paths.ticketDir);

        const readOut = await runFifoWorkerWithDeadline(
          ctx,
          [
            "--op", "read-artifact",
            "--state-root", stateRoot,
            "--project-key", DEFAULT_PROJECT_KEY,
            "--issue-ref", issueRef,
            "--sha256", bodySha,
          ],
          "fifo readArtifact",
        );
        assert.equal(readOut.ok, false);
        assert.equal(readOut.code, "artifact_corrupt");
        assertTreeUnchanged(paths.ticketDir, ticketBefore, "FIFO readArtifact must write nothing");

        const writeOut = await runFifoWorkerWithDeadline(
          ctx,
          [
            "--op", "write-artifact",
            "--state-root", stateRoot,
            "--project-key", DEFAULT_PROJECT_KEY,
            "--issue-ref", issueRef,
            "--content", body,
          ],
          "fifo writeArtifact",
        );
        assert.equal(writeOut.ok, false);
        assert.equal(writeOut.code, "artifact_corrupt");
        assertTreeUnchanged(paths.ticketDir, ticketBefore, "FIFO writeArtifact must write nothing");

        const appendOut = await runFifoWorkerWithDeadline(
          ctx,
          [
            "--op", "append",
            "--state-root", stateRoot,
            "--project-key", DEFAULT_PROJECT_KEY,
            "--issue-ref", issueRef,
            "--sha256", bodySha,
            "--evidence-bytes", String(bodyBytes),
          ],
          "fifo appendCommitRecord",
        );
        assert.equal(appendOut.ok, false);
        assert.equal(appendOut.code, "artifact_corrupt");
        assertTreeUnchanged(paths.ticketDir, ticketBefore, "FIFO appendCommitRecord must write nothing");
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 8: foreign name in log/ beside a damaged second record quarantines with foreign_log_entry and verifiedPrefix length 1", async () => {
    const ctx = createStoreTestContext("herdr-s1c-c6-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "c6-holder");
      const issueRef = "example/repo#610";
      const paths = getTicketPaths(stateRoot, issueRef);

      const rec1 = await runWrite(lease, () =>
        appendCommitRecord(lease, makeIntentInput({ issueRef, event: "c6_first" })),
      );
      const rec2 = await runWrite(lease, () =>
        appendCommitRecord(lease, makeReceiptInput({ issueRef, event: "c6_second" })),
      );
      assert.equal(rec2.seq, 2);

      const p2 = path.join(paths.logDir, "000002.json");
      const orig2 = fs.readFileSync(p2);
      const damaged2 = { ...rec2.record, prevRecordSha256: "0".repeat(64) };
      fs.writeFileSync(p2, `${JSON.stringify(damaged2, null, 2)}\n`, "utf8");
      const foreignPath = path.join(paths.logDir, "notes.txt");
      fs.writeFileSync(foreignPath, "stray file beside damaged rec2\n", "utf8");

      const before = snapshotTree(stateRoot);
      const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
      assert.equal(opened.status, "quarantined");
      assert.equal(opened.reason, "foreign_log_entry");
      assert.equal(opened.seq, null);
      assert.equal(opened.path, foreignPath);
      assert.equal(opened.verifiedPrefix.length, 1);
      assert.equal(opened.verifiedPrefix[0]?.seq, 1);
      assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);
      assertTreeUnchanged(stateRoot, before, "foreign name beside damaged rec2 open");

      const err = await expectErrorCode(
        () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
        "log_quarantined",
        "refused append with foreign name beside damaged rec2",
      );
      assert.ok(err instanceof StoreError);
      assertTreeUnchanged(stateRoot, before, "foreign name beside damaged rec2 refused append");

      // Removing only the foreign file reveals the damaged second record; repairing both restores clean log.
      fs.unlinkSync(foreignPath);
      const afterForeignRemoved = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
      assert.equal(afterForeignRemoved.status, "quarantined");
      assert.equal(afterForeignRemoved.reason, "broken_hash_chain");
      assert.equal(afterForeignRemoved.seq, 2);
      assert.equal(afterForeignRemoved.verifiedPrefix.length, 1);

      fs.writeFileSync(p2, orig2);
      const repaired = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
      assert.equal(repaired.status, "clean");
      assert.equal(repaired.records.length, 2);

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
