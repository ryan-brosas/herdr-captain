import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { getGlobalLeaseRegistry } from "../../src/lease.ts";
import { ProcessTracker } from "./process.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEASE_SOURCE_PATH = path.resolve(HERE, "..", "..", "src", "lease.ts");

export function makeStatLine(
  pid: number,
  comm: string,
  state: string,
  startTime: string,
  ppid = 0,
): string {
  // Linux /proc/<pid>/stat: fields 3..22 after ") " -> state is field[0], ppid is field[1], starttime is field[19].
  const middle = [String(ppid), ...Array.from({ length: 17 }, () => "0")].join(" ");
  return `${pid} (${comm}) ${state} ${middle} ${startTime} 0 0\n`;
}

export interface FixtureProcEntry {
  pid: number;
  stat?: string;
  statMode?: number;
  environ?: string;
  environMode?: number;
  uids?: [number, number, number, number];
  statusRaw?: string;
  statusMode?: number;
  uidMap?: string;
}

export function createFixtureProcRoot(
  procRoot: string,
  selfStartTime: string,
  entries: FixtureProcEntry[],
  selfUidMap?: string,
  selfPpid = 0,
): { procRoot: string; restoreModes: () => void } {
  const chmodPaths: string[] = [];
  const selfStatLine = makeStatLine(process.pid, "bun", "R", selfStartTime, selfPpid);
  fs.mkdirSync(path.join(procRoot, "self"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "self", "stat"), selfStatLine, "utf8");
  fs.writeFileSync(path.join(procRoot, "self", "environ"), "PATH=/usr/bin\0", "utf8");
  if (selfUidMap !== undefined) {
    fs.writeFileSync(path.join(procRoot, "self", "uid_map"), selfUidMap, "utf8");
  }
  if (selfPpid > 0) {
    const selfPidDir = path.join(procRoot, String(process.pid));
    fs.mkdirSync(selfPidDir, { recursive: true });
    fs.writeFileSync(path.join(selfPidDir, "stat"), selfStatLine, "utf8");
    fs.writeFileSync(path.join(selfPidDir, "environ"), "PATH=/usr/bin\0", "utf8");
    if (selfUidMap !== undefined) {
      fs.writeFileSync(path.join(selfPidDir, "uid_map"), selfUidMap, "utf8");
    }
  }

  for (const entry of entries) {
    const pidDir = path.join(procRoot, String(entry.pid));
    fs.mkdirSync(pidDir, { recursive: true });
    if (entry.statusRaw !== undefined || entry.uids !== undefined) {
      const statusPath = path.join(pidDir, "status");
      const statusContent =
        entry.statusRaw ?? `Name:\tfixture\nUid:\t${entry.uids?.join("\t")}\n`;
      fs.writeFileSync(statusPath, statusContent, "utf8");
      if (entry.statusMode !== undefined) {
        fs.chmodSync(statusPath, entry.statusMode);
        chmodPaths.push(statusPath);
      }
    }
    if (entry.uidMap !== undefined) {
      fs.writeFileSync(path.join(pidDir, "uid_map"), entry.uidMap, "utf8");
    }
    if (entry.stat !== undefined) {
      const statPath = path.join(pidDir, "stat");
      fs.writeFileSync(statPath, entry.stat, "utf8");
      if (entry.statMode !== undefined) {
        fs.chmodSync(statPath, entry.statMode);
        chmodPaths.push(statPath);
      }
    }
    if (entry.environ !== undefined) {
      const envPath = path.join(pidDir, "environ");
      fs.writeFileSync(envPath, entry.environ, "utf8");
      if (entry.environMode !== undefined) {
        fs.chmodSync(envPath, entry.environMode);
        chmodPaths.push(envPath);
      }
    }
  }

  return {
    procRoot,
    restoreModes: () => {
      for (const filePath of chmodPaths) {
        try {
          fs.chmodSync(filePath, 0o644);
        } catch {
          // Ignore if already removed.
        }
      }
    },
  };
}

