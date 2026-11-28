import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OwnerLease } from "./lease.ts";

export type { OwnerLease };

export const COMMIT_SCHEMA_VERSION = 1 as const;
export const PAYLOAD_VERSION = 1 as const;
export const MAX_COMMIT_RECORD_BYTES = 8192;
export const MAX_COMMIT_SEQ = 999_999;

const ISSUE_REF_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
const RECORD_FILE_RE = /^(\d{6})\.json$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const STORE_OWNED_KEYS = ["schemaVersion", "seq", "prevRecordSha256", "time", "ownerEpoch", "projectKey"] as const;
const COUNTER_KEYS = ["attemptSeq", "totalAttemptsUsed", "fixRoundsUsed"] as const;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export type StoreErrorCode =
  | "invalid_argument" | "record_exists" | "record_too_large" | "seq_overflow"
  | "log_quarantined" | "artifact_missing" | "artifact_corrupt" | "short_write";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: StoreErrorCode,
    message: string,
    options?: { readonly details?: Readonly<Record<string, unknown>>; readonly cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StoreError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = { ...options.details };
    }
  }
}

export interface ParsedIssueRef {
  readonly issueRef: string;
  readonly owner: string;
  readonly repo: string;
  readonly issue: string;
}

export interface TicketPaths {
  readonly ticketDir: string;
  readonly logDir: string;
  readonly artifactsDir: string;
}

export interface EvidenceRef {
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface CountersAfter {
  readonly attemptSeq: number;
  readonly totalAttemptsUsed: number;
  readonly fixRoundsUsed: number;
}

export interface IntentRef {
  readonly seq: number;
  readonly sha256: string;
}

export interface IntentPayload {
  readonly kind: string;
  readonly version: 1;
  readonly data: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

export interface ReceiptPayload {
  readonly kind: string;
  readonly version: 1;
  readonly data: Readonly<Record<string, unknown>>;
  readonly intentRef?: IntentRef;
  readonly [extra: string]: unknown;
}

export interface CommitRecordBase {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly prevRecordSha256: string | null;
  readonly time: string;
  readonly ownerEpoch: number;
  readonly projectKey: string;
  readonly issueRef: string;
  readonly event: string;
  readonly attemptId?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly countersAfter: CountersAfter;
  readonly phaseAfter: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

export type IntentCommitRecord = CommitRecordBase & { readonly intent: IntentPayload; readonly receipt?: never };
export type ReceiptCommitRecord = CommitRecordBase & { readonly receipt: ReceiptPayload; readonly intent?: never };
export type CommitRecord = IntentCommitRecord | ReceiptCommitRecord;

export interface VerifiedCommitEntry {
  readonly seq: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly path: string;
  readonly record: CommitRecord;
}

export type QuarantineReason =
  | "log_unreadable" | "foreign_log_entry" | "missing_first_record" | "sequence_gap"
  | "record_unreadable" | "record_too_large" | "parse_error" | "invalid_record_type"
  | "unknown_schema_version" | "seq_mismatch" | "invalid_genesis_prev_hash" | "broken_hash_chain"
  | "project_key_mismatch" | "issue_ref_mismatch" | "invalid_timestamp" | "invalid_owner_epoch"
  | "invalid_event" | "invalid_attempt_id" | "invalid_payload_presence" | "unknown_payload_version"
  | "invalid_payload" | "invalid_intent_ref" | "missing_counter" | "invalid_counter"
  | "invalid_phase_after" | "invalid_evidence_ref" | "artifact_missing" | "artifact_unreadable"
  | "artifact_length_mismatch" | "artifact_hash_mismatch";

export interface CleanTicketLog {
  readonly status: "clean";
  readonly projectKey: string;
  readonly issueRef: string;
  readonly issue: string;
  readonly ticketDir: string;
  readonly records: readonly VerifiedCommitEntry[];
  readonly lastSeq: number;
  readonly lastRecordSha256: string | null;
}

export interface QuarantinedTicketLog {
  readonly status: "quarantined";
  readonly projectKey: string;
  readonly issueRef: string;
  readonly issue: string;
  readonly ticketDir: string;
  readonly reason: QuarantineReason;
  readonly message: string;
  readonly seq: number | null;
  readonly path: string | null;
  readonly verifiedPrefix: readonly VerifiedCommitEntry[];
}

export type OpenTicketLogResult = CleanTicketLog | QuarantinedTicketLog;

export interface StoreFsOps {
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly openSync: typeof fs.openSync;
  readonly writeSync: typeof fs.writeSync;
  readonly fsyncSync: typeof fs.fsyncSync;
  readonly closeSync: typeof fs.closeSync;
  readonly linkSync: typeof fs.linkSync;
  readonly removeTemp?: (targetPath: fs.PathLike) => void;
  readonly readFileSync: typeof fs.readFileSync;
  readonly readdirSync: typeof fs.readdirSync;
  readonly fstatSync: typeof fs.fstatSync;
  readonly lstatSync: typeof fs.lstatSync;
}

export interface StoreOptions { readonly fs?: Partial<StoreFsOps>; }
export interface OpenTicketLogInput { readonly stateRoot: string; readonly projectKey: string; readonly issueRef: string; }
export interface WriteArtifactResult { readonly sha256: string; readonly bytes: number; readonly path: string; readonly created: boolean; }
export interface ReadArtifactInput { readonly stateRoot: string; readonly issueRef: string; readonly sha256: string; }
export interface ReadArtifactResult { readonly sha256: string; readonly bytes: number; readonly path: string; readonly content: Buffer; }

interface AppendCommitRecordBaseInput {
  readonly issueRef: string;
  readonly event: string;
  readonly attemptId?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly countersAfter: CountersAfter;
  readonly phaseAfter: Readonly<Record<string, unknown>>;
}

export type AppendCommitRecordInput =
  | (AppendCommitRecordBaseInput & { readonly intent: IntentPayload; readonly receipt?: undefined })
  | (AppendCommitRecordBaseInput & { readonly receipt: ReceiptPayload; readonly intent?: undefined });

const DEFAULT_FS_OPS: StoreFsOps = {
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  linkSync: fs.linkSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  fstatSync: fs.fstatSync,
  lstatSync: fs.lstatSync,
};

function resolveFsOps(overrides?: Partial<StoreFsOps>): StoreFsOps {
  if (overrides === undefined) return DEFAULT_FS_OPS;
  return {
    mkdirSync: overrides.mkdirSync ?? fs.mkdirSync,
    openSync: overrides.openSync ?? fs.openSync,
    writeSync: overrides.writeSync ?? fs.writeSync,
    fsyncSync: overrides.fsyncSync ?? fs.fsyncSync,
    closeSync: overrides.closeSync ?? fs.closeSync,
    linkSync: overrides.linkSync ?? fs.linkSync,
    removeTemp: overrides.removeTemp,
    readFileSync: overrides.readFileSync ?? fs.readFileSync,
    readdirSync: overrides.readdirSync ?? fs.readdirSync,
    fstatSync: overrides.fstatSync ?? fs.fstatSync,
    lstatSync: overrides.lstatSync ?? fs.lstatSync,
  };
}

function removeTempFile(io: StoreFsOps, tmpPath: string): void {
  if (io.removeTemp !== undefined) {
    io.removeTemp(tmpPath);
    return;
  }
  fs.unlinkSync(tmpPath);
}

function getErrnoCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNaturalSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0;
}

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 1;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function requireNonEmptyString(v: unknown, field: string): string {
  if (!isNonEmptyString(v)) {
    throw new StoreError("invalid_argument", `${field} must be a non-empty string`);
  }
  return v;
}

function isValidIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_UTC_RE.exec(value);
  if (m === null) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === mo &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === s
  );
}

