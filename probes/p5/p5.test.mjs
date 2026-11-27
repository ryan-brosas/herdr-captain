import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSameProcessAlive,
  readOwnerRecord,
  readProcessStat,
  stopProcessesByEnvToken,
} from "../p2/lease.mjs";
import { buildExpectedPayload, buildStandInWorkerArgv } from "./capture.mjs";
import {
  buildDeterministicName,
  createHcClient,
  HcBoundaryError,
} from "./hc-boundary.mjs";
import {
  foldCommitLog,
  GENESIS_SHA256,
  getTicketDir,
  readArtifactVerified,
  sha256Hex,
} from "./ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACER_PATH = path.join(HERE, "tracer.mjs");
const FAKE_HC_PATH = path.join(HERE, "fake-hc.mjs");

let tripwireRoot = null;
let tripwireDir = null;
let tripwireMarker = null;
const activeSandboxes = [];

function buildTripwireEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    PATH: `${tripwireDir}:${process.env.PATH ?? ""}`,
  };
}

function assertTripwireNeverRan() {
  expect(fs.existsSync(tripwireMarker), "PATH hc tripwire must never execute").toBe(false);
}

function createSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-p5-${label}-`));
  const stateRoot = path.join(root, "state");
  const fakeHcStateDir = path.join(root, "fake-hc-state");
  const workDir = path.join(root, "work");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(fakeHcStateDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const token = `p5-${crypto.randomBytes(8).toString("hex")}`;
  const prefix = `p5-${crypto.randomBytes(4).toString("hex")}`;
  const projectKey = crypto.randomBytes(8).toString("hex");

  const env = buildTripwireEnv({
    FAKE_HC_STATE_DIR: fakeHcStateDir,
    FAKE_HC_PROC_TOKEN: token,
  });

  const sandbox = {
    root,
    stateRoot,
    fakeHcStateDir,
    workDir,
    token,
    prefix,
    projectKey,
    env,
  };
  activeSandboxes.push(sandbox);
  return sandbox;
}

function makeGateFifo(dirPath, name = "gate.fifo") {
  const fifoPath = path.join(dirPath, name);
  execFileSync("mkfifo", [fifoPath], { stdio: "ignore" });
  return fifoPath;
}

function releaseGateFifo(fifoPath) {
  fs.writeFileSync(fifoPath, "go\n", "utf8");
}

function readFakeHcState(fakeHcStateDir) {
  const p = path.join(fakeHcStateDir, "state.json");
  if (!fs.existsSync(p)) {
    return { nextId: 1, runCount: 0, callSeq: 0, terminals: {} };
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readFakeHcCalls(fakeHcStateDir) {
  const p = path.join(fakeHcStateDir, "calls.ndjson");
  if (!fs.existsSync(p)) {
    return [];
  }
  const raw = fs.readFileSync(p, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line));
}

function runTracerProcess(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TRACER_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        pid: child.pid,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function runFakeHcDirect(args, env) {
  const res = spawnSync(FAKE_HC_PATH, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return {
    exitCode: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function waitForKernelLockRelease(stateRoot) {
  const lockPath = path.join(stateRoot, "owner.lock");
  const res = spawnSync("flock", ["--exclusive", "--timeout", "5", lockPath, "true"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(res.status).toBe(0);
}

async function waitForRecordedCall(fakeHcStateDir, startIdx, predicate, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const calls = readFakeHcCalls(fakeHcStateDir).slice(startIdx);
    const match = calls.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for fake-hc call");
}

function listDirSorted(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath).sort();
}

beforeAll(() => {
  tripwireRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-p5-tripwire-"));
  tripwireDir = path.join(tripwireRoot, "bin");
  tripwireMarker = path.join(tripwireRoot, "hc-tripwire.triggered");
  fs.mkdirSync(tripwireDir, { recursive: true });

  const tripwireScript = path.join(tripwireDir, "hc");
  fs.writeFileSync(
    tripwireScript,
    `#!/bin/sh\nprintf 'TRIPWIRE %s\\n' "$*" >> '${tripwireMarker}'\nexit 99\n`,
    { mode: 0o755 },
  );

  const resolved = execFileSync("sh", ["-c", "command -v hc"], {
    encoding: "utf8",
    env: buildTripwireEnv(),
  }).trim();
  expect(resolved).toBe(tripwireScript);
});

