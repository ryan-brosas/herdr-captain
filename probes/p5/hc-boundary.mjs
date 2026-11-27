import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ALLOWED_HC_COMMANDS = Object.freeze([
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

export const FORBIDDEN_HC_COMMANDS = Object.freeze([
  "server",
  "update",
  "machine",
  "keys",
]);

const ALLOWED_COMMAND_SET = new Set(ALLOWED_HC_COMMANDS);
const FORBIDDEN_COMMAND_SET = new Set(FORBIDDEN_HC_COMMANDS);

const MAX_TERMINAL_NAME_LENGTH = 32;
const TERMINAL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const LOCAL_ADDRESS_RE = /^t\d+$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9._-]{0,24}$/;

const DEFAULT_TIMEOUT_MS = 10_000;

export class HcBoundaryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "HcBoundaryError";
    this.code = code;
    this.details = details;
  }
}

export function normalizePrefix(rawPrefix) {
  if (typeof rawPrefix !== "string" || rawPrefix.length === 0) {
    throw new HcBoundaryError("invalid_prefix", "Terminal name prefix must be a non-empty string");
  }
  if (!PREFIX_RE.test(rawPrefix)) {
    throw new HcBoundaryError(
      "invalid_prefix",
      `Terminal name prefix must match ${PREFIX_RE} (got ${JSON.stringify(rawPrefix)})`,
    );
  }
  const base = rawPrefix.endsWith("-") ? rawPrefix.slice(0, -1) : rawPrefix;
  if (base.length === 0) {
    throw new HcBoundaryError("invalid_prefix", "Terminal name prefix must not be only hyphens");
  }
  const namespace = `${base}-`;
  if (namespace.length >= MAX_TERMINAL_NAME_LENGTH) {
    throw new HcBoundaryError(
      "invalid_prefix",
      `Terminal name prefix ${JSON.stringify(rawPrefix)} leaves no room within 32 characters`,
    );
  }
  return { prefix: base, namespace };
}

