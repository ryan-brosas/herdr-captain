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
    description: "omit --outlive-parent from tracer hc.run launch",
    pattern: "check-2:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `        const runRes = await hc.run({
          name: terminalName,
          cwd,
          argv: workerArgv,
          outliveParent: true,`,
        `        const runRes = await hc.run({
          name: terminalName,
          cwd,
          argv: workerArgv,
          outliveParent: false,`,
      );
    },
    expectedErrorRe: /--outlive-parent/,
  },
  {
    id: "ctrl-3",
    check: "check-3",
    description: "fall back to bare 'hc' on PATH when --hc-bin is omitted or non-explicit",
    pattern: "check-3:",
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
    expectedErrorRe: /(missing_hc_bin|hc-tripwire|Received:\s*true)/,
  },
  {
    id: "ctrl-4",
    check: "check-4",
    description: "accept captured output whenever hc read returns complete: true (skipping independent completeness check)",
    pattern: "check-4:",
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
    expectedErrorRe: /Expected:\s*3[\s\S]*Received:\s*0/,
  },
  {
    id: "ctrl-5",
    check: "check-5",
    description: "relaunch replacement worker when log ends in launch_intent and terminal is not found",
    pattern: "check-5:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `      if (!lookup.ok && lookup.notFound) {
        const rec = await lease.enqueue({`,
        `      if (!lookup.ok && lookup.notFound) {
        await hc.run({
          name: attempt.terminalName,
          cwd: attempt.intent.cwd,
          argv: ["sh", "-c", "echo replacement"],
          outliveParent: true,
          noParent: true,
          noNotify: true,
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
        const rec = await lease.enqueue({`,
      );
    },
    expectedErrorRe: /Expected:\s*"uncertain"[\s\S]*Received:\s*"relaunched"/,
  },
  {
    id: "ctrl-6a",
    check: "check-6",
    description: "allow forbidden --force flag through hc boundary",
    pattern: "check-6:",
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
    expectedErrorRe: /expected refusal for --force on kill/,
  },
  {
    id: "ctrl-6b",
    check: "check-6",
    description: "disable timeout kill on hung hc call",
    pattern: "check-6:",
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
    expectedErrorRe: /Expected constructor:\s*\[class HcBoundaryError[\s\S]*Received value:\s*null/,
  },
  {
    id: "ctrl-7a",
    check: "check-7",
    description: "cleanup removes unprefixed terminal as well",
    pattern: "check-7:",
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
        `    if (
      term &&
      typeof term.name === "string" &&
      term.name.startsWith(namespace) &&
      typeof term.address === "string" &&
      !term.address.includes("/")
    ) {`,
        `    if (
      term &&
      typeof term.address === "string" &&
      !term.address.includes("/")
    ) {`,
      );
    },
    expectedErrorRe: /Expected:\s*1[\s\S]*Received:\s*0/,
  },
  {
    id: "ctrl-7b",
    check: "check-7",
    description: "cleanup skips post-rm readback by address",
    pattern: "check-7:",
    mutate(p5Dir) {
      replaceExact(
        path.join(p5Dir, "tracer.mjs"),
        `    // Read each removed terminal back by address; expect exit 3 (not_found).
    const readback = await hc.get(addr, { timeoutMs: hcTimeoutMs });`,
        `    // Mutation: skip post-rm readback by address.
    const readback = { ok: false, notFound: true, exitCode: 3, error: { kind: "not_found" } };`,
      );
    },
    expectedErrorRe: /Expected:\s*>\s*\d+[\s\S]*Received:\s*-1/,
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
      ["test", "--test-name-pattern", ctrl.pattern, testPath],
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
        .filter((l) => /error:|Expected:|Expected constructor:|Received:|Received value:|\(fail\)|check-\d/.test(l))
        .slice(0, 8)
        .map((l) => `    ${l.trim()}`)
        .join("\n");
      console.log(`PASS [${ctrl.id}] (${elapsedMs}ms) ${ctrl.check}: ${ctrl.description}`);
      console.log(`  exit=${res.status}`);
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
