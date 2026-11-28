import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLease,
  LeaseError,
  type LeaseErrorCode,
  type OwnerLease,
} from "./lease.ts";

export { LeaseError, type LeaseErrorCode, type OwnerLease };

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const MAX_PROJECT_RECORD_BYTES = 2048;
export const PROJECT_RECORD_FILENAME = "project.json";

const PROJECT_KEY_PATTERN = /^[0-9a-f]{16}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const PROJECT_RECORD_KEYS = new Set([
  "schemaVersion",
  "slug",
  "canonicalCommonDir",
  "commonDirSha256",
  "originUrl",
  "rootCommitShas",
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
  | "identity_unborn"
  | "identity_mismatch"
  | "identity_relocated"
  | "project_record_too_large"
  | "invalid_project_record";

export type ClaimErrorCode = IdentityErrorCode | LeaseErrorCode;

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
}

export interface OriginWarning {
  readonly stored: string | null;
  readonly live: string | null;
}

export interface IdentityFsOps {
  readonly realpathSync: typeof fs.realpathSync;
  readonly openSync: typeof fs.openSync;
  readonly writeFileSync: typeof fs.writeFileSync;
  readonly fsyncSync: typeof fs.fsyncSync;
  readonly closeSync: typeof fs.closeSync;
  readonly linkSync: typeof fs.linkSync;
  readonly unlinkSync: typeof fs.unlinkSync;
  readonly readFileSync: typeof fs.readFileSync;
  readonly fstatSync: typeof fs.fstatSync;
  readonly lstatSync: typeof fs.lstatSync;
}

export interface ResolveIdentityOptions {
  readonly fs?: Partial<IdentityFsOps>;
}

export interface ClaimProjectOptions {
  readonly fs?: Partial<IdentityFsOps>;
  readonly acquireTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
}

export interface ClaimProjectResult {
  readonly projectKey: string;
  readonly stateRoot: string;
  readonly lease: OwnerLease;
  readonly record: ProjectRecord;
  readonly published: boolean;
  readonly originWarning: OriginWarning | null;
}

interface PublishOrVerifyOutcome {
  readonly record: ProjectRecord;
  readonly published: boolean;
  readonly originWarning: OriginWarning | null;
}

const DEFAULT_FS_OPS: IdentityFsOps = {
  realpathSync: fs.realpathSync,
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
  readFileSync: fs.readFileSync,
  fstatSync: fs.fstatSync,
  lstatSync: fs.lstatSync,
};

function resolveFsOps(overrides?: Partial<IdentityFsOps>): IdentityFsOps {
  if (overrides === undefined) {
    return DEFAULT_FS_OPS;
  }
  return {
    realpathSync: overrides.realpathSync ?? fs.realpathSync,
    openSync: overrides.openSync ?? fs.openSync,
    writeFileSync: overrides.writeFileSync ?? fs.writeFileSync,
    fsyncSync: overrides.fsyncSync ?? fs.fsyncSync,
    closeSync: overrides.closeSync ?? fs.closeSync,
    linkSync: overrides.linkSync ?? fs.linkSync,
    unlinkSync: overrides.unlinkSync ?? fs.unlinkSync,
    readFileSync: overrides.readFileSync ?? fs.readFileSync,
    fstatSync: overrides.fstatSync ?? fs.fstatSync,
    lstatSync: overrides.lstatSync ?? fs.lstatSync,
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

function hasSharedString(a: readonly string[], b: readonly string[]): boolean {
  const bSet = new Set(b);
  for (const item of a) {
    if (bSet.has(item)) {
      return true;
    }
  }
  return false;
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
    if (i > 0 && !(value[i - 1]! < item)) {
      return false;
    }
  }
  return true;
}

function cloneProjectRecord(record: ProjectRecord): ProjectRecord {
  return {
    schemaVersion: record.schemaVersion,
    slug: record.slug,
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirSha256: record.commonDirSha256,
    originUrl: record.originUrl,
    rootCommitShas: [...record.rootCommitShas],
  };
}

function computeOriginWarning(
  storedOriginUrl: string | null,
  liveOriginUrl: string | null,
): OriginWarning | null {
  return storedOriginUrl !== liveOriginUrl
    ? { stored: storedOriginUrl, live: liveOriginUrl }
    : null;
}

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IdentityError("invalid_argument", `${name} must be a non-empty string`);
  }
  return value;
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

function fsyncDir(io: IdentityFsOps, dirPath: string): void {
  const dirFd = io.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    io.fsyncSync(dirFd);
  } finally {
    io.closeSync(dirFd);
  }
}

