#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSameProcessAlive, readProcessStat } from "../p2/lease.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "fake-hc-runner.mjs");

const TERMINAL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const DEFAULT_ROWS = 120;
const DEFAULT_COLS = 200;

const STATE_DIR = process.env.FAKE_HC_STATE_DIR;
if (!STATE_DIR || !path.isAbsolute(STATE_DIR)) {
  process.stderr.write("fake-hc requires absolute FAKE_HC_STATE_DIR\n");
  process.exit(2);
}

fs.mkdirSync(path.join(STATE_DIR, "outputs"), { recursive: true });
fs.mkdirSync(path.join(STATE_DIR, "jobs"), { recursive: true });
fs.mkdirSync(path.join(STATE_DIR, "ready"), { recursive: true });

const LOCK_DIR = path.join(STATE_DIR, ".state.lock");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const CALLS_PATH = path.join(STATE_DIR, "calls.ndjson");

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

function loadStateUnlocked() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return { nextId: 1, runCount: 0, callSeq: 0, terminals: {} };
    }
    throw err;
  }
}

function saveStateUnlocked(state) {
  const tmpPath = path.join(STATE_DIR, `.state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, STATE_PATH);
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
    // Runner may still be flushing exit.json; wait briefly.
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
 * Emits the exact 27 top-level keys of `hc get --json` documented in docs/probes/p3.md,
 * plus optional `first_message` only when unsent (retaining P3 Behaviour 2 semantics).
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
 * Emits the short terminal record returned by `hc run --bg --json` and `hc ls --all --json`
 * (matching docs/probes/p3.md steps a1, b1, c1, c8, d3).
 */
function toShortTerminal(rec) {
  const program = rec.argv[0] ?? "";
  const agent = program.split("/").pop() || "";
  const out = {
    address: rec.address,
    agent,
    cwd: rec.cwd,
    name: rec.name,
    state: rec.state,
    turn: rec.turn,
  };
  if (rec.parent !== null) {
    out.parent = rec.parent;
  }
  if (rec.exit_code !== null) {
    out.exit_code = rec.exit_code;
  }
  if (rec.signal !== null) {
    out.signal = rec.signal;
  }
  if (rec.reason !== null) {
    out.reason = rec.reason;
  }
  if (rec.first_message && rec.first_message.sent === false) {
    out.first_message = rec.first_message;
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

function errorOut(exitCode, kind, message, hint) {
  jsonOut({ error: { hint, kind, message } });
  return exitCode;
}

function killTerminalProcesses(rec) {
  if (rec.workerPid && rec.workerStartTime && isSameProcessAlive(rec.workerPid, rec.workerStartTime)) {
    try {
      // Kill the worker's detached process group first so child commands (e.g. sleep) end too.
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

function runCommand(argv) {
  const cmd = argv[0];

  // Fault injection for testing hc boundary timeout handling (env-only, invents no JSON fields).
  if (process.env.FAKE_HC_HANG_CMD && process.env.FAKE_HC_HANG_CMD === cmd) {
    const hangMs = Number(process.env.FAKE_HC_HANG_MS ?? "5000");
    sleepMsSync(Number.isFinite(hangMs) && hangMs > 0 ? hangMs : 5000);
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
    let keep = false;
    let rm = false;
    let parent = null;
    const labels = {};
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
      if (tok === "--keep") {
        keep = true;
        continue;
      }
      if (tok === "--rm") {
        rm = true;
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
      if (tok === "--parent") {
        parent = flagsPart[++i];
        continue;
      }
      if (tok === "--label") {
        const kv = flagsPart[++i] ?? "";
        const eq = kv.indexOf("=");
        if (eq !== -1) {
          labels[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        continue;
      }
      extraPositionals.push(tok);
    }

    const effectiveArgv = childArgv.length > 0 ? childArgv : extraPositionals;

    const prepared = withStateLock(() => {
      const state = loadStateUnlocked();
      // Always count every run call so hidden duplicate launches are impossible.
      state.runCount = (state.runCount ?? 0) + 1;

      if (process.env.FAKE_HC_FAIL_RUN_NO_ADDR === "1") {
        recordCallUnlocked(state, argv, 1);
        saveStateUnlocked(state);
        return {
          exitCode: errorOut(1, "spawn_failed", "simulated launch failure with no address", "check the program name and cwd"),
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

      const address = `t${state.nextId}`;
      state.nextId += 1;

      const effectiveParent = noParent ? null : (parent ?? process.env.HC_TERMINAL_ID ?? null);
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
        keep,
        labels,
        name,
        notify: !noNotify,
        parent: effectiveParent,
        reason: null,
        reported: false,
        rm,
        rows: DEFAULT_ROWS,
        screen: process.env.FAKE_HC_SCREEN_INEXACT === "1" ? "inexact" : "exact",
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

    const shortResult = withStateLock(() => {
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
      return toShortTerminal(stored ?? rec);
    });

    jsonOut(shortResult);
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
        terminals.push(toShortTerminal(rec));
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
      const outputPath = path.join(STATE_DIR, "outputs", `${rec.address}.log`);
      const rawText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
      const allLines = splitOutputLines(rawText);

      // Reproduces P3 c4/c5/c7: returns last (rows + lines) lines and STILL reports complete: true
      // even when earlier lines were cropped by --lines.
      const windowSize = rec.rows + Math.max(0, linesArg);
      const sliced = allLines.length > windowSize ? allLines.slice(allLines.length - windowSize) : allLines;
      const text = sliced.length > 0 ? `${sliced.join("\n")}\n` : "";
      const how = linesArg > 0 ? "history" : "screen";
      const complete = process.env.FAKE_HC_READ_INCOMPLETE === "1" ? false : true;

      recordCallUnlocked(state, argv, 0);
      saveStateUnlocked(state);

      if (wantJson) {
        const res = { complete, how, text };
        if (!complete) {
          res.why = "working";
        }
        jsonOut(res);
      } else {
        process.stdout.write(text);
      }
      return 0;
    });
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
      } else if (tok === "--children" || tok === "--output") {
        i += 1;
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
          return { done: true, exitCode: errorOut(3, "not_found", `no terminal "${target}"`, "run hc ls --all to list terminals") };
        }
        refreshTerminal(rec);
        if (rec.state === "finished") {
          recordCallUnlocked(state, argv, 0);
          saveStateUnlocked(state);
          jsonOut({
            children: [],
            ended: true,
            exit_code: rec.exit_code,
            reason: "exit",
            signal: rec.signal,
            status: null,
            terminal: rec.address,
            turn: rec.turn,
          });
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
        return errorOut(1, "still_live", `terminal "${rec.address}" is still live`, "kill it first");
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
    return errorOut(1, "unknown_command", `unsupported command "${cmd ?? ""}"`, "check allowed commands");
  });
}

const code = runCommand(process.argv.slice(2));
process.exit(code);
