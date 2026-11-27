import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, test } from "bun:test";
import {
  IDENTITY_DECISIONS_DIR,
  IdentityError,
  MAX_PROJECT_RECORD_BYTES,
  PROJECT_RECORD_FILENAME,
  openProject,
  recordIdentityDecision,
  resolveProjectIdentity,
  type IdentityOperationOptions,
  type LiveProjectIdentity,
  type OpenProjectResult,
  type ProjectRecord,
  type RecordIdentityDecisionInput,
  type RecordIdentityDecisionResult,
} from "../src/identity.ts";

interface IdentityUnderTest {
  readonly resolveProjectIdentity: (
    cwd: string,
    options?: IdentityOperationOptions,
  ) => LiveProjectIdentity;
  readonly openProject: (
    cwd: string,
    stateBase: string,
    options?: IdentityOperationOptions,
  ) => OpenProjectResult;
  readonly recordIdentityDecision: (
    input: RecordIdentityDecisionInput,
    options?: IdentityOperationOptions,
  ) => RecordIdentityDecisionResult;
}

const REAL_IDENTITY: IdentityUnderTest = {
  resolveProjectIdentity,
  openProject,
  recordIdentityDecision,
};

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY_MODULE_URL = pathToFileURL(path.resolve(TEST_DIR, "../src/identity.ts")).href;

interface TrackedProcess {
  readonly pid: number;
  readonly startTime: string;
}

const activeScratchDirs = new Set<string>();
const trackedProcesses = new Map<string, TrackedProcess>();

function createScratchDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-captain-s1b-${label}-`));
  activeScratchDirs.add(dir);
  return dir;
}

function removeScratchDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  activeScratchDirs.delete(dir);
}

function readProcessStat(pid: number): { state: string; startTime: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT" || code === "ESRCH") {
      return null;
    }
    throw err;
  }
  const closeParen = raw.lastIndexOf(")");
  if (closeParen === -1 || closeParen + 2 >= raw.length) {
    return null;
  }
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    return null;
  }
  return {
    state: fields[0],
    startTime: fields[19],
  };
}

function isSameProcessAlive(pid: number, expectedStartTime: string): boolean {
  const stat = readProcessStat(pid);
  if (stat === null || stat.startTime !== expectedStartTime) {
    return false;
  }
  return stat.state !== "Z" && stat.state !== "X" && stat.state !== "x";
}

function trackProcess(pid: number): TrackedProcess {
  const stat = readProcessStat(pid);
  const startTime = stat?.startTime ?? "";
  const entry = { pid, startTime };
  if (startTime.length > 0) {
    trackedProcesses.set(`${pid}:${startTime}`, entry);
  }
  return entry;
}

async function ensureProcessDead(proc: TrackedProcess, timeoutMs = 2000): Promise<void> {
  if (proc.startTime.length === 0) {
    return;
  }
  if (isSameProcessAlive(proc.pid, proc.startTime)) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== "ESRCH") {
        throw err;
      }
    }
  }
  const deadline = performance.now() + timeoutMs;
  while (isSameProcessAlive(proc.pid, proc.startTime)) {
    if (performance.now() >= deadline) {
      throw new Error(`Process pid=${proc.pid} stayed alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  trackedProcesses.delete(`${proc.pid}:${proc.startTime}`);
}

afterEach(async () => {
  for (const proc of [...trackedProcesses.values()]) {
    await ensureProcessDead(proc);
  }
  for (const dir of [...activeScratchDirs]) {
    removeScratchDir(dir);
  }
});

afterAll(async () => {
  for (const proc of [...trackedProcesses.values()]) {
    await ensureProcessDead(proc);
  }
  for (const dir of [...activeScratchDirs]) {
    removeScratchDir(dir);
  }
  assert.strictEqual(activeScratchDirs.size, 0, "scratch directories leaked");
  assert.strictEqual(trackedProcesses.size, 0, "child processes leaked");
});

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SUPER_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

function runGit(args: readonly string[], cwd?: string): string {
  const fullArgs = cwd !== undefined ? ["-C", cwd, ...args] : [...args];
  return execFileSync("git", fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  }).trim();
}

function initRepoWithCommit(
  repoDir: string,
  options?: { readonly content?: string; readonly originUrl?: string; readonly commitDate?: string },
): string {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(["init", "-b", "main"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), options?.content ?? "fixture repo\n", "utf8");
  runGit(["add", "README.md"], repoDir);
  const env = {
    ...cleanGitEnv(),
    ...(options?.commitDate
      ? { GIT_AUTHOR_DATE: options.commitDate, GIT_COMMITTER_DATE: options.commitDate }
      : {}),
  };
  execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "-c",
      "user.name=Test Author",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial commit",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
  );
  if (options?.originUrl !== undefined) {
    runGit(["remote", "add", "origin", options.originUrl], repoDir);
  }
  return runGit(["rev-parse", "HEAD"], repoDir);
}

function addOrphanRootCommit(repoDir: string, branchName: string, content: string, commitDate: string): string {
  runGit(["checkout", "--orphan", branchName], repoDir);
  runGit(["rm", "-rf", "."], repoDir);
  fs.writeFileSync(path.join(repoDir, `${branchName}.txt`), content, "utf8");
  runGit(["add", `${branchName}.txt`], repoDir);
  const env = {
    ...cleanGitEnv(),
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  };
  execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "-c",
      "user.name=Test Author",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      `orphan ${branchName}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
  );
  return runGit(["rev-parse", "HEAD"], repoDir);
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface FileSnapshot {
  readonly sha256: string;
  readonly bytes: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

function snapshotFile(filePath: string): FileSnapshot {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

function snapshotTree(rootDir: string, skipRelPaths: ReadonlySet<string> = new Set()): Map<string, FileSnapshot> {
  const out = new Map<string, FileSnapshot>();
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (skipRelPaths.has(rel)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.set(rel, snapshotFile(full));
      }
    }
  };
  walk(rootDir, "");
  return out;
}

function seedStateFiles(stateRoot: string): void {
  fs.mkdirSync(path.join(stateRoot, "tickets", "8", "log"), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "tickets", "8", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "owner.lock"), "", "utf8");
  fs.writeFileSync(
    path.join(stateRoot, "owner.json"),
    `${JSON.stringify({ schemaVersion: 1, epoch: 3 }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(stateRoot, "tickets", "8", "log", "000001.json"),
    `${JSON.stringify({ schemaVersion: 1, seq: 1, event: "brief_committed" })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(stateRoot, "tickets", "8", "artifacts", "artifact.md"),
    "immutable artifact content\n",
    "utf8",
  );
}

function expectIdentityError(
  fn: () => unknown,
  expectedCode: IdentityError["code"],
  contextMessage: string,
): IdentityError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof IdentityError,
    `${contextMessage}: expected IdentityError(${expectedCode}), got ${String(caught)}`,
  );
  assert.strictEqual(
    caught.code,
    expectedCode,
    `${contextMessage}: expected code=${expectedCode}, got code=${caught.code} (${caught.message})`,
  );
  return caught;
}

async function expectCheckFailure(
  fn: () => void | Promise<void>,
  expectedPattern: RegExp,
  label: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `${label}: expected check to fail, but it passed`);
  assert.match(
    caught.message,
    expectedPattern,
    `${label}: check failed with unexpected error: ${caught.message}`,
  );
}

function runFreshOpenSubprocess(cwd: string, stateBase: string): OpenProjectResult {
  const script = `
    import { openProject } from ${JSON.stringify(IDENTITY_MODULE_URL)};
    const [cwd, stateBase] = process.argv.slice(1);
    const result = openProject(cwd, stateBase);
    process.stdout.write(JSON.stringify(result) + "\\n");
  `;
  const proc = spawnSync(process.execPath, ["-e", script, cwd, stateBase], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.strictEqual(
    proc.status,
    0,
    `fresh open subprocess failed (status=${proc.status}, stderr=${proc.stderr})`,
  );
  return JSON.parse(proc.stdout.trim()) as OpenProjectResult;
}

async function spawnFlockHolder(lockPath: string): Promise<{
  readonly proc: TrackedProcess;
  readonly release: () => Promise<void>;
}> {
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblocking",
      "--no-fork",
      "--conflict-exit-code",
      "200",
      lockPath,
      "sh",
      "-c",
      'printf "ready\\n"; exec cat >/dev/null',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  assert.ok(child.pid !== undefined, "flock holder did not report a pid");
  const proc = trackProcess(child.pid);
  child.stdin.on("error", () => {});

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await new Promise<void>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for flock holder ready line (stderr=${stderrBuf})`));
    }, 5000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (stdoutBuf.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`flock holder exited before ready (code=${code}, signal=${signal}, stderr=${stderrBuf})`));
    });
  });

  const release = async (): Promise<void> => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }
    await exited;
    await ensureProcessDead(proc);
  };

  return { proc, release };
}

