#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PROBES = path.dirname(HERE);
const P2_LEASE_SRC = path.join(REPO_PROBES, "p2", "lease.mjs");

const P5_FILES = [
  "capture.mjs",
  "fake-hc-runner.mjs",
  "fake-hc.mjs",
  "hc-boundary.mjs",
  "ledger.mjs",
  "p5.test.mjs",
  "tracer.mjs",
];

function replaceExact(filePath, target, replacement) {
  const original = fs.readFileSync(filePath, "utf8");
  const idx = original.indexOf(target);
  if (idx === -1) {
    throw new Error(`Mutation target not found in ${path.basename(filePath)}: ${target.slice(0, 80)}`);
  }
  if (original.indexOf(target, idx + 1) !== -1) {
    throw new Error(`Mutation target matched multiple locations in ${path.basename(filePath)}`);
  }
  const updated = original.slice(0, idx) + replacement + original.slice(idx + target.length);
  fs.writeFileSync(filePath, updated, "utf8");
}

function makeScratchCopy(label) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-p5-negctrl-${label}-`));
  const p2Dir = path.join(scratchRoot, "probes", "p2");
  const p5Dir = path.join(scratchRoot, "probes", "p5");
  fs.mkdirSync(p2Dir, { recursive: true });
  fs.mkdirSync(p5Dir, { recursive: true });

  fs.copyFileSync(P2_LEASE_SRC, path.join(p2Dir, "lease.mjs"));
  for (const name of P5_FILES) {
    const src = path.join(HERE, name);
    const dst = path.join(p5Dir, name);
    fs.copyFileSync(src, dst);
    const mode = fs.statSync(src).mode;
    fs.chmodSync(dst, mode);
  }
  return { scratchRoot, p5Dir };
}

const CONTROLS = [
  {
    id: "ctrl-2",
    check: "check-2",
    description: "omit --outlive-parent from hc.run launch flags",
    testNameFilter: "check-2:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--name", name];`,
        `const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", name];`,
      );
    },
    expectedErrorRe: /error: hc run argv must include --outlive-parent[\s\S]*Expected to contain:\s*"--outlive-parent"/,
  },
  {
    id: "ctrl-3",
    check: "check-3",
    description: "fall back to bare 'hc' on PATH when --hc-bin is omitted or non-explicit",
    testNameFilter: "check-3:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `export function validateHcBin(hcBin) {
  if (typeof hcBin !== "string" || hcBin.trim().length === 0) {
    throw new HcBoundaryError(
      "missing_hc_bin",
      "Explicit hc binary path is required; PATH lookup is forbidden",
    );
  }
  if (!hcBin.includes("/")) {
    throw new HcBoundaryError(
      "non_explicit_hc_bin",
      \`hc path must be an explicit file path containing '/' (got \${JSON.stringify(hcBin)}); PATH lookup is forbidden\`,
    );
  }`,
        `export function validateHcBin(hcBin) {
  if (typeof hcBin !== "string" || hcBin.trim().length === 0 || !hcBin.includes("/")) {
    return "hc";
  }`,
      );
    },
    expectedErrorRe: /error: PATH hc tripwire must never execute[\s\S]*Expected:\s*false[\s\S]*Received:\s*true/,
  },
  {
    id: "ctrl-4",
    check: "check-4",
    description: "accept captured output whenever hc read returns complete: true (skipping independent completeness check)",
    testNameFilter: "check-4:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "capture.mjs"),
        `  if (readResult.complete !== true) {
    return { ok: false, reason: \`hc_read_incomplete:\${readResult.why ?? "unknown"}\` };
  }

  // Independent framing check (does NOT trust readResult.complete === true).`,
        `  if (readResult.complete !== true) {
    return { ok: false, reason: \`hc_read_incomplete:\${readResult.why ?? "unknown"}\` };
  }
  return {
    ok: true,
    payloadText: readResult.text,
    sha256: sha256Hex(readResult.text),
    linesVerified: expectedLines,
    reportFileVerified: false,
  };

  // Independent framing check (does NOT trust readResult.complete === true).`,
      );
    },
    expectedErrorRe: /error: cropped complete:true read must fail capture verification[\s\S]*Expected:\s*3[\s\S]*Received:\s*0/,
  },
  {
    id: "ctrl-5",
    check: "check-5",
    description: "relaunch replacement worker when log ends in launch_intent and terminal is not found",
    testNameFilter: "check-5:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `    // Crash window: after launch_intent, before launch_receipt (section 8 row 2).
    if (folded.recoveryAction === "reconcile_uncertain_launch") {
      const reconciled = await reconcileUncertainLaunch({`,
        `    // Crash window: after launch_intent, before launch_receipt (section 8 row 2).
    if (folded.recoveryAction === "reconcile_uncertain_launch") {
      const lookupFirst = await safeReadbackLookup(hc, attempt.terminalName, hcTimeoutMs);
      if (!lookupFirst.ok && lookupFirst.notFound) {
        await hc.run({
          name: attempt.terminalName,
          cwd: attempt.intent.cwd,
          argv: ["sh", "-c", "echo replacement"],
          timeoutMs: hcTimeoutMs,
        });
        return {
          exitCode: 0,
          payload: {
            outcome: "relaunched",
            escalated: false,
            found: false,
          },
        };
      }
      const reconciled = await reconcileUncertainLaunch({`,
      );
    },
    expectedErrorRe: /error: launch_intent without receipt must settle uncertain, not relaunch[\s\S]*Expected:\s*"uncertain"[\s\S]*Received:\s*"relaunched"/,
  },
  {
    id: "ctrl-6a",
    check: "check-6",
    description: "allow forbidden --force flag through hc boundary",
    testNameFilter: "check-6:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `      if (token === "--force" || token.startsWith("--force=") || token === "-f") {
        throw new HcBoundaryError(
          "forbidden_flag",
          \`Flag \${JSON.stringify(token)} is forbidden on hc \${cmd}\`,
          { command: cmd, flag: token },
        );
      }`,
        `      if (token === "--force-disabled-for-ctrl") {
        throw new HcBoundaryError("forbidden_flag", "unreachable");
      }`,
      );
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `      if (token === "--json") {
        continue;
      }`,
        `      if (token === "--json" || token === "--force" || token.startsWith("--force=") || token === "-f") {
        continue;
      }`,
      );
    },
    expectedErrorRe: /error: expected refusal for --force on kill[\s\S]*Expected constructor:\s*\[class HcBoundaryError[\s\S]*Received value:\s*null/,
  },
  {
    id: "ctrl-6b",
    check: "check-6",
    description: "disable timeout kill on hung hc call",
    testNameFilter: "check-6:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;`,
        `      const timer = setTimeout(() => {
        return;
        if (settled) {
          return;
        }
        timedOut = true;`,
      );
    },
    expectedErrorRe: /error: hung hc call must be killed at timeout with HcBoundaryError[\s\S]*Expected constructor:\s*\[class HcBoundaryError[\s\S]*Received value:\s*null/,
  },
  {
    id: "ctrl-7a",
    check: "check-7",
    description: "cleanup removes unprefixed and near-miss terminals as well",
    testNameFilter: "check-7:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `      LOCAL_ADDRESS_RE.test(terminal.address) &&
      hasPrefix(terminal.name)
    ) {`,
        `      LOCAL_ADDRESS_RE.test(terminal.address)
    ) {`,
      );
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `      if (
        term &&
        hc.hasPrefix(term.name) &&
        typeof term.address === "string" &&
        !term.address.includes("/")
      ) {`,
        `      if (
        term &&
        typeof term.address === "string" &&
        !term.address.includes("/")
      ) {`,
      );
    },
    expectedErrorRe: /error: cleanup must skip unprefixed and near-miss terminals[\s\S]*Expected:\s*3[\s\S]*Received:\s*0/,
  },
  {
    id: "ctrl-7b",
    check: "check-7",
    description: "cleanup skips post-rm readback by address",
    testNameFilter: "check-7:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `      // Read each removed terminal back by address; expect exit 3 (not_found).
      const readback = await hc.get(addr, { timeoutMs: hcTimeoutMs });`,
        `      // Mutation: skip post-rm readback by address.
      const readback = { ok: false, notFound: true, exitCode: 3, errorKind: "not_found" };`,
      );
    },
    expectedErrorRe: /error: cleanup must run hc get by address after hc rm[\s\S]*Expected:\s*>\s*\d+[\s\S]*Received:\s*-1/,
  },
  {
    id: "ctrl-r3",
    check: "r3-holder-loss",
    description: "write recovery screen artifact outside lease.enqueue before lease check",
    testNameFilter: "r3-holder-loss:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `  // Every store write (screen artifact + commit record) runs inside lease.enqueue.
  const rec = await lease.enqueue({
    write: () => {
      const evidenceRefs = [];
      if (screenRead.ok) {
        const screenArtifact = writeArtifactOnce(ticketDir, screenRead.result.text);
        evidenceRefs.push({
          kind: "readback_screen",
          sha256: screenArtifact.sha256,
          bytes: screenArtifact.bytes,
          truncated: !screenRead.result.complete,
        });
      }`,
        `  // Mutation: write screen artifact outside lease.enqueue before lease re-check.
  const preEvidenceRefs = [];
  if (screenRead.ok) {
    const screenArtifact = writeArtifactOnce(ticketDir, screenRead.result.text);
    preEvidenceRefs.push({
      kind: "readback_screen",
      sha256: screenArtifact.sha256,
      bytes: screenArtifact.bytes,
      truncated: !screenRead.result.complete,
    });
  }
  const rec = await lease.enqueue({
    write: () => {
      const evidenceRefs = preEvidenceRefs;`,
      );
    },
    expectedErrorRe: /error: holder loss before enqueue must write zero new artifacts/,
  },
  {
    id: "ctrl-r4",
    check: "r4-replacement",
    description: "re-trust terminal name instead of verified address after wait and drop address check",
    testNameFilter: "r4-replacement:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `      // Fetch post-wait metadata by verifiedAddress (never re-trust the name after wait).
      const postLookup = await safeReadbackLookup(hc, verifiedAddress, hcTimeoutMs);
      if (!postLookup.ok || postLookup.terminal.address !== verifiedAddress) {`,
        `      // Mutation: re-fetch by name after wait and skip address comparison.
      const postLookup = await safeReadbackLookup(hc, attempt.terminalName, hcTimeoutMs);
      if (!postLookup.ok) {`,
      );
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `    // Read output by verifiedAddress (never by name after first verified lookup).
    let readRes;
    try {
      readRes = await hc.read(verifiedAddress, {`,
        `    // Mutation: read output by name instead of verifiedAddress.
    let readRes;
    try {
      readRes = await hc.read(attempt.terminalName, {`,
      );
    },
    expectedErrorRe: /error: replaced terminal under same name during wait must stay uncertain[\s\S]*Expected:\s*"uncertain"[\s\S]*Received:\s*"captured"/,
  },
  {
    id: "ctrl-r13-r14",
    check: "r13-r14-address-shapes",
    description: "set both address patterns back to digits only",
    testNameFilter: "r13-r15-letter-address:|r14-stderr-letter-address:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "hc-boundary.mjs"),
        `const LOCAL_ADDRESS_RE = /^t[0-9a-z]+$/;
const ANY_ADDRESS_TOKEN_RE = /(?:^|[^A-Za-z0-9._/-])(?:[a-z0-9._-]+\\/)?t[0-9][0-9a-z]*(?=$|[^A-Za-z0-9._/-])/;`,
        `const LOCAL_ADDRESS_RE = /^t[0-9]+$/;
const ANY_ADDRESS_TOKEN_RE = /(?:^|[^A-Za-z0-9._/-])(?:[a-z0-9._-]+\\/)?t[0-9]+(?=$|[^A-Za-z0-9._/-])/;`,
      );
    },
    expectedErrorRe:
      /error: letter-bearing address from validated run must not be refused[\s\S]*HcBoundaryError: hc get refused target "t1a"[\s\S]*code: "prefix_violation"[\s\S]*error: letter-bearing address in stderr message must settle uncertain[\s\S]*Expected:\s*"uncertain"[\s\S]*Received:\s*"not_delivered"/,
  },
];

let passed = 0;
let failed = 0;

console.log("Probe P5: runnable negative controls (scratch copies only)");

for (const ctrl of CONTROLS) {
  const { scratchRoot, p5Dir } = makeScratchCopy(ctrl.id);
  const t0 = performance.now();
  try {
    ctrl.mutate(p5Dir);
    const testPath = path.join(p5Dir, "p5.test.mjs");
    const res = spawnSync(
      process.execPath,
      ["test", "--test-name-pattern", ctrl.testNameFilter, testPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const elapsedMs = (performance.now() - t0).toFixed(1);

    const ranAtLeastOne = /Ran [1-9]\d* test/.test(combined);
    const failedNonZero = res.status !== 0 && res.status !== null;
    const matchedExpected = ctrl.expectedErrorRe.test(combined);

    if (ranAtLeastOne && failedNonZero && matchedExpected) {
      passed += 1;
      const excerptLines = combined
        .split("\n")
        .filter((l) => /error:|Expected:|Expected to contain:|Expected constructor:|Received:|Received value:/.test(l))
        .slice(0, 6)
        .map((l) => `    ${l.trim()}`)
        .join("\n");
      console.log(`PASS [${ctrl.id}] (${elapsedMs}ms) ${ctrl.check}: ${ctrl.description}`);
      console.log(`  exit=${res.status} pattern=${ctrl.expectedErrorRe}`);
      console.log(excerptLines);
    } else {
      failed += 1;
      console.error(`FAIL [${ctrl.id}] (${elapsedMs}ms) ${ctrl.check}: ${ctrl.description}`);
      console.error(`  exit=${res.status} ranAtLeastOne=${ranAtLeastOne} matchedExpected=${matchedExpected}`);
      console.error(combined);
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed (total ${CONTROLS.length})`);
process.exit(failed === 0 ? 0 : 1);
