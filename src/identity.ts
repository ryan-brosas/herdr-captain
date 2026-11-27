import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const IDENTITY_DECISION_SCHEMA_VERSION = 1 as const;
export const MAX_PROJECT_RECORD_BYTES = 2048;
export const MAX_DECISION_RECORD_BYTES = 8192;
export const PROJECT_RECORD_FILENAME = "project.json";
export const IDENTITY_DECISIONS_DIR = "identity-decisions";

const PROJECT_KEY_PATTERN = /^[0-9a-f]{16}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const PROJECT_RECORD_REQUIRED_KEYS = new Set([
  "schemaVersion",
  "slug",
  "canonicalCommonDir",
  "commonDirSha256",
  "originUrl",
  "rootCommitShas",
]);

const PROJECT_RECORD_ALLOWED_KEYS = new Set([
  ...PROJECT_RECORD_REQUIRED_KEYS,
  "reboundFrom",
]);

const DECISION_REQUIRED_KEYS = new Set([
  "schemaVersion",
  "decisionId",
  "choice",
  "oldProjectKey",
  "newProjectKey",
  "oldCanonicalCommonDir",
  "newCanonicalCommonDir",
  "rootCommitShas",
  "originUrl",
  "decidedBy",
  "time",
]);

const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SUPER_PREFIX",
] as const;

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export type IdentityErrorCode =
  | "not_git_repo"
  | "invalid_argument"
  | "identity_mismatch"
  | "identity_relocated"
  | "project_record_too_large"
  | "invalid_project_record"
  | "decision_exists"
  | "invalid_decision"
  | "decision_mismatch"
  | "decision_candidate_not_found"
  | "rebind_destination_exists";

export interface RelocationCandidate {
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly slug: string;
  readonly canonicalCommonDir: string;
  readonly commonDirSha256: string;
  readonly originUrl: string | null;
  readonly rootCommitShas: readonly string[];
}

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly candidates?: readonly RelocationCandidate[];
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: IdentityErrorCode,
    message: string,
    options?: {
      readonly candidates?: readonly RelocationCandidate[];
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "IdentityError";
    this.code = code;
    if (options?.candidates !== undefined) {
      this.candidates = options.candidates.map((candidate) => ({
        ...candidate,
        rootCommitShas: [...candidate.rootCommitShas],
      }));
    }
    if (options?.details !== undefined) {
      this.details = { ...options.details };
    }
  }
}

export interface LiveProjectIdentity {
  readonly projectKey: string;
  readonly slug: string;
  readonly canonicalCommonDir: string;
  readonly commonDirSha256: string;
  readonly originUrl: string | null;
  readonly rootCommitShas: readonly string[];
}

export interface ProjectRecord {
  readonly schemaVersion: 1;
  readonly slug: string;
  readonly canonicalCommonDir: string;
  readonly commonDirSha256: string;
  readonly originUrl: string | null;
  readonly rootCommitShas: readonly string[];
  readonly reboundFrom?: readonly string[];
}

export type IdentityDecisionChoice = "rebind" | "new_project";

export interface IdentityDecision {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly choice: IdentityDecisionChoice;
  readonly oldProjectKey: string | null;
  readonly newProjectKey: string;
  readonly oldCanonicalCommonDir: string | null;
  readonly newCanonicalCommonDir: string;
  readonly rootCommitShas: readonly string[];
  readonly originUrl: string | null;
  readonly decidedBy: string;
  readonly time: string;
}

export interface OriginUrlDrift {
  readonly stored: string | null;
  readonly live: string | null;
}

export interface OpenProjectResult {
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly record: ProjectRecord;
  readonly originDrift: OriginUrlDrift | null;
  readonly created: boolean;
  readonly rebound: boolean;
  readonly appliedDecisionId: string | null;
}

export interface RecordIdentityDecisionInput {
  readonly cwd: string;
  readonly stateBase: string;
  readonly choice: IdentityDecisionChoice;
  readonly decidedBy: string;
  readonly oldProjectKey?: string | null;
  readonly decisionId?: string;
  readonly time?: string;
}

export interface RecordIdentityDecisionResult {
  readonly decisionPath: string;
  readonly decision: IdentityDecision;
}

export interface IdentityFsOps {
  readonly realpathSync: typeof fs.realpathSync;
  readonly statSync: typeof fs.statSync;
  readonly lstatSync: typeof fs.lstatSync;
  readonly fstatSync: typeof fs.fstatSync;
  readonly readdirSync: typeof fs.readdirSync;
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly openSync: typeof fs.openSync;
  readonly readFileSync: typeof fs.readFileSync;
  readonly writeFileSync: typeof fs.writeFileSync;
  readonly fsyncSync: typeof fs.fsyncSync;
  readonly closeSync: typeof fs.closeSync;
  readonly renameSync: typeof fs.renameSync;
  readonly linkSync: typeof fs.linkSync;
  readonly unlinkSync: typeof fs.unlinkSync;
  readonly rmSync: typeof fs.rmSync;
}

export interface IdentityOperationOptions {
  readonly fs?: Partial<IdentityFsOps>;
}

const DEFAULT_FS_OPS: IdentityFsOps = {
  realpathSync: fs.realpathSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  fstatSync: fs.fstatSync,
  readdirSync: fs.readdirSync,
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
};

function resolveFsOps(overrides?: Partial<IdentityFsOps>): IdentityFsOps {
  if (overrides === undefined) {
    return DEFAULT_FS_OPS;
  }
  return {
    ...DEFAULT_FS_OPS,
    ...overrides,
  };
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function getErrnoCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

function getExitStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isStrictlySortedUniqueCommitShas(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string" || !COMMIT_SHA_PATTERN.test(item)) {
      return false;
    }
    if (i > 0 && !(value[i - 1] < item)) {
      return false;
    }
  }
  return true;
}