// ---------------------------------------------------------------------------
// Check functions (shared by real tests and broken-adapter negative controls)
// ---------------------------------------------------------------------------

function runCheck1WorktreesClonesAndNonGit(api: IdentityUnderTest, scratch: string): void {
  const originRepo = path.join(scratch, "origin-repo");
  const mainClone = path.join(scratch, "clone-a", "project-dir");
  const wtAlpha = path.join(scratch, "wt-alpha");
  const wtBeta = path.join(scratch, "completely-different-name");
  const wtBetaLink = path.join(scratch, "wt-beta-symlink");
  const wtBetaSub = path.join(wtBeta, "nested", "subdir");
  const wtBetaSubLink = path.join(scratch, "wt-beta-sub-symlink");
  const separateClone = path.join(scratch, "separate-clone");
  const unrelatedSameName = path.join(scratch, "unrelated-parent", "project-dir");
  const outsideGit = path.join(scratch, "not-a-git-repo");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  fs.mkdirSync(path.dirname(mainClone), { recursive: true });
  runGit(["clone", originRepo, mainClone]);
  runGit(["worktree", "add", "-b", "branch-alpha", wtAlpha], mainClone);
  runGit(["worktree", "add", "-b", "branch-beta", wtBeta], mainClone);
  fs.mkdirSync(wtBetaSub, { recursive: true });
  fs.symlinkSync(wtBeta, wtBetaLink);
  fs.symlinkSync(wtBetaSub, wtBetaSubLink);
  runGit(["clone", originRepo, separateClone]);
  initRepoWithCommit(unrelatedSameName, { content: "distinct repo\n" });
  fs.mkdirSync(outsideGit, { recursive: true });

  const expectedCommonDir = fs.realpathSync(path.join(mainClone, ".git"));
  const expectedSha256 = sha256Hex(expectedCommonDir);
  const expectedKey = expectedSha256.slice(0, 16);

  const idMain = api.resolveProjectIdentity(mainClone);
  const idAlpha = api.resolveProjectIdentity(wtAlpha);
  const idBeta = api.resolveProjectIdentity(wtBeta);
  const idBetaLink = api.resolveProjectIdentity(wtBetaLink);
  const idBetaSubLink = api.resolveProjectIdentity(wtBetaSubLink);
  const idSeparate = api.resolveProjectIdentity(separateClone);
  const idUnrelated = api.resolveProjectIdentity(unrelatedSameName);

  assert.match(idMain.projectKey, /^[0-9a-f]{16}$/);
  assert.strictEqual(idMain.projectKey, expectedKey, "main clone key must match sha256(commonDir).slice(0,16)");
  assert.strictEqual(idAlpha.projectKey, expectedKey, "linked worktree wt-alpha must share projectKey");
  assert.strictEqual(idBeta.projectKey, expectedKey, "linked worktree with different name must share projectKey");
  assert.strictEqual(idBetaLink.projectKey, expectedKey, "symlinked worktree must share projectKey");
  assert.strictEqual(idBetaSubLink.projectKey, expectedKey, "symlinked nested subdir must share projectKey");
  assert.strictEqual(idAlpha.canonicalCommonDir, expectedCommonDir);
  assert.strictEqual(idBeta.canonicalCommonDir, expectedCommonDir);
  assert.strictEqual(idBetaLink.canonicalCommonDir, expectedCommonDir);
  assert.strictEqual(idBetaSubLink.canonicalCommonDir, expectedCommonDir);

  assert.notStrictEqual(idSeparate.projectKey, expectedKey, "separate clone must have distinct projectKey");
  assert.notStrictEqual(
    idUnrelated.projectKey,
    expectedKey,
    "unrelated repository with identical folder basename must have distinct projectKey",
  );
  assert.notStrictEqual(idSeparate.projectKey, idUnrelated.projectKey);

  const openAlpha = api.openProject(wtAlpha, stateBase);
  assert.strictEqual(openAlpha.projectKey, expectedKey);
  assert.strictEqual(openAlpha.stateRoot, path.join(stateBase, expectedKey));
  assert.strictEqual(openAlpha.created, true);

  const openBetaLink = api.openProject(wtBetaLink, stateBase);
  assert.strictEqual(openBetaLink.projectKey, expectedKey);
  assert.strictEqual(openBetaLink.created, false);

  const openSeparate = api.openProject(separateClone, stateBase);
  assert.strictEqual(openSeparate.projectKey, idSeparate.projectKey);
  assert.strictEqual(openSeparate.created, true);

  expectIdentityError(
    () => api.resolveProjectIdentity(outsideGit),
    "not_git_repo",
    "resolve outside git repo",
  );
  expectIdentityError(
    () => api.openProject(outsideGit, stateBase),
    "not_git_repo",
    "open outside git repo",
  );
  expectIdentityError(
    () => api.openProject(path.join(scratch, "does-not-exist"), stateBase),
    "not_git_repo",
    "open nonexistent path",
  );
}

function runCheck2ProjectRecordAndSizeLimit(api: IdentityUnderTest, scratch: string): void {
  const stateBase = path.join(scratch, "state");

  // Multi-root repo (3 parentless commits with controlled dates) + origin URL
  const multiRootRepo = path.join(scratch, "multi-root");
  const root1 = initRepoWithCommit(multiRootRepo, {
    content: "root-a\n",
    originUrl: "https://example.invalid/org/multi-root.git",
    commitDate: "2026-01-01T00:00:00Z",
  });
  const root2 = addOrphanRootCommit(multiRootRepo, "orphan-two", "root-b\n", "2026-01-02T00:00:00Z");
  const root3 = addOrphanRootCommit(multiRootRepo, "orphan-three", "root-c\n", "2026-01-03T00:00:00Z");
  const expectedRoots = [root1, root2, root3].sort();

  const opened = api.openProject(multiRootRepo, stateBase);
  const projectJsonPath = path.join(opened.stateRoot, PROJECT_RECORD_FILENAME);
  const rawBytes = fs.readFileSync(projectJsonPath);
  assert.ok(rawBytes.byteLength < MAX_PROJECT_RECORD_BYTES);

  const parsed = JSON.parse(rawBytes.toString("utf8")) as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(parsed).sort(), [
    "canonicalCommonDir",
    "commonDirSha256",
    "originUrl",
    "rootCommitShas",
    "schemaVersion",
    "slug",
  ]);
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.slug, "multi-root");
  assert.strictEqual(parsed.canonicalCommonDir, fs.realpathSync(path.join(multiRootRepo, ".git")));
  assert.strictEqual(parsed.commonDirSha256, sha256Hex(parsed.canonicalCommonDir as string));
  assert.strictEqual(parsed.originUrl, "https://example.invalid/org/multi-root.git");
  assert.deepStrictEqual(parsed.rootCommitShas, expectedRoots);
  assert.deepStrictEqual(opened.record.rootCommitShas, expectedRoots);

  // Repo with no origin -> originUrl === null
  const noOriginRepo = path.join(scratch, "no-origin");
  const noOriginRoot = initRepoWithCommit(noOriginRepo);
  const openedNoOrigin = api.openProject(noOriginRepo, stateBase);
  assert.strictEqual(openedNoOrigin.record.originUrl, null);
  assert.deepStrictEqual(openedNoOrigin.record.rootCommitShas, [noOriginRoot]);

  // Exact byte boundary: 2047 UTF-8 bytes allowed; 2048 UTF-8 bytes refused with nothing written.
  const makeSizedRepo = (name: string, targetByteLength: number, useMultibyte: boolean): string => {
    const repo = path.join(scratch, name);
    const root = initRepoWithCommit(repo);
    const commonDir = fs.realpathSync(path.join(repo, ".git"));
    const commonSha = sha256Hex(commonDir);
    const baseRecord: ProjectRecord = {
      schemaVersion: 1,
      slug: name,
      canonicalCommonDir: commonDir,
      commonDirSha256: commonSha,
      originUrl: "https://example.invalid/",
      rootCommitShas: [root],
    };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(baseRecord, null, 2)}\n`, "utf8");
    const delta = targetByteLength - baseBytes;
    assert.ok(delta > 10, `expected room to pad ${name} to ${targetByteLength} bytes`);

    let suffix: string;
    if (useMultibyte) {
      // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes.
      const pairCount = Math.floor(delta / 2);
      const remainder = delta % 2;
      suffix = "é".repeat(pairCount) + "a".repeat(remainder);
    } else {
      suffix = "a".repeat(delta);
    }
    const url = `https://example.invalid/${suffix}`;
    const checkRecord: ProjectRecord = { ...baseRecord, originUrl: url };
    const serialized = `${JSON.stringify(checkRecord, null, 2)}\n`;
    assert.strictEqual(Buffer.byteLength(serialized, "utf8"), targetByteLength);
    if (useMultibyte) {
      assert.ok(serialized.length < targetByteLength, "expected UTF-16 length < UTF-8 byte length");
    }
    runGit(["remote", "add", "origin", url], repo);
    return repo;
  };

  const repo2047 = makeSizedRepo("size-2047", 2047, false);
  const opened2047 = api.openProject(repo2047, stateBase);
  const bytes2047 = fs.readFileSync(path.join(opened2047.stateRoot, PROJECT_RECORD_FILENAME));
  assert.strictEqual(bytes2047.byteLength, 2047);
  const reopened2047 = api.openProject(repo2047, stateBase);
  assert.strictEqual(reopened2047.created, false);

  const freshStateBase = path.join(scratch, "state-oversized");
  const repo2048 = makeSizedRepo("size-2048", 2048, false);
  expectIdentityError(
    () => api.openProject(repo2048, freshStateBase),
    "project_record_too_large",
    "2048-byte project.json must be refused",
  );
  assert.strictEqual(
    fs.existsSync(freshStateBase),
    false,
    "2048-byte refusal must write nothing and create no folder",
  );

  // Multi-byte UTF-8 case: UTF-16 length < 2048, UTF-8 byte length === 2048 -> refused!
  const repo2048Utf8 = makeSizedRepo("size-2048-utf8", 2048, true);
  expectIdentityError(
    () => api.openProject(repo2048Utf8, freshStateBase),
    "project_record_too_large",
    "2048 UTF-8 byte multi-byte project.json must be refused",
  );
  assert.strictEqual(fs.existsSync(freshStateBase), false);

  // Oversized on load: pad existing 2047-byte project.json to 2048 bytes -> refused on load!
  const paddedPath = path.join(opened2047.stateRoot, PROJECT_RECORD_FILENAME);
  fs.writeFileSync(paddedPath, Buffer.concat([bytes2047, Buffer.from(" ", "utf8")]));
  assert.strictEqual(fs.statSync(paddedPath).size, 2048);
  expectIdentityError(
    () => api.openProject(repo2047, stateBase),
    "project_record_too_large",
    "2048-byte project.json on disk must be refused on load",
  );
}