export function buildDeterministicName({ prefix, issue, attemptId }) {
  const { namespace } = normalizePrefix(prefix);
  const issueStr = String(issue);
  if (!/^[a-z0-9]+$/.test(issueStr)) {
    throw new HcBoundaryError("invalid_name", `Issue identifier must be lowercase alphanumeric (got ${JSON.stringify(issue)})`);
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

function parseJsonStrict(raw, commandLabel) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HcBoundaryError(
      "invalid_json",
      `hc ${commandLabel} returned non-JSON output`,
      { raw: raw.slice(0, 500), cause: err instanceof Error ? err.message : String(err) },
    );
  }
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

export function createHcClient({
  hcBin,
  prefix,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  env = undefined,
}) {
  const resolvedHcBin = validateHcBin(hcBin);
  const { prefix: normalizedPrefix, namespace } = normalizePrefix(prefix);
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new HcBoundaryError("invalid_timeout", `defaultTimeoutMs must be a positive finite number (got ${defaultTimeoutMs})`);
  }

  // Tracks local terminal addresses (e.g. "t1") proven by run/ls/get responses to carry the required prefix.
  const authorizedAddresses = new Set();

  function hasPrefix(name) {
    return typeof name === "string" && name.startsWith(namespace);
  }

  function recordAuthorizedTerminal(terminal) {
    if (
      terminal &&
      typeof terminal === "object" &&
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
    if (!TERMINAL_NAME_RE.test(target)) {
      throw new HcBoundaryError(
        "invalid_name",
        `hc ${command} terminal name ${JSON.stringify(target)} is invalid`,
        { command, target },
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

    // Check forbidden flags across every command before '--'.
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
      for (let i = 0; i < hcArgs.length; i += 1) {
        const token = hcArgs[i];
        if (token === "--all" || token === "--json") {
          continue;
        }
        const label = extractFlagValue(hcArgs, i, "--label");
        if (label) {
          i = label.nextIndex;
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
        const labelOpt = extractFlagValue(hcArgs, i, "--label");
        if (labelOpt) {
          i = labelOpt.nextIndex;
          continue;
        }
        const timeoutOpt = extractFlagValue(hcArgs, i, "--timeout");
        if (timeoutOpt) {
          i = timeoutOpt.nextIndex;
          continue;
        }
        const parentOpt = extractFlagValue(hcArgs, i, "--parent");
        if (parentOpt) {
          assertAllowedTarget(parentOpt.value, "run --parent");
          i = parentOpt.nextIndex;
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
      if (!hasPrefix(name)) {
        throw new HcBoundaryError(
          "prefix_violation",
          `hc run --name ${JSON.stringify(name)} lacks required prefix ${JSON.stringify(namespace)}`,
          { command: cmd, name, namespace },
        );
      }
      if (!TERMINAL_NAME_RE.test(name)) {
        throw new HcBoundaryError(
          "invalid_name",
          `hc run --name ${JSON.stringify(name)} must be 1-32 chars of [a-z0-9._-]`,
          { command: cmd, name },
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
            throw new HcBoundaryError("invalid_args", `hc read --lines must be a non-negative integer (got ${JSON.stringify(linesOpt.value)})`);
          }
          i = linesOpt.nextIndex;
          continue;
        }
      }
      if (cmd === "wait") {
        const timeoutOpt = extractFlagValue(hcArgs, i, "--timeout");
        if (timeoutOpt) {
          const secs = Number(timeoutOpt.value);
          if (!Number.isFinite(secs) || secs <= 0) {
            throw new HcBoundaryError("invalid_args", `hc wait --timeout must be positive (got ${JSON.stringify(timeoutOpt.value)})`);
          }
          i = timeoutOpt.nextIndex;
          continue;
        }
        const childrenOpt = extractFlagValue(hcArgs, i, "--children");
        if (childrenOpt) {
          if (childrenOpt.value !== "all" && childrenOpt.value !== "any") {
            throw new HcBoundaryError("invalid_args", `hc wait --children must be all or any`);
          }
          i = childrenOpt.nextIndex;
          continue;
        }
        const outputOpt = extractFlagValue(hcArgs, i, "--output");
        if (outputOpt) {
          i = outputOpt.nextIndex;
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
              { command: cmd, args, signal, stderr: stderr.trim() },
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
        stdout: res.stdout,
        stderr: res.stderr,
      });
    }
    return { exitCode: res.exitCode, version: res.stdout.trim() };
  }

  async function schema({ timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["schema", "--json"], { timeoutMs });
    if (res.exitCode !== 0) {
      throw new HcBoundaryError("hc_failed", `hc schema exited ${res.exitCode}`, {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      });
    }
    return { exitCode: res.exitCode, schema: parseJsonStrict(res.stdout, "schema") };
  }

  async function run({
    name,
    cwd,
    argv,
    outliveParent = true,
    noParent = true,
    noNotify = true,
    timeoutMs = defaultTimeoutMs,
  }) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new HcBoundaryError("invalid_args", "run requires a non-empty argv array");
    }
    const args = ["run", "--bg", "--json"];
    if (noParent) {
      args.push("--no-parent");
    }
    if (noNotify) {
      args.push("--no-notify");
    }
    if (outliveParent) {
      args.push("--outlive-parent");
    }
    args.push("--name", name);
    if (typeof cwd === "string" && cwd.length > 0) {
      args.push("--cwd", cwd);
    }
    args.push("--", ...argv);

    const res = await execHc(args, { timeoutMs });
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        error: parsed?.error ?? {
          kind: "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc run exited ${res.exitCode}`,
          hint: null,
        },
        rawStdout: res.stdout,
        rawStderr: res.stderr,
      };
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.address !== "string") {
      throw new HcBoundaryError("invalid_json", "hc run returned JSON without a terminal address", {
        stdout: res.stdout.slice(0, 500),
      });
    }
    recordAuthorizedTerminal(parsed);
    return {
      ok: true,
      exitCode: 0,
      result: parsed,
    };
  }

  async function get(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["get", target, "--json"], { timeoutMs });
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: res.exitCode === 3 || parsed?.error?.kind === "not_found",
        error: parsed?.error ?? {
          kind: res.exitCode === 3 ? "not_found" : "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc get exited ${res.exitCode}`,
          hint: null,
        },
      };
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HcBoundaryError("invalid_json", "hc get returned invalid JSON", { stdout: res.stdout.slice(0, 500) });
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
      throw new HcBoundaryError("hc_failed", `hc ls exited ${res.exitCode}`, {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      });
    }
    const parsed = parseJsonStrict(res.stdout, "ls");
    if (!parsed || !Array.isArray(parsed.terminals)) {
      throw new HcBoundaryError("invalid_json", "hc ls did not return a terminals array");
    }
    for (const term of parsed.terminals) {
      recordAuthorizedTerminal(term);
    }
    return {
      exitCode: 0,
      hiddenFinished: typeof parsed.hidden_finished === "number" ? parsed.hidden_finished : 0,
      machines: Array.isArray(parsed.machines) ? parsed.machines : [],
      terminals: parsed.terminals,
    };
  }

  async function read(target, { lines = 0, timeoutMs = defaultTimeoutMs } = {}) {
    if (!Number.isInteger(lines) || lines < 0) {
      throw new HcBoundaryError("invalid_args", `read lines must be a non-negative integer (got ${lines})`);
    }
    const res = await execHc(["read", target, "--lines", String(lines), "--json"], { timeoutMs });
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        error: parsed?.error ?? {
          kind: "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc read exited ${res.exitCode}`,
          hint: null,
        },
      };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.text !== "string" ||
      typeof parsed.complete !== "boolean" ||
      typeof parsed.how !== "string"
    ) {
      throw new HcBoundaryError("invalid_json", "hc read returned unexpected JSON shape", {
        stdout: res.stdout.slice(0, 500),
      });
    }
    return {
      ok: true,
      exitCode: 0,
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
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: res.exitCode === 3 || parsed?.error?.kind === "not_found",
        error: parsed?.error ?? {
          kind: res.exitCode === 3 ? "not_found" : "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc wait exited ${res.exitCode}`,
          hint: null,
        },
      };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.ended !== "boolean" ||
      typeof parsed.reason !== "string"
    ) {
      throw new HcBoundaryError("invalid_json", "hc wait returned unexpected JSON shape", {
        stdout: res.stdout.slice(0, 500),
      });
    }
    return {
      ok: true,
      exitCode: 0,
      result: parsed,
    };
  }

  async function kill(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["kill", target, "--json"], { timeoutMs });
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: res.exitCode === 3 || parsed?.error?.kind === "not_found",
        error: parsed?.error ?? {
          kind: res.exitCode === 3 ? "not_found" : "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc kill exited ${res.exitCode}`,
          hint: null,
        },
      };
    }
    return {
      ok: true,
      exitCode: 0,
      terminal: parsed,
    };
  }

  async function rm(target, { timeoutMs = defaultTimeoutMs } = {}) {
    const res = await execHc(["rm", target, "--json"], { timeoutMs });
    const parsed = tryParseJson(res.stdout);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        exitCode: res.exitCode,
        notFound: res.exitCode === 3 || parsed?.error?.kind === "not_found",
        error: parsed?.error ?? {
          kind: res.exitCode === 3 ? "not_found" : "unknown_error",
          message: (res.stderr || res.stdout).trim() || `hc rm exited ${res.exitCode}`,
          hint: null,
        },
      };
    }
    return {
      ok: true,
      exitCode: 0,
      removed: parsed?.removed ?? target,
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
