import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_HC_COMMANDS = Object.freeze([
  "run",
  "get",
  "ls",
  "read",
  "wait",
  "kill",
  "rm",
  "schema",
  "--version",
]);

const FORBIDDEN_HC_COMMANDS = Object.freeze([
  "server",
  "update",
  "machine",
  "keys",
]);

const ALLOWED_COMMAND_SET = new Set(ALLOWED_HC_COMMANDS);
const FORBIDDEN_COMMAND_SET = new Set(FORBIDDEN_HC_COMMANDS);

// Error kinds listed for terminal.run in hc schema --json, excluding unavailable.
const TERMINAL_RUN_DEFINITE_ERROR_KINDS = new Set([
  "invalid_params",
  "name_taken",
  "spawn_failed",
  "invalid_template",
  "not_found",
  "machine_unknown",
  "config",
]);

const MAX_TERMINAL_NAME_LENGTH = 32;
const TERMINAL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const LOCAL_ADDRESS_RE = /^t\d+$/;
const ANY_ADDRESS_EXACT_RE = /^(?:[a-z0-9._-]+\/)?t\d+$/;
const ANY_ADDRESS_TOKEN_RE = /\b(?:[a-z0-9._-]+\/)?t\d+\b/;

// Fixed prefix shape: tag "p5-" followed by 8 to 16 lowercase alphanumeric characters.
const PREFIX_RE = /^p5-[a-z0-9]{8,16}$/;

const DEFAULT_TIMEOUT_MS = 10_000;

export class HcBoundaryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "HcBoundaryError";
    this.code = code;
    this.details = details;
  }
}

export function generateRandomPrefix() {
  return `p5-${crypto.randomBytes(6).toString("hex")}`;
}

export function normalizePrefix(rawPrefix) {
  if (typeof rawPrefix !== "string" || !PREFIX_RE.test(rawPrefix)) {
    throw new HcBoundaryError(
      "invalid_prefix",
      `Terminal name prefix must match ${PREFIX_RE} (got ${JSON.stringify(rawPrefix)})`,
    );
  }
  const namespace = `${rawPrefix}-`;
  return { prefix: rawPrefix, namespace };
}

export function buildDeterministicName({ prefix, issue, attemptId }) {
  const { namespace } = normalizePrefix(prefix);
  const issueStr = String(issue);
  if (!/^[a-z0-9]+$/.test(issueStr)) {
    throw new HcBoundaryError(
      "invalid_name",
      `Issue identifier must be lowercase alphanumeric (got ${JSON.stringify(issue)})`,
    );
  }
  if (typeof attemptId !== "string" || !/^[a-z0-9._-]+$/.test(attemptId)) {
    throw new HcBoundaryError("invalid_name", `attemptId must use [a-z0-9._-] (got ${JSON.stringify(attemptId)})`);
  }
  const name = `${namespace}i${issueStr}-${attemptId}`;
  if (name.length > MAX_TERMINAL_NAME_LENGTH) {
    throw new HcBoundaryError(
      "name_too_long",
      `Deterministic terminal name ${JSON.stringify(name)} is ${name.length} chars (max ${MAX_TERMINAL_NAME_LENGTH})`,
      { name, length: name.length, max: MAX_TERMINAL_NAME_LENGTH },
    );
  }
  if (!TERMINAL_NAME_RE.test(name)) {
    throw new HcBoundaryError("invalid_name", `Deterministic terminal name ${JSON.stringify(name)} has invalid characters`);
  }
  return name;
}