afterEach(async () => {
  while (activeSandboxes.length > 0) {
    const sb = activeSandboxes.pop();
    try {
      await stopProcessesByEnvToken("FAKE_HC_PROC_TOKEN", sb.token, 3000);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  }
  assertTripwireNeverRan();
});

afterAll(() => {
  try {
    assertTripwireNeverRan();
  } finally {
    if (tripwireRoot) {
      fs.rmSync(tripwireRoot, { recursive: true, force: true });
    }
  }
});

describe("Probe P5: recovery tracer and hc boundary", () => {
  test("check-2: commits brief, records launch intent, launches outliving worker, records receipt in order", async () => {
    const sb = createSandbox("check2");
    const gateFifo = makeGateFifo(sb.workDir);
    const reportFile = path.join(sb.workDir, "report.txt");
    const issue = "7";
    const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });
    expect(expectedName.length).toBeLessThanOrEqual(32);
    expect(expectedName.startsWith(`${sb.prefix}-`)).toBe(true);

    const startRes = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
        "--cwd",
        sb.workDir,
        "--expected-lines",
        "200",
        "--report-file",
        reportFile,
        "--gate-fifo",
        gateFifo,
      ],
      sb.env,
    );

    expect(startRes.signal).toBeNull();
    expect(startRes.exitCode).toBe(0);
    expect(startRes.stderr).toContain(`prefix=${sb.prefix}\n`);
    const summary = JSON.parse(startRes.stdout);
    expect(summary.outcome).toBe("launched");
    expect(summary.prefix).toBe(sb.prefix);
    expect(summary.terminalName).toBe(expectedName);
    expect(summary.address).toBe("t1");
    expect(summary.epoch).toBe(1);

    // Controller has already exited: prove the worker genuinely outlived its parent.
    const getAfter = runFakeHcDirect(["get", expectedName, "--json"], sb.env);
    expect(getAfter.exitCode).toBe(0);
    const termAfter = JSON.parse(getAfter.stdout);
    expect(termAfter.state).toBe("live");
    expect(termAfter.die_with_parent).toBe(false);
    expect(termAfter.keep).toBe(false);
    expect(termAfter.rm).toBe(false);
    expect(termAfter.notify).toBe(false);
    expect(termAfter.parent).toBeNull();
    expect(Number.isInteger(termAfter.pid)).toBe(true);
    const workerStat = readProcessStat(termAfter.pid);
    expect(workerStat).not.toBeNull();
    expect(isSameProcessAlive(termAfter.pid, workerStat.startTime)).toBe(true);

    // Verify fake hc recorded exact launch arguments and counted exactly one run call.
    const fakeState = readFakeHcState(sb.fakeHcStateDir);
    expect(fakeState.runCount).toBe(1);
    const calls = readFakeHcCalls(sb.fakeHcStateDir);
    const runCalls = calls.filter((c) => c.argv[0] === "run");
    expect(runCalls.length).toBe(1);
    const runArgv = runCalls[0].argv;
    const ddIdx = runArgv.indexOf("--");
    expect(ddIdx).toBeGreaterThan(0);
    const hcFlags = runArgv.slice(0, ddIdx);
    expect(hcFlags).toContain("--bg");
    expect(hcFlags).toContain("--json");
    expect(hcFlags).toContain("--no-parent");
    expect(hcFlags).toContain("--no-notify");
    expect(hcFlags, "hc run argv must include --outlive-parent").toContain("--outlive-parent");
    expect(hcFlags).not.toContain("--keep");
    expect(hcFlags).not.toContain("--rm");
    expect(hcFlags).not.toContain("--force");
    const nameFlagIdx = hcFlags.indexOf("--name");
    expect(nameFlagIdx).toBeGreaterThan(0);
    expect(hcFlags[nameFlagIdx + 1]).toBe(expectedName);
    expect(hcFlags[nameFlagIdx + 1].length).toBeLessThanOrEqual(32);

    // Verify commit log record order, exclusive files, and SHA-256 hash chain.
    const ticketDir = getTicketDir(sb.stateRoot, issue);
    const logDir = path.join(ticketDir, "log");
    const logFiles = fs.readdirSync(logDir).sort();
    expect(logFiles).toEqual(["000001.json", "000002.json", "000003.json"]);

    const raw1 = fs.readFileSync(path.join(logDir, "000001.json"));
    const raw2 = fs.readFileSync(path.join(logDir, "000002.json"));
    const raw3 = fs.readFileSync(path.join(logDir, "000003.json"));
    const r1 = JSON.parse(raw1.toString("utf8"));
    const r2 = JSON.parse(raw2.toString("utf8"));
    const r3 = JSON.parse(raw3.toString("utf8"));

    expect([r1.event, r2.event, r3.event]).toEqual(["brief_committed", "launch_intent", "launch_receipt"]);
    expect(r1.prevRecordSha256).toBe(GENESIS_SHA256);
    expect(r2.prevRecordSha256).toBe(sha256Hex(raw1));
    expect(r3.prevRecordSha256).toBe(sha256Hex(raw2));
    expect(r2.intent.terminalName).toBe(expectedName);
    expect(r3.receipt.address).toBe("t1");
    expect(r2.time <= r3.time).toBe(true);
    expect(r2.time <= runCalls[0].ts).toBe(true);

    const folded = foldCommitLog(ticketDir);
    expect(folded.status).toBe("ok");
    expect(folded.phase).toBe("building");
    expect(folded.openAttempt?.state).toBe("delivered");
    expect(folded.openAttempt?.terminalName).toBe(expectedName);

    releaseGateFifo(gateFifo);
    const waitDone = runFakeHcDirect(["wait", expectedName, "--timeout", "10", "--json"], sb.env);
    expect(waitDone.exitCode).toBe(0);
    expect(JSON.parse(waitDone.stdout).ended).toBe(true);
    assertTripwireNeverRan();
  });

  test("check-3: refuses missing or non-explicit hc path and never hits PATH tripwire", async () => {
    const sb = createSandbox("check3");

    // 1. Missing --hc-bin on start
    const missingStart = await runTracerProcess(
      [
        "start",
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        "7",
        "--prefix",
        sb.prefix,
        "--cwd",
        sb.workDir,
      ],
      sb.env,
    );
    assertTripwireNeverRan();
    expect(missingStart.exitCode).not.toBe(0);
    expect(missingStart.stderr, "missing --hc-bin must report missing_hc_bin").toContain("missing_hc_bin");

    // 2. Bare "hc" (would look up on PATH if allowed) on start
    const bareStart = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        "hc",
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        "7",
        "--prefix",
        sb.prefix,
        "--cwd",
        sb.workDir,
      ],
      sb.env,
    );
    expect(bareStart.exitCode).not.toBe(0);
    expect(bareStart.stderr).toContain("non_explicit_hc_bin");

    // 3. Missing --hc-bin on recover
    const missingRecover = await runTracerProcess(
      [
        "recover",
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        "7",
        "--prefix",
        sb.prefix,
      ],
      sb.env,
    );
    expect(missingRecover.exitCode).not.toBe(0);
    expect(missingRecover.stderr).toContain("missing_hc_bin");

    // 4. Bare "hc" on cleanup
    const bareCleanup = await runTracerProcess(
      [
        "cleanup",
        "--hc-bin",
        "hc",
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--prefix",
        sb.prefix,
      ],
      sb.env,
    );
    expect(bareCleanup.exitCode).not.toBe(0);
    expect(bareCleanup.stderr).toContain("non_explicit_hc_bin");

    // 5. Nonexistent explicit path refused
    const badPath = await runTracerProcess(
      [
        "cleanup",
        "--hc-bin",
        path.join(sb.root, "no-such-hc"),
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--prefix",
        sb.prefix,
      ],
      sb.env,
    );
    expect(badPath.exitCode).not.toBe(0);
    expect(badPath.stderr).toContain("hc_bin_not_found");

    expect(readOwnerRecord(sb.stateRoot)).toBeNull();
    assertTripwireNeverRan();
  });

  test("check-4: SIGKILL after receipt, worker finishes, new controller folds log, finds by name, captures full output, and rejects cropped complete:true read", async () => {
    const sb = createSandbox("check4");
    const gateFifo = makeGateFifo(sb.workDir);
    const reportFile = path.join(sb.workDir, "worker-report.txt");
    const issue = "7";
    const expectedLines = 250;
    const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

    const crashRes = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
        "--cwd",
        sb.workDir,
        "--expected-lines",
        String(expectedLines),
        "--report-file",
        reportFile,
        "--gate-fifo",
        gateFifo,
        "--crash-at",
        "after_receipt",
      ],
      sb.env,
    );

    expect(crashRes.signal).toBe("SIGKILL");
    expect(crashRes.exitCode).toBeNull();
    expect(crashRes.stdout).toBe("");

    waitForKernelLockRelease(sb.stateRoot);
    expect(readOwnerRecord(sb.stateRoot)?.epoch).toBe(1);

    const liveCheck = runFakeHcDirect(["get", expectedName, "--json"], sb.env);
    expect(liveCheck.exitCode).toBe(0);
    expect(JSON.parse(liveCheck.stdout).state).toBe("live");

    releaseGateFifo(gateFifo);
    const waitWorker = runFakeHcDirect(["wait", expectedName, "--timeout", "10", "--json"], sb.env);
    expect(waitWorker.exitCode).toBe(0);
    expect(JSON.parse(waitWorker.stdout).ended).toBe(true);

    // P3 cropped-read trap: --lines 50 returns 170 lines with complete: true, and MUST be rejected.
    const croppedStateRoot = path.join(sb.root, "state-cropped");
    fs.cpSync(sb.stateRoot, croppedStateRoot, { recursive: true });
    const callsBeforeCropped = readFakeHcCalls(sb.fakeHcStateDir).length;

    const croppedRecover = await runTracerProcess(
      [
        "recover",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        croppedStateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
        "--read-lines",
        "50",
      ],
      sb.env,
    );
    expect(croppedRecover.signal).toBeNull();
    expect(croppedRecover.exitCode, "cropped complete:true read must fail capture verification").toBe(3);
    const croppedPayload = JSON.parse(croppedRecover.stdout);
    expect(croppedPayload.outcome).toBe("capture_unusable");
    expect(croppedPayload.reason).toBe("missing_begin_sentinel");
    expect(croppedPayload.readCompleteClaimed).toBe(true);
    expect(croppedPayload.terminalKept).toBe(true);

    const croppedCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeCropped);
    expect(croppedCalls.some((c) => c.argv[0] === "read" && c.argv.includes("50"))).toBe(true);
    expect(croppedCalls.some((c) => c.argv[0] === "rm" || c.argv[0] === "kill")).toBe(false);

    // Full recovery in a fresh controller process: first lookup by deterministic name, then read by verified address.
    const callsBeforeRecover = readFakeHcCalls(sb.fakeHcStateDir).length;
    const recoverRes = await runTracerProcess(
      [
        "recover",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
        "--read-lines",
        "1000",
      ],
      sb.env,
    );

    expect(recoverRes.signal).toBeNull();
    expect(recoverRes.exitCode).toBe(0);
    const recovered = JSON.parse(recoverRes.stdout);
    expect(recovered.outcome).toBe("captured");
    expect(recovered.epoch).toBe(2);
    expect(recovered.terminalName).toBe(expectedName);
    expect(recovered.address).toBe("t1");
    expect(recovered.linesVerified).toBe(expectedLines);
    expect(recovered.reportFileVerified).toBe(true);
    expect(recovered.recordSeq).toBe(4);

    // First lookup used deterministic name; post-verification read used verified address "t1" (R4).
    const recoverCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeRecover);
    const getCall = recoverCalls.find((c) => c.argv[0] === "get");
    const readCall = recoverCalls.find((c) => c.argv[0] === "read");
    expect(getCall?.argv).toEqual(["get", expectedName, "--json"]);
    expect(readCall?.argv).toEqual(["read", "t1", "--lines", "1000", "--json"]);

    expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);

    const ticketDir = getTicketDir(sb.stateRoot, issue);
    const artifactText = readArtifactVerified(ticketDir, recovered.artifactSha256);
    expect(artifactText).toBe(buildExpectedPayload("a1", expectedLines));

    const folded = foldCommitLog(ticketDir);
    expect(folded.status).toBe("ok");
    expect(folded.phase).toBe("gating");
    expect(folded.openAttempt).toBeNull();
    expect(folded.records.map((r) => r.event)).toEqual([
      "brief_committed",
      "launch_intent",
      "launch_receipt",
      "capture_settled",
    ]);
    expect(readOwnerRecord(sb.stateRoot)?.epoch).toBe(2);
    assertTripwireNeverRan();
  });

  test("check-5: SIGKILL after intent (before launch and after launch) folds to uncertain and escalates with zero relaunch", async () => {
    // Subcase A: SIGKILL after launch_intent is durable and BEFORE hc run.
    {
      const sb = createSandbox("check5a");
      const issue = "7";
      const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

      const crashBeforeLaunch = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--crash-at",
          "after_intent_before_launch",
        ],
        sb.env,
      );

      expect(crashBeforeLaunch.signal).toBe("SIGKILL");
      expect(crashBeforeLaunch.exitCode).toBeNull();
      waitForKernelLockRelease(sb.stateRoot);

      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(0);
      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const foldedBefore = foldCommitLog(ticketDir);
      expect(foldedBefore.status).toBe("ok");
      expect(foldedBefore.records.map((r) => r.event)).toEqual(["brief_committed", "launch_intent"]);
      expect(foldedBefore.openAttempt?.state).toBe("intent");
      expect(foldedBefore.recoveryAction).toBe("reconcile_uncertain_launch");

      const recoverA = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );

      expect(recoverA.signal).toBeNull();
      expect(recoverA.exitCode).toBe(0);
      const payloadA = JSON.parse(recoverA.stdout);
      expect(payloadA.outcome, "launch_intent without receipt must settle uncertain, not relaunch").toBe("uncertain");
      expect(payloadA.escalated).toBe(true);
      expect(payloadA.found).toBe(false);
      expect(payloadA.boundAddress).toBeNull();
      expect(payloadA.epoch).toBe(2);
      expect(payloadA.foldedFromSeq).toBe(2);
      expect(payloadA.foldedAttemptStateBefore).toBe("intent");

      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(0);
      const callsA = readFakeHcCalls(sb.fakeHcStateDir);
      expect(callsA.map((c) => c.argv)).toEqual([["get", expectedName, "--json"]]);
      expect(callsA[0].exitCode).toBe(3);

      const foldedAfterA = foldCommitLog(ticketDir);
      expect(foldedAfterA.status).toBe("ok");
      expect(foldedAfterA.phase).toBe("escalated");
      expect(foldedAfterA.openAttempt?.state).toBe("uncertain");
      expect(foldedAfterA.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "reconcile_unresolved",
      ]);
    }

    // Subcase B: SIGKILL after hc run and BEFORE launch_receipt is written.
    {
      const sb = createSandbox("check5b");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

      const crashAfterLaunch = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--gate-fifo",
          gateFifo,
          "--crash-at",
          "after_launch_before_receipt",
        ],
        sb.env,
      );

      expect(crashAfterLaunch.signal).toBe("SIGKILL");
      expect(crashAfterLaunch.exitCode).toBeNull();
      waitForKernelLockRelease(sb.stateRoot);

      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const foldedBefore = foldCommitLog(ticketDir);
      expect(foldedBefore.status).toBe("ok");
      expect(foldedBefore.records.map((r) => r.event)).toEqual(["brief_committed", "launch_intent"]);
      expect(foldedBefore.openAttempt?.state).toBe("intent");
      expect(foldedBefore.recoveryAction).toBe("reconcile_uncertain_launch");

      const callsBeforeRecover = readFakeHcCalls(sb.fakeHcStateDir).length;
      const recoverB = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );

      expect(recoverB.signal).toBeNull();
      expect(recoverB.exitCode).toBe(0);
      const payloadB = JSON.parse(recoverB.stdout);
      expect(payloadB.outcome).toBe("uncertain");
      expect(payloadB.escalated).toBe(true);
      expect(payloadB.found).toBe(true);
      expect(payloadB.boundAddress).toBe("t1");
      expect(payloadB.epoch).toBe(2);
      expect(payloadB.foldedFromSeq).toBe(2);
      expect(payloadB.foldedAttemptStateBefore).toBe("intent");

      // First lookup by deterministic name, then screen-only read by verified address "t1" (R4).
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      const recoverCallsB = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeRecover);
      expect(recoverCallsB.map((c) => c.argv)).toEqual([
        ["get", expectedName, "--json"],
        ["read", "t1", "--lines", "0", "--json"],
      ]);

      const foldedAfterB = foldCommitLog(ticketDir);
      expect(foldedAfterB.status).toBe("ok");
      expect(foldedAfterB.phase).toBe("escalated");
      expect(foldedAfterB.openAttempt?.state).toBe("uncertain");
      expect(foldedAfterB.openAttempt?.boundAddress).toBe("t1");
      expect(foldedAfterB.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "reconcile_unresolved",
      ]);
    }

    assertTripwireNeverRan();
  });

  test("check-6: hc boundary refuses every forbidden command and flag, including --children, and cuts a hung hc call at its time limit", async () => {
    const sb = createSandbox("check6");
    const hc = createHcClient({
      hcBin: FAKE_HC_PATH,
      prefix: sb.prefix,
      defaultTimeoutMs: 2000,
      env: sb.env,
    });

    const ver = await hc.version();
    expect(ver.version).toBe("hc 0.1.22");
    const sch = await hc.schema();
    expect(sch.schema.info.version).toBe("0.1.22");

    const cases = [
      { label: "server", args: ["server", "status"], code: "forbidden_command" },
      { label: "update", args: ["update"], code: "forbidden_command" },
      { label: "machine", args: ["machine", "ls"], code: "forbidden_command" },
      { label: "keys", args: ["keys", `${sb.prefix}-w1`, "enter"], code: "forbidden_command" },
      { label: "send (unlisted)", args: ["send", `${sb.prefix}-w1`, "hi"], code: "forbidden_command" },
      { label: "--force on kill", args: ["kill", "--force", `${sb.prefix}-w1`], code: "forbidden_flag" },
      { label: "--force=true on rm", args: ["rm", "--force=true", `${sb.prefix}-w1`], code: "forbidden_flag" },
      { label: "-f on rm", args: ["rm", "-f", `${sb.prefix}-w1`], code: "forbidden_flag" },
      { label: "--keep on run", args: ["run", "--bg", "--keep", "--name", `${sb.prefix}-w1`, "--", "true"], code: "forbidden_flag" },
      { label: "--rm on run", args: ["run", "--bg", "--rm", "--name", `${sb.prefix}-w1`, "--", "true"], code: "forbidden_flag" },
      { label: "--label on run (removed R7)", args: ["run", "--bg", "--label", "a=b", "--name", `${sb.prefix}-w1`, "--", "true"], code: "forbidden_flag" },
      { label: "--parent on run (removed R7)", args: ["run", "--bg", "--parent", `${sb.prefix}-p1`, "--name", `${sb.prefix}-w1`, "--", "true"], code: "forbidden_flag" },
      { label: "--label on ls (removed R7)", args: ["ls", "--label", "a=b", "--json"], code: "forbidden_flag" },
      { label: "--output on wait (removed R7)", args: ["wait", `${sb.prefix}-w1`, "--output", "ready", "--json"], code: "forbidden_flag" },
      { label: "--children all with named terminal (R2)", args: ["wait", `${sb.prefix}-w1`, "--children", "all", "--json"], code: "forbidden_flag" },
      { label: "--children=any with named terminal (R2)", args: ["wait", `${sb.prefix}-w1`, "--children=any", "--json"], code: "forbidden_flag" },
      { label: "--children without terminal (R2)", args: ["wait", "--children", "all", "--json"], code: "forbidden_flag" },
      { label: "remote --on", args: ["run", "--bg", "--on", "box", "--name", `${sb.prefix}-w1`, "--", "true"], code: "remote_target_forbidden" },
      { label: "remote --on=", args: ["run", "--bg", "--on=box", "--name", `${sb.prefix}-w1`, "--", "true"], code: "remote_target_forbidden" },
      { label: "remote target slash on get", args: ["get", `box/${sb.prefix}-w1`, "--json"], code: "remote_target_forbidden" },
      { label: "remote target slash on address", args: ["kill", "box/t1", "--json"], code: "remote_target_forbidden" },
      { label: "remote +machine on get", args: ["get", "+box", "--json"], code: "remote_target_forbidden" },
      { label: "remote +machine on ls", args: ["ls", "+box", "--json"], code: "remote_target_forbidden" },
      { label: "wait with no terminal", args: ["wait", "--timeout", "5", "--json"], code: "missing_terminal_target" },
      { label: "run without prefix", args: ["run", "--bg", "--name", "other-worker", "--", "true"], code: "prefix_violation" },
      { label: "run without --name", args: ["run", "--bg", "--", "true"], code: "prefix_violation" },
      { label: "run near-miss prefix without separator", args: ["run", "--bg", "--name", `${sb.prefix}extra`, "--", "true"], code: "prefix_violation" },
      { label: "get without prefix", args: ["get", "other-worker", "--json"], code: "prefix_violation" },
      { label: "get near-miss prefix without separator", args: ["get", `${sb.prefix}extra`, "--json"], code: "prefix_violation" },
      { label: "get bare prefix plus hyphen", args: ["get", `${sb.prefix}-`, "--json"], code: "prefix_violation" },
      { label: "read without prefix", args: ["read", "other-worker", "--lines", "0", "--json"], code: "prefix_violation" },
      { label: "wait without prefix", args: ["wait", "other-worker", "--timeout", "1", "--json"], code: "prefix_violation" },
      { label: "kill without prefix", args: ["kill", "other-worker", "--json"], code: "prefix_violation" },
      { label: "rm without prefix", args: ["rm", "other-worker", "--json"], code: "prefix_violation" },
      { label: "unauthorized raw address", args: ["kill", "t99", "--json"], code: "prefix_violation" },
      { label: "name longer than 32 chars", args: ["run", "--bg", "--name", `${sb.prefix}-${"x".repeat(30)}`, "--", "true"], code: "invalid_name" },
    ];

    const callsBeforeRefusals = readFakeHcCalls(sb.fakeHcStateDir).length;
    for (const tc of cases) {
      let caught = null;
      try {
        await hc.execHc(tc.args);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected refusal for ${tc.label}`).toBeInstanceOf(HcBoundaryError);
      expect(caught.code, `expected code ${tc.code} for ${tc.label}, got ${caught?.code}`).toBe(tc.code);
    }
    expect(readFakeHcCalls(sb.fakeHcStateDir).length).toBe(callsBeforeRefusals);

    // Hung hc call is cut at its time limit and reported.
    const hangClient = createHcClient({
      hcBin: FAKE_HC_PATH,
      prefix: sb.prefix,
      defaultTimeoutMs: 150,
      env: {
        ...sb.env,
        FAKE_HC_HANG_CMD: "ls",
        FAKE_HC_HANG_MS: "2500",
      },
    });

    const t0 = performance.now();
    let timeoutErr = null;
    try {
      await hangClient.ls({ all: true, timeoutMs: 150 });
    } catch (err) {
      timeoutErr = err;
    }
    const elapsedMs = performance.now() - t0;

    expect(timeoutErr, "hung hc call must be killed at timeout with HcBoundaryError").toBeInstanceOf(HcBoundaryError);
    expect(timeoutErr.code).toBe("hc_timeout");
    expect(timeoutErr.details.killed).toBe(true);
    expect(timeoutErr.details.timeoutMs).toBe(150);
    expect(elapsedMs).toBeLessThan(1200);
    assertTripwireNeverRan();
  });

  test("check-7: cleanup removes every terminal with the prefix, leaves unprefixed and near-miss terminals in place, and reads each removed one back by address", async () => {
    const sb = createSandbox("check7");
    const gateLive = makeGateFifo(sb.workDir, "live.fifo");
    const gateOther = makeGateFifo(sb.workDir, "other.fifo");
    const gateNear1 = makeGateFifo(sb.workDir, "near1.fifo");
    const gateNear2 = makeGateFifo(sb.workDir, "near2.fifo");

    const prefixedLiveName = `${sb.prefix}-live`;
    const prefixedDoneName = `${sb.prefix}-done`;
    const unprefixedName = "other-keep-term";
    const nearMissNoSep = `${sb.prefix}extra`;
    const nearMissSharedHead = `${sb.prefix.slice(0, -1)}-same`;

    // 1. Live terminal WITH full prefix + '-'
    const r1 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", prefixedLiveName, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateLive}' || true`],
      sb.env,
    );
    expect(r1.exitCode).toBe(0);
    const addrLive = JSON.parse(r1.stdout).address;

    // 2. Finished terminal WITH full prefix + '-'
    const r2 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", prefixedDoneName, "--cwd", sb.workDir, "--", "sh", "-c", "echo done"],
      sb.env,
    );
    expect(r2.exitCode).toBe(0);
    const addrDone = JSON.parse(r2.stdout).address;
    expect(JSON.parse(runFakeHcDirect(["wait", addrDone, "--timeout", "5", "--json"], sb.env).stdout).ended).toBe(true);

    // 3. Unprefixed live terminal (must stay untouched)
    const r3 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", unprefixedName, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateOther}' || true`],
      sb.env,
    );
    expect(r3.exitCode).toBe(0);
    const addrOther = JSON.parse(r3.stdout).address;

    // 4. Near-miss live terminal sharing entire prefix without '-' separator (must stay untouched, R1)
    const r4 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", nearMissNoSep, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateNear1}' || true`],
      sb.env,
    );
    expect(r4.exitCode).toBe(0);
    const addrNear1 = JSON.parse(r4.stdout).address;

    // 5. Near-miss live terminal sharing leading characters of prefix (must stay untouched, R1)
    const r5 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", nearMissSharedHead, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateNear2}' || true`],
      sb.env,
    );
    expect(r5.exitCode).toBe(0);
    const addrNear2 = JSON.parse(r5.stdout).address;

    const callsBeforeCleanup = readFakeHcCalls(sb.fakeHcStateDir).length;
    const cleanupRes = await runTracerProcess(
      [
        "cleanup",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--prefix",
        sb.prefix,
      ],
      sb.env,
    );

    expect(cleanupRes.signal).toBeNull();
    expect(cleanupRes.exitCode).toBe(0);
    const summary = JSON.parse(cleanupRes.stdout);
    expect(summary.outcome).toBe("cleaned");
    expect(summary.remainingPrefixedCount).toBe(0);
    expect(summary.skippedCount, "cleanup must skip unprefixed and near-miss terminals").toBe(3);
    expect(summary.removed.map((x) => x.address).sort()).toEqual([addrLive, addrDone].sort());
    for (const item of summary.removed) {
      expect(item.readbackExitCode).toBe(3);
      expect(item.readbackKind).toBe("not_found");
    }

    const cleanupCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeCleanup);
    for (const addr of [addrLive, addrDone]) {
      const rmIdx = cleanupCalls.findIndex((c) => c.argv[0] === "rm" && c.argv[1] === addr);
      const getAfterRmIdx = cleanupCalls.findIndex(
        (c, idx) => idx > rmIdx && c.argv[0] === "get" && c.argv[1] === addr && c.exitCode === 3,
      );
      expect(rmIdx).toBeGreaterThan(-1);
      expect(getAfterRmIdx, "cleanup must run hc get by address after hc rm").toBeGreaterThan(rmIdx);
    }

    const protectedTargets = new Set([addrOther, unprefixedName, addrNear1, nearMissNoSep, addrNear2, nearMissSharedHead]);
    expect(
      cleanupCalls.some((c) => (c.argv[0] === "kill" || c.argv[0] === "rm") && protectedTargets.has(c.argv[1])),
    ).toBe(false);

    // Confirm all three non-matching terminals remain live and untouched.
    for (const [addr, name] of [
      [addrOther, unprefixedName],
      [addrNear1, nearMissNoSep],
      [addrNear2, nearMissSharedHead],
    ]) {
      const check = runFakeHcDirect(["get", addr, "--json"], sb.env);
      expect(check.exitCode).toBe(0);
      const parsed = JSON.parse(check.stdout);
      expect(parsed.name).toBe(name);
      expect(parsed.state).toBe("live");
    }

    expect(runFakeHcDirect(["get", addrLive, "--json"], sb.env).exitCode).toBe(3);
    expect(runFakeHcDirect(["get", addrDone, "--json"], sb.env).exitCode).toBe(3);

    releaseGateFifo(gateOther);
    releaseGateFifo(gateNear1);
    releaseGateFifo(gateNear2);
    assertTripwireNeverRan();
  });

  test("r1-prefix: start, recover, and cleanup refuse short or malformed prefixes before any hc call; start generates cryptographic prefix when omitted", async () => {
    const badPrefixes = ["a", "p5", "p5-", "p5-1234567", "foo-12345678", "p5-UPPER123", "p5-12345678-"];

    for (const bad of badPrefixes) {
      const sb = createSandbox("r1-bad");
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          "7",
          "--prefix",
          bad,
          "--cwd",
          sb.workDir,
        ],
        sb.env,
      );
      expect(startRes.exitCode).not.toBe(0);
      expect(JSON.parse(startRes.stderr).error.code).toBe("invalid_prefix");

      const recoverRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          "7",
          "--prefix",
          bad,
        ],
        sb.env,
      );
      expect(recoverRes.exitCode).not.toBe(0);
      expect(JSON.parse(recoverRes.stderr).error.code).toBe("invalid_prefix");

      const cleanupRes = await runTracerProcess(
        [
          "cleanup",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--prefix",
          bad,
        ],
        sb.env,
      );
      expect(cleanupRes.exitCode).not.toBe(0);
      expect(JSON.parse(cleanupRes.stderr).error.code).toBe("invalid_prefix");

      // Zero hc calls and zero lease acquisition when prefix is invalid.
      expect(readFakeHcCalls(sb.fakeHcStateDir).length).toBe(0);
      expect(readOwnerRecord(sb.stateRoot)).toBeNull();
    }

    // Start without --prefix generates cryptographic p5-<hex> prefixes and prints them.
    const sb1 = createSandbox("r1-gen1");
    const sb2 = createSandbox("r1-gen2");
    const res1 = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb1.stateRoot,
        "--project-key",
        sb1.projectKey,
        "--issue",
        "7",
        "--cwd",
        sb1.workDir,
        "--expected-lines",
        "5",
      ],
      sb1.env,
    );
    const res2 = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb2.stateRoot,
        "--project-key",
        sb2.projectKey,
        "--issue",
        "7",
        "--cwd",
        sb2.workDir,
        "--expected-lines",
        "5",
      ],
      sb2.env,
    );
    expect(res1.exitCode).toBe(0);
    expect(res2.exitCode).toBe(0);
    const p1 = JSON.parse(res1.stdout).prefix;
    const p2 = JSON.parse(res2.stdout).prefix;
    expect(p1).toMatch(/^p5-[a-z0-9]{8,16}$/);
    expect(p2).toMatch(/^p5-[a-z0-9]{8,16}$/);
    expect(p1).not.toBe(p2);
    expect(res1.stderr).toContain(`prefix=${p1}\n`);
    expect(res2.stderr).toContain(`prefix=${p2}\n`);
    assertTripwireNeverRan();
  });

  test("r3-holder-loss: lease holder death after screen read and before artifact write writes nothing and exits non-zero with lease_revoked", async () => {
    const sb = createSandbox("r3");
    const gateFifo = makeGateFifo(sb.workDir);
    const issue = "7";

    const crashRes = await runTracerProcess(
      [
        "start",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
        "--cwd",
        sb.workDir,
        "--gate-fifo",
        gateFifo,
        "--crash-at",
        "after_launch_before_receipt",
      ],
      sb.env,
    );
    expect(crashRes.signal).toBe("SIGKILL");
    waitForKernelLockRelease(sb.stateRoot);

    const ticketDir = getTicketDir(sb.stateRoot, issue);
    const artifactsBefore = listDirSorted(path.join(ticketDir, "artifacts"));
    const logBefore = listDirSorted(path.join(ticketDir, "log"));
    expect(artifactsBefore.length).toBe(1); // brief only
    expect(logBefore).toEqual(["000001.json", "000002.json"]);

    const callsBefore = readFakeHcCalls(sb.fakeHcStateDir).length;
    const killHolderEnv = {
      ...sb.env,
      FAKE_HC_KILL_HOLDER_ON_CMD: "read",
      FAKE_HC_OWNER_JSON: path.join(sb.stateRoot, "owner.json"),
    };

    const recRes = await runTracerProcess(
      [
        "recover",
        "--hc-bin",
        FAKE_HC_PATH,
        "--state-root",
        sb.stateRoot,
        "--project-key",
        sb.projectKey,
        "--issue",
        issue,
        "--prefix",
        sb.prefix,
      ],
      killHolderEnv,
    );

    expect(recRes.exitCode).not.toBe(0);
    expect(recRes.stdout).toBe("");
    expect(JSON.parse(recRes.stderr).error.code).toBe("lease_revoked");

    // Confirm the screen read ran before holder loss.
    const recCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBefore);
    expect(recCalls.some((c) => c.argv[0] === "read")).toBe(true);

    // Zero new artifacts and zero new commit records written after holder loss.
    const artifactsAfter = listDirSorted(path.join(ticketDir, "artifacts"));
    const logAfter = listDirSorted(path.join(ticketDir, "log"));
    expect(artifactsAfter, "holder loss before enqueue must write zero new artifacts").toEqual(artifactsBefore);
    expect(logAfter).toEqual(logBefore);

    releaseGateFifo(gateFifo);
    assertTripwireNeverRan();
  });

  test("r4-replacement: terminal replaced under same name before lookup or during wait stays uncertain and captures nothing from replacement", async () => {
    // Subcase A: replaced under the same name BEFORE first lookup.
    {
      const sb = createSandbox("r4a");
      const issue = "7";
      const expectedLines = 10;
      const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--expected-lines",
          String(expectedLines),
          "--crash-at",
          "after_receipt",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      // Wait for t1 to finish, remove t1, and start replacement t2 under the exact same name.
      expect(runFakeHcDirect(["wait", "t1", "--timeout", "5", "--json"], sb.env).exitCode).toBe(0);
      expect(runFakeHcDirect(["rm", "t1", "--json"], sb.env).exitCode).toBe(0);
      const replArgv = buildStandInWorkerArgv({ attemptId: "a1", expectedLines });
      const replRun = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", expectedName, "--cwd", sb.workDir, "--", ...replArgv],
        sb.env,
      );
      expect(replRun.exitCode).toBe(0);
      expect(JSON.parse(replRun.stdout).address).toBe("t2");
      expect(runFakeHcDirect(["wait", "t2", "--timeout", "5", "--json"], sb.env).exitCode).toBe(0);

      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const artifactsBefore = listDirSorted(path.join(ticketDir, "artifacts"));

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );
      expect(recRes.exitCode).toBe(3);
      const payload = JSON.parse(recRes.stdout);
      expect(payload.outcome).toBe("uncertain");
      expect(payload.escalated).toBe(true);
      expect(payload.reason).toBe("terminal_address_mismatch");
      expect(listDirSorted(path.join(ticketDir, "artifacts"))).toEqual(artifactsBefore);
    }

    // Subcase B: replaced under the same name DURING wait (after first verified lookup of t1).
    {
      const sb = createSandbox("r4b");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const expectedLines = 10;
      const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--expected-lines",
          String(expectedLines),
          "--gate-fifo",
          gateFifo,
          "--crash-at",
          "after_receipt",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const artifactsBefore = listDirSorted(path.join(ticketDir, "artifacts"));
      const callsBefore = readFakeHcCalls(sb.fakeHcStateDir).length;

      // Replacement worker produces valid framed output so only address pinning prevents capture.
      const replacementSpec = JSON.stringify({
        name: expectedName,
        argv: buildStandInWorkerArgv({ attemptId: "a1", expectedLines }),
      });

      const recoverPromise = runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        {
          ...sb.env,
          FAKE_HC_REPLACE_AFTER_WAIT: replacementSpec,
        },
      );

      // Once recover completes its first get(expectedName) while t1 is live, unblock t1.
      await waitForRecordedCall(sb.fakeHcStateDir, callsBefore, (c) => c.argv[0] === "get" && c.argv[1] === expectedName);
      releaseGateFifo(gateFifo);

      const recRes = await recoverPromise;
      expect(recRes.signal).toBeNull();
      const payload = JSON.parse(recRes.stdout);
      expect(payload.outcome, "replaced terminal under same name during wait must stay uncertain").toBe("uncertain");
      expect(recRes.exitCode).toBe(3);
      expect(payload.escalated).toBe(true);
      expect(payload.reason).toBe("terminal_missing_after_wait");

      // Post-wait lookup targeted verified address t1; zero reads occurred; zero new artifacts saved.
      const recCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBefore);
      expect(recCalls.map((c) => c.argv)).toEqual([
        ["get", expectedName, "--json"],
        ["wait", "t1", "--timeout", "10", "--json"],
        ["get", "t1", "--json"],
      ]);
      expect(listDirSorted(path.join(ticketDir, "artifacts"))).toEqual(artifactsBefore);

      const folded = foldCommitLog(ticketDir);
      expect(folded.phase).toBe("escalated");
      expect(folded.openAttempt?.state).toBe("uncertain");
    }

    assertTripwireNeverRan();
  });

  test("r5-run-failures: definite name_taken settles not_delivered; ambiguous failures end uncertain and never launch again", async () => {
    // 1. Definite failure: name_taken (all four conditions hold -> settles not_delivered).
    {
      const sb = createSandbox("r5-def");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

      const holder = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", expectedName, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateFifo}' || true`],
        sb.env,
      );
      expect(holder.exitCode).toBe(0);
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);

      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
        ],
        sb.env,
      );
      expect(startRes.exitCode).toBe(1);
      const payload = JSON.parse(startRes.stdout);
      expect(payload.outcome).toBe("not_delivered");
      expect(payload.errorKind).toBe("name_taken");

      const folded = foldCommitLog(getTicketDir(sb.stateRoot, issue));
      expect(folded.status).toBe("ok");
      expect(folded.phase).toBe("ready");
      expect(folded.openAttempt).toBeNull();
      expect(folded.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "launch_failed_authoritative",
      ]);
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(2);
      releaseGateFifo(gateFifo);
    }

    // 2. Ambiguous cases: time limit, unparseable stderr, unavailable, address in output, unlisted error kind.
    const ambiguousCases = [
      {
        label: "timeout",
        extraEnv: { FAKE_HC_HANG_CMD: "run", FAKE_HC_HANG_MS: "2500" },
        extraArgs: ["--hc-timeout-ms", "150"],
        expectedReason: "hc_timeout",
      },
      {
        label: "unparseable",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "unparseable" },
        extraArgs: [],
        expectedReason: "unparseable_stderr",
      },
      {
        label: "unavailable",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "unavailable" },
        extraArgs: [],
        expectedReason: "error_unavailable",
      },
      {
        label: "address-in-output",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "error_with_address" },
        extraArgs: [],
        expectedReason: "address_in_output",
      },
      {
        label: "address-in-stderr-message",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "stderr_message_address" },
        extraArgs: [],
        expectedReason: "address_in_output",
      },
      {
        label: "address-in-stderr-hint",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "stderr_hint_address" },
        extraArgs: [],
        expectedReason: "address_in_output",
      },
      {
        label: "unlisted-kind",
        extraEnv: { FAKE_HC_FAIL_RUN_MODE: "unknown_kind" },
        extraArgs: [],
        expectedReason: "unlisted_error_kind",
      },
    ];

    for (const tc of ambiguousCases) {
      const sb = createSandbox(`r5-${tc.label}`);
      const issue = "7";
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          ...tc.extraArgs,
        ],
        { ...sb.env, ...tc.extraEnv },
      );

      expect(startRes.exitCode, `ambiguous case ${tc.label} must exit 1`).toBe(1);
      const payload = JSON.parse(startRes.stdout);
      expect(payload.outcome, `ambiguous case ${tc.label} must settle uncertain`).toBe("uncertain");
      expect(payload.escalated).toBe(true);
      expect(payload.reason).toBe(tc.expectedReason);
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);

      const folded = foldCommitLog(getTicketDir(sb.stateRoot, issue));
      expect(folded.status).toBe("ok");
      expect(folded.phase).toBe("escalated");
      expect(folded.openAttempt?.state).toBe("uncertain");
      expect(folded.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "reconcile_unresolved",
      ]);

      // Subsequent recover stays escalated and never launches again.
      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );
      expect(recRes.exitCode).toBe(0);
      expect(JSON.parse(recRes.stdout).alreadyEscalated).toBe(true);
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
    }

    assertTripwireNeverRan();
  });

  test("edge-cases: wait exit-0 timeout keeps delivered, unsent first_message escalates, schema mismatch escalates, tampered log quarantines, fake counts every run", async () => {
    // 1. Live worker wait timeout (exit 0, ended: false, reason: timeout) does NOT settle as finished.
    {
      const sb = createSandbox("edge-wait-timeout");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--gate-fifo",
          gateFifo,
          "--crash-at",
          "after_receipt",
        ],
        sb.env,
      );
      expect(startRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const waitTimeoutRecover = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--wait-timeout-secs",
          "0.1",
        ],
        sb.env,
      );
      expect(waitTimeoutRecover.exitCode).toBe(4);
      const wtPayload = JSON.parse(waitTimeoutRecover.stdout);
      expect(wtPayload.outcome).toBe("still_running");
      expect(wtPayload.reason).toBe("timeout");
      const folded = foldCommitLog(getTicketDir(sb.stateRoot, issue));
      expect(folded.phase).toBe("building");
      expect(folded.openAttempt?.state).toBe("delivered");
      releaseGateFifo(gateFifo);
    }

    // 2. Crash after launch with retained first_message.sent: false (P3 Behaviour 2 & 7).
    {
      const sb = createSandbox("edge-first-msg");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const envBlocked = { ...sb.env, FAKE_HC_RUN_FIRST_MSG_UNSENT: "permission_blocked" };
      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--gate-fifo",
          gateFifo,
          "--crash-at",
          "after_launch_before_receipt",
        ],
        envBlocked,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );
      expect(recRes.exitCode).toBe(0);
      const recPayload = JSON.parse(recRes.stdout);
      expect(recPayload.outcome).toBe("uncertain");
      expect(recPayload.escalated).toBe(true);
      expect(recPayload.reason).toBe("launch_first_message_unsent");
      expect(recPayload.firstMessage.sent).toBe(false);
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      releaseGateFifo(gateFifo);
    }

    // 3. Schema-invalid response from hc get stays uncertain and escalates (R6).
    {
      const sb = createSandbox("edge-bad-schema");
      const issue = "7";
      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--crash-at",
          "after_intent_before_launch",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        { ...sb.env, FAKE_HC_INVALID_RESPONSE_CMD: "get" },
      );
      expect(recRes.exitCode).toBe(0);
      const recPayload = JSON.parse(recRes.stdout);
      expect(recPayload.outcome).toBe("uncertain");
      expect(recPayload.escalated).toBe(true);
      expect(recPayload.reason).toBe("invalid_response_schema");
    }

    // 4. Corrupt hash chain moves ticket to quarantined and refuses to launch anything.
    {
      const sb = createSandbox("edge-quarantine");
      const issue = "7";
      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--crash-at",
          "after_intent_before_launch",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const rec1Path = path.join(getTicketDir(sb.stateRoot, issue), "log", "000001.json");
      const orig = fs.readFileSync(rec1Path, "utf8");
      fs.writeFileSync(rec1Path, `${orig} `, "utf8");

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        sb.env,
      );
      expect(recRes.exitCode).toBe(2);
      expect(JSON.parse(recRes.stdout).outcome).toBe("quarantined");
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(0);
    }

    // 5. Fake hc errors go on stderr with schema error kinds and every run call is counted.
    {
      const sb = createSandbox("edge-run-count");
      const gateFifo = makeGateFifo(sb.workDir);
      const name1 = `${sb.prefix}-dup`;
      const name2 = `${sb.prefix}-two`;
      const r1 = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name1, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateFifo}' || true`],
        sb.env,
      );
      expect(r1.exitCode).toBe(0);
      expect(JSON.parse(r1.stdout).address).toBe("t1");

      // Duplicate live name fails with exit 1 name_taken on stderr and still increments runCount.
      const dup = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name1, "--cwd", sb.workDir, "--", "true"],
        sb.env,
      );
      expect(dup.exitCode).toBe(1);
      expect(dup.stdout).toBe("");
      expect(JSON.parse(dup.stderr).error.kind).toBe("name_taken");

      // rm on a live terminal returns schema-listed kind "live" on stderr.
      const rmLive = runFakeHcDirect(["rm", "t1", "--json"], sb.env);
      expect(rmLive.exitCode).toBe(1);
      expect(rmLive.stdout).toBe("");
      expect(JSON.parse(rmLive.stderr).error.kind).toBe("live");

      // Distinct second launch allocates distinct address t2 and increments runCount to 3.
      const r2 = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name2, "--cwd", sb.workDir, "--", "true"],
        sb.env,
      );
      expect(r2.exitCode).toBe(0);
      expect(JSON.parse(r2.stdout).address).toBe("t2");
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(3);
      releaseGateFifo(gateFifo);
    }

    assertTripwireNeverRan();
  });

  test("r10-r11-r12: short-form launch passes, malformed run/get/ls/wait are rejected, kill/rm read exit code only, fake counts run once across faults, and unused client fields are absent", async () => {
    function writeStubHc(dir, name, body) {
      const stubPath = path.join(dir, name);
      fs.writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return stubPath;
    }

    // 1. Short-form launch response (`{ address, state }` alone) passes and commits a launch receipt;
    //    fake-hc prints short forms for run and ls entries (omitting name when unnamed) and full Terminal for get.
    {
      const sb = createSandbox("r10-short-launch");
      const issue = "7";
      const minimalHc = writeStubHc(sb.workDir, "minimal-hc", 'printf \'{"address":"t7","state":"live"}\\n\'');
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          minimalHc,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
        ],
        sb.env,
      );
      expect(startRes.exitCode, "minimal short-form {address, state} launch must succeed").toBe(0);
      const payload = JSON.parse(startRes.stdout);
      expect(payload.outcome).toBe("launched");
      expect(payload.address).toBe("t7");
      const folded = foldCommitLog(getTicketDir(sb.stateRoot, issue));
      expect(folded.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "launch_receipt",
      ]);
      expect(folded.records[2].receipt.address).toBe("t7");
      expect(folded.records[2].receipt.state).toBe("live");
      expect(folded.records[2].receipt.name).toBe(payload.terminalName);
      expect(folded.openAttempt?.state).toBe("delivered");

      // Check fake-hc emits real hc 0.1.22 short forms for run and ls entries and full Terminal for get.
      const runNamed = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", `${sb.prefix}-short`, "--cwd", sb.workDir, "--", "true"],
        sb.env,
      );
      expect(runNamed.exitCode).toBe(0);
      const runJson = JSON.parse(runNamed.stdout);
      expect(runJson.address).toBe("t1");
      expect(runJson.state).toBeTypeOf("string");
      for (const fullOnlyKey of ["labels", "argv", "created_ms", "screen", "cols", "rows"]) {
        expect(fullOnlyKey in runJson, `fake run must print short form without ${fullOnlyKey}`).toBe(false);
      }

      // Unnamed terminal omits `name` in fake ls output.
      const runUnnamed = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--cwd", sb.workDir, "--", "true"],
        sb.env,
      );
      expect(runUnnamed.exitCode).toBe(0);
      const lsRes = runFakeHcDirect(["ls", "--all", "--json"], sb.env);
      expect(lsRes.exitCode).toBe(0);
      const lsJson = JSON.parse(lsRes.stdout);
      expect(Array.isArray(lsJson.terminals)).toBe(true);
      expect(typeof lsJson.hidden_finished).toBe("number");
      expect(Array.isArray(lsJson.machines)).toBe(true);
      const unnamedEntry = lsJson.terminals.find((t) => t.address === "t2");
      expect(unnamedEntry).toBeTruthy();
      expect("name" in unnamedEntry).toBe(false);
      for (const fullOnlyKey of ["labels", "argv", "created_ms", "screen", "cols", "rows"]) {
        expect(fullOnlyKey in unnamedEntry, `fake ls entry must print short form without ${fullOnlyKey}`).toBe(false);
      }

      const getRes = runFakeHcDirect(["get", "t1", "--json"], sb.env);
      expect(getRes.exitCode).toBe(0);
      const getJson = JSON.parse(getRes.stdout);
      for (const reqKey of ["address", "labels", "argv", "cwd", "state", "created_ms", "screen", "cols", "rows"]) {
        expect(reqKey in getJson, `fake get must include full Terminal required key ${reqKey}`).toBe(true);
      }
    }

    // 2. Malformed `run` response (no `address`): ends uncertain, commits no launch_receipt, and counts runCount === 1 (R10 + R11).
    {
      const sb = createSandbox("r10-bad-run");
      const issue = "7";
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
        ],
        { ...sb.env, FAKE_HC_INVALID_RESPONSE_CMD: "run" },
      );
      expect(startRes.exitCode, "malformed run response must exit 1").toBe(1);
      const payload = JSON.parse(startRes.stdout);
      expect(payload.outcome).toBe("uncertain");
      expect(payload.escalated).toBe(true);
      expect(payload.reason).toBe("invalid_response_schema");
      const folded = foldCommitLog(getTicketDir(sb.stateRoot, issue));
      expect(folded.phase).toBe("escalated");
      expect(folded.openAttempt?.state).toBe("uncertain");
      expect(folded.records.map((r) => r.event)).toEqual([
        "brief_committed",
        "launch_intent",
        "reconcile_unresolved",
      ]);
      expect(
        readFakeHcState(sb.fakeHcStateDir).runCount,
        "R11: malformed run response must still count as 1 run call",
      ).toBe(1);
    }

    // 3. Malformed `get` response (missing required Terminal fields, plus non-string labels rejected).
    {
      const sb = createSandbox("r10-bad-get");
      const issue = "7";
      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--crash-at",
          "after_intent_before_launch",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        { ...sb.env, FAKE_HC_INVALID_RESPONSE_CMD: "get" },
      );
      expect(recRes.exitCode).toBe(0);
      const recPayload = JSON.parse(recRes.stdout);
      expect(recPayload.outcome).toBe("uncertain");
      expect(recPayload.escalated).toBe(true);
      expect(recPayload.reason).toBe("invalid_response_schema");

      const badLabelsHc = writeStubHc(
        sb.workDir,
        "bad-labels-hc",
        `printf '{"address":"t1","name":"${sb.prefix}-x","labels":{"k":123},"argv":["sh"],"cwd":"/tmp","state":"finished","created_ms":1,"screen":"exact","cols":80,"rows":24}\\n'`,
      );
      const hc = createHcClient({ hcBin: badLabelsHc, prefix: sb.prefix, env: sb.env });
      const getBadLabels = await hc.get(`${sb.prefix}-x`);
      expect(getBadLabels.ok).toBe(false);
      expect(getBadLabels.schemaInvalid).toBe(true);
    }

    // 4. Malformed `ls` response (`terminals` is not an array): cleanup rejects before killing or removing anything;
    //    `hc.ls` also rejects missing `machines`.
    {
      const sb = createSandbox("r10-bad-ls");
      const gateFifo = makeGateFifo(sb.workDir);
      const liveName = `${sb.prefix}-keep-live`;
      const seeded = runFakeHcDirect(
        [
          "run",
          "--bg",
          "--json",
          "--no-parent",
          "--no-notify",
          "--outlive-parent",
          "--name",
          liveName,
          "--cwd",
          sb.workDir,
          "--",
          "sh",
          "-c",
          `IFS= read -r _ < '${gateFifo}' || true`,
        ],
        sb.env,
      );
      expect(seeded.exitCode).toBe(0);

      const cleanRes = await runTracerProcess(
        [
          "cleanup",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--prefix",
          sb.prefix,
        ],
        { ...sb.env, FAKE_HC_INVALID_RESPONSE_CMD: "ls" },
      );
      expect(cleanRes.exitCode, "malformed ls in cleanup must exit non-zero").toBe(1);

      const calls = readFakeHcCalls(sb.fakeHcStateDir);
      const killCalls = calls.filter((c) => c.argv[0] === "kill");
      const rmCalls = calls.filter((c) => c.argv[0] === "rm");
      expect(killCalls.length, "malformed ls in cleanup must make 0 kill calls").toBe(0);
      expect(rmCalls.length, "malformed ls in cleanup must make 0 rm calls").toBe(0);

      const stillLive = runFakeHcDirect(["get", liveName, "--json"], sb.env);
      expect(stillLive.exitCode).toBe(0);
      expect(JSON.parse(stillLive.stdout).state).toBe("live");

      const noMachinesHc = writeStubHc(
        sb.workDir,
        "no-machines-hc",
        'printf \'{"terminals":[],"hidden_finished":0}\\n\'',
      );
      const hc = createHcClient({ hcBin: noMachinesHc, prefix: sb.prefix, env: sb.env });
      let lsErr = null;
      try {
        await hc.ls({ all: true });
      } catch (err) {
        lsErr = err;
      }
      expect(lsErr).toBeInstanceOf(HcBoundaryError);
      expect(lsErr.code).toBe("invalid_json");

      releaseGateFifo(gateFifo);
    }

    // 5. Malformed `wait` response (no `ended`): recover ends uncertain, escalates, and writes zero new artifacts;
    //    `hc.wait` also rejects malformed `children`.
    {
      const sb = createSandbox("r10-bad-wait");
      const gateFifo = makeGateFifo(sb.workDir);
      const issue = "7";
      const crashRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--gate-fifo",
          gateFifo,
          "--crash-at",
          "after_receipt",
        ],
        sb.env,
      );
      expect(crashRes.signal).toBe("SIGKILL");
      waitForKernelLockRelease(sb.stateRoot);

      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const artifactsBefore = fs.readdirSync(path.join(ticketDir, "artifacts")).sort();

      const recRes = await runTracerProcess(
        [
          "recover",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
        ],
        { ...sb.env, FAKE_HC_INVALID_RESPONSE_CMD: "wait" },
      );
      expect(recRes.exitCode, "malformed wait response must exit 3").toBe(3);
      const recPayload = JSON.parse(recRes.stdout);
      expect(recPayload.outcome).toBe("uncertain");
      expect(recPayload.escalated).toBe(true);
      expect(recPayload.reason).toBe("invalid_response_schema");
      const folded = foldCommitLog(ticketDir);
      expect(folded.phase).toBe("escalated");
      expect(folded.openAttempt?.state).toBe("uncertain");
      const artifactsAfter = fs.readdirSync(path.join(ticketDir, "artifacts")).sort();
      expect(artifactsAfter).toEqual(artifactsBefore);

      const badChildrenHc = writeStubHc(
        sb.workDir,
        "bad-children-hc",
        'printf \'{"terminal":"t1","ended":true,"reason":"exit","turn":0,"children":[{"terminal":"t2"}]}\\n\'',
      );
      const hc = createHcClient({ hcBin: badChildrenHc, prefix: sb.prefix, env: sb.env });
      const badWait = await hc.wait(`${sb.prefix}-w`);
      expect(badWait.ok).toBe(false);
      expect(badWait.schemaInvalid).toBe(true);

      releaseGateFifo(gateFifo);
    }

    // 6. `kill` and `rm` read exit code only (0 ok, 3 not_found) and ignore unrecorded output shapes.
    {
      const sb = createSandbox("r10-kill-rm-exit-only");
      const exitZeroStub = writeStubHc(sb.workDir, "exit-zero-hc", "printf 'not-json-at-all\\n'; exit 0");
      const exitThreeStub = writeStubHc(sb.workDir, "exit-three-hc", "exit 3");

      const hcOk = createHcClient({ hcBin: exitZeroStub, prefix: sb.prefix, env: sb.env });
      expect(await hcOk.kill(`${sb.prefix}-t`)).toEqual({ ok: true, exitCode: 0, notFound: false });
      expect(await hcOk.rm(`${sb.prefix}-t`)).toEqual({ ok: true, exitCode: 0, notFound: false });

      const hcNf = createHcClient({ hcBin: exitThreeStub, prefix: sb.prefix, env: sb.env });
      expect(await hcNf.kill(`${sb.prefix}-t`)).toEqual({ ok: false, exitCode: 3, notFound: true });
      expect(await hcNf.rm(`${sb.prefix}-t`)).toEqual({ ok: false, exitCode: 3, notFound: true });
    }

    // 7. R11: a `run` hang that resumes before the caller's time limit counts `runCount === 1`, not 2.
    {
      const sb = createSandbox("r11-hang-resumes");
      const issue = "7";
      const startRes = await runTracerProcess(
        [
          "start",
          "--hc-bin",
          FAKE_HC_PATH,
          "--state-root",
          sb.stateRoot,
          "--project-key",
          sb.projectKey,
          "--issue",
          issue,
          "--prefix",
          sb.prefix,
          "--cwd",
          sb.workDir,
          "--hc-timeout-ms",
          "5000",
        ],
        { ...sb.env, FAKE_HC_HANG_CMD: "run", FAKE_HC_HANG_MS: "80" },
      );
      expect(startRes.exitCode, "resumed hung run must succeed").toBe(0);
      const payload = JSON.parse(startRes.stdout);
      expect(payload.outcome).toBe("launched");
      expect(payload.address).toBe("t1");
      expect(
        readFakeHcState(sb.fakeHcStateDir).runCount,
        "R11: resumed hung run must count as 1, not 2",
      ).toBe(1);
    }

    // 8. R12: createHcClient returns no unused properties (validateArgs, hcBin, prefix, namespace).
    {
      const sb = createSandbox("r12-client-surface");
      const hc = createHcClient({ hcBin: FAKE_HC_PATH, prefix: sb.prefix, env: sb.env });
      expect("validateArgs" in hc).toBe(false);
      expect("hcBin" in hc).toBe(false);
      expect("prefix" in hc).toBe(false);
      expect("namespace" in hc).toBe(false);
    }

    assertTripwireNeverRan();
  });
});
