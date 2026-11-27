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
}

export interface RecordIdentityDecisionResult {
  readonly decisionPath: string;
  readonly decision: IdentityDecision;
}

export interface IdentityFsOps {
  readonly openSync: typeof fs.openSync;
  readonly renameSync: typeof fs.renameSync;
}

export interface IdentityOperationOptions {
  readonly fs?: Partial<IdentityFsOps>;
}

const DEFAULT_FS_OPS: IdentityFsOps = {
  openSync: fs.openSync,
  renameSync: fs.renameSync,
};

function resolveFsOps(overrides?: Partial<IdentityFsOps>): IdentityFsOps {
  if (overrides === undefined) {
    return DEFAULT_FS_OPS;
  }
  return {
    openSync: overrides.openSync ?? fs.openSync,
    renameSync: overrides.renameSync ?? fs.renameSync,
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

function buildReboundFrom(
  existing: readonly string[] | undefined,
  oldProjectKey: string,
  currentProjectKey: string,
): string[] {
  const result: string[] = [];
  if (existing !== undefined) {
    for (const key of existing) {
      if (key !== currentProjectKey && !result.includes(key)) {
        result.push(key);
      }
    }
  }
  if (oldProjectKey !== currentProjectKey && !result.includes(oldProjectKey)) {
    result.push(oldProjectKey);
  }
  return result;
}

function computeOriginDrift(
  storedOriginUrl: string | null,
  liveOriginUrl: string | null,
): OriginUrlDrift | null {
  return storedOriginUrl !== liveOriginUrl
    ? { stored: storedOriginUrl, live: liveOriginUrl }
    : null;
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

function lstatOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

function pathExistsAsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

function fsyncDir(dirPath: string): void {
  const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function ensureDirectory(dirPath: string, errorCode: IdentityErrorCode): void {
  const existing = lstatOrNull(dirPath);
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new IdentityError(errorCode, `Expected directory at ${dirPath}`);
    }
    return;
  }

  const firstCreated = fs.mkdirSync(dirPath, { recursive: true });
  const parentDir = path.dirname(dirPath);
  if (typeof firstCreated === "string") {
    const firstParent = path.dirname(firstCreated);
    if (firstParent !== parentDir) {
      fsyncDir(firstParent);
    }
  }
  fsyncDir(parentDir);
  fsyncDir(dirPath);
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
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error while cleaning up failed temp file.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error while propagating the write failure.
    }
    throw err;
  }

  fsyncDir(dirPath);
}