function cloneProjectRecord(record: ProjectRecord): ProjectRecord {
  if (record.reboundFrom === undefined) {
    return {
      schemaVersion: record.schemaVersion,
      slug: record.slug,
      canonicalCommonDir: record.canonicalCommonDir,
      commonDirSha256: record.commonDirSha256,
      originUrl: record.originUrl,
      rootCommitShas: [...record.rootCommitShas],
    };
  }
  return {
    schemaVersion: record.schemaVersion,
    slug: record.slug,
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirSha256: record.commonDirSha256,
    originUrl: record.originUrl,
    rootCommitShas: [...record.rootCommitShas],
    reboundFrom: [...record.reboundFrom],
  };
}

function cloneIdentityDecision(decision: IdentityDecision): IdentityDecision {
  return {
    schemaVersion: decision.schemaVersion,
    decisionId: decision.decisionId,
    choice: decision.choice,
    oldProjectKey: decision.oldProjectKey,
    newProjectKey: decision.newProjectKey,
    oldCanonicalCommonDir: decision.oldCanonicalCommonDir,
    newCanonicalCommonDir: decision.newCanonicalCommonDir,
    rootCommitShas: [...decision.rootCommitShas],
    originUrl: decision.originUrl,
    decidedBy: decision.decidedBy,
    time: decision.time,
  };
}

function appendUniqueKey(existing: readonly string[] | undefined, key: string): string[] {
  const result = existing ? [...existing] : [];
  if (!result.includes(key)) {
    result.push(key);
  }
  return result;
}

function buildCleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  return env;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildCleanGitEnv(),
  });
}

function deriveSlug(canonicalCommonDir: string, projectKey: string): string {
  const base = path.basename(canonicalCommonDir);
  let candidate: string;
  if (base === ".git") {
    candidate = path.basename(path.dirname(canonicalCommonDir));
  } else if (base.endsWith(".git") && base.length > 4) {
    candidate = base.slice(0, -4);
  } else {
    candidate = base;
  }
  return candidate.length > 0 && candidate !== path.sep ? candidate : projectKey;
}

function resolveOriginUrl(realCwd: string): string | null {
  try {
    const raw = runGit(realCwd, ["config", "--get", "remote.origin.url"]).trim();
    return raw.length > 0 ? raw : null;
  } catch (err) {
    if (getExitStatus(err) === 1) {
      return null;
    }
    throw new IdentityError("not_git_repo", `Failed to read remote.origin.url for ${realCwd}`, {
      cause: err,
    });
  }
}

function resolveRootCommitShas(realCwd: string): string[] {
  let hasHead = false;
  try {
    runGit(realCwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    hasHead = true;
  } catch (err) {
    if (getExitStatus(err) !== 1) {
      throw new IdentityError("not_git_repo", `Failed to inspect HEAD for ${realCwd}`, {
        cause: err,
      });
    }
  }

  let rawOutput: string;
  try {
    const args = hasHead
      ? ["rev-list", "--max-parents=0", "--all", "HEAD"]
      : ["rev-list", "--max-parents=0", "--all"];
    rawOutput = runGit(realCwd, args);
  } catch (err) {
    throw new IdentityError("not_git_repo", `Failed to resolve root commits for ${realCwd}`, {
      cause: err,
    });
  }

  const unique = new Set<string>();
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!COMMIT_SHA_PATTERN.test(trimmed)) {
      throw new IdentityError(
        "not_git_repo",
        `Unexpected commit SHA from git rev-list: ${trimmed}`,
      );
    }
    unique.add(trimmed);
  }

  return Array.from(unique).sort();
}

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IdentityError("invalid_argument", `${name} must be a non-empty string`);
  }
  return value;
}

function lstatOrNull(io: IdentityFsOps, targetPath: string): fs.Stats | null {
  try {
    return io.lstatSync(targetPath);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

function pathExistsAsDirectory(io: IdentityFsOps, targetPath: string): boolean {
  try {
    return io.statSync(targetPath).isDirectory();
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

function fsyncDir(io: IdentityFsOps, dirPath: string): void {
  const dirFd = io.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    io.fsyncSync(dirFd);
  } finally {
    io.closeSync(dirFd);
  }
}

function ensureDirectory(io: IdentityFsOps, dirPath: string, errorCode: IdentityErrorCode): void {
  const existing = lstatOrNull(io, dirPath);
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new IdentityError(errorCode, `Expected directory at ${dirPath}`);
    }
    return;
  }

  const firstCreated = io.mkdirSync(dirPath, { recursive: true });
  const parentDir = path.dirname(dirPath);
  if (typeof firstCreated === "string") {
    const firstParent = path.dirname(firstCreated);
    if (firstParent !== parentDir) {
      fsyncDir(io, firstParent);
    }
  }
  fsyncDir(io, parentDir);
  fsyncDir(io, dirPath);
}

function serializeRecordJson(
  value: ProjectRecord | IdentityDecision,
  fileName: string,
  maxBytes: number,
  sizeErrorCode: IdentityErrorCode,
): string {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const byteLength = Buffer.byteLength(payload, "utf8");
  if (byteLength >= maxBytes) {
    throw new IdentityError(
      sizeErrorCode,
      `${fileName} is ${byteLength} UTF-8 bytes; must be fewer than ${maxBytes} bytes`,
      { details: { fileName, byteLength, maxBytes } },
    );
  }
  return payload;
}

function writePayloadAtomic(
  io: IdentityFsOps,
  dirPath: string,
  fileName: string,
  payload: string,
  maxBytes: number,
  sizeErrorCode: IdentityErrorCode,
): void {
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.byteLength >= maxBytes) {
    throw new IdentityError(
      sizeErrorCode,
      `${fileName} is ${bytes.byteLength} UTF-8 bytes; must be fewer than ${maxBytes} bytes`,
      { details: { fileName, byteLength: bytes.byteLength, maxBytes } },
    );
  }

  const targetPath = path.join(dirPath, fileName);
  const tmpName = `.${fileName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dirPath, tmpName);

  let fd: number | undefined;
  try {
    fd = io.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;

    io.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // Ignore close error while cleaning up failed temp file.
      }
    }
    try {
      io.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error while propagating the write failure.
    }
    throw err;
  }

  fsyncDir(io, dirPath);
}

function writePayloadExclusive(
  io: IdentityFsOps,
  dirPath: string,
  fileName: string,
  payload: string,
  maxBytes: number,
  sizeErrorCode: IdentityErrorCode,
): string {
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.byteLength >= maxBytes) {
    throw new IdentityError(
      sizeErrorCode,
      `${fileName} is ${bytes.byteLength} UTF-8 bytes; must be fewer than ${maxBytes} bytes`,
      { details: { fileName, byteLength: bytes.byteLength, maxBytes } },
    );
  }

  ensureDirectory(io, dirPath, "invalid_decision");

  const targetPath = path.join(dirPath, fileName);
  const tmpName = `.${fileName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dirPath, tmpName);

  let fd: number | undefined;
  let linked = false;
  try {
    fd = io.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;

    io.linkSync(tmpPath, targetPath);
    linked = true;
    io.unlinkSync(tmpPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // Ignore close error on cleanup path.
      }
    }
    if (!linked) {
      try {
        io.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup error on failed link path.
      }
    }
    if (getErrnoCode(err) === "EEXIST") {
      throw new IdentityError(
        "decision_exists",
        `Identity decision already exists at ${targetPath}`,
        { details: { decisionPath: targetPath }, cause: err },
      );
    }
    throw err;
  }

  fsyncDir(io, dirPath);
  return targetPath;
}

