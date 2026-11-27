import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquireLease, LeaseError, readProcessStat, type OwnerLease } from "../../src/lease.ts";
import { formatError, inspectFds } from "./process.ts";

interface ChildHandle {
  child: ChildProcess;
  pid: number;
  startTime: string | null;
  hasExited: () => boolean;
  exitedPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  stopAndWait: () => Promise<void>;
}

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

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writePidFileAtomic(filePath: string, data: Record<string, unknown>): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function spawnDetachedSurvivingChild(
  onHandleCreated: (handle: ChildHandle) => void,
  onChildTracked: (handle: ChildHandle) => void,
  fault: string | null,
  observedFile: string | null,
): Promise<ChildHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", 'printf "child_ready\\n"; exec sleep 60 >/dev/null 2>&1'], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let childExited = false;
    let resolveExited!: (info: {
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }) => void;
    const exitedPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((res) => {
      resolveExited = res;
    });
    const markExited = (info: {
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }): void => {
      if (!childExited) {
        childExited = true;
        resolveExited(info);
      }
    };
    child.once("exit", (code, signal) => {
      markExited({ code, signal });
    });

    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      reject(new Error("Detached child failed to produce a valid PID"));
      return;
    }

    const handle: ChildHandle = {
      child,
      pid,
      startTime: null,
      hasExited: () => childExited,
      exitedPromise,
      async stopAndWait() {
        if (!childExited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore ESRCH if child exited concurrently.
          }
          await exitedPromise;
        }
      },
    };

    // Establish raw-handle cleanup ownership immediately after spawn, before any fallible call.
    onHandleCreated(handle);

    let stdoutBuf = "";
    let sawReady = false;
    let settled = false;

    const finishReject = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    child.once("error", (err) => {
      markExited({ code: null, signal: null, error: err });
      finishReject(err);
    });

    try {
      const observedStart = readProcessStat(pid)?.startTime ?? null;
      if (fault === "fail-after-child-spawn") {
        if (observedFile) {
          writePidFileAtomic(observedFile, { pid, startTime: observedStart });
        }
        throw new Error("forced_readProcessStat_failure_after_spawn");
      }
      handle.startTime = observedStart;
      onChildTracked(handle);
    } catch (err) {
      finishReject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdoutBuf.includes("child_ready\n")) {
        sawReady = true;
      }
    });

    // Wait for stdout EOF so `exec sleep 60 >/dev/null 2>&1` has completed and closed the pipe.
    child.stdout?.once("end", () => {
      if (settled) {
        return;
      }
      if (!sawReady) {
        finishReject(new Error("Detached child closed stdout before printing child_ready"));
        return;
      }
      settled = true;
      child.unref();
      resolve(handle);
    });

    child.once("exit", (code, signal) => {
      if (!sawReady) {
        finishReject(new Error(`Detached child exited early (code=${code}, signal=${signal})`));
      }
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "hold";
  const childPidFile = args["child-pid-file"] || null;
  const fault = args.fault || null;
  const observedFile = args["observed-file"] || null;
  const projectKey = args["project-key"];
  const stateRoot = args["state-root"];

  if (!projectKey || !stateRoot) {
    throw new Error("Provide --state-root and --project-key");
  }

  const beforeFds =
    mode === "hold-with-child"
      ? new Map(inspectFds("self").map((x) => [x.fd, x.target]))
      : null;

  let lease: OwnerLease | null = null;
  let ownedChild: ChildHandle | null = null;
  let childHandedOff = false;

  const cleanupBeforeHandoff = async (): Promise<void> => {
    if (!childHandedOff && ownedChild !== null) {
      await ownedChild.stopAndWait();
      ownedChild = null;
      if (childPidFile) {
        try {
          fs.rmSync(childPidFile, { force: true });
        } catch {
          // Ignore removal error on cleanup.
        }
      }
    }
    if (lease !== null) {
      await lease.release();
      lease = null;
    }
  };

  try {
    try {
      lease = await acquireLease({ projectKey, stateRoot });
    } catch (err) {
      if (err instanceof LeaseError) {
        emit({
          event: "acquire_failed",
          code: err.code,
          message: err.message,
          pid: process.pid,
          projectKey,
          stateRoot,
        });
        process.exit(err.code === "owner_conflict" ? 2 : 3);
      }
      throw err;
    }

    if (mode === "try-once") {
      emit({
        event: "acquired",
        pid: lease.pid,
        holderPid: lease.holderPid,
        holderStartTime: lease.holderStartTime,
        epoch: lease.epoch,
        projectKey: lease.projectKey,
        stateRoot: lease.stateRoot,
        ownerRecord: lease.ownerRecord,
      });
      await lease.release();
      lease = null;
      process.exit(0);
    }

    if (mode === "hold-with-child") {
      const afterFds = inspectFds("self");
      const newParentFds = afterFds.filter((x) => beforeFds?.get(x.fd) !== x.target);

      const childHandle = await spawnDetachedSurvivingChild(
        (handle) => {
          ownedChild = handle;
        },
        (handle) => {
          if (fault === "hang-before-publish") {
            handle.child.stdout?.once("end", () => {
              if (observedFile) {
                writePidFileAtomic(observedFile, {
                  pid: handle.pid,
                  startTime: handle.startTime,
                  childPidFileExists: childPidFile ? fs.existsSync(childPidFile) : false,
                });
              }
            });
            return;
          }
          if (childPidFile) {
            writePidFileAtomic(childPidFile, {
              pid: handle.pid,
              startTime: handle.startTime,
            });
          }
          emit({
            event: "child_spawned",
            pid: lease?.pid,
            holderPid: lease?.holderPid,
            holderStartTime: lease?.holderStartTime,
            childPid: handle.pid,
            childStartTime: handle.startTime,
          });
        },
        fault,
        observedFile,
      );

      if (fault === "hang-before-publish") {
        await new Promise(() => {});
      }

      if (fault === "hang-after-child-ready") {
        if (observedFile) {
          writePidFileAtomic(observedFile, {
            ownerPid: process.pid,
            ownerStartTime: readProcessStat(process.pid)?.startTime ?? null,
            holderPid: lease.holderPid,
            holderStartTime: lease.holderStartTime,
            childPid: childHandle.pid,
            childStartTime: childHandle.startTime,
            runScratchDir: path.dirname(stateRoot),
          });
        }
        await new Promise(() => {});
      }

      const childFds = inspectFds(childHandle.pid);

      emit({
        event: "acquired_with_child",
        pid: lease.pid,
        holderPid: lease.holderPid,
        holderStartTime: lease.holderStartTime,
        epoch: lease.epoch,
        projectKey: lease.projectKey,
        stateRoot: lease.stateRoot,
        childPid: childHandle.pid,
        childStartTime: childHandle.startTime,
        newParentFds,
        childFds,
      });
      childHandedOff = true;

      const rl = readline.createInterface({ input: process.stdin });
      for await (const line of rl) {
        if (line.trim() === "release") {
          break;
        }
      }
      await lease.release();
      lease = null;
      process.exit(0);
    }

    if (mode === "hold") {
      emit({
        event: "acquired",
        pid: lease.pid,
        holderPid: lease.holderPid,
        holderStartTime: lease.holderStartTime,
        epoch: lease.epoch,
        projectKey: lease.projectKey,
        stateRoot: lease.stateRoot,
        ownerRecord: lease.ownerRecord,
      });

      const rl = readline.createInterface({ input: process.stdin });
      for await (const rawLine of rl) {
        const cmd = rawLine.trim();
        if (cmd === "release") {
          break;
        }
        if (cmd.startsWith("write:")) {
          const name = cmd.slice("write:".length);
          const currentLease = lease;
          try {
            await currentLease.enqueue({
              write: () => {
                fs.writeFileSync(path.join(stateRoot, name), `epoch=${currentLease.epoch}\n`, "utf8");
                return name;
              },
              effect: (written) => written,
            });
            emit({ event: "wrote", name, epoch: currentLease.epoch });
          } catch (err) {
            emit({
              event: "write_failed",
              name,
              code: err instanceof LeaseError ? err.code : "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const releasedInfo = { pid: lease.pid, holderPid: lease.holderPid, epoch: lease.epoch };
      await lease.release();
      lease = null;
      emit({ event: "released", ...releasedInfo });
      process.exit(0);
    }

    throw new Error(`Unknown --mode: ${mode}`);
  } catch (err) {
    await cleanupBeforeHandoff();
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(1);
});