function runCheck3MismatchRefusal(api: IdentityUnderTest, scratch: string): void {
  const repo = path.join(scratch, "repo-a");
  const stateBase = path.join(scratch, "state");
  initRepoWithCommit(repo, { originUrl: "https://example.invalid/org/repo.git" });

  const opened = api.openProject(repo, stateBase);
  seedStateFiles(opened.stateRoot);

  const projectJsonPath = path.join(opened.stateRoot, PROJECT_RECORD_FILENAME);
  const collidingDir = path.join(scratch, "other-colliding-repo", ".git");
  const collidingRecord: ProjectRecord = {
    ...opened.record,
    canonicalCommonDir: collidingDir,
    commonDirSha256: sha256Hex(collidingDir),
  };
  fs.writeFileSync(projectJsonPath, `${JSON.stringify(collidingRecord, null, 2)}\n`, "utf8");

  const beforeTree = snapshotTree(stateBase);
  expectIdentityError(
    () => api.openProject(repo, stateBase),
    "identity_mismatch",
    "stored canonicalCommonDir mismatch must refuse with identity_mismatch",
  );
  const afterTree = snapshotTree(stateBase);
  assert.deepStrictEqual(afterTree, beforeTree, "mismatch refusal must leave state untouched");

  // Also test path-only tamper where commonDirSha256 stayed as the old hash.
  const pathOnlyMismatch: ProjectRecord = {
    ...opened.record,
    canonicalCommonDir: collidingDir,
  };
  fs.writeFileSync(projectJsonPath, `${JSON.stringify(pathOnlyMismatch, null, 2)}\n`, "utf8");
  const beforePathOnly = snapshotTree(stateBase);
  expectIdentityError(
    () => api.openProject(repo, stateBase),
    "identity_mismatch",
    "stored path tamper must refuse with identity_mismatch",
  );
  assert.deepStrictEqual(snapshotTree(stateBase), beforePathOnly);
}

function runCheck4RelocationAndLiveCopy(api: IdentityUnderTest, scratch: string): void {
  const originRepo = path.join(scratch, "origin");
  const cloneOrig = path.join(scratch, "clone-orig");
  const cloneCopy = path.join(scratch, "clone-copy");
  const cloneMoved = path.join(scratch, "clone-moved");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneOrig]);
  runGit(["clone", originRepo, cloneCopy]);

  const openedOrig = api.openProject(cloneOrig, stateBase);

  // Copy whose original still exists must open as a separate project.
  const openedCopy = api.openProject(cloneCopy, stateBase);
  assert.notStrictEqual(openedCopy.projectKey, openedOrig.projectKey);
  assert.strictEqual(openedCopy.created, true);

  // Different repo sharing only the same originUrl (different root commits) must NOT trigger relocation.
  const sameOriginOld = path.join(scratch, "same-origin-old");
  const sameOriginNew = path.join(scratch, "same-origin-new");
  const sharedUrl = "https://example.invalid/org/shared-url.git";
  initRepoWithCommit(sameOriginOld, { content: "history-1\n", originUrl: sharedUrl });
  initRepoWithCommit(sameOriginNew, { content: "history-2\n", originUrl: sharedUrl });
  api.openProject(sameOriginOld, stateBase);
  fs.rmSync(sameOriginOld, { recursive: true, force: true });
  const openedDistinctRoots = api.openProject(sameOriginNew, stateBase);
  assert.strictEqual(openedDistinctRoots.created, true);

  // Move cloneOrig -> cloneMoved: old canonical path is gone, must refuse with identity_relocated.
  fs.renameSync(cloneOrig, cloneMoved);
  const movedIdentity = api.resolveProjectIdentity(cloneMoved);
  const expectedNewStateRoot = path.join(stateBase, movedIdentity.projectKey);
  const decisionsDir = path.join(stateBase, IDENTITY_DECISIONS_DIR);

  const err = expectIdentityError(
    () => api.openProject(cloneMoved, stateBase),
    "identity_relocated",
    "moved clone must refuse with identity_relocated",
  );
  assert.ok(err.candidates !== undefined, "identity_relocated must list candidates");
  assert.strictEqual(err.candidates.length, 1);
  assert.strictEqual(err.candidates[0].projectKey, openedOrig.projectKey);
  assert.strictEqual(err.candidates[0].canonicalCommonDir, openedOrig.record.canonicalCommonDir);
  assert.strictEqual(
    fs.existsSync(expectedNewStateRoot),
    false,
    "relocation refusal must not create the new project folder",
  );
  assert.strictEqual(
    fs.existsSync(decisionsDir),
    false,
    "opening a project must never create a decision file",
  );

  // Local repo with originUrl === null also refuses with identity_relocated when moved.
  const localOrig = path.join(scratch, "local-orig");
  const localMoved = path.join(scratch, "local-moved");
  initRepoWithCommit(localOrig, { content: "local-only\n" });
  const openedLocal = api.openProject(localOrig, stateBase);
  fs.renameSync(localOrig, localMoved);
  const localErr = expectIdentityError(
    () => api.openProject(localMoved, stateBase),
    "identity_relocated",
    "moved local-only repo must refuse with identity_relocated",
  );
  assert.strictEqual(localErr.candidates?.length, 1);
  assert.strictEqual(localErr.candidates?.[0].projectKey, openedLocal.projectKey);
  assert.strictEqual(
    fs.existsSync(path.join(stateBase, api.resolveProjectIdentity(localMoved).projectKey)),
    false,
  );
}

