#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLease, formatError } from "../p2/lease.mjs";
import { buildStandInWorkerArgv, verifyCapturedOutput } from "./capture.mjs";
import {
  buildDeterministicName,
  createHcClient,
  HcBoundaryError,
  normalizePrefix,
  validateHcBin,
} from "./hc-boundary.mjs";
import {
  appendCommitRecord,
  foldCommitLog,
  getTicketDir,
  writeArtifactOnce,
} from "./ledger.mjs";

export const CRASH_POINTS = Object.freeze([
  "after_intent_before_launch",
  "after_launch_before_receipt",
  "after_receipt",
]);

const CRASH_POINT_SET = new Set(CRASH_POINTS);

function sigkillSelfNoCleanup() {
  // Real OS SIGKILL with no JS cleanup or lease release.
  process.kill(process.pid, "SIGKILL");
}

function requireNonEmptyString(value, flagName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required argument: ${flagName}`);
  }
  return value;
}

export async function runStart({
  hcBin,
  stateRoot,
  projectKey,
  issue,
  prefix,
  cwd,
  briefText = "Probe P5 stand-in recovery tracer brief",
  expectedLines = 250,
  reportFile = null,
  gateFifo = null,
  delaySeconds = 0,
  crashAt = null,
  hcTimeoutMs = 10_000,
}) {
  // Refuse to start without an explicit hc path BEFORE acquiring lease or touching hc.
  validateHcBin(hcBin);
  requireNonEmptyString(stateRoot, "--state-root");
  requireNonEmptyString(projectKey, "--project-key");
  requireNonEmptyString(String(issue ?? ""), "--issue");
  const { prefix: normPrefix } = normalizePrefix(prefix);
  requireNonEmptyString(cwd, "--cwd");

  if (crashAt !== null && !CRASH_POINT_SET.has(crashAt)) {
    throw new Error(`Invalid --crash-at value ${JSON.stringify(crashAt)}; expected one of ${CRASH_POINTS.join(", ")}`);
  }

  const hc = createHcClient({ hcBin, prefix: normPrefix, defaultTimeoutMs: hcTimeoutMs });
  const ticketDir = getTicketDir(stateRoot, issue);
  const issueRef = `issue#${issue}`;

  const lease = await acquireLease({ projectKey, stateRoot });
  try {
    const initialFold = foldCommitLog(ticketDir);
    if (initialFold.status === "quarantined") {
      throw new Error(`Commit log is quarantined: ${initialFold.quarantineReason}`);
    }
    if (initialFold.phase !== "drafted" || initialFold.lastSeq !== 0) {
      throw new Error(
        `start requires a fresh ticket log (found phase=${initialFold.phase}, lastSeq=${initialFold.lastSeq}); use recover instead`,
      );
    }

    // Step 1: persist immutable brief artifact, then commit brief_committed inside lease queue.
    const briefCommit = await lease.enqueue({
      write: () => {
        const briefArtifact = writeArtifactOnce(ticketDir, briefText);
        return appendCommitRecord(ticketDir, {
          ownerEpoch: lease.epoch,
          projectKey,
          issueRef,
          event: "brief_committed",
          intent: {
            briefVersion: 1,
            briefSha256: briefArtifact.sha256,
            riskTier: "mid",
            expectedLines,
            reportFile: reportFile ?? null,
          },
          evidenceRefs: [
            {
              kind: "brief",
              sha256: briefArtifact.sha256,
              bytes: briefArtifact.bytes,
              truncated: false,
            },
          ],
          countersAfter: {
            attemptSeq: 0,
            totalAttemptsUsed: 0,
            fixRoundsUsed: 0,
          },
          phaseAfter: {
            phase: "ready",
            attemptState: null,
          },
        });
      },
    });

    const attemptId = "a1";
    const terminalName = buildDeterministicName({
      prefix: normPrefix,
      issue,
      attemptId,
    });
    const workerArgv = buildStandInWorkerArgv({
      attemptId,
      expectedLines,
      reportFile,
      gateFifo,
      delaySeconds,
    });

    // Step 2: commit launch_intent durably BEFORE external hc run effect, both inside serialized lease queue.
    const launchStep = await lease.enqueue({
      write: () => {
        const intentRecord = appendCommitRecord(ticketDir, {
          ownerEpoch: lease.epoch,
          projectKey,
          issueRef,
          event: "launch_intent",
          attemptId,
          intent: {
            terminalName,
            prefix: normPrefix,
            cwd,
            outliveParent: true,
            noParent: true,
            noNotify: true,
            expectedLines,
            reportFile: reportFile ?? null,
          },
          evidenceRefs: [],
          countersAfter: {
            attemptSeq: 1,
            totalAttemptsUsed: 1,
            fixRoundsUsed: 0,
          },
          phaseAfter: {
            phase: "building",
            attemptState: "intent",
          },
        });

        if (crashAt === "after_intent_before_launch") {
          sigkillSelfNoCleanup();
        }
        return intentRecord;
      },
      effect: async () => {
        const runRes = await hc.run({
          name: terminalName,
          cwd,
          argv: workerArgv,
          outliveParent: true,
          noParent: true,
          noNotify: true,
          timeoutMs: hcTimeoutMs,
        });

        if (crashAt === "after_launch_before_receipt") {
          sigkillSelfNoCleanup();
        }
        return runRes;
      },
    });

    const runRes = launchStep.effectResult;

    // Step 3: commit launch_receipt (or launch_failed_authoritative if hc run returned error with no address).
    const receiptStep = await lease.enqueue({
      write: () => {
        if (!runRes.ok) {
          return appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "launch_failed_authoritative",
            attemptId,
            receipt: {
              exitCode: runRes.exitCode,
              error: runRes.error,
              disposition: "not_delivered",
            },
            evidenceRefs: [],
            countersAfter: {
              attemptSeq: 1,
              totalAttemptsUsed: 1,
              fixRoundsUsed: 0,
            },
            phaseAfter: {
              phase: "ready",
              attemptState: null,
            },
          });
        }

        const r = runRes.result;
        const receiptRecord = appendCommitRecord(ticketDir, {
          ownerEpoch: lease.epoch,
          projectKey,
          issueRef,
          event: "launch_receipt",
          attemptId,
          receipt: {
            address: r.address,
            name: r.name ?? terminalName,
            state: r.state,
            turn: r.turn ?? 0,
            agent: r.agent ?? null,
            firstMessage: r.first_message ?? null,
          },
          evidenceRefs: [],
          countersAfter: {
            attemptSeq: 1,
            totalAttemptsUsed: 1,
            fixRoundsUsed: 0,
          },
          phaseAfter: {
            phase: "building",
            attemptState: "delivered",
          },
        });

        if (crashAt === "after_receipt") {
          sigkillSelfNoCleanup();
        }
        return receiptRecord;
      },
    });

    const outcome = runRes.ok ? "launched" : "not_delivered";
    return {
      exitCode: runRes.ok ? 0 : 1,
      payload: {
        outcome,
        epoch: lease.epoch,
        pid: process.pid,
        holderPid: lease.holderPid,
        attemptId,
        terminalName,
        address: runRes.ok ? runRes.result.address : null,
        briefSeq: briefCommit.writeResult.seq,
        intentSeq: launchStep.writeResult.seq,
        receiptSeq: receiptStep.writeResult.seq,
      },
    };
  } finally {
    await lease.release();
  }
}

