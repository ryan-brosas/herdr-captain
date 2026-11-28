import fs from "node:fs";
import path from "node:path";
import { isSameProcessAlive, type ProcessStat } from "../../src/lease.ts";

const DEAD_PROCESS_STATES = new Set(["Z", "X", "x"]);
const INVALID_LINUX_UID = "4294967295";
const MAX_PARENT_CHAIN_STEPS = 64;

export interface TrackedProcessIdentity {
  pid: number;
  startTime: string;
}

export type UncertainProcessReason =
  | "unreadable_stat"
  | "malformed_stat"
  | "unreadable_environ"
  | "unreadable_stat_after"
  | "malformed_stat_after";

export interface UncertainProcessEntry {
  pid: number;
  startTime?: string;
  reason: UncertainProcessReason;
}

export interface EnvTokenScanOptions {
  minStartTime?: string;
}

export interface EnvTokenScanResult {
  matches: TrackedProcessIdentity[];
  uncertain: UncertainProcessEntry[];
}

export interface DetailedProcessStat extends ProcessStat {
  pid: number;
  ppid: number;
}

type ProcessStatReadResult =
  | { status: "ok"; stat: DetailedProcessStat }
  | { status: "absent" }
  | { status: "malformed"; raw: string };

function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

function readProcessStatStrict(
  pid: number | "self",
  procRoot = "/proc",
): ProcessStatReadResult {
  if (pid !== "self" && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`Invalid pid for readProcessStatStrict: ${String(pid)}`);
  }
  let statRaw: string;
  try {
    statRaw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ENOENT" || code === "ESRCH") {
      return { status: "absent" };
    }
    throw err;
  }
  const openParen = statRaw.indexOf("(");
  const closeParen = statRaw.lastIndexOf(")");
  if (
    openParen <= 1 ||
    closeParen <= openParen ||
    closeParen + 2 >= statRaw.length ||
    statRaw[openParen - 1] !== " " ||
    statRaw[closeParen + 1] !== " "
  ) {
    return { status: "malformed", raw: statRaw };
  }
  const pidField = statRaw.slice(0, openParen - 1);
  if (!/^\d+$/.test(pidField)) {
    return { status: "malformed", raw: statRaw };
  }
  const parsedPid = Number(pidField);
  if (!Number.isSafeInteger(parsedPid) || parsedPid <= 0) {
    return { status: "malformed", raw: statRaw };
  }
  if (pid !== "self" && parsedPid !== pid) {
    return { status: "malformed", raw: statRaw };
  }
  const fields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    return { status: "malformed", raw: statRaw };
  }
  const state = fields[0];
  const ppidField = fields[1];
  const startTime = fields[19];
  if (
    !state ||
    !/^[A-Za-z]$/.test(state) ||
    !ppidField ||
    !/^\d+$/.test(ppidField) ||
    !startTime ||
    !/^\d+$/.test(startTime)
  ) {
    return { status: "malformed", raw: statRaw };
  }
  const ppid = Number(ppidField);
  if (!Number.isSafeInteger(ppid) || ppid < 0) {
    return { status: "malformed", raw: statRaw };
  }
  return { status: "ok", stat: { pid: parsedPid, ppid, state, startTime } };
}

export function assertProcReadable(procRoot = "/proc"): DetailedProcessStat {
  fs.readdirSync(procRoot);
  const selfResult = readProcessStatStrict("self", procRoot);
  if (selfResult.status !== "ok") {
    throw new Error(`Unusable self/stat under ${procRoot}: ${selfResult.status}`);
  }
  return selfResult.stat;
}

/**
 * Confirms a tracked process identity is no longer running.
 * Distinguishes process absence (ENOENT/ESRCH) from malformed /proc/<pid>/stat data:
 * malformed or unreadable records throw rather than reporting the process dead.
 */
