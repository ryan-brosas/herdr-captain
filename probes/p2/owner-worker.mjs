import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquireLease, LeaseError, readProcessStat, resolveProjectIdentity } from "./lease.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
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

function inspectFds(pid = "self") {
  const result = [];
  const entries = fs.readdirSync(`/proc/${pid}/fd`);
  for (const fd of entries) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
      const match = info.match(/^flags:\s*([0-7]+)/m);
      const flagsOct = match ? match[1] : null;
      const flagsNum = flagsOct !== null ? parseInt(flagsOct, 8) : 0;
      result.push({
        fd,
        target,
        flagsOct,
        cloexec: (flagsNum & 0o2000000) !== 0,
      });
    } catch {
      // Skip transient procfs descriptors (e.g., the readdir fd itself).
    }
  }
  return result;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writePidFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function spawnDetachedSurvivingChild(onSpawned) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", 'printf "child_ready\\n"; exec sleep 60 >/dev/null 2>&1'], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let childExited = false;
    const exitedPromise = new Promise((res) => {
      child.once("exit", (code, signal) => {
        childExited = true;
        res({ code, signal });
      });
    });

    const startTime = readProcessStat(child.pid)?.startTime ?? null;
    const handle = {
      child,
      pid: child.pid,
      startTime,
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

    try {
      onSpawned(handle);
    } catch (err) {
      reject(err);
      return;
    }

    let stdoutBuf = "";
    let sawReady = false;
    let settled = false;

    const finishReject = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      if (stdoutBuf.includes("child_ready\n")) {
        sawReady = true;
      }
    });

    // Wait for stdout EOF so `exec sleep 60 >/dev/null 2>&1` has completed and closed the pipe.
    child.stdout.once("end", () => {
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

    child.once("error", finishReject);
    child.once("exit", (code, signal) => {
      if (!sawReady) {
        finishReject(new Error(`Detached child exited early (code=${code}, signal=${signal})`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "hold";
  const childPidFile = args["child-pid-file"] || null;

  let projectKey = args["project-key"];
  let stateRoot = args["state-root"];
  let canonicalCommonDir = null;

  if (args.cwd) {
    if (!args["state-base"]) {
      throw new Error("--state-base is required when --cwd is used");
    }
    const identity = resolveProjectIdentity(args.cwd);
    projectKey = identity.projectKey;
    canonicalCommonDir = identity.canonicalCommonDir;
    stateRoot = path.join(args["state-base"], projectKey);
  }

  if (!projectKey || !stateRoot) {
    throw new Error("Provide either (--state-root and --project-key) or (--cwd and --state-base)");
  }

  const beforeFds = mode === "hold-with-child" ? new Map(inspectFds("self").map((x) => [x.fd, x.target])) : null;

  let lease = null;
  let ownedChild = null;
  let childHandedOff = false;

  const cleanupBeforeHandoff = async () => {
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
          canonicalCommonDir,
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
        canonicalCommonDir,
        ownerRecord: lease.ownerRecord,
      });
      await lease.release();
      lease = null;
      process.exit(0);
    }

    if (mode === "hold-with-child") {
      const afterFds = inspectFds("self");
      const newParentFds = afterFds.filter((x) => beforeFds.get(x.fd) !== x.target);

      const childHandle = await spawnDetachedSurvivingChild((handle) => {
        ownedChild = handle;
        if (childPidFile) {
          writePidFileAtomic(childPidFile, {
            pid: handle.pid,
            startTime: handle.startTime,
          });
        }
        emit({
          event: "child_spawned",
          pid: lease.pid,
          holderPid: lease.holderPid,
          holderStartTime: lease.holderStartTime,
          childPid: handle.pid,
          childStartTime: handle.startTime,
        });
      });

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
        canonicalCommonDir,
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
          try {
            await lease.enqueue({
              write: () => {
                fs.writeFileSync(path.join(stateRoot, name), `epoch=${lease.epoch}\n`, "utf8");
                return name;
              },
              effect: (written) => written,
            });
            emit({ event: "wrote", name, epoch: lease.epoch });
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
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