function sha256Hex(bytes: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isValidIntentRefShape(v: unknown): v is IntentRef {
  return isPlainObject(v) && isPositiveSafeInt(v.seq) && v.seq <= MAX_COMMIT_SEQ &&
    typeof v.sha256 === "string" && SHA256_HEX_RE.test(v.sha256);
}

function isValidEvidenceRefShape(v: unknown): v is EvidenceRef {
  return isPlainObject(v) && isNonEmptyString(v.kind) &&
    typeof v.sha256 === "string" && SHA256_HEX_RE.test(v.sha256) &&
    isNaturalSafeInt(v.bytes) && typeof v.truncated === "boolean";
}

function validateLeaseArg(lease: OwnerLease): OwnerLease {
  if (
    typeof lease !== "object" || lease === null || typeof lease.assertValid !== "function" ||
    !isNonEmptyString(lease.stateRoot) || !isNonEmptyString(lease.projectKey) ||
    !isPositiveSafeInt(lease.epoch)
  ) {
    throw new StoreError("invalid_argument", "lease must be a valid open OwnerLease");
  }
  return lease;
}

export function parseIssueRef(issueRef: string): ParsedIssueRef {
  if (typeof issueRef !== "string") {
    throw new StoreError("invalid_argument", "issueRef must be a string");
  }
  const match = ISSUE_REF_RE.exec(issueRef);
  if (match === null) {
    throw new StoreError("invalid_argument", `issueRef must match <owner>/<repo>#<number> with no leading zero: ${issueRef}`, {
      details: { issueRef },
    });
  }
  const [, owner, repo, issue] = match as unknown as [string, string, string, string];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new StoreError("invalid_argument", `Invalid owner or repo in issueRef: ${issueRef}`, { details: { issueRef } });
  }
  return { issueRef, owner, repo, issue };
}

