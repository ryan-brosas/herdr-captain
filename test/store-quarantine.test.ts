import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import {
  appendCommitRecord,
  getTicketPaths,
  MAX_COMMIT_RECORD_BYTES,
  openTicketLog,
  StoreError,
  writeArtifact,
  type QuarantineReason,
  type VerifiedCommitEntry,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
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
} from "./helpers/store-fixtures.ts";

assertSupportedBunVersion(Bun.version);

interface QuarantineCase {
  readonly name: string;
  readonly expectedReason: QuarantineReason;
  readonly expectedSeq: number | null;
  readonly expectedPrefixLen: number;
  readonly setup: (args: {
    readonly stateRoot: string;
    readonly issueRef: string;
    readonly logDir: string;
    readonly artifactsDir: string;
    readonly rec1: VerifiedCommitEntry;
    readonly rec2: VerifiedCommitEntry;
    readonly artifactPath: string;
    readonly artifactBytes: Buffer;
  }) => {
    readonly damagedFilePath: string | null;
    readonly expectedPath: string;
    readonly repair: () => void;
    readonly expectedCleanCountAfterRepair: number;
  };
}

function writeJsonRecord(filePath: string, obj: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function buildSequencedRecord(
  template: Record<string, unknown>,
  patch: Record<string, unknown>,
  removeKeys: readonly string[] = [],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...template, ...patch };
  for (const key of removeKeys) {
    delete next[key];
  }
  return next;
}