function serializeProjectRecord(record: ProjectRecord): Buffer {
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.byteLength >= MAX_PROJECT_RECORD_BYTES) {
    throw new IdentityError(
      "project_record_too_large",
      `${PROJECT_RECORD_FILENAME} is ${bytes.byteLength} UTF-8 bytes; must be fewer than ${MAX_PROJECT_RECORD_BYTES} bytes`,
      {
        details: {
          fileName: PROJECT_RECORD_FILENAME,
          byteLength: bytes.byteLength,
          maxBytes: MAX_PROJECT_RECORD_BYTES,
        },
      },
    );
  }
  return bytes;
}

function readBoundedUtf8File(io: IdentityFsOps, filePath: string): string {
  let fd: number;
  try {
    const flags =
      typeof fs.constants.O_NOFOLLOW === "number"
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY;
    fd = io.openSync(filePath, flags);
  } catch (err) {
    if (getErrnoCode(err) === "ELOOP") {
      throw new IdentityError("invalid_project_record", `Refusing symlink at ${filePath}`, {
        cause: err,
      });
    }
    throw err;
  }

  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) {
      throw new IdentityError("invalid_project_record", `Expected regular file at ${filePath}`);
    }
    if (stat.size >= MAX_PROJECT_RECORD_BYTES) {
      throw new IdentityError(
        "project_record_too_large",
        `${path.basename(filePath)} is ${stat.size} bytes; must be fewer than ${MAX_PROJECT_RECORD_BYTES} bytes`,
        { details: { filePath, byteLength: stat.size, maxBytes: MAX_PROJECT_RECORD_BYTES } },
      );
    }

    const raw = io.readFileSync(fd);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    if (bytes.byteLength >= MAX_PROJECT_RECORD_BYTES) {
      throw new IdentityError(
        "project_record_too_large",
        `${path.basename(filePath)} is ${bytes.byteLength} bytes; must be fewer than ${MAX_PROJECT_RECORD_BYTES} bytes`,
        {
          details: {
            filePath,
            byteLength: bytes.byteLength,
            maxBytes: MAX_PROJECT_RECORD_BYTES,
          },
        },
      );
    }

    try {
      return UTF8_FATAL_DECODER.decode(bytes);
    } catch (err) {
      throw new IdentityError("invalid_project_record", `Invalid UTF-8 in ${filePath}`, {
        cause: err,
      });
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

  for (const key of Object.keys(parsed)) {
    if (!PROJECT_RECORD_KEYS.has(key)) {
      throw new IdentityError("invalid_project_record", `Unexpected field ${key} in ${filePath}`);
    }
  }
  for (const requiredKey of PROJECT_RECORD_KEYS) {
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
  const rawText = readBoundedUtf8File(io, filePath);
  return parseProjectRecord(rawText, filePath);
}

function verifyExistingProjectRecord(
  io: IdentityFsOps,
  projectPath: string,
  projectKey: string,
  live: LiveProjectIdentity,
): PublishOrVerifyOutcome {
  const stored = readProjectRecordFile(io, projectPath);

  if (stored.canonicalCommonDir !== live.canonicalCommonDir) {
    throw new IdentityError(
      "identity_mismatch",
      `Stored canonicalCommonDir (${stored.canonicalCommonDir}) does not match live path (${live.canonicalCommonDir})`,
      {
        details: {
          projectKey,
          storedCanonicalCommonDir: stored.canonicalCommonDir,
          liveCanonicalCommonDir: live.canonicalCommonDir,
        },
      },
    );
  }

  if (
    stored.commonDirSha256.slice(0, 16) !== projectKey ||
    stored.commonDirSha256 !== live.commonDirSha256
  ) {
    throw new IdentityError(
      "identity_mismatch",
      `Stored commonDirSha256 (${stored.commonDirSha256}) does not match directory ${projectKey}`,
      {
        details: {
          projectKey,
          storedCommonDirSha256: stored.commonDirSha256,
          liveCommonDirSha256: live.commonDirSha256,
        },
      },
    );
  }

  if (
    stored.rootCommitShas.length === 0 ||
    !hasSharedString(stored.rootCommitShas, live.rootCommitShas)
  ) {
    throw new IdentityError(
      "identity_mismatch",
      `Stored rootCommitShas for ${projectKey} share no root commit with live repository`,
      {
        details: {
          projectKey,
          storedRootCommitShas: [...stored.rootCommitShas],
          liveRootCommitShas: [...live.rootCommitShas],
        },
      },
    );
  }

  return {
    record: stored,
    published: false,
    originWarning: computeOriginWarning(stored.originUrl, live.originUrl),
  };
}

function scanRelocationCandidates(
  io: IdentityFsOps,
  resolvedStateBase: string,
  live: LiveProjectIdentity,
): RelocationCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolvedStateBase, { withFileTypes: true });
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }

  const candidates: RelocationCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === live.projectKey) {
      continue;
    }
    if (!PROJECT_KEY_PATTERN.test(entry.name)) {
      continue;
    }

    const siblingStateRoot = path.join(resolvedStateBase, entry.name);
    const siblingProjectPath = path.join(siblingStateRoot, PROJECT_RECORD_FILENAME);
    if (lstatOrNull(io, siblingProjectPath) === null) {
      continue;
    }

    let record: ProjectRecord;
    try {
      record = readProjectRecordFile(io, siblingProjectPath);
    } catch {
      continue;
    }

    if (record.rootCommitShas.length === 0) {
      continue;
    }
    if (
      hasSharedString(record.rootCommitShas, live.rootCommitShas) &&
      lstatOrNull(io, record.canonicalCommonDir) === null
    ) {
      candidates.push({
        projectKey: entry.name,
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

function publishProjectRecord(
  io: IdentityFsOps,
  resolvedStateBase: string,
  stateRoot: string,
  projectPath: string,
  lease: OwnerLease,
  live: LiveProjectIdentity,
): PublishOrVerifyOutcome {
  const candidates = scanRelocationCandidates(io, resolvedStateBase, live);
  if (candidates.length > 0) {
    const namedDirs = candidates.map((candidate) => candidate.stateRoot);
    throw new IdentityError(
      "identity_relocated",
      `Clone appears relocated from existing state directory: ${namedDirs.join(", ")}`,
      {
        candidates,
        details: {
          projectKey: live.projectKey,
          matchingStateRoots: namedDirs,
        },
      },
    );
  }

  const record: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    slug: live.slug,
    canonicalCommonDir: live.canonicalCommonDir,
    commonDirSha256: live.commonDirSha256,
    originUrl: live.originUrl,
    rootCommitShas: [...live.rootCommitShas],
  };
  const bytes = serializeProjectRecord(record);

  // Check lease right before creating and writing the temporary file.
  lease.assertValid();

  const tmpName = `.${PROJECT_RECORD_FILENAME}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(stateRoot, tmpName);

  let fd: number | undefined;
  let createdTemp = false;
  let published = false;
  let linkedExisting = false;

  try {
    fd = io.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    createdTemp = true;

    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;

    // Check lease right before hard-linking project.json.
    lease.assertValid();

    try {
      io.linkSync(tmpPath, projectPath);
      published = true;
    } catch (err) {
      if (getErrnoCode(err) === "EEXIST") {
        linkedExisting = true;
      } else {
        throw err;
      }
    }

    if (published) {
      fsyncDir(io, stateRoot);
    }
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // Ignore close error while unwinding.
      }
    }
    if (createdTemp) {
      try {
        io.unlinkSync(tmpPath);
      } catch {
        // Leftover temp stays ignored and never masks a primary error.
      }
    }
  }

  if (linkedExisting) {
    return verifyExistingProjectRecord(io, projectPath, lease.projectKey, live);
  }

  return {
    record,
    published: true,
    originWarning: null,
  };
}

export function resolveProjectIdentity(
  cwd: string,
  options?: ResolveIdentityOptions,
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

export async function claimProject(
  cwd: string,
  stateBase: string,
  options?: ClaimProjectOptions,
): Promise<ClaimProjectResult> {
  requireNonEmptyString(cwd, "cwd");
  requireNonEmptyString(stateBase, "stateBase");

  const io = resolveFsOps(options?.fs);
  const resolvedStateBase = path.resolve(stateBase);

  // Step 1: Read the repository without writing anything.
  const initialLive = resolveProjectIdentity(cwd, { fs: io });

  // Step 2: Refuse unborn repositories before any write or lease acquisition.
  if (initialLive.rootCommitShas.length === 0) {
    throw new IdentityError(
      "identity_unborn",
      `Repository at ${initialLive.canonicalCommonDir} has no commit on any ref`,
      {
        details: {
          projectKey: initialLive.projectKey,
          canonicalCommonDir: initialLive.canonicalCommonDir,
        },
      },
    );
  }

  // Step 3: Acquire the owner lease; the lease creates the project directory.
  const stateRoot = path.join(resolvedStateBase, initialLive.projectKey);
  const lease = await acquireLease({
    projectKey: initialLive.projectKey,
    stateRoot,
    ...(options?.acquireTimeoutMs !== undefined
      ? { acquireTimeoutMs: options.acquireTimeoutMs }
      : {}),
    ...(options?.releaseTimeoutMs !== undefined
      ? { releaseTimeoutMs: options.releaseTimeoutMs }
      : {}),
  });

  try {
    const projectPath = path.join(stateRoot, PROJECT_RECORD_FILENAME);
    const { writeResult } = await lease.enqueue<PublishOrVerifyOutcome>({
      write: () => {
        // Step 4: Re-read the repository inside the lease queue.
        const live = resolveProjectIdentity(cwd, { fs: io });
        if (
          live.projectKey !== lease.projectKey ||
          live.canonicalCommonDir !== initialLive.canonicalCommonDir
        ) {
          throw new IdentityError(
            "identity_mismatch",
            `Repository key changed after lease acquisition: acquired ${lease.projectKey}, live ${live.projectKey}`,
            {
              details: {
                acquiredProjectKey: lease.projectKey,
                liveProjectKey: live.projectKey,
                acquiredCanonicalCommonDir: initialLive.canonicalCommonDir,
                liveCanonicalCommonDir: live.canonicalCommonDir,
              },
            },
          );
        }
        if (live.rootCommitShas.length === 0) {
          throw new IdentityError(
            "identity_unborn",
            `Repository at ${live.canonicalCommonDir} has no commit on any ref`,
            {
              details: {
                projectKey: live.projectKey,
                canonicalCommonDir: live.canonicalCommonDir,
              },
            },
          );
        }

        // Step 5: Publish project.json once, or verify an existing record.
        const outcome =
          lstatOrNull(io, projectPath) !== null
            ? verifyExistingProjectRecord(io, projectPath, lease.projectKey, live)
            : publishProjectRecord(io, resolvedStateBase, stateRoot, projectPath, lease, live);

        // Step 7: Final lease check after publication or verification.
        lease.assertValid();
        return outcome;
      },
    });

    // Guard against asynchronous revocation between queue completion and return.
    lease.assertValid();

    return {
      projectKey: lease.projectKey,
      stateRoot: lease.stateRoot,
      lease,
      record: cloneProjectRecord(writeResult.record),
      published: writeResult.published,
      originWarning: writeResult.originWarning,
    };
  } catch (err) {
    // Step 6: Release the lease after the queued step ends, never from inside it.
    try {
      await lease.release();
    } catch {
      // Preserve the original refusal error while ensuring the lease is released.
    }
    throw err;
  }
}
