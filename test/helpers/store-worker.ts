import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { claimProject } from "../../src/identity.ts";
import { acquireLease, readProcessStat, type OwnerLease } from "../../src/lease.ts";
import {
  appendCommitRecord,
  getTicketPaths,
  openTicketLog,
  writeArtifact,
  type StoreFsOps,
} from "../../src/store.ts";
import { formatError } from "./process.ts";
import { makeIntentInput, makeReceiptInput } from "./store-fixtures.ts";

const CONTROL_FD = 3;

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

function emitSync(obj: Record<string, unknown>): void {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`);
}

function readControlLineSync(): string {
  const buf = Buffer.alloc(1);
  let line = "";
  while (true) {
    const bytesRead = fs.readSync(CONTROL_FD, buf, 0, 1, null);
    if (bytesRead === 0) {
      return line.trim();
    }
    const ch = buf.toString("utf8", 0, 1);
    if (ch === "\n") {
      return line.trim();
    }
    line += ch;
  }
}

function getErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

interface HookTelemetry {
  tmpPath: string | null;
  targetPath: string | null;
  writtenBytes: Buffer[];
  linkErrno: string | null;
  linkSucceeded: boolean;
  afterPause: boolean;
  mkdirsAfterPause: number;
  opensCreateAfterPause: number;
  writesAfterPause: number;
  linksAfterPause: number;
  unlinksAfterPause: number;
}

function buildWorkerFsOps(params: {
  readonly pauseAt: string | undefined;
  readonly workerId: string;
  readonly stateRoot: string;
  readonly issueRef: string;
  readonly leafKind: "log" | "artifacts";
  readonly selfStartTime: string | null;
  readonly holderPid: number;
  readonly holderStartTime: string;
  readonly telemetry: HookTelemetry;
}): Partial<StoreFsOps> {
  const {
    pauseAt,
    workerId,
    stateRoot,
    issueRef,
    leafKind,
    selfStartTime,
    holderPid,
    holderStartTime,
    telemetry,
  } = params;

  const ticketPaths = getTicketPaths(stateRoot, issueRef);
  const ticketsDir = path.dirname(ticketPaths.ticketDir);
  const ticketDir = ticketPaths.ticketDir;
  const leafDir = leafKind === "log" ? ticketPaths.logDir : ticketPaths.artifactsDir;

  let pausedOnce = false;
  let tempFd: number | null = null;
  const dirFdMap = new Map<number, string>();
  let createdTicketsDir = false;
  let createdTicketDir = false;
  let createdLeafDir = false;
  let linkedOnce = false;

  const pauseNow = (point: string, extra?: Record<string, unknown>): void => {
    pausedOnce = true;
    const writtenBuf =
      telemetry.writtenBytes.length > 0 ? Buffer.concat(telemetry.writtenBytes) : null;
    emitSync({
      event: "paused",
      workerId,
      point,
      pid: process.pid,
      startTime: selfStartTime,
      holderPid,
      holderStartTime,
      tmpPath: telemetry.tmpPath,
      targetPath: telemetry.targetPath,
      writtenBytesBase64: writtenBuf !== null ? writtenBuf.toString("base64") : null,
      ...extra,
    });
    readControlLineSync();
    telemetry.afterPause = true;
  };

  return {
    mkdirSync(targetPath, options) {
      if (telemetry.afterPause) {
        telemetry.mkdirsAfterPause += 1;
      }
      const pathStr = path.resolve(String(targetPath));
      const res = fs.mkdirSync(targetPath, options as never);
      if (pathStr === path.resolve(ticketsDir)) {
        createdTicketsDir = true;
        if (!pausedOnce && pauseAt === "after-mkdir-tickets") {
          pauseNow("after-mkdir-tickets", { dirPath: pathStr });
        }
      } else if (pathStr === path.resolve(ticketDir)) {
        createdTicketDir = true;
        if (!pausedOnce && pauseAt === "after-mkdir-issue") {
          pauseNow("after-mkdir-issue", { dirPath: pathStr });
        }
      } else if (pathStr === path.resolve(leafDir)) {
        createdLeafDir = true;
        if (!pausedOnce && pauseAt === "after-mkdir-leaf") {
          pauseNow("after-mkdir-leaf", { dirPath: pathStr });
        }
      }
      return res;
    },

    openSync(targetPath, flags, mode) {
      const pathStr = String(targetPath);
      const isCreate =
        typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0;
      const isDir =
        typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0;
      if (telemetry.afterPause && isCreate) {
        telemetry.opensCreateAfterPause += 1;
      }
      const fd = fs.openSync(targetPath, flags, mode);
      if (isCreate && path.basename(pathStr).startsWith(".")) {
        tempFd = fd;
        telemetry.tmpPath = pathStr;
        if (!pausedOnce && pauseAt === "after-open-temp") {
          pauseNow("after-open-temp");
        }
      } else if (isDir) {
        dirFdMap.set(fd, path.resolve(pathStr));
      }
      return fd;
    },

    writeSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | null,
      position?: fs.ReadPosition | null,
    ): number => {
      if (fd === tempFd && !pausedOnce && pauseAt === "fail-write-paused") {
        pauseNow("fail-write-paused");
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      }
      if (telemetry.afterPause) {
        telemetry.writesAfterPause += 1;
      }
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const off = offset ?? 0;
      const len = length ?? view.byteLength - off;

      if (fd === tempFd && !pausedOnce && pauseAt === "after-short-write" && len > 1) {
        const partialLen = Math.max(1, Math.floor(len / 2));
        const written = fs.writeSync(fd, buffer, off, partialLen, position ?? null);
        telemetry.writtenBytes.push(Buffer.from(view.subarray(off, off + written)));
        pauseNow("after-short-write", { partialBytes: written, totalRemaining: len });
        return written;
      }

      const written = fs.writeSync(fd, buffer, off, len, position ?? null);
      if (fd === tempFd) {
        telemetry.writtenBytes.push(Buffer.from(view.subarray(off, off + written)));
        if (!pausedOnce && pauseAt === "after-full-write" && off + written >= view.byteLength) {
          pauseNow("after-full-write");
        }
      }
      return written;
    }) as typeof fs.writeSync,

    fsyncSync(fd) {
      fs.fsyncSync(fd);
      if (fd === tempFd) {
        if (!pausedOnce && pauseAt === "after-file-fsync") {
          pauseNow("after-file-fsync");
        }
        return;
      }
      const dirPath = dirFdMap.get(fd);
      if (dirPath !== undefined) {
        if (
          !pausedOnce &&
          pauseAt === "after-fsync-tickets-parent" &&
          createdTicketsDir &&
          dirPath === path.resolve(stateRoot)
        ) {
          pauseNow("after-fsync-tickets-parent", { dirPath });
        } else if (
          !pausedOnce &&
          pauseAt === "after-fsync-issue-parent" &&
          createdTicketDir &&
          dirPath === path.resolve(ticketsDir)
        ) {
          pauseNow("after-fsync-issue-parent", { dirPath });
        } else if (
          !pausedOnce &&
          pauseAt === "after-fsync-leaf-parent" &&
          createdLeafDir &&
          dirPath === path.resolve(ticketDir)
        ) {
          pauseNow("after-fsync-leaf-parent", { dirPath });
        } else if (
          !pausedOnce &&
          pauseAt === "after-dir-fsync" &&
          linkedOnce &&
          dirPath === path.resolve(leafDir)
        ) {
          pauseNow("after-dir-fsync", { dirPath });
        }
      }
    },

    closeSync(fd) {
      fs.closeSync(fd);
      dirFdMap.delete(fd);
      if (fd === tempFd) {
        tempFd = null;
        if (!pausedOnce && pauseAt === "after-file-close") {
          pauseNow("after-file-close");
        }
      }
    },

    linkSync(existingPath, newPath) {
      const tmpStr = String(existingPath);
      const targetStr = String(newPath);
      telemetry.tmpPath = tmpStr;
      telemetry.targetPath = targetStr;
      let didPauseBeforeLink = false;
      if (!pausedOnce && pauseAt === "before-link") {
        pausedOnce = true;
        didPauseBeforeLink = true;
        const writtenBuf =
          telemetry.writtenBytes.length > 0 ? Buffer.concat(telemetry.writtenBytes) : null;
        emitSync({
          event: "paused",
          workerId,
          point: "before-link",
          pid: process.pid,
          startTime: selfStartTime,
          holderPid,
          holderStartTime,
          tmpPath: tmpStr,
          targetPath: targetStr,
          writtenBytesBase64: writtenBuf !== null ? writtenBuf.toString("base64") : null,
        });
        readControlLineSync();
      }
      if (telemetry.afterPause) {
        telemetry.linksAfterPause += 1;
      }
      try {
        fs.linkSync(existingPath, newPath);
        telemetry.linkSucceeded = true;
        linkedOnce = true;
      } catch (err) {
        telemetry.linkErrno = getErrorCode(err);
        throw err;
      } finally {
        if (didPauseBeforeLink) {
          telemetry.afterPause = true;
        }
      }
      if (!pausedOnce && pauseAt === "after-link") {
        pauseNow("after-link");
      }
    },

    removeTemp(targetPath) {
      if (telemetry.afterPause) {
        telemetry.unlinksAfterPause += 1;
      }
      fs.unlinkSync(targetPath);
      if (!pausedOnce && pauseAt === "after-unlink-temp") {
        pauseNow("after-unlink-temp");
      }
    },
  };
}

function createCommandReader(): {
  nextCommand: () => Promise<string | null>;
  close: () => void;
} {
  const rl = readline.createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    const waiter = waiters.shift();
    if (waiter) {
      waiter(trimmed);
    } else {
      queue.push(trimmed);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.(null);
    }
  });

  return {
    nextCommand: (): Promise<string | null> => {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    close: () => rl.close(),
  };
}

function buildRecordInput(
  issueRef: string,
  recordKind: string,
  tag: string,
  suffix = "",
) {
  const fullTag = suffix.length > 0 ? `${tag}-${suffix}` : tag;
  if (recordKind === "receipt") {
    return makeReceiptInput({
      issueRef,
      event: `receipt_${fullTag}`,
      attemptId: `att-${fullTag}`,
      receipt: {
        kind: "worker_receipt",
        version: 1,
        data: { tag: fullTag, outcome: "delivered" },
      },
    });
  }
  return makeIntentInput({
    issueRef,
    event: `intent_${fullTag}`,
    attemptId: `att-${fullTag}`,
    intent: {
      kind: "worker_intent",
      version: 1,
      data: { tag: fullTag, role: "implementer" },
    },
  });
}

async function runIntegrationP1(
  cwd: string,
  stateBase: string,
  issueRef: string,
  selfStartTime: string | null,
): Promise<void> {
  const claimed = await claimProject(cwd, stateBase);
  const { lease, projectKey, stateRoot } = claimed;
  try {
    const { writeResult: artifact } = await lease.enqueue({
      write: () => writeArtifact(lease, issueRef, "# Brief\n\nIntegrated slice S1c.\n"),
    });

    const stepOrder: string[] = [];
    const { writeResult: intentEntry, effectResult } = await lease.enqueue({
      write: () => {
        stepOrder.push("write_intent");
        return appendCommitRecord(
          lease,
          makeIntentInput({
            issueRef,
            event: "dispatch_intent",
            attemptId: "att-1",
            evidenceRefs: [
              {
                kind: "brief",
                sha256: artifact.sha256,
                bytes: artifact.bytes,
                truncated: false,
              },
            ],
            countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
            phaseAfter: { phase: "building", attemptState: "intent" },
          }),
        );
      },
      effect: (committedIntent) => {
        stepOrder.push("run_effect");
        return {
          deliveredSeq: committedIntent.seq,
          deliveredSha256: committedIntent.sha256,
          standInStatus: "dispatched",
        };
      },
    });

    const { writeResult: receiptEntry } = await lease.enqueue({
      write: () =>
        appendCommitRecord(
          lease,
          makeReceiptInput({
            issueRef,
            event: "dispatch_receipt",
            attemptId: "att-1",
            receipt: {
              kind: "dispatch_receipt",
              version: 1,
              data: { status: effectResult.standInStatus },
              intentRef: { seq: intentEntry.seq, sha256: intentEntry.sha256 },
            },
            countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
            phaseAfter: { phase: "building", attemptState: "delivered" },
          }),
        ),
    });

    await lease.release();

    emitSync({
      event: "integration_p1_done",
      pid: process.pid,
      startTime: selfStartTime,
      projectKey,
      stateRoot,
      epoch: lease.epoch,
      holderPid: lease.holderPid,
      holderStartTime: lease.holderStartTime,
      published: claimed.published,
      stepOrder,
      artifact,
      intentEntry,
      effectResult,
      receiptEntry,
    });
  } catch (err) {
    try {
      await lease.release();
    } catch {
      // Preserve original error.
    }
    throw err;
  }
}

async function runIntegrationP2(
  cwd: string,
  stateBase: string,
  issueRef: string,
  selfStartTime: string | null,
): Promise<void> {
  const claimed = await claimProject(cwd, stateBase);
  const { lease, projectKey, stateRoot } = claimed;
  try {
    const opened = openTicketLog({ stateRoot, projectKey, issueRef });
    const { writeResult: nextEntry } = await lease.enqueue({
      write: () =>
        appendCommitRecord(
          lease,
          makeReceiptInput({
            issueRef,
            event: "attempt_settled",
            attemptId: "att-1",
            receipt: {
              kind: "settlement_receipt",
              version: 1,
              data: { outcome: "settled_by_p2" },
            },
            countersAfter: { attemptSeq: 1, totalAttemptsUsed: 1, fixRoundsUsed: 0 },
            phaseAfter: { phase: "gating", attemptState: null },
          }),
        ),
    });

    await lease.release();

    emitSync({
      event: "integration_p2_done",
      pid: process.pid,
      startTime: selfStartTime,
      projectKey,
      stateRoot,
      epoch: lease.epoch,
      holderPid: lease.holderPid,
      holderStartTime: lease.holderStartTime,
      published: claimed.published,
      opened,
      nextEntry,
    });
  } catch (err) {
    try {
      await lease.release();
    } catch {
      // Preserve original error.
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  const workerId = args["worker-id"] ?? "worker";
  const selfStartTime = readProcessStat(process.pid)?.startTime ?? null;

  if (mode === "open") {
    const stateRoot = args["state-root"];
    const projectKey = args["project-key"];
    const issueRef = args["issue-ref"];
    if (!stateRoot || !projectKey || !issueRef) {
      throw new Error("open mode requires --state-root, --project-key, and --issue-ref");
    }
    const result = openTicketLog({ stateRoot, projectKey, issueRef });
    emitSync({ event: "opened", workerId, pid: process.pid, startTime: selfStartTime, result });
    return;
  }

  if (mode === "integration-p1") {
    const cwd = args.cwd;
    const stateBase = args["state-base"];
    const issueRef = args["issue-ref"];
    if (!cwd || !stateBase || !issueRef) {
      throw new Error("integration-p1 requires --cwd, --state-base, and --issue-ref");
    }
    await runIntegrationP1(cwd, stateBase, issueRef, selfStartTime);
    return;
  }

  if (mode === "integration-p2") {
    const cwd = args.cwd;
    const stateBase = args["state-base"];
    const issueRef = args["issue-ref"];
    if (!cwd || !stateBase || !issueRef) {
      throw new Error("integration-p2 requires --cwd, --state-base, and --issue-ref");
    }
    await runIntegrationP2(cwd, stateBase, issueRef, selfStartTime);
    return;
  }

  const stateRoot = args["state-root"];
  const projectKey = args["project-key"];
  const issueRef = args["issue-ref"];
  if (!stateRoot || !projectKey || !issueRef) {
    throw new Error("Provide --state-root, --project-key, and --issue-ref");
  }

  const pauseAt = args["pause-at"];
  const holdAfter = args["hold-after"] === "1";
  const stayAliveOnError = args["stay-alive-on-error"] === "1";
  const recordKind = args["record-kind"] ?? "intent";
  const tag = args.tag ?? workerId;
  const content = args.content ?? `artifact content for ${tag}\nline two of payload\n`;

  const commands = createCommandReader();
  let lease: OwnerLease | null = null;

  try {
    lease = await acquireLease({ projectKey, stateRoot });
    const activeLease = lease;

    if (mode === "hold-lease") {
      if (args["seed-record"] === "1") {
        await activeLease.enqueue({
          write: () => {
            const art = writeArtifact(activeLease, issueRef, "seeded artifact\n");
            return appendCommitRecord(
              activeLease,
              makeIntentInput({
                issueRef,
                event: "seeded_intent",
                attemptId: "att-seed",
                evidenceRefs: [
                  { kind: "brief", sha256: art.sha256, bytes: art.bytes, truncated: false },
                ],
              }),
            );
          },
        });
      }
      emitSync({
        event: "holding",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
        holderPid: activeLease.holderPid,
        holderStartTime: activeLease.holderStartTime,
        epoch: activeLease.epoch,
      });
      while (true) {
        const cmd = await commands.nextCommand();
        if (cmd === null || cmd === "exit" || cmd === "release") {
          break;
        }
      }
      lease = null;
      await activeLease.release();
      emitSync({
        event: "released",
        workerId,
        pid: process.pid,
        holderPid: activeLease.holderPid,
        epoch: activeLease.epoch,
      });
      return;
    }

    if (mode === "intent-then-receipt") {
      const { writeResult: intentEntry } = await activeLease.enqueue({
        write: () => appendCommitRecord(activeLease, buildRecordInput(issueRef, "intent", tag)),
      });
      emitSync({
        event: "paused",
        workerId,
        point: "between-intent-and-receipt",
        pid: process.pid,
        startTime: selfStartTime,
        holderPid: activeLease.holderPid,
        holderStartTime: activeLease.holderStartTime,
        intentSeq: intentEntry.seq,
        intentSha256: intentEntry.sha256,
      });
      readControlLineSync();
      const { writeResult: receiptEntry } = await activeLease.enqueue({
        write: () =>
          appendCommitRecord(
            activeLease,
            makeReceiptInput({
              issueRef,
              event: `receipt_${tag}`,
              attemptId: `att-${tag}`,
              receipt: {
                kind: "worker_receipt",
                version: 1,
                data: { tag },
                intentRef: { seq: intentEntry.seq, sha256: intentEntry.sha256 },
              },
            }),
          ),
      });
      lease = null;
      await activeLease.release();
      emitSync({
        event: "completed",
        workerId,
        pid: process.pid,
        intentEntry,
        receiptEntry,
      });
      return;
    }

    const telemetry: HookTelemetry = {
      tmpPath: null,
      targetPath: null,
      writtenBytes: [],
      linkErrno: null,
      linkSucceeded: false,
      afterPause: false,
      mkdirsAfterPause: 0,
      opensCreateAfterPause: 0,
      writesAfterPause: 0,
      linksAfterPause: 0,
      unlinksAfterPause: 0,
    };

    const leafKind = mode === "artifact" ? "artifacts" : "log";
    const fsOps = buildWorkerFsOps({
      pauseAt,
      workerId,
      stateRoot,
      issueRef,
      leafKind,
      selfStartTime,
      holderPid: activeLease.holderPid,
      holderStartTime: activeLease.holderStartTime,
      telemetry,
    });

    let failed = false;
    try {
      const { writeResult } = await activeLease.enqueue({
        write: () => {
          if (pauseAt === "before-store-call") {
            emitSync({
              event: "paused",
              workerId,
              point: "before-store-call",
              pid: process.pid,
              startTime: selfStartTime,
              holderPid: activeLease.holderPid,
              holderStartTime: activeLease.holderStartTime,
            });
            readControlLineSync();
            telemetry.afterPause = true;
          }
          if (mode === "artifact") {
            return writeArtifact(activeLease, issueRef, content, { fs: fsOps });
          }
          return appendCommitRecord(
            activeLease,
            buildRecordInput(issueRef, recordKind, tag),
            { fs: fsOps },
          );
        },
      });
      emitSync({
        event: mode === "artifact" ? "artifact_ok" : "append_ok",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
        holderPid: activeLease.holderPid,
        holderStartTime: activeLease.holderStartTime,
        epoch: activeLease.epoch,
        result: writeResult,
        tmpPath: telemetry.tmpPath,
        targetPath: telemetry.targetPath,
        writtenBytesBase64:
          telemetry.writtenBytes.length > 0
            ? Buffer.concat(telemetry.writtenBytes).toString("base64")
            : null,
        linkErrno: telemetry.linkErrno,
        linkSucceeded: telemetry.linkSucceeded,
        mkdirsAfterPause: telemetry.mkdirsAfterPause,
        opensCreateAfterPause: telemetry.opensCreateAfterPause,
        writesAfterPause: telemetry.writesAfterPause,
        linksAfterPause: telemetry.linksAfterPause,
        unlinksAfterPause: telemetry.unlinksAfterPause,
      });
    } catch (err) {
      failed = true;
      emitSync({
        event: mode === "artifact" ? "artifact_failed" : "append_failed",
        workerId,
        pid: process.pid,
        startTime: selfStartTime,
        holderPid: activeLease.holderPid,
        holderStartTime: activeLease.holderStartTime,
        epoch: activeLease.epoch,
        code: getErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
        tmpPath: telemetry.tmpPath,
        targetPath: telemetry.targetPath,
        writtenBytesBase64:
          telemetry.writtenBytes.length > 0
            ? Buffer.concat(telemetry.writtenBytes).toString("base64")
            : null,
        linkErrno: telemetry.linkErrno,
        linkSucceeded: telemetry.linkSucceeded,
        mkdirsAfterPause: telemetry.mkdirsAfterPause,
        opensCreateAfterPause: telemetry.opensCreateAfterPause,
        writesAfterPause: telemetry.writesAfterPause,
        linksAfterPause: telemetry.linksAfterPause,
        unlinksAfterPause: telemetry.unlinksAfterPause,
      });
    }

    if ((!failed && holdAfter) || (failed && stayAliveOnError)) {
      let extraSeq = 0;
      while (true) {
        const cmd = await commands.nextCommand();
        if (cmd === null || cmd === "exit") {
          break;
        }
        if (cmd === "release") {
          if (lease !== null) {
            const toRelease = lease;
            lease = null;
            await toRelease.release();
            emitSync({
              event: "released",
              workerId,
              pid: process.pid,
              holderPid: toRelease.holderPid,
              epoch: toRelease.epoch,
            });
          }
          break;
        }
        if (cmd === "append_again" && lease !== null) {
          extraSeq += 1;
          const currentLease = lease;
          try {
            const { writeResult } = await currentLease.enqueue({
              write: () =>
                appendCommitRecord(
                  currentLease,
                  buildRecordInput(issueRef, recordKind, tag, `again${extraSeq}`),
                ),
            });
            emitSync({
              event: "append_ok",
              workerId,
              pid: process.pid,
              epoch: currentLease.epoch,
              result: writeResult,
            });
          } catch (err) {
            emitSync({
              event: "append_failed",
              workerId,
              pid: process.pid,
              epoch: currentLease.epoch,
              code: getErrorCode(err),
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  } finally {
    if (lease !== null) {
      const toRelease = lease;
      lease = null;
      await toRelease.release();
    }
    commands.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(1);
});