function readBoundedUtf8File(
  io: IdentityFsOps,
  filePath: string,
  maxBytes: number,
  sizeErrorCode: IdentityErrorCode,
  invalidErrorCode: IdentityErrorCode,
): string {
  let fd: number;
  try {
    const flags =
      typeof fs.constants.O_NOFOLLOW === "number"
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY;
    fd = io.openSync(filePath, flags);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ELOOP") {
      throw new IdentityError(invalidErrorCode, `Refusing symlink at ${filePath}`, { cause: err });
    }
    throw err;
  }

  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) {
      throw new IdentityError(invalidErrorCode, `Expected regular file at ${filePath}`);
    }
    if (stat.size >= maxBytes) {
      throw new IdentityError(
        sizeErrorCode,
        `${path.basename(filePath)} is ${stat.size} bytes; must be fewer than ${maxBytes} bytes`,
        { details: { filePath, byteLength: stat.size, maxBytes } },
      );
    }

    const raw = io.readFileSync(fd);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    if (bytes.byteLength >= maxBytes) {
      throw new IdentityError(
        sizeErrorCode,
        `${path.basename(filePath)} is ${bytes.byteLength} bytes; must be fewer than ${maxBytes} bytes`,
        { details: { filePath, byteLength: bytes.byteLength, maxBytes } },
      );
    }

    try {
      return UTF8_FATAL_DECODER.decode(bytes);
    } catch (err) {
      throw new IdentityError(invalidErrorCode, `Invalid UTF-8 in ${filePath}`, { cause: err });
    }
  } finally {
    io.closeSync(fd);
  }
}

function parseProjectRecord(rawText: string, filePath: string): ProjectRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new IdentityError("invalid_project_record", `Malformed JSON in ${filePath}`, {
      cause: err,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new IdentityError("invalid_project_record", `${filePath} must be a JSON object`);
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!PROJECT_RECORD_ALLOWED_KEYS.has(key)) {
      throw new IdentityError("invalid_project_record", `Unexpected field ${key} in ${filePath}`);
    }
  }
  for (const requiredKey of PROJECT_RECORD_REQUIRED_KEYS) {
    if (!(requiredKey in parsed)) {
      throw new IdentityError(
        "invalid_project_record",
        `Missing required field ${requiredKey} in ${filePath}`,
      );
    }
  }

  const {
    schemaVersion,
    slug,
    canonicalCommonDir,
    commonDirSha256,
    originUrl,
    rootCommitShas,
    reboundFrom,
  } = parsed;

  if (schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new IdentityError(
      "invalid_project_record",
      `Unsupported project.json schemaVersion in ${filePath}: ${String(schemaVersion)}`,
    );
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new IdentityError("invalid_project_record", `Invalid slug in ${filePath}`);
  }
  if (
    typeof canonicalCommonDir !== "string" ||
    canonicalCommonDir.length === 0 ||
    !path.isAbsolute(canonicalCommonDir)
  ) {
    throw new IdentityError(
      "invalid_project_record",
      `Invalid canonicalCommonDir in ${filePath}`,
    );
  }
  if (typeof commonDirSha256 !== "string" || !SHA256_HEX_PATTERN.test(commonDirSha256)) {
    throw new IdentityError("invalid_project_record", `Invalid commonDirSha256 in ${filePath}`);
  }
  if (originUrl !== null && (typeof originUrl !== "string" || originUrl.length === 0)) {
    throw new IdentityError("invalid_project_record", `Invalid originUrl in ${filePath}`);
  }
  if (!isStrictlySortedUniqueCommitShas(rootCommitShas)) {
    throw new IdentityError(
      "invalid_project_record",
      `Invalid or unsorted rootCommitShas in ${filePath}`,
    );
  }

  if ("reboundFrom" in parsed) {
    if (!Array.isArray(reboundFrom) || reboundFrom.length === 0) {
      throw new IdentityError("invalid_project_record", `Invalid reboundFrom in ${filePath}`);
    }
    const currentKey = commonDirSha256.slice(0, 16);
    const seen = new Set<string>();
    const validatedReboundFrom: string[] = [];
    for (const key of reboundFrom) {
      if (
        typeof key !== "string" ||
        !PROJECT_KEY_PATTERN.test(key) ||
        key === currentKey ||
        seen.has(key)
      ) {
        throw new IdentityError("invalid_project_record", `Invalid reboundFrom entry in ${filePath}`);
      }
      seen.add(key);
      validatedReboundFrom.push(key);
    }

    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      slug,
      canonicalCommonDir,
      commonDirSha256,
      originUrl,
      rootCommitShas: [...rootCommitShas],
      reboundFrom: validatedReboundFrom,
    };
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    slug,
    canonicalCommonDir,
    commonDirSha256,
    originUrl,
    rootCommitShas: [...rootCommitShas],
  };
}

