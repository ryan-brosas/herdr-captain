import fs from "node:fs";
import { sha256Hex } from "./ledger.mjs";

export function formatBeginSentinel(attemptId, expectedLines) {
  return `P5-BEGIN attempt=${attemptId} lines=${expectedLines}`;
}

export function formatEndSentinel(attemptId, expectedLines) {
  return `P5-END attempt=${attemptId} lines=${expectedLines}`;
}

export function formatBodyLine(index, expectedLines) {
  return `p5 line ${index} of ${expectedLines}`;
}

export function buildExpectedPayload(attemptId, expectedLines) {
  const lines = [formatBeginSentinel(attemptId, expectedLines)];
  for (let i = 1; i <= expectedLines; i += 1) {
    lines.push(formatBodyLine(i, expectedLines));
  }
  lines.push(formatEndSentinel(attemptId, expectedLines));
  return `${lines.join("\n")}\n`;
}

function shellQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

export function buildStandInWorkerArgv({
  attemptId,
  expectedLines = 250,
  reportFile = null,
  gateFifo = null,
  delaySeconds = 0,
}) {
  if (!Number.isInteger(expectedLines) || expectedLines < 1) {
    throw new Error(`expectedLines must be a positive integer (got ${expectedLines})`);
  }

  const parts = ["set -eu"];
  if (typeof gateFifo === "string" && gateFifo.length > 0) {
    // Wait on a named FIFO so tests synchronize without sleep timers.
    parts.push(`IFS= read -r _p5_go < ${shellQuote(gateFifo)} || true`);
  }
  if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
    parts.push(`sleep ${delaySeconds}`);
  }

  const begin = formatBeginSentinel(attemptId, expectedLines);
  const end = formatEndSentinel(attemptId, expectedLines);

  if (typeof reportFile === "string" && reportFile.length > 0) {
    const tmpFile = `${reportFile}.tmp.$$`;
    parts.push(`tmp=${shellQuote(tmpFile)}`);
    parts.push(`{`);
    parts.push(`  printf '%s\\n' ${shellQuote(begin)}`);
    parts.push(`  i=1`);
    parts.push(`  while [ "$i" -le ${expectedLines} ]; do`);
    parts.push(`    printf 'p5 line %d of %d\\n' "$i" ${expectedLines}`);
    parts.push(`    i=$((i + 1))`);
    parts.push(`  done`);
    parts.push(`  printf '%s\\n' ${shellQuote(end)}`);
    parts.push(`} > "$tmp"`);
    parts.push(`mv "$tmp" ${shellQuote(reportFile)}`);
    parts.push(`cat ${shellQuote(reportFile)}`);
  } else {
    parts.push(`printf '%s\\n' ${shellQuote(begin)}`);
    parts.push(`i=1`);
    parts.push(`while [ "$i" -le ${expectedLines} ]; do`);
    parts.push(`  printf 'p5 line %d of %d\\n' "$i" ${expectedLines}`);
    parts.push(`  i=$((i + 1))`);
    parts.push(`done`);
    parts.push(`printf '%s\\n' ${shellQuote(end)}`);
  }

  return ["sh", "-c", parts.join("\n")];
}

function normalizeCapturedLines(rawText) {
  return String(rawText)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
}

/**
 * Independently verifies completeness of captured output from a finished worker.
 * Never accepts output solely because hc ReadResult.complete === true (P3 showed
 * a cropped read with too-small --lines still returns complete: true).
 */
export function verifyCapturedOutput({
  readResult,
  terminal,
  attemptId,
  expectedLines,
  reportFile = null,
}) {
  if (!terminal || typeof terminal !== "object") {
    return { ok: false, reason: "missing_terminal_metadata" };
  }
  if (terminal.keep === true) {
    return { ok: false, reason: "kept_shell_rejected" };
  }
  if (terminal.state !== "finished") {
    return { ok: false, reason: `worker_not_finished:${terminal.state}` };
  }
  if (terminal.exit_code !== 0 || terminal.signal !== null) {
    return {
      ok: false,
      reason: `worker_failed:exit=${terminal.exit_code},signal=${terminal.signal}`,
    };
  }
  if (terminal.screen !== "exact") {
    return { ok: false, reason: `screen_not_exact:${terminal.screen}` };
  }
  if (!readResult || typeof readResult !== "object" || typeof readResult.text !== "string") {
    return { ok: false, reason: "missing_read_result" };
  }
  if (readResult.complete !== true) {
    return { ok: false, reason: `hc_read_incomplete:${readResult.why ?? "unknown"}` };
  }

  // Independent framing check (does NOT trust readResult.complete === true).
  const lines = normalizeCapturedLines(readResult.text);
  const beginMarker = formatBeginSentinel(attemptId, expectedLines);
  const endMarker = formatEndSentinel(attemptId, expectedLines);

  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx === -1) {
    return {
      ok: false,
      reason: "missing_begin_sentinel",
      details: {
        expectedBegin: beginMarker,
        capturedLineCount: lines.filter((l) => l.length > 0).length,
        readCompleteClaimed: readResult.complete,
      },
    };
  }

  const endIdx = lines.indexOf(endMarker, beginIdx + 1);
  if (endIdx === -1) {
    return {
      ok: false,
      reason: "missing_end_sentinel",
      details: {
        expectedEnd: endMarker,
        capturedLineCount: lines.filter((l) => l.length > 0).length,
      },
    };
  }

  const bodyLines = lines.slice(beginIdx + 1, endIdx);
  if (bodyLines.length !== expectedLines) {
    return {
      ok: false,
      reason: "line_count_mismatch",
      details: { expectedLines, actualLines: bodyLines.length },
    };
  }

  for (let i = 0; i < expectedLines; i += 1) {
    const expectedLine = formatBodyLine(i + 1, expectedLines);
    if (bodyLines[i] !== expectedLine) {
      return {
        ok: false,
        reason: "body_line_mismatch",
        details: {
          lineNumber: i + 1,
          expected: expectedLine,
          actual: bodyLines[i],
        },
      };
    }
  }

  const payloadText = `${[beginMarker, ...bodyLines, endMarker].join("\n")}\n`;
  const payloadSha256 = sha256Hex(payloadText);

  let reportFileVerified = false;
  if (typeof reportFile === "string" && reportFile.length > 0) {
    let diskRaw;
    try {
      diskRaw = fs.readFileSync(reportFile, "utf8");
    } catch (err) {
      return {
        ok: false,
        reason: "report_file_missing",
        details: { reportFile, cause: err instanceof Error ? err.message : String(err) },
      };
    }
    const normalizedDisk = diskRaw.replace(/\r\n/g, "\n");
    const diskSha = sha256Hex(normalizedDisk);
    if (diskSha !== payloadSha256) {
      return {
        ok: false,
        reason: "report_file_digest_mismatch",
        details: { reportFile, capturedSha256: payloadSha256, diskSha256: diskSha },
      };
    }
    reportFileVerified = true;
  }

  return {
    ok: true,
    payloadText,
    sha256: payloadSha256,
    linesVerified: expectedLines,
    reportFileVerified,
  };
}
