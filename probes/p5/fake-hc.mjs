#!/usr/bin/env bun
/**
 * Fake `hc` executable for offline probe P5 tests.
 *
 * Responses copy `hc 0.1.22` field names, types, error kinds, and stderr error
 * envelopes from `hc schema --json` and `hc --skill`.
 *
 * FIXTURE PROTOCOL (test harness control channel, NOT real `hc` behaviour):
 * - FAKE_HC_STATE_DIR: required absolute temp folder for fixture state (`state.json`,
 *   `calls.ndjson`, `hangs.ndjson`, `outputs/`, `jobs/`, `ready/`). Exit code 2 reports missing or
 *   non-absolute FAKE_HC_STATE_DIR.
 * - FAKE_HC_PROC_TOKEN: env token propagated to worker children for deterministic cleanup.
 * - FAKE_HC_HANG_CMD + FAKE_HC_HANG_MS: records `calls.ndjson` (`exitCode: -1`) and `hangs.ndjson`
 *   `entered`/`exited` records around a synchronous wait on the named command for timeout testing.
 * - FAKE_HC_RUN_FIRST_MSG_UNSENT: sets unsent `first_message` on launched terminal.
 * - FAKE_HC_FAIL_RUN_MODE: injects run failures (`unparseable`, `unavailable`,
 *   `error_with_address`, `stderr_message_address`, `stderr_hint_address`, `unknown_kind`).
 *   Note: `unknown_kind` emits an unlisted kind solely to test rejection of non-schema kinds.
 * - FAKE_HC_KILL_HOLDER_ON_CMD + FAKE_HC_OWNER_JSON: sends SIGKILL to `owner.json`'s
 *   `holderPid` after the named command completes its read and before it exits.
 * - FAKE_HC_REPLACE_AFTER_WAIT: JSON `{name, argv}`; once `wait` sees the terminal finish,
 *   removes the original terminal and creates a finished replacement under the same name.
 * - FAKE_HC_INVALID_RESPONSE_CMD: emits a schema-invalid JSON response for the named command.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAliveNonZombie, isSameProcessAlive, readProcessStat } from "../p2/lease.mjs";
import { writeJsonAtomic } from "./fake-hc-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "fake-hc-runner.mjs");

const TERMINAL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const DEFAULT_ROWS = 120;
const DEFAULT_COLS = 200;

// Fixture protocol: require an explicit temp folder; exit 2 on bad setup.
const STATE_DIR = process.env.FAKE_HC_STATE_DIR;
if (!STATE_DIR || !path.isAbsolute(STATE_DIR)) {
  process.stderr.write("fake-hc fixture protocol error: requires absolute FAKE_HC_STATE_DIR\n");
  process.exit(2);
}

fs.mkdirSync(path.join(STATE_DIR, "outputs"), { recursive: true });
fs.mkdirSync(path.join(STATE_DIR, "jobs"), { recursive: true });
fs.mkdirSync(path.join(STATE_DIR, "ready"), { recursive: true });

const LOCK_DIR = path.join(STATE_DIR, ".state.lock");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const CALLS_PATH = path.join(STATE_DIR, "calls.ndjson");
const HANGS_PATH = path.join(STATE_DIR, "hangs.ndjson");

function sleepMsSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(fn) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if (err && typeof err === "object" && err.code === "EEXIST") {
        if (Date.now() >= deadline) {
          throw new Error("fake-hc timed out acquiring state lock");
        }
        sleepMsSync(5);
        continue;
      }
      throw err;
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(LOCK_DIR);
    } catch {
      // Ignore lock removal error.
    }
  }
}

// Base-36 counter starting at 46 ("1a") mints made-up local addresses holding a digit then a letter (e.g. t1a, t1b).
const INITIAL_NEXT_ID = 46;

function mintAddress(state) {
  const id = Number.isInteger(state.nextId) && state.nextId >= 1 ? state.nextId : INITIAL_NEXT_ID;
  state.nextId = id + 1;
  return `t${id.toString(36)}`;
}

function loadStateUnlocked() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return { nextId: INITIAL_NEXT_ID, runCount: 0, callSeq: 0, terminals: {} };
    }
    throw err;
  }
}

function saveStateUnlocked(state) {
  writeJsonAtomic(STATE_PATH, state, { pretty: true });
}

function recordCallUnlocked(state, argv, exitCode) {
  state.callSeq = (state.callSeq ?? 0) + 1;
  const entry = {
    seq: state.callSeq,
    ts: new Date().toISOString(),
    argv,
    exitCode,
  };
  fs.appendFileSync(CALLS_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

function recordHangEventUnlocked(state, event) {
  state.hangSeq = (state.hangSeq ?? 0) + 1;
  const entry = {
    seq: state.hangSeq,
    ts: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(HANGS_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

function maybeKillLeaseHolderForFixture(cmd) {
  if (process.env.FAKE_HC_KILL_HOLDER_ON_CMD !== cmd) {
    return;
  }
  const ownerJsonPath = process.env.FAKE_HC_OWNER_JSON;
  if (!ownerJsonPath || !fs.existsSync(ownerJsonPath)) {
    return;
  }
  const owner = JSON.parse(fs.readFileSync(ownerJsonPath, "utf8"));
  const holderPid = owner?.holderPid;
  if (!Number.isInteger(holderPid) || holderPid <= 0) {
    return;
  }
  try {
    process.kill(holderPid, "SIGKILL");
  } catch {
    // Ignore ESRCH if holder already exited.
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isProcessAliveNonZombie(holderPid)) {
    sleepMsSync(5);
  }
}

function refreshTerminal(rec) {
  if (rec.state !== "live") {
    return rec;
  }
  const exitPath = path.join(STATE_DIR, "outputs", `${rec.address}.exit.json`);
  if (fs.existsSync(exitPath)) {
    try {
      const exitInfo = JSON.parse(fs.readFileSync(exitPath, "utf8"));
      rec.state = "finished";
      rec.exit_code = exitInfo.exit_code ?? null;
      rec.signal = exitInfo.signal ?? null;
      rec.reason = exitInfo.reason ?? "exited";
      rec.finished_ms = exitInfo.finished_ms ?? Date.now();
      return rec;
    } catch {
      // Retry next refresh if partially visible.
    }
  }
  if (rec.workerPid && rec.workerStartTime && !isSameProcessAlive(rec.workerPid, rec.workerStartTime)) {
    const waitDeadline = Date.now() + 200;
    while (Date.now() < waitDeadline) {
      if (fs.existsSync(exitPath)) {
        try {
          const exitInfo = JSON.parse(fs.readFileSync(exitPath, "utf8"));
          rec.state = "finished";
          rec.exit_code = exitInfo.exit_code ?? null;
          rec.signal = exitInfo.signal ?? null;
          rec.reason = exitInfo.reason ?? "exited";
          rec.finished_ms = exitInfo.finished_ms ?? Date.now();
          return rec;
        } catch {
          // Wait briefly.
        }
      }
      sleepMsSync(5);
    }
    rec.state = "finished";
    rec.exit_code = rec.exit_code ?? 0;
    rec.signal = rec.signal ?? null;
    rec.reason = rec.reason ?? "exited";
    rec.finished_ms = rec.finished_ms ?? Date.now();
  }
  return rec;
}

/**
 * Emits full `Terminal` fields defined by `hc schema --json` (`hc get --json`),
 * including all required fields and optional `first_message` only when unsent.
 */
