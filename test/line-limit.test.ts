import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  assertTrackedFileLineLimits,
  checkTrackedFileLineLimits,
  countLines,
  formatLineLimitViolations,
  MAX_TRACKED_FILE_LINES,
  REPO_ROOT,
} from "./helpers/line-limit.ts";

assertSupportedBunVersion(Bun.version);

const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SUPER_PREFIX",
  "GIT_CEILING_DIRECTORIES",
] as const;

function runGit(cwd: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  const res = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (status=${String(res.status)}): ${(res.stderr ?? "").trim()}`,
    );
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-captain-line-limit-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeAndStageFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  runGit(repoDir, ["add", "--", relPath]);
}

function makeLines(count: number, trailingNewline: boolean): string {
  if (count === 0) {
    return "";
  }
  const body = Array.from({ length: count }, (_, idx) => `line-${idx + 1}`).join("\n");
  return trailingNewline ? `${body}\n` : body;
}

describe("Tracked file 1,000-line limit", () => {
  test("every tracked file under src/ and test/ is at 1,000 lines or fewer", () => {
    const result = assertTrackedFileLineLimits(REPO_ROOT, MAX_TRACKED_FILE_LINES, (line) => {
      process.stderr.write(`${line}\n`);
    });
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.files.some((entry) => entry.path.startsWith("src/"))).toBe(true);
    expect(result.files.some((entry) => entry.path.startsWith("test/"))).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("countLines counts newline characters plus one when the last line has no newline", () => {
    expect(countLines(Buffer.from(""))).toBe(0);
    expect(countLines(Buffer.from("a"))).toBe(1);
    expect(countLines(Buffer.from("\n"))).toBe(1);
    expect(countLines(Buffer.from("a\n"))).toBe(1);
    expect(countLines(Buffer.from("a\nb"))).toBe(2);
    expect(countLines(Buffer.from("a\nb\n"))).toBe(2);
    expect(countLines(Buffer.from("a\r\nb\r\n"))).toBe(2);
    expect(countLines(Buffer.from("a\r\nb"))).toBe(2);
    expect(countLines(Buffer.from(makeLines(1000, true)))).toBe(1000);
    expect(countLines(Buffer.from(makeLines(1000, false)))).toBe(1000);
    expect(countLines(Buffer.from(makeLines(1001, true)))).toBe(1001);
    expect(countLines(Buffer.from(makeLines(1001, false)))).toBe(1001);
  });

  test("passes 1,000-line tracked files and fails 1,001-line tracked files with the Fix message", () => {
    withTempDir((repoDir) => {
      runGit(repoDir, ["init", "-q"]);
      writeAndStageFile(repoDir, "test/at-limit.ts", makeLines(1000, true));
      writeAndStageFile(repoDir, "src/at-limit-no-nl.ts", makeLines(1000, false));

      const passing = assertTrackedFileLineLimits(repoDir);
      expect(passing.checkedCount).toBe(2);
      expect(passing.violations).toEqual([]);

      writeAndStageFile(repoDir, "test/over-limit.ts", makeLines(1001, true));
      const printedSingle: string[] = [];
      expect(() =>
        assertTrackedFileLineLimits(repoDir, MAX_TRACKED_FILE_LINES, (line) => {
          printedSingle.push(line);
        }),
      ).toThrow(/^Fix: split test\/over-limit\.ts \(1001 lines, limit 1000\)$/);
      expect(printedSingle).toEqual(["Fix: split test/over-limit.ts (1001 lines, limit 1000)"]);

      writeAndStageFile(repoDir, "src/over-no-nl.ts", makeLines(1001, false));
      const checkMulti = checkTrackedFileLineLimits(repoDir);
      expect(formatLineLimitViolations(checkMulti.violations)).toEqual([
        "Fix: split src/over-no-nl.ts (1001 lines, limit 1000)",
        "Fix: split test/over-limit.ts (1001 lines, limit 1000)",
      ]);

      const printedMulti: string[] = [];
      expect(() =>
        assertTrackedFileLineLimits(repoDir, MAX_TRACKED_FILE_LINES, (line) => {
          printedMulti.push(line);
        }),
      ).toThrow(
        "Fix: split src/over-no-nl.ts (1001 lines, limit 1000)\nFix: split test/over-limit.ts (1001 lines, limit 1000)",
      );
      expect(printedMulti).toEqual([
        "Fix: split src/over-no-nl.ts (1001 lines, limit 1000)",
        "Fix: split test/over-limit.ts (1001 lines, limit 1000)",
      ]);
    });
  });

  test("checks every tracked file under src/ and test/ regardless of extension and ignores untracked files or other roots", () => {
    withTempDir((repoDir) => {
      runGit(repoDir, ["init", "-q"]);
      writeAndStageFile(repoDir, "docs/long-doc.md", makeLines(1005, true));
      writeAndStageFile(repoDir, "test/ok.ts", makeLines(10, true));

      // Untracked file over the limit under test/ is not listed by git ls-files.
      fs.writeFileSync(path.join(repoDir, "test", "untracked.ts"), makeLines(1005, true), "utf8");
      expect(assertTrackedFileLineLimits(repoDir).checkedCount).toBe(1);

      // Non-.ts tracked files (including paths with spaces) under src/ and test/ are checked.
      writeAndStageFile(repoDir, "test/fixture.txt", makeLines(1001, true));
      writeAndStageFile(repoDir, "src/has space.json", makeLines(1002, false));

      const printed: string[] = [];
      expect(() =>
        assertTrackedFileLineLimits(repoDir, MAX_TRACKED_FILE_LINES, (line) => {
          printed.push(line);
        }),
      ).toThrow();
      expect(printed).toEqual([
        "Fix: split src/has space.json (1002 lines, limit 1000)",
        "Fix: split test/fixture.txt (1001 lines, limit 1000)",
      ]);
    });
  });

  test("fails closed with a clear reason when file list is empty, unreadable, or git fails", () => {
    // 1. Tracked files exist outside src/ and test/, leaving src/ and test/ empty.
    withTempDir((repoDir) => {
      runGit(repoDir, ["init", "-q"]);
      writeAndStageFile(repoDir, "README.md", "hello\n");
      expect(() => checkTrackedFileLineLimits(repoDir)).toThrow(
        /no tracked files under src\/ or test\//,
      );
    });

    // 2. Non-git directory fails (never silently succeeds or walks up to an enclosing repo).
    withTempDir((nonGitDir) => {
      fs.mkdirSync(path.join(nonGitDir, "test"), { recursive: true });
      fs.writeFileSync(path.join(nonGitDir, "test", "a.ts"), "export {};\n", "utf8");
      expect(() => checkTrackedFileLineLimits(nonGitDir)).toThrow(/git ls-files failed/);
    });

    // 3. Missing directory fails.
    withTempDir((tmpDir) => {
      const missingDir = path.join(tmpDir, "does-not-exist");
      expect(() => checkTrackedFileLineLimits(missingDir)).toThrow(/Cannot read repository root/);
    });

    // 4. Missing git executable fails.
    withTempDir((tmpDir) => {
      const emptyBin = path.join(tmpDir, "empty-bin");
      fs.mkdirSync(emptyBin, { recursive: true });
      const originalPath = process.env.PATH ?? "";
      process.env.PATH = emptyBin;
      try {
        expect(() => checkTrackedFileLineLimits(REPO_ROOT)).toThrow(/Failed to run git ls-files/);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    // 5. Tracked file missing from disk fails closed instead of being skipped.
    withTempDir((repoDir) => {
      runGit(repoDir, ["init", "-q"]);
      writeAndStageFile(repoDir, "test/vanished.ts", "export {};\n");
      fs.unlinkSync(path.join(repoDir, "test", "vanished.ts"));
      expect(() => checkTrackedFileLineLimits(repoDir)).toThrow(
        /Cannot read tracked file test\/vanished\.ts/,
      );
    });
  });
});
