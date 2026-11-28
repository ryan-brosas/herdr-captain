import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  claimProject,
  PROJECT_RECORD_FILENAME,
  type ClaimProjectResult,
  type IdentityFsOps,
} from "../../src/identity.ts";
import { readOwnerRecord, readProcessStat } from "../../src/lease.ts";
import { makeRepoUnborn } from "./identity-fixtures.ts";
import { formatError } from "./process.ts";

const CONTROL_FD = 3;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${String(token)}`);
    }
    const key = token.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = val;
    i += 1;
  }
  return args;
}

function emitSync(obj: Record<string, unknown>): void {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`);
}

function readControlLineSync(): string {
  const buf = Buffer.alloc(1);
  let line = "";
  while (true) {
    const bytesRead = fs.readSync(CONTROL_FD, buf, 0, 1, null);
    if (bytesRead === 0) {
      return line.trim();
    }
    const ch = buf.toString("utf8", 0, 1);
    if (ch === "\n") {
      return line.trim();
    }
    line += ch;
  }
}

function getErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

function readHolderIdentityFromStateDir(
  stateRoot: string,
  expectedOwnerPid?: number,
): {
  holderPid: number | null;
  holderStartTime: string | null;
} {
  try {
    const owner = readOwnerRecord(stateRoot);
    if (owner === null) {
      return { holderPid: null, holderStartTime: null };
    }
    if (expectedOwnerPid !== undefined && owner.pid !== expectedOwnerPid) {
      return { holderPid: null, holderStartTime: null };
    }
    const startTime = readProcessStat(owner.holderPid)?.startTime ?? null;
    return { holderPid: owner.holderPid, holderStartTime: startTime };
  } catch {
    return { holderPid: null, holderStartTime: null };
  }
}

interface HookTelemetry {
  linkErrno: string | null;
  linkSucceeded: boolean;
  holderPid: number | null;
  holderStartTime: string | null;
}