function toPublicTerminal(rec) {
  const out = {
    address: rec.address,
    argv: rec.argv,
    cols: rec.cols,
    created_ms: rec.created_ms,
    cwd: rec.cwd,
    die_with_parent: rec.die_with_parent,
    exit_code: rec.exit_code,
    finished_ms: rec.finished_ms,
    identity: "",
    keep: rec.keep,
    labels: rec.labels,
    name: rec.name,
    notify: rec.notify,
    parent: rec.parent,
    pid: rec.workerPid ?? null,
    reason: rec.reason,
    reported: rec.reported,
    rm: rec.rm,
    rows: rec.rows,
    screen: rec.screen,
    signal: rec.signal,
    state: rec.state,
    status: rec.status,
    status_ms: rec.status_ms,
    template: rec.template,
    title: "",
    turn: rec.turn,
  };
  if (rec.first_message && rec.first_message.sent === false) {
    out.first_message = rec.first_message;
  }
  return out;
}

/**
 * Short CLI launch form matching `hc 0.1.22` `hc run --bg --json` (P3 `a1`/`b1`/`c1`/`d3`
 * and Captain's field-name reading of 2026-11-27).
 */
function toShortRunResult(rec) {
  const out = {
    address: rec.address,
    agent: path.basename(rec.argv[0] ?? ""),
    cwd: rec.cwd,
    state: rec.state,
    turn: rec.turn,
  };
  if (rec.name !== null) {
    out.name = rec.name;
  }
  if (rec.parent !== null) {
    out.parent = rec.parent;
  }
  if (rec.template !== null) {
    out.template = rec.template;
  }
  if (rec.first_message && rec.first_message.sent === false) {
    out.first_message = rec.first_message;
  }
  return out;
}

