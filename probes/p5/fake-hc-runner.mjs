#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessStat } from "../p2/lease.mjs";

const SIGNAL_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

export function writeJsonAtomic(filePath, value, { pretty = false } = {}) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  const serialized = pretty ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
  fs.writeFileSync(tmpPath, serialized, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function runRunnerMain() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.exit(2);
  }

  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const { argv, cwd, outputPath, exitPath, readyPath, env: extraEnv } = job;

  const outFd = fs.openSync(outputPath, "a");
  const runnerStartTime = readProcessStat(process.pid)?.startTime ?? null;

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, ...(extraEnv ?? {}) },
  });

  fs.closeSync(outFd);

  const workerPid = child.pid ?? null;
  const workerStartTime = workerPid ? readProcessStat(workerPid)?.startTime ?? null : null;

  writeJsonAtomic(readyPath, {
    runnerPid: process.pid,
    runnerStartTime,
    workerPid,
    workerStartTime,
  });

  child.once("error", (err) => {
    try {
      fs.appendFileSync(outputPath, `spawn error: ${err.message}\n`, "utf8");
    } catch {
      // Ignore output error on spawn failure.
    }
    writeJsonAtomic(exitPath, {
      exit_code: 127,
      signal: null,
      reason: "exited",
      finished_ms: Date.now(),
    });
    process.exit(0);
  });

  child.once("exit", (code, signal) => {
    const sigNum = signal ? (SIGNAL_NUMBERS[signal] ?? 1) : null;
    writeJsonAtomic(exitPath, {
      exit_code: signal ? null : (code ?? 0),
      signal: sigNum,
      reason: signal ? "killed" : "exited",
      finished_ms: Date.now(),
    });
    process.exit(0);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runRunnerMain();
}