function readProjectRecordFile(io: IdentityFsOps, filePath: string): ProjectRecord {
  const rawText = readBoundedUtf8File(
    io,
    filePath,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
    "invalid_project_record",
  );
  return parseProjectRecord(rawText, filePath);
}

function parseIdentityDecision(
  rawText: string,
  filePath: string,
  expectedNewProjectKey: string,
): IdentityDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new IdentityError("invalid_decision", `Malformed JSON in ${filePath}`, { cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new IdentityError("invalid_decision", `${filePath} must be a JSON object`);
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!DECISION_REQUIRED_KEYS.has(key)) {
      throw new IdentityError("invalid_decision", `Unexpected field ${key} in ${filePath}`);
    }
  }
  for (const requiredKey of DECISION_REQUIRED_KEYS) {
    if (!(requiredKey in parsed)) {
      throw new IdentityError("invalid_decision", `Missing required field ${requiredKey} in ${filePath}`);
    }
  }

  const {
    schemaVersion,
    decisionId,
    choice,
    oldProjectKey,
    newProjectKey,
    oldCanonicalCommonDir,
    newCanonicalCommonDir,
    rootCommitShas,
    originUrl,
    decidedBy,
    time,
  } = parsed;

  if (schemaVersion !== IDENTITY_DECISION_SCHEMA_VERSION) {
    throw new IdentityError(
      "invalid_decision",
      `Unsupported decision schemaVersion in ${filePath}: ${String(schemaVersion)}`,
    );
  }
  if (typeof decisionId !== "string" || decisionId.trim().length === 0) {
    throw new IdentityError("invalid_decision", `Invalid decisionId in ${filePath}`);
  }
  if (choice !== "rebind" && choice !== "new_project") {
    throw new IdentityError("invalid_decision", `Invalid choice in ${filePath}: ${String(choice)}`);
  }
  if (
    typeof newProjectKey !== "string" ||
    !PROJECT_KEY_PATTERN.test(newProjectKey) ||
    newProjectKey !== expectedNewProjectKey
  ) {
    throw new IdentityError("invalid_decision", `Invalid newProjectKey in ${filePath}`);
  }
  if (
    typeof newCanonicalCommonDir !== "string" ||
    newCanonicalCommonDir.length === 0 ||
    !path.isAbsolute(newCanonicalCommonDir) ||
    sha256Hex(newCanonicalCommonDir).slice(0, 16) !== newProjectKey
  ) {
    throw new IdentityError("invalid_decision", `Invalid newCanonicalCommonDir in ${filePath}`);
  }

  let validatedOldKey: string | null;
  let validatedOldDir: string | null;

  if (choice === "rebind") {
    if (
      typeof oldProjectKey !== "string" ||
      !PROJECT_KEY_PATTERN.test(oldProjectKey) ||
      oldProjectKey === newProjectKey
    ) {
      throw new IdentityError("invalid_decision", `Invalid oldProjectKey for rebind in ${filePath}`);
    }
    if (
      typeof oldCanonicalCommonDir !== "string" ||
      oldCanonicalCommonDir.length === 0 ||
      !path.isAbsolute(oldCanonicalCommonDir) ||
      sha256Hex(oldCanonicalCommonDir).slice(0, 16) !== oldProjectKey
    ) {
      throw new IdentityError(
        "invalid_decision",
        `Invalid oldCanonicalCommonDir for rebind in ${filePath}`,
      );
    }
    validatedOldKey = oldProjectKey;
    validatedOldDir = oldCanonicalCommonDir;
  } else {
    if (oldProjectKey === null && oldCanonicalCommonDir === null) {
      validatedOldKey = null;
      validatedOldDir = null;
    } else if (
      typeof oldProjectKey === "string" &&
      PROJECT_KEY_PATTERN.test(oldProjectKey) &&
      oldProjectKey !== newProjectKey &&
      typeof oldCanonicalCommonDir === "string" &&
      oldCanonicalCommonDir.length > 0 &&
      path.isAbsolute(oldCanonicalCommonDir) &&
      sha256Hex(oldCanonicalCommonDir).slice(0, 16) === oldProjectKey
    ) {
      validatedOldKey = oldProjectKey;
      validatedOldDir = oldCanonicalCommonDir;
    } else {
      throw new IdentityError(
        "invalid_decision",
        `Invalid oldProjectKey or oldCanonicalCommonDir for new_project in ${filePath}`,
      );
    }
  }

  if (!isStrictlySortedUniqueCommitShas(rootCommitShas)) {
    throw new IdentityError("invalid_decision", `Invalid or unsorted rootCommitShas in ${filePath}`);
  }
  if (originUrl !== null && (typeof originUrl !== "string" || originUrl.length === 0)) {
    throw new IdentityError("invalid_decision", `Invalid originUrl in ${filePath}`);
  }
  if (typeof decidedBy !== "string" || decidedBy.trim().length === 0) {
    throw new IdentityError("invalid_decision", `Invalid decidedBy in ${filePath}`);
  }
  if (typeof time !== "string" || time.trim().length === 0 || Number.isNaN(Date.parse(time))) {
    throw new IdentityError("invalid_decision", `Invalid time in ${filePath}`);
  }

  return {
    schemaVersion: IDENTITY_DECISION_SCHEMA_VERSION,
    decisionId,
    choice,
    oldProjectKey: validatedOldKey,
    newProjectKey,
    oldCanonicalCommonDir: validatedOldDir,
    newCanonicalCommonDir,
    rootCommitShas: [...rootCommitShas],
    originUrl,
    decidedBy,
    time,
  };
}