/**
 * Short CLI list entry matching `hc 0.1.22` `hc ls --all --json`
 * (Captain's field-name reading of 2026-11-27; omits `name` when unnamed).
 */
function toShortListEntry(rec) {
  const out = {
    address: rec.address,
    agent: path.basename(rec.argv[0] ?? ""),
    cwd: rec.cwd,
    state: rec.state,
    turn: rec.turn,
    where: rec.cwd,
  };
  if (rec.name !== null) {
    out.name = rec.name;
  }
  return out;
}

function findTerminal(state, target) {
  if (state.terminals[target]) {
    return state.terminals[target];
  }
  let finishedMatch = null;
  for (const rec of Object.values(state.terminals)) {
    refreshTerminal(rec);
    if (rec.name === target) {
      if (rec.state === "live") {
        return rec;
      }
      finishedMatch = rec;
    }
  }
  return finishedMatch;
}

function jsonOut(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Per `hc --skill` line 347: Errors are `{error: {kind, message, hint}}` on stderr.
function errorOut(exitCode, kind, message, hint) {
  process.stderr.write(`${JSON.stringify({ error: { hint, kind, message } })}\n`);
  return exitCode;
}

function killTerminalProcesses(rec) {
  if (rec.workerPid && rec.workerStartTime && isSameProcessAlive(rec.workerPid, rec.workerStartTime)) {
    try {
      process.kill(-rec.workerPid, "SIGKILL");
    } catch {
      try {
        process.kill(rec.workerPid, "SIGKILL");
      } catch {
        // Ignore ESRCH.
      }
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isSameProcessAlive(rec.workerPid, rec.workerStartTime)) {
      sleepMsSync(5);
    }
  }
  if (rec.runnerPid && rec.runnerStartTime && isSameProcessAlive(rec.runnerPid, rec.runnerStartTime)) {
    try {
      process.kill(rec.runnerPid, "SIGKILL");
    } catch {
      // Ignore ESRCH.
    }
  }
}

function splitOutputLines(rawText) {
  if (rawText.length === 0) {
    return [];
  }
  const normalized = rawText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function maybeReplaceTerminalAfterWaitUnlocked(state, rec) {
  const rawSpec = process.env.FAKE_HC_REPLACE_AFTER_WAIT;
  if (!rawSpec || state.replaceAfterWaitDone) {
    return;
  }
  const spec = JSON.parse(rawSpec);
  if (!spec || typeof spec.name !== "string" || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    return;
  }
  if (rec.name !== spec.name) {
    return;
  }
  state.replaceAfterWaitDone = true;

  // Remove the original terminal and replace it under the same name with a new address.
  delete state.terminals[rec.address];

  const replAddr = mintAddress(state);
  const runRes = spawnSync(spec.argv[0], spec.argv.slice(1), {
    cwd: rec.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  const outText = `${runRes.stdout ?? ""}${runRes.stderr ?? ""}`;
  fs.writeFileSync(path.join(STATE_DIR, "outputs", `${replAddr}.log`), outText, "utf8");

  state.terminals[replAddr] = {
    address: replAddr,
    argv: spec.argv,
    cols: DEFAULT_COLS,
    created_ms: Date.now(),
    cwd: rec.cwd,
    die_with_parent: false,
    exit_code: runRes.status ?? 0,
    finished_ms: Date.now(),
    first_message: null,
    keep: false,
    labels: {},
    name: spec.name,
    notify: false,
    parent: null,
    reason: "exited",
    reported: false,
    rm: false,
    rows: DEFAULT_ROWS,
    screen: "exact",
    signal: null,
    state: "finished",
    status: null,
    status_ms: null,
    template: null,
    turn: 0,
    runnerPid: null,
    runnerStartTime: null,
    workerPid: null,
    workerStartTime: null,
  };
}

function runCommand(argv) {
  const cmd = argv[0];

  // Count every `run` invocation once, before any fault branch, so hidden launches are impossible.
  if (cmd === "run") {
    withStateLock(() => {
      const state = loadStateUnlocked();
      state.runCount = (state.runCount ?? 0) + 1;
      saveStateUnlocked(state);
    });
  }

  // Fixture protocol: hang injection for timeout testing.
  if (process.env.FAKE_HC_HANG_CMD && process.env.FAKE_HC_HANG_CMD === cmd) {
    const rawHangMs = Number(process.env.FAKE_HC_HANG_MS ?? "5000");
    const effectiveHangMs = Number.isFinite(rawHangMs) && rawHangMs > 0 ? rawHangMs : 5000;
    const procStat = readProcessStat(process.pid);
    const t0 = performance.now();
    withStateLock(() => {
      const state = loadStateUnlocked();
      recordCallUnlocked(state, argv, -1);
      recordHangEventUnlocked(state, {
        phase: "entered",
        cmd,
        argv,
        pid: process.pid,
        startTime: procStat?.startTime ?? null,
        runCountAtEntry: state.runCount ?? 0,
        hangMs: effectiveHangMs,
      });
      saveStateUnlocked(state);
    });
    sleepMsSync(effectiveHangMs);
    const elapsedMs = Math.round(performance.now() - t0);
    withStateLock(() => {
      const state = loadStateUnlocked();
      recordHangEventUnlocked(state, {
        phase: "exited",
        cmd,
        argv,
        pid: process.pid,
        startTime: procStat?.startTime ?? null,
        runCountAtExit: state.runCount ?? 0,
        hangMs: effectiveHangMs,
        elapsedMs,
      });
      saveStateUnlocked(state);
    });
  }

  // Fixture protocol: schema-invalid response injection.
  if (process.env.FAKE_HC_INVALID_RESPONSE_CMD && process.env.FAKE_HC_INVALID_RESPONSE_CMD === cmd) {
    withStateLock(() => {
      const state = loadStateUnlocked();
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
    });
    if (cmd === "run") {
      jsonOut({ state: "live" });
    } else if (cmd === "get") {
      jsonOut({ address: "t1a", state: "finished", cwd: "/tmp" });
    } else if (cmd === "ls") {
      jsonOut({ terminals: "not-an-array", hidden_finished: 0, machines: [] });
    } else if (cmd === "wait") {
      jsonOut({ terminal: "t1a", reason: "exit", turn: 0, children: [] });
    } else {
      jsonOut({ address: "t1a", state: 123 });
    }
    return 0;
  }

  if (cmd === "--version") {
    withStateLock(() => {
      const state = loadStateUnlocked();
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
    });
    process.stdout.write("hc 0.1.22\n");
    return 0;
  }

  if (cmd === "schema") {
    withStateLock(() => {
      const state = loadStateUnlocked();
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
    });
    jsonOut({
      openrpc: "1.3.2",
      info: { title: "hc", version: "0.1.22" },
      methods: [
        { name: "terminal.run" },
        { name: "terminal.get" },
        { name: "terminal.list" },
        { name: "terminal.read" },
        { name: "terminal.wait" },
        { name: "terminal.kill" },
        { name: "terminal.rm" },
      ],
    });
    return 0;
  }

  if (cmd === "run") {
    const dd = argv.indexOf("--");
    const flagsPart = dd === -1 ? argv.slice(1) : argv.slice(1, dd);
    const childArgv = dd === -1 ? [] : argv.slice(dd + 1);

    let name = null;
    let cwd = process.cwd();
    let noParent = false;
    let noNotify = false;
    let outliveParent = false;
    const extraPositionals = [];

    for (let i = 0; i < flagsPart.length; i += 1) {
      const tok = flagsPart[i];
      if (tok === "--bg" || tok === "--json") {
        continue;
      }
      if (tok === "--no-parent") {
        noParent = true;
        continue;
      }
      if (tok === "--no-notify") {
        noNotify = true;
        continue;
      }
      if (tok === "--outlive-parent") {
        outliveParent = true;
        continue;
      }
      if (tok === "--name") {
        name = flagsPart[++i];
        continue;
      }
      if (tok.startsWith("--name=")) {
        name = tok.slice("--name=".length);
        continue;
      }
      if (tok === "--cwd") {
        cwd = flagsPart[++i];
        continue;
      }
      if (tok.startsWith("--cwd=")) {
        cwd = tok.slice("--cwd=".length);
        continue;
      }
      extraPositionals.push(tok);
    }

    const effectiveArgv = childArgv.length > 0 ? childArgv : extraPositionals;

    const prepared = withStateLock(() => {
      const state = loadStateUnlocked();

      const failMode = process.env.FAKE_HC_FAIL_RUN_MODE;
      if (failMode === "unparseable") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        process.stderr.write("fatal: broken pipe\n");
        return { exitCode: 1 };
      }
      if (failMode === "unavailable") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "unavailable", "core is unavailable", "retry after the core responds"),
        };
      }
      if (failMode === "error_with_address") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        jsonOut({ address: "t99" });
        return {
          exitCode: errorOut(1, "spawn_failed", "failed after allocation", "inspect before retrying"),
        };
      }
      if (failMode === "stderr_message_address") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "spawn_failed", "allocated t123 before failing", "inspect before retrying"),
        };
      }
      if (failMode === "stderr_message_letter_address") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "spawn_failed", "allocated t2k before failing", "inspect before retrying"),
        };
      }
      if (failMode === "stderr_hint_address") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "spawn_failed", "spawn failed after start", "check t123 before retrying"),
        };
      }
      // Fixture fault injection: emits an unlisted error kind to exercise R5 ambiguous handling.
      if (failMode === "unknown_kind") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "registry_save_failed", "registry write failed", "check hc ls --all"),
        };
      }

      if (name !== null && !TERMINAL_NAME_RE.test(name)) {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "invalid_params", `invalid terminal name "${name}"`, "use 1-32 chars of a-z 0-9 - _ ."),
        };
      }

      if (name !== null) {
        for (const existing of Object.values(state.terminals)) {
          refreshTerminal(existing);
          if (existing.state === "live" && existing.name === name) {
            recordCallUnlocked(state, argv, 1);
            saveStateUnlocked(state);
            return {
              exitCode: errorOut(
                1,
                "name_taken",
                `a live terminal is already named "${name}"`,
                "pick another name, or kill the one holding it",
              ),
            };
          }
        }
      }

      if (effectiveArgv.length === 0) {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "invalid_params", "no program given", "pass -- <program>"),
        };
      }

      const address = mintAddress(state);

      const effectiveParent = noParent ? null : (process.env.HC_TERMINAL_ID ?? null);
      const dieWithParent = effectiveParent !== null && !outliveParent;
      const firstMessageUnsent = process.env.FAKE_HC_RUN_FIRST_MSG_UNSENT
        ? { sent: false, reason: process.env.FAKE_HC_RUN_FIRST_MSG_UNSENT }
        : null;

      const rec = {
        address,
        argv: effectiveArgv,
        cols: DEFAULT_COLS,
        created_ms: Date.now(),
        cwd,
        die_with_parent: dieWithParent,
        exit_code: null,
        finished_ms: null,
        first_message: firstMessageUnsent,
        keep: false,
        labels: {},
        name,
        notify: !noNotify,
        parent: effectiveParent,
        reason: null,
        reported: false,
        rm: false,
        rows: DEFAULT_ROWS,
        screen: "exact",
        signal: null,
        state: "live",
        status: null,
        status_ms: null,
        template: null,
        turn: 0,
        runnerPid: null,
        runnerStartTime: null,
        workerPid: null,
        workerStartTime: null,
      };

      state.terminals[address] = rec;
      saveStateUnlocked(state);
      return { exitCode: null, address, rec };
    });

    if (prepared.exitCode !== null) {
      return prepared.exitCode;
    }

    const { address, rec } = prepared;
    const outputPath = path.join(STATE_DIR, "outputs", `${address}.log`);
    const exitPath = path.join(STATE_DIR, "outputs", `${address}.exit.json`);
    const readyPath = path.join(STATE_DIR, "ready", `${address}.json`);
    const jobPath = path.join(STATE_DIR, "jobs", `${address}.json`);

    fs.writeFileSync(outputPath, "", "utf8");
    const procEnv = {};
    if (process.env.FAKE_HC_PROC_TOKEN) {
      procEnv.FAKE_HC_PROC_TOKEN = process.env.FAKE_HC_PROC_TOKEN;
    }
    fs.writeFileSync(
      jobPath,
      `${JSON.stringify({ argv: rec.argv, cwd: rec.cwd, outputPath, exitPath, readyPath, env: procEnv })}\n`,
      "utf8",
    );

    const runner = spawn(process.execPath, [RUNNER_PATH, jobPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...procEnv },
    });
    runner.unref();

    const readyDeadline = Date.now() + 5000;
    let readyInfo = null;
    while (Date.now() < readyDeadline) {
      if (fs.existsSync(readyPath)) {
        try {
          readyInfo = JSON.parse(fs.readFileSync(readyPath, "utf8"));
          break;
        } catch {
          // Wait for atomic rename.
        }
      }
      sleepMsSync(5);
    }

    const runResult = withStateLock(() => {
      const state = loadStateUnlocked();
      const stored = state.terminals[address];
      if (stored && readyInfo) {
        stored.runnerPid = readyInfo.runnerPid ?? null;
        stored.runnerStartTime = readyInfo.runnerStartTime ?? null;
        stored.workerPid = readyInfo.workerPid ?? null;
        stored.workerStartTime = readyInfo.workerStartTime ?? null;
      } else if (stored && runner.pid) {
        stored.runnerPid = runner.pid;
        stored.runnerStartTime = readProcessStat(runner.pid)?.startTime ?? null;
      }
      if (stored) {
        refreshTerminal(stored);
      }
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
      return toShortRunResult(stored ?? rec);
    });

    jsonOut(runResult);
    return 0;
  }

  if (cmd === "ls") {
    const showAll = argv.includes("--all");
    const result = withStateLock(() => {
      const state = loadStateUnlocked();
      const terminals = [];
      let hiddenFinished = 0;
      for (const rec of Object.values(state.terminals)) {
        refreshTerminal(rec);
        if (!showAll && rec.state !== "live") {
          hiddenFinished += 1;
          continue;
        }
        terminals.push(toShortListEntry(rec));
      }
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
      return {
        hidden_finished: hiddenFinished,
        machines: [],
        terminals,
      };
    });
    jsonOut(result);
    return 0;
  }

  if (cmd === "get") {
    const positionals = argv.slice(1).filter((t) => !t.startsWith("-"));
    const target = positionals[0];
    return withStateLock(() => {
      const state = loadStateUnlocked();
      if (!target) {
        recordCallUnlocked(state, argv, 7);
        saveStateUnlocked(state);
        return errorOut(7, "needs_target", "which terminal?", "pass an address like t7 or a name");
      }
      const rec = findTerminal(state, target);
      if (!rec) {
        recordCallUnlocked(state, argv, 3);
        saveStateUnlocked(state);
        return errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals");
      }
      refreshTerminal(rec);
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
      jsonOut(toPublicTerminal(rec));
      return 0;
    });
  }

  if (cmd === "read") {
    let linesArg = 0;
    let wantJson = false;
    const positionals = [];
    for (let i = 1; i < argv.length; i += 1) {
      const tok = argv[i];
      if (tok === "--json") {
        wantJson = true;
      } else if (tok === "--lines") {
        linesArg = Number(argv[++i] ?? "0");
      } else if (tok.startsWith("--lines=")) {
        linesArg = Number(tok.slice("--lines=".length));
      } else if (!tok.startsWith("-")) {
        positionals.push(tok);
      }
    }
    const target = positionals[0];
    const rc = withStateLock(() => {
      const state = loadStateUnlocked();
      if (!target) {
        recordCallUnlocked(state, argv, 7);
        saveStateUnlocked(state);
        return errorOut(7, "needs_target", "which terminal?", "pass an address like t7 or a name");
      }
      const rec = findTerminal(state, target);
      if (!rec) {
        recordCallUnlocked(state, argv, 3);
        saveStateUnlocked(state);
        return errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals");
      }
      refreshTerminal(rec);
      const outputPath = path.join(STATE_DIR, "outputs", `${rec.address}.log`);
      const rawText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
      const allLines = splitOutputLines(rawText);

      // Reproduces P3 c4/c5/c7: returns last (rows + lines) lines and still reports complete: true
      // even when earlier lines were cropped by --lines.
      const windowSize = rec.rows + Math.max(0, linesArg);
      const sliced = allLines.length > windowSize ? allLines.slice(allLines.length - windowSize) : allLines;
      const text = sliced.length > 0 ? `${sliced.join("\n")}\n` : "";
      const how = linesArg > 0 ? "history" : "screen";

      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);

      if (wantJson) {
        jsonOut({ complete: true, how, text });
      } else {
        process.stdout.write(text);
      }
      return 0;
    });
    maybeKillLeaseHolderForFixture("read");
    return rc;
  }

  if (cmd === "wait") {
    let timeoutSecs = 180;
    const positionals = [];
    for (let i = 1; i < argv.length; i += 1) {
      const tok = argv[i];
      if (tok === "--json") {
        continue;
      }
      if (tok === "--timeout") {
        timeoutSecs = Number(argv[++i] ?? "180");
      } else if (tok.startsWith("--timeout=")) {
        timeoutSecs = Number(tok.slice("--timeout=".length));
      } else if (!tok.startsWith("-")) {
        positionals.push(tok);
      }
    }
    const target = positionals[0];
    if (!target) {
      return withStateLock(() => {
        const state = loadStateUnlocked();
        recordCallUnlocked(state, argv, 7);
        saveStateUnlocked(state);
        return errorOut(7, "needs_target", "which terminal?", "pass an address like t7 or a name");
      });
    }

    const deadline = Date.now() + Math.max(10, Math.ceil(timeoutSecs * 1000));
    while (true) {
      const check = withStateLock(() => {
        const state = loadStateUnlocked();
        const rec = findTerminal(state, target);
        if (!rec) {
          recordCallUnlocked(state, argv, 3);
          saveStateUnlocked(state);
          return {
            done: true,
            exitCode: errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals"),
          };
        }
        refreshTerminal(rec);
        if (rec.state === "finished") {
          const waitPayload = {
            children: [],
            ended: true,
            exit_code: rec.exit_code,
            reason: "exit",
            signal: rec.signal,
            status: null,
            terminal: rec.address,
            turn: rec.turn,
          };
          maybeReplaceTerminalAfterWaitUnlocked(state, rec);
          recordCallUnlocked(state, argv, 0);
          saveStateUnlocked(state);
          jsonOut(waitPayload);
          return { done: true, exitCode: 0 };
        }
        if (Date.now() >= deadline) {
          recordCallUnlocked(state, argv, 0);
          saveStateUnlocked(state);
          jsonOut({
            children: [],
            ended: false,
            exit_code: null,
            reason: "timeout",
            signal: null,
            status: null,
            terminal: rec.address,
            turn: rec.turn,
          });
          return { done: true, exitCode: 0 };
        }
        saveStateUnlocked(state);
        return { done: false };
      });
      if (check.done) {
        return check.exitCode;
      }
      sleepMsSync(10);
    }
  }

  if (cmd === "kill") {
    const positionals = argv.slice(1).filter((t) => !t.startsWith("-"));
    const target = positionals[0];
    return withStateLock(() => {
      const state = loadStateUnlocked();
      if (!target) {
        recordCallUnlocked(state, argv, 7);
        saveStateUnlocked(state);
        return errorOut(7, "needs_target", "which terminal?", "pass an address like t7 or a name");
      }
      const rec = findTerminal(state, target);
      if (!rec) {
        recordCallUnlocked(state, argv, 3);
        saveStateUnlocked(state);
        return errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals");
      }
      refreshTerminal(rec);
      if (rec.state === "live") {
        killTerminalProcesses(rec);
        rec.state = "finished";
        rec.exit_code = null;
        rec.signal = 1;
        rec.reason = "killed";
        rec.finished_ms = Date.now();
      }
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
      jsonOut(toPublicTerminal(rec));
      return 0;
    });
  }

  if (cmd === "rm") {
    const positionals = argv.slice(1).filter((t) => !t.startsWith("-"));
    const target = positionals[0];
    return withStateLock(() => {
      const state = loadStateUnlocked();
      if (!target) {
        recordCallUnlocked(state, argv, 7);
        saveStateUnlocked(state);
        return errorOut(7, "needs_target", "which terminal?", "pass an address like t7 or a name");
      }
      const rec = findTerminal(state, target);
      if (!rec) {
        recordCallUnlocked(state, argv, 3);
        saveStateUnlocked(state);
        return errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals");
      }
      refreshTerminal(rec);
      if (rec.state === "live") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return errorOut(1, "live", `terminal "${rec.address}" is still live`, "kill it first");
      }
      const addr = rec.address;
      delete state.terminals[addr];
      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);
      jsonOut({ removed: addr });
      return 0;
    });
  }

  return withStateLock(() => {
    const state = loadStateUnlocked();
    recordCallUnlocked(state, argv, 1);
    saveStateUnlocked(state);
    return errorOut(1, "invalid_params", `unsupported command "${cmd}"`, "use an allowed command");
  });
}

const exitCode = runCommand(process.argv.slice(2));
process.exit(exitCode);