export async function runRecover({
  hcBin,
  stateRoot,
  projectKey,
  issue,
  prefix,
  readLines = 1000,
  waitTimeoutSecs = 10,
  hcTimeoutMs = 10_000,
}) {
  validateHcBin(hcBin);
  requireNonEmptyString(stateRoot, "--state-root");
  requireNonEmptyString(projectKey, "--project-key");
  requireNonEmptyString(String(issue ?? ""), "--issue");
  const { prefix: normPrefix } = normalizePrefix(prefix);

  const hc = createHcClient({ hcBin, prefix: normPrefix, defaultTimeoutMs: hcTimeoutMs });
  const ticketDir = getTicketDir(stateRoot, issue);
  const issueRef = `issue#${issue}`;

  const lease = await acquireLease({ projectKey, stateRoot });
  try {
    const folded = foldCommitLog(ticketDir);
    if (folded.status === "quarantined") {
      return {
        exitCode: 2,
        payload: {
          outcome: "quarantined",
          epoch: lease.epoch,
          reason: folded.quarantineReason,
        },
      };
    }

    if (folded.recoveryAction === "ready_to_launch") {
      return {
        exitCode: 0,
        payload: {
          outcome: "nothing_to_recover",
          phase: folded.phase,
          epoch: lease.epoch,
        },
      };
    }

    if (folded.recoveryAction === "already_settled") {
      return {
        exitCode: 0,
        payload: {
          outcome: "already_settled",
          phase: folded.phase,
          epoch: lease.epoch,
        },
      };
    }

    if (folded.recoveryAction === "already_escalated_uncertain") {
      return {
        exitCode: 0,
        payload: {
          outcome: "uncertain",
          escalated: true,
          alreadyEscalated: true,
          epoch: lease.epoch,
          terminalName: folded.openAttempt.terminalName,
          boundAddress: folded.openAttempt.boundAddress,
        },
      };
    }

    const attempt = folded.openAttempt;

    // Crash window: after launch_intent, before launch_receipt (section 8 row 2).
    if (folded.recoveryAction === "reconcile_uncertain_launch") {
      const lookup = await hc.get(attempt.terminalName, { timeoutMs: hcTimeoutMs });

      if (!lookup.ok && lookup.notFound) {
        const rec = await lease.enqueue({
          write: () =>
            appendCommitRecord(ticketDir, {
              ownerEpoch: lease.epoch,
              projectKey,
              issueRef,
              event: "reconcile_unresolved",
              attemptId: attempt.attemptId,
              receipt: {
                lookupName: attempt.terminalName,
                found: false,
                boundAddress: null,
                reason: "launch_intent_without_receipt_not_found",
              },
              evidenceRefs: [],
              countersAfter: folded.counters,
              phaseAfter: {
                phase: "escalated",
                attemptState: "uncertain",
              },
            }),
        });
        return {
          exitCode: 0,
          payload: {
            outcome: "uncertain",
            escalated: true,
            found: false,
            epoch: lease.epoch,
            foldedFromSeq: folded.lastSeq,
            foldedAttemptStateBefore: attempt.state,
            terminalName: attempt.terminalName,
            boundAddress: null,
            recordSeq: rec.writeResult.seq,
          },
        };
      }

      if (!lookup.ok) {
        const rec = await lease.enqueue({
          write: () =>
            appendCommitRecord(ticketDir, {
              ownerEpoch: lease.epoch,
              projectKey,
              issueRef,
              event: "reconcile_unresolved",
              attemptId: attempt.attemptId,
              receipt: {
                lookupName: attempt.terminalName,
                found: null,
                boundAddress: null,
                reason: "launch_readback_error",
                error: lookup.error,
              },
              evidenceRefs: [],
              countersAfter: folded.counters,
              phaseAfter: {
                phase: "escalated",
                attemptState: "uncertain",
              },
            }),
        });
        return {
          exitCode: 0,
          payload: {
            outcome: "uncertain",
            escalated: true,
            found: null,
            epoch: lease.epoch,
            foldedFromSeq: folded.lastSeq,
            foldedAttemptStateBefore: attempt.state,
            terminalName: attempt.terminalName,
            boundAddress: null,
            recordSeq: rec.writeResult.seq,
          },
        };
      }

      // Terminal found by deterministic name: per section 8 row 2, bind terminal,
      // inspect first_message/state/status?.state/turn, read screen once with --lines 0,
      // never launch a duplicate, stay uncertain and escalate.
      const term = lookup.terminal;
      const screenRead = await hc.read(attempt.terminalName, { lines: 0, timeoutMs: hcTimeoutMs });
      const evidenceRefs = [];
      if (screenRead.ok) {
        const screenArtifact = writeArtifactOnce(ticketDir, screenRead.result.text);
        evidenceRefs.push({
          kind: "readback_screen",
          sha256: screenArtifact.sha256,
          bytes: screenArtifact.bytes,
          truncated: !screenRead.result.complete,
        });
      }

      const unsent = term.first_message && term.first_message.sent === false;
      const reason = unsent ? "launch_first_message_unsent" : "launch_intent_without_receipt_found";

      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "reconcile_unresolved",
            attemptId: attempt.attemptId,
            receipt: {
              lookupName: attempt.terminalName,
              found: true,
              boundAddress: term.address,
              terminalState: term.state,
              statusState: term.status?.state ?? null,
              turn: term.turn ?? 0,
              firstMessage: term.first_message ?? null,
              screenReadOk: screenRead.ok,
              reason,
            },
            evidenceRefs,
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });

      return {
        exitCode: 0,
        payload: {
          outcome: "uncertain",
          escalated: true,
          found: true,
          epoch: lease.epoch,
          foldedFromSeq: folded.lastSeq,
          foldedAttemptStateBefore: attempt.state,
          terminalName: attempt.terminalName,
          boundAddress: term.address,
          terminalState: term.state,
          statusState: term.status?.state ?? null,
          firstMessage: term.first_message ?? null,
          reason,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    // Crash window: after launch_receipt was written (section 8 row 5).
    // Always find the worker by its deterministic name from the folded log (never in-memory address).
    let lookup = await hc.get(attempt.terminalName, { timeoutMs: hcTimeoutMs });
    if (!lookup.ok) {
      const reason = lookup.notFound ? "terminal_missing" : "readback_error";
      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "reconcile_unresolved",
            attemptId: attempt.attemptId,
            receipt: {
              lookupName: attempt.terminalName,
              found: false,
              boundAddress: null,
              reason,
              error: lookup.error,
            },
            evidenceRefs: [],
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });
      return {
        exitCode: 3,
        payload: {
          outcome: "uncertain",
          escalated: true,
          reason,
          epoch: lease.epoch,
          terminalName: attempt.terminalName,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    let term = lookup.terminal;
    if (attempt.address !== null && term.address !== attempt.address) {
      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "reconcile_unresolved",
            attemptId: attempt.attemptId,
            receipt: {
              lookupName: attempt.terminalName,
              found: true,
              boundAddress: term.address,
              expectedAddress: attempt.address,
              reason: "terminal_address_mismatch",
            },
            evidenceRefs: [],
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });
      return {
        exitCode: 3,
        payload: {
          outcome: "uncertain",
          escalated: true,
          reason: "terminal_address_mismatch",
          epoch: lease.epoch,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    if (term.keep === true) {
      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "capture_unusable",
            attemptId: attempt.attemptId,
            receipt: {
              address: term.address,
              name: attempt.terminalName,
              reason: "kept_shell_rejected",
            },
            evidenceRefs: [],
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });
      return {
        exitCode: 3,
        payload: {
          outcome: "capture_unusable",
          reason: "kept_shell_rejected",
          terminalKept: true,
          epoch: lease.epoch,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    if (term.state === "live") {
      const waitRes = await hc.wait(attempt.terminalName, {
        timeoutSecs: waitTimeoutSecs,
        timeoutMs: Math.max(hcTimeoutMs, Math.ceil(waitTimeoutSecs * 1000) + 5000),
      });
      if (!waitRes.ok) {
        const reason = waitRes.notFound ? "terminal_missing" : "wait_error";
        const rec = await lease.enqueue({
          write: () =>
            appendCommitRecord(ticketDir, {
              ownerEpoch: lease.epoch,
              projectKey,
              issueRef,
              event: "reconcile_unresolved",
              attemptId: attempt.attemptId,
              receipt: {
                lookupName: attempt.terminalName,
                found: !waitRes.notFound,
                boundAddress: term.address,
                reason,
                error: waitRes.error,
              },
              evidenceRefs: [],
              countersAfter: folded.counters,
              phaseAfter: {
                phase: "escalated",
                attemptState: "uncertain",
              },
            }),
        });
        return {
          exitCode: 3,
          payload: {
            outcome: "uncertain",
            escalated: true,
            reason,
            epoch: lease.epoch,
            recordSeq: rec.writeResult.seq,
          },
        };
      }

      // Section 8 row 4: inspect JSON ended and reason, never treat exit 0 alone as finished.
      if (waitRes.result.ended !== true) {
        return {
          exitCode: 4,
          payload: {
            outcome: "still_running",
            epoch: lease.epoch,
            terminalName: attempt.terminalName,
            address: term.address,
            reason: waitRes.result.reason,
          },
        };
      }

      lookup = await hc.get(attempt.terminalName, { timeoutMs: hcTimeoutMs });
      if (!lookup.ok) {
        const reason = lookup.notFound ? "terminal_missing_after_wait" : "readback_error";
        const rec = await lease.enqueue({
          write: () =>
            appendCommitRecord(ticketDir, {
              ownerEpoch: lease.epoch,
              projectKey,
              issueRef,
              event: "reconcile_unresolved",
              attemptId: attempt.attemptId,
              receipt: {
                lookupName: attempt.terminalName,
                found: !lookup.notFound,
                boundAddress: term.address,
                reason,
                error: lookup.error,
              },
              evidenceRefs: [],
              countersAfter: folded.counters,
              phaseAfter: {
                phase: "escalated",
                attemptState: "uncertain",
              },
            }),
        });
        return {
          exitCode: 3,
          payload: {
            outcome: "uncertain",
            escalated: true,
            reason,
            epoch: lease.epoch,
            recordSeq: rec.writeResult.seq,
          },
        };
      }
      term = lookup.terminal;
    }

    const readRes = await hc.read(attempt.terminalName, {
      lines: readLines,
      timeoutMs: hcTimeoutMs,
    });
    if (!readRes.ok) {
      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "capture_unusable",
            attemptId: attempt.attemptId,
            receipt: {
              address: term.address,
              name: attempt.terminalName,
              reason: "hc_read_failed",
              error: readRes.error,
            },
            evidenceRefs: [],
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });
      return {
        exitCode: 3,
        payload: {
          outcome: "capture_unusable",
          reason: "hc_read_failed",
          terminalKept: true,
          epoch: lease.epoch,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    const verified = verifyCapturedOutput({
      readResult: readRes.result,
      terminal: term,
      attemptId: attempt.attemptId,
      expectedLines: attempt.intent.expectedLines,
      reportFile: attempt.intent.reportFile,
    });

    if (!verified.ok) {
      // Section 8 row 5: keep the terminal when the capture is missing, truncated, or unverified.
      const rec = await lease.enqueue({
        write: () =>
          appendCommitRecord(ticketDir, {
            ownerEpoch: lease.epoch,
            projectKey,
            issueRef,
            event: "capture_unusable",
            attemptId: attempt.attemptId,
            receipt: {
              address: term.address,
              name: attempt.terminalName,
              readHow: readRes.result.how,
              readComplete: readRes.result.complete,
              verificationError: verified.reason,
              details: verified.details ?? null,
            },
            evidenceRefs: [],
            countersAfter: folded.counters,
            phaseAfter: {
              phase: "escalated",
              attemptState: "uncertain",
            },
          }),
      });
      return {
        exitCode: 3,
        payload: {
          outcome: "capture_unusable",
          reason: verified.reason,
          details: verified.details ?? null,
          readCompleteClaimed: readRes.result.complete,
          terminalKept: true,
          epoch: lease.epoch,
          terminalName: attempt.terminalName,
          address: term.address,
          recordSeq: rec.writeResult.seq,
        },
      };
    }

    // Section 4 & 8: persist artifact BEFORE committing capture_settled.
    const settled = await lease.enqueue({
      write: () => {
        const artifact = writeArtifactOnce(ticketDir, verified.payloadText);
        const rec = appendCommitRecord(ticketDir, {
          ownerEpoch: lease.epoch,
          projectKey,
          issueRef,
          event: "capture_settled",
          attemptId: attempt.attemptId,
          receipt: {
            address: term.address,
            name: attempt.terminalName,
            state: term.state,
            exitCode: term.exit_code,
            signal: term.signal,
            reason: term.reason,
            screen: term.screen,
            readHow: readRes.result.how,
            readComplete: readRes.result.complete,
            linesVerified: verified.linesVerified,
            reportFileVerified: verified.reportFileVerified,
          },
          evidenceRefs: [
            {
              kind: "worker_output",
              sha256: artifact.sha256,
              bytes: artifact.bytes,
              truncated: false,
            },
          ],
          countersAfter: folded.counters,
          phaseAfter: {
            phase: "gating",
            attemptState: null,
          },
        });
        return { artifact, rec };
      },
    });

    return {
      exitCode: 0,
      payload: {
        outcome: "captured",
        epoch: lease.epoch,
        foldedFromSeq: folded.lastSeq,
        terminalName: attempt.terminalName,
        address: term.address,
        artifactSha256: settled.writeResult.artifact.sha256,
        artifactBytes: settled.writeResult.artifact.bytes,
        linesVerified: verified.linesVerified,
        reportFileVerified: verified.reportFileVerified,
        recordSeq: settled.writeResult.rec.seq,
      },
    };
  } finally {
    await lease.release();
  }
}

export async function runCleanup({ hcBin, prefix, hcTimeoutMs = 10_000 }) {
  validateHcBin(hcBin);
  const { prefix: normPrefix, namespace } = normalizePrefix(prefix);
  const hc = createHcClient({ hcBin, prefix: normPrefix, defaultTimeoutMs: hcTimeoutMs });

  const listed = await hc.ls({ all: true, timeoutMs: hcTimeoutMs });
  const matching = [];
  let skippedCount = 0;

  for (const term of listed.terminals) {
    if (
      term &&
      typeof term.name === "string" &&
      term.name.startsWith(namespace) &&
      typeof term.address === "string" &&
      !term.address.includes("/")
    ) {
      matching.push(term);
    } else {
      skippedCount += 1;
    }
  }

  const removed = [];
  const failures = [];

  for (const term of matching) {
    const addr = term.address;
    const wasLive = term.state === "live";

    if (wasLive) {
      const killRes = await hc.kill(addr, { timeoutMs: hcTimeoutMs });
      if (!killRes.ok && !killRes.notFound) {
        failures.push({ address: addr, name: term.name, step: "kill", error: killRes.error });
        continue;
      }
      if (killRes.ok && killRes.terminal?.state !== "finished") {
        await hc.wait(addr, { timeoutSecs: 5, timeoutMs: Math.max(hcTimeoutMs, 6000) });
      }
    }

    const rmRes = await hc.rm(addr, { timeoutMs: hcTimeoutMs });
    if (!rmRes.ok && !rmRes.notFound) {
      failures.push({ address: addr, name: term.name, step: "rm", error: rmRes.error });
      continue;
    }

    // Read each removed terminal back by address; expect exit 3 (not_found).
    const readback = await hc.get(addr, { timeoutMs: hcTimeoutMs });
    if (readback.ok || !readback.notFound) {
      failures.push({
        address: addr,
        name: term.name,
        step: "readback",
        exitCode: readback.exitCode,
        stillPresent: readback.ok,
        error: readback.error ?? null,
      });
      continue;
    }

    removed.push({
      address: addr,
      name: term.name,
      wasLive,
      readbackExitCode: readback.exitCode,
      readbackKind: readback.error?.kind ?? "not_found",
    });
  }

  const afterLs = await hc.ls({ all: true, timeoutMs: hcTimeoutMs });
  const remainingPrefixed = afterLs.terminals.filter(
    (t) => t && typeof t.name === "string" && t.name.startsWith(namespace),
  );

  const ok = failures.length === 0 && remainingPrefixed.length === 0;
  return {
    exitCode: ok ? 0 : 1,
    payload: {
      outcome: ok ? "cleaned" : "cleanup_incomplete",
      prefix: normPrefix,
      namespace,
      removed,
      skippedCount,
      remainingPrefixedCount: remainingPrefixed.length,
      failures,
    },
  };
}

function parseCliArgs(argv) {
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      if (i + 1 >= argv.length) {
        throw new Error(`Flag ${token} requires a value`);
      }
      flags[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return { cmd, flags };
}

function parseOptionalInt(raw, fallback, flagName) {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flagName} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseOptionalPositiveNumber(raw, fallback, flagName) {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flagName} must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return n;
}

async function main() {
  const { cmd, flags } = parseCliArgs(process.argv.slice(2));
  if (!cmd) {
    throw new Error("Usage: tracer.mjs <start|recover|cleanup> --hc-bin <path> ...");
  }

  let res;
  if (cmd === "start") {
    res = await runStart({
      hcBin: flags["hc-bin"],
      stateRoot: flags["state-root"],
      projectKey: flags["project-key"],
      issue: flags.issue,
      prefix: flags.prefix,
      cwd: flags.cwd,
      briefText: flags["brief-text"] ?? "Probe P5 stand-in recovery tracer brief",
      expectedLines: parseOptionalInt(flags["expected-lines"], 250, "--expected-lines"),
      reportFile: flags["report-file"] ?? null,
      gateFifo: flags["gate-fifo"] ?? null,
      delaySeconds: flags["delay-seconds"] !== undefined ? parseOptionalPositiveNumber(flags["delay-seconds"], 0, "--delay-seconds") : 0,
      crashAt: flags["crash-at"] ?? null,
      hcTimeoutMs: parseOptionalInt(flags["hc-timeout-ms"], 10_000, "--hc-timeout-ms"),
    });
  } else if (cmd === "recover") {
    res = await runRecover({
      hcBin: flags["hc-bin"],
      stateRoot: flags["state-root"],
      projectKey: flags["project-key"],
      issue: flags.issue,
      prefix: flags.prefix,
      readLines: parseOptionalInt(flags["read-lines"], 1000, "--read-lines"),
      waitTimeoutSecs: parseOptionalPositiveNumber(flags["wait-timeout-secs"], 10, "--wait-timeout-secs"),
      hcTimeoutMs: parseOptionalInt(flags["hc-timeout-ms"], 10_000, "--hc-timeout-ms"),
    });
  } else if (cmd === "cleanup") {
    res = await runCleanup({
      hcBin: flags["hc-bin"],
      prefix: flags.prefix,
      hcTimeoutMs: parseOptionalInt(flags["hc-timeout-ms"], 10_000, "--hc-timeout-ms"),
    });
  } else {
    throw new Error(`Unknown command ${JSON.stringify(cmd)}; expected start, recover, or cleanup`);
  }

  process.stdout.write(`${JSON.stringify(res.payload)}\n`);
  process.exit(res.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    const code = err instanceof HcBoundaryError ? err.code : "tracer_error";
    process.stderr.write(`${JSON.stringify({ error: { code, message: formatError(err) } })}\n`);
    process.exit(1);
  });
}