describe("commit-log store quarantine and corruption detection (proof 8)", () => {
  test("proof 8: every envelope, chain, sequence, naming, and size damage quarantines with reason, location, verified prefix, refuses append without writes, preserves damaged bytes, and recovers on manual repair", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p8a-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p8a-holder");

      const cases: QuarantineCase[] = [
        {
          name: "parse error on record 1 (empty verified prefix)",
          expectedReason: "parse_error",
          expectedSeq: 1,
          expectedPrefixLen: 0,
          setup: ({ logDir, rec1 }) => {
            const p1 = path.join(logDir, "000001.json");
            const orig1 = fs.readFileSync(p1);
            fs.writeFileSync(p1, '{"schemaVersion": 1, broken', "utf8");
            return {
              damagedFilePath: p1,
              expectedPath: p1,
              repair: () => fs.writeFileSync(p1, orig1),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "invalid UTF-8 bytes on record 2 (parse_error)",
          expectedReason: "parse_error",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            fs.writeFileSync(p2, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "record that is not a JSON object (array)",
          expectedReason: "invalid_record_type",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            fs.writeFileSync(p2, "[1, 2, 3]\n", "utf8");
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "sequence gap (000001.json followed by 000003.json)",
          expectedReason: "sequence_gap",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir }) => {
            const p2 = path.join(logDir, "000002.json");
            const p3 = path.join(logDir, "000003.json");
            const orig2 = fs.readFileSync(p2);
            fs.unlinkSync(p2);
            fs.writeFileSync(p3, orig2);
            return {
              damagedFilePath: p3,
              expectedPath: path.join(logDir, "000002.json"),
              repair: () => {
                fs.unlinkSync(p3);
                fs.writeFileSync(p2, orig2);
              },
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "missing first record (only 000002.json present)",
          expectedReason: "missing_first_record",
          expectedSeq: 1,
          expectedPrefixLen: 0,
          setup: ({ logDir }) => {
            const p1 = path.join(logDir, "000001.json");
            const p2 = path.join(logDir, "000002.json");
            const orig1 = fs.readFileSync(p1);
            fs.unlinkSync(p1);
            return {
              damagedFilePath: p2,
              expectedPath: p1,
              repair: () => fs.writeFileSync(p1, orig1),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "seq field differs from file name",
          expectedReason: "seq_mismatch",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(p2, buildSequencedRecord(rec2.record, { seq: 7 }));
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "broken prevRecordSha256 on record 2",
          expectedReason: "broken_hash_chain",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, { prevRecordSha256: "f".repeat(64) }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "first record prevRecordSha256 is not null",
          expectedReason: "invalid_genesis_prev_hash",
          expectedSeq: 1,
          expectedPrefixLen: 0,
          setup: ({ logDir, rec1 }) => {
            const p1 = path.join(logDir, "000001.json");
            const orig1 = fs.readFileSync(p1);
            writeJsonRecord(
              p1,
              buildSequencedRecord(rec1.record, { prevRecordSha256: "0".repeat(64) }),
            );
            return {
              damagedFilePath: p1,
              expectedPath: p1,
              repair: () => fs.writeFileSync(p1, orig1),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "unknown schemaVersion",
          expectedReason: "unknown_schema_version",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(p2, buildSequencedRecord(rec2.record, { schemaVersion: 2 }));
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "unknown payload version",
          expectedReason: "unknown_payload_version",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                receipt: { kind: "dispatch_receipt", version: 2, data: {} },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "both intent and receipt present",
          expectedReason: "invalid_payload_presence",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                intent: { kind: "dispatch", version: 1, data: {} },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "neither intent nor receipt present",
          expectedReason: "invalid_payload_presence",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(p2, buildSequencedRecord(rec2.record, {}, ["receipt"]));
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "negative counter",
          expectedReason: "invalid_counter",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                countersAfter: { attemptSeq: -1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "non-integer counter (1.5)",
          expectedReason: "invalid_counter",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1.5, fixRoundsUsed: 0 },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "counter above MAX_SAFE_INTEGER (9007199254740992)",
          expectedReason: "invalid_counter",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            const raw = JSON.stringify(rec2.record, null, 2).replace(
              '"fixRoundsUsed": 0',
              '"fixRoundsUsed": 9007199254740992',
            );
            fs.writeFileSync(p2, `${raw}\n`, "utf8");
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "counter is negative zero (-0)",
          expectedReason: "invalid_counter",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            const raw = JSON.stringify(rec2.record, null, 2).replace(
              '"fixRoundsUsed": 0',
              '"fixRoundsUsed": -0',
            );
            fs.writeFileSync(p2, `${raw}\n`, "utf8");
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "missing counter field in countersAfter",
          expectedReason: "missing_counter",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1 },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "record file of exactly 8192 bytes",
          expectedReason: "record_too_large",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            const baseObj = buildSequencedRecord(rec2.record, {
              receipt: { kind: "dispatch_receipt", version: 1, data: { pad: "" } },
            });
            const baseLen = Buffer.byteLength(`${JSON.stringify(baseObj, null, 2)}\n`, "utf8");
            const oversized = buildSequencedRecord(rec2.record, {
              receipt: {
                kind: "dispatch_receipt",
                version: 1,
                data: { pad: "x".repeat(MAX_COMMIT_RECORD_BYTES - baseLen) },
              },
            });
            const bytes = Buffer.from(`${JSON.stringify(oversized, null, 2)}\n`, "utf8");
            assert.equal(bytes.byteLength, MAX_COMMIT_RECORD_BYTES);
            fs.writeFileSync(p2, bytes);
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "projectKey does not match ticket's projectKey",
          expectedReason: "project_key_mismatch",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, { projectKey: "fedcba9876543210" }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "issueRef does not match ticket's issueRef",
          expectedReason: "issue_ref_mismatch",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, { issueRef: "other/repo#999" }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "intentRef of wrong shape (seq 0 and bad sha256)",
          expectedReason: "invalid_intent_ref",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                receipt: {
                  kind: "dispatch_receipt",
                  version: 1,
                  data: {},
                  intentRef: { seq: 0, sha256: "not-a-hex-digest" },
                },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "intentRef seq past 999999 ceiling",
          expectedReason: "invalid_intent_ref",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, {
                receipt: {
                  kind: "dispatch_receipt",
                  version: 1,
                  data: {},
                  intentRef: { seq: 1_000_000, sha256: "a".repeat(64) },
                },
              }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "time with non-UTC timezone offset (+02:00)",
          expectedReason: "invalid_timestamp",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, { time: "2026-11-28T12:00:00+02:00" }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "time with impossible calendar date (2026-02-29T00:00:00Z)",
          expectedReason: "invalid_timestamp",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(
              p2,
              buildSequencedRecord(rec2.record, { time: "2026-02-29T00:00:00Z" }),
            );
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "invalid ownerEpoch (0)",
          expectedReason: "invalid_owner_epoch",
          expectedSeq: 2,
          expectedPrefixLen: 1,
          setup: ({ logDir, rec2 }) => {
            const p2 = path.join(logDir, "000002.json");
            const orig2 = fs.readFileSync(p2);
            writeJsonRecord(p2, buildSequencedRecord(rec2.record, { ownerEpoch: 0 }));
            return {
              damagedFilePath: p2,
              expectedPath: p2,
              repair: () => fs.writeFileSync(p2, orig2),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "foreign name in log/ (notes.txt)",
          expectedReason: "foreign_log_entry",
          expectedSeq: null,
          expectedPrefixLen: 0,
          setup: ({ logDir }) => {
            const foreign = path.join(logDir, "notes.txt");
            fs.writeFileSync(foreign, "stray file\n", "utf8");
            return {
              damagedFilePath: foreign,
              expectedPath: foreign,
              repair: () => fs.unlinkSync(foreign),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "foreign name in log/ (000000.json)",
          expectedReason: "foreign_log_entry",
          expectedSeq: null,
          expectedPrefixLen: 0,
          setup: ({ logDir }) => {
            const foreign = path.join(logDir, "000000.json");
            fs.writeFileSync(foreign, "{}\n", "utf8");
            return {
              damagedFilePath: foreign,
              expectedPath: foreign,
              repair: () => fs.unlinkSync(foreign),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
        {
          name: "foreign name in log/ (1000000.json)",
          expectedReason: "foreign_log_entry",
          expectedSeq: null,
          expectedPrefixLen: 0,
          setup: ({ logDir }) => {
            const foreign = path.join(logDir, "1000000.json");
            fs.writeFileSync(foreign, "{}\n", "utf8");
            return {
              damagedFilePath: foreign,
              expectedPath: foreign,
              repair: () => fs.unlinkSync(foreign),
              expectedCleanCountAfterRepair: 2,
            };
          },
        },
      ];

      let issueNum = 100;
      for (const tc of cases) {
        issueNum += 1;
        const issueRef = `example/repo#${issueNum}`;
        const paths = getTicketPaths(stateRoot, issueRef);
        const artifactBytes = Buffer.from(`artifact for case ${issueNum}\n`, "utf8");
        const art = await runWrite(lease, () =>
          writeArtifact(lease, issueRef, artifactBytes),
        );
        const rec1 = await runWrite(lease, () =>
          appendCommitRecord(
            lease,
            makeIntentInput({
              issueRef,
              event: "case_intent",
              attemptId: "att-1",
              evidenceRefs: [
                { kind: "brief", sha256: art.sha256, bytes: art.bytes, truncated: false },
              ],
            }),
          ),
        );
        const rec2 = await runWrite(lease, () =>
          appendCommitRecord(
            lease,
            makeReceiptInput({
              issueRef,
              event: "case_receipt",
              attemptId: "att-1",
              receipt: {
                kind: "dispatch_receipt",
                version: 1,
                data: { ok: true },
                intentRef: { seq: rec1.seq, sha256: rec1.sha256 },
              },
            }),
          ),
        );

        const prepared = tc.setup({
          stateRoot,
          issueRef,
          logDir: paths.logDir,
          artifactsDir: paths.artifactsDir,
          rec1,
          rec2,
          artifactPath: art.path,
          artifactBytes,
        });

        const treeBefore = snapshotTree(stateRoot);
        const damagedSnap =
          prepared.damagedFilePath !== null ? snapshotRawFile(prepared.damagedFilePath) : null;

        // Open must return quarantined (never throw, never clean) and create no quarantine file.
        const opened = openTicketLog({
          stateRoot,
          projectKey: DEFAULT_PROJECT_KEY,
          issueRef,
        });
        assert.equal(opened.status, "quarantined", `${tc.name}: expected quarantined`);
        assert.equal(opened.reason, tc.expectedReason, `${tc.name}: wrong reason`);
        assert.equal(opened.seq, tc.expectedSeq, `${tc.name}: wrong seq`);
        assert.equal(opened.path, prepared.expectedPath, `${tc.name}: wrong path`);
        assert.equal(
          opened.verifiedPrefix.length,
          tc.expectedPrefixLen,
          `${tc.name}: wrong verifiedPrefix length`,
        );
        if (tc.expectedPrefixLen === 1) {
          assert.equal(opened.verifiedPrefix[0]?.seq, 1);
          assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);
        }
        assertTreeUnchanged(stateRoot, treeBefore, `${tc.name}: open must write no quarantine file`);

        // Append must be refused with log_quarantined, write nothing, and preserve damaged bytes.
        const err = await expectErrorCode(
          () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
          "log_quarantined",
          `${tc.name}: append to quarantined ticket`,
        );
        assert.ok(err instanceof StoreError);
        assertTreeUnchanged(stateRoot, treeBefore, `${tc.name}: refused append must write nothing`);
        if (prepared.damagedFilePath !== null && damagedSnap !== null) {
          assertRawFileUnchanged(
            prepared.damagedFilePath,
            damagedSnap,
            `${tc.name}: damaged file must keep its exact bytes`,
          );
        }

        // Manual repair restores a clean log on the next open.
        prepared.repair();
        const repaired = openTicketLog({
          stateRoot,
          projectKey: DEFAULT_PROJECT_KEY,
          issueRef,
        });
        assert.equal(repaired.status, "clean", `${tc.name}: expected clean after manual repair`);
        assert.equal(repaired.records.length, prepared.expectedCleanCountAfterRepair);
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 8: missing, unreadable, wrong-hash, and wrong-length artifacts quarantine on open, refuse append, preserve bytes, and recover on repair; unknown v1 fields open clean", async () => {
    const ctx = createStoreTestContext("herdr-s1c-p8b-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "p8b-holder");
      const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;

      // Helper to seed a ticket with record 1 (clean, no artifact) and record 2 (referencing artifact).
      const seedTwoRecordsWithArtifact = async (issueRef: string, content: Buffer) => {
        const paths = getTicketPaths(stateRoot, issueRef);
        const art = await runWrite(lease, () => writeArtifact(lease, issueRef, content));
        const rec1 = await runWrite(lease, () =>
          appendCommitRecord(lease, makeIntentInput({ issueRef, evidenceRefs: [] })),
        );
        const rec2 = await runWrite(lease, () =>
          appendCommitRecord(
            lease,
            makeReceiptInput({
              issueRef,
              evidenceRefs: [
                { kind: "report", sha256: art.sha256, bytes: art.bytes, truncated: false },
              ],
            }),
          ),
        );
        return { paths, art, rec1, rec2 };
      };

      // Case A: missing artifact referenced by record 2.
      {
        const issueRef = "example/repo#201";
        const content = Buffer.from("missing-artifact-body\n", "utf8");
        const { art, rec1 } = await seedTwoRecordsWithArtifact(issueRef, content);
        fs.unlinkSync(art.path);

        const before = snapshotTree(stateRoot);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "quarantined");
        assert.equal(opened.reason, "artifact_missing");
        assert.equal(opened.seq, 2);
        assert.equal(opened.path, art.path);
        assert.equal(opened.verifiedPrefix.length, 1);
        assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);

        await expectErrorCode(
          () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
          "log_quarantined",
          "append on missing artifact quarantine",
        );
        assertTreeUnchanged(stateRoot, before, "missing artifact quarantine");

        fs.writeFileSync(art.path, content);
        const repaired = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(repaired.status, "clean");
        assert.equal(repaired.records.length, 2);
      }

      // Case B: wrong-hash artifact (same byte length, altered content).
      {
        const issueRef = "example/repo#202";
        const content = Buffer.from("0123456789abcdef", "utf8");
        const tampered = Buffer.from("fedcba9876543210", "utf8");
        assert.equal(tampered.byteLength, content.byteLength);
        const { art, rec1 } = await seedTwoRecordsWithArtifact(issueRef, content);
        fs.writeFileSync(art.path, tampered);

        const before = snapshotTree(stateRoot);
        const artSnap = snapshotRawFile(art.path);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "quarantined");
        assert.equal(opened.reason, "artifact_hash_mismatch");
        assert.equal(opened.seq, 2);
        assert.equal(opened.path, art.path);
        assert.equal(opened.verifiedPrefix.length, 1);
        assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);

        await expectErrorCode(
          () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
          "log_quarantined",
          "append on wrong-hash artifact quarantine",
        );
        assertTreeUnchanged(stateRoot, before, "wrong-hash artifact quarantine");
        assertRawFileUnchanged(art.path, artSnap, "tampered artifact keeps exact bytes");

        fs.writeFileSync(art.path, content);
        const repaired = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(repaired.status, "clean");
        assert.equal(repaired.records.length, 2);
      }

      // Case C: wrong-length artifact (artifact hash matches, but evidenceRefs[0].bytes disagrees with actual file length).
      {
        const issueRef = "example/repo#203";
        const content = Buffer.from("exact-length-artifact\n", "utf8");
        const { paths, art, rec1, rec2 } = await seedTwoRecordsWithArtifact(issueRef, content);
        const p2 = path.join(paths.logDir, "000002.json");
        const orig2 = fs.readFileSync(p2);
        writeJsonRecord(
          p2,
          buildSequencedRecord(rec2.record, {
            evidenceRefs: [
              { kind: "report", sha256: art.sha256, bytes: art.bytes + 5, truncated: false },
            ],
          }),
        );

        const before = snapshotTree(stateRoot);
        const rec2Snap = snapshotRawFile(p2);
        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "quarantined");
        assert.equal(opened.reason, "artifact_length_mismatch");
        assert.equal(opened.seq, 2);
        assert.equal(opened.path, art.path);
        assert.equal(opened.verifiedPrefix.length, 1);
        assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);

        await expectErrorCode(
          () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
          "log_quarantined",
          "append on wrong-length artifact quarantine",
        );
        assertTreeUnchanged(stateRoot, before, "wrong-length artifact quarantine");
        assertRawFileUnchanged(p2, rec2Snap, "damaged record keeps exact bytes");

        fs.writeFileSync(p2, orig2);
        const repaired = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(repaired.status, "clean");
        assert.equal(repaired.records.length, 2);
      }

      // Case D: unreadable artifact (chmod 0o000 when non-root, directory when root).
      {
        const issueRef = "example/repo#204";
        const content = Buffer.from("unreadable-artifact-body\n", "utf8");
        const { art, rec1 } = await seedTwoRecordsWithArtifact(issueRef, content);
        if (isRoot) {
          fs.unlinkSync(art.path);
          fs.mkdirSync(art.path);
        } else {
          fs.chmodSync(art.path, 0o000);
        }
        try {
          const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
          assert.equal(opened.status, "quarantined");
          assert.equal(opened.reason, "artifact_unreadable");
          assert.equal(opened.seq, 2);
          assert.equal(opened.path, art.path);
          assert.equal(opened.verifiedPrefix.length, 1);
          assert.equal(opened.verifiedPrefix[0]?.sha256, rec1.sha256);

          await expectErrorCode(
            () => runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef }))),
            "log_quarantined",
            "append on unreadable artifact quarantine",
          );
        } finally {
          if (isRoot) {
            fs.rmdirSync(art.path);
            fs.writeFileSync(art.path, content);
          } else {
            fs.chmodSync(art.path, 0o600);
          }
        }
        const repaired = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(repaired.status, "clean");
        assert.equal(repaired.records.length, 2);
      }

      // Case E: version 1 record with unknown optional fields (top-level and inside payload) opens clean and preserves them.
      {
        const issueRef = "example/repo#205";
        const paths = getTicketPaths(stateRoot, issueRef);
        fs.mkdirSync(paths.logDir, { recursive: true });
        const recWithExtras = {
          schemaVersion: 1,
          seq: 1,
          prevRecordSha256: null,
          time: "2026-11-28T01:02:03.456Z",
          ownerEpoch: 1,
          projectKey: DEFAULT_PROJECT_KEY,
          issueRef,
          event: "future_v1_event",
          intent: {
            kind: "dispatch",
            version: 1,
            data: { role: "implementer" },
            futurePayloadField: { nested: "kept" },
          },
          evidenceRefs: [],
          countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
          phaseAfter: { phase: "building" },
          futureTopLevelFlag: "preserved-by-v1",
          futureTopLevelCount: 42,
        };
        const rawBytes = Buffer.from(`${JSON.stringify(recWithExtras, null, 2)}\n`, "utf8");
        const p1 = path.join(paths.logDir, "000001.json");
        fs.writeFileSync(p1, rawBytes);

        const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
        assert.equal(opened.status, "clean");
        assert.equal(opened.records.length, 1);
        assert.equal(opened.records[0]?.sha256, sha256Hex(rawBytes));
        assert.equal(opened.records[0]?.record.futureTopLevelFlag, "preserved-by-v1");
        assert.equal(opened.records[0]?.record.futureTopLevelCount, 42);
        assert.deepEqual(opened.records[0]?.record.intent?.futurePayloadField, {
          nested: "kept",
        });

        // Next append chains cleanly from this unknown-field v1 record.
        const rec2 = await runWrite(lease, () =>
          appendCommitRecord(lease, makeReceiptInput({ issueRef })),
        );
        assert.equal(rec2.seq, 2);
        assert.equal(rec2.record.prevRecordSha256, sha256Hex(rawBytes));
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
