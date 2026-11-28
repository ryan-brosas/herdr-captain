import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_TRACKED_FILE_LINES = 1000;
export const CHECKED_PATHSPECS = ["src/", "test/"] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SUPER_PREFIX",
] as const;

export interface TrackedFileLineCount {
  readonly path: string;
  readonly lines: number;
}

export interface LineLimitCheckResult {
  readonly repoRoot: string;
  readonly limit: number;
  readonly checkedCount: number;
  readonly files: readonly TrackedFileLineCount[];
  readonly violations: readonly TrackedFileLineCount[];
}

/**
 * Counts lines in raw file bytes: the number of newline characters (`\n`),
 * plus one when the file is non-empty and its last byte is not `\n`.
 */
export function countLines(content: Buffer | Uint8Array): number {
  if (content.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === 0x0a) {
      newlines += 1;
    }
  }
  return content[content.length - 1] === 0x0a ? newlines : newlines + 1;
}

function buildIsolatedGitEnv(resolvedRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }

  const ceilings = new Set<string>();
  const logicalParent = path.dirname(resolvedRoot);
  if (logicalParent !== resolvedRoot) {
    ceilings.add(logicalParent);
  }
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realParent = path.dirname(realRoot);
    if (realParent !== realRoot) {
      ceilings.add(realParent);
    }
  } catch {
    // Let directory validation or git report the root error.
  }

  if (ceilings.size > 0) {
    env.GIT_CEILING_DIRECTORIES = [...ceilings].join(path.delimiter);
  } else {
    delete env.GIT_CEILING_DIRECTORIES;
  }
  return env;
}

export function listTrackedSourceAndTestFiles(repoRoot: string = REPO_ROOT): string[] {
  const resolvedRoot = path.resolve(repoRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedRoot);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read repository root ${resolvedRoot}: ${message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Repository root is not a directory: ${resolvedRoot}`);
  }

  const res = spawnSync("git", ["ls-files", "-z", "--", ...CHECKED_PATHSPECS], {
    cwd: resolvedRoot,
    env: buildIsolatedGitEnv(resolvedRoot),
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`Failed to run git ls-files in ${resolvedRoot}: ${res.error.message}`);
  }
  if (res.signal !== null || res.status !== 0) {
    const stderr = (res.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(
      `git ls-files failed in ${resolvedRoot} (status=${String(res.status)}, signal=${String(res.signal)})${stderr.length > 0 ? `: ${stderr}` : ""}`,
    );
  }

  const rawStdout = (res.stdout ?? Buffer.alloc(0)).toString("utf8");
  const files = [...new Set(rawStdout.split("\0").filter((entry) => entry.length > 0))];
  if (files.length === 0) {
    throw new Error(`git ls-files returned no tracked files under src/ or test/ in ${resolvedRoot}`);
  }

  return files;
}

export function formatLineLimitViolations(
  violations: readonly TrackedFileLineCount[],
  limit: number = MAX_TRACKED_FILE_LINES,
): string[] {
  return violations.map(
    (entry) => `Fix: split ${entry.path} (${entry.lines} lines, limit ${limit})`,
  );
}

export function checkTrackedFileLineLimits(
  repoRoot: string = REPO_ROOT,
  limit: number = MAX_TRACKED_FILE_LINES,
): LineLimitCheckResult {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Invalid line limit: ${String(limit)}`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const paths = listTrackedSourceAndTestFiles(resolvedRoot);
  const files: TrackedFileLineCount[] = [];
  const violations: TrackedFileLineCount[] = [];

  for (const relPath of paths) {
    const fullPath = path.join(resolvedRoot, relPath);
    let content: Buffer;
    try {
      content = fs.readFileSync(fullPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read tracked file ${relPath} in ${resolvedRoot}: ${message}`);
    }
    const lines = countLines(content);
    const entry: TrackedFileLineCount = { path: relPath, lines };
    files.push(entry);
    if (lines > limit) {
      violations.push(entry);
    }
  }

  return {
    repoRoot: resolvedRoot,
    limit,
    checkedCount: files.length,
    files,
    violations,
  };
}

export function assertTrackedFileLineLimits(
  repoRoot: string = REPO_ROOT,
  limit: number = MAX_TRACKED_FILE_LINES,
  onViolationLine?: (line: string) => void,
): LineLimitCheckResult {
  const result = checkTrackedFileLineLimits(repoRoot, limit);
  if (result.violations.length > 0) {
    const messages = formatLineLimitViolations(result.violations, limit);
    if (onViolationLine) {
      for (const message of messages) {
        onViolationLine(message);
      }
    }
    throw new Error(messages.join("\n"));
  }
  return result;
}
