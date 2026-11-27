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
  MAX_DECISION_RECORD_BYTES,
  MAX_PROJECT_RECORD_BYTES,
  PROJECT_RECORD_FILENAME,
  openProject,
  recordIdentityDecision,
  resolveProjectIdentity,
  type IdentityDecision,
  type IdentityOperationOptions,
  type LiveProjectIdentity,
  type OpenProjectResult,
  type ProjectRecord,
  type RecordIdentityDecisionInput,
  type RecordIdentityDecisionResult,
} from "../src/identity.ts";

interface IdentityUnderTest {
  readonly resolveProjectIdentity: (cwd: string) => LiveProjectIdentity;
  readonly openProject: (
    cwd: string,
    stateBase: string,
    options?: IdentityOperationOptions,
  ) => OpenProjectResult;
  readonly recordIdentityDecision: (
    input: RecordIdentityDecisionInput,
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
  const craftedDecisionPath = path.join(craftedDecisionsDir, `${movedIdentity.projectKey}.json`);
  fs.writeFileSync(
    craftedDecisionPath,
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
  const nonCandErr = expectIdentityError(
    () => api.openProject(cloneMoved, nonCandState),
    "decision_mismatch",
    "openProject must refuse an on-disk decision naming a non-candidate",
  );
  assert.ok(
    nonCandErr.message.includes(craftedDecisionPath),
    "decision_mismatch error must name the decision file",
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

async function interruptRebindWithSigkill(
  cloneMoved: string,
  stateBase: string,
  oldStateRoot: string,
  newStateRoot: string,
  expectedOldCanonicalCommonDir: string,
): Promise<void> {
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
    assert.strictEqual(fs.existsSync(oldStateRoot), false, "old folder must already be renamed");
    assert.strictEqual(fs.existsSync(newStateRoot), true, "new folder must exist after rename");
    const midCrashRecord = JSON.parse(
      fs.readFileSync(path.join(newStateRoot, PROJECT_RECORD_FILENAME), "utf8"),
    ) as ProjectRecord;
    assert.strictEqual(
      midCrashRecord.canonicalCommonDir,
      expectedOldCanonicalCommonDir,
      "project.json must still hold the old path before rewrite",
    );

    // Kill child with real SIGKILL and confirm death.
    process.kill(child.pid, "SIGKILL");
    const exitInfo = await childExited;
    assert.strictEqual(exitInfo.signal, "SIGKILL");
    await ensureProcessDead(childProc);
  } finally {
    await ensureProcessDead(childProc);
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

  await interruptRebindWithSigkill(
    cloneMoved,
    stateBase,
    openedOrig.stateRoot,
    newStateRoot,
    openedOrig.record.canonicalCommonDir,
  );
  const midCrashRecord = JSON.parse(
    fs.readFileSync(path.join(newStateRoot, PROJECT_RECORD_FILENAME), "utf8"),
  ) as ProjectRecord;
  assert.strictEqual(midCrashRecord.reboundFrom, undefined);

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

  test("fix-1 R1: round trip A -> B -> A -> B maintains reboundFrom per Build note 13 and reuses the existing decision", async () => {
    const scratch = createScratchDir("fix1-r1");
    const originRepo = path.join(scratch, "origin");
    const locA = path.join(scratch, "loc-a");
    const locB = path.join(scratch, "loc-b");
    const stateBase = path.join(scratch, "state");

    initRepoWithCommit(originRepo);
    runGit(["clone", originRepo, locA]);

    const openA = openProject(locA, stateBase);
    seedStateFiles(openA.stateRoot);
    const nonProjectBefore = snapshotTree(openA.stateRoot, new Set([PROJECT_RECORD_FILENAME]));

    // A -> B
    fs.renameSync(locA, locB);
    const decAB = recordIdentityDecision({
      cwd: locB,
      stateBase,
      choice: "rebind",
      oldProjectKey: openA.projectKey,
      decidedBy: "user-r1",
    });
    const decABSnapshot = snapshotFile(decAB.decisionPath);
    const openB1 = openProject(locB, stateBase);
    assert.strictEqual(openB1.rebound, true);
    assert.strictEqual(openB1.appliedDecisionId, decAB.decision.decisionId);
    assert.deepStrictEqual(openB1.record.reboundFrom, [openA.projectKey]);

    // B -> A
    fs.renameSync(locB, locA);
    const decBA = recordIdentityDecision({
      cwd: locA,
      stateBase,
      choice: "rebind",
      oldProjectKey: openB1.projectKey,
      decidedBy: "user-r1",
    });
    const openA2 = openProject(locA, stateBase);
    assert.strictEqual(openA2.projectKey, openA.projectKey);
    assert.strictEqual(openA2.rebound, true);
    assert.strictEqual(openA2.appliedDecisionId, decBA.decision.decisionId);
    assert.deepStrictEqual(openA2.record.reboundFrom, [openB1.projectKey]);

    // Reopen at A must succeed (project.json must pass reader validation).
    const reopenA = openProject(locA, stateBase);
    assert.strictEqual(reopenA.projectKey, openA.projectKey);
    assert.strictEqual(reopenA.created, false);
    assert.strictEqual(reopenA.rebound, false);
    assert.deepStrictEqual(reopenA.record.reboundFrom, [openB1.projectKey]);

    // A -> B again: reuses first decision with no new decision file written.
    const decisionsDir = path.join(stateBase, IDENTITY_DECISIONS_DIR);
    const decisionsBeforeSecondMove = snapshotTree(decisionsDir);
    fs.renameSync(locA, locB);
    const openB2 = openProject(locB, stateBase);
    assert.strictEqual(openB2.projectKey, openB1.projectKey);
    assert.strictEqual(openB2.rebound, true);
    assert.strictEqual(openB2.appliedDecisionId, decAB.decision.decisionId);
    assert.deepStrictEqual(openB2.record.reboundFrom, [openA.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(decisionsDir),
      decisionsBeforeSecondMove,
      "second move to B must reuse the existing decision without writing any decision file",
    );
    assert.deepStrictEqual(snapshotFile(decAB.decisionPath), decABSnapshot);
    assert.deepStrictEqual(
      snapshotTree(openB2.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      nonProjectBefore,
    );

    // Reopen at B must succeed cleanly.
    const reopenB = openProject(locB, stateBase);
    assert.strictEqual(reopenB.projectKey, openB1.projectKey);
    assert.strictEqual(reopenB.created, false);
    assert.strictEqual(reopenB.rebound, false);
    assert.deepStrictEqual(reopenB.record.reboundFrom, [openA.projectKey]);

    // Three-location cycle A -> B -> C -> A preserves oldest-first order excluding current key.
    const cycleState = path.join(scratch, "state-cycle");
    const cycA = path.join(scratch, "cyc-a");
    const cycB = path.join(scratch, "cyc-b");
    const cycC = path.join(scratch, "cyc-c");
    runGit(["clone", originRepo, cycA]);
    const cOpenA = openProject(cycA, cycleState);

    fs.renameSync(cycA, cycB);
    recordIdentityDecision({
      cwd: cycB,
      stateBase: cycleState,
      choice: "rebind",
      oldProjectKey: cOpenA.projectKey,
      decidedBy: "user-cycle",
    });
    const cOpenB = openProject(cycB, cycleState);
    assert.deepStrictEqual(cOpenB.record.reboundFrom, [cOpenA.projectKey]);

    fs.renameSync(cycB, cycC);
    recordIdentityDecision({
      cwd: cycC,
      stateBase: cycleState,
      choice: "rebind",
      oldProjectKey: cOpenB.projectKey,
      decidedBy: "user-cycle",
    });
    const cOpenC = openProject(cycC, cycleState);
    assert.deepStrictEqual(cOpenC.record.reboundFrom, [cOpenA.projectKey, cOpenB.projectKey]);

    fs.renameSync(cycC, cycA);
    recordIdentityDecision({
      cwd: cycA,
      stateBase: cycleState,
      choice: "rebind",
      oldProjectKey: cOpenC.projectKey,
      decidedBy: "user-cycle",
    });
    const cOpenA2 = openProject(cycA, cycleState);
    assert.deepStrictEqual(cOpenA2.record.reboundFrom, [cOpenB.projectKey, cOpenC.projectKey]);
    const cReopenA = openProject(cycA, cycleState);
    assert.deepStrictEqual(cReopenA.record.reboundFrom, [cOpenB.projectKey, cOpenC.projectKey]);

    // Interrupted move back B -> A must also exclude the current key via the shared helper.
    const crashBackState = path.join(scratch, "state-crash-back");
    const cbA = path.join(scratch, "cb-a");
    const cbB = path.join(scratch, "cb-b");
    runGit(["clone", originRepo, cbA]);
    const cbOpenA = openProject(cbA, crashBackState);
    fs.renameSync(cbA, cbB);
    recordIdentityDecision({
      cwd: cbB,
      stateBase: crashBackState,
      choice: "rebind",
      oldProjectKey: cbOpenA.projectKey,
      decidedBy: "user-cb",
    });
    const cbOpenB = openProject(cbB, crashBackState);
    fs.renameSync(cbB, cbA);
    recordIdentityDecision({
      cwd: cbA,
      stateBase: crashBackState,
      choice: "rebind",
      oldProjectKey: cbOpenB.projectKey,
      decidedBy: "user-cb",
    });
    await interruptRebindWithSigkill(
      cbA,
      crashBackState,
      cbOpenB.stateRoot,
      cbOpenA.stateRoot,
      cbOpenB.record.canonicalCommonDir,
    );
    const cbRecoveredA = runFreshOpenSubprocess(cbA, crashBackState);
    assert.strictEqual(cbRecoveredA.rebound, true);
    assert.deepStrictEqual(cbRecoveredA.record.reboundFrom, [cbOpenB.projectKey]);
    const cbReopenA = runFreshOpenSubprocess(cbA, crashBackState);
    assert.strictEqual(cbReopenA.rebound, false);
    assert.deepStrictEqual(cbReopenA.record.reboundFrom, [cbOpenB.projectKey]);
  });

  test("fix-1 Build note 11: existing decision for another pair refuses openProject and recordIdentityDecision with decision_mismatch and leaves state unchanged", () => {
    const scratch = createScratchDir("fix1-bn11");
    const originRepo = path.join(scratch, "origin");
    initRepoWithCommit(originRepo);

    // Case 1: A -> B rebound, B -> A rebound (A is live), then C -> B with <B>.json still naming A -> B.
    const stateLive = path.join(scratch, "state-live-a");
    const cloneA = path.join(scratch, "clone-a");
    const cloneB = path.join(scratch, "clone-b");
    const cloneC = path.join(scratch, "clone-c");
    runGit(["clone", originRepo, cloneA]);
    runGit(["clone", originRepo, cloneC]);

    const openA = openProject(cloneA, stateLive);
    const openC = openProject(cloneC, stateLive);
    seedStateFiles(openA.stateRoot);
    seedStateFiles(openC.stateRoot);

    fs.renameSync(cloneA, cloneB);
    const decAB = recordIdentityDecision({
      cwd: cloneB,
      stateBase: stateLive,
      choice: "rebind",
      oldProjectKey: openA.projectKey,
      decidedBy: "user-bn11",
    });
    const openB = openProject(cloneB, stateLive);

    fs.renameSync(cloneB, cloneA);
    recordIdentityDecision({
      cwd: cloneA,
      stateBase: stateLive,
      choice: "rebind",
      oldProjectKey: openB.projectKey,
      decidedBy: "user-bn11",
    });
    openProject(cloneA, stateLive);

    // Move C into B's path; <B>.json names A -> B, not C -> B.
    fs.renameSync(cloneC, cloneB);
    const beforeStateLive = snapshotTree(stateLive);

    const openErr = expectIdentityError(
      () => openProject(cloneB, stateLive),
      "decision_mismatch",
      "openProject must refuse when existing decision names another pair",
    );
    assert.ok(openErr.message.includes(decAB.decisionPath));
    assert.strictEqual(openErr.details?.decisionPath, decAB.decisionPath);
    assert.deepStrictEqual(
      snapshotTree(stateLive),
      beforeStateLive,
      "decision_mismatch on openProject must leave state tree unchanged byte for byte",
    );

    const recRebindErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: cloneB,
          stateBase: stateLive,
          choice: "rebind",
          oldProjectKey: openC.projectKey,
          decidedBy: "user-bn11",
        }),
      "decision_mismatch",
      "recordIdentityDecision(rebind) must refuse when existing decision names another pair",
    );
    assert.ok(recRebindErr.message.includes(decAB.decisionPath));
    assert.strictEqual(recRebindErr.details?.decisionPath, decAB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateLive), beforeStateLive);

    const recNewErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: cloneB,
          stateBase: stateLive,
          choice: "new_project",
          decidedBy: "user-bn11",
        }),
      "decision_mismatch",
      "recordIdentityDecision(new_project) must refuse when existing decision names another pair",
    );
    assert.ok(recNewErr.message.includes(decAB.decisionPath));
    assert.strictEqual(recNewErr.details?.decisionPath, decAB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateLive), beforeStateLive);

