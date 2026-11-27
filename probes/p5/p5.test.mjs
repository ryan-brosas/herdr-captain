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
import { buildExpectedPayload } from "./capture.mjs";
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
  expect(fs.existsSync(tripwireMarker)).toBe(false);
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
  // Open write-only, write one line, close: unblocks `read < fifo` immediately with zero sleep.
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
  // Blocking flock wait with timeout proves the kernel released owner.lock after SIGKILL (zero sleep polling).
  const res = spawnSync("flock", ["--exclusive", "--timeout", "5", lockPath, "true"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(res.status).toBe(0);
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

  // Confirm the tripwire is genuinely first on PATH for every test environment.
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
    const summary = JSON.parse(startRes.stdout);
    expect(summary.outcome).toBe("launched");
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
    expect(hcFlags).toContain("--outlive-parent");
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

    // Prove launch_intent was committed strictly before hc run executed (recorded timestamps).
    expect(r2.time <= runCalls[0].ts).toBe(true);

    const folded = foldCommitLog(ticketDir);
    expect(folded.status).toBe("ok");
    expect(folded.phase).toBe("building");
    expect(folded.openAttempt?.state).toBe("delivered");
    expect(folded.openAttempt?.terminalName).toBe(expectedName);

    // Let the surviving worker finish cleanly.
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
    expect(missingStart.exitCode).not.toBe(0);
    expect(missingStart.stderr).toContain("missing_hc_bin");

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
      ["cleanup", "--hc-bin", "hc", "--prefix", sb.prefix],
      sb.env,
    );
    expect(bareCleanup.exitCode).not.toBe(0);
    expect(bareCleanup.stderr).toContain("non_explicit_hc_bin");

    // 5. Nonexistent explicit path refused
    const badPath = await runTracerProcess(
      ["cleanup", "--hc-bin", path.join(sb.root, "no-such-hc"), "--prefix", sb.prefix],
      sb.env,
    );
    expect(badPath.exitCode).not.toBe(0);
    expect(badPath.stderr).toContain("hc_bin_not_found");

    // Prove no lease was acquired and PATH tripwire never ran.
    expect(readOwnerRecord(sb.stateRoot)).toBeNull();
    assertTripwireNeverRan();
  });

  test("check-4: SIGKILL after receipt, worker finishes, new controller folds log, finds by name, captures full output, and rejects cropped complete:true read", async () => {
    const sb = createSandbox("check4");
    const gateFifo = makeGateFifo(sb.workDir);
    const reportFile = path.join(sb.workDir, "worker-report.txt");
    const issue = "7";
    const expectedLines = 250; // > 120 screen rows + 50 history lines (170), so --lines 50 crops the top!
    const expectedName = buildDeterministicName({ prefix: sb.prefix, issue, attemptId: "a1" });

    // Controller 1 crashes with real OS SIGKILL right after launch_receipt is durable.
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

    // Must be genuine OS SIGKILL, not a clean exit or thrown error.
    expect(crashRes.signal).toBe("SIGKILL");
    expect(crashRes.exitCode).toBeNull();
    expect(crashRes.stdout).toBe("");

    // Lease holder exits on EOF and kernel releases owner.lock.
    waitForKernelLockRelease(sb.stateRoot);
    const ownerAfterCrash = readOwnerRecord(sb.stateRoot);
    expect(ownerAfterCrash?.epoch).toBe(1);

    // Worker survived the controller's SIGKILL.
    const liveCheck = runFakeHcDirect(["get", expectedName, "--json"], sb.env);
    expect(liveCheck.exitCode).toBe(0);
    expect(JSON.parse(liveCheck.stdout).state).toBe("live");

    // Unblock worker so it finishes while controller is absent.
    releaseGateFifo(gateFifo);
    const waitWorker = runFakeHcDirect(["wait", expectedName, "--timeout", "10", "--json"], sb.env);
    expect(waitWorker.exitCode).toBe(0);
    expect(JSON.parse(waitWorker.stdout).ended).toBe(true);

    // First verify P3's cropped-read trap on a separate state copy:
    // --lines 50 returns 170 lines with complete: true, and the verifier MUST reject it!
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
    expect(croppedRecover.exitCode).toBe(3);
    const croppedPayload = JSON.parse(croppedRecover.stdout);
    expect(croppedPayload.outcome).toBe("capture_unusable");
    expect(croppedPayload.reason).toBe("missing_begin_sentinel");
    expect(croppedPayload.readCompleteClaimed).toBe(true);
    expect(croppedPayload.terminalKept).toBe(true);

    // Prove the cropped read really used --lines 50 and still kept the terminal in fake hc.
    const croppedCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeCropped);
    expect(croppedCalls.some((c) => c.argv[0] === "read" && c.argv.includes("50"))).toBe(true);
    expect(croppedCalls.some((c) => c.argv[0] === "rm" || c.argv[0] === "kill")).toBe(false);

    // Now run full recovery on the real stateRoot as a brand-new controller process (zero shared memory).
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

    // Prove the new controller looked up and read the worker by its deterministic name, not an address.
    const recoverCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeRecover);
    const getCall = recoverCalls.find((c) => c.argv[0] === "get");
    const readCall = recoverCalls.find((c) => c.argv[0] === "read");
    expect(getCall?.argv).toEqual(["get", expectedName, "--json"]);
    expect(readCall?.argv).toEqual(["read", expectedName, "--lines", "1000", "--json"]);

    // Prove fake hc counted exactly ONE run call total.
    expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);

    // Verify persisted artifact contains the complete 250-line output and folded log is clean.
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

      // Zero run calls before recovery, log ends at launch_intent.
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(0);
      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const foldedBefore = foldCommitLog(ticketDir);
      expect(foldedBefore.status).toBe("ok");
      expect(foldedBefore.records.map((r) => r.event)).toEqual(["brief_committed", "launch_intent"]);
      expect(foldedBefore.openAttempt?.state).toBe("intent");
      expect(foldedBefore.recoveryAction).toBe("reconcile_uncertain_launch");

      // New controller acquires lease, folds log, checks hc get <name> (exit 3 not_found), stays uncertain and escalates.
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
      expect(payloadA.outcome).toBe("uncertain");
      expect(payloadA.escalated).toBe(true);
      expect(payloadA.found).toBe(false);
      expect(payloadA.boundAddress).toBeNull();
      expect(payloadA.epoch).toBe(2);
      expect(payloadA.foldedFromSeq).toBe(2);
      expect(payloadA.foldedAttemptStateBefore).toBe("intent");

      // Fake hc counted 0 run calls and 0 send calls; only readback get ran.
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

      // Fake counted 1 run call, and log ends at launch_intent (no receipt).
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      const ticketDir = getTicketDir(sb.stateRoot, issue);
      const foldedBefore = foldCommitLog(ticketDir);
      expect(foldedBefore.status).toBe("ok");
      expect(foldedBefore.records.map((r) => r.event)).toEqual(["brief_committed", "launch_intent"]);
      expect(foldedBefore.openAttempt?.state).toBe("intent");
      expect(foldedBefore.recoveryAction).toBe("reconcile_uncertain_launch");

      // New controller acquires lease, folds log, finds terminal via hc get <name>, reads --lines 0 once,
      // binds address for the record, stays uncertain and escalates without relaunching or resending.
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

      // Fake hc still counted exactly 1 run call and 0 sends; readback used get + read --lines 0 only.
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      const recoverCallsB = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeRecover);
      expect(recoverCallsB.map((c) => c.argv)).toEqual([
        ["get", expectedName, "--json"],
        ["read", expectedName, "--lines", "0", "--json"],
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

  test("check-6: hc boundary refuses every forbidden command and flag, and cuts a hung hc call at its time limit", async () => {
    const sb = createSandbox("check6");
    const hc = createHcClient({
      hcBin: FAKE_HC_PATH,
      prefix: sb.prefix,
      defaultTimeoutMs: 2000,
      env: sb.env,
    });

    // Allowed non-mutating commands work through the boundary against fake hc.
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
      { label: "remote --on", args: ["run", "--bg", "--on", "box", "--name", `${sb.prefix}-w1`, "--", "true"], code: "remote_target_forbidden" },
      { label: "remote --on=", args: ["run", "--bg", "--on=box", "--name", `${sb.prefix}-w1`, "--", "true"], code: "remote_target_forbidden" },
      { label: "remote target slash on get", args: ["get", `box/${sb.prefix}-w1`, "--json"], code: "remote_target_forbidden" },
      { label: "remote target slash on address", args: ["kill", "box/t1", "--json"], code: "remote_target_forbidden" },
      { label: "remote +machine", args: ["get", "+box", "--json"], code: "remote_target_forbidden" },
      { label: "remote +machine on ls", args: ["ls", "+box", "--json"], code: "remote_target_forbidden" },
      { label: "wait with no terminal", args: ["wait", "--timeout", "5", "--json"], code: "missing_terminal_target" },
      { label: "wait --children with no terminal", args: ["wait", "--children", "all", "--json"], code: "missing_terminal_target" },
      { label: "run without prefix", args: ["run", "--bg", "--name", "other-worker", "--", "true"], code: "prefix_violation" },
      { label: "run without --name", args: ["run", "--bg", "--", "true"], code: "prefix_violation" },
      { label: "get without prefix", args: ["get", "other-worker", "--json"], code: "prefix_violation" },
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
    // Refused calls must NEVER spawn the hc program.
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

    expect(timeoutErr).toBeInstanceOf(HcBoundaryError);
    expect(timeoutErr.code).toBe("hc_timeout");
    expect(timeoutErr.details.killed).toBe(true);
    expect(timeoutErr.details.timeoutMs).toBe(150);
    expect(elapsedMs).toBeLessThan(1200);
    assertTripwireNeverRan();
  });

  test("check-7: cleanup removes every terminal with the prefix, leaves unprefixed terminal in place, and reads each removed one back by address", async () => {
    const sb = createSandbox("check7");
    const gateLive = makeGateFifo(sb.workDir, "live.fifo");
    const gateOther = makeGateFifo(sb.workDir, "other.fifo");

    const prefixedLiveName = `${sb.prefix}-live`;
    const prefixedDoneName = `${sb.prefix}-done`;
    const unprefixedName = "other-keep-term";

    // Seed three terminals directly via fake-hc:
    // 1. Live terminal WITH prefix
    const r1 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", prefixedLiveName, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateLive}' || true`],
      sb.env,
    );
    expect(r1.exitCode).toBe(0);
    const addrLive = JSON.parse(r1.stdout).address;

    // 2. Finished terminal WITH prefix
    const r2 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", prefixedDoneName, "--cwd", sb.workDir, "--", "sh", "-c", "echo done"],
      sb.env,
    );
    expect(r2.exitCode).toBe(0);
    const addrDone = JSON.parse(r2.stdout).address;
    const waitDone = runFakeHcDirect(["wait", addrDone, "--timeout", "5", "--json"], sb.env);
    expect(waitDone.exitCode).toBe(0);
    expect(JSON.parse(waitDone.stdout).ended).toBe(true);

    // 3. Live terminal WITHOUT prefix (must stay untouched!)
    const r3 = runFakeHcDirect(
      ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", unprefixedName, "--cwd", sb.workDir, "--", "sh", "-c", `IFS= read -r _ < '${gateOther}' || true`],
      sb.env,
    );
    expect(r3.exitCode).toBe(0);
    const addrOther = JSON.parse(r3.stdout).address;

    const callsBeforeCleanup = readFakeHcCalls(sb.fakeHcStateDir).length;
    const cleanupRes = await runTracerProcess(
      ["cleanup", "--hc-bin", FAKE_HC_PATH, "--prefix", sb.prefix],
      sb.env,
    );

    expect(cleanupRes.signal).toBeNull();
    expect(cleanupRes.exitCode).toBe(0);
    const summary = JSON.parse(cleanupRes.stdout);
    expect(summary.outcome).toBe("cleaned");
    expect(summary.remainingPrefixedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.removed.map((x) => x.address).sort()).toEqual([addrLive, addrDone].sort());
    for (const item of summary.removed) {
      expect(item.readbackExitCode).toBe(3);
      expect(item.readbackKind).toBe("not_found");
    }

    // Verify exact calls made by cleanup: rm + post-rm get BY ADDRESS for each prefixed terminal,
    // and ZERO kill/rm calls for the unprefixed terminal!
    const cleanupCalls = readFakeHcCalls(sb.fakeHcStateDir).slice(callsBeforeCleanup);
    for (const addr of [addrLive, addrDone]) {
      const rmIdx = cleanupCalls.findIndex((c) => c.argv[0] === "rm" && c.argv[1] === addr);
      const getAfterRmIdx = cleanupCalls.findIndex(
        (c, idx) => idx > rmIdx && c.argv[0] === "get" && c.argv[1] === addr && c.exitCode === 3,
      );
      expect(rmIdx).toBeGreaterThan(-1);
      expect(getAfterRmIdx).toBeGreaterThan(rmIdx);
    }
    expect(cleanupCalls.some((c) => (c.argv[0] === "kill" || c.argv[0] === "rm") && (c.argv[1] === addrOther || c.argv[1] === unprefixedName))).toBe(false);

    // Verify unprefixed terminal is STILL live and untouched in fake hc.
    const otherAfter = runFakeHcDirect(["get", addrOther, "--json"], sb.env);
    expect(otherAfter.exitCode).toBe(0);
    const otherTerm = JSON.parse(otherAfter.stdout);
    expect(otherTerm.name).toBe(unprefixedName);
    expect(otherTerm.state).toBe("live");

    // Verify both prefixed terminals are gone by address.
    expect(runFakeHcDirect(["get", addrLive, "--json"], sb.env).exitCode).toBe(3);
    expect(runFakeHcDirect(["get", addrDone, "--json"], sb.env).exitCode).toBe(3);

    // Release unprefixed fixture worker cleanly.
    releaseGateFifo(gateOther);
    const waitOther = runFakeHcDirect(["wait", addrOther, "--timeout", "5", "--json"], sb.env);
    expect(waitOther.exitCode).toBe(0);
    assertTripwireNeverRan();
  });

  test("edge-cases: wait exit-0 timeout keeps delivered, unsent first_message escalates, tampered log quarantines, fake counts every run", async () => {
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

      // Worker is still blocked on gateFifo: recover waits briefly, sees ended:false, stays delivered.
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
      const envBlocked = { ...sb.env, FAKE_HC_RUN_FIRST_MSG_UNSENT: "Trust this folder?" };
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
      expect(recPayload.firstMessage).toEqual({ sent: false, reason: "Trust this folder?" });
      expect(readFakeHcState(sb.fakeHcStateDir).runCount).toBe(1);
      releaseGateFifo(gateFifo);
    }

    // 3. Corrupt hash chain moves ticket to quarantined and refuses to launch anything.
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

      // Tamper with 000001.json so 000002.json's prevRecordSha256 chain breaks.
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

    // 4. Fake hc never hides a second launch behind the same address and counts every run call.
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

      // Duplicate live name fails with exit 1 name_taken AND still increments runCount.
      const dup = runFakeHcDirect(
        ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name1, "--cwd", sb.workDir, "--", "true"],
        sb.env,
      );
      expect(dup.exitCode).toBe(1);
      expect(JSON.parse(dup.stdout).error.kind).toBe("name_taken");

      // Distinct second launch allocates distinct address t2 AND increments runCount to 3.
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
});