export function validateHcBin(hcBin) {
  if (typeof hcBin !== "string" || hcBin.trim().length === 0) {
    throw new HcBoundaryError(
      "missing_hc_bin",
      "Explicit hc binary path is required; PATH lookup is forbidden",
    );
  }
  if (!hcBin.includes("/")) {
    throw new HcBoundaryError(
      "non_explicit_hc_bin",
      `hc path must be an explicit file path containing '/' (got ${JSON.stringify(hcBin)}); PATH lookup is forbidden`,
    );
  }
  const resolved = path.resolve(hcBin);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new HcBoundaryError(
      "hc_bin_not_found",
      `Explicit hc path does not exist: ${resolved}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (!stat.isFile()) {
    throw new HcBoundaryError("hc_bin_not_executable", `Explicit hc path is not a regular file: ${resolved}`);
  }
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch (err) {
    throw new HcBoundaryError(
      "hc_bin_not_executable",
      `Explicit hc path is not executable: ${resolved}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  return resolved;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isRemoteTarget(target) {
  return typeof target === "string" && (target.includes("/") || target.startsWith("+"));
}

function assertNotRemoteTarget(target, context) {
  if (isRemoteTarget(target)) {
    throw new HcBoundaryError(
      "remote_target_forbidden",
      `Remote target is forbidden (${context}): ${JSON.stringify(target)}`,
      { target, context },
    );
  }
}

function splitAtDoubleDash(args) {
  const idx = args.indexOf("--");
  if (idx === -1) {
    return { hcArgs: args, childArgs: null };
  }
  return { hcArgs: args.slice(0, idx), childArgs: args.slice(idx + 1) };
}

function extractFlagValue(hcArgs, index, flagName) {
  const token = hcArgs[index];
  if (token === flagName) {
    if (index + 1 >= hcArgs.length) {
      throw new HcBoundaryError("invalid_args", `Flag ${flagName} requires a value`);
    }
    return { value: hcArgs[index + 1], nextIndex: index + 1 };
  }
  if (token.startsWith(`${flagName}=`)) {
    return { value: token.slice(flagName.length + 1), nextIndex: index };
  }
  return null;
}

function tryParseJson(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parses the hc stderr error envelope documented in `hc --skill` (line 347):
 * `{error: {kind, message, hint}}`.
 * Only `kind` is returned for programmatic decisions; `message` and `hint`
 * are free text and are validated only for JSON shape.
 */
function parseHcErrorEnvelope(stderr, { requireHint = false } = {}) {
  const parsed = tryParseJson(stderr);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.error)) {
    return { ok: false, kind: null, rawParsed: parsed };
  }
  const errObj = parsed.error;
  const hintMissing = requireHint && !("hint" in errObj);
  const hintBadType =
    "hint" in errObj && typeof errObj.hint !== "string" && errObj.hint !== null;
  if (
    typeof errObj.kind !== "string" ||
    errObj.kind.length === 0 ||
    typeof errObj.message !== "string" ||
    hintMissing ||
    hintBadType
  ) {
    return { ok: false, kind: null, rawParsed: parsed };
  }
  return { ok: true, kind: errObj.kind, rawParsed: parsed };
}

function objectContainsAddressField(value) {
  if (Array.isArray(value)) {
    return value.some(objectContainsAddressField);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, val] of Object.entries(value)) {
    if ((key === "address" || key === "terminal") && typeof val === "string" && ANY_ADDRESS_EXACT_RE.test(val)) {
      return true;
    }
    if (typeof val === "object" && val !== null && objectContainsAddressField(val)) {
      return true;
    }
  }
  return false;
}

function outputContainsTerminalAddress(stdout, parsedStdout, parsedStderr) {
  if (objectContainsAddressField(parsedStdout) || objectContainsAddressField(parsedStderr)) {
    return true;
  }
  if (typeof stdout === "string" && ANY_ADDRESS_TOKEN_RE.test(stdout)) {
    return true;
  }
  return false;
}

function isFirstMessageValid(fm) {
  if (!isPlainObject(fm)) {
    return false;
  }
  if (typeof fm.sent !== "boolean") {
    return false;
  }
  if (fm.reason !== undefined && fm.reason !== null && typeof fm.reason !== "string") {
    return false;
  }
  if (fm.started !== undefined && fm.started !== null && typeof fm.started !== "boolean") {
    return false;
  }
  if (fm.turn !== undefined && fm.turn !== null && !isNonNegativeInt(fm.turn)) {
    return false;
  }
  return true;
}

function isStatusValid(st) {
  return isPlainObject(st) && typeof st.state === "string";
}

function isRunResultValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  if (typeof obj.address !== "string" || obj.address.length === 0) {
    return false;
  }
  if (obj.state !== "live" && obj.state !== "finished") {
    return false;
  }
  if (obj.name !== undefined && obj.name !== null && typeof obj.name !== "string") {
    return false;
  }
  if (obj.turn !== undefined && !isNonNegativeInt(obj.turn)) {
    return false;
  }
  if (obj.first_message !== undefined && obj.first_message !== null && !isFirstMessageValid(obj.first_message)) {
    return false;
  }
  return true;
}

function isTerminalValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  // Required fields from hc schema --json Terminal:
  if (typeof obj.address !== "string" || obj.address.length === 0) {
    return false;
  }
  if (!isPlainObject(obj.labels)) {
    return false;
  }
  if (!Array.isArray(obj.argv) || !obj.argv.every((x) => typeof x === "string")) {
    return false;
  }
  if (typeof obj.cwd !== "string") {
    return false;
  }
  if (obj.state !== "live" && obj.state !== "finished") {
    return false;
  }
  if (!isNonNegativeInt(obj.created_ms)) {
    return false;
  }
  if (typeof obj.screen !== "string") {
    return false;
  }
  if (!isNonNegativeInt(obj.cols) || !isNonNegativeInt(obj.rows)) {
    return false;
  }
  // Optional/defaulted fields read by the tracer and capture verifier:
  if (obj.name !== undefined && obj.name !== null && typeof obj.name !== "string") {
    return false;
  }
  if (obj.keep !== undefined && typeof obj.keep !== "boolean") {
    return false;
  }
  if (obj.exit_code !== undefined && obj.exit_code !== null && !Number.isInteger(obj.exit_code)) {
    return false;
  }
  if (obj.signal !== undefined && obj.signal !== null && !Number.isInteger(obj.signal)) {
    return false;
  }
  if (obj.reason !== undefined && obj.reason !== null && typeof obj.reason !== "string") {
    return false;
  }
  if (obj.turn !== undefined && !isNonNegativeInt(obj.turn)) {
    return false;
  }
  if (obj.status !== undefined && obj.status !== null && !isStatusValid(obj.status)) {
    return false;
  }
  if (obj.first_message !== undefined && obj.first_message !== null && !isFirstMessageValid(obj.first_message)) {
    return false;
  }
  return true;
}

function isCompactTerminalValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  if (typeof obj.address !== "string" || obj.address.length === 0) {
    return false;
  }
  if (obj.state !== "live" && obj.state !== "finished") {
    return false;
  }
  if (obj.name !== undefined && obj.name !== null && typeof obj.name !== "string") {
    return false;
  }
  return true;
}

function isListResultValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  if (!Array.isArray(obj.terminals) || !obj.terminals.every(isCompactTerminalValid)) {
    return false;
  }
  if (!isNonNegativeInt(obj.hidden_finished)) {
    return false;
  }
  if (obj.machines !== undefined && !Array.isArray(obj.machines)) {
    return false;
  }
  return true;
}

function isReadResultValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  if (typeof obj.text !== "string" || typeof obj.complete !== "boolean" || typeof obj.how !== "string") {
    return false;
  }
  if (obj.why !== undefined && obj.why !== null && typeof obj.why !== "string") {
    return false;
  }
  return true;
}

function isWaitResultValid(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  if (
    typeof obj.terminal !== "string" ||
    obj.terminal.length === 0 ||
    typeof obj.ended !== "boolean" ||
    typeof obj.reason !== "string" ||
    !isNonNegativeInt(obj.turn) ||
    !Array.isArray(obj.children)
  ) {
    return false;
  }
  if (obj.exit_code !== undefined && obj.exit_code !== null && !Number.isInteger(obj.exit_code)) {
    return false;
  }
  if (obj.signal !== undefined && obj.signal !== null && !Number.isInteger(obj.signal)) {
    return false;
  }
  if (obj.status !== undefined && obj.status !== null && typeof obj.status !== "string") {
    return false;
  }
  return true;
}

function isRemoveResultValid(obj) {
  return isPlainObject(obj) && typeof obj.removed === "string" && obj.removed.length > 0;
}