function readIdentityDecisionFile(
  io: IdentityFsOps,
  filePath: string,
  expectedNewProjectKey: string,
): IdentityDecision {
  const rawText = readBoundedUtf8File(
    io,
    filePath,
    MAX_DECISION_RECORD_BYTES,
    "invalid_decision",
    "invalid_decision",
  );
  return parseIdentityDecision(rawText, filePath, expectedNewProjectKey);
}

function decisionFilePath(stateBase: string, newProjectKey: string): string {
  return path.join(stateBase, IDENTITY_DECISIONS_DIR, `${newProjectKey}.json`);
}

function isMatchingInterruptedRebind(
  stored: ProjectRecord,
  decision: IdentityDecision,
  live: LiveProjectIdentity,
): boolean {
  if (decision.choice !== "rebind" || decision.oldProjectKey === null || decision.oldCanonicalCommonDir === null) {
    return false;
  }
  if (sha256Hex(stored.canonicalCommonDir) !== stored.commonDirSha256) {
    return false;
  }
  if (stored.commonDirSha256.slice(0, 16) !== decision.oldProjectKey) {
    return false;
  }
  if (stored.canonicalCommonDir !== decision.oldCanonicalCommonDir) {
    return false;
  }
  if (decision.newProjectKey !== live.projectKey || decision.newCanonicalCommonDir !== live.canonicalCommonDir) {
    return false;
  }
  if (!sameStringArray(decision.rootCommitShas, stored.rootCommitShas)) {
    return false;
  }
  if (!sameStringArray(decision.rootCommitShas, live.rootCommitShas)) {
    return false;
  }
  if (decision.originUrl !== stored.originUrl || decision.originUrl !== live.originUrl) {
    return false;
  }
  return true;
}

function scanRelocationCandidates(
  io: IdentityFsOps,
  resolvedStateBase: string,
  live: LiveProjectIdentity,
): RelocationCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = io.readdirSync(resolvedStateBase, { withFileTypes: true }) as fs.Dirent[];
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const candidates: RelocationCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const siblingKey = entry.name;
    if (!PROJECT_KEY_PATTERN.test(siblingKey) || siblingKey === live.projectKey) {
      continue;
    }

    const siblingStateRoot = path.join(resolvedStateBase, siblingKey);
    const siblingProjectPath = path.join(siblingStateRoot, PROJECT_RECORD_FILENAME);
    if (lstatOrNull(io, siblingProjectPath) === null) {
      continue;
    }

    const record = readProjectRecordFile(io, siblingProjectPath);
    if (sha256Hex(record.canonicalCommonDir) !== record.commonDirSha256) {
      throw new IdentityError(
        "invalid_project_record",
        `commonDirSha256 does not match canonicalCommonDir in ${siblingProjectPath}`,
      );
    }

    let effectiveCanonicalDir = record.canonicalCommonDir;
    const recordKey = record.commonDirSha256.slice(0, 16);
    if (recordKey !== siblingKey) {
      // Allow a sibling folder whose rebind crashed between rename and project.json rewrite.
      const siblingDecisionPath = decisionFilePath(resolvedStateBase, siblingKey);
      if (lstatOrNull(io, siblingDecisionPath) === null) {
        throw new IdentityError(
          "invalid_project_record",
          `project.json key ${recordKey} does not match directory ${siblingKey}`,
        );
      }
      const siblingDecision = readIdentityDecisionFile(io, siblingDecisionPath, siblingKey);
      if (
        siblingDecision.choice !== "rebind" ||
        siblingDecision.oldProjectKey !== recordKey ||
        siblingDecision.oldCanonicalCommonDir !== record.canonicalCommonDir
      ) {
        throw new IdentityError(
          "invalid_project_record",
          `project.json key ${recordKey} does not match directory ${siblingKey}`,
        );
      }
      effectiveCanonicalDir = siblingDecision.newCanonicalCommonDir;
    }

    if (
      sameStringArray(record.rootCommitShas, live.rootCommitShas) &&
      record.originUrl === live.originUrl &&
      !pathExistsAsDirectory(io, effectiveCanonicalDir)
    ) {
      candidates.push({
        projectKey: siblingKey,
        stateRoot: siblingStateRoot,
        slug: record.slug,
        canonicalCommonDir: record.canonicalCommonDir,
        commonDirSha256: record.commonDirSha256,
        originUrl: record.originUrl,
        rootCommitShas: [...record.rootCommitShas],
      });
    }
  }

  candidates.sort((a, b) => (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0));
  return candidates;
}

