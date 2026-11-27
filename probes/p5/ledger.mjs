import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GENESIS_SHA256 = "0".repeat(64);
export const MAX_COMMIT_RECORD_BYTES = 8192;
const SEQ_FILE_RE = /^(\d{6})\.json$/;

export class LedgerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function formatSeq6(seq) {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999) {
    throw new LedgerError("invalid_seq", `Sequence number out of range: ${seq}`);
  }
  return String(seq).padStart(6, "0");
}

export function getTicketDir(stateRoot, issue) {
  const issueStr = String(issue);
  if (!/^[a-z0-9_-]+$/.test(issueStr)) {
    throw new LedgerError("invalid_issue", `Invalid issue folder name: ${JSON.stringify(issue)}`);
  }
  return path.join(stateRoot, "tickets", issueStr);
}

function fsyncDir(dirPath) {
  const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function writeExclusiveHardLink(dirPath, finalName, payloadBuffer, { allowExistingMatchingHash = null } = {}) {
  fs.mkdirSync(dirPath, { recursive: true });
  const finalPath = path.join(dirPath, finalName);
  const tmpName = `.${finalName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dirPath, tmpName);

  let fd;
  let tmpCreated = false;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    tmpCreated = true;
    fs.writeFileSync(fd, payloadBuffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      fs.linkSync(tmpPath, finalPath);
    } catch (err) {
      if (err && typeof err === "object" && err.code === "EEXIST" && allowExistingMatchingHash !== null) {
        const existingBytes = fs.readFileSync(finalPath);
        const existingSha = sha256Hex(existingBytes);
        if (existingSha !== allowExistingMatchingHash) {
          throw new LedgerError(
            "artifact_hash_collision",
            `Existing artifact ${finalPath} hash mismatch: expected ${allowExistingMatchingHash}, found ${existingSha}`,
          );
        }
        return { path: finalPath, existed: true };
      }
      if (err && typeof err === "object" && err.code === "EEXIST") {
        throw new LedgerError("record_exists", `Commit record already exists: ${finalPath}`);
      }
      throw err;
    }

    fs.unlinkSync(tmpPath);
    tmpCreated = false;
    fsyncDir(dirPath);
    return { path: finalPath, existed: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup path.
      }
    }
    if (tmpCreated) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore temp unlink error on cleanup path.
      }
    }
  }
}

export function writeArtifactOnce(ticketDir, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const digest = sha256Hex(buf);
  const artifactsDir = path.join(ticketDir, "artifacts");
  const fileName = `${digest}.md`;
  const { path: artifactPath } = writeExclusiveHardLink(artifactsDir, fileName, buf, {
    allowExistingMatchingHash: digest,
  });
  return {
    sha256: digest,
    bytes: buf.length,
    path: artifactPath,
  };
}

export function readArtifactVerified(ticketDir, expectedSha256) {
  const artifactPath = path.join(ticketDir, "artifacts", `${expectedSha256}.md`);
  const bytes = fs.readFileSync(artifactPath);
  const actualSha = sha256Hex(bytes);
  if (actualSha !== expectedSha256) {
    throw new LedgerError(
      "artifact_corrupt",
      `Artifact ${artifactPath} SHA-256 mismatch: expected ${expectedSha256}, actual ${actualSha}`,
    );
  }
  return bytes.toString("utf8");
}

export function appendCommitRecord(ticketDir, recordData) {
  const folded = foldCommitLog(ticketDir);
  if (folded.status === "quarantined") {
    throw new LedgerError("ledger_quarantined", `Cannot append to quarantined commit log: ${folded.quarantineReason}`);
  }

  const nextSeq = folded.lastSeq + 1;
  const prevRecordSha256 = folded.lastSeq === 0 ? GENESIS_SHA256 : folded.lastRecordSha256;

  const record = {
    schemaVersion: 1,
    seq: nextSeq,
    prevRecordSha256,
    time: new Date().toISOString(),
    ownerEpoch: recordData.ownerEpoch,
    projectKey: recordData.projectKey,
    issueRef: recordData.issueRef,
    event: recordData.event,
    ...(recordData.attemptId !== undefined ? { attemptId: recordData.attemptId } : {}),
    ...(recordData.intent !== undefined ? { intent: recordData.intent } : {}),
    ...(recordData.receipt !== undefined ? { receipt: recordData.receipt } : {}),
    evidenceRefs: recordData.evidenceRefs ?? [],
    countersAfter: recordData.countersAfter,
    phaseAfter: recordData.phaseAfter,
  };

  const payloadStr = `${JSON.stringify(record, null, 2)}\n`;
  const payloadBuf = Buffer.from(payloadStr, "utf8");
  if (payloadBuf.length >= MAX_COMMIT_RECORD_BYTES) {
    throw new LedgerError(
      "record_too_large",
      `Commit record seq=${nextSeq} is ${payloadBuf.length} bytes (limit < ${MAX_COMMIT_RECORD_BYTES})`,
    );
  }

  const logDir = path.join(ticketDir, "log");
  const fileName = `${formatSeq6(nextSeq)}.json`;
  const { path: recordPath } = writeExclusiveHardLink(logDir, fileName, payloadBuf);
  const digest = sha256Hex(payloadBuf);

  return {
    seq: nextSeq,
    sha256: digest,
    path: recordPath,
    record,
  };
}

function quarantine(reason, records = []) {
  return {
    status: "quarantined",
    phase: "quarantined",
    quarantineReason: reason,
    recoveryAction: "quarantined",
    brief: null,
    openAttempt: null,
    settledAttempts: [],
    counters: { attemptSeq: 0, totalAttemptsUsed: 0, fixRoundsUsed: 0 },
    records,
    lastSeq: records.length,
    lastRecordSha256: GENESIS_SHA256,
  };
}

function verifyEvidenceRefs(ticketDir, evidenceRefs, seq) {
  if (!Array.isArray(evidenceRefs)) {
    return `Record seq=${seq} evidenceRefs is not an array`;
  }
  for (const ref of evidenceRefs) {
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof ref.kind !== "string" ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !Number.isInteger(ref.bytes) ||
      ref.bytes < 0 ||
      typeof ref.truncated !== "boolean"
    ) {
      return `Record seq=${seq} has malformed evidenceRef`;
    }
    const artifactPath = path.join(ticketDir, "artifacts", `${ref.sha256}.md`);
    let raw;
    try {
      raw = fs.readFileSync(artifactPath);
    } catch {
      return `Record seq=${seq} references missing artifact ${ref.sha256}`;
    }
    if (raw.length !== ref.bytes) {
      return `Record seq=${seq} artifact ${ref.sha256} byte mismatch: expected ${ref.bytes}, got ${raw.length}`;
    }
    const actualSha = sha256Hex(raw);
    if (actualSha !== ref.sha256) {
      return `Record seq=${seq} artifact ${ref.sha256} SHA-256 mismatch: actual ${actualSha}`;
    }
  }
  return null;
}

export function foldCommitLog(ticketDir) {
  const logDir = path.join(ticketDir, "log");
  let entries;
  try {
    entries = fs.readdirSync(logDir);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return {
        status: "ok",
        phase: "drafted",
        recoveryAction: "ready_to_launch",
        brief: null,
        openAttempt: null,
        settledAttempts: [],
        counters: { attemptSeq: 0, totalAttemptsUsed: 0, fixRoundsUsed: 0 },
        records: [],
        lastSeq: 0,
        lastRecordSha256: GENESIS_SHA256,
      };
    }
    throw err;
  }

  const recordFiles = [];
  for (const name of entries) {
    if (name.startsWith(".")) {
      // Orphan temp file from an interrupted crash before hard-link is harmless.
      continue;
    }
    const match = SEQ_FILE_RE.exec(name);
    if (!match) {
      return quarantine(`Unexpected file in commit log directory: ${name}`);
    }
    recordFiles.push({ name, seq: Number(match[1]) });
  }
  recordFiles.sort((a, b) => a.seq - b.seq);

  let phase = "drafted";
  let brief = null;
  let openAttempt = null;
  const settledAttempts = [];
  let counters = { attemptSeq: 0, totalAttemptsUsed: 0, fixRoundsUsed: 0 };
  const records = [];
  let expectedPrevSha = GENESIS_SHA256;

  for (let i = 0; i < recordFiles.length; i += 1) {
    const expectedSeq = i + 1;
    const file = recordFiles[i];
    if (file.seq !== expectedSeq) {
      return quarantine(`Sequence gap in commit log: expected ${formatSeq6(expectedSeq)}.json, found ${file.name}`, records);
    }

    const fullPath = path.join(logDir, file.name);
    const rawBuf = fs.readFileSync(fullPath);
    if (rawBuf.length >= MAX_COMMIT_RECORD_BYTES) {
      return quarantine(`Commit record ${file.name} exceeds 8 KB limit (${rawBuf.length} bytes)`, records);
    }

    let record;
    try {
      record = JSON.parse(rawBuf.toString("utf8"));
    } catch (err) {
      return quarantine(`Commit record ${file.name} parse error: ${err instanceof Error ? err.message : String(err)}`, records);
    }

    if (!record || typeof record !== "object" || record.schemaVersion !== 1) {
      return quarantine(`Commit record ${file.name} has invalid schemaVersion`, records);
    }
    if (record.seq !== expectedSeq) {
      return quarantine(`Commit record ${file.name} seq mismatch: ${record.seq} !== ${expectedSeq}`, records);
    }
    if (record.prevRecordSha256 !== expectedPrevSha) {
      return quarantine(
        `Commit record ${file.name} broken prevRecordSha256 chain: expected ${expectedPrevSha}, found ${record.prevRecordSha256}`,
        records,
      );
    }
    if (!Number.isInteger(record.ownerEpoch) || record.ownerEpoch < 1) {
      return quarantine(`Commit record ${file.name} has invalid ownerEpoch`, records);
    }

    const artifactErr = verifyEvidenceRefs(ticketDir, record.evidenceRefs, expectedSeq);
    if (artifactErr !== null) {
      return quarantine(artifactErr, records);
    }

    const ev = record.event;
    if (ev === "brief_committed") {
      if (phase !== "drafted") {
        return quarantine(`Illegal brief_committed from phase ${phase} at seq=${expectedSeq}`, records);
      }
      if (!record.intent || typeof record.intent.briefSha256 !== "string") {
        return quarantine(`brief_committed missing briefSha256 at seq=${expectedSeq}`, records);
      }
      brief = record.intent;
      phase = "ready";
    } else if (ev === "launch_intent") {
      if (phase !== "ready" || openAttempt !== null) {
        return quarantine(`Illegal launch_intent from phase=${phase} openAttempt=${Boolean(openAttempt)} at seq=${expectedSeq}`, records);
      }
      if (
        typeof record.attemptId !== "string" ||
        !record.intent ||
        typeof record.intent.terminalName !== "string"
      ) {
        return quarantine(`Malformed launch_intent at seq=${expectedSeq}`, records);
      }
      counters = {
        attemptSeq: counters.attemptSeq + 1,
        totalAttemptsUsed: counters.totalAttemptsUsed + 1,
        fixRoundsUsed: counters.fixRoundsUsed,
      };
      openAttempt = {
        attemptId: record.attemptId,
        state: "intent",
        terminalName: record.intent.terminalName,
        prefix: record.intent.prefix,
        intent: record.intent,
        address: null,
        receipt: null,
        boundAddress: null,
      };
      phase = "building";
    } else if (ev === "launch_receipt") {
      if (phase !== "building" || openAttempt === null || openAttempt.state !== "intent") {
        return quarantine(`Illegal launch_receipt at seq=${expectedSeq}`, records);
      }
      if (record.attemptId !== openAttempt.attemptId || !record.receipt || typeof record.receipt.address !== "string") {
        return quarantine(`Malformed launch_receipt at seq=${expectedSeq}`, records);
      }
      openAttempt = {
        ...openAttempt,
        state: "delivered",
        address: record.receipt.address,
        receipt: record.receipt,
      };
      phase = "building";
    } else if (ev === "launch_failed_authoritative") {
      if (phase !== "building" || openAttempt === null || openAttempt.state !== "intent") {
        return quarantine(`Illegal launch_failed_authoritative at seq=${expectedSeq}`, records);
      }
      if (record.attemptId !== openAttempt.attemptId) {
        return quarantine(`attemptId mismatch on launch_failed_authoritative at seq=${expectedSeq}`, records);
      }
      settledAttempts.push({
        ...openAttempt,
        state: "settled",
        outcome: "not_delivered",
        receipt: record.receipt ?? null,
      });
      openAttempt = null;
      phase = "ready";
    } else if (ev === "capture_settled") {
      if (phase !== "building" || openAttempt === null || openAttempt.state !== "delivered") {
        return quarantine(`Illegal capture_settled at seq=${expectedSeq}`, records);
      }
      if (record.attemptId !== openAttempt.attemptId) {
        return quarantine(`attemptId mismatch on capture_settled at seq=${expectedSeq}`, records);
      }
      settledAttempts.push({
        ...openAttempt,
        state: "settled",
        outcome: "captured",
        captureReceipt: record.receipt ?? null,
        evidenceRefs: record.evidenceRefs,
      });
      openAttempt = null;
      phase = "gating";
    } else if (ev === "reconcile_unresolved") {
      if (
        openAttempt === null ||
        (openAttempt.state !== "intent" && openAttempt.state !== "delivered" && openAttempt.state !== "uncertain")
      ) {
        return quarantine(`Illegal reconcile_unresolved at seq=${expectedSeq}`, records);
      }
      if (record.attemptId !== openAttempt.attemptId) {
        return quarantine(`attemptId mismatch on reconcile_unresolved at seq=${expectedSeq}`, records);
      }
      openAttempt = {
        ...openAttempt,
        state: "uncertain",
        boundAddress: record.receipt?.boundAddress ?? openAttempt.boundAddress,
        reconcileReceipt: record.receipt ?? null,
      };
      phase = "escalated";
    } else if (ev === "capture_unusable") {
      if (phase !== "building" || openAttempt === null || openAttempt.state !== "delivered") {
        return quarantine(`Illegal capture_unusable at seq=${expectedSeq}`, records);
      }
      if (record.attemptId !== openAttempt.attemptId) {
        return quarantine(`attemptId mismatch on capture_unusable at seq=${expectedSeq}`, records);
      }
      openAttempt = {
        ...openAttempt,
        state: "uncertain",
        reconcileReceipt: record.receipt ?? null,
      };
      phase = "escalated";
    } else {
      return quarantine(`Unknown commit record event ${JSON.stringify(ev)} at seq=${expectedSeq}`, records);
    }

    if (
      !record.countersAfter ||
      record.countersAfter.attemptSeq !== counters.attemptSeq ||
      record.countersAfter.totalAttemptsUsed !== counters.totalAttemptsUsed ||
      record.countersAfter.fixRoundsUsed !== counters.fixRoundsUsed
    ) {
      return quarantine(`Counter mismatch at seq=${expectedSeq}`, records);
    }

    const expectedAttemptState = openAttempt ? openAttempt.state : null;
    if (
      !record.phaseAfter ||
      record.phaseAfter.phase !== phase ||
      record.phaseAfter.attemptState !== expectedAttemptState
    ) {
      return quarantine(
        `phaseAfter mismatch at seq=${expectedSeq}: expected (${phase}, ${expectedAttemptState}), got (${record.phaseAfter?.phase}, ${record.phaseAfter?.attemptState})`,
        records,
      );
    }

    expectedPrevSha = sha256Hex(rawBuf);
    records.push(record);
  }

  let recoveryAction;
  if (openAttempt !== null && openAttempt.state === "intent") {
    // Log ended after launch_intent with no confirming launch_receipt -> uncertain effect (section 4 & section 8).
    recoveryAction = "reconcile_uncertain_launch";
  } else if (openAttempt !== null && openAttempt.state === "delivered") {
    // Log has launch_receipt -> worker may have finished while controller was absent (section 8).
    recoveryAction = "reconcile_delivered_worker";
  } else if (openAttempt !== null && openAttempt.state === "uncertain") {
    recoveryAction = "already_escalated_uncertain";
  } else if (phase === "gating") {
    recoveryAction = "already_settled";
  } else {
    recoveryAction = "ready_to_launch";
  }

  return {
    status: "ok",
    phase,
    recoveryAction,
    brief,
    openAttempt,
    settledAttempts,
    counters,
    records,
    lastSeq: records.length,
    lastRecordSha256: expectedPrevSha,
  };
}