export function makeFakeFlockScript(binDir: string, scriptBody: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const flockPath = path.join(binDir, "flock");
  fs.writeFileSync(flockPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return flockPath;
}

export async function waitUntilCondition(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function runBunSubprocess(
  tracker: ProcessTracker,
  scratchRoot: string,
  scriptPath: string,
  args: string[] = [],
  options: {
    extraEnv?: Record<string, string>;
    timeoutMs?: number;
    killWhenFileExists?: string;
  } = {},
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  ctrlToken: string;
  runTmpDir: string | null;
  stoppedByController: Array<{ pid: number; startTime: string }>;
}> {
  const { extraEnv, timeoutMs = 15000, killWhenFileExists } = options;
  const ctrlToken = `herdr-s1a-ctrl-${crypto.randomUUID()}`;
  tracker.registerEnvToken("HERDR_S1A_CTRL_TOKEN", ctrlToken);

  const ownsTmpDir = !(extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, "TMPDIR"));
  const runTmpDir = ownsTmpDir ? fs.mkdtempSync(path.join(scratchRoot, "sub-tmp-")) : null;
  if (runTmpDir !== null) {
    tracker.registerScratchDir(runTmpDir);
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: Error } = {
    code: null,
    signal: null,
  };
  let stoppedByController: Array<{ pid: number; startTime: string }> = [];

  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(runTmpDir !== null ? { TMPDIR: runTmpDir } : {}),
      ...(extraEnv ?? {}),
      HERDR_S1A_CTRL_TOKEN: ctrlToken,
    },
  });
  const tracked = tracker.trackChild(child);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  let watcherActive = true;
  const killChildOnTimeout = (): void => {
    if (tracked.hasExited()) {
      return;
    }
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore ESRCH if exited concurrently.
    }
  };

  const timer = setTimeout(killChildOnTimeout, timeoutMs);

  let fileKillPromise: Promise<void> | undefined;
  if (killWhenFileExists) {
    fileKillPromise = (async () => {
      const deadline = performance.now() + timeoutMs;
      while (watcherActive && !tracked.hasExited() && performance.now() < deadline) {
        if (fs.existsSync(killWhenFileExists)) {
          try {
            const raw = fs.readFileSync(killWhenFileExists, "utf8");
            if (raw.endsWith("\n")) {
              killChildOnTimeout();
              return;
            }
          } catch {
            // File may still be finishing write.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
  }

  try {
    exitInfo = await tracked.exited;
  } finally {
    watcherActive = false;
    clearTimeout(timer);
    if (fileKillPromise) {
      await fileKillPromise;
    }
    await tracked.ensureStopped();
    stoppedByController = await tracker.stopAndRetireEnvToken("HERDR_S1A_CTRL_TOKEN", ctrlToken);
    if (runTmpDir !== null) {
      fs.rmSync(runTmpDir, { recursive: true, force: true });
      tracker.scratchDirs.delete(runTmpDir);
    }
  }

  if (exitInfo.error) {
    throw exitInfo.error;
  }

  return {
    status: exitInfo.code,
    signal: exitInfo.signal,
    timedOut,
    stdout,
    stderr,
    ctrlToken,
    runTmpDir,
    stoppedByController,
  };
}

export function setupLeaseSuiteHooks(
  onScratchRoot: (dir: string) => void,
  prefix = "herdr-captain-s1a-",
): ProcessTracker {
  const suiteTracker = new ProcessTracker();

  beforeEach(() => {
    onScratchRoot(suiteTracker.createScratchDir(prefix));
  });

  afterEach(async () => {
    const registry = getGlobalLeaseRegistry();
    for (const [, entry] of [...registry.entries()]) {
      try {
        await entry.revokeAndClose();
      } catch {
        // Best-effort cleanup before strict tracker verification.
      }
    }
    registry.clear();
    await suiteTracker.cleanupAll();
    expect(suiteTracker.ownedChildren.size).toBe(0);
    expect(suiteTracker.trackedExternals.size).toBe(0);
    expect(suiteTracker.activeEnvTokens.size).toBe(0);
    expect(suiteTracker.scratchDirs.size).toBe(0);
  });

  afterAll(() => {
    suiteTracker.dispose();
  });

  return suiteTracker;
}