function runCheck5TwoCandidatesAndNonCandidateRefusal(api: IdentityUnderTest, scratch: string): void {
  const originRepo = path.join(scratch, "origin");
  const cloneA = path.join(scratch, "clone-a");
  const cloneB = path.join(scratch, "clone-b");
  const cloneLive = path.join(scratch, "clone-live");
  const cloneMoved = path.join(scratch, "clone-moved");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneA]);
  runGit(["clone", originRepo, cloneB]);
  runGit(["clone", originRepo, cloneLive]);

  const openedA = api.openProject(cloneA, stateBase);
  const openedB = api.openProject(cloneB, stateBase);
  const openedLive = api.openProject(cloneLive, stateBase);
  seedStateFiles(openedA.stateRoot);
  seedStateFiles(openedB.stateRoot);

  const beforeA = snapshotTree(openedA.stateRoot);
  const beforeLive = snapshotTree(openedLive.stateRoot);

  // Remove cloneA and move cloneB -> cloneMoved; cloneLive stays on disk.
  fs.rmSync(cloneA, { recursive: true, force: true });
  fs.renameSync(cloneB, cloneMoved);

  const expectedCandidates = [openedA.projectKey, openedB.projectKey].sort();
  const relErr = expectIdentityError(
    () => api.openProject(cloneMoved, stateBase),
    "identity_relocated",
    "two missing clones must refuse and list both candidates",
  );
  assert.deepStrictEqual(
    relErr.candidates?.map((c) => c.projectKey),
    expectedCandidates,
    "relocation error must list both missing candidates and not the live clone",
  );

  const movedIdentity = api.resolveProjectIdentity(cloneMoved);
  assert.strictEqual(fs.existsSync(path.join(stateBase, movedIdentity.projectKey)), false);

  // Recording a decision naming a bogus key or a live non-candidate key must refuse.
  expectIdentityError(
    () =>
      api.recordIdentityDecision({
        cwd: cloneMoved,
        stateBase,
        choice: "rebind",
        oldProjectKey: "0123456789abcdef",
        decidedBy: "operator-test",
      }),
    "decision_candidate_not_found",
    "rebind decision naming nonexistent key must refuse",
  );
  expectIdentityError(
    () =>
      api.recordIdentityDecision({
        cwd: cloneMoved,
        stateBase,
        choice: "rebind",
        oldProjectKey: openedLive.projectKey,
        decidedBy: "operator-test",
      }),
    "decision_candidate_not_found",
    "rebind decision naming live clone key must refuse",
  );
  assert.strictEqual(fs.existsSync(path.join(stateBase, IDENTITY_DECISIONS_DIR)), false);

  // Also test openProject refusing an on-disk decision file that names a non-candidate key.
  const nonCandState = path.join(scratch, "state-non-candidate-file");
  fs.cpSync(stateBase, nonCandState, { recursive: true });
  const craftedDecisionsDir = path.join(nonCandState, IDENTITY_DECISIONS_DIR);
  fs.mkdirSync(craftedDecisionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(craftedDecisionsDir, `${movedIdentity.projectKey}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        decisionId: "crafted-non-candidate",
        choice: "rebind",
        oldProjectKey: openedLive.projectKey,
        newProjectKey: movedIdentity.projectKey,
        oldCanonicalCommonDir: openedLive.record.canonicalCommonDir,
        newCanonicalCommonDir: movedIdentity.canonicalCommonDir,
        rootCommitShas: [...movedIdentity.rootCommitShas],
        originUrl: movedIdentity.originUrl,
        decidedBy: "operator-test",
        time: "2026-11-27T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  expectIdentityError(
    () => api.openProject(cloneMoved, nonCandState),
    "decision_candidate_not_found",
    "openProject must refuse an on-disk decision naming a non-candidate",
  );
  assert.strictEqual(fs.existsSync(path.join(nonCandState, movedIdentity.projectKey)), false);

  // Recording a decision naming one of the two candidates succeeds and rebinds only that one.
  const recorded = api.recordIdentityDecision({
    cwd: cloneMoved,
    stateBase,
    choice: "rebind",
    oldProjectKey: openedB.projectKey,
    decidedBy: "operator-test",
  });
  const openedMoved = api.openProject(cloneMoved, stateBase);
  assert.strictEqual(openedMoved.projectKey, movedIdentity.projectKey);
  assert.strictEqual(openedMoved.rebound, true);
  assert.strictEqual(openedMoved.appliedDecisionId, recorded.decision.decisionId);
  assert.deepStrictEqual(openedMoved.record.reboundFrom, [openedB.projectKey]);
  assert.strictEqual(fs.existsSync(openedB.stateRoot), false);
  assert.deepStrictEqual(snapshotTree(openedA.stateRoot), beforeA);
  assert.deepStrictEqual(snapshotTree(openedLive.stateRoot), beforeLive);
}

function runCheck6ExclusiveAndMalformedDecision(api: IdentityUnderTest, scratch: string): void {
  const originRepo = path.join(scratch, "origin");
  const cloneOrig = path.join(scratch, "clone-orig");
  const cloneMoved = path.join(scratch, "clone-moved");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneOrig]);
  const openedOrig = api.openProject(cloneOrig, stateBase);
  fs.renameSync(cloneOrig, cloneMoved);

  const first = api.recordIdentityDecision({
    cwd: cloneMoved,
    stateBase,
    choice: "rebind",
    oldProjectKey: openedOrig.projectKey,
    decidedBy: "first-user",
  });

  const movedIdentity = api.resolveProjectIdentity(cloneMoved);
  const expectedDecisionPath = path.join(
    stateBase,
    IDENTITY_DECISIONS_DIR,
    `${movedIdentity.projectKey}.json`,
  );
  assert.strictEqual(first.decisionPath, expectedDecisionPath);

  const parsedDecision = JSON.parse(fs.readFileSync(expectedDecisionPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepStrictEqual(Object.keys(parsedDecision).sort(), [
    "choice",
    "decidedBy",
    "decisionId",
    "newCanonicalCommonDir",
    "newProjectKey",
    "oldCanonicalCommonDir",
    "oldProjectKey",
    "originUrl",
    "rootCommitShas",
    "schemaVersion",
    "time",
  ]);
  assert.strictEqual(parsedDecision.schemaVersion, 1);
  assert.strictEqual(parsedDecision.choice, "rebind");
  assert.strictEqual(parsedDecision.oldProjectKey, openedOrig.projectKey);
  assert.strictEqual(parsedDecision.newProjectKey, movedIdentity.projectKey);
  assert.strictEqual(parsedDecision.oldCanonicalCommonDir, openedOrig.record.canonicalCommonDir);
  assert.strictEqual(parsedDecision.newCanonicalCommonDir, movedIdentity.canonicalCommonDir);
  assert.strictEqual(parsedDecision.decidedBy, "first-user");

  const firstSnapshot = snapshotFile(expectedDecisionPath);

  // Second write for the same new key must fail exclusively and leave the first file unchanged.
  expectIdentityError(
    () =>
      api.recordIdentityDecision({
        cwd: cloneMoved,
        stateBase,
        choice: "new_project",
        decidedBy: "second-user",
      }),
    "decision_exists",
    "second decision write for the same newProjectKey must fail exclusively",
  );
  const afterSecondAttempt = snapshotFile(expectedDecisionPath);
  assert.strictEqual(afterSecondAttempt.sha256, firstSnapshot.sha256);
  assert.strictEqual(afterSecondAttempt.bytes, firstSnapshot.bytes);

  // Malformed decisions must all refuse and never create the new project folder.
  const validDecisionObj = parsedDecision;
  const malformedPayloads: Array<{ label: string; raw: string }> = [
    { label: "broken JSON", raw: "{not valid json" },
    {
      label: "unknown schemaVersion",
      raw: JSON.stringify({ ...validDecisionObj, schemaVersion: 2 }),
    },
    {
      label: "unknown choice",
      raw: JSON.stringify({ ...validDecisionObj, choice: "auto_rebind" }),
    },
    {
      label: "missing decidedBy",
      raw: JSON.stringify({ ...validDecisionObj, decidedBy: undefined }),
    },
    {
      label: "extra unexpected field",
      raw: JSON.stringify({ ...validDecisionObj, extra: true }),
    },
    {
      label: "rebind with null oldProjectKey",
      raw: JSON.stringify({
        ...validDecisionObj,
        oldProjectKey: null,
        oldCanonicalCommonDir: null,
      }),
    },
    {
      label: "mismatched newProjectKey",
      raw: JSON.stringify({ ...validDecisionObj, newProjectKey: "ffffffffffffffff" }),
    },
    {
      label: "unsorted rootCommitShas",
      raw: JSON.stringify({
        ...validDecisionObj,
        rootCommitShas: [
          "ffffffffffffffffffffffffffffffffffffffff",
          "0000000000000000000000000000000000000000",
        ],
      }),
    },
    {
      label: "oversized decision file",
      raw: `${JSON.stringify({ ...validDecisionObj, decidedBy: "x".repeat(9000) })}\n`,
    },
  ];

  for (const [idx, item] of malformedPayloads.entries()) {
    const subState = path.join(scratch, `malformed-state-${idx}`);
    fs.cpSync(stateBase, subState, { recursive: true });
    const subDecisionPath = path.join(
      subState,
      IDENTITY_DECISIONS_DIR,
      `${movedIdentity.projectKey}.json`,
    );
    fs.writeFileSync(subDecisionPath, item.raw, "utf8");
    expectIdentityError(
      () => api.openProject(cloneMoved, subState),
      "invalid_decision",
      `malformed decision (${item.label}) must refuse`,
    );
    assert.strictEqual(
      fs.existsSync(path.join(subState, movedIdentity.projectKey)),
      false,
      `malformed decision (${item.label}) must create no project folder`,
    );
  }
}

function runCheck7NewProjectDecision(api: IdentityUnderTest, scratch: string): void {
  const originRepo = path.join(scratch, "origin");
  const cloneOrig = path.join(scratch, "clone-orig");
  const cloneMoved = path.join(scratch, "clone-moved");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneOrig]);

  const openedOrig = api.openProject(cloneOrig, stateBase);
  seedStateFiles(openedOrig.stateRoot);
  const beforeOrigTree = snapshotTree(openedOrig.stateRoot);

  fs.renameSync(cloneOrig, cloneMoved);

  const recorded = api.recordIdentityDecision({
    cwd: cloneMoved,
    stateBase,
    choice: "new_project",
    decidedBy: "user-new",
  });
  assert.strictEqual(recorded.decision.choice, "new_project");

  const openedFresh = api.openProject(cloneMoved, stateBase);
  assert.strictEqual(openedFresh.created, true);
  assert.strictEqual(openedFresh.rebound, false);
  assert.strictEqual(openedFresh.appliedDecisionId, recorded.decision.decisionId);
  assert.strictEqual(openedFresh.record.reboundFrom, undefined);
  assert.notStrictEqual(openedFresh.projectKey, openedOrig.projectKey);

  const freshDisk = JSON.parse(
    fs.readFileSync(path.join(openedFresh.stateRoot, PROJECT_RECORD_FILENAME), "utf8"),
  ) as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(freshDisk).sort(), [
    "canonicalCommonDir",
    "commonDirSha256",
    "originUrl",
    "rootCommitShas",
    "schemaVersion",
    "slug",
  ]);

  // Every byte and inode under the old folder must be completely unchanged.
  assert.deepStrictEqual(
    snapshotTree(openedOrig.stateRoot),
    beforeOrigTree,
    "new_project must leave every byte under the old folder unchanged",
  );

  // Reopening the new project succeeds cleanly without touching the old folder.
  const reopened = api.openProject(cloneMoved, stateBase);
  assert.strictEqual(reopened.created, false);
  assert.strictEqual(reopened.rebound, false);
  assert.deepStrictEqual(snapshotTree(openedOrig.stateRoot), beforeOrigTree);

  // Also test new_project explicitly naming a candidate oldProjectKey.
  const namedStateBase = path.join(scratch, "state-named-new");
  const cloneNamedOrig = path.join(scratch, "clone-named-orig");
  const cloneNamedMoved = path.join(scratch, "clone-named-moved");
  runGit(["clone", originRepo, cloneNamedOrig]);
  const openedNamedOrig = api.openProject(cloneNamedOrig, namedStateBase);
  seedStateFiles(openedNamedOrig.stateRoot);
  const beforeNamedOrig = snapshotTree(openedNamedOrig.stateRoot);
  fs.renameSync(cloneNamedOrig, cloneNamedMoved);

  const recordedNamed = api.recordIdentityDecision({
    cwd: cloneNamedMoved,
    stateBase: namedStateBase,
    choice: "new_project",
    oldProjectKey: openedNamedOrig.projectKey,
    decidedBy: "user-new-named",
  });
  assert.strictEqual(recordedNamed.decision.oldProjectKey, openedNamedOrig.projectKey);
  assert.strictEqual(
    recordedNamed.decision.oldCanonicalCommonDir,
    openedNamedOrig.record.canonicalCommonDir,
  );
  const openedNamedFresh = api.openProject(cloneNamedMoved, namedStateBase);
  assert.strictEqual(openedNamedFresh.created, true);
  assert.strictEqual(openedNamedFresh.record.reboundFrom, undefined);
  assert.deepStrictEqual(snapshotTree(openedNamedOrig.stateRoot), beforeNamedOrig);
}

async function runCheck8RebindAndDestinationExists(
  api: IdentityUnderTest,
  scratch: string,
): Promise<void> {
  const originRepo = path.join(scratch, "origin");
  const cloneOrig = path.join(scratch, "clone-orig");
  const cloneMoved = path.join(scratch, "clone-moved");
  const cloneMovedAgain = path.join(scratch, "clone-moved-again");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneOrig]);

  const openedOrig = api.openProject(cloneOrig, stateBase);
  seedStateFiles(openedOrig.stateRoot);

  const nonProjectBefore = snapshotTree(openedOrig.stateRoot, new Set([PROJECT_RECORD_FILENAME]));
  const lockPathOld = path.join(openedOrig.stateRoot, "owner.lock");

  // Hold an active flock across the rebind to verify Build notes 5 (rebind takes no lease and preserves the lock).
  const holder = await spawnFlockHolder(lockPathOld);
  try {
    fs.renameSync(cloneOrig, cloneMoved);

    const recorded = api.recordIdentityDecision({
      cwd: cloneMoved,
      stateBase,
      choice: "rebind",
      oldProjectKey: openedOrig.projectKey,
      decidedBy: "user-rebind",
    });

    const rebound = api.openProject(cloneMoved, stateBase);
    assert.strictEqual(rebound.rebound, true);
    assert.strictEqual(rebound.created, false);
    assert.strictEqual(rebound.appliedDecisionId, recorded.decision.decisionId);
    assert.strictEqual(
      fs.existsSync(openedOrig.stateRoot),
      false,
      "old project folder must be gone after rebind",
    );

    const nonProjectAfter = snapshotTree(rebound.stateRoot, new Set([PROJECT_RECORD_FILENAME]));
    assert.deepStrictEqual(
      nonProjectAfter,
      nonProjectBefore,
      "rebind must rename in one step, preserving bytes and inodes of all files inside the folder",
    );

    const expectedCommonDir = fs.realpathSync(path.join(cloneMoved, ".git"));
    assert.strictEqual(rebound.record.canonicalCommonDir, expectedCommonDir);
    assert.strictEqual(rebound.record.commonDirSha256, sha256Hex(expectedCommonDir));
    assert.strictEqual(rebound.record.slug, "clone-moved");
    assert.deepStrictEqual(rebound.record.reboundFrom, [openedOrig.projectKey]);

    // Existing flock holder still holds the lock at the renamed path.
    const lockPathNew = path.join(rebound.stateRoot, "owner.lock");
    const probeLock = spawnSync(
      "flock",
      ["--exclusive", "--nonblocking", "--no-fork", "--conflict-exit-code", "200", lockPathNew, "true"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.strictEqual(
      probeLock.status,
      200,
      `expected existing flock holder to keep lock across rebind rename (got status=${probeLock.status})`,
    );

    // Creating a fresh clone later at the original path does not break reopening the completed rebind.
    runGit(["clone", originRepo, cloneOrig]);
    const freshAtOldPath = api.openProject(cloneOrig, stateBase);
    assert.strictEqual(freshAtOldPath.projectKey, openedOrig.projectKey);
    assert.strictEqual(freshAtOldPath.created, true);
    const reopenFirstRebind = api.openProject(cloneMoved, stateBase);
    assert.strictEqual(reopenFirstRebind.projectKey, rebound.projectKey);
    assert.strictEqual(reopenFirstRebind.rebound, false);

    // Second rebind accumulates reboundFrom history without rewriting nested files.
    fs.renameSync(cloneMoved, cloneMovedAgain);
    api.recordIdentityDecision({
      cwd: cloneMovedAgain,
      stateBase,
      choice: "rebind",
      oldProjectKey: rebound.projectKey,
      decidedBy: "user-rebind-2",
    });
    const rebound2 = api.openProject(cloneMovedAgain, stateBase);
    assert.deepStrictEqual(rebound2.record.reboundFrom, [openedOrig.projectKey, rebound.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(rebound2.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      nonProjectBefore,
    );
  } finally {
    await holder.release();
  }

  // Destination already exists: refuse for both empty directory and populated project directory.
  for (const destKind of ["empty-dir", "populated-dir"] as const) {
    const destStateBase = path.join(scratch, `state-dest-${destKind}`);
    const srcRepo = path.join(scratch, `src-${destKind}`);
    const dstRepo = path.join(scratch, `dst-${destKind}`);
    runGit(["clone", originRepo, srcRepo]);

    const openedSrc = api.openProject(srcRepo, destStateBase);
    seedStateFiles(openedSrc.stateRoot);
    fs.renameSync(srcRepo, dstRepo);

    const dstIdentity = api.resolveProjectIdentity(dstRepo);
    const dstStateRoot = path.join(destStateBase, dstIdentity.projectKey);

    // First test recordIdentityDecision refusing when destination already exists.
    fs.mkdirSync(dstStateRoot, { recursive: true });
    if (destKind === "populated-dir") {
      fs.writeFileSync(
        path.join(dstStateRoot, PROJECT_RECORD_FILENAME),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            slug: path.basename(dstRepo),
            canonicalCommonDir: dstIdentity.canonicalCommonDir,
            commonDirSha256: dstIdentity.commonDirSha256,
            originUrl: dstIdentity.originUrl,
            rootCommitShas: [...dstIdentity.rootCommitShas],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }

    const beforeSrc = snapshotTree(openedSrc.stateRoot);
    const beforeDst = snapshotTree(dstStateRoot);

    expectIdentityError(
      () =>
        api.recordIdentityDecision({
          cwd: dstRepo,
          stateBase: destStateBase,
          choice: "rebind",
          oldProjectKey: openedSrc.projectKey,
          decidedBy: "user-dest-exists",
        }),
      "rebind_destination_exists",
      `recordIdentityDecision must refuse when destination (${destKind}) already exists`,
    );

    // Now place a valid rebind decision on disk and verify openProject ALSO refuses without overwriting.
    const decisionsDir = path.join(destStateBase, IDENTITY_DECISIONS_DIR);
    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(decisionsDir, `${dstIdentity.projectKey}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          decisionId: `pre-existing-${destKind}`,
          choice: "rebind",
          oldProjectKey: openedSrc.projectKey,
          newProjectKey: dstIdentity.projectKey,
          oldCanonicalCommonDir: openedSrc.record.canonicalCommonDir,
          newCanonicalCommonDir: dstIdentity.canonicalCommonDir,
          rootCommitShas: [...dstIdentity.rootCommitShas],
          originUrl: dstIdentity.originUrl,
          decidedBy: "user-dest-exists",
          time: "2026-11-27T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expectIdentityError(
      () => api.openProject(dstRepo, destStateBase),
      "rebind_destination_exists",
      `openProject must refuse rebind when destination (${destKind}) already exists`,
    );
    assert.strictEqual(fs.existsSync(openedSrc.stateRoot), true);
    assert.deepStrictEqual(snapshotTree(openedSrc.stateRoot), beforeSrc);
    assert.deepStrictEqual(snapshotTree(dstStateRoot), beforeDst);
  }
}