    // Case 2: A -> B -> D rebound (<A> no longer exists), then C -> B with <B>.json naming A -> B.
    const stateGone = path.join(scratch, "state-gone-a");
    const goneA = path.join(scratch, "gone-a");
    const goneB = path.join(scratch, "gone-b");
    const goneC = path.join(scratch, "gone-c");
    const goneD = path.join(scratch, "gone-d");
    runGit(["clone", originRepo, goneA]);
    runGit(["clone", originRepo, goneC]);

    const gOpenA = openProject(goneA, stateGone);
    const gOpenC = openProject(goneC, stateGone);
    fs.renameSync(goneA, goneB);
    const gDecAB = recordIdentityDecision({
      cwd: goneB,
      stateBase: stateGone,
      choice: "rebind",
      oldProjectKey: gOpenA.projectKey,
      decidedBy: "user-bn11",
    });
    const gOpenB = openProject(goneB, stateGone);
    fs.renameSync(goneB, goneD);
    recordIdentityDecision({
      cwd: goneD,
      stateBase: stateGone,
      choice: "rebind",
      oldProjectKey: gOpenB.projectKey,
      decidedBy: "user-bn11",
    });
    openProject(goneD, stateGone);

    fs.renameSync(goneC, goneB);
    const beforeStateGone = snapshotTree(stateGone);

