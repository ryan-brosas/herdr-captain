import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readProcessStat } from "../../src/lease.ts";
import { formatError, ProcessTracker } from "./process.ts";

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

const tracker = new ProcessTracker();
let fatalShutdownPromise: Promise<void> | null = null;

function handleFatalError(label: string, err: unknown): Promise<void> {
  process.stderr.write(`${label}: ${formatError(err)}\n`);
  if (fatalShutdownPromise !== null) {
    return fatalShutdownPromise;
  }
  fatalShutdownPromise = (async () => {
    try {
      await tracker.cleanupAll();
    } catch (cleanupErr) {
      process.stderr.write(`${formatError(cleanupErr)}\n`);
    }
    process.exit(1);
  })();
  return fatalShutdownPromise;
}

process.on("uncaughtException", (err) => {
  void handleFatalError("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  void handleFatalError("Unhandled rejection", reason);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenario = args.scenario;
  const observedFile = args["observed-file"] || null;

  const scratchRoot = tracker.createScratchDir("herdr-captain-harness-");

  try {
    if (scenario === "prereq-check") {
      execFileSync("flock", ["--version"], { encoding: "utf8" });
      return;
    }

    if (scenario === "hang-with-child") {
      const stateRoot = path.join(scratchRoot, "state");
      const childPidFile = path.join(scratchRoot, "child.json");
      const childToken = `herdr-s1a-harness-${crypto.randomUUID()}`;
      tracker.registerEnvToken("HERDR_S1A_CHILD_TOKEN", childToken);

      const worker = tracker.spawnWorker(
        [
          "--mode",
          "hold-with-child",
          "--state-root",
          stateRoot,
          "--project-key",
          "0707070707070707",
          "--child-pid-file",
          childPidFile,
          "--fault",
          "hang-after-child-ready",
          ...(observedFile ? ["--observed-file", observedFile] : []),
        ],
        { HERDR_S1A_CHILD_TOKEN: childToken },
      );

      await worker.nextEvent(5000);
      // Wait longer than the controller timeout so the controller kills this harness mid-flight.
      await worker.nextEvent(30000);
      return;
    }

    if (scenario === "uncaught-after-acquire") {
      const stateRoot = path.join(scratchRoot, "state");
      const worker = tracker.spawnWorker([
        "--mode",
        "hold",
        "--state-root",
        stateRoot,
        "--project-key",
        "0909090909090909",
      ]);

      const acquired = await worker.nextEvent(5000);
      if (observedFile && typeof worker.pid === "number") {
        const tmpObserved = `${observedFile}.tmp.${process.pid}`;
        fs.writeFileSync(
          tmpObserved,
          `${JSON.stringify({
            ownerPid: worker.pid,
            ownerStartTime: readProcessStat(worker.pid)?.startTime ?? null,
            holderPid: acquired.holderPid,
            holderStartTime: acquired.holderStartTime,
            runScratchDir: scratchRoot,
          })}\n`,
          "utf8",
        );
        fs.renameSync(tmpObserved, observedFile);
      }
      setImmediate(() => {
        throw new Error("forced_uncaught_runner_error_outside_await");
      });
      await new Promise(() => {});
      return;
    }

    throw new Error(`Unknown --scenario: ${String(scenario)}`);
  } finally {
    await tracker.cleanupAll();
  }
}

main().catch(async (err) => {
  try {
    await tracker.cleanupAll();
  } catch (cleanupErr) {
    process.stderr.write(`${formatError(cleanupErr)}\n`);
  }
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(1);
});