async function runCheck9SigkillBetweenRenameAndRewrite(
  recoverOpen: (cwd: string, stateBase: string) => OpenProjectResult,
  scratch: string,
): Promise<void> {
  const originRepo = path.join(scratch, "origin");
  const cloneOrig = path.join(scratch, "clone-orig");
  const cloneMoved = path.join(scratch, "clone-moved");
  const stateBase = path.join(scratch, "state");

  initRepoWithCommit(originRepo);
  runGit(["clone", originRepo, cloneOrig]);

  const openedOrig = openProject(cloneOrig, stateBase);
  seedStateFiles(openedOrig.stateRoot);
  const nonProjectBefore = snapshotTree(openedOrig.stateRoot, new Set([PROJECT_RECORD_FILENAME]));

  fs.renameSync(cloneOrig, cloneMoved);
  const movedIdentity = resolveProjectIdentity(cloneMoved);
  const newStateRoot = path.join(stateBase, movedIdentity.projectKey);

  const recorded = recordIdentityDecision({
    cwd: cloneMoved,
    stateBase,
    choice: "rebind",
    oldProjectKey: openedOrig.projectKey,
    decidedBy: "user-crash-test",
  });

  // Child process executes the real rename step and pauses synchronously right before opening
  // the temp file for the project.json rewrite so the parent can kill it with real SIGKILL.
  const childScript = `
    import fs from "node:fs";
    import path from "node:path";
    import { openProject } from ${JSON.stringify(IDENTITY_MODULE_URL)};

    const [cwd, stateBase, expectedNewStateRoot] = process.argv.slice(1);
    let renamed = false;

    openProject(cwd, stateBase, {
      fs: {
        renameSync(oldPath, newPath) {
          fs.renameSync(oldPath, newPath);
          if (String(newPath) === expectedNewStateRoot) {
            renamed = true;
          }
        },
        openSync(targetPath, flags, mode) {
          const target = String(targetPath);
          if (
            renamed &&
            path.dirname(target) === expectedNewStateRoot &&
            path.basename(target).startsWith(".project.json.tmp.")
          ) {
            fs.writeSync(
              1,
              JSON.stringify({ event: "paused_between_rename_and_rewrite", pid: process.pid }) + "\\n",
            );
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          return fs.openSync(targetPath, flags, mode);
        },
      },
    });
  `;

  const child = spawn(
    process.execPath,
    ["-e", childScript, cloneMoved, stateBase, newStateRoot],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ok(child.pid !== undefined, "crash-test child did not report a pid");
  const childProc = trackProcess(child.pid);

  const childExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    let stderrBuf = "";
    const pausedEvent = await new Promise<{ event: string; pid: number }>((resolve, reject) => {
      let stdoutBuf = "";
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for child pause event (stderr=${stderrBuf})`));
      }, 5000);
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        const nl = stdoutBuf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(stdoutBuf.slice(0, nl)) as { event: string; pid: number });
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Child exited before pausing between rename and rewrite (code=${code}, signal=${signal}, stderr=${stderrBuf})`,
          ),
        );
      });
    });

    assert.strictEqual(pausedEvent.event, "paused_between_rename_and_rewrite");
    assert.strictEqual(pausedEvent.pid, child.pid);

    // Verify exact mid-rebind on-disk state BEFORE killing child.
    assert.strictEqual(fs.existsSync(openedOrig.stateRoot), false, "old folder must already be renamed");
    assert.strictEqual(fs.existsSync(newStateRoot), true, "new folder must exist after rename");
    const midCrashRecord = JSON.parse(
      fs.readFileSync(path.join(newStateRoot, PROJECT_RECORD_FILENAME), "utf8"),
    ) as ProjectRecord;
    assert.strictEqual(
      midCrashRecord.canonicalCommonDir,
      openedOrig.record.canonicalCommonDir,
      "project.json must still hold the old path before rewrite",
    );
    assert.strictEqual(midCrashRecord.reboundFrom, undefined);

    // Kill child with real SIGKILL and confirm death.
    process.kill(child.pid, "SIGKILL");
    const exitInfo = await childExited;
    assert.strictEqual(exitInfo.signal, "SIGKILL");
    await ensureProcessDead(childProc);
  } finally {
    await ensureProcessDead(childProc);
  }

  // Fresh process reads the mid-rebind state and completes the rewrite.
  const recovered = recoverOpen(cloneMoved, stateBase);
  assert.strictEqual(recovered.projectKey, movedIdentity.projectKey);
  assert.strictEqual(
    recovered.rebound,
    true,
    "fresh open after SIGKILL between rename and rewrite must complete the rebind",
  );
  assert.strictEqual(recovered.created, false);
  assert.strictEqual(recovered.appliedDecisionId, recorded.decision.decisionId);
  assert.strictEqual(
    recovered.record.canonicalCommonDir,
    movedIdentity.canonicalCommonDir,
    "recovered project.json must hold the new canonicalCommonDir",
  );
  assert.strictEqual(recovered.record.commonDirSha256, movedIdentity.commonDirSha256);
  assert.deepStrictEqual(recovered.record.reboundFrom, [openedOrig.projectKey]);
  assert.deepStrictEqual(
    snapshotTree(newStateRoot, new Set([PROJECT_RECORD_FILENAME])),
    nonProjectBefore,
    "crash recovery must preserve all nested files byte for byte and inode for inode",
  );
  const leftoverTmp = fs
    .readdirSync(newStateRoot)
    .filter((name) => name.startsWith(".project.json.tmp."));
  assert.deepStrictEqual(leftoverTmp, [], "no temporary project.json file may remain after recovery");

  // Snapshot the completed state, then run another fresh process: nothing changes.
  const completedTreeBefore = snapshotTree(newStateRoot);
  const secondOpen = recoverOpen(cloneMoved, stateBase);
  assert.strictEqual(secondOpen.rebound, false);
  assert.strictEqual(secondOpen.created, false);
  assert.strictEqual(secondOpen.appliedDecisionId, null);
  assert.deepStrictEqual(secondOpen.record, recovered.record);
  assert.deepStrictEqual(
    snapshotTree(newStateRoot),
    completedTreeBefore,
    "reopening from the completed rebind state must change nothing on disk",
  );
}

