import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import type { OwnerLease } from "../src/lease.ts";
import {
  appendCommitRecord,
  COMMIT_SCHEMA_VERSION,
  formatSeq6,
  getTicketPaths,
  MAX_COMMIT_RECORD_BYTES,
  MAX_COMMIT_SEQ,
  openTicketLog,
  parseIssueRef,
  PAYLOAD_VERSION,
  readArtifact,
  StoreError,
  writeArtifact,
  type StoreFsOps,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import { confirmProcessDead } from "./helpers/process.ts";
import {
  assertRawFileUnchanged,
  assertTreeUnchanged,
  createStoreTestContext,
  DEFAULT_ISSUE_REF,
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

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("commit-log store core behavior, artifacts, size, read-only open, and leftovers (proofs 2, 6, 7, 9, 10, 11)", () => {
  test("proof 2: store assigns seq, chains prevRecordSha256 from null, sets UTC time, frames payloads, preserves optional attemptId, and blocks caller overrides", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p2a-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p2a-holder");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);

      // Observe lease calls to prove Ruling 16: store never calls enqueue/release/revoke itself.
      let unexpectedLeaseCalls = 0;
      const observedLease: OwnerLease = {
        ...lease,
        enqueue: (...args) => {
          unexpectedLeaseCalls += 1;
          return lease.enqueue(...args);
        },
        release: () => {
          unexpectedLeaseCalls += 1;
          return lease.release();
        },
        revoke: () => {
          unexpectedLeaseCalls += 1;
          return lease.revoke();
        },
      };

      const art = await runWrite(lease, () =>
        writeArtifact(observedLease, DEFAULT_ISSUE_REF, "# Brief artifact\n"),
      );

      // Record 1: intent without attemptId, with evidenceRef (truncated: true and false allowed).
      const beforeT1 = Date.now();
      const rec1 = await runWrite(lease, () =>
        appendCommitRecord(
          observedLease,
          makeIntentInput({
            event: "brief_committed",
            evidenceRefs: [
              { kind: "brief", sha256: art.sha256, bytes: art.bytes, truncated: true },
            ],
            countersAfter: { attemptSeq: 0, totalAttemptsUsed: 0, fixRoundsUsed: 0 },
            phaseAfter: { phase: "ready", attemptState: null, opaqueTag: "v1" },
          }),
        ),
      );
      const afterT1 = Date.now();

      assert.equal(rec1.seq, 1);
      assert.equal(path.basename(rec1.path), "000001.json");
      assert.equal(rec1.record.schemaVersion, COMMIT_SCHEMA_VERSION);
      assert.equal(rec1.record.seq, 1);
      assert.equal(rec1.record.prevRecordSha256, null);
      assert.equal(rec1.record.ownerEpoch, lease.epoch);
      assert.equal(rec1.record.projectKey, lease.projectKey);
      assert.equal(rec1.record.issueRef, DEFAULT_ISSUE_REF);
      assert.equal(ISO_UTC_RE.test(rec1.record.time), true);
      const t1Ms = Date.parse(rec1.record.time);
      assert.equal(t1Ms >= beforeT1 - 1000 && t1Ms <= afterT1 + 1000, true);
      assert.equal("attemptId" in rec1.record, false);
      assert.deepEqual(rec1.record.intent, {
        kind: "dispatch",
        version: PAYLOAD_VERSION,
        data: { role: "implementer", task: "run slice" },
      });

      const file1Bytes = fs.readFileSync(path.join(paths.logDir, "000001.json"));
      assert.equal(rec1.sha256, sha256Hex(file1Bytes));
      assert.equal(rec1.bytes, file1Bytes.byteLength);
      const parsedFile1 = JSON.parse(file1Bytes.toString("utf8")) as Record<string, unknown>;
      assert.equal(Object.hasOwn(parsedFile1, "attemptId"), false);

      // Record 2: receipt with attemptId and an intentRef pointing to a non-existent seq/hash
      // (proves store checks intentRef shape and does not follow it).
      const rec2 = await runWrite(lease, () =>
        appendCommitRecord(
          observedLease,
          makeReceiptInput({
            event: "opaque_custom_receipt",
            attemptId: "att-1",
            receipt: {
              kind: "receipt_kind",
              version: 1,
              data: { note: "arbitrary opaque payload" },
              intentRef: { seq: 99, sha256: "a".repeat(64) },
            },
            countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
            phaseAfter: { phase: "custom_phase", attemptState: "delivered" },
          }),
        ),
      );

      assert.equal(rec2.seq, 2);
      assert.equal(path.basename(rec2.path), "000002.json");
      assert.equal(rec2.record.prevRecordSha256, rec1.sha256);
      assert.equal(rec2.record.attemptId, "att-1");
      assert.deepEqual(rec2.record.receipt?.intentRef, { seq: 99, sha256: "a".repeat(64) });
      assert.equal(unexpectedLeaseCalls, 0, "Store must never call enqueue, release, or revoke");

      // Record 3 verifies chaining past n = 2.
      const rec3 = await runWrite(lease, () =>
        appendCommitRecord(
          lease,
          makeIntentInput({
            event: "follow_up",
            attemptId: "att-2",
          }),
        ),
      );
      assert.equal(rec3.seq, 3);
      assert.equal(path.basename(rec3.path), "000003.json");
      assert.equal(rec3.record.prevRecordSha256, rec2.sha256);

      // Read back full log and verify exact match for records with and without attemptId.
      const opened = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(opened.status, "clean");
      assert.equal(opened.lastSeq, 3);
      assert.equal(opened.lastRecordSha256, rec3.sha256);
      assert.equal(opened.records.length, 3);
      assert.deepEqual(opened.records[0]?.record, rec1.record);
      assert.deepEqual(opened.records[1]?.record, rec2.record);
      assert.deepEqual(opened.records[2]?.record, rec3.record);
      assert.equal("attemptId" in opened.records[0]!.record, false);
      assert.equal(opened.records[1]!.record.attemptId, "att-1");

      // No caller input can set or change any store-owned field.
      const beforeOverrides = snapshotTree(stateRoot);
      const forbiddenOverrides: Array<Record<string, unknown>> = [
        { schemaVersion: 2 },
        { seq: 99 },
        { prevRecordSha256: "b".repeat(64) },
        { time: "1999-01-01T00:00:00.000Z" },
        { ownerEpoch: 999 },
        { projectKey: "fedcba9876543210" },
      ];
      for (const override of forbiddenOverrides) {
        const key = Object.keys(override)[0]!;
        const polluted = { ...makeIntentInput(), ...override };
        const err = await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, polluted as unknown as ReturnType<typeof makeIntentInput>),
            ),
          "invalid_argument",
          `caller attempt to set ${key}`,
        );
        assert.ok(err instanceof StoreError);
      }
      assertTreeUnchanged(stateRoot, beforeOverrides, "forbidden store-field overrides");

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 2: invalid issueRef formats are refused without writes, seq limit 999999 is enforced, non-monotonic ownerEpoch loads cleanly, and fold hashes raw file bytes", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p2b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p2b-holder");
      const beforeInvalid = snapshotTree(stateRoot);

      const invalidRefs = [
        "",
        "owner/repo",
        "repo#8",
        "a/b/c#8",
        "owner/repo#0",
        "owner/repo#08",
        "owner/repo#7a",
        "owner/repo#-1",
        "owner/repo#1.5",
        "../repo#8",
        "owner/..#8",
        "./repo#8",
        "owner/.#8",
        "owner/repo#8 ",
        " owner/repo#8",
        "/repo#8",
        "owner/#8",
      ];
      for (const bad of invalidRefs) {
        await expectErrorCode(() => parseIssueRef(bad), "invalid_argument", `parseIssueRef(${bad})`);
        await expectErrorCode(
          () => openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef: bad }),
          "invalid_argument",
          `openTicketLog(${bad})`,
        );
        await expectErrorCode(
          () => runWrite(lease, () => writeArtifact(lease, bad, "x")),
          "invalid_argument",
          `writeArtifact(${bad})`,
        );
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(lease, makeIntentInput({ issueRef: bad })),
            ),
          "invalid_argument",
          `appendCommitRecord(${bad})`,
        );
      }
      assertTreeUnchanged(stateRoot, beforeInvalid, "invalid issueRef must write nothing");

      // Ruling 10: sequence formatting ceiling 999999.
      assert.equal(formatSeq6(1), "000001");
      assert.equal(formatSeq6(MAX_COMMIT_SEQ), "999999");
      await expectErrorCode(() => formatSeq6(MAX_COMMIT_SEQ + 1), "seq_overflow", "seq > 999999");
      await expectErrorCode(() => formatSeq6(0), "invalid_argument", "seq === 0");

      // Ruling 13 & Ruling 14: fold hashes raw bytes without re-serializing and accepts any positive safe ownerEpoch order.
      const customRef = "org/custom#12";
      const paths = getTicketPaths(stateRoot, customRef);
      fs.mkdirSync(paths.logDir, { recursive: true });
      // Hand-craft compact JSON with unusual key order, extra trailing spaces, and ownerEpoch = 5.
      const raw1 = Buffer.from(
        '{"phaseAfter":{"phase":"ready"},"countersAfter":{"fixRoundsUsed":0,"totalAttemptsUsed":0,"attemptSeq":0},"evidenceRefs":[],"intent":{"data":{"x":1},"version":1,"kind":"custom"},"event":"ev1","issueRef":"org/custom#12","projectKey":"0123456789abcdef","ownerEpoch":5,"time":"2026-11-28T00:00:00Z","prevRecordSha256":null,"seq":1,"schemaVersion":1}   ',
        "utf8",
      );
      const sha1 = sha256Hex(raw1);
      // Record 2 chains to raw1's exact bytes and has a lower ownerEpoch = 2.
      const raw2 = Buffer.from(
        `{"schemaVersion":1,"seq":2,"prevRecordSha256":"${sha1}","time":"2026-11-28T00:01:00Z","ownerEpoch":2,"projectKey":"${DEFAULT_PROJECT_KEY}","issueRef":"${customRef}","event":"ev2","receipt":{"kind":"r","version":1,"data":{}},"evidenceRefs":[],"countersAfter":{"attemptSeq":1,"totalAttemptsUsed":1,"fixRoundsUsed":0},"phaseAfter":{"phase":"gating"}}`,
        "utf8",
      );
      const sha2 = sha256Hex(raw2);
      fs.writeFileSync(path.join(paths.logDir, "000001.json"), raw1);
      fs.writeFileSync(path.join(paths.logDir, "000002.json"), raw2);

      const opened = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: customRef,
      });
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 2);
      assert.equal(opened.records[0]?.sha256, sha1);
      assert.equal(opened.records[1]?.sha256, sha2);
      assert.equal(opened.records[0]?.record.ownerEpoch, 5);
      assert.equal(opened.records[1]?.record.ownerEpoch, 2);

      // Next append must chain to raw2's exact bytes (sha2) without re-serializing record 2.
      const rec3 = await runWrite(lease, () =>
        appendCommitRecord(lease, makeIntentInput({ issueRef: customRef })),
      );
      assert.equal(rec3.seq, 3);
      assert.equal(rec3.record.prevRecordSha256, sha2);

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 6: artifact is written once, same bytes change nothing on disk, conflicting bytes fail with artifact_corrupt leaving file unchanged, and orphan artifacts do not alter open", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p6-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p6-holder");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);

      const payload = Buffer.from("# Verdict\n\nAPPROVE — utf8 ✓\n", "utf8");
      const expectedSha = sha256Hex(payload);

      const first = await runWrite(lease, () =>
        writeArtifact(lease, DEFAULT_ISSUE_REF, payload),
      );
      assert.equal(first.created, true);
      assert.equal(first.sha256, expectedSha);
      assert.equal(first.bytes, payload.byteLength);
      assert.equal(first.path, path.join(paths.artifactsDir, `${expectedSha}.md`));

      const snapBeforeRewrite = snapshotTree(paths.artifactsDir);
      const fileBeforeRewrite = snapshotRawFile(first.path);

      // Writing identical bytes again writes nothing (no temp file creation, no link, tree unchanged).
      let createCalls = 0;
      let linkCalls = 0;
      const spyFs: Partial<StoreFsOps> = {
        openSync(targetPath, flags, mode) {
          if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
            createCalls += 1;
          }
          return fs.openSync(targetPath, flags, mode);
        },
        linkSync(existingPath, newPath) {
          linkCalls += 1;
          return fs.linkSync(existingPath, newPath);
        },
      };
      const second = await runWrite(lease, () =>
        writeArtifact(lease, DEFAULT_ISSUE_REF, payload, { fs: spyFs }),
      );
      assert.equal(second.created, false);
      assert.equal(second.sha256, expectedSha);
      assert.equal(second.bytes, payload.byteLength);
      assert.equal(createCalls, 0, "Idempotent artifact write must create no temporary file");
      assert.equal(linkCalls, 0, "Idempotent artifact write must not call linkSync");
      assertTreeUnchanged(paths.artifactsDir, snapBeforeRewrite, "idempotent artifact rewrite");
      assertRawFileUnchanged(first.path, fileBeforeRewrite, "idempotent artifact file");

      // Read back artifact verified.
      const readBack = readArtifact({
        stateRoot,
        issueRef: DEFAULT_ISSUE_REF,
        sha256: expectedSha,
      });
      assert.equal(Buffer.compare(readBack.content, payload), 0);

      // Orphan artifact (not named by any commit record) does not change openTicketLog.
      const openEmpty = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(openEmpty.status, "clean");
      assert.equal(openEmpty.records.length, 0);

      const rec1 = await runWrite(lease, () =>
        appendCommitRecord(lease, makeIntentInput({ evidenceRefs: [] })),
      );
      const openWithRec = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(openWithRec.status, "clean");
      assert.equal(openWithRec.records.length, 1);
      assert.equal(openWithRec.records[0]?.sha256, rec1.sha256);

      // Corrupt an existing artifact's bytes under its digest name -> writing the original bytes
      // must fail with artifact_corrupt and neither replace nor remove the existing file.
      const badContent = Buffer.from("tampered-different-bytes!\n", "utf8");
      const targetName = path.join(paths.artifactsDir, `${sha256Hex("target-body")}.md`);
      fs.writeFileSync(targetName, badContent);
      const corruptSnap = snapshotRawFile(targetName);

      await expectErrorCode(
        () => runWrite(lease, () => writeArtifact(lease, DEFAULT_ISSUE_REF, "target-body")),
        "artifact_corrupt",
        "writing bytes under existing corrupt artifact name",
      );
      assertRawFileUnchanged(targetName, corruptSnap, "corrupt artifact must remain untouched");

      // Same corruption refusal if EEXIST occurs at linkSync (race where another writer placed corrupt bytes).
      const raceBody = "race-artifact-body\n";
      const racePath = path.join(paths.artifactsDir, `${sha256Hex(raceBody)}.md`);
      const raceCorruptBytes = Buffer.from("raced-corrupt-bytes", "utf8");
      const raceFs: Partial<StoreFsOps> = {
        linkSync(existingPath, newPath) {
          if (String(newPath) === racePath && !fs.existsSync(racePath)) {
            fs.writeFileSync(racePath, raceCorruptBytes);
          }
          return fs.linkSync(existingPath, newPath);
        },
      };
      await expectErrorCode(
        () =>
          runWrite(lease, () => writeArtifact(lease, DEFAULT_ISSUE_REF, raceBody, { fs: raceFs })),
        "artifact_corrupt",
        "artifact link EEXIST with mismatching bytes",
      );
      assert.equal(Buffer.compare(fs.readFileSync(racePath), raceCorruptBytes), 0);

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 7: append naming missing, unreadable, wrong-hash, or wrong-length artifact is refused before publishing in log/", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p7-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p7-holder");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);

      // Write one valid artifact so we can test wrong length, wrong hash, and unreadable.
      const goodBytes = Buffer.from("0123456789abcdef", "utf8");
      const goodArt = await runWrite(lease, () =>
        writeArtifact(lease, DEFAULT_ISSUE_REF, goodBytes),
      );

      // 1. Missing artifact -> refused before log/ is even created.
      const beforeMissing = snapshotTree(stateRoot);
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            appendCommitRecord(
              lease,
              makeIntentInput({
                evidenceRefs: [
                  { kind: "brief", sha256: "e".repeat(64), bytes: 10, truncated: false },
                ],
              }),
            ),
          ),
        "artifact_missing",
        "missing artifact ref on append",
      );
      assert.equal(fs.existsSync(paths.logDir), false, "log/ must not be created on refused append");
      assertTreeUnchanged(stateRoot, beforeMissing, "missing artifact refusal");

      // 2. Wrong length (artifact file exists with right hash, evidenceRef states wrong byte count).
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            appendCommitRecord(
              lease,
              makeIntentInput({
                evidenceRefs: [
                  {
                    kind: "brief",
                    sha256: goodArt.sha256,
                    bytes: goodArt.bytes + 1,
                    truncated: false,
                  },
                ],
              }),
            ),
          ),
        "artifact_corrupt",
        "wrong artifact length on append",
      );
      assert.equal(fs.existsSync(paths.logDir), false);

      // 3. Wrong hash (same byte length, altered file bytes).
      const tamperedArtPath = path.join(paths.artifactsDir, `${"c".repeat(64)}.md`);
      fs.writeFileSync(tamperedArtPath, Buffer.from("fedcba9876543210", "utf8"));
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            appendCommitRecord(
              lease,
              makeIntentInput({
                evidenceRefs: [
                  { kind: "brief", sha256: "c".repeat(64), bytes: 16, truncated: false },
                ],
              }),
            ),
          ),
        "artifact_corrupt",
        "wrong artifact hash on append",
      );
      assert.equal(fs.existsSync(paths.logDir), false);

      // 4. Unreadable artifact (chmod 0o000 for non-root, directory for root).
      const unreadableSha = "d".repeat(64);
      const unreadablePath = path.join(paths.artifactsDir, `${unreadableSha}.md`);
      const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
      if (isRoot) {
        fs.mkdirSync(unreadablePath);
      } else {
        fs.writeFileSync(unreadablePath, goodBytes);
        fs.chmodSync(unreadablePath, 0o000);
      }
      try {
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(
                lease,
                makeIntentInput({
                  evidenceRefs: [
                    {
                      kind: "brief",
                      sha256: unreadableSha,
                      bytes: goodBytes.byteLength,
                      truncated: false,
                    },
                  ],
                }),
              ),
            ),
          "artifact_corrupt",
          "unreadable artifact on append",
        );
        assert.equal(fs.existsSync(paths.logDir), false);
      } finally {
        if (!isRoot) {
          fs.chmodSync(unreadablePath, 0o600);
        }
      }

      // Valid artifact ref succeeds.
      const ok = await runWrite(lease, () =>
        appendCommitRecord(
          lease,
          makeIntentInput({
            evidenceRefs: [
              { kind: "brief", sha256: goodArt.sha256, bytes: goodArt.bytes, truncated: false },
            ],
          }),
        ),
      );
      assert.equal(ok.seq, 1);

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 9: 8191-byte multibyte UTF-8 record publishes and opens clean; 8192-byte record with fewer than 8192 characters is refused with nothing written", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p9-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p9-holder");

      // Measure baseline serialized byte length for a record with an empty filler string.
      // Because time is always 24 chars (YYYY-MM-DDTHH:MM:SS.sssZ), exact length is deterministic.
      const baseInput = makeIntentInput({
        event: "size_check",
        intent: { kind: "size", version: 1, data: { filler: "" } },
      });
      const probeRec = await runWrite(lease, () => appendCommitRecord(lease, baseInput));
      assert.equal(probeRec.seq, 1);

      // For seq 2, prevRecordSha256 changes from null (4 bytes) to `"<64 hex>"` (66 bytes) -> +62 bytes.
      const seq2Template = {
        ...probeRec.record,
        seq: 2,
        prevRecordSha256: probeRec.sha256,
        intent: { kind: "size", version: 1, data: { filler: "" } },
      };
      const baseBytesSeq2 = Buffer.byteLength(`${JSON.stringify(seq2Template, null, 2)}\n`, "utf8");
      const neededFor8191 = MAX_COMMIT_RECORD_BYTES - 1 - baseBytesSeq2;
      assert.equal(neededFor8191 > 100, true);

      // Build filler using 3-byte UTF-8 character "€" (U+20AC, 1 UTF-16 code unit, 3 UTF-8 bytes)
      // plus 0..2 ASCII "a" bytes to hit EXACTLY 8191 UTF-8 bytes.
      const euroCount = Math.floor(neededFor8191 / 3);
      const rem = neededFor8191 % 3;
      const filler8191 = "€".repeat(euroCount) + "a".repeat(rem);
      assert.equal(Buffer.byteLength(filler8191, "utf8"), neededFor8191);
      assert.equal(filler8191.length < neededFor8191, true, "Test must use multibyte UTF-8");

      const rec8191 = await runWrite(lease, () =>
        appendCommitRecord(
          lease,
          makeIntentInput({
            event: "size_check",
            intent: { kind: "size", version: 1, data: { filler: filler8191 } },
          }),
        ),
      );
      assert.equal(rec8191.seq, 2);
      assert.equal(rec8191.bytes, 8191);
      const file8191 = fs.readFileSync(rec8191.path);
      assert.equal(file8191.byteLength, 8191);
      assert.equal(
        file8191.toString("utf8").length < 8191,
        true,
        "Character length must be strictly less than 8191 to prove byte counting",
      );

      // Next append (seq 3 has identical envelope byte length to seq 2): add 1 ASCII byte -> 8192 bytes!
      const filler8192 = `${filler8191}a`;
      const expectedText8192 = `${JSON.stringify(
        { ...rec8191.record, seq: 3, prevRecordSha256: rec8191.sha256, intent: { kind: "size", version: 1, data: { filler: filler8192 } } },
        null,
        2,
      )}\n`;
      assert.equal(Buffer.byteLength(expectedText8192, "utf8"), 8192);
      assert.equal(
        expectedText8192.length < 8192,
        true,
        "8192-byte record must have < 8192 characters so char-counting would wrongly accept it",
      );

      const before8192 = snapshotTree(stateRoot);
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            appendCommitRecord(
              lease,
              makeIntentInput({
                event: "size_check",
                intent: { kind: "size", version: 1, data: { filler: filler8192 } },
              }),
            ),
          ),
        "record_too_large",
        "8192-byte multibyte record must be refused",
      );
      assertTreeUnchanged(stateRoot, before8192, "8192-byte refusal must write nothing");

      const opened = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 2);
      assert.equal(opened.records[1]?.bytes, 8191);

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 10: read-only open without a lease leaves state root unchanged when absent and while another process holds the lease", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p10-");
    try {
      // Sub-case A: state root does not exist at all.
      const absentStateRoot = path.join(ctx.scratchRoot, "absent-state");
      const absentSnap = snapshotTree(absentStateRoot);
      assert.equal(absentSnap.exists, false);
      const openAbsent = openTicketLog({
        stateRoot: absentStateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(openAbsent.status, "clean");
      assert.deepEqual(openAbsent.records, []);
      assert.equal(openAbsent.lastSeq, 0);
      assert.equal(openAbsent.lastRecordSha256, null);
      assertTreeUnchanged(absentStateRoot, absentSnap, "open on absent state root");

      // Sub-case B: state root exists without tickets/ folder.
      const emptyStateRoot = ctx.createDir("empty-state");
      fs.writeFileSync(path.join(emptyStateRoot, "marker.txt"), "keep\n", "utf8");
      const emptySnap = snapshotTree(emptyStateRoot);
      const openNoTicket = openTicketLog({
        stateRoot: emptyStateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(openNoTicket.status, "clean");
      assert.deepEqual(openNoTicket.records, []);
      assertTreeUnchanged(emptyStateRoot, emptySnap, "open on existing state root without ticket");

      // Sub-case C: another process holds the active lease and has committed a record + artifact.
      const liveStateRoot = path.join(ctx.scratchRoot, "live-state");
      const holderWorker = ctx.spawnStoreWorker([
        "--mode",
        "hold-lease",
        "--worker-id",
        "lease-holder",
        "--state-root",
        liveStateRoot,
        "--project-key",
        DEFAULT_PROJECT_KEY,
        "--issue-ref",
        DEFAULT_ISSUE_REF,
        "--seed-record",
        "1",
      ]);
      const holdingEv = await holderWorker.nextEvent();
      assert.equal(holdingEv.event, "holding");

      const beforeOpen = snapshotTree(liveStateRoot);
      const openWhileHeld = openTicketLog({
        stateRoot: liveStateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(openWhileHeld.status, "clean");
      assert.equal(openWhileHeld.records.length, 1);
      assert.equal(openWhileHeld.records[0]?.record.event, "seeded_intent");
      assertTreeUnchanged(liveStateRoot, beforeOpen, "open while another process holds lease");

      holderWorker.sendCommand("release");
      const relEv = await holderWorker.nextEvent();
      assert.equal(relEv.event, "released");
      const exit = await holderWorker.exited;
      assert.equal(exit.code, 0);
      assert.equal(
        confirmProcessDead(Number(holdingEv.holderPid), String(holdingEv.holderStartTime)),
        true,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 11: leftover temporary files in log/ and artifacts/, and colliding temp names on exclusive creation, survive every call without removal", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p11-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p11-holder");
      const paths = getTicketPaths(stateRoot, DEFAULT_ISSUE_REF);
      fs.mkdirSync(paths.logDir, { recursive: true });
      fs.mkdirSync(paths.artifactsDir, { recursive: true });

      // Pre-place leftover dot-temp files in both log/ and artifacts/.
      const leftoverLogTmp = path.join(paths.logDir, ".000001.json.tmp.99999.deadbeefcafe");
      const leftoverArtTmp = path.join(paths.artifactsDir, ".abcd.md.tmp.99999.deadbeefcafe");
      fs.writeFileSync(leftoverLogTmp, "leftover-log-tmp\n", "utf8");
      fs.writeFileSync(leftoverArtTmp, "leftover-art-tmp\n", "utf8");
      const leftoverLogSnap = snapshotRawFile(leftoverLogTmp);
      const leftoverArtSnap = snapshotRawFile(leftoverArtTmp);

      // 1. Colliding temp file in artifacts/ via injected openSync.
      const collidingArtPayload = Buffer.from("colliding-artifact-temp-sentinel\n", "utf8");
      let collidingArtPath: string | null = null;
      let artUnlinkCalls = 0;
      const collidingArtFs: Partial<StoreFsOps> = {
        openSync(targetPath, flags, mode) {
          const p = String(targetPath);
          if (
            collidingArtPath === null &&
            typeof flags === "number" &&
            (flags & fs.constants.O_CREAT) !== 0 &&
            path.basename(p).startsWith(".")
          ) {
            fs.writeFileSync(p, collidingArtPayload);
            collidingArtPath = p;
          }
          return fs.openSync(targetPath, flags, mode);
        },
        removeTemp(targetPath) {
          artUnlinkCalls += 1;
          fs.unlinkSync(targetPath);
        },
      };
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            writeArtifact(lease, DEFAULT_ISSUE_REF, "artifact-body\n", { fs: collidingArtFs }),
          ),
        "EEXIST",
        "colliding artifact temp O_EXCL must fail with EEXIST",
      );
      assert.ok(collidingArtPath !== null);
      assert.equal(artUnlinkCalls, 0, "Failed exclusive creation must remove nothing");
      const collidingArtSnap = snapshotRawFile(collidingArtPath);
      assert.equal(Buffer.compare(collidingArtSnap.bytes, collidingArtPayload), 0);

      // 2. Colliding temp file in log/ via injected openSync.
      const collidingLogPayload = Buffer.from("colliding-log-temp-sentinel\n", "utf8");
      let collidingLogPath: string | null = null;
      let logUnlinkCalls = 0;
      const collidingLogFs: Partial<StoreFsOps> = {
        openSync(targetPath, flags, mode) {
          const p = String(targetPath);
          if (
            collidingLogPath === null &&
            typeof flags === "number" &&
            (flags & fs.constants.O_CREAT) !== 0 &&
            path.basename(p).startsWith(".")
          ) {
            fs.writeFileSync(p, collidingLogPayload);
            collidingLogPath = p;
          }
          return fs.openSync(targetPath, flags, mode);
        },
        removeTemp(targetPath) {
          logUnlinkCalls += 1;
          fs.unlinkSync(targetPath);
        },
      };
      await expectErrorCode(
        () =>
          runWrite(lease, () =>
            appendCommitRecord(lease, makeIntentInput(), { fs: collidingLogFs }),
          ),
        "EEXIST",
        "colliding log temp O_EXCL must fail with EEXIST",
      );
      assert.ok(collidingLogPath !== null);
      assert.equal(logUnlinkCalls, 0, "Failed exclusive creation must remove nothing");
      assert.equal(fs.existsSync(path.join(paths.logDir, "000001.json")), false);
      const collidingLogSnap = snapshotRawFile(collidingLogPath);
      assert.equal(Buffer.compare(collidingLogSnap.bytes, collidingLogPayload), 0);

      // 3. Subsequent artifact write, commit append, and open all succeed and leave every leftover and colliding temp intact.
      const art = await runWrite(lease, () =>
        writeArtifact(lease, DEFAULT_ISSUE_REF, "artifact-body\n"),
      );
      const rec = await runWrite(lease, () =>
        appendCommitRecord(
          lease,
          makeIntentInput({
            evidenceRefs: [{ kind: "brief", sha256: art.sha256, bytes: art.bytes, truncated: false }],
          }),
        ),
      );
      assert.equal(rec.seq, 1);

      const opened = openTicketLog({
        stateRoot,
        projectKey: DEFAULT_PROJECT_KEY,
        issueRef: DEFAULT_ISSUE_REF,
      });
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 1);

      assertRawFileUnchanged(leftoverLogTmp, leftoverLogSnap, "leftover log temp");
      assertRawFileUnchanged(leftoverArtTmp, leftoverArtSnap, "leftover artifact temp");
      assertRawFileUnchanged(collidingArtPath, collidingArtSnap, "colliding artifact temp");
      assertRawFileUnchanged(collidingLogPath, collidingLogSnap, "colliding log temp");

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