export function confirmProcessDead(
  pid: number,
  expectedStartTime: string,
  procRoot = "/proc",
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for confirmProcessDead: ${String(pid)}`);
  }
  if (typeof expectedStartTime !== "string" || !/^\d+$/.test(expectedStartTime)) {
    throw new Error(`Invalid expectedStartTime for confirmProcessDead: ${String(expectedStartTime)}`);
  }
  assertProcReadable(procRoot);
  const result = readProcessStatStrict(pid, procRoot);
  if (result.status === "absent") {
    return true;
  }
  if (result.status === "malformed") {
    throw new Error(`Malformed /proc stat for pid=${pid} under ${procRoot}`);
  }
  if (result.stat.startTime !== expectedStartTime) {
    return true;
  }
  return DEAD_PROCESS_STATES.has(result.stat.state);
}

export async function terminateExternalProcess(
  pid: number,
  expectedStartTime: string,
  timeoutMs = 2000,
  procRoot = "/proc",
): Promise<boolean> {
  if (confirmProcessDead(pid, expectedStartTime, procRoot)) {
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (err: unknown) {
    if (getErrorCode(err) === "ESRCH") {
      return confirmProcessDead(pid, expectedStartTime, procRoot);
    }
    throw err;
  }
  const deadline = performance.now() + timeoutMs;
  while (!confirmProcessDead(pid, expectedStartTime, procRoot)) {
    if (performance.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function hasUnmappedLowerUid(uidMapRaw: string): boolean {
  for (const rawLine of uidMapRaw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length === 3 && parts[1] === INVALID_LINUX_UID) {
      return true;
    }
  }
  return false;
}

function readSelfUidMapUsable(procRoot: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(procRoot, "self", "uid_map"), "utf8");
    return raw.trim().length > 0 && !hasUnmappedLowerUid(raw);
  } catch {
    return false;
  }
}

function getProcessOwnerProof(
  pid: number,
  procRoot: string,
  myUid: number | null,
  canCheckUidMap: boolean,
): "other_user" | "maybe_ours" | "absent" {
  const pidDir = path.join(procRoot, String(pid));
  if (!fs.existsSync(pidDir)) {
    return "absent";
  }

  // Inside an unshared user namespace (e.g. `unshare -c -n`), processes in an
  // ancestor/host user namespace show lower UID 4294967295 (INVALID_UID) in
  // `/proc/<pid>/uid_map`. No child of our process can live in an ancestor
  // user namespace, whereas same-namespace non-dumpable children keep our map.
  if (canCheckUidMap) {
    try {
      const uidMapRaw = fs.readFileSync(path.join(pidDir, "uid_map"), "utf8");
      if (hasUnmappedLowerUid(uidMapRaw)) {
        return "other_user";
      }
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if ((code === "ENOENT" || code === "ESRCH") && !fs.existsSync(pidDir)) {
        return "absent";
      }
    }
  }

  if (myUid === null) {
    return "maybe_ours";
  }

  try {
    const statusRaw = fs.readFileSync(path.join(pidDir, "status"), "utf8");
    const uidMatch = statusRaw.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
    if (uidMatch) {
      const uids = [
        Number(uidMatch[1]),
        Number(uidMatch[2]),
        Number(uidMatch[3]),
        Number(uidMatch[4]),
      ];
      return uids.every((uid) => uid !== myUid) ? "other_user" : "maybe_ours";
    }
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if ((code === "ENOENT" || code === "ESRCH") && !fs.existsSync(pidDir)) {
      return "absent";
    }
  }

  return "maybe_ours";
}

function collectSelfAncestors(
  selfStat: DetailedProcessStat,
  procRoot: string,
): Map<number, string> | null {
  const ancestors = new Map<number, string>();
  ancestors.set(selfStat.pid, selfStat.startTime);

  let curKey: number | "self" = "self";
  let curStat = selfStat;

  for (let step = 0; step < MAX_PARENT_CHAIN_STEPS; step += 1) {
    if (curStat.pid === 1) {
      return ancestors;
    }
    const parentPid = curStat.ppid;
    if (parentPid <= 0 || ancestors.has(parentPid)) {
      return null;
    }
    let parentResult: ProcessStatReadResult;
    try {
      parentResult = readProcessStatStrict(parentPid, procRoot);
    } catch {
      return null;
    }
    if (parentResult.status !== "ok") {
      return null;
    }
    let curAfter: ProcessStatReadResult;
    try {
      curAfter = readProcessStatStrict(curKey, procRoot);
    } catch {
      return null;
    }
    if (
      curAfter.status !== "ok" ||
      curAfter.stat.pid !== curStat.pid ||
      curAfter.stat.startTime !== curStat.startTime ||
      curAfter.stat.ppid !== parentPid
    ) {
      return null;
    }
    ancestors.set(parentPid, parentResult.stat.startTime);
    curKey = parentPid;
    curStat = parentResult.stat;
  }

  return curStat.pid === 1 ? ancestors : null;
}

function isProvenNotOursByParentChain(
  pid: number,
  initialStat: DetailedProcessStat,
  selfStartTicks: bigint,
  selfAncestors: ReadonlyMap<number, string> | null,
  procRoot: string,
): boolean {
  if (selfAncestors === null) {
    return false;
  }

  let childPid = pid;
  let childStat = initialStat;
  const visited = new Set<number>([childPid]);

  for (let step = 0; step < MAX_PARENT_CHAIN_STEPS; step += 1) {
    const parentPid = childStat.ppid;
    if (parentPid <= 0 || visited.has(parentPid)) {
      return false;
    }

    let parentResult: ProcessStatReadResult;
    try {
      parentResult = readProcessStatStrict(parentPid, procRoot);
    } catch {
      return false;
    }
    if (parentResult.status !== "ok") {
      return false;
    }

    let childAfter: ProcessStatReadResult;
    try {
      childAfter = readProcessStatStrict(childPid, procRoot);
    } catch {
      return false;
    }
    if (
      childAfter.status !== "ok" ||
      childAfter.stat.startTime !== childStat.startTime ||
      childAfter.stat.ppid !== parentPid
    ) {
      return false;
    }

    if (selfAncestors.get(parentPid) === parentResult.stat.startTime) {
      return false;
    }
    if (BigInt(parentResult.stat.startTime) < selfStartTicks) {
      return true;
    }

    visited.add(parentPid);
    childPid = parentPid;
    childStat = parentResult.stat;
  }

  return false;
}

function formatUncertainProcesses(uncertain: UncertainProcessEntry[], procRoot: string): string {
  const details = uncertain
    .map((u) => `pid=${u.pid}${u.startTime ? ` startTime=${u.startTime}` : ""} (${u.reason})`)
    .join(", ");
  return `Uncertain process cleanup under ${procRoot}: could not rule out ${uncertain.length} process(es) [${details}]`;
}

export function scanProcessesByEnvToken(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): EnvTokenScanResult {
  if (
    typeof envName !== "string" ||
    envName.length === 0 ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return { matches: [], uncertain: [] };
  }

  // Fail closed (throw) if /proc, own stat, or own environ is unreadable so sweeps never
  // treat an unreadable /proc as "zero leftover processes".
  const entries = fs.readdirSync(procRoot);
  const selfStat = assertProcReadable(procRoot);
  fs.readFileSync(path.join(procRoot, "self", "environ"), "utf8");

  const minStartTimeRaw = options?.minStartTime ?? selfStat.startTime;
  if (typeof minStartTimeRaw !== "string" || !/^\d+$/.test(minStartTimeRaw)) {
    throw new Error(`Invalid minStartTime for env-token scan: ${String(minStartTimeRaw)}`);
  }
  const minStartTicks = BigInt(minStartTimeRaw);
  const selfStartTicks = BigInt(selfStat.startTime);
  const selfAncestors = collectSelfAncestors(selfStat, procRoot);
  const myUid = typeof process.getuid === "function" ? process.getuid() : null;
  const canCheckUidMap = readSelfUidMapUsable(procRoot);

  const needle = `${envName}=${token}`;
  const matches: TrackedProcessIdentity[] = [];
  const uncertain: UncertainProcessEntry[] = [];

  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pid === selfStat.pid) {
      continue;
    }

    let statBefore: ProcessStatReadResult;
    try {
      statBefore = readProcessStatStrict(pid, procRoot);
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
        if (owner === "other_user" || owner === "absent") {
          continue;
        }
        uncertain.push({ pid, reason: "unreadable_stat" });
        continue;
      }
      throw err;
    }
    if (statBefore.status === "absent") {
      continue;
    }
    if (statBefore.status === "malformed") {
      const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
      if (owner === "other_user" || owner === "absent") {
        continue;
      }
      uncertain.push({ pid, reason: "malformed_stat" });
      continue;
    }
    if (DEAD_PROCESS_STATES.has(statBefore.stat.state)) {
      continue;
    }

    let envRaw: string;
    try {
      envRaw = fs.readFileSync(path.join(procRoot, String(pid), "environ"), "utf8");
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "ENOENT" || code === "ESRCH") {
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        const owner = getProcessOwnerProof(pid, procRoot, myUid, canCheckUidMap);
        if (owner === "other_user" || owner === "absent") {
          continue;
        }
        if (BigInt(statBefore.stat.startTime) < minStartTicks) {
          continue;
        }
        if (
          isProvenNotOursByParentChain(
            pid,
            statBefore.stat,
            selfStartTicks,
            selfAncestors,
            procRoot,
          )
        ) {
          continue;
        }
        uncertain.push({
          pid,
          startTime: statBefore.stat.startTime,
          reason: "unreadable_environ",
        });
        continue;
      }
      throw err;
    }
    if (!envRaw.split("\0").includes(needle)) {
      continue;
    }

    let statAfter: ProcessStatReadResult;
    try {
      statAfter = readProcessStatStrict(pid, procRoot);
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        uncertain.push({
          pid,
          startTime: statBefore.stat.startTime,
          reason: "unreadable_stat_after",
        });
        continue;
      }
      throw err;
    }
    if (statAfter.status === "absent") {
      continue;
    }
    if (statAfter.status === "malformed") {
      uncertain.push({
        pid,
        startTime: statBefore.stat.startTime,
        reason: "malformed_stat_after",
      });
      continue;
    }
    if (
      statAfter.stat.startTime !== statBefore.stat.startTime ||
      DEAD_PROCESS_STATES.has(statAfter.stat.state)
    ) {
      continue;
    }
    matches.push({ pid, startTime: statAfter.stat.startTime });
  }

  return { matches, uncertain };
}

export function findProcessesByEnvToken(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): TrackedProcessIdentity[] {
  const { matches, uncertain } = scanProcessesByEnvToken(envName, token, procRoot, options);
  if (uncertain.length > 0) {
    throw new Error(formatUncertainProcesses(uncertain, procRoot));
  }
  return matches;
}

export async function stopProcessesByEnvToken(
  envName: string,
  token: string,
  timeoutMs = 3000,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): Promise<TrackedProcessIdentity[]> {
  const stopped: TrackedProcessIdentity[] = [];
  const seen = new Set<string>();
  const deadline = performance.now() + timeoutMs;

  while (true) {
    const { matches, uncertain } = scanProcessesByEnvToken(envName, token, procRoot, options);
    if (matches.length === 0) {
      if (uncertain.length > 0) {
        throw new Error(formatUncertainProcesses(uncertain, procRoot));
      }
      return stopped;
    }
    for (const proc of matches) {
      const remaining = Math.max(200, Math.ceil(deadline - performance.now()));
      const ok = await terminateExternalProcess(proc.pid, proc.startTime, remaining, procRoot);
      if (!ok) {
        throw new Error(`Failed to confirm termination of token-owned process pid=${proc.pid}`);
      }
      const key = `${proc.pid}:${proc.startTime}`;
      if (!seen.has(key)) {
        seen.add(key);
        stopped.push(proc);
      }
    }
    if (performance.now() >= deadline) {
      const remaining = scanProcessesByEnvToken(envName, token, procRoot, options);
      if (remaining.matches.length > 0) {
        throw new Error(
          `Timed out waiting for token-owned processes to terminate: ${remaining.matches.map((m) => m.pid).join(",")}`,
        );
      }
      if (remaining.uncertain.length > 0) {
        throw new Error(formatUncertainProcesses(remaining.uncertain, procRoot));
      }
      return stopped;
    }
  }
}

export function stopProcessesByEnvTokenSync(
  envName: string,
  token: string,
  procRoot = "/proc",
  options?: EnvTokenScanOptions,
): void {
  let matches: TrackedProcessIdentity[];
  try {
    matches = scanProcessesByEnvToken(envName, token, procRoot, options).matches;
  } catch {
    return;
  }
  for (const proc of matches) {
    if (!isSameProcessAlive(proc.pid, proc.startTime)) {
      continue;
    }
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // Ignore ESRCH if already exited.
    }
  }
}