export function createHcClient({
  hcBin,
  prefix,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  env = undefined,
}) {
  const resolvedHcBin = validateHcBin(hcBin);
  const { prefix: normalizedPrefix, namespace } = normalizePrefix(prefix);
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new HcBoundaryError(
      "invalid_timeout",
      `defaultTimeoutMs must be a positive finite number (got ${defaultTimeoutMs})`,
    );
  }

  // Tracks local addresses (e.g. "t1") proven by run/ls/get responses to belong to this prefix.
  const authorizedAddresses = new Set();

  function hasPrefix(name) {
    return (
      typeof name === "string" &&
      name.startsWith(namespace) &&
      name.length > namespace.length &&
      TERMINAL_NAME_RE.test(name)
    );
  }

  function recordAuthorizedTerminal(terminal) {
    if (
      isPlainObject(terminal) &&
      typeof terminal.address === "string" &&
      LOCAL_ADDRESS_RE.test(terminal.address) &&
      hasPrefix(terminal.name)
    ) {
      authorizedAddresses.add(terminal.address);
    }
  }

  function assertAllowedTarget(target, command) {
    if (typeof target !== "string" || target.length === 0) {
      throw new HcBoundaryError(
        "missing_terminal_target",
        `hc ${command} must name an explicit terminal`,
        { command },
      );
    }
    assertNotRemoteTarget(target, `hc ${command}`);
    if (LOCAL_ADDRESS_RE.test(target)) {
      if (!authorizedAddresses.has(target)) {
        throw new HcBoundaryError(
          "prefix_violation",
          `hc ${command} refused address ${JSON.stringify(target)}: not verified to carry prefix ${JSON.stringify(namespace)}`,
          { command, target, namespace },
        );
      }
      return;
    }
    if (!hasPrefix(target)) {
      throw new HcBoundaryError(
        "prefix_violation",
        `hc ${command} refused terminal ${JSON.stringify(target)}: name lacks required prefix ${JSON.stringify(namespace)}`,
        { command, target, namespace },
      );
    }
  }

  function validateArgs(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new HcBoundaryError("forbidden_command", "hc command arguments must be a non-empty array");
    }
    for (const arg of args) {
      if (typeof arg !== "string") {
        throw new HcBoundaryError("invalid_args", "All hc arguments must be strings");
      }
    }

    const cmd = args[0];
    if (FORBIDDEN_COMMAND_SET.has(cmd)) {
      throw new HcBoundaryError(
        "forbidden_command",
        `hc subcommand ${JSON.stringify(cmd)} is forbidden`,
        { command: cmd },
      );
    }
    if (!ALLOWED_COMMAND_SET.has(cmd)) {
      throw new HcBoundaryError(
        "forbidden_command",
        `hc subcommand ${JSON.stringify(cmd)} is not in the allowlist`,
        { command: cmd },
      );
    }

    const { hcArgs, childArgs } = splitAtDoubleDash(args.slice(1));
    if (childArgs !== null && cmd !== "run") {
      throw new HcBoundaryError("invalid_args", `Unexpected '--' separator for hc ${cmd}`);
    }

    // Check globally forbidden flags across every command before '--'.
    for (const token of hcArgs) {
      if (token === "--force" || token.startsWith("--force=") || token === "-f") {
        throw new HcBoundaryError(
          "forbidden_flag",
          `Flag ${JSON.stringify(token)} is forbidden on hc ${cmd}`,
          { command: cmd, flag: token },
        );
      }
      if (token === "--on" || token.startsWith("--on=")) {
        throw new HcBoundaryError(
          "remote_target_forbidden",
          `Remote target flag ${JSON.stringify(token)} is forbidden on hc ${cmd}`,
          { command: cmd, flag: token },
        );
      }
    }

    if (cmd === "--version") {
      if (hcArgs.length > 0) {
        throw new HcBoundaryError("invalid_args", "hc --version takes no extra arguments");
      }
      return { cmd, target: null };
    }

    if (cmd === "schema") {
      for (const token of hcArgs) {
        if (token !== "--json") {
          throw new HcBoundaryError("forbidden_flag", `Unsupported flag ${JSON.stringify(token)} on hc schema`);
        }
      }
      return { cmd, target: null };
    }

    if (cmd === "ls") {
      for (const token of hcArgs) {
        if (token === "--all" || token === "--json") {
          continue;
        }
        assertNotRemoteTarget(token, "hc ls");
        throw new HcBoundaryError("forbidden_flag", `Unsupported argument ${JSON.stringify(token)} on hc ls`);
      }
      return { cmd, target: null };
    }

    if (cmd === "run") {
      let name = null;
      let sawPositionals = false;
      for (let i = 0; i < hcArgs.length; i += 1) {
        const token = hcArgs[i];
        if (token === "--keep" || token === "--rm") {
          throw new HcBoundaryError(
            "forbidden_flag",
            `Flag ${JSON.stringify(token)} is forbidden on hc run`,
            { command: cmd, flag: token },
          );
        }
        if (
          token === "--bg" ||
          token === "--json" ||
          token === "--no-parent" ||
          token === "--no-notify" ||
          token === "--outlive-parent"
        ) {
          continue;
        }
        const nameOpt = extractFlagValue(hcArgs, i, "--name");
        if (nameOpt) {
          if (name !== null) {
            throw new HcBoundaryError("invalid_args", "Duplicate --name flag on hc run");
          }
          name = nameOpt.value;
          i = nameOpt.nextIndex;
          continue;
        }
        const cwdOpt = extractFlagValue(hcArgs, i, "--cwd");
        if (cwdOpt) {
          i = cwdOpt.nextIndex;
          continue;
        }
        if (token.startsWith("-")) {
          throw new HcBoundaryError("forbidden_flag", `Unsupported flag ${JSON.stringify(token)} on hc run`);
        }
        sawPositionals = true;
      }

      if (name === null) {
        throw new HcBoundaryError(
          "prefix_violation",
          `hc run requires --name carrying prefix ${JSON.stringify(namespace)}`,
          { command: cmd, namespace },
        );
      }
      assertNotRemoteTarget(name, "hc run --name");
      if (name.length > MAX_TERMINAL_NAME_LENGTH || !TERMINAL_NAME_RE.test(name)) {
        throw new HcBoundaryError(
          "invalid_name",
          `hc run --name ${JSON.stringify(name)} must be 1-32 chars of [a-z0-9._-]`,
          { command: cmd, name },
        );
      }
      if (!hasPrefix(name)) {
        throw new HcBoundaryError(
          "prefix_violation",
          `hc run --name ${JSON.stringify(name)} lacks required prefix ${JSON.stringify(namespace)}`,
          { command: cmd, name, namespace },
        );
      }
      if ((!childArgs || childArgs.length === 0) && !sawPositionals) {
        throw new HcBoundaryError("invalid_args", "hc run requires a program to execute");
      }
      return { cmd, target: name };
    }

    // Target-bearing commands: get, read, wait, kill, rm
    const positionals = [];
    for (let i = 0; i < hcArgs.length; i += 1) {
      const token = hcArgs[i];
      if (token === "--json") {
        continue;
      }
      if (cmd === "read") {
        const linesOpt = extractFlagValue(hcArgs, i, "--lines");
        if (linesOpt) {
          if (!/^\d+$/.test(linesOpt.value)) {
            throw new HcBoundaryError(
              "invalid_args",
              `hc read --lines must be a non-negative integer (got ${JSON.stringify(linesOpt.value)})`,
            );
          }
          i = linesOpt.nextIndex;
          continue;
        }
      }
      if (cmd === "wait") {
        if (token === "--children" || token.startsWith("--children=")) {
          throw new HcBoundaryError("forbidden_flag", `Flag ${JSON.stringify(token)} is forbidden on hc wait`, {
            command: cmd,
            flag: token,
          });
        }
        const timeoutOpt = extractFlagValue(hcArgs, i, "--timeout");
        if (timeoutOpt) {
          const secs = Number(timeoutOpt.value);
          if (!Number.isFinite(secs) || secs <= 0) {
            throw new HcBoundaryError(
              "invalid_args",
              `hc wait --timeout must be positive (got ${JSON.stringify(timeoutOpt.value)})`,
            );
          }
          i = timeoutOpt.nextIndex;
          continue;
        }
      }
      if (token.startsWith("-")) {
        throw new HcBoundaryError("forbidden_flag", `Unsupported flag ${JSON.stringify(token)} on hc ${cmd}`);
      }
      positionals.push(token);
    }

    if (positionals.length === 0) {
      throw new HcBoundaryError(
        "missing_terminal_target",
        `hc ${cmd} must name an explicit terminal`,
        { command: cmd },
      );
    }
    if (positionals.length > 1) {
      throw new HcBoundaryError(
        "invalid_args",
        `hc ${cmd} accepts exactly one terminal target (got ${positionals.length})`,
        { command: cmd, positionals },
      );
    }

    const target = positionals[0];
    assertAllowedTarget(target, cmd);
    return { cmd, target };
  }

  async function execHc(args, { timeoutMs = defaultTimeoutMs } = {}) {
    const { cmd } = validateArgs(args);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new HcBoundaryError("invalid_timeout", `timeoutMs must be a positive finite number (got ${timeoutMs})`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(resolvedHcBin, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: env ?? process.env,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore ESRCH if child exited right as timer fired.
          }
        }
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.once("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          new HcBoundaryError("hc_spawn_error", `Failed to spawn ${resolvedHcBin}: ${err.message}`, {
            command: cmd,
            hcBin: resolvedHcBin,
            cause: err.message,
          }),
        );
      });

      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);

        if (timedOut) {
          reject(
            new HcBoundaryError(
              "hc_timeout",
              `hc ${cmd} timed out after ${timeoutMs}ms and was killed`,
              {
                command: cmd,
                args,
                timeoutMs,
                killed: true,
                signal: signal ?? "SIGKILL",
              },
            ),
          );
          return;
        }

        if (signal !== null) {
          reject(
            new HcBoundaryError(
              "hc_killed",
              `hc ${cmd} terminated by signal ${signal}`,
              { command: cmd, args, signal },
            ),
          );
          return;
        }

        resolve({
          command: cmd,
          args,
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  async function version({ timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["--version"], { timeoutMs });
    if (res.exitCode !== 0) {
      throw new HcBoundaryError("hc_failed", `hc --version exited ${res.exitCode}`, {
        exitCode: res.exitCode,
      });
    }
    return { exitCode: res.exitCode, version: res.stdout.trim() };
  }

  async function schema({ timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["schema", "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      throw new HcBoundaryError("hc_failed", `hc schema exited ${res.exitCode}`, {
        exitCode: res.exitCode,
      });
    }
    const parsed = tryParseJson(res.stdout);
    if (!isPlainObject(parsed) || typeof parsed.openrpc !== "string" || !Array.isArray(parsed.methods)) {
      throw new HcBoundaryError("invalid_json", "hc schema returned unexpected JSON shape");
    }
    return { exitCode: res.exitCode, schema: parsed };
  }

  async function run({ name, cwd, argv, timeoutMs = defaultTimeoutMs }) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new HcBoundaryError("invalid_args", "run requires a non-empty argv array");
    }
    // Always enforce --bg, --no-parent, --no-notify, and --outlive-parent with no switch to disable them.
    const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name];
    if (typeof cwd === "string" && cwd.length > 0) {
      args.push("--cwd", cwd);
    }
    args.push("--", ...argv);

    let res;
    try {
      res = await execHc(args, { timeoutMs });
    } catch (err) {
      if (err instanceof HcBoundaryError && (err.code === "hc_timeout" || err.code === "hc_killed")) {
        return {
          ok: false,
          disposition: "ambiguous",
          reason: err.code,
          exitCode: null,
          errorKind: null,
        };
      }
      throw err;
    }

    const parsedStdout = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr, { requireHint: true });
      const hasAddress = outputContainsTerminalAddress(res.stdout, parsedStdout, envParsed.rawParsed);

      // Settle not_delivered only when all four conditions hold:
      // 1. hc exited non-zero.
      // 2. stderr parses as {error: {kind, message, hint}}.
      // 3. kind is listed by hc schema --json for terminal.run and is not unavailable.
      // 4. No terminal address appears in the output.
      if (
        envParsed.ok &&
        TERMINAL_RUN_DEFINITE_ERROR_KINDS.has(envParsed.kind) &&
        !hasAddress
      ) {
        return {
          ok: false,
          disposition: "not_delivered",
          reason: "definite_run_error",
          exitCode: res.exitCode,
          errorKind: envParsed.kind,
        };
      }

      let reason;
      if (hasAddress) {
        reason = "address_in_output";
      } else if (!envParsed.ok) {
        reason = "unparseable_stderr";
      } else if (envParsed.kind === "unavailable") {
        reason = "error_unavailable";
      } else {
        reason = "unlisted_error_kind";
      }
      return {
        ok: false,
        disposition: "ambiguous",
        reason,
        exitCode: res.exitCode,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }

    if (!isRunResultValid(parsedStdout)) {
      return {
        ok: false,
        disposition: "ambiguous",
        reason: "invalid_response_schema",
        exitCode: 0,
        errorKind: null,
      };
    }
    recordAuthorizedTerminal(parsedStdout);
    return {
      ok: true,
      exitCode: 0,
      result: parsedStdout,
    };
  }

  async function get(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["get", target, "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      const notFound = envParsed.ok && envParsed.kind === "not_found" && res.exitCode === 3;
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound,
        schemaInvalid: !envParsed.ok,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }
    const parsed = tryParseJson(res.stdout);
    if (!isTerminalValid(parsed)) {
      return {
        ok: false,
        exitCode: 0,
        notFound: false,
        schemaInvalid: true,
        errorKind: null,
      };
    }
    if (!hasPrefix(parsed.name)) {
      throw new HcBoundaryError(
        "prefix_violation",
        `hc get returned terminal ${JSON.stringify(parsed.address)} with name ${JSON.stringify(parsed.name)} outside prefix ${JSON.stringify(namespace)}`,
        { target, address: parsed.address, name: parsed.name, namespace },
      );
    }
    recordAuthorizedTerminal(parsed);
    return {
      ok: true,
      exitCode: 0,
      notFound: false,
      schemaInvalid: false,
      terminal: parsed,
    };
  }

  async function ls({ all = true, timeoutMs = defaultTimeoutMs } = {}) {
    const args = ["ls"];
    if (all) {
      args.push("--all");
    }
    args.push("--json");
    const res = await execHc(args, { timeoutMs });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      throw new HcBoundaryError("hc_failed", `hc ls exited ${res.exitCode}`, {
        exitCode: res.exitCode,
        errorKind: envParsed.ok ? envParsed.kind : null,
      });
    }
    const parsed = tryParseJson(res.stdout);
    if (!isListResultValid(parsed)) {
      throw new HcBoundaryError("invalid_json", "hc ls returned unexpected JSON shape");
    }
    for (const term of parsed.terminals) {
      recordAuthorizedTerminal(term);
    }
    return {
      exitCode: 0,
      hiddenFinished: parsed.hidden_finished,
      machines: parsed.machines ?? [],
      terminals: parsed.terminals,
    };
  }

  async function read(target, { lines = 0, timeoutMs = defaultTimeoutMs } = {}) {
    if (!Number.isInteger(lines) || lines < 0) {
      throw new HcBoundaryError("invalid_args", `read lines must be a non-negative integer (got ${lines})`);
    }
    const res = await execHc(["read", target, "--lines", String(lines), "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: envParsed.ok && envParsed.kind === "not_found" && res.exitCode === 3,
        schemaInvalid: !envParsed.ok,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }
    const parsed = tryParseJson(res.stdout);
    if (!isReadResultValid(parsed)) {
      return {
        ok: false,
        exitCode: 0,
        notFound: false,
        schemaInvalid: true,
        errorKind: null,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      schemaInvalid: false,
      result: parsed,
    };
  }

  async function wait(target, { timeoutSecs = 10, timeoutMs = undefined } = {}) {
    if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
      throw new HcBoundaryError("invalid_args", `wait timeoutSecs must be positive (got ${timeoutSecs})`);
    }
    const processTimeoutMs = timeoutMs ?? Math.max(defaultTimeoutMs, Math.ceil(timeoutSecs * 1000) + 5000);
    const res = await execHc(["wait", target, "--timeout", String(timeoutSecs), "--json"], {
      timeoutMs: processTimeoutMs,
    });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: envParsed.ok && envParsed.kind === "not_found" && res.exitCode === 3,
        schemaInvalid: !envParsed.ok,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }
    const parsed = tryParseJson(res.stdout);
    if (!isWaitResultValid(parsed)) {
      return {
        ok: false,
        exitCode: 0,
        notFound: false,
        schemaInvalid: true,
        errorKind: null,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      schemaInvalid: false,
      result: parsed,
    };
  }

  async function kill(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["kill", target, "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: envParsed.ok && envParsed.kind === "not_found" && res.exitCode === 3,
        schemaInvalid: !envParsed.ok,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }
    const parsed = tryParseJson(res.stdout);
    if (!isCompactTerminalValid(parsed)) {
      return {
        ok: false,
        exitCode: 0,
        notFound: false,
        schemaInvalid: true,
        errorKind: null,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      schemaInvalid: false,
      terminal: parsed,
    };
  }

  async function rm(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["rm", target, "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      const envParsed = parseHcErrorEnvelope(res.stderr);
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: envParsed.ok && envParsed.kind === "not_found" && res.exitCode === 3,
        schemaInvalid: !envParsed.ok,
        errorKind: envParsed.ok ? envParsed.kind : null,
      };
    }
    const parsed = tryParseJson(res.stdout);
    if (!isRemoveResultValid(parsed)) {
      return {
        ok: false,
        exitCode: 0,
        notFound: false,
        schemaInvalid: true,
        errorKind: null,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      schemaInvalid: false,
      removed: parsed.removed,
    };
  }

  return {
    hcBin: resolvedHcBin,
    prefix: normalizedPrefix,
    namespace,
    hasPrefix,
    validateArgs,
    execHc,
    version,
    schema,
    run,
    get,
    ls,
    read,
    wait,
    kill,
    rm,
  };
}