export function resolveProjectIdentity(
  cwd: string,
  options?: IdentityOperationOptions,
): LiveProjectIdentity {
  requireNonEmptyString(cwd, "cwd");
  const io = resolveFsOps(options?.fs);

  let realCwd: string;
  try {
    realCwd = io.realpathSync(cwd);
  } catch (err) {
    throw new IdentityError("not_git_repo", `Working directory does not exist: ${cwd}`, {
      cause: err,
    });
  }

  let rawCommonDir: string;
  try {
    rawCommonDir = runGit(realCwd, ["rev-parse", "--git-common-dir"]).trim();
  } catch (err) {
    throw new IdentityError("not_git_repo", `Not a Git repository: ${cwd}`, { cause: err });
  }

  if (rawCommonDir.length === 0) {
    throw new IdentityError("not_git_repo", `Empty Git common directory for ${cwd}`);
  }

  const resolvedCommonDir = path.resolve(realCwd, rawCommonDir);
  let canonicalCommonDir: string;
  try {
    canonicalCommonDir = io.realpathSync(resolvedCommonDir);
  } catch (err) {
    throw new IdentityError(
      "not_git_repo",
      `Failed to resolve canonical Git common dir for ${cwd}`,
      { cause: err },
    );
  }

  const commonDirSha256 = sha256Hex(canonicalCommonDir);
  const projectKey = commonDirSha256.slice(0, 16);
  const slug = deriveSlug(canonicalCommonDir, projectKey);
  const originUrl = resolveOriginUrl(realCwd);
  const rootCommitShas = resolveRootCommitShas(realCwd);

  return {
    projectKey,
    slug,
    canonicalCommonDir,
    commonDirSha256,
    originUrl,
    rootCommitShas,
  };
}

export function recordIdentityDecision(
  input: RecordIdentityDecisionInput,
  options?: IdentityOperationOptions,
): RecordIdentityDecisionResult {
  requireNonEmptyString(input.cwd, "cwd");
  requireNonEmptyString(input.stateBase, "stateBase");
  requireNonEmptyString(input.decidedBy, "decidedBy");

  if (input.choice !== "rebind" && input.choice !== "new_project") {
    throw new IdentityError(
      "invalid_argument",
      `choice must be "rebind" or "new_project", received ${String(input.choice)}`,
    );
  }

  const decisionId =
    input.decisionId !== undefined
      ? requireNonEmptyString(input.decisionId, "decisionId").trim()
      : crypto.randomUUID();
  const time =
    input.time !== undefined
      ? requireNonEmptyString(input.time, "time").trim()
      : new Date().toISOString();
  if (Number.isNaN(Date.parse(time))) {
    throw new IdentityError("invalid_argument", `time must be a valid ISO-8601 timestamp: ${time}`);
  }

  const io = resolveFsOps(options?.fs);
  const resolvedStateBase = path.resolve(input.stateBase);
  const live = resolveProjectIdentity(input.cwd, options);
  const newStateRoot = path.join(resolvedStateBase, live.projectKey);

  if (lstatOrNull(io, newStateRoot) !== null) {
    throw new IdentityError(
      "rebind_destination_exists",
      `Destination project folder already exists: ${newStateRoot}`,
      { details: { projectKey: live.projectKey, stateRoot: newStateRoot } },
    );
  }

  const candidates = scanRelocationCandidates(io, resolvedStateBase, live);

  let oldProjectKey: string | null = null;
  let oldCanonicalCommonDir: string | null = null;

  if (input.choice === "rebind") {
    if (typeof input.oldProjectKey !== "string" || !PROJECT_KEY_PATTERN.test(input.oldProjectKey)) {
      throw new IdentityError(
        "invalid_argument",
        "rebind decision requires a valid 16-hex oldProjectKey",
      );
    }
    const matched = candidates.find((candidate) => candidate.projectKey === input.oldProjectKey);
    if (matched === undefined) {
      throw new IdentityError(
        "decision_candidate_not_found",
        `oldProjectKey ${input.oldProjectKey} is not a relocation candidate for ${live.projectKey}`,
        { candidates, details: { requestedOldProjectKey: input.oldProjectKey } },
      );
    }
    oldProjectKey = matched.projectKey;
    oldCanonicalCommonDir = matched.canonicalCommonDir;
  } else if (input.oldProjectKey !== undefined && input.oldProjectKey !== null) {
    if (typeof input.oldProjectKey !== "string" || !PROJECT_KEY_PATTERN.test(input.oldProjectKey)) {
      throw new IdentityError(
        "invalid_argument",
        "oldProjectKey must be a valid 16-hex key or null",
      );
    }
    const matched = candidates.find((candidate) => candidate.projectKey === input.oldProjectKey);
    if (matched === undefined) {
      throw new IdentityError(
        "decision_candidate_not_found",
        `oldProjectKey ${input.oldProjectKey} is not a relocation candidate for ${live.projectKey}`,
        { candidates, details: { requestedOldProjectKey: input.oldProjectKey } },
      );
    }
    oldProjectKey = matched.projectKey;
    oldCanonicalCommonDir = matched.canonicalCommonDir;
  }

  const decision: IdentityDecision = {
    schemaVersion: IDENTITY_DECISION_SCHEMA_VERSION,
    decisionId,
    choice: input.choice,
    oldProjectKey,
    newProjectKey: live.projectKey,
    oldCanonicalCommonDir,
    newCanonicalCommonDir: live.canonicalCommonDir,
    rootCommitShas: [...live.rootCommitShas],
    originUrl: live.originUrl,
    decidedBy: input.decidedBy.trim(),
    time,
  };

  const decisionsDir = path.join(resolvedStateBase, IDENTITY_DECISIONS_DIR);
  const fileName = `${live.projectKey}.json`;
  const payload = serializeRecordJson(
    decision,
    fileName,
    MAX_DECISION_RECORD_BYTES,
    "invalid_decision",
  );
  const writtenPath = writePayloadExclusive(
    io,
    decisionsDir,
    fileName,
    payload,
    MAX_DECISION_RECORD_BYTES,
    "invalid_decision",
  );

  return {
    decisionPath: writtenPath,
    decision: cloneIdentityDecision(decision),
  };
}