function buildPausedFsOps(
  pauseAt: string | undefined,
  workerId: string,
  cwd: string,
  stateBase: string,
  swapTarget: string | undefined,
  selfStartTime: string | null,
  telemetry: HookTelemetry,
): Partial<IdentityFsOps> | undefined {
  if (!pauseAt) {
    return undefined;
  }

  let pausedOnce = false;
  let realpathCalls = 0;
  let verifyFd: number | null = null;

  const resolveOwnerFromDir = (targetPath: string): void => {
    const owner = readHolderIdentityFromStateDir(path.dirname(targetPath));
    if (owner.holderPid !== null) {
      telemetry.holderPid = owner.holderPid;
      telemetry.holderStartTime = owner.holderStartTime;
    }
  };

  if (pauseAt === "after-lease") {
    return {
      openSync(targetPath, flags, mode) {
        const pathStr = String(targetPath);
        if (!pausedOnce && path.basename(pathStr).startsWith(`.${PROJECT_RECORD_FILENAME}.tmp.`)) {
          pausedOnce = true;
          resolveOwnerFromDir(pathStr);
          emitSync({
            event: "paused",
            workerId,
            point: "after-lease",
            tmpPath: pathStr,
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
          readControlLineSync();
        }
        return fs.openSync(targetPath, flags, mode);
      },
    };
  }

  if (pauseAt === "before-link") {
    return {
      linkSync(existingPath, newPath) {
        const tmpStr = String(existingPath);
        const targetStr = String(newPath);
        if (!pausedOnce && path.basename(targetStr) === PROJECT_RECORD_FILENAME) {
          pausedOnce = true;
          resolveOwnerFromDir(targetStr);
          emitSync({
            event: "paused",
            workerId,
            point: "before-link",
            tmpPath: tmpStr,
            targetPath: targetStr,
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
          readControlLineSync();
        }
        try {
          fs.linkSync(existingPath, newPath);
          telemetry.linkSucceeded = true;
        } catch (err) {
          telemetry.linkErrno = getErrorCode(err);
          throw err;
        }
      },
    };
  }

  if (pauseAt === "before-unlink") {
    return {
      unlinkSync(targetPath) {
        const tmpStr = String(targetPath);
        if (!pausedOnce && path.basename(tmpStr).startsWith(`.${PROJECT_RECORD_FILENAME}.tmp.`)) {
          pausedOnce = true;
          resolveOwnerFromDir(tmpStr);
          emitSync({
            event: "paused",
            workerId,
            point: "before-unlink",
            tmpPath: tmpStr,
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
          readControlLineSync();
        }
        fs.unlinkSync(targetPath);
      },
    };
  }

  if (pauseAt === "during-verify") {
    return {
      openSync(targetPath, flags, mode) {
        const fd = fs.openSync(targetPath, flags, mode);
        const pathStr = String(targetPath);
        if (!pausedOnce && path.basename(pathStr) === PROJECT_RECORD_FILENAME) {
          verifyFd = fd;
          resolveOwnerFromDir(pathStr);
        }
        return fd;
      },
      readFileSync(fdOrPath, options) {
        if (!pausedOnce && verifyFd !== null && fdOrPath === verifyFd) {
          pausedOnce = true;
          emitSync({
            event: "paused",
            workerId,
            point: "during-verify",
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
          readControlLineSync();
        }
        return fs.readFileSync(fdOrPath, options as never);
      },
    };
  }

  if (pauseAt === "step4-make-unborn") {
    return {
      realpathSync: ((targetPath: fs.PathLike, options?: fs.EncodingOption) => {
        realpathCalls += 1;
        if (!pausedOnce && realpathCalls === 3) {
          pausedOnce = true;
          const dirs = fs.existsSync(stateBase) ? fs.readdirSync(stateBase) : [];
          for (const dir of dirs) {
            const candidate = readHolderIdentityFromStateDir(
              path.join(stateBase, dir),
              process.pid,
            );
            if (candidate.holderPid !== null) {
              telemetry.holderPid = candidate.holderPid;
              telemetry.holderStartTime = candidate.holderStartTime;
              break;
            }
          }
          makeRepoUnborn(cwd);
          emitSync({
            event: "step4_mutated",
            mutation: "make-unborn",
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
        }
        return fs.realpathSync(targetPath, options as never);
      }) as typeof fs.realpathSync,
    };
  }

  if (pauseAt === "step4-swap-cwd") {
    if (!swapTarget) {
      throw new Error("--pause-at step4-swap-cwd requires --swap-target");
    }
    return {
      realpathSync: ((targetPath: fs.PathLike, options?: fs.EncodingOption) => {
        realpathCalls += 1;
        if (!pausedOnce && realpathCalls === 3) {
          pausedOnce = true;
          const dirs = fs.existsSync(stateBase) ? fs.readdirSync(stateBase) : [];
          for (const dir of dirs) {
            const candidate = readHolderIdentityFromStateDir(
              path.join(stateBase, dir),
              process.pid,
            );
            if (candidate.holderPid !== null) {
              telemetry.holderPid = candidate.holderPid;
              telemetry.holderStartTime = candidate.holderStartTime;
              break;
            }
          }
          fs.unlinkSync(cwd);
          fs.symlinkSync(swapTarget, cwd);
          emitSync({
            event: "step4_mutated",
            mutation: "swap-cwd",
            pid: process.pid,
            startTime: selfStartTime,
            holderPid: telemetry.holderPid,
            holderStartTime: telemetry.holderStartTime,
          });
        }
        return fs.realpathSync(targetPath, options as never);
      }) as typeof fs.realpathSync,
    };
  }

  throw new Error(`Unknown --pause-at value: ${pauseAt}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd;
  const stateBase = args["state-base"];
  const workerId = args["worker-id"] ?? "worker";
  const waitBeforeClaim = args["wait-before-claim"] === "1";
  const holdAfterClaim = args["hold-after-claim"] === "1";
  const stayAliveOnError = args["stay-alive-on-error"] === "1";
  const pauseAt = args["pause-at"];
  const swapTarget = args["swap-target"];

  if (!cwd || !stateBase) {
    throw new Error("Provide --cwd and --state-base");
  }

  const selfStartTime = readProcessStat(process.pid)?.startTime ?? null;
  const rl = readline.createInterface({ input: process.stdin });
  const commandQueue: string[] = [];
  const commandWaiters: Array<(line: string | null) => void> = [];
  let stdinClosed = false;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    const waiter = commandWaiters.shift();
    if (waiter) {
      waiter(trimmed);
    } else {
      commandQueue.push(trimmed);
    }
  });
  rl.on("close", () => {
    stdinClosed = true;
    while (commandWaiters.length > 0) {
      commandWaiters.shift()?.(null);
    }
  });

  const nextCommand = (): Promise<string | null> => {
    const queued = commandQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (stdinClosed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      commandWaiters.push(resolve);
    });
  };

  let activeResult: ClaimProjectResult | null = null;

  const runSingleClaim = async (usePauseHooks: boolean): Promise<void> => {
    const telemetry: HookTelemetry = {
      linkErrno: null,
      linkSucceeded: false,
      holderPid: null,
      holderStartTime: null,
    };
    const fsOps = usePauseHooks
      ? buildPausedFsOps(pauseAt, workerId, cwd, stateBase, swapTarget, selfStartTime, telemetry)
      : undefined;

    try {
      const result = await claimProject(cwd, stateBase, fsOps ? { fs: fsOps } : undefined);
      activeResult = result;
      emitSync({
        event: "claimed",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
        projectKey: result.projectKey,
        stateRoot: result.stateRoot,
        epoch: result.lease.epoch,
        holderPid: result.lease.holderPid,
        holderStartTime: result.lease.holderStartTime,
        published: result.published,
        record: result.record,
        originWarning: result.originWarning,
        linkErrno: telemetry.linkErrno,
        linkSucceeded: telemetry.linkSucceeded,
      });
    } catch (err) {
      emitSync({
        event: "claim_failed",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
        code: getErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
        linkErrno: telemetry.linkErrno,
        linkSucceeded: telemetry.linkSucceeded,
        holderPid: telemetry.holderPid,
        holderStartTime: telemetry.holderStartTime,
      });
    }
  };

  try {
    if (waitBeforeClaim) {
      emitSync({
        event: "at_barrier",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
      });
      const cmd = await nextCommand();
      if (cmd !== "go") {
        return;
      }
    }

    await runSingleClaim(true);

    if (activeResult !== null && !holdAfterClaim) {
      const toRelease = activeResult;
      activeResult = null;
      await toRelease.lease.release();
      emitSync({
        event: "released",
        workerId,
        pid: process.pid,
        holderPid: toRelease.lease.holderPid,
        epoch: toRelease.lease.epoch,
      });
      return;
    }

    if (activeResult === null && !stayAliveOnError) {
      return;
    }

    while (true) {
      const cmd = await nextCommand();
      if (cmd === null || cmd === "exit") {
        break;
      }
      if (cmd === "release") {
        if (activeResult !== null) {
          const toRelease = activeResult;
          activeResult = null;
          await toRelease.lease.release();
          emitSync({
            event: "released",
            workerId,
            pid: process.pid,
            holderPid: toRelease.lease.holderPid,
            epoch: toRelease.lease.epoch,
          });
        }
        continue;
      }
      if (cmd === "claim_again") {
        await runSingleClaim(false);
        continue;
      }
    }
  } finally {
    if (activeResult !== null) {
      const toRelease = activeResult;
      activeResult = null;
      await toRelease.lease.release();
    }
    rl.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(1);
});