function writePayloadExclusive(
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

  ensureDirectory(dirPath, "invalid_decision");

  const targetPath = path.join(dirPath, fileName);
  const tmpName = `.${fileName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dirPath, tmpName);

  let fd: number | undefined;
  let linked = false;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.linkSync(tmpPath, targetPath);
    linked = true;
    fs.unlinkSync(tmpPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup path.
      }
    }
    if (!linked) {
      try {
        fs.rmSync(tmpPath, { force: true });
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

  fsyncDir(dirPath);
  return targetPath;
}

function readBoundedUtf8File(
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
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ELOOP") {
      throw new IdentityError(invalidErrorCode, `Refusing symlink at ${filePath}`, { cause: err });
    }
    throw err;
  }

  try {
    const stat = fs.fstatSync(fd);
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

    const raw = fs.readFileSync(fd);
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
    fs.closeSync(fd);
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

function readProjectRecordFile(filePath: string): ProjectRecord {
  const rawText = readBoundedUtf8File(
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
  filePath: string,
  expectedNewProjectKey: string,
): IdentityDecision {
  const rawText = readBoundedUtf8File(
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

function assertDecisionMatchesLive(
  decision: IdentityDecision,
  decisionPath: string,
  live: LiveProjectIdentity,
): void {
  if (
    decision.newProjectKey !== live.projectKey ||
    decision.newCanonicalCommonDir !== live.canonicalCommonDir
  ) {
    throw new IdentityError(
      "decision_mismatch",
      `Identity decision at ${decisionPath} names ${decision.newCanonicalCommonDir}, which does not match live repository at ${live.canonicalCommonDir}`,
      {
        details: {
          decisionPath,
          decisionId: decision.decisionId,
          newProjectKey: live.projectKey,
          decisionCanonicalCommonDir: decision.newCanonicalCommonDir,
          liveCanonicalCommonDir: live.canonicalCommonDir,
        },
      },
    );
  }
  if (!sameStringArray(decision.rootCommitShas, live.rootCommitShas)) {
    throw new IdentityError(
      "decision_mismatch",
      `Identity decision at ${decisionPath} has rootCommitShas that do not match live repository at ${live.canonicalCommonDir}`,
      {
        details: {
          decisionPath,
          decisionId: decision.decisionId,
          newProjectKey: live.projectKey,
          decisionRootCommitShas: [...decision.rootCommitShas],
          liveRootCommitShas: [...live.rootCommitShas],
        },
      },
    );
  }
}

function isInterruptedRebindDecisionMatch(
  stored: ProjectRecord,
  decision: IdentityDecision,
): boolean {
  if (
    decision.choice !== "rebind" ||
    decision.oldProjectKey === null ||
    decision.oldCanonicalCommonDir === null
  ) {
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
  if (!sameStringArray(decision.rootCommitShas, stored.rootCommitShas)) {
    return false;
  }
  return true;
}

function isMatchingInterruptedRebind(
  stored: ProjectRecord,
  decision: IdentityDecision,
  live: LiveProjectIdentity,
): boolean {
  if (!isInterruptedRebindDecisionMatch(stored, decision)) {
    return false;
  }
  if (
    decision.newProjectKey !== live.projectKey ||
    decision.newCanonicalCommonDir !== live.canonicalCommonDir
  ) {
    return false;
  }
  if (!sameStringArray(decision.rootCommitShas, live.rootCommitShas)) {
    return false;
  }
  return true;
}

function finishInterruptedRebind(
  io: IdentityFsOps,
  stateRoot: string,
  stored: ProjectRecord,
  decision: IdentityDecision,
): ProjectRecord {
  if (decision.choice !== "rebind" || decision.oldProjectKey === null) {
    throw new IdentityError("invalid_decision", "Interrupted rebind requires a rebind decision");
  }
  const updatedRecord: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    slug: stored.slug,
    canonicalCommonDir: decision.newCanonicalCommonDir,
    commonDirSha256: sha256Hex(decision.newCanonicalCommonDir),
    originUrl: stored.originUrl,
    rootCommitShas: [...stored.rootCommitShas],
    reboundFrom: buildReboundFrom(
      stored.reboundFrom,
      decision.oldProjectKey,
      decision.newProjectKey,
    ),
  };
  const payload = serializeRecordJson(
    updatedRecord,
    PROJECT_RECORD_FILENAME,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
  );
  writePayloadAtomic(
    io,
    stateRoot,
    PROJECT_RECORD_FILENAME,
    payload,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
  );
  return updatedRecord;
}

function findInterruptedRebindDecision(
  resolvedStateBase: string,
  folderKey: string,
  record: ProjectRecord,
): IdentityDecision | null {
  const recordKey = record.commonDirSha256.slice(0, 16);
  const folderDecisionPath = decisionFilePath(resolvedStateBase, folderKey);
  if (lstatOrNull(folderDecisionPath) === null) {
    return null;
  }
  const folderDecision = readIdentityDecisionFile(folderDecisionPath, folderKey);
  if (
    !isInterruptedRebindDecisionMatch(record, folderDecision) ||
    lstatOrNull(path.join(resolvedStateBase, recordKey)) !== null
  ) {
    return null;
  }
  return folderDecision;
}

function readVerifiedFolderRecord(folderStateRoot: string): ProjectRecord {
  const projectPath = path.join(folderStateRoot, PROJECT_RECORD_FILENAME);
  const record = readProjectRecordFile(projectPath);
  if (sha256Hex(record.canonicalCommonDir) !== record.commonDirSha256) {
    throw new IdentityError(
      "invalid_project_record",
      `commonDirSha256 does not match canonicalCommonDir in ${projectPath}`,
    );
  }
  return record;
}

function readAndFinishFolderIfInterrupted(
  io: IdentityFsOps,
  resolvedStateBase: string,
  folderKey: string,
  folderStateRoot: string,
): ProjectRecord {
  const record = readVerifiedFolderRecord(folderStateRoot);
  const recordKey = record.commonDirSha256.slice(0, 16);
  if (recordKey === folderKey) {
    return record;
  }
  const folderDecision = findInterruptedRebindDecision(resolvedStateBase, folderKey, record);
  if (folderDecision === null) {
    throw new IdentityError(
      "invalid_project_record",
      `project.json key ${recordKey} does not match directory ${folderKey}`,
    );
  }
  return finishInterruptedRebind(io, folderStateRoot, record, folderDecision);
}

function resolveDecisionSourceRecord(
  io: IdentityFsOps,
  resolvedStateBase: string,
  oldProjectKey: string,
  oldCanonicalCommonDir: string,
  rootCommitShas: readonly string[],
): { readonly stateRoot: string; readonly record: ProjectRecord } | null {
  const oldStateRoot = path.join(resolvedStateBase, oldProjectKey);
  const oldDirStat = lstatOrNull(oldStateRoot);
  if (
    oldDirStat === null ||
    !oldDirStat.isDirectory() ||
    lstatOrNull(path.join(oldStateRoot, PROJECT_RECORD_FILENAME)) === null
  ) {
    return null;
  }
  const record = readAndFinishFolderIfInterrupted(
    io,
    resolvedStateBase,
    oldProjectKey,
    oldStateRoot,
  );
  if (
    record.commonDirSha256.slice(0, 16) !== oldProjectKey ||
    record.canonicalCommonDir !== oldCanonicalCommonDir ||
    !sameStringArray(record.rootCommitShas, rootCommitShas) ||
    pathExistsAsDirectory(record.canonicalCommonDir)
  ) {
    return null;
  }
  return { stateRoot: oldStateRoot, record };
}

function writeFreshProjectRecord(
  io: IdentityFsOps,
  live: LiveProjectIdentity,
  newStateRoot: string,
  appliedDecisionId: string | null,
): OpenProjectResult {
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
  ensureDirectory(newStateRoot, "invalid_project_record");
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
    appliedDecisionId,
  };
}

function listSiblingProjectRecords(
  io: IdentityFsOps,
  resolvedStateBase: string,
  excludeProjectKey: string,
): Array<{
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly record: ProjectRecord;
}> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolvedStateBase, { withFileTypes: true }) as fs.Dirent[];
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const siblings: Array<{
    readonly projectKey: string;
    readonly stateRoot: string;
    readonly record: ProjectRecord;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const siblingKey = entry.name;
    if (!PROJECT_KEY_PATTERN.test(siblingKey) || siblingKey === excludeProjectKey) {
      continue;
    }

    const siblingStateRoot = path.join(resolvedStateBase, siblingKey);
    const siblingProjectPath = path.join(siblingStateRoot, PROJECT_RECORD_FILENAME);
    if (lstatOrNull(siblingProjectPath) === null) {
      continue;
    }

    const record = readAndFinishFolderIfInterrupted(
      io,
      resolvedStateBase,
      siblingKey,
      siblingStateRoot,
    );
    siblings.push({ projectKey: siblingKey, stateRoot: siblingStateRoot, record });
  }

  return siblings;
}

function hasStateFolderReboundFrom(
  io: IdentityFsOps,
  resolvedStateBase: string,
  projectKey: string,
): boolean {
  for (const sibling of listSiblingProjectRecords(io, resolvedStateBase, projectKey)) {
    if (sibling.record.reboundFrom?.includes(projectKey)) {
      return true;
    }
  }
  return false;
}

function scanRelocationCandidates(
  io: IdentityFsOps,
  resolvedStateBase: string,
  live: LiveProjectIdentity,
): RelocationCandidate[] {
  const candidates: RelocationCandidate[] = [];
  for (const { projectKey, stateRoot, record } of listSiblingProjectRecords(
    io,
    resolvedStateBase,
    live.projectKey,
  )) {
    if (
      sameStringArray(record.rootCommitShas, live.rootCommitShas) &&
      record.originUrl === live.originUrl &&
      !pathExistsAsDirectory(record.canonicalCommonDir)
    ) {
      candidates.push({
        projectKey,
        stateRoot,
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

export function resolveProjectIdentity(cwd: string): LiveProjectIdentity {
  requireNonEmptyString(cwd, "cwd");

  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
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
    canonicalCommonDir = fs.realpathSync(resolvedCommonDir);
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
): RecordIdentityDecisionResult {
  const cwd = input.cwd;
  const stateBase = input.stateBase;
  const choice = input.choice;
  const decidedBy = input.decidedBy;
  const requestedOldProjectKey = input.oldProjectKey;

  requireNonEmptyString(cwd, "cwd");
  requireNonEmptyString(stateBase, "stateBase");
  requireNonEmptyString(decidedBy, "decidedBy");

  if (choice !== "rebind" && choice !== "new_project") {
    throw new IdentityError(
      "invalid_argument",
      `choice must be "rebind" or "new_project", received ${String(choice)}`,
    );
  }
  if (choice === "rebind") {
    if (typeof requestedOldProjectKey !== "string" || !PROJECT_KEY_PATTERN.test(requestedOldProjectKey)) {
      throw new IdentityError(
        "invalid_argument",
        "rebind decision requires a valid 16-hex oldProjectKey",
      );
    }
  } else if (requestedOldProjectKey !== undefined && requestedOldProjectKey !== null) {
    if (typeof requestedOldProjectKey !== "string" || !PROJECT_KEY_PATTERN.test(requestedOldProjectKey)) {
      throw new IdentityError(
        "invalid_argument",
        "oldProjectKey must be a valid 16-hex key or null",
      );
    }
  }

  const resolvedStateBase = path.resolve(stateBase);
  const live = resolveProjectIdentity(cwd);
  const newStateRoot = path.join(resolvedStateBase, live.projectKey);

  if (lstatOrNull(newStateRoot) !== null) {
    throw new IdentityError(
      "rebind_destination_exists",
      `Destination project folder already exists: ${newStateRoot}`,
      { details: { projectKey: live.projectKey, stateRoot: newStateRoot } },
    );
  }

  const decisionPath = decisionFilePath(resolvedStateBase, live.projectKey);
  let existingDecision: IdentityDecision | null = null;
  if (lstatOrNull(decisionPath) !== null) {
    existingDecision = readIdentityDecisionFile(decisionPath, live.projectKey);
    assertDecisionMatchesLive(existingDecision, decisionPath, live);
    if (
      existingDecision.choice === "new_project" &&
      hasStateFolderReboundFrom(DEFAULT_FS_OPS, resolvedStateBase, live.projectKey)
    ) {
      throw new IdentityError(
        "decision_mismatch",
        `Existing identity decision at ${decisionPath} was already used for a new project that has moved on`,
        {
          details: {
            decisionPath,
            decisionId: existingDecision.decisionId,
            newProjectKey: live.projectKey,
          },
        },
      );
    }
    if (existingDecision.oldProjectKey !== null && existingDecision.oldCanonicalCommonDir !== null) {
      if (
        requestedOldProjectKey !== undefined &&
        requestedOldProjectKey !== null &&
        requestedOldProjectKey !== existingDecision.oldProjectKey
      ) {
        throw new IdentityError(
          "decision_mismatch",
          `Existing identity decision at ${decisionPath} names ${existingDecision.oldProjectKey} -> ${existingDecision.newProjectKey}, not ${requestedOldProjectKey} -> ${live.projectKey}`,
          {
            details: {
              decisionPath,
              decisionId: existingDecision.decisionId,
              existingOldProjectKey: existingDecision.oldProjectKey,
              requestedOldProjectKey,
              newProjectKey: live.projectKey,
            },
          },
        );
      }
      if (
        resolveDecisionSourceRecord(
          DEFAULT_FS_OPS,
          resolvedStateBase,
          existingDecision.oldProjectKey,
          existingDecision.oldCanonicalCommonDir,
          existingDecision.rootCommitShas,
        ) === null
      ) {
        throw new IdentityError(
          "decision_mismatch",
          `Existing identity decision at ${decisionPath} names ${existingDecision.oldProjectKey} -> ${existingDecision.newProjectKey}, which does not match the current move`,
          {
            details: {
              decisionPath,
              decisionId: existingDecision.decisionId,
              existingOldProjectKey: existingDecision.oldProjectKey,
              newProjectKey: live.projectKey,
            },
          },
        );
      }
    }
  }

  const candidates = scanRelocationCandidates(DEFAULT_FS_OPS, resolvedStateBase, live);

  let oldProjectKey: string | null = null;
  let oldCanonicalCommonDir: string | null = null;

  if (choice === "rebind" || (requestedOldProjectKey !== undefined && requestedOldProjectKey !== null)) {
    const requestedKey = requestedOldProjectKey as string;
    const matched = candidates.find((candidate) => candidate.projectKey === requestedKey);
    if (matched !== undefined) {
      oldProjectKey = matched.projectKey;
      oldCanonicalCommonDir = matched.canonicalCommonDir;
    } else if (
      existingDecision !== null &&
      existingDecision.oldProjectKey === requestedKey &&
      existingDecision.oldCanonicalCommonDir !== null
    ) {
      oldProjectKey = existingDecision.oldProjectKey;
      oldCanonicalCommonDir = existingDecision.oldCanonicalCommonDir;
    } else {
      throw new IdentityError(
        "decision_candidate_not_found",
        `oldProjectKey ${requestedKey} is not a relocation candidate for ${live.projectKey}`,
        { candidates, details: { requestedOldProjectKey: requestedKey } },
      );
    }
  }

  const decision: IdentityDecision = {
    schemaVersion: IDENTITY_DECISION_SCHEMA_VERSION,
    decisionId: crypto.randomUUID(),
    choice,
    oldProjectKey,
    newProjectKey: live.projectKey,
    oldCanonicalCommonDir,
    newCanonicalCommonDir: live.canonicalCommonDir,
    rootCommitShas: [...live.rootCommitShas],
    originUrl: live.originUrl,
    decidedBy: decidedBy.trim(),
    time: new Date().toISOString(),
  };

  const decisionsDir = path.join(resolvedStateBase, IDENTITY_DECISIONS_DIR);
  const fileName = `${live.projectKey}.json`;
  const payload = `${JSON.stringify(decision, null, 2)}\n`;
  const writtenPath = writePayloadExclusive(
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

function openProjectAttempt(
  io: IdentityFsOps,
  resolvedStateBase: string,
  live: LiveProjectIdentity,
  canRetryLostRebindRace: boolean,
): OpenProjectResult {
  const newStateRoot = path.join(resolvedStateBase, live.projectKey);
  const newProjectJsonPath = path.join(newStateRoot, PROJECT_RECORD_FILENAME);
  const decisionPath = decisionFilePath(resolvedStateBase, live.projectKey);

  const decision =
    lstatOrNull(decisionPath) !== null
      ? readIdentityDecisionFile(decisionPath, live.projectKey)
      : null;

  if (decision !== null) {
    assertDecisionMatchesLive(decision, decisionPath, live);
  }

  const destStat = lstatOrNull(newStateRoot);
  if (destStat !== null) {
    const oldStateRoot =
      decision !== null && decision.choice === "rebind" && decision.oldProjectKey !== null
        ? path.join(resolvedStateBase, decision.oldProjectKey)
        : null;
    const oldStillExists = oldStateRoot !== null && lstatOrNull(oldStateRoot) !== null;

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

    if (lstatOrNull(newProjectJsonPath) === null) {
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

    const stored = readProjectRecordFile(newProjectJsonPath);

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

      if (decision !== null && decision.choice === "rebind") {
        const rebindCompleted =
          decision.oldProjectKey !== null &&
          stored.reboundFrom !== undefined &&
          stored.reboundFrom.includes(decision.oldProjectKey) &&
          sameStringArray(stored.rootCommitShas, decision.rootCommitShas);
        if (!rebindCompleted) {
          throw new IdentityError(
            "rebind_destination_exists",
            `Destination ${live.projectKey} already exists and was not rebound from ${String(decision.oldProjectKey)}`,
            { details: { oldProjectKey: decision.oldProjectKey, newProjectKey: live.projectKey } },
          );
        }
      }

      return {
        projectKey: live.projectKey,
        stateRoot: newStateRoot,
        record: cloneProjectRecord(stored),
        originDrift: computeOriginDrift(stored.originUrl, live.originUrl),
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
      if (isMatchingInterruptedRebind(stored, decision, live)) {
        fsyncDir(resolvedStateBase);
        const updatedRecord = finishInterruptedRebind(io, newStateRoot, stored, decision);
        return {
          projectKey: live.projectKey,
          stateRoot: newStateRoot,
          record: cloneProjectRecord(updatedRecord),
          originDrift: computeOriginDrift(updatedRecord.originUrl, live.originUrl),
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

  if (decision === null) {
    const candidates = scanRelocationCandidates(io, resolvedStateBase, live);
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

    return writeFreshProjectRecord(io, live, newStateRoot, null);
  }

  if (decision.choice === "new_project") {
    if (hasStateFolderReboundFrom(io, resolvedStateBase, live.projectKey)) {
      throw new IdentityError(
        "decision_mismatch",
        `Identity decision at ${decisionPath} was already used for a new project that has moved on`,
        {
          details: {
            decisionPath,
            decisionId: decision.decisionId,
            newProjectKey: live.projectKey,
          },
        },
      );
    }
    if (decision.oldProjectKey !== null && decision.oldCanonicalCommonDir !== null) {
      const oldSource = resolveDecisionSourceRecord(
        io,
        resolvedStateBase,
        decision.oldProjectKey,
        decision.oldCanonicalCommonDir,
        decision.rootCommitShas,
      );
      if (oldSource === null) {
        throw new IdentityError(
          "decision_mismatch",
          `Identity decision at ${decisionPath} names ${decision.oldProjectKey} -> ${decision.newProjectKey}, which does not match the current move`,
          {
            details: {
              decisionPath,
              decisionId: decision.decisionId,
              oldProjectKey: decision.oldProjectKey,
              newProjectKey: live.projectKey,
            },
          },
        );
      }
    }

    return writeFreshProjectRecord(io, live, newStateRoot, decision.decisionId);
  }

  // decision.choice === "rebind"
  const oldProjectKey = decision.oldProjectKey;
  const oldCanonicalCommonDir = decision.oldCanonicalCommonDir;
  if (oldProjectKey === null || oldCanonicalCommonDir === null) {
    throw new IdentityError("invalid_decision", `Rebind decision at ${decisionPath} is missing oldProjectKey`);
  }

  let oldSource: { readonly stateRoot: string; readonly record: ProjectRecord } | null;
  try {
    oldSource = resolveDecisionSourceRecord(
      io,
      resolvedStateBase,
      oldProjectKey,
      oldCanonicalCommonDir,
      decision.rootCommitShas,
    );
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (canRetryLostRebindRace) {
        return openProjectAttempt(io, resolvedStateBase, live, false);
      }
      throw new IdentityError(
        "decision_mismatch",
        `Identity decision at ${decisionPath} names ${oldProjectKey} -> ${decision.newProjectKey}, whose source folder disappeared during rebind`,
        {
          details: {
            decisionPath,
            decisionId: decision.decisionId,
            oldProjectKey,
            newProjectKey: live.projectKey,
          },
          cause: err,
        },
      );
    }
    throw err;
  }

  if (oldSource === null) {
    if (canRetryLostRebindRace && lstatOrNull(newStateRoot) !== null) {
      return openProjectAttempt(io, resolvedStateBase, live, false);
    }
    throw new IdentityError(
      "decision_mismatch",
      `Identity decision at ${decisionPath} names ${oldProjectKey} -> ${decision.newProjectKey}, which does not match the current move`,
      {
        details: {
          decisionPath,
          decisionId: decision.decisionId,
          oldProjectKey,
          newProjectKey: live.projectKey,
        },
      },
    );
  }

  const oldStateRoot = oldSource.stateRoot;
  const oldRecord = oldSource.record;
  const updatedRecord: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    slug: live.slug,
    canonicalCommonDir: live.canonicalCommonDir,
    commonDirSha256: live.commonDirSha256,
    originUrl: oldRecord.originUrl,
    rootCommitShas: [...oldRecord.rootCommitShas],
    reboundFrom: buildReboundFrom(oldRecord.reboundFrom, oldProjectKey, live.projectKey),
  };

  // Validate size BEFORE renaming so an oversized record never mutates disk.
  const payload = serializeRecordJson(
    updatedRecord,
    PROJECT_RECORD_FILENAME,
    MAX_PROJECT_RECORD_BYTES,
    "project_record_too_large",
  );

  // Step 1: Move old project folder to new key in one rename; no file inside is rewritten.
  // An empty directory appearing between the existence check and rename(2) is atomically
  // replaced by POSIX rename(2); it holds no files or state, so replacing it loses nothing.
  try {
    io.renameSync(oldStateRoot, newStateRoot);
  } catch (err) {
    const code = getErrnoCode(err);
    if (
      code === "ENOENT" ||
      code === "ENOTEMPTY" ||
      code === "EEXIST" ||
      code === "ENOTDIR" ||
      code === "EISDIR"
    ) {
      if (canRetryLostRebindRace) {
        return openProjectAttempt(io, resolvedStateBase, live, false);
      }
      if (code === "ENOENT") {
        throw new IdentityError(
          "decision_mismatch",
          `Identity decision at ${decisionPath} names ${oldProjectKey} -> ${decision.newProjectKey}, whose source folder disappeared before rename`,
          {
            details: {
              decisionPath,
              decisionId: decision.decisionId,
              oldProjectKey,
              newProjectKey: live.projectKey,
            },
            cause: err,
          },
        );
      }
      throw new IdentityError(
        "rebind_destination_exists",
        `Rebind destination already exists with content: ${newStateRoot}`,
        {
          details: { oldProjectKey, newProjectKey: live.projectKey, stateRoot: newStateRoot },
          cause: err,
        },
      );
    }
    throw err;
  }

  fsyncDir(resolvedStateBase);

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
    originDrift: computeOriginDrift(updatedRecord.originUrl, live.originUrl),
    created: false,
    rebound: true,
    appliedDecisionId: decision.decisionId,
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
  const live = resolveProjectIdentity(cwd);
  return openProjectAttempt(io, resolvedStateBase, live, true);
}