export function formatSeq6(seq: number): string {
  if (!isPositiveSafeInt(seq)) {
    throw new StoreError("invalid_argument", `Invalid sequence number: ${String(seq)}`, { details: { seq } });
  }
  if (seq > MAX_COMMIT_SEQ) {
    throw new StoreError("seq_overflow", `Sequence ${seq} exceeds max ${MAX_COMMIT_SEQ}`, {
      details: { seq, maxSeq: MAX_COMMIT_SEQ },
    });
  }
  return String(seq).padStart(6, "0");
}

export function getTicketPaths(stateRoot: string, issueRef: string): TicketPaths {
  const validRoot = requireNonEmptyString(stateRoot, "stateRoot");
  const parsed = parseIssueRef(issueRef);
  const ticketDir = path.join(path.resolve(validRoot), "tickets", parsed.issue);
  return { ticketDir, logDir: path.join(ticketDir, "log"), artifactsDir: path.join(ticketDir, "artifacts") };
}

function fsyncDir(io: StoreFsOps, dirPath: string): void {
  const dirFd = io.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  let fsyncFailed = false;
  try {
    io.fsyncSync(dirFd);
  } catch (err) {
    fsyncFailed = true;
    throw err;
  } finally {
    if (fsyncFailed) {
      try { io.closeSync(dirFd); } catch { /* keep fsync error */ }
    } else {
      io.closeSync(dirFd);
    }
  }
}

function checkDirState(io: StoreFsOps, dirPath: string): "present" | "absent" | "unreadable" {
  try {
    const stat = io.lstatSync(dirPath);
    return stat.isSymbolicLink() || !stat.isDirectory() ? "unreadable" : "present";
  } catch (err) {
    return getErrnoCode(err) === "ENOENT" ? "absent" : "unreadable";
  }
}