function runCheck10OriginDrift(api: IdentityUnderTest, scratch: string): void {
  const stateBase = path.join(scratch, "state");

  const repo = path.join(scratch, "drift-repo");
  const urlOne = "https://example.invalid/org/one.git";
  const urlTwo = "https://example.invalid/org/two.git";
  initRepoWithCommit(repo, { originUrl: urlOne });

  const initial = api.openProject(repo, stateBase);
  assert.strictEqual(initial.originDrift, null);
  const projectJsonPath = path.join(initial.stateRoot, PROJECT_RECORD_FILENAME);
  const initialDisk = snapshotFile(projectJsonPath);

  // Change origin URL -> succeeds and reports drift; stored project.json is unchanged.
  runGit(["remote", "set-url", "origin", urlTwo], repo);
  const drifted = api.openProject(repo, stateBase);
  assert.strictEqual(drifted.projectKey, initial.projectKey);
  assert.strictEqual(drifted.created, false);
  assert.deepStrictEqual(drifted.originDrift, { stored: urlOne, live: urlTwo });
  assert.strictEqual(drifted.record.originUrl, urlOne);
  assert.deepStrictEqual(snapshotFile(projectJsonPath), initialDisk);

  // Remove origin URL -> succeeds and reports drift to null.
  runGit(["remote", "remove", "origin"], repo);
  const removed = api.openProject(repo, stateBase);
  assert.deepStrictEqual(removed.originDrift, { stored: urlOne, live: null });
  assert.strictEqual(removed.record.originUrl, urlOne);
  assert.deepStrictEqual(snapshotFile(projectJsonPath), initialDisk);

  // Restore original URL -> drift clears.
  runGit(["remote", "add", "origin", urlOne], repo);
  const restored = api.openProject(repo, stateBase);
  assert.strictEqual(restored.originDrift, null);

  // Repo opened with null origin, then origin added -> reports drift from null to URL.
  const noOriginRepo = path.join(scratch, "no-origin-drift");
  initRepoWithCommit(noOriginRepo);
  const initialNull = api.openProject(noOriginRepo, stateBase);
  assert.strictEqual(initialNull.originDrift, null);
  assert.strictEqual(initialNull.record.originUrl, null);

  const addedUrl = "https://example.invalid/org/added.git";
  runGit(["remote", "add", "origin", addedUrl], noOriginRepo);
  const addedDrift = api.openProject(noOriginRepo, stateBase);
  assert.deepStrictEqual(addedDrift.originDrift, { stored: null, live: addedUrl });
  assert.strictEqual(addedDrift.record.originUrl, null);
}