export function openProject(
  cwd: string,
  stateBase: string,
  options?: IdentityOperationOptions,
): OpenProjectResult {
  requireNonEmptyString(cwd, "cwd");
  requireNonEmptyString(stateBase, "stateBase");

  const io = resolveFsOps(options?.fs);
  const resolvedStateBase = path.resolve(stateBase);
  const live = resolveProjectIdentity(cwd, options);
  const newStateRoot = path.join(resolvedStateBase, live.projectKey);
  const newProjectJsonPath = path.join(newStateRoot, PROJECT_RECORD_FILENAME);
  const decisionPath = decisionFilePath(resolvedStateBase, live.projectKey);

  const decision =
    lstatOrNull(io, decisionPath) !== null
      ? readIdentityDecisionFile(io, decisionPath, live.projectKey)
      : null;

  const destStat = lstatOrNull(io, newStateRoot);
  if (destStat !== null) {
    const oldStateRoot =
      decision !== null && decision.choice === "rebind" && decision.oldProjectKey !== null
        ? path.join(resolvedStateBase, decision.oldProjectKey)
        : null;
    const oldStillExists = oldStateRoot !== null && lstatOrNull(io, oldStateRoot) !== null;

    if (!destStat.isDirectory()) {
      if (oldStillExists) {
        throw new IdentityError(
          "rebind_destination_exists",
          `Rebind destination already exists: ${newStateRoot}`,
          { details: { projectKey: live.projectKey, stateRoot: newStateRoot } },
        );
      }
      throw new IdentityError(
        "invalid_project_record",
        `Expected project directory at ${newStateRoot}`,
      );
    }

    if (lstatOrNull(io, newProjectJsonPath) === null) {
      if (oldStillExists) {
        throw new IdentityError(
          "rebind_destination_exists",
          `Rebind destination folder already exists: ${newStateRoot}`,
          { details: { projectKey: live.projectKey, stateRoot: newStateRoot } },
        );
      }
      throw new IdentityError(
        "invalid_project_record",
        `Project folder exists without ${PROJECT_RECORD_FILENAME}: ${newStateRoot}`,
      );
    }

    const stored = readProjectRecordFile(io, newProjectJsonPath);

    if (stored.canonicalCommonDir === live.canonicalCommonDir) {
      if (stored.commonDirSha256 !== live.commonDirSha256) {
        throw new IdentityError(
          "identity_mismatch",
          `Stored commonDirSha256 does not match live identity for ${live.projectKey}`,
          {
            details: {
              projectKey: live.projectKey,
              storedCommonDirSha256: stored.commonDirSha256,
              liveCommonDirSha256: live.commonDirSha256,
            },
          },
        );
      }

      if (decision !== null) {
        if (decision.newCanonicalCommonDir !== live.canonicalCommonDir) {
          throw new IdentityError(
            "decision_mismatch",
            `Decision newCanonicalCommonDir does not match live repository for ${live.projectKey}`,
          );
        }
        if (decision.choice === "rebind") {
          const rebindCompleted =
            decision.oldProjectKey !== null &&
            stored.reboundFrom !== undefined &&
            stored.reboundFrom.includes(decision.oldProjectKey);
          if (!rebindCompleted) {
            throw new IdentityError(
              "rebind_destination_exists",
              `Destination ${live.projectKey} already exists and was not rebound from ${String(decision.oldProjectKey)}`,
              { details: { oldProjectKey: decision.oldProjectKey, newProjectKey: live.projectKey } },
            );
          }
        }
      }

      const originDrift: OriginUrlDrift | null =
        stored.originUrl !== live.originUrl
          ? { stored: stored.originUrl, live: live.originUrl }
          : null;

      return {
        projectKey: live.projectKey,
        stateRoot: newStateRoot,
        record: cloneProjectRecord(stored),
        originDrift,
        created: false,
        rebound: false,
        appliedDecisionId: null,
      };
    }

    if (decision !== null && decision.choice === "rebind") {
      if (oldStillExists) {
        throw new IdentityError(
          "rebind_destination_exists",
          `Rebind destination already exists while source ${decision.oldProjectKey} still exists`,
          { details: { oldProjectKey: decision.oldProjectKey, newProjectKey: live.projectKey } },
        );
      }
      if (isMatchingInterruptedRebind(stored, decision, live) && decision.oldProjectKey !== null) {
        const updatedRecord: ProjectRecord = {
          schemaVersion: PROJECT_SCHEMA_VERSION,
          slug: live.slug,
          canonicalCommonDir: live.canonicalCommonDir,
          commonDirSha256: live.commonDirSha256,
          originUrl: stored.originUrl,
          rootCommitShas: [...stored.rootCommitShas],
          reboundFrom: appendUniqueKey(stored.reboundFrom, decision.oldProjectKey),
        };
        const payload = serializeRecordJson(
          updatedRecord,
          PROJECT_RECORD_FILENAME,
          MAX_PROJECT_RECORD_BYTES,
          "project_record_too_large",
        );
        writePayloadAtomic(
          io,
          newStateRoot,
          PROJECT_RECORD_FILENAME,
          payload,
          MAX_PROJECT_RECORD_BYTES,
          "project_record_too_large",
        );
        return {
          projectKey: live.projectKey,
          stateRoot: newStateRoot,
          record: cloneProjectRecord(updatedRecord),
          originDrift: null,
          created: false,
          rebound: true,
          appliedDecisionId: decision.decisionId,
        };
      }
    }

    throw new IdentityError(
      "identity_mismatch",
      `Stored canonicalCommonDir (${stored.canonicalCommonDir}) does not match live path (${live.canonicalCommonDir})`,
      {
        details: {
          projectKey: live.projectKey,
          storedCanonicalCommonDir: stored.canonicalCommonDir,
          liveCanonicalCommonDir: live.canonicalCommonDir,
        },
      },
    );
  }

  const candidates = scanRelocationCandidates(io, resolvedStateBase, live);

  if (decision === null) {
    if (candidates.length > 0) {
      throw new IdentityError(
        "identity_relocated",
        `Repository at ${live.canonicalCommonDir} matches ${candidates.length} missing project(s); record a rebind or new_project decision before opening`,
        {
          candidates,
          details: {
            newProjectKey: live.projectKey,
            newCanonicalCommonDir: live.canonicalCommonDir,
          },
        },
      );
    }

    const freshRecord: ProjectRecord = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      slug: live.slug,
      canonicalCommonDir: live.canonicalCommonDir,
      commonDirSha256: live.commonDirSha256,
      originUrl: live.originUrl,
      rootCommitShas: [...live.rootCommitShas],
    };
    const payload = serializeRecordJson(
      freshRecord,
      PROJECT_RECORD_FILENAME,
      MAX_PROJECT_RECORD_BYTES,
      "project_record_too_large",
    );
    ensureDirectory(io, newStateRoot, "invalid_project_record");
    writePayloadAtomic(
      io,
      newStateRoot,
      PROJECT_RECORD_FILENAME,
      payload,
      MAX_PROJECT_RECORD_BYTES,
      "project_record_too_large",
    );
    return {
      projectKey: live.projectKey,
      stateRoot: newStateRoot,
      record: cloneProjectRecord(freshRecord),
      originDrift: null,
      created: true,
      rebound: false,
      appliedDecisionId: null,
    };
  }

  if (
    decision.newProjectKey !== live.projectKey ||
    decision.newCanonicalCommonDir !== live.canonicalCommonDir ||
    !sameStringArray(decision.rootCommitShas, live.rootCommitShas) ||
    decision.originUrl !== live.originUrl
  ) {
    throw new IdentityError(
      "decision_mismatch",
      `Identity decision at ${decisionPath} does not match live repository at ${live.canonicalCommonDir}`,
      {
        details: {
          decisionId: decision.decisionId,
          newProjectKey: live.projectKey,
        },
      },
    );
  }

  if (decision.choice === "new_project") {
    if (decision.oldProjectKey !== null) {
      const matched = candidates.find(
        (candidate) =>
          candidate.projectKey === decision.oldProjectKey &&
          candidate.canonicalCommonDir === decision.oldCanonicalCommonDir,
      );
      if (matched === undefined) {
        throw new IdentityError(
          "decision_candidate_not_found",
          `Decision names oldProjectKey ${decision.oldProjectKey}, which is not a relocation candidate`,
          { candidates, details: { decisionId: decision.decisionId } },
        );
      }
    }

    const freshRecord: ProjectRecord = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      slug: live.slug,
      canonicalCommonDir: live.canonicalCommonDir,
      commonDirSha256: live.commonDirSha256,
      originUrl: live.originUrl,
      rootCommitShas: [...live.rootCommitShas],
    };
    const payload = serializeRecordJson(
      freshRecord,
      PROJECT_RECORD_FILENAME,
      MAX_PROJECT_RECORD_BYTES,
      "project_record_too_large",
    );
    ensureDirectory(io, newStateRoot, "invalid_project_record");
    writePayloadAtomic(
      io,
      newStateRoot,
      PROJECT_RECORD_FILENAME,
      payload,
      MAX_PROJECT_RECORD_BYTES,
      "project_record_too_large",
    );
    return {
      projectKey: live.projectKey,
      stateRoot: newStateRoot,
      record: cloneProjectRecord(freshRecord),
      originDrift: null,
      created: true,
      rebound: false,
      appliedDecisionId: decision.decisionId,
    };
  }

  // decision.choice === "rebind"
  const oldProjectKey = decision.oldProjectKey;
  if (oldProjectKey === null || decision.oldCanonicalCommonDir === null) {
    throw new IdentityError("invalid_decision", `Rebind decision is missing oldProjectKey`);
  }

  const matched = candidates.find(
    (candidate) =>
      candidate.projectKey === oldProjectKey &&
      candidate.canonicalCommonDir === decision.oldCanonicalCommonDir,
  );
  if (matched === undefined) {
    throw new IdentityError(
      "decision_candidate_not_found",
      `Rebind decision names ${oldProjectKey}, which is not a relocation candidate for ${live.projectKey}`,
      { candidates, details: { decisionId: decision.decisionId, oldProjectKey } },
    );
  }

  const oldStateRoot = matched.stateRoot;
  const oldRecord = readProjectRecordFile(io, path.join(oldStateRoot, PROJECT_RECORD_FILENAME));
  const updatedRecord: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    slug: live.slug,
    canonicalCommonDir: live.canonicalCommonDir,
    commonDirSha256: live.commonDirSha256,
    originUrl: oldRecord.originUrl,
    rootCommitShas: [...oldRecord.rootCommitShas],
    reboundFrom: appendUniqueKey(oldRecord.reboundFrom, oldProjectKey),
  };

  // Validate size BEFORE renaming so an oversized record never mutates disk.
  const payload = serializeRecordJson(
    updatedRecord,
    PROJECT_RECORD_FILENAME,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
  );

  // Guard explicitly because POSIX rename(2) overwrites an existing empty directory.
  if (lstatOrNull(io, newStateRoot) !== null) {
    throw new IdentityError(
      "rebind_destination_exists",
      `Rebind destination already exists: ${newStateRoot}`,
      { details: { oldProjectKey, newProjectKey: live.projectKey, stateRoot: newStateRoot } },
    );
  }

  // Step 1: Move old project folder to new key in one rename; no file inside is rewritten.
  io.renameSync(oldStateRoot, newStateRoot);
  fsyncDir(io, resolvedStateBase);

  // Step 2: Atomically rewrite project.json with the new path and reboundFrom list.
  writePayloadAtomic(
    io,
    newStateRoot,
    PROJECT_RECORD_FILENAME,
    payload,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
  );

  return {
    projectKey: live.projectKey,
    stateRoot: newStateRoot,
    record: cloneProjectRecord(updatedRecord),
    originDrift: null,
    created: false,
    rebound: true,
    appliedDecisionId: decision.decisionId,
  };
}