    const gOpenErr = expectIdentityError(
      () => openProject(goneB, stateGone),
      "decision_mismatch",
      "openProject must refuse when existing decision names a missing/other pair",
    );
    assert.ok(gOpenErr.message.includes(gDecAB.decisionPath));
    assert.strictEqual(gOpenErr.details?.decisionPath, gDecAB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateGone), beforeStateGone);

    const gRecErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: goneB,
          stateBase: stateGone,
          choice: "rebind",
          oldProjectKey: gOpenC.projectKey,
          decidedBy: "user-bn11",
        }),
      "decision_mismatch",
      "recordIdentityDecision must refuse when existing decision names a missing/other pair",
    );
    assert.ok(gRecErr.message.includes(gDecAB.decisionPath));
    assert.strictEqual(gRecErr.details?.decisionPath, gDecAB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateGone), beforeStateGone);

    // Case 3: different rootCommitShas moves into path B when <B>.json holds a new_project decision for repo 1.
    const stateRoots = path.join(scratch, "state-diff-roots");
    const rootRepo1A = path.join(scratch, "root1-a");
    const rootRepoB = path.join(scratch, "root-shared-b");
    const rootRepo1D = path.join(scratch, "root1-d");
    const rootRepo2 = path.join(scratch, "root2");
    runGit(["clone", originRepo, rootRepo1A]);
    initRepoWithCommit(rootRepo2, { content: "distinct root commit history\n" });

    openProject(rootRepo1A, stateRoots);
    fs.renameSync(rootRepo1A, rootRepoB);
    const rootDecB = recordIdentityDecision({
      cwd: rootRepoB,
      stateBase: stateRoots,
      choice: "new_project",
      decidedBy: "user-bn11-roots",
    });
    const openedRootB = openProject(rootRepoB, stateRoots);
    fs.renameSync(rootRepoB, rootRepo1D);
    recordIdentityDecision({
      cwd: rootRepo1D,
      stateBase: stateRoots,
      choice: "rebind",
      oldProjectKey: openedRootB.projectKey,
      decidedBy: "user-bn11-roots",
    });
    openProject(rootRepo1D, stateRoots);

    fs.renameSync(rootRepo2, rootRepoB);
    const beforeStateRoots = snapshotTree(stateRoots);

    const rootOpenErr = expectIdentityError(
      () => openProject(rootRepoB, stateRoots),
      "decision_mismatch",
      "openProject must refuse when existing decision has different rootCommitShas",
    );
    assert.ok(rootOpenErr.message.includes(rootDecB.decisionPath));
    assert.strictEqual(rootOpenErr.details?.decisionPath, rootDecB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateRoots), beforeStateRoots);

    const rootRecErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: rootRepoB,
          stateBase: stateRoots,
          choice: "new_project",
          decidedBy: "user-bn11-roots",
        }),
      "decision_mismatch",
      "recordIdentityDecision must refuse when existing decision has different rootCommitShas",
    );
    assert.ok(rootRecErr.message.includes(rootDecB.decisionPath));
    assert.strictEqual(rootRecErr.details?.decisionPath, rootDecB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateRoots), beforeStateRoots);
  });

  test("fix-1 R2: changed origin before decision application or after SIGKILL finishes rebind and reports originDrift", async () => {
    const scratch = createScratchDir("fix1-r2");
    const urlOne = "https://example.invalid/org/origin-one.git";
    const urlTwo = "https://example.invalid/org/origin-two.git";

    // Subcase A: origin changes before a recorded rebind decision is applied.
    const stateBefore = path.join(scratch, "state-before-apply");
    const repoBeforeA = path.join(scratch, "before-a");
    const repoBeforeB = path.join(scratch, "before-b");
    initRepoWithCommit(repoBeforeA, { originUrl: urlOne });

    const openedBeforeA = openProject(repoBeforeA, stateBefore);
    seedStateFiles(openedBeforeA.stateRoot);
    const beforeNonProject = snapshotTree(
      openedBeforeA.stateRoot,
      new Set([PROJECT_RECORD_FILENAME]),
    );

    fs.renameSync(repoBeforeA, repoBeforeB);
    const decBefore = recordIdentityDecision({
      cwd: repoBeforeB,
      stateBase: stateBefore,
      choice: "rebind",
      oldProjectKey: openedBeforeA.projectKey,
      decidedBy: "user-r2-before",
    });

    // Change origin URL before openProject applies the decision.
    runGit(["remote", "set-url", "origin", urlTwo], repoBeforeB);
    const reboundBefore = openProject(repoBeforeB, stateBefore);
    assert.strictEqual(reboundBefore.rebound, true);
    assert.strictEqual(reboundBefore.appliedDecisionId, decBefore.decision.decisionId);
    assert.strictEqual(reboundBefore.record.originUrl, urlOne);
    assert.deepStrictEqual(reboundBefore.originDrift, { stored: urlOne, live: urlTwo });
    assert.deepStrictEqual(reboundBefore.record.reboundFrom, [openedBeforeA.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(reboundBefore.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      beforeNonProject,
    );

    const reopenBefore = openProject(repoBeforeB, stateBefore);
    assert.strictEqual(reopenBefore.rebound, false);
    assert.deepStrictEqual(reopenBefore.originDrift, { stored: urlOne, live: urlTwo });

    // Subcase B: origin changes after SIGKILL between rename and rewrite.
    const stateSigkill = path.join(scratch, "state-after-sigkill");
    const repoCrashA = path.join(scratch, "crash-a");
    const repoCrashB = path.join(scratch, "crash-b");
    initRepoWithCommit(repoCrashA, { originUrl: urlOne });

    const openedCrashA = openProject(repoCrashA, stateSigkill);
    seedStateFiles(openedCrashA.stateRoot);
    const crashNonProject = snapshotTree(
      openedCrashA.stateRoot,
      new Set([PROJECT_RECORD_FILENAME]),
    );

    fs.renameSync(repoCrashA, repoCrashB);
    const crashBIdentity = resolveProjectIdentity(repoCrashB);
    const crashBStateRoot = path.join(stateSigkill, crashBIdentity.projectKey);
    const decCrash = recordIdentityDecision({
      cwd: repoCrashB,
      stateBase: stateSigkill,
      choice: "rebind",
      oldProjectKey: openedCrashA.projectKey,
      decidedBy: "user-r2-crash",
    });

    await interruptRebindWithSigkill(
      repoCrashB,
      stateSigkill,
      openedCrashA.stateRoot,
      crashBStateRoot,
      openedCrashA.record.canonicalCommonDir,
    );

    // Change origin URL after SIGKILL before recovery open runs.
    runGit(["remote", "set-url", "origin", urlTwo], repoCrashB);
    const recoveredCrash = runFreshOpenSubprocess(repoCrashB, stateSigkill);
    assert.strictEqual(recoveredCrash.projectKey, crashBIdentity.projectKey);
    assert.strictEqual(recoveredCrash.rebound, true);
    assert.strictEqual(recoveredCrash.appliedDecisionId, decCrash.decision.decisionId);
    assert.strictEqual(recoveredCrash.record.canonicalCommonDir, crashBIdentity.canonicalCommonDir);
    assert.strictEqual(recoveredCrash.record.slug, openedCrashA.record.slug);
    assert.strictEqual(recoveredCrash.record.originUrl, urlOne);
    assert.deepStrictEqual(recoveredCrash.originDrift, { stored: urlOne, live: urlTwo });
    assert.deepStrictEqual(recoveredCrash.record.reboundFrom, [openedCrashA.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(crashBStateRoot, new Set([PROJECT_RECORD_FILENAME])),
      crashNonProject,
    );

    const reopenCrash = runFreshOpenSubprocess(repoCrashB, stateSigkill);
    assert.strictEqual(reopenCrash.rebound, false);
    assert.deepStrictEqual(reopenCrash.originDrift, { stored: urlOne, live: urlTwo });
  });

  test("fix-1 R3: interrupted rebind followed by move to C finishes B first, and recordIdentityDecision validates with reader rules before publishing", async () => {
    const scratch = createScratchDir("fix1-r3");
    const originRepo = path.join(scratch, "origin");
    initRepoWithCommit(originRepo);

    // Subcase A: interrupt A -> B, move to C, open at C -> finishes B first, then record & apply B -> C.
    const stateBase = path.join(scratch, "state-three-loc");
    const locA = path.join(scratch, "clone-a");
    const locB = path.join(scratch, "clone-b");
    const locC = path.join(scratch, "clone-c");
    runGit(["clone", originRepo, locA]);

    const openA = openProject(locA, stateBase);
    seedStateFiles(openA.stateRoot);
    const nonProjectBefore = snapshotTree(openA.stateRoot, new Set([PROJECT_RECORD_FILENAME]));

    fs.renameSync(locA, locB);
    const idB = resolveProjectIdentity(locB);
    const stateRootB = path.join(stateBase, idB.projectKey);
    recordIdentityDecision({
      cwd: locB,
      stateBase,
      choice: "rebind",
      oldProjectKey: openA.projectKey,
      decidedBy: "user-r3-ab",
    });

    await interruptRebindWithSigkill(
      locB,
      stateBase,
      openA.stateRoot,
      stateRootB,
      openA.record.canonicalCommonDir,
    );

    // Move clone again from B -> C before B's rewrite ran.
    fs.renameSync(locB, locC);
    const idC = resolveProjectIdentity(locC);

    const relErr = expectIdentityError(
      () => openProject(locC, stateBase),
      "identity_relocated",
      "open at C after interrupted A -> B must refuse with identity_relocated",
    );
    assert.strictEqual(relErr.candidates?.length, 1);
    assert.strictEqual(relErr.candidates?.[0].projectKey, idB.projectKey);
    assert.strictEqual(
      relErr.candidates?.[0].canonicalCommonDir,
      idB.canonicalCommonDir,
      "scan must finish interrupted rebind first and list B with path B",
    );
    assert.strictEqual(
      relErr.candidates?.[0].slug,
      openA.record.slug,
      "finished interrupted rebind must keep stored slug per Build note 14",
    );

    // Verify B's project.json on disk is already finished with path B and stored slug.
    const finishedBOnDisk = JSON.parse(
      fs.readFileSync(path.join(stateRootB, PROJECT_RECORD_FILENAME), "utf8"),
    ) as ProjectRecord;
    assert.strictEqual(finishedBOnDisk.canonicalCommonDir, idB.canonicalCommonDir);
    assert.strictEqual(finishedBOnDisk.commonDirSha256, idB.commonDirSha256);
    assert.strictEqual(finishedBOnDisk.slug, openA.record.slug);
    assert.deepStrictEqual(finishedBOnDisk.reboundFrom, [openA.projectKey]);

    // Record B -> C, read it back, and apply it cleanly.
    const decBC = recordIdentityDecision({
      cwd: locC,
      stateBase,
      choice: "rebind",
      oldProjectKey: idB.projectKey,
      decidedBy: "user-r3-bc",
    });
    const readBackBC = JSON.parse(fs.readFileSync(decBC.decisionPath, "utf8")) as IdentityDecision;
    assert.strictEqual(readBackBC.oldProjectKey, idB.projectKey);
    assert.strictEqual(readBackBC.oldCanonicalCommonDir, idB.canonicalCommonDir);
    assert.strictEqual(sha256Hex(readBackBC.oldCanonicalCommonDir as string).slice(0, 16), idB.projectKey);
    assert.strictEqual(readBackBC.newProjectKey, idC.projectKey);
    assert.strictEqual(readBackBC.newCanonicalCommonDir, idC.canonicalCommonDir);

    const openC = openProject(locC, stateBase);
    assert.strictEqual(openC.projectKey, idC.projectKey);
    assert.strictEqual(openC.rebound, true);
    assert.strictEqual(openC.appliedDecisionId, decBC.decision.decisionId);
    assert.strictEqual(openC.record.canonicalCommonDir, idC.canonicalCommonDir);
    assert.deepStrictEqual(openC.record.reboundFrom, [openA.projectKey, idB.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(openC.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      nonProjectBefore,
    );
    assert.strictEqual(openProject(locC, stateBase).rebound, false);

    // Subcase B: calling recordIdentityDecision directly at C (without opening C first) also finishes B first.
    const directState = path.join(scratch, "state-direct-record");
    const dA = path.join(scratch, "direct-a");
    const dB = path.join(scratch, "direct-b");
    const dC = path.join(scratch, "direct-c");
    runGit(["clone", originRepo, dA]);
    const dOpenA = openProject(dA, directState);
    fs.renameSync(dA, dB);
    const dIdB = resolveProjectIdentity(dB);
    const dStateRootB = path.join(directState, dIdB.projectKey);
    recordIdentityDecision({
      cwd: dB,
      stateBase: directState,
      choice: "rebind",
      oldProjectKey: dOpenA.projectKey,
      decidedBy: "user-r3-direct-ab",
    });
    await interruptRebindWithSigkill(
      dB,
      directState,
      dOpenA.stateRoot,
      dStateRootB,
      dOpenA.record.canonicalCommonDir,
    );
    fs.renameSync(dB, dC);
    const dDecBC = recordIdentityDecision({
      cwd: dC,
      stateBase: directState,
      choice: "rebind",
      oldProjectKey: dIdB.projectKey,
      decidedBy: "user-r3-direct-bc",
    });
    assert.strictEqual(dDecBC.decision.oldCanonicalCommonDir, dIdB.canonicalCommonDir);
    const dOpenC = openProject(dC, directState);
    assert.strictEqual(dOpenC.rebound, true);
    assert.deepStrictEqual(dOpenC.record.reboundFrom, [dOpenA.projectKey, dIdB.projectKey]);

    // Subcase C: input producing a decision the reader refuses (>= 8192 UTF-8 bytes) writes NO file.
    const sizeState = path.join(scratch, "state-decision-size");
    const sizeOrig = path.join(scratch, "size-orig");
    const sizeMoved = path.join(scratch, "size-moved");
    runGit(["clone", originRepo, sizeOrig]);
    const sizeOpenOrig = openProject(sizeOrig, sizeState);
    fs.renameSync(sizeOrig, sizeMoved);
    const sizeMovedId = resolveProjectIdentity(sizeMoved);

    const sampleDecision: IdentityDecision = {
      schemaVersion: 1,
      decisionId: "00000000-0000-4000-8000-000000000000",
      choice: "rebind",
      oldProjectKey: sizeOpenOrig.projectKey,
      newProjectKey: sizeMovedId.projectKey,
      oldCanonicalCommonDir: sizeOpenOrig.record.canonicalCommonDir,
      newCanonicalCommonDir: sizeMovedId.canonicalCommonDir,
      rootCommitShas: [...sizeMovedId.rootCommitShas],
      originUrl: sizeMovedId.originUrl,
      decidedBy: "u",
      time: "2026-11-27T00:00:00.000Z",
    };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(sampleDecision, null, 2)}\n`, "utf8");
    const exact8192Delta = MAX_DECISION_RECORD_BYTES - baseBytes;
    assert.ok(exact8192Delta > 10);

    const asciiTooLarge = "u" + "a".repeat(exact8192Delta);
    const multibyteTooLarge =
      "u" + "é".repeat(Math.floor(exact8192Delta / 2)) + "a".repeat(exact8192Delta % 2);
    assert.ok(multibyteTooLarge.length < asciiTooLarge.length);

    const decisionsDir = path.join(sizeState, IDENTITY_DECISIONS_DIR);
    for (const [label, decidedBy] of [
      ["8192-byte ASCII", asciiTooLarge],
      ["8192-byte UTF-8 multibyte", multibyteTooLarge],
    ] as const) {
      expectIdentityError(
        () =>
          recordIdentityDecision({
            cwd: sizeMoved,
            stateBase: sizeState,
            choice: "rebind",
            oldProjectKey: sizeOpenOrig.projectKey,
            decidedBy,
          }),
        "invalid_decision",
        `decision at ${label} must refuse before publishing`,
      );
      assert.strictEqual(
        fs.existsSync(decisionsDir),
        false,
        `${label} refusal must write no file and create no identity-decisions directory`,
      );
    }

    // 8191 UTF-8 bytes succeeds and is read back cleanly by openProject.
    const ascii8191 = "u" + "a".repeat(exact8192Delta - 1);
    const valid8191 = recordIdentityDecision({
      cwd: sizeMoved,
      stateBase: sizeState,
      choice: "rebind",
      oldProjectKey: sizeOpenOrig.projectKey,
      decidedBy: ascii8191,
    });
    assert.strictEqual(fs.statSync(valid8191.decisionPath).size, MAX_DECISION_RECORD_BYTES - 1);
    const opened8191 = openProject(sizeMoved, sizeState);
    assert.strictEqual(opened8191.rebound, true);
    assert.strictEqual(opened8191.appliedDecisionId, valid8191.decision.decisionId);
  });

  test("fix-1 R4: rename races translate ENOTEMPTY/EEXIST to rebind_destination_exists, finish concurrent ENOENT moves, and replace empty dirs cleanly", () => {
    const scratch = createScratchDir("fix1-r4");
    const originRepo = path.join(scratch, "origin");
    initRepoWithCommit(originRepo);

    // Subcase A: non-empty destination folder appears between existence check and renameSync.
    const statePopulated = path.join(scratch, "state-race-populated");
    const popOrig = path.join(scratch, "pop-orig");
    const popMoved = path.join(scratch, "pop-moved");
    runGit(["clone", originRepo, popOrig]);
    const popOpenOrig = openProject(popOrig, statePopulated);
    seedStateFiles(popOpenOrig.stateRoot);
    fs.renameSync(popOrig, popMoved);
    const popMovedId = resolveProjectIdentity(popMoved);
    const popDestRoot = path.join(statePopulated, popMovedId.projectKey);
    recordIdentityDecision({
      cwd: popMoved,
      stateBase: statePopulated,
      choice: "rebind",
      oldProjectKey: popOpenOrig.projectKey,
      decidedBy: "user-r4-pop",
    });

    const beforeOldPop = snapshotTree(popOpenOrig.stateRoot);
    expectIdentityError(
      () =>
        openProject(popMoved, statePopulated, {
          fs: {
            renameSync(oldPath, newPath) {
              fs.mkdirSync(String(newPath), { recursive: true });
              fs.writeFileSync(path.join(String(newPath), "sentinel.txt"), "kept\n", "utf8");
              fs.renameSync(oldPath, newPath);
            },
          },
        }),
      "rebind_destination_exists",
      "populated destination appearing before rename must refuse with rebind_destination_exists",
    );
    assert.deepStrictEqual(
      snapshotTree(popOpenOrig.stateRoot),
      beforeOldPop,
      "source folder must remain unchanged byte for byte and inode for inode",
    );
    assert.deepStrictEqual(fs.readdirSync(popDestRoot), ["sentinel.txt"]);
    assert.strictEqual(fs.readFileSync(path.join(popDestRoot, "sentinel.txt"), "utf8"), "kept\n");

    // Subcase B: another opener moves the folder right before renameSync (rewrite not done yet).
    const stateConcurrentMove = path.join(scratch, "state-race-concurrent-move");
    const cmOrig = path.join(scratch, "cm-orig");
    const cmMoved = path.join(scratch, "cm-moved");
    runGit(["clone", originRepo, cmOrig]);
    const cmOpenOrig = openProject(cmOrig, stateConcurrentMove);
    seedStateFiles(cmOpenOrig.stateRoot);
    const cmNonProjectBefore = snapshotTree(
      cmOpenOrig.stateRoot,
      new Set([PROJECT_RECORD_FILENAME]),
    );
    fs.renameSync(cmOrig, cmMoved);
    const cmMovedId = resolveProjectIdentity(cmMoved);
    const cmDec = recordIdentityDecision({
      cwd: cmMoved,
      stateBase: stateConcurrentMove,
      choice: "rebind",
      oldProjectKey: cmOpenOrig.projectKey,
      decidedBy: "user-r4-cm",
    });

    const cmResult = openProject(cmMoved, stateConcurrentMove, {
      fs: {
        renameSync(oldPath, newPath) {
          // Simulate another opener moving oldPath -> newPath first, then hitting real ENOENT.
          fs.renameSync(oldPath, newPath);
          fs.renameSync(oldPath, newPath);
        },
      },
    });
    assert.strictEqual(cmResult.projectKey, cmMovedId.projectKey);
    assert.strictEqual(cmResult.rebound, true);
    assert.strictEqual(cmResult.appliedDecisionId, cmDec.decision.decisionId);
    assert.strictEqual(cmResult.record.canonicalCommonDir, cmMovedId.canonicalCommonDir);
    assert.strictEqual(cmResult.record.slug, cmOpenOrig.record.slug);
    assert.deepStrictEqual(cmResult.record.reboundFrom, [cmOpenOrig.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(cmResult.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      cmNonProjectBefore,
    );
    assert.strictEqual(openProject(cmMoved, stateConcurrentMove).rebound, false);

    // Subcase C: another opener completes BOTH rename and project.json rewrite right before renameSync.
    const stateConcurrentDone = path.join(scratch, "state-race-concurrent-done");
    const cdOrig = path.join(scratch, "cd-orig");
    const cdMoved = path.join(scratch, "cd-moved");
    runGit(["clone", originRepo, cdOrig]);
    const cdOpenOrig = openProject(cdOrig, stateConcurrentDone);
    fs.renameSync(cdOrig, cdMoved);
    const cdMovedId = resolveProjectIdentity(cdMoved);
    recordIdentityDecision({
      cwd: cdMoved,
      stateBase: stateConcurrentDone,
      choice: "rebind",
      oldProjectKey: cdOpenOrig.projectKey,
      decidedBy: "user-r4-cd",
    });

    let winnerSnapshot: FileSnapshot | undefined;
    const cdResult = openProject(cdMoved, stateConcurrentDone, {
      fs: {
        renameSync(oldPath, newPath) {
          const winner = openProject(cdMoved, stateConcurrentDone);
          winnerSnapshot = snapshotFile(path.join(winner.stateRoot, PROJECT_RECORD_FILENAME));
          fs.renameSync(oldPath, newPath);
        },
      },
    });
    assert.strictEqual(cdResult.projectKey, cdMovedId.projectKey);
    assert.strictEqual(cdResult.rebound, false);
    assert.strictEqual(cdResult.created, false);
    assert.deepStrictEqual(cdResult.record.reboundFrom, [cdOpenOrig.projectKey]);
    assert.deepStrictEqual(
      snapshotFile(path.join(cdResult.stateRoot, PROJECT_RECORD_FILENAME)),
      winnerSnapshot,
      "concurrent opener that sees an already-completed rebind must not rewrite project.json",
    );

    // Subcase D: source disappears with nothing at destination -> named IdentityError, never raw ENOENT.
    const stateVanished = path.join(scratch, "state-race-vanished");
    const vanOrig = path.join(scratch, "van-orig");
    const vanMoved = path.join(scratch, "van-moved");
    runGit(["clone", originRepo, vanOrig]);
    const vanOpenOrig = openProject(vanOrig, stateVanished);
    fs.renameSync(vanOrig, vanMoved);
    const vanDec = recordIdentityDecision({
      cwd: vanMoved,
      stateBase: stateVanished,
      choice: "rebind",
      oldProjectKey: vanOpenOrig.projectKey,
      decidedBy: "user-r4-van",
    });
    const vanErr = expectIdentityError(
      () =>
        openProject(vanMoved, stateVanished, {
          fs: {
            renameSync(oldPath, newPath) {
              fs.rmSync(String(oldPath), { recursive: true, force: true });
              fs.renameSync(oldPath, newPath);
            },
          },
        }),
      "decision_mismatch",
      "vanished source with no destination must throw named decision_mismatch on re-evaluation, not raw ENOENT",
    );
    assert.ok(vanErr.message.includes(vanDec.decisionPath));

    // Subcase E: empty folder appearing before renameSync is replaced cleanly with nothing lost (Build note 15).
    const stateEmpty = path.join(scratch, "state-race-empty");
    const empOrig = path.join(scratch, "emp-orig");
    const empMoved = path.join(scratch, "emp-moved");
    runGit(["clone", originRepo, empOrig]);
    const empOpenOrig = openProject(empOrig, stateEmpty);
    seedStateFiles(empOpenOrig.stateRoot);
    const empNonProjectBefore = snapshotTree(
      empOpenOrig.stateRoot,
      new Set([PROJECT_RECORD_FILENAME]),
    );
    fs.renameSync(empOrig, empMoved);
    recordIdentityDecision({
      cwd: empMoved,
      stateBase: stateEmpty,
      choice: "rebind",
      oldProjectKey: empOpenOrig.projectKey,
      decidedBy: "user-r4-empty",
    });
    const empResult = openProject(empMoved, stateEmpty, {
      fs: {
        renameSync(oldPath, newPath) {
          fs.mkdirSync(String(newPath));
          fs.renameSync(oldPath, newPath);
        },
      },
    });
    assert.strictEqual(empResult.rebound, true);
    assert.deepStrictEqual(
      snapshotTree(empResult.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      empNonProjectBefore,
    );
  });

  test("fix-2 R6: new_project decision is used once; after rebind moves state on, open and recorder refuse with decision_mismatch", () => {
    const scratch = createScratchDir("fix2-r6");
    const originRepo = path.join(scratch, "origin");
    initRepoWithCommit(originRepo);

    // Subcase A: new_project recorded without oldProjectKey, applied once, rebound B -> C, then moved back to B.
    const stateNoOld = path.join(scratch, "state-no-old");
    const locA = path.join(scratch, "no-old-a");
    const locB = path.join(scratch, "no-old-b");
    const locC = path.join(scratch, "no-old-c");
    runGit(["clone", originRepo, locA]);

    openProject(locA, stateNoOld);
    fs.renameSync(locA, locB);

    const decNewB = recordIdentityDecision({
      cwd: locB,
      stateBase: stateNoOld,
      choice: "new_project",
      decidedBy: "user-r6-new",
    });
    assert.strictEqual(decNewB.decision.oldProjectKey, null);

    // First use: a new_project decision recorded and then applied by a later open still works.
    const openB = openProject(locB, stateNoOld);
    assert.strictEqual(openB.created, true);
    assert.strictEqual(openB.rebound, false);
    assert.strictEqual(openB.appliedDecisionId, decNewB.decision.decisionId);
    assert.strictEqual(openB.record.reboundFrom, undefined);
    seedStateFiles(openB.stateRoot);

    // Rebind B -> C, moving the state created by new_project onward.
    fs.renameSync(locB, locC);
    recordIdentityDecision({
      cwd: locC,
      stateBase: stateNoOld,
      choice: "rebind",
      oldProjectKey: openB.projectKey,
      decidedBy: "user-r6-rebind",
    });
    const openC = openProject(locC, stateNoOld);
    assert.strictEqual(openC.rebound, true);
    assert.deepStrictEqual(openC.record.reboundFrom, [openB.projectKey]);

    // Move clone back C -> B: old new_project decision must not be reused.
    fs.renameSync(locC, locB);
    const beforeReturn = snapshotTree(stateNoOld);

    const openErr = expectIdentityError(
      () => openProject(locB, stateNoOld),
      "decision_mismatch",
      "openProject must refuse to reuse a new_project decision after its state moved on",
    );
    assert.ok(openErr.message.includes(decNewB.decisionPath));
    assert.strictEqual(openErr.details?.decisionPath, decNewB.decisionPath);
    assert.strictEqual(fs.existsSync(openB.stateRoot), false);
    assert.deepStrictEqual(
      snapshotTree(stateNoOld),
      beforeReturn,
      "refusing stale new_project on openProject must leave state tree unchanged",
    );

    const recRebindErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: locB,
          stateBase: stateNoOld,
          choice: "rebind",
          oldProjectKey: openC.projectKey,
          decidedBy: "user-r6-rebind-back",
        }),
      "decision_mismatch",
      "recordIdentityDecision(rebind C -> B) must refuse with decision_mismatch after new_project moved on",
    );
    assert.ok(recRebindErr.message.includes(decNewB.decisionPath));
    assert.strictEqual(recRebindErr.details?.decisionPath, decNewB.decisionPath);
    assert.deepStrictEqual(
      snapshotTree(stateNoOld),
      beforeReturn,
      "refusing stale new_project on recordIdentityDecision(rebind) must leave state tree unchanged",
    );

    const recNewErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: locB,
          stateBase: stateNoOld,
          choice: "new_project",
          decidedBy: "user-r6-new-again",
        }),
      "decision_mismatch",
      "recordIdentityDecision(new_project) must refuse with decision_mismatch after new_project moved on",
    );
    assert.ok(recNewErr.message.includes(decNewB.decisionPath));
    assert.strictEqual(recNewErr.details?.decisionPath, decNewB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateNoOld), beforeReturn);

    // Subcase B: new_project recorded WITH explicit oldProjectKey is also used only once.
    const stateWithOld = path.join(scratch, "state-with-old");
    const woA = path.join(scratch, "with-old-a");
    const woB = path.join(scratch, "with-old-b");
    const woC = path.join(scratch, "with-old-c");
    runGit(["clone", originRepo, woA]);

    const woOpenA = openProject(woA, stateWithOld);
    fs.renameSync(woA, woB);
    const woDecNewB = recordIdentityDecision({
      cwd: woB,
      stateBase: stateWithOld,
      choice: "new_project",
      oldProjectKey: woOpenA.projectKey,
      decidedBy: "user-r6-with-old",
    });
    const woOpenB = openProject(woB, stateWithOld);
    assert.strictEqual(woOpenB.created, true);
    assert.strictEqual(woOpenB.appliedDecisionId, woDecNewB.decision.decisionId);

    fs.renameSync(woB, woC);
    recordIdentityDecision({
      cwd: woC,
      stateBase: stateWithOld,
      choice: "rebind",
      oldProjectKey: woOpenB.projectKey,
      decidedBy: "user-r6-with-old-rebind",
    });
    const woOpenC = openProject(woC, stateWithOld);
    assert.deepStrictEqual(woOpenC.record.reboundFrom, [woOpenB.projectKey]);

    fs.renameSync(woC, woB);
    const beforeWoReturn = snapshotTree(stateWithOld);

    const woOpenErr = expectIdentityError(
      () => openProject(woB, stateWithOld),
      "decision_mismatch",
      "openProject must refuse to reuse a named-source new_project decision after its state moved on",
    );
    assert.ok(woOpenErr.message.includes(woDecNewB.decisionPath));
    assert.strictEqual(woOpenErr.details?.decisionPath, woDecNewB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateWithOld), beforeWoReturn);

    const woRecErr = expectIdentityError(
      () =>
        recordIdentityDecision({
          cwd: woB,
          stateBase: stateWithOld,
          choice: "rebind",
          oldProjectKey: woOpenC.projectKey,
          decidedBy: "user-r6-with-old-back",
        }),
      "decision_mismatch",
      "recordIdentityDecision must refuse to reuse a named-source new_project decision after its state moved on",
    );
    assert.ok(woRecErr.message.includes(woDecNewB.decisionPath));
    assert.strictEqual(woRecErr.details?.decisionPath, woDecNewB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateWithOld), beforeWoReturn);
  });

  test("fix-2 R7: root commits are compared when destination folder exists and refuse unrelated repo with decision_mismatch", () => {
    const scratch = createScratchDir("fix2-r7");

    // Subcase A: finish rebind A -> B, move repo 1 away, place unrelated repo 2 at path B with folder B present.
    const stateRebind = path.join(scratch, "state-rebind");
    const repo1A = path.join(scratch, "rebind-repo1-a");
    const sharedPathB = path.join(scratch, "rebind-shared-b");
    const repo1Away = path.join(scratch, "rebind-repo1-away");
    initRepoWithCommit(repo1A, { content: "repo one for r7 rebind\n" });

    const open1A = openProject(repo1A, stateRebind);
    seedStateFiles(open1A.stateRoot);

    fs.renameSync(repo1A, sharedPathB);
    const decAB = recordIdentityDecision({
      cwd: sharedPathB,
      stateBase: stateRebind,
      choice: "rebind",
      oldProjectKey: open1A.projectKey,
      decidedBy: "user-r7-rebind",
    });
    const open1B = openProject(sharedPathB, stateRebind);
    assert.strictEqual(open1B.rebound, true);
    assert.strictEqual(fs.existsSync(open1B.stateRoot), true);

    fs.renameSync(sharedPathB, repo1Away);
    initRepoWithCommit(sharedPathB, { content: "repo two unrelated for r7 rebind\n" });
    const repo2Identity = resolveProjectIdentity(sharedPathB);
    assert.strictEqual(repo2Identity.projectKey, open1B.projectKey);
    assert.notDeepStrictEqual(repo2Identity.rootCommitShas, open1B.record.rootCommitShas);

    const beforeRebindTree = snapshotTree(stateRebind);
    const rebindErr = expectIdentityError(
      () => openProject(sharedPathB, stateRebind),
      "decision_mismatch",
      "openProject must refuse when destination folder exists and decision root commits differ from live repo",
    );
    assert.ok(
      rebindErr.message.includes(decAB.decisionPath),
      "decision_mismatch must name the decision file",
    );
    assert.match(
      rebindErr.message,
      /root/i,
      "decision_mismatch must name root commits as the cause",
    );
    assert.strictEqual(rebindErr.details?.decisionPath, decAB.decisionPath);
    assert.deepStrictEqual(
      snapshotTree(stateRebind),
      beforeRebindTree,
      "refusal when destination folder exists must leave state tree unchanged",
    );

    // Subcase B: new_project decision at B with destination folder B still present, unrelated repo 2 placed at path B.
    const stateNew = path.join(scratch, "state-new-project");
    const npRepo1A = path.join(scratch, "np-repo1-a");
    const npSharedB = path.join(scratch, "np-shared-b");
    const npRepo1Away = path.join(scratch, "np-repo1-away");
    initRepoWithCommit(npRepo1A, { content: "repo one for r7 new_project\n" });

    openProject(npRepo1A, stateNew);
    fs.renameSync(npRepo1A, npSharedB);
    const decNewB = recordIdentityDecision({
      cwd: npSharedB,
      stateBase: stateNew,
      choice: "new_project",
      decidedBy: "user-r7-new",
    });
    const openNpB = openProject(npSharedB, stateNew);
    assert.strictEqual(openNpB.created, true);

    fs.renameSync(npSharedB, npRepo1Away);
    initRepoWithCommit(npSharedB, { content: "repo two unrelated for r7 new_project\n" });

    const beforeNewTree = snapshotTree(stateNew);
    const newErr = expectIdentityError(
      () => openProject(npSharedB, stateNew),
      "decision_mismatch",
      "openProject must refuse new_project decision with differing root commits when destination folder exists",
    );
    assert.ok(newErr.message.includes(decNewB.decisionPath));
    assert.match(newErr.message, /root/i);
    assert.strictEqual(newErr.details?.decisionPath, decNewB.decisionPath);
    assert.deepStrictEqual(snapshotTree(stateNew), beforeNewTree);
  });

  test("fix-3 R12: destination folder present with commitless live repo refuses with decision_mismatch and leaves state unchanged", () => {
    const scratch = createScratchDir("fix3-r12");
    const stateBase = path.join(scratch, "state");
    const repo1A = path.join(scratch, "repo1-a");
    const sharedPathB = path.join(scratch, "shared-b");
    const repo1Away = path.join(scratch, "repo1-away");

    initRepoWithCommit(repo1A, { content: "repo one for r12\n" });
    const open1A = openProject(repo1A, stateBase);
    seedStateFiles(open1A.stateRoot);

    fs.renameSync(repo1A, sharedPathB);
    const decAB = recordIdentityDecision({
      cwd: sharedPathB,
      stateBase,
      choice: "rebind",
      oldProjectKey: open1A.projectKey,
      decidedBy: "user-r12",
    });
    const open1B = openProject(sharedPathB, stateBase);
    assert.strictEqual(open1B.rebound, true);
    assert.strictEqual(fs.existsSync(open1B.stateRoot), true);
    assert.strictEqual(open1B.record.rootCommitShas.length, 1);

    // Move repo 1 away and place a commitless repository at path B with folder B still present.
    fs.renameSync(sharedPathB, repo1Away);
    fs.mkdirSync(sharedPathB, { recursive: true });
    runGit(["init", "-b", "main"], sharedPathB);

    const emptyLive = resolveProjectIdentity(sharedPathB);
    assert.strictEqual(emptyLive.projectKey, open1B.projectKey);
    assert.deepStrictEqual(emptyLive.rootCommitShas, []);

    const beforeTree = snapshotTree(stateBase);
    const err = expectIdentityError(
      () => openProject(sharedPathB, stateBase),
      "decision_mismatch",
      "openProject must refuse when destination folder exists and commitless live repo differs from decision root commits",
    );
    assert.ok(err.message.includes(decAB.decisionPath));
    assert.match(err.message, /root/i);
    assert.strictEqual(err.details?.decisionPath, decAB.decisionPath);
    assert.deepStrictEqual(
      snapshotTree(stateBase),
      beforeTree,
      "refusal for commitless repo with existing destination folder must leave state tree unchanged",
    );
  });

  test("fix-2 R8: mismatched decision whose source folder waits for an earlier rebind finishes that folder per Build note 17 and refuses with decision_mismatch", async () => {
    const scratch = createScratchDir("fix2-r8");
    const stateBase = path.join(scratch, "state");
    const pathA = path.join(scratch, "loc-a");
    const pathB = path.join(scratch, "loc-b");
    const pathC = path.join(scratch, "loc-c");
    const pathD = path.join(scratch, "loc-d");
    const pathE = path.join(scratch, "loc-e");

    // Step 1: repo 2 records a real B -> C rebind decision (<C>.json with repo 2's roots), then moves to D.
    initRepoWithCommit(pathB, { content: "repo two history for r8\n" });
    const openRepo2B = openProject(pathB, stateBase);
    fs.renameSync(pathB, pathC);
    const decRepo2BC = recordIdentityDecision({
      cwd: pathC,
      stateBase,
      choice: "rebind",
      oldProjectKey: openRepo2B.projectKey,
      decidedBy: "user-r8-repo2-bc",
    });
    const openRepo2C = openProject(pathC, stateBase);
    fs.renameSync(pathC, pathD);
    recordIdentityDecision({
      cwd: pathD,
      stateBase,
      choice: "rebind",
      oldProjectKey: openRepo2C.projectKey,
      decidedBy: "user-r8-repo2-cd",
    });
    openProject(pathD, stateBase);

    // Step 2: repo 1 (distinct roots) opens at A, moves A -> B, records A -> B, and gets SIGKILLed mid-rebind.
    initRepoWithCommit(pathA, { content: "repo one history for r8\n" });
    const openRepo1A = openProject(pathA, stateBase);
    seedStateFiles(openRepo1A.stateRoot);
    const repo1NonProjectBefore = snapshotTree(
      openRepo1A.stateRoot,
      new Set([PROJECT_RECORD_FILENAME]),
    );

    fs.renameSync(pathA, pathB);
    const repo1IdB = resolveProjectIdentity(pathB);
    assert.strictEqual(repo1IdB.projectKey, openRepo2B.projectKey);
    const stateRootB = path.join(stateBase, repo1IdB.projectKey);
    recordIdentityDecision({
      cwd: pathB,
      stateBase,
      choice: "rebind",
      oldProjectKey: openRepo1A.projectKey,
      decidedBy: "user-r8-repo1-ab",
    });

    await interruptRebindWithSigkill(
      pathB,
      stateBase,
      openRepo1A.stateRoot,
      stateRootB,
      openRepo1A.record.canonicalCommonDir,
    );

    // Step 3: move repo 1 away from B and move repo 2 back to C so openProject(C) checks source folder B.
    fs.renameSync(pathB, pathE);
    fs.renameSync(pathD, pathC);
    const stateRootC = path.join(stateBase, openRepo2C.projectKey);
    assert.strictEqual(fs.existsSync(stateRootC), false);

    const relBProject = `${repo1IdB.projectKey}/${PROJECT_RECORD_FILENAME}`;
    const beforeExcludingBProject = snapshotTree(stateBase, new Set([relBProject]));

    // First call finishes folder B per its own decision (A -> B), changes nothing else, and refuses with decision_mismatch.
    const firstErr = expectIdentityError(
      () => openProject(pathC, stateBase),
      "decision_mismatch",
      "openProject must refuse when interrupted source folder belongs to another pair",
    );
    assert.ok(firstErr.message.includes(decRepo2BC.decisionPath));
    assert.strictEqual(firstErr.details?.decisionPath, decRepo2BC.decisionPath);
    assert.strictEqual(fs.existsSync(stateRootC), false);

    const finishedB = JSON.parse(
      fs.readFileSync(path.join(stateRootB, PROJECT_RECORD_FILENAME), "utf8"),
    ) as ProjectRecord;
    assert.strictEqual(
      finishedB.canonicalCommonDir,
      repo1IdB.canonicalCommonDir,
      "interrupted source folder B must be finished with path B from its own decision",
    );
    assert.strictEqual(finishedB.commonDirSha256, repo1IdB.commonDirSha256);
    assert.strictEqual(
      finishedB.slug,
      openRepo1A.record.slug,
      "finished interrupted folder must keep stored slug per Build note 14",
    );
    assert.deepStrictEqual(finishedB.rootCommitShas, openRepo1A.record.rootCommitShas);
    assert.deepStrictEqual(finishedB.reboundFrom, [openRepo1A.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(stateRootB, new Set([PROJECT_RECORD_FILENAME])),
      repo1NonProjectBefore,
    );
    assert.deepStrictEqual(
      snapshotTree(stateBase, new Set([relBProject])),
      beforeExcludingBProject,
      "nothing else in the state tree may change when finishing the interrupted source before refusal",
    );

    // Second call refuses identically and changes nothing at all (including B/project.json).
    const afterFirstCall = snapshotTree(stateBase);
    const secondErr = expectIdentityError(
      () => openProject(pathC, stateBase),
      "decision_mismatch",
      "second openProject must still refuse with decision_mismatch",
    );
    assert.ok(secondErr.message.includes(decRepo2BC.decisionPath));
    assert.deepStrictEqual(
      snapshotTree(stateBase),
      afterFirstCall,
      "second call after interrupted source was finished must change nothing at all",
    );
  });

  test("fix-2 R9: rebind losing a race before rename (openSync ENOENT and renameSync ENOTDIR) re-evaluates once without leaking raw errno", async () => {
    const scratch = createScratchDir("fix2-r9");
    const originRepo = path.join(scratch, "origin");
    initRepoWithCommit(originRepo);

    // Helper: create A -> B -> X -> A (SIGKILL mid-rebind), then move clone A -> B.
    // Leaves folder A waiting for X -> A while <B>.json already names A -> B.
    async function setupInterruptedSourceBeforeRebind(label: string): Promise<{
      readonly stateBase: string;
      readonly locB: string;
      readonly idA: LiveProjectIdentity;
      readonly idB: LiveProjectIdentity;
      readonly idX: LiveProjectIdentity;
      readonly stateRootA: string;
      readonly stateRootB: string;
      readonly decAB: RecordIdentityDecisionResult;
      readonly nonProjectBefore: Map<string, FileSnapshot>;
    }> {
      const stateBase = path.join(scratch, `state-${label}`);
      const locA = path.join(scratch, `${label}-a`);
      const locB = path.join(scratch, `${label}-b`);
      const locX = path.join(scratch, `${label}-x`);
      runGit(["clone", originRepo, locA]);

      const openA = openProject(locA, stateBase);
      seedStateFiles(openA.stateRoot);
      const nonProjectBefore = snapshotTree(openA.stateRoot, new Set([PROJECT_RECORD_FILENAME]));

      fs.renameSync(locA, locB);
      const decAB = recordIdentityDecision({
        cwd: locB,
        stateBase,
        choice: "rebind",
        oldProjectKey: openA.projectKey,
        decidedBy: `user-r9-${label}-ab`,
      });
      const openB = openProject(locB, stateBase);

      fs.renameSync(locB, locX);
      recordIdentityDecision({
        cwd: locX,
        stateBase,
        choice: "rebind",
        oldProjectKey: openB.projectKey,
        decidedBy: `user-r9-${label}-bx`,
      });
      const openX = openProject(locX, stateBase);

      fs.renameSync(locX, locA);
      const idA = resolveProjectIdentity(locA);
      recordIdentityDecision({
        cwd: locA,
        stateBase,
        choice: "rebind",
        oldProjectKey: openX.projectKey,
        decidedBy: `user-r9-${label}-xa`,
      });
      await interruptRebindWithSigkill(
        locA,
        stateBase,
        openX.stateRoot,
        openA.stateRoot,
        openX.record.canonicalCommonDir,
      );

      fs.renameSync(locA, locB);
      const idB = resolveProjectIdentity(locB);
      const idX: LiveProjectIdentity = {
        projectKey: openX.projectKey,
        slug: openX.record.slug,
        canonicalCommonDir: openX.record.canonicalCommonDir,
        commonDirSha256: openX.record.commonDirSha256,
        originUrl: openX.record.originUrl,
        rootCommitShas: openX.record.rootCommitShas,
      };
      return {
        stateBase,
        locB,
        idA,
        idB,
        idX,
        stateRootA: openA.stateRoot,
        stateRootB: openB.stateRoot,
        decAB,
        nonProjectBefore,
      };
    }

    // Subcase A: winner completes A -> B during loser's source-lookup openSync -> raw ENOENT caught, returns finished rebind.
    const subA = await setupInterruptedSourceBeforeRebind("open-finished");
    let racedA = false;
    let winnerSnapA: FileSnapshot | undefined;
    const resA = openProject(subA.locB, subA.stateBase, {
      fs: {
        openSync(targetPath, flags, mode) {
          const target = String(targetPath);
          if (
            !racedA &&
            path.dirname(target) === subA.stateRootA &&
            path.basename(target).startsWith(".project.json.tmp.")
          ) {
            racedA = true;
            const winner = openProject(subA.locB, subA.stateBase);
            winnerSnapA = snapshotFile(path.join(winner.stateRoot, PROJECT_RECORD_FILENAME));
          }
          return fs.openSync(targetPath, flags, mode);
        },
      },
    });
    assert.strictEqual(racedA, true);
    assert.strictEqual(resA.projectKey, subA.idB.projectKey);
    assert.strictEqual(resA.rebound, false);
    assert.strictEqual(resA.created, false);
    assert.strictEqual(resA.appliedDecisionId, null);
    assert.deepStrictEqual(resA.record.reboundFrom, [subA.idX.projectKey, subA.idA.projectKey]);
    assert.deepStrictEqual(
      snapshotFile(path.join(resA.stateRoot, PROJECT_RECORD_FILENAME)),
      winnerSnapA,
      "loser returning finished rebind after openSync ENOENT must not rewrite project.json",
    );
    assert.deepStrictEqual(
      snapshotTree(resA.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      subA.nonProjectBefore,
    );

    // Subcase B: winner finishes A and renames A -> B (stops before B's rewrite) during loser's source-lookup openSync.
    const subB = await setupInterruptedSourceBeforeRebind("open-midmove");
    let racedB = false;
    const resB = openProject(subB.locB, subB.stateBase, {
      fs: {
        openSync(targetPath, flags, mode) {
          const target = String(targetPath);
          if (
            !racedB &&
            path.dirname(target) === subB.stateRootA &&
            path.basename(target).startsWith(".project.json.tmp.")
          ) {
            racedB = true;
            try {
              openProject(subB.locB, subB.stateBase, {
                fs: {
                  openSync(innerPath, innerFlags, innerMode) {
                    const inner = String(innerPath);
                    if (
                      path.dirname(inner) === subB.stateRootB &&
                      path.basename(inner).startsWith(".project.json.tmp.")
                    ) {
                      throw new Error("stop_before_b_rewrite");
                    }
                    return fs.openSync(innerPath, innerFlags, innerMode);
                  },
                },
              });
            } catch (err) {
              if (!(err instanceof Error) || err.message !== "stop_before_b_rewrite") {
                throw err;
              }
            }
          }
          return fs.openSync(targetPath, flags, mode);
        },
      },
    });
    assert.strictEqual(racedB, true);
    assert.strictEqual(resB.projectKey, subB.idB.projectKey);
    assert.strictEqual(resB.rebound, true);
    assert.strictEqual(resB.appliedDecisionId, subB.decAB.decision.decisionId);
    assert.strictEqual(resB.record.canonicalCommonDir, subB.idB.canonicalCommonDir);
    assert.deepStrictEqual(resB.record.reboundFrom, [subB.idX.projectKey, subB.idA.projectKey]);
    assert.deepStrictEqual(
      snapshotTree(resB.stateRoot, new Set([PROJECT_RECORD_FILENAME])),
      subB.nonProjectBefore,
    );
    assert.strictEqual(openProject(subB.locB, subB.stateBase).rebound, false);

    // Subcase C: source A vanishes with nothing at B during loser's source-lookup openSync -> named decision_mismatch, never raw ENOENT.
    const subC = await setupInterruptedSourceBeforeRebind("open-vanished");
    let racedC = false;
    const errC = expectIdentityError(
      () =>
        openProject(subC.locB, subC.stateBase, {
          fs: {
            openSync(targetPath, flags, mode) {
              const target = String(targetPath);
              if (
                !racedC &&
                path.dirname(target) === subC.stateRootA &&
                path.basename(target).startsWith(".project.json.tmp.")
              ) {
                racedC = true;
                fs.rmSync(subC.stateRootA, { recursive: true, force: true });
              }
              return fs.openSync(targetPath, flags, mode);
            },
          },
        }),
      "decision_mismatch",
      "source disappearing during openSync with no destination must throw named decision_mismatch, never raw ENOENT",
    );
    assert.strictEqual(racedC, true);
    assert.ok(errC.message.includes(subC.decAB.decisionPath));
    assert.strictEqual(fs.existsSync(subC.stateRootB), false);

    // Subcase D: populated destination appears at B during source-lookup openSync while A stays -> rebind_destination_exists.
    const subD = await setupInterruptedSourceBeforeRebind("open-dest-appeared");
    let racedD = false;
    expectIdentityError(
      () =>
        openProject(subD.locB, subD.stateBase, {
          fs: {
            openSync(targetPath, flags, mode) {
              const target = String(targetPath);
              if (
                !racedD &&
                path.dirname(target) === subD.stateRootA &&
                path.basename(target).startsWith(".project.json.tmp.")
              ) {
                racedD = true;
                fs.mkdirSync(subD.stateRootB, { recursive: true });
                fs.writeFileSync(path.join(subD.stateRootB, "sentinel.txt"), "kept\n", "utf8");
              }
              return fs.openSync(targetPath, flags, mode);
            },
          },
        }),
      "rebind_destination_exists",
      "non-empty destination appearing during source-lookup openSync must refuse with rebind_destination_exists",
    );
    assert.strictEqual(racedD, true);
    assert.strictEqual(fs.readFileSync(path.join(subD.stateRootB, "sentinel.txt"), "utf8"), "kept\n");
    assert.deepStrictEqual(
      snapshotTree(subD.stateRootA, new Set([PROJECT_RECORD_FILENAME])),
      subD.nonProjectBefore,
    );

    // Subcase E: regular file appears at destination right before renameSync (ENOTDIR) -> rebind_destination_exists, never raw ENOTDIR.
    const stateFileBlocker = path.join(scratch, "state-file-blocker");
    const fbOrig = path.join(scratch, "fb-orig");
    const fbMoved = path.join(scratch, "fb-moved");
    runGit(["clone", originRepo, fbOrig]);
    const fbOpenOrig = openProject(fbOrig, stateFileBlocker);
    seedStateFiles(fbOpenOrig.stateRoot);
    fs.renameSync(fbOrig, fbMoved);
    const fbMovedId = resolveProjectIdentity(fbMoved);
    const fbDestRoot = path.join(stateFileBlocker, fbMovedId.projectKey);
    recordIdentityDecision({
      cwd: fbMoved,
      stateBase: stateFileBlocker,
      choice: "rebind",
      oldProjectKey: fbOpenOrig.projectKey,
      decidedBy: "user-r9-file-blocker",
    });
    const beforeFbOld = snapshotTree(fbOpenOrig.stateRoot);
    let racedE = false;
    expectIdentityError(
      () =>
        openProject(fbMoved, stateFileBlocker, {
          fs: {
            renameSync(oldPath, newPath) {
              if (!racedE) {
                racedE = true;
                fs.writeFileSync(String(newPath), "not-a-dir\n", "utf8");
              }
              fs.renameSync(oldPath, newPath);
            },
          },
        }),
      "rebind_destination_exists",
      "regular file appearing before renameSync must refuse with rebind_destination_exists, never raw ENOTDIR",
    );
    assert.strictEqual(racedE, true);
    assert.deepStrictEqual(snapshotTree(fbOpenOrig.stateRoot), beforeFbOld);
    assert.strictEqual(fs.readFileSync(fbDestRoot, "utf8"), "not-a-dir\n");
  });

  test("fix-3 R11: recordIdentityDecision reads each input field once and publishes a decision accepted by openProject", () => {
    const scratch = createScratchDir("fix3-r11");

    // Subcase A: fresh repository, absent state base, new_project with counting getters and a changing decidedBy accessor.
    const freshRepo = path.join(scratch, "fresh-repo");
    const absentStateNew = path.join(scratch, "absent-state-new");
    initRepoWithCommit(freshRepo, { content: "r11 fresh repo\n" });

    let newCwdReads = 0;
    let newStateBaseReads = 0;
    let newChoiceReads = 0;
    let newDecidedByReads = 0;
    let newOldKeyReads = 0;

    const newInput: RecordIdentityDecisionInput = {
      get cwd() {
        newCwdReads += 1;
        return freshRepo;
      },
      get stateBase() {
        newStateBaseReads += 1;
        return absentStateNew;
      },
      get choice() {
        newChoiceReads += 1;
        return "new_project" as const;
      },
      get decidedBy() {
        newDecidedByReads += 1;
        return newDecidedByReads === 1 ? "  user  " : "";
      },
      get oldProjectKey() {
        newOldKeyReads += 1;
        return null;
      },
    };

    const recordedNew = recordIdentityDecision(newInput);
    const openedNew = openProject(freshRepo, absentStateNew);
    assert.strictEqual(openedNew.created, true);
    assert.strictEqual(openedNew.appliedDecisionId, recordedNew.decision.decisionId);

    assert.strictEqual(
      recordedNew.decision.decidedBy,
      "user",
      "returned decision must hold the trimmed first decidedBy value",
    );

    const onDiskNew = JSON.parse(fs.readFileSync(recordedNew.decisionPath, "utf8")) as IdentityDecision;
    assert.strictEqual(
      onDiskNew.decidedBy,
      "user",
      "published decision file must hold the trimmed first decidedBy value",
    );

    assert.strictEqual(newCwdReads, 1, "recordIdentityDecision(new_project) must read input.cwd once");
    assert.strictEqual(
      newStateBaseReads,
      1,
      "recordIdentityDecision(new_project) must read input.stateBase once",
    );
    assert.strictEqual(
      newChoiceReads,
      1,
      "recordIdentityDecision(new_project) must read input.choice once",
    );
    assert.strictEqual(
      newDecidedByReads,
      1,
      "recordIdentityDecision(new_project) must read input.decidedBy once",
    );
    assert.strictEqual(
      newOldKeyReads,
      1,
      "recordIdentityDecision(new_project) must read input.oldProjectKey once",
    );

    // Subcase B: rebind path also reads every input field once (including oldProjectKey).
    const stateRebind = path.join(scratch, "state-rebind");
    const locA = path.join(scratch, "rebind-a");
    const locB = path.join(scratch, "rebind-b");
    initRepoWithCommit(locA, { content: "r11 rebind repo\n" });
    const openA = openProject(locA, stateRebind);
    fs.renameSync(locA, locB);

    let rebCwdReads = 0;
    let rebStateBaseReads = 0;
    let rebChoiceReads = 0;
    let rebDecidedByReads = 0;
    let rebOldKeyReads = 0;

    const rebindInput: RecordIdentityDecisionInput = {
      get cwd() {
        rebCwdReads += 1;
        return locB;
      },
      get stateBase() {
        rebStateBaseReads += 1;
        return stateRebind;
      },
      get choice() {
        rebChoiceReads += 1;
        return "rebind" as const;
      },
      get decidedBy() {
        rebDecidedByReads += 1;
        return rebDecidedByReads === 1 ? "  rebind-user  " : "";
      },
      get oldProjectKey() {
        rebOldKeyReads += 1;
        return openA.projectKey;
      },
    };

    const recordedRebind = recordIdentityDecision(rebindInput);
    const openedRebind = openProject(locB, stateRebind);
    assert.strictEqual(openedRebind.rebound, true);
    assert.strictEqual(openedRebind.appliedDecisionId, recordedRebind.decision.decisionId);

    assert.strictEqual(recordedRebind.decision.decidedBy, "rebind-user");

    const onDiskRebind = JSON.parse(
      fs.readFileSync(recordedRebind.decisionPath, "utf8"),
    ) as IdentityDecision;
    assert.strictEqual(onDiskRebind.decidedBy, "rebind-user");

    assert.strictEqual(rebCwdReads, 1, "recordIdentityDecision(rebind) must read input.cwd once");
    assert.strictEqual(
      rebStateBaseReads,
      1,
      "recordIdentityDecision(rebind) must read input.stateBase once",
    );
    assert.strictEqual(
      rebChoiceReads,
      1,
      "recordIdentityDecision(rebind) must read input.choice once",
    );
    assert.strictEqual(
      rebDecidedByReads,
      1,
      "recordIdentityDecision(rebind) must read input.decidedBy once",
    );
    assert.strictEqual(
      rebOldKeyReads,
      1,
      "recordIdentityDecision(rebind) must read input.oldProjectKey once",
    );
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
            const live = resolveProjectIdentity(cwd);
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
            const live = resolveProjectIdentity(cwd);
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
            const live = resolveProjectIdentity(cwd);
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
      recordIdentityDecision(input) {
        try {
          return recordIdentityDecision(input);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "decision_candidate_not_found") {
            const live = resolveProjectIdentity(input.cwd);
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
      recordIdentityDecision(input) {
        try {
          return recordIdentityDecision(input);
        } catch (err) {
          if (err instanceof IdentityError && err.code === "decision_exists") {
            const live = resolveProjectIdentity(input.cwd);
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