// ---------------------------------------------------------------------------
// Primary checks (1 through 10)
// ---------------------------------------------------------------------------

describe("project identity (S1b)", () => {
  test("check 1: linked worktrees and symlinks share projectKey; separate clones and same-basename repos differ; non-git fails closed", () => {
    const scratch = createScratchDir("check1");
    runCheck1WorktreesClonesAndNonGit(REAL_IDENTITY, scratch);
  });

  test("check 2: project.json has exact schema v1 fields, sorted rootCommitShas, and refuses >= 2048 UTF-8 bytes with nothing written", () => {
    const scratch = createScratchDir("check2");
    runCheck2ProjectRecordAndSizeLimit(REAL_IDENTITY, scratch);
  });

  test("check 3: stored canonicalCommonDir mismatch refuses with identity_mismatch and rebinds nothing", () => {
    const scratch = createScratchDir("check3");
    runCheck3MismatchRefusal(REAL_IDENTITY, scratch);
  });

  test("check 4: moved clone refuses with identity_relocated listing the candidate and creates no folder; live copy opens separately", () => {
    const scratch = createScratchDir("check4");
    runCheck4RelocationAndLiveCopy(REAL_IDENTITY, scratch);
  });

  test("check 5: two relocation candidates list both; decision naming one works; decision naming non-candidate refuses", () => {
    const scratch = createScratchDir("check5");
    runCheck5TwoCandidatesAndNonCandidateRefusal(REAL_IDENTITY, scratch);
  });

  test("check 6: decision file is created exclusively and malformed decisions refuse", () => {
    const scratch = createScratchDir("check6");
    runCheck6ExclusiveAndMalformedDecision(REAL_IDENTITY, scratch);
  });

  test("check 7: new_project decision opens a fresh project and leaves every byte under the old folder unchanged", () => {
    const scratch = createScratchDir("check7");
    runCheck7NewProjectDecision(REAL_IDENTITY, scratch);
  });

  test("check 8: rebind renames in one step preserving bytes, inodes, and active flock; updates project.json with reboundFrom; refuses existing destination", async () => {
    const scratch = createScratchDir("check8");
    await runCheck8RebindAndDestinationExists(REAL_IDENTITY, scratch);
  });

  test("check 9: child killed with SIGKILL between rename and rewrite completes on next open and stays unchanged on repeat open", async () => {
    const scratch = createScratchDir("check9");
    await runCheck9SigkillBetweenRenameAndRewrite(runFreshOpenSubprocess, scratch);
  });

  test("check 10: origin URL drift succeeds, reports stored and live URLs, and blocks nothing", () => {
    const scratch = createScratchDir("check10");
    runCheck10OriginDrift(REAL_IDENTITY, scratch);
  });
});

// ---------------------------------------------------------------------------
// Negative controls (check 11: broken adapters prove checks 1 to 9 catch rule breaks)
// ---------------------------------------------------------------------------