function ensureDirChain(io: StoreFsOps, lease: OwnerLease, baseDir: string, segments: readonly string[]): string {
  let current = path.resolve(baseDir);
  for (const segment of segments) {
    const parent = current;
    const next = path.join(parent, segment);
    let exists = false;
    try {
      const stat = io.lstatSync(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: expected directory at ${next}`), { code: "ENOTDIR", path: next });
      }
      exists = true;
    } catch (err) {
      if (getErrnoCode(err) !== "ENOENT") throw err;
    }
    if (!exists) {
      lease.assertValid();
      let created = false;
      try {
        io.mkdirSync(next, 0o700);
        created = true;
      } catch (err) {
        if (getErrnoCode(err) === "EEXIST") {
          const stat = io.lstatSync(next);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw err;
        } else {
          throw err;
        }
      }
      if (created) fsyncDir(io, parent);
    }
    current = next;
  }
  return current;
}

function writeAllSync(io: StoreFsOps, lease: OwnerLease, fd: number, bytes: Buffer, tmpPath: string): void {
  if (bytes.byteLength === 0) {
    lease.assertValid();
    const written = io.writeSync(fd, bytes, 0, 0);
    if (written !== 0) {
      throw new StoreError("short_write", `Unexpected write count ${written} for empty payload`, {
        details: { tmpPath, expected: 0, written },
      });
    }
    return;
  }
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    lease.assertValid();
    const written = io.writeSync(fd, bytes, offset, remaining);
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
      throw new StoreError("short_write", `Short write (${String(written)}/${remaining}) to ${tmpPath}`, {
        details: { tmpPath, offset, remaining, written },
      });
    }
    offset += written;
  }
}

type ReadRegularResult =
  | { readonly status: "ok"; readonly bytes: Buffer }
  | { readonly status: "missing" }
  | { readonly status: "too_large"; readonly byteLength: number }
  | { readonly status: "unreadable"; readonly message: string };

function readRegularFileNoFollow(io: StoreFsOps, filePath: string, maxBytesExclusive?: number): ReadRegularResult {
  const flags = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW : fs.constants.O_RDONLY;
  let fd: number;
  try {
    fd = io.openSync(filePath, flags);
  } catch (err) {
    const code = getErrnoCode(err);
    return code === "ENOENT" ? { status: "missing" } : { status: "unreadable", message: `Unable to open ${filePath} (${code ?? "unknown"})` };
  }
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) return { status: "unreadable", message: `Not a regular file: ${filePath}` };
    if (maxBytesExclusive !== undefined && stat.size >= maxBytesExclusive) {
      return { status: "too_large", byteLength: stat.size };
    }
    const raw = io.readFileSync(fd);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    if (maxBytesExclusive !== undefined && bytes.byteLength >= maxBytesExclusive) {
      return { status: "too_large", byteLength: bytes.byteLength };
    }
    return { status: "ok", bytes };
  } catch (err) {
    return { status: "unreadable", message: `Unable to read ${filePath} (${getErrnoCode(err) ?? "unknown"})` };
  } finally {
    try { io.closeSync(fd); } catch { /* ignore read-only close error */ }
  }
}

type ArtifactCheckResult =
  | { readonly status: "ok"; readonly path: string; readonly bytes: number; readonly content: Buffer }
  | { readonly status: "missing"; readonly path: string }
  | { readonly status: "unreadable"; readonly path: string; readonly message: string }
  | { readonly status: "length_mismatch"; readonly path: string; readonly actualBytes: number; readonly expectedBytes: number }
  | { readonly status: "hash_mismatch"; readonly path: string };

function inspectArtifactFile(
  io: StoreFsOps,
  artifactsDir: string,
  expectedSha256: string,
  expectedBytes?: number,
): ArtifactCheckResult {
  const artifactPath = path.join(artifactsDir, `${expectedSha256}.md`);
  const dirState = checkDirState(io, artifactsDir);
  if (dirState === "absent") return { status: "missing", path: artifactPath };
  if (dirState === "unreadable") {
    return { status: "unreadable", path: artifactPath, message: `Unreadable artifacts directory: ${artifactsDir}` };
  }
  const readRes = readRegularFileNoFollow(io, artifactPath);
  if (readRes.status === "missing") return { status: "missing", path: artifactPath };
  if (readRes.status !== "ok") {
    return { status: "unreadable", path: artifactPath, message: readRes.status === "unreadable" ? readRes.message : artifactPath };
  }
  const content = readRes.bytes;
  if (expectedBytes !== undefined && content.byteLength !== expectedBytes) {
    return { status: "length_mismatch", path: artifactPath, actualBytes: content.byteLength, expectedBytes };
  }
  if (sha256Hex(content) !== expectedSha256) return { status: "hash_mismatch", path: artifactPath };
  return { status: "ok", path: artifactPath, bytes: content.byteLength, content };
}

function throwForArtifactFailure(check: Exclude<ArtifactCheckResult, { status: "ok" }>, sha256: string): never {
  if (check.status === "missing") {
    throw new StoreError("artifact_missing", `Artifact not found: ${check.path}`, { details: { path: check.path, sha256 } });
  }
  throw new StoreError("artifact_corrupt", `Artifact verification failed (${check.status}): ${check.path}`, {
    details: { path: check.path, sha256, status: check.status },
  });
}

function publishExclusiveFile(params: {
  readonly io: StoreFsOps;
  readonly lease: OwnerLease;
  readonly stateRoot: string;
  readonly dirSegments: readonly string[];
  readonly finalName: string;
  readonly bytes: Buffer;
  readonly onLinkEexist: (finalPath: string) => "already_valid";
}): { readonly finalPath: string; readonly created: boolean } {
  const { io, lease, stateRoot, dirSegments, finalName, bytes, onLinkEexist } = params;
  const dirPath = ensureDirChain(io, lease, stateRoot, dirSegments);
  const finalPath = path.join(dirPath, finalName);
  const tmpPath = path.join(dirPath, `.${finalName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);

  let fd: number | undefined;
  let createdTemp = false;
  let tempRemovalHandled = false;
  let linkedExisting = false;
  let hasPrimaryError = false;

  try {
    lease.assertValid();
    fd = io.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    createdTemp = true;

    writeAllSync(io, lease, fd, bytes, tmpPath);
    io.fsyncSync(fd);

    const openFd = fd;
    fd = undefined;
    io.closeSync(openFd);

    lease.assertValid();
    try {
      io.linkSync(tmpPath, finalPath);
    } catch (err) {
      if (getErrnoCode(err) === "EEXIST") {
        onLinkEexist(finalPath);
        linkedExisting = true;
      } else {
        throw err;
      }
    }

    tempRemovalHandled = true;
    lease.assertValid();
    try {
      removeTempFile(io, tmpPath);
    } catch {
      // Leftover dot-temp stays ignored and never blocks publication or hides an earlier error.
    }

    if (!linkedExisting) fsyncDir(io, dirPath);
  } catch (err) {
    hasPrimaryError = true;
    throw err;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { /* ignore close error while unwinding */ }
    }
    if (createdTemp && !tempRemovalHandled) {
      let leaseValidForRemove = false;
      try {
        lease.assertValid();
        leaseValidForRemove = true;
      } catch (err) {
        if (!hasPrimaryError) throw err;
      }
      if (leaseValidForRemove) {
        try { removeTempFile(io, tmpPath); } catch { /* leftover temp never hides primary error */ }
      }
    }
  }

  return { finalPath, created: !linkedExisting };
}

function validateRecordEnvelope(
  parsed: unknown,
  ctx: {
    readonly name: string;
    readonly expectedSeq: number;
    readonly prevSha256: string | null;
    readonly projectKey: string;
    readonly issueRef: string;
  },
): { readonly ok: true; readonly record: CommitRecord } | { readonly ok: false; readonly reason: QuarantineReason; readonly message: string } {
  const fail = (reason: QuarantineReason, message: string) => ({ ok: false as const, reason, message });
  if (!isPlainObject(parsed)) return fail("invalid_record_type", `${ctx.name} must be a JSON object`);
  if (parsed.schemaVersion !== COMMIT_SCHEMA_VERSION) {
    return fail("unknown_schema_version", `Unsupported schemaVersion in ${ctx.name}: ${String(parsed.schemaVersion)}`);
  }
  if (!isPositiveSafeInt(parsed.seq) || parsed.seq !== ctx.expectedSeq) {
    return fail("seq_mismatch", `Record seq ${String(parsed.seq)} does not match ${ctx.name}`);
  }
  if (ctx.expectedSeq === 1) {
    if (parsed.prevRecordSha256 !== null) return fail("invalid_genesis_prev_hash", "First record prevRecordSha256 must be null");
  } else if (parsed.prevRecordSha256 !== ctx.prevSha256) {
    return fail("broken_hash_chain", `${ctx.name} prevRecordSha256 does not match prior record`);
  }
  if (parsed.projectKey !== ctx.projectKey) return fail("project_key_mismatch", `${ctx.name} projectKey mismatch`);
  if (parsed.issueRef !== ctx.issueRef) return fail("issue_ref_mismatch", `${ctx.name} issueRef mismatch`);
  if (!isValidIsoUtcTimestamp(parsed.time)) return fail("invalid_timestamp", `${ctx.name} time is not ISO-8601 UTC`);
  if (!isPositiveSafeInt(parsed.ownerEpoch)) return fail("invalid_owner_epoch", `${ctx.name} invalid ownerEpoch`);
  if (!isNonEmptyString(parsed.event)) return fail("invalid_event", `${ctx.name} invalid event`);
  if (Object.hasOwn(parsed, "attemptId") && !isNonEmptyString(parsed.attemptId)) {
    return fail("invalid_attempt_id", `${ctx.name} invalid attemptId`);
  }

  const hasIntent = Object.hasOwn(parsed, "intent");
  const hasReceipt = Object.hasOwn(parsed, "receipt");
  if (hasIntent === hasReceipt) return fail("invalid_payload_presence", `${ctx.name} must contain exactly one of intent or receipt`);
  const payload = hasIntent ? parsed.intent : parsed.receipt;
  if (!isPlainObject(payload)) return fail("invalid_payload", `${ctx.name} payload must be a JSON object`);
  if (payload.version !== PAYLOAD_VERSION) {
    return fail("unknown_payload_version", `Unsupported payload version in ${ctx.name}: ${String(payload.version)}`);
  }
  if (!isNonEmptyString(payload.kind) || !isPlainObject(payload.data)) {
    return fail("invalid_payload", `${ctx.name} payload requires non-empty kind and object data`);
  }
  if (hasReceipt && Object.hasOwn(payload, "intentRef") && !isValidIntentRefShape(payload.intentRef)) {
    return fail("invalid_intent_ref", `${ctx.name} receipt intentRef has invalid shape`);
  }

  if (!isPlainObject(parsed.countersAfter)) return fail("invalid_counter", `${ctx.name} countersAfter must be an object`);
  for (const key of COUNTER_KEYS) {
    if (!Object.hasOwn(parsed.countersAfter, key)) return fail("missing_counter", `${ctx.name} missing countersAfter.${key}`);
    if (!isNaturalSafeInt(parsed.countersAfter[key])) return fail("invalid_counter", `${ctx.name} invalid countersAfter.${key}`);
  }
  if (!isPlainObject(parsed.phaseAfter)) return fail("invalid_phase_after", `${ctx.name} phaseAfter must be an object`);
  if (!Array.isArray(parsed.evidenceRefs)) return fail("invalid_evidence_ref", `${ctx.name} evidenceRefs must be an array`);
  for (const ref of parsed.evidenceRefs) {
    if (!isValidEvidenceRefShape(ref)) return fail("invalid_evidence_ref", `${ctx.name} contains invalid evidenceRef`);
  }
  return { ok: true, record: parsed as CommitRecord };
}

export function openTicketLog(input: OpenTicketLogInput, options?: StoreOptions): OpenTicketLogResult {
  if (!isPlainObject(input)) throw new StoreError("invalid_argument", "openTicketLog input must be an object");
  const stateRoot = requireNonEmptyString(input.stateRoot, "stateRoot");
  const projectKey = requireNonEmptyString(input.projectKey, "projectKey");
  const parsedRef = parseIssueRef(input.issueRef);
  const paths = getTicketPaths(stateRoot, parsedRef.issueRef);
  const io = resolveFsOps(options?.fs);

  const cleanEmpty = (): CleanTicketLog => ({
    status: "clean", projectKey, issueRef: parsedRef.issueRef, issue: parsedRef.issue,
    ticketDir: paths.ticketDir, records: [], lastSeq: 0, lastRecordSha256: null,
  });

  const quarantine = (
    reason: QuarantineReason,
    message: string,
    seq: number | null,
    targetPath: string | null,
    verifiedPrefix: readonly VerifiedCommitEntry[],
  ): QuarantinedTicketLog => ({
    status: "quarantined", projectKey, issueRef: parsedRef.issueRef, issue: parsedRef.issue,
    ticketDir: paths.ticketDir, reason, message, seq, path: targetPath, verifiedPrefix: [...verifiedPrefix],
  });

  for (const dirPath of [path.dirname(paths.ticketDir), paths.ticketDir, paths.logDir]) {
    const dirState = checkDirState(io, dirPath);
    if (dirState === "absent") return cleanEmpty();
    if (dirState === "unreadable") return quarantine("log_unreadable", `Expected readable directory at ${dirPath}`, null, dirPath, []);
  }

  let rawNames: string[];
  try {
    rawNames = io.readdirSync(paths.logDir).map((entry) => String(entry));
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") return cleanEmpty();
    return quarantine("log_unreadable", `Failed to list ${paths.logDir}`, null, paths.logDir, []);
  }
  rawNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const recordFiles: Array<{ readonly seq: number; readonly name: string; readonly filePath: string }> = [];
  for (const name of rawNames) {
    if (name.startsWith(".")) continue;
    const match = RECORD_FILE_RE.exec(name);
    const fullPath = path.join(paths.logDir, name);
    if (match === null) return quarantine("foreign_log_entry", `Unexpected entry in log/: ${name}`, null, fullPath, []);
    const seq = Number(match[1]);
    if (seq < 1 || seq > MAX_COMMIT_SEQ) {
      return quarantine("foreign_log_entry", `Out-of-range log entry name: ${name}`, null, fullPath, []);
    }
    recordFiles.push({ seq, name, filePath: fullPath });
  }

  if (recordFiles.length === 0) return cleanEmpty();
  recordFiles.sort((a, b) => a.seq - b.seq);
  if (recordFiles[0]!.seq !== 1) {
    return quarantine("missing_first_record", `Expected 000001.json, found ${recordFiles[0]!.name}`, 1, path.join(paths.logDir, "000001.json"), []);
  }

  const verified: VerifiedCommitEntry[] = [];
  let expectedSeq = 1;
  let prevSha256: string | null = null;

  for (const item of recordFiles) {
    if (item.seq !== expectedSeq) {
      const missingName = `${formatSeq6(expectedSeq)}.json`;
      return quarantine("sequence_gap", `Expected ${missingName}, found ${item.name}`, expectedSeq, path.join(paths.logDir, missingName), verified);
    }

    const readRes = readRegularFileNoFollow(io, item.filePath, MAX_COMMIT_RECORD_BYTES);
    if (readRes.status === "missing" || readRes.status === "unreadable") {
      const msg = readRes.status === "unreadable" ? readRes.message : `Missing record ${item.filePath}`;
      return quarantine("record_unreadable", msg, expectedSeq, item.filePath, verified);
    }
    if (readRes.status === "too_large") {
      return quarantine("record_too_large", `${item.name} is ${readRes.byteLength} bytes; limit is < ${MAX_COMMIT_RECORD_BYTES}`, expectedSeq, item.filePath, verified);
    }

    const rawBytes = readRes.bytes;
    const recordSha256 = sha256Hex(rawBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_FATAL_DECODER.decode(rawBytes));
    } catch {
      return quarantine("parse_error", `Invalid UTF-8 JSON in ${item.filePath}`, expectedSeq, item.filePath, verified);
    }

    const validated = validateRecordEnvelope(parsed, {
      name: item.name, expectedSeq, prevSha256, projectKey, issueRef: parsedRef.issueRef,
    });
    if (!validated.ok) return quarantine(validated.reason, validated.message, expectedSeq, item.filePath, verified);

    for (const ref of validated.record.evidenceRefs) {
      const check = inspectArtifactFile(io, paths.artifactsDir, ref.sha256, ref.bytes);
      if (check.status === "missing") return quarantine("artifact_missing", `Missing artifact ${ref.sha256}.md`, expectedSeq, check.path, verified);
      if (check.status === "unreadable") return quarantine("artifact_unreadable", check.message, expectedSeq, check.path, verified);
      if (check.status === "length_mismatch") {
        return quarantine("artifact_length_mismatch", `Artifact ${ref.sha256}.md length ${check.actualBytes} !== ${check.expectedBytes}`, expectedSeq, check.path, verified);
      }
      if (check.status === "hash_mismatch") return quarantine("artifact_hash_mismatch", `Artifact ${ref.sha256}.md hash mismatch`, expectedSeq, check.path, verified);
    }

    verified.push({ seq: expectedSeq, sha256: recordSha256, bytes: rawBytes.byteLength, path: item.filePath, record: validated.record });
    prevSha256 = recordSha256;
    expectedSeq += 1;
  }

  return {
    status: "clean", projectKey, issueRef: parsedRef.issueRef, issue: parsedRef.issue,
    ticketDir: paths.ticketDir, records: verified, lastSeq: verified.length, lastRecordSha256: prevSha256,
  };
}

export function readArtifact(input: ReadArtifactInput, options?: StoreOptions): ReadArtifactResult {
  if (!isPlainObject(input)) throw new StoreError("invalid_argument", "readArtifact input must be an object");
  const stateRoot = requireNonEmptyString(input.stateRoot, "stateRoot");
  const parsedRef = parseIssueRef(input.issueRef);
  if (typeof input.sha256 !== "string" || !SHA256_HEX_RE.test(input.sha256)) {
    throw new StoreError("invalid_argument", "sha256 must be a 64-character lowercase hex digest");
  }
  const paths = getTicketPaths(stateRoot, parsedRef.issueRef);
  const check = inspectArtifactFile(resolveFsOps(options?.fs), paths.artifactsDir, input.sha256);
  if (check.status !== "ok") throwForArtifactFailure(check, input.sha256);
  return { sha256: input.sha256, bytes: check.bytes, path: check.path, content: check.content };
}

export function writeArtifact(
  lease: OwnerLease,
  issueRef: string,
  content: string | Buffer | Uint8Array,
  options?: StoreOptions,
): WriteArtifactResult {
  validateLeaseArg(lease);
  const parsedRef = parseIssueRef(issueRef);
  let bytes: Buffer;
  if (typeof content === "string") bytes = Buffer.from(content, "utf8");
  else if (Buffer.isBuffer(content)) bytes = Buffer.from(content);
  else if (content instanceof Uint8Array) bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  else throw new StoreError("invalid_argument", "artifact content must be a string, Buffer, or Uint8Array");

  const io = resolveFsOps(options?.fs);
  const paths = getTicketPaths(lease.stateRoot, parsedRef.issueRef);
  const digest = sha256Hex(bytes);

  lease.assertValid();

  const existing = inspectArtifactFile(io, paths.artifactsDir, digest);
  if (existing.status === "ok") return { sha256: digest, bytes: bytes.byteLength, path: existing.path, created: false };
  if (existing.status !== "missing") throwForArtifactFailure(existing, digest);

  const published = publishExclusiveFile({
    io, lease, stateRoot: lease.stateRoot, dirSegments: ["tickets", parsedRef.issue, "artifacts"],
    finalName: `${digest}.md`, bytes,
    onLinkEexist: () => {
      const raced = inspectArtifactFile(io, paths.artifactsDir, digest);
      if (raced.status === "ok") return "already_valid";
      throwForArtifactFailure(raced, digest);
    },
  });
  return { sha256: digest, bytes: bytes.byteLength, path: published.finalPath, created: published.created };
}

function validateAndClonePayload(raw: unknown, label: "intent" | "receipt"): IntentPayload | ReceiptPayload {
  if (!isPlainObject(raw)) throw new StoreError("invalid_argument", `${label} must be a plain object`);
  const kind = requireNonEmptyString(raw.kind, `${label}.kind`);
  if (raw.version !== PAYLOAD_VERSION) throw new StoreError("invalid_argument", `${label}.version must be ${PAYLOAD_VERSION}`);
  if (!isPlainObject(raw.data)) throw new StoreError("invalid_argument", `${label}.data must be a plain object`);
  const cloned: Record<string, unknown> = { ...raw, kind, version: PAYLOAD_VERSION, data: { ...raw.data } };
  if (label === "receipt") {
    if (Object.hasOwn(raw, "intentRef") && raw.intentRef !== undefined) {
      if (!isValidIntentRefShape(raw.intentRef)) throw new StoreError("invalid_argument", "receipt.intentRef has invalid shape");
      cloned.intentRef = { seq: raw.intentRef.seq, sha256: raw.intentRef.sha256 };
    } else {
      delete cloned.intentRef;
    }
  }
  return cloned as IntentPayload | ReceiptPayload;
}

export function appendCommitRecord(
  lease: OwnerLease,
  input: AppendCommitRecordInput,
  options?: StoreOptions,
): VerifiedCommitEntry {
  validateLeaseArg(lease);
  if (!isPlainObject(input)) throw new StoreError("invalid_argument", "appendCommitRecord input must be an object");
  const rawInput = input as unknown as Record<string, unknown>;
  for (const key of STORE_OWNED_KEYS) {
    if (Object.hasOwn(rawInput, key)) {
      throw new StoreError("invalid_argument", `Caller input cannot set store-owned field: ${key}`, { details: { field: key } });
    }
  }

  const parsedRef = parseIssueRef(input.issueRef);
  const event = requireNonEmptyString(input.event, "event");
  const attemptId =
    Object.hasOwn(rawInput, "attemptId") && rawInput.attemptId !== undefined
      ? requireNonEmptyString(rawInput.attemptId, "attemptId")
      : undefined;

  const hasIntent = Object.hasOwn(rawInput, "intent") && rawInput.intent !== undefined;
  const hasReceipt = Object.hasOwn(rawInput, "receipt") && rawInput.receipt !== undefined;
  if (hasIntent === hasReceipt) throw new StoreError("invalid_argument", "Input must provide exactly one of intent or receipt");
  const payload = hasIntent
    ? validateAndClonePayload(rawInput.intent, "intent")
    : validateAndClonePayload(rawInput.receipt, "receipt");

  if (!Array.isArray(rawInput.evidenceRefs)) throw new StoreError("invalid_argument", "evidenceRefs must be an array");
  const evidenceRefs: EvidenceRef[] = rawInput.evidenceRefs.map((ref) => {
    if (!isValidEvidenceRefShape(ref)) throw new StoreError("invalid_argument", "Invalid evidenceRef entry");
    return { kind: ref.kind, sha256: ref.sha256, bytes: ref.bytes, truncated: ref.truncated };
  });

  if (!isPlainObject(rawInput.countersAfter)) throw new StoreError("invalid_argument", "countersAfter must be a plain object");
  for (const key of COUNTER_KEYS) {
    if (!Object.hasOwn(rawInput.countersAfter, key)) throw new StoreError("invalid_argument", `countersAfter is missing ${key}`);
    if (!isNaturalSafeInt(rawInput.countersAfter[key])) throw new StoreError("invalid_argument", `countersAfter.${key} must be a natural safe integer`);
  }
  const countersAfter: CountersAfter = {
    attemptSeq: rawInput.countersAfter.attemptSeq as number,
    totalAttemptsUsed: rawInput.countersAfter.totalAttemptsUsed as number,
    fixRoundsUsed: rawInput.countersAfter.fixRoundsUsed as number,
  };
  if (!isPlainObject(rawInput.phaseAfter)) throw new StoreError("invalid_argument", "phaseAfter must be a plain object");
  const phaseAfter: Readonly<Record<string, unknown>> = { ...rawInput.phaseAfter };

  const io = resolveFsOps(options?.fs);
  const paths = getTicketPaths(lease.stateRoot, parsedRef.issueRef);

  lease.assertValid();

  const opened = openTicketLog(
    { stateRoot: lease.stateRoot, projectKey: lease.projectKey, issueRef: parsedRef.issueRef },
    { fs: io },
  );
  if (opened.status === "quarantined") {
    throw new StoreError("log_quarantined", `Cannot append to quarantined ticket ${parsedRef.issueRef}: ${opened.reason}`, {
      details: { reason: opened.reason, seq: opened.seq, path: opened.path },
    });
  }

  for (const ref of evidenceRefs) {
    const check = inspectArtifactFile(io, paths.artifactsDir, ref.sha256, ref.bytes);
    if (check.status !== "ok") throwForArtifactFailure(check, ref.sha256);
  }

  const nextSeq = opened.lastSeq + 1;
  const finalName = `${formatSeq6(nextSeq)}.json`;
  const recordBase: CommitRecordBase = {
    schemaVersion: COMMIT_SCHEMA_VERSION,
    seq: nextSeq,
    prevRecordSha256: opened.lastRecordSha256,
    time: new Date().toISOString(),
    ownerEpoch: lease.epoch,
    projectKey: lease.projectKey,
    issueRef: parsedRef.issueRef,
    event,
    ...(attemptId !== undefined ? { attemptId } : {}),
    evidenceRefs,
    countersAfter,
    phaseAfter,
  };
  const record: CommitRecord = hasIntent
    ? { ...recordBase, intent: payload as IntentPayload }
    : { ...recordBase, receipt: payload as ReceiptPayload };

  let serialized: string;
  try {
    serialized = `${JSON.stringify(record, null, 2)}\n`;
  } catch (err) {
    throw new StoreError("invalid_argument", "Commit record payload is not JSON-serializable", { cause: err });
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength >= MAX_COMMIT_RECORD_BYTES) {
    throw new StoreError("record_too_large", `${finalName} is ${bytes.byteLength} UTF-8 bytes; limit is < ${MAX_COMMIT_RECORD_BYTES}`, {
      details: { fileName: finalName, byteLength: bytes.byteLength, maxBytes: MAX_COMMIT_RECORD_BYTES },
    });
  }
  const digest = sha256Hex(bytes);

  const published = publishExclusiveFile({
    io, lease, stateRoot: lease.stateRoot, dirSegments: ["tickets", parsedRef.issue, "log"],
    finalName, bytes,
    onLinkEexist: (finalPath) => {
      throw new StoreError("record_exists", `Commit record already exists at ${finalPath}`, {
        details: { seq: nextSeq, path: finalPath },
      });
    },
  });

  return {
    seq: nextSeq,
    sha256: digest,
    bytes: bytes.byteLength,
    path: published.finalPath,
    record: JSON.parse(serialized) as CommitRecord,
  };
}
