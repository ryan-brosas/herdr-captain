import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquireLease, LeaseError, resolveProjectIdentity } from "./lease.mjs";

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

function spawnDetachedSurvivingChild() {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", 'printf "child_ready\\n"; exec sleep 60 >/dev/null 2>&1'], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdoutBuf = "";
    let sawReady = false;

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      if (stdoutBuf.includes("child_ready\n")) {
        sawReady = true;
      }
    });

    // Wait for stdout EOF so `exec sleep 60 >/dev/null 2>&1` has completed and closed the pipe.
    child.stdout.once("end", () => {
      if (!sawReady) {
        reject(new Error("Detached child closed stdout before printing child_ready"));
        return;
      }
      child.unref();
      resolve(child);
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!sawReady) {
        reject(new Error(`Detached child exited early (code=${code}, signal=${signal})`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "hold";

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

  let lease;
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
      epoch: lease.epoch,
      projectKey: lease.projectKey,
      stateRoot: lease.stateRoot,
      canonicalCommonDir,
      ownerRecord: lease.ownerRecord,
    });
    await lease.release();
    process.exit(0);
  }

  if (mode === "hold-with-child") {
    const afterFds = inspectFds("self");
    const newParentFds = afterFds.filter((x) => beforeFds.get(x.fd) !== x.target);
    const child = await spawnDetachedSurvivingChild();
    const childFds = inspectFds(child.pid);

    emit({
      event: "acquired_with_child",
      pid: lease.pid,
      holderPid: lease.holderPid,
      epoch: lease.epoch,
      projectKey: lease.projectKey,
      stateRoot: lease.stateRoot,
      childPid: child.pid,
      newParentFds,
      childFds,
    });

    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim() === "release") {
        break;
      }
    }
    await lease.release();
    process.exit(0);
  }

  if (mode === "hold") {
    emit({
      event: "acquired",
      pid: lease.pid,
      holderPid: lease.holderPid,
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

    await lease.release();
    emit({ event: "released", pid: lease.pid, holderPid: lease.holderPid, epoch: lease.epoch });
    process.exit(0);
  }

  throw new Error(`Unknown --mode: ${mode}`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