describe("negative controls (broken adapters fail on intended assertions)", () => {
  test("control 1: fails check 1 when projectKey uses --git-dir instead of --git-common-dir", async () => {
    const scratch = createScratchDir("ctrl1");
    const brokenGitDirApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      resolveProjectIdentity(cwd) {
        const real = resolveProjectIdentity(cwd);
        const realCwd = fs.realpathSync(cwd);
        const rawGitDir = runGit(["rev-parse", "--git-dir"], realCwd);
        const canonicalGitDir = fs.realpathSync(path.resolve(realCwd, rawGitDir));
        const sha = sha256Hex(canonicalGitDir);
        return {
          ...real,
          canonicalCommonDir: canonicalGitDir,
          commonDirSha256: sha,
          projectKey: sha.slice(0, 16),
        };
      },
    };
    await expectCheckFailure(
      () => runCheck1WorktreesClonesAndNonGit(brokenGitDirApi, scratch),
      /linked worktree wt-alpha must share projectKey/,
      "control 1",
    );
  });

  test("control 2: fails check 2 when >= 2048-byte project.json is allowed instead of refused", async () => {
    const scratch = createScratchDir("ctrl2");
    const brokenSizeApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      openProject(cwd, stateBase, options) {
        try {
          return openProject(cwd, stateBase, options);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "project_record_too_large") {
            const live = resolveProjectIdentity(cwd, options);
            const stateRoot = path.join(path.resolve(stateBase), live.projectKey);
            const record: ProjectRecord = {
              schemaVersion: 1,
              slug: live.slug,
              canonicalCommonDir: live.canonicalCommonDir,
              commonDirSha256: live.commonDirSha256,
              originUrl: live.originUrl,
              rootCommitShas: [...live.rootCommitShas],
            };
            fs.mkdirSync(stateRoot, { recursive: true });
            fs.writeFileSync(
              path.join(stateRoot, PROJECT_RECORD_FILENAME),
              `${JSON.stringify(record, null, 2)}\n`,
              "utf8",
            );
            return {
              projectKey: live.projectKey,
              stateRoot,
              record,
              originDrift: null,
              created: true,
              rebound: false,
              appliedDecisionId: null,
            };
          }
          throw err;
        }
      },
    };
    await expectCheckFailure(
      () => runCheck2ProjectRecordAndSizeLimit(brokenSizeApi, scratch),
      /2048-byte project\.json must be refused/,
      "control 2",
    );
  });

  test("control 3: fails check 3 when canonicalCommonDir mismatch is silently ignored", async () => {
    const scratch = createScratchDir("ctrl3");
    const brokenMismatchApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      openProject(cwd, stateBase, options) {
        try {
          return openProject(cwd, stateBase, options);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "identity_mismatch") {
            const live = resolveProjectIdentity(cwd, options);
            const stateRoot = path.join(path.resolve(stateBase), live.projectKey);
            const record = JSON.parse(
              fs.readFileSync(path.join(stateRoot, PROJECT_RECORD_FILENAME), "utf8"),
            ) as ProjectRecord;
            return {
              projectKey: live.projectKey,
              stateRoot,
              record,
              originDrift: null,
              created: false,
              rebound: false,
              appliedDecisionId: null,
            };
          }
          throw err;
        }
      },
    };
    await expectCheckFailure(
      () => runCheck3MismatchRefusal(brokenMismatchApi, scratch),
      /stored canonicalCommonDir mismatch must refuse with identity_mismatch/,
      "control 3",
    );
  });

  test("control 4: fails check 4 when a moved clone silently opens a new project instead of refusing", async () => {
    const scratch = createScratchDir("ctrl4");
    const brokenRelocationApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      openProject(cwd, stateBase, options) {
        try {
          return openProject(cwd, stateBase, options);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "identity_relocated") {
            const live = resolveProjectIdentity(cwd, options);
            const stateRoot = path.join(path.resolve(stateBase), live.projectKey);
            const record: ProjectRecord = {
              schemaVersion: 1,
              slug: live.slug,
              canonicalCommonDir: live.canonicalCommonDir,
              commonDirSha256: live.commonDirSha256,
              originUrl: live.originUrl,
              rootCommitShas: [...live.rootCommitShas],
            };
            fs.mkdirSync(stateRoot, { recursive: true });
            fs.writeFileSync(
              path.join(stateRoot, PROJECT_RECORD_FILENAME),
              `${JSON.stringify(record, null, 2)}\n`,
              "utf8",
            );
            return {
              projectKey: live.projectKey,
              stateRoot,
              record,
              originDrift: null,
              created: true,
              rebound: false,
              appliedDecisionId: null,
            };
          }
          throw err;
        }
      },
    };
    await expectCheckFailure(
      () => runCheck4RelocationAndLiveCopy(brokenRelocationApi, scratch),
      /moved clone must refuse with identity_relocated/,
      "control 4",
    );
  });

  test("control 5: fails check 5 when recordIdentityDecision accepts a key that is not a candidate", async () => {
    const scratch = createScratchDir("ctrl5");
    const brokenCandidateApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      recordIdentityDecision(input, options) {
        try {
          return recordIdentityDecision(input, options);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "decision_candidate_not_found") {
            const live = resolveProjectIdentity(input.cwd, options);
            const decisionsDir = path.join(path.resolve(input.stateBase), IDENTITY_DECISIONS_DIR);
            fs.mkdirSync(decisionsDir, { recursive: true });
            const decisionPath = path.join(decisionsDir, `${live.projectKey}.json`);
            const decision = {
              schemaVersion: 1 as const,
              decisionId: "broken-accept",
              choice: input.choice,
              oldProjectKey: input.oldProjectKey ?? null,
              newProjectKey: live.projectKey,
              oldCanonicalCommonDir: "/fake/non-candidate/.git",
              newCanonicalCommonDir: live.canonicalCommonDir,
              rootCommitShas: [...live.rootCommitShas],
              originUrl: live.originUrl,
              decidedBy: input.decidedBy,
              time: new Date().toISOString(),
            };
            fs.writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
            return { decisionPath, decision };
          }
          throw err;
        }
      },
    };
    await expectCheckFailure(
      () => runCheck5TwoCandidatesAndNonCandidateRefusal(brokenCandidateApi, scratch),
      /rebind decision naming nonexistent key must refuse/,
      "control 5",
    );
  });

  test("control 6: fails check 6 when a second decision write overwrites the existing decision file", async () => {
    const scratch = createScratchDir("ctrl6");
    const brokenOverwriteDecisionApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      recordIdentityDecision(input, options) {
        try {
          return recordIdentityDecision(input, options);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "decision_exists") {
            const live = resolveProjectIdentity(input.cwd, options);
            const decisionPath = path.join(
              path.resolve(input.stateBase),
              IDENTITY_DECISIONS_DIR,
              `${live.projectKey}.json`,
            );
            const decision = {
              schemaVersion: 1 as const,
              decisionId: "overwritten",
              choice: input.choice,
              oldProjectKey: null,
              newProjectKey: live.projectKey,
              oldCanonicalCommonDir: null,
              newCanonicalCommonDir: live.canonicalCommonDir,
              rootCommitShas: [...live.rootCommitShas],
              originUrl: live.originUrl,
              decidedBy: input.decidedBy,
              time: new Date().toISOString(),
            };
            fs.writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
            return { decisionPath, decision };
          }
          throw err;
        }
      },
    };
    await expectCheckFailure(
      () => runCheck6ExclusiveAndMalformedDecision(brokenOverwriteDecisionApi, scratch),
      /second decision write for the same newProjectKey must fail exclusively/,
      "control 6",
    );
  });

  test("control 7: fails check 7 when new_project mutates files inside the old project folder", async () => {
    const scratch = createScratchDir("ctrl7");
    const brokenNewProjectApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      openProject(cwd, stateBase, options) {
        const result = openProject(cwd, stateBase, options);
        if (result.created && result.appliedDecisionId !== null) {
          for (const entry of fs.readdirSync(stateBase, { withFileTypes: true })) {
            if (entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name) && entry.name !== result.projectKey) {
              fs.writeFileSync(path.join(stateBase, entry.name, "owner.json"), '{"tampered":true}\n', "utf8");
            }
          }
        }
        return result;
      },
    };
    await expectCheckFailure(
      () => runCheck7NewProjectDecision(brokenNewProjectApi, scratch),
      /new_project must leave every byte under the old folder unchanged/,
      "control 7",
    );
  });

  test("control 8: fails check 8 when rebind copies and deletes instead of renaming in one step", async () => {
    const scratch = createScratchDir("ctrl8");
    const brokenCopyDeleteRebindApi: IdentityUnderTest = {
      ...REAL_IDENTITY,
      openProject(cwd, stateBase, options) {
        const result = openProject(cwd, stateBase, options);
        if (result.rebound) {
          // Simulate copy-and-delete: copy folder to temp, delete original, move copy back (new inodes!).
          const copyTmp = `${result.stateRoot}.copy-tmp`;
          fs.cpSync(result.stateRoot, copyTmp, { recursive: true });
          fs.rmSync(result.stateRoot, { recursive: true, force: true });
          fs.renameSync(copyTmp, result.stateRoot);
        }
        return result;
      },
    };
    await expectCheckFailure(
      () => runCheck8RebindAndDestinationExists(brokenCopyDeleteRebindApi, scratch),
      /rebind must rename in one step, preserving bytes and inodes/,
      "control 8",
    );
  });

  test("control 9: fails check 9 when crash recovery skips rewriting project.json or rewrites again on repeat open", async () => {
    const scratchSkip = createScratchDir("ctrl9-skip");
    const brokenSkipRecovery = (cwd: string, stateBase: string): OpenProjectResult => {
      const live = resolveProjectIdentity(cwd);
      const stateRoot = path.join(path.resolve(stateBase), live.projectKey);
      const stored = JSON.parse(
        fs.readFileSync(path.join(stateRoot, PROJECT_RECORD_FILENAME), "utf8"),
      ) as ProjectRecord;
      if (stored.canonicalCommonDir !== live.canonicalCommonDir) {
        return {
          projectKey: live.projectKey,
          stateRoot,
          record: stored,
          originDrift: null,
          created: false,
          rebound: false,
          appliedDecisionId: null,
        };
      }
      return openProject(cwd, stateBase);
    };
    await expectCheckFailure(
      () => runCheck9SigkillBetweenRenameAndRewrite(brokenSkipRecovery, scratchSkip),
      /fresh open after SIGKILL between rename and rewrite must complete the rebind/,
      "control 9 (skip rewrite)",
    );

    const scratchRepeat = createScratchDir("ctrl9-repeat");
    let callCount = 0;
    const brokenRepeatRewrite = (cwd: string, stateBase: string): OpenProjectResult => {
      callCount += 1;
      const result = runFreshOpenSubprocess(cwd, stateBase);
      if (callCount === 2) {
        const projectJsonPath = path.join(result.stateRoot, PROJECT_RECORD_FILENAME);
        const tmpPath = `${projectJsonPath}.broken-rewrite`;
        fs.writeFileSync(tmpPath, fs.readFileSync(projectJsonPath));
        fs.renameSync(tmpPath, projectJsonPath);
      }
      return result;
    };
    await expectCheckFailure(
      () => runCheck9SigkillBetweenRenameAndRewrite(brokenRepeatRewrite, scratchRepeat),
      /reopening from the completed rebind state must change nothing on disk/,
      "control 9 (repeat rewrite)",
    );
  });
});
