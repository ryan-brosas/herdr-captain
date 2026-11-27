import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minimizeRun, proveSteps } from 'gdp-wired';
import { search } from 'gdp-wired/machine';
import {
  EVENT_NAMES,
  attemptBudgetBrokenLeqRule,
  attemptBudgetRule,
  makeAttemptBudgetLaws,
} from '../rules/attempt-budget.mjs';
import {
  PACKAGE_ROOT,
  readInstalledGdpWiredVersion,
  readPinnedGdpWiredVersion,
  sha256,
  verifyManifest,
} from './compile-kernel.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const COMPILE_SCRIPT = resolve(SCRIPT_DIR, 'compile-kernel.mjs');
const VERIFY_MANIFEST_SCRIPT = resolve(SCRIPT_DIR, 'verify-manifest.mjs');
const OFFLINE_SCRIPT = resolve(SCRIPT_DIR, 'run-compiled-offline.mjs');

function findLineNumber(filePath, matcher) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const idx = lines.findIndex((line) => (typeof matcher === 'string' ? line.includes(matcher) : matcher.test(line)));
  if (idx < 0) {
    throw new Error(`Pattern ${matcher} not found in ${filePath}`);
  }
  return { line: idx + 1, text: lines[idx].trim() };
}

function withScratchDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printSection(num, title) {
  console.log(`\n=== Check ${num}: ${title} ===`);
}

function check1ReproducibilityAndTamper() {
  printSection(1, 'Byte-identical double compile, manifest verification, and 1-byte tamper detection');
  const pinned = readPinnedGdpWiredVersion(PACKAGE_ROOT);
  const installed = readInstalledGdpWiredVersion(PACKAGE_ROOT);
  assert.equal(installed, pinned, `Expected gdp-wired@${pinned}, got ${installed}`);

  return withScratchDir('herdr-captain-p4-repro-', (scratch) => {
    const runADir = join(scratch, 'run-a');
    const runBDir = join(scratch, 'run-b');
    mkdirSync(runADir, { recursive: true });
    mkdirSync(runBDir, { recursive: true });

    const outA = JSON.parse(
      execFileSync(process.execPath, [COMPILE_SCRIPT, '--emit-dir', runADir], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      }),
    );
    const outB = JSON.parse(
      execFileSync(process.execPath, [COMPILE_SCRIPT, '--emit-dir', runBDir], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      }),
    );

    const comparedFiles = [
      'generated/raw-compilejs.txt',
      'generated/attempt-budget.js',
      'generated/attempt-budget.d.ts',
      'generated/manifest.json',
    ];
    for (const rel of comparedFiles) {
      const bufA = readFileSync(join(runADir, rel));
      const bufB = readFileSync(join(runBDir, rel));
      assert.equal(
        Buffer.compare(bufA, bufB),
        0,
        `Non-deterministic output detected in ${rel} across two independent compiles`,
      );
    }

    // Confirm committed artifacts in probes/p4/generated/ match the deterministic build byte for byte.
    const committedFiles = [
      'generated/attempt-budget.js',
      'generated/attempt-budget.d.ts',
      'generated/manifest.json',
    ];
    for (const rel of committedFiles) {
      const fresh = readFileSync(join(runADir, rel));
      const committed = readFileSync(resolve(PACKAGE_ROOT, rel));
      assert.equal(
        Buffer.compare(fresh, committed),
        0,
        `Committed ${rel} differs from fresh deterministic compile; run: node scripts/compile-kernel.mjs --write`,
      );
    }

    const verifiedManifest = verifyManifest(PACKAGE_ROOT);

    // Tamper test: flip exactly 1 byte inside the executable body of generated/attempt-budget.js.
    const tamperDir = join(scratch, 'tamper');
    mkdirSync(join(tamperDir, 'rules'), { recursive: true });
    mkdirSync(join(tamperDir, 'scripts'), { recursive: true });
    mkdirSync(join(tamperDir, 'generated'), { recursive: true });
    cpSync(resolve(PACKAGE_ROOT, 'package.json'), join(tamperDir, 'package.json'));
    cpSync(resolve(PACKAGE_ROOT, 'rules/attempt-budget.mjs'), join(tamperDir, 'rules/attempt-budget.mjs'));
    cpSync(resolve(PACKAGE_ROOT, 'scripts/compile-kernel.mjs'), join(tamperDir, 'scripts/compile-kernel.mjs'));
    cpSync(resolve(PACKAGE_ROOT, 'scripts/verify-manifest.mjs'), join(tamperDir, 'scripts/verify-manifest.mjs'));
    for (const rel of committedFiles) {
      cpSync(resolve(PACKAGE_ROOT, rel), join(tamperDir, rel));
    }

    const artifactPath = join(tamperDir, 'generated/attempt-budget.js');
    const originalBuf = readFileSync(artifactPath);
    const mutatedBuf = Buffer.from(originalBuf);
    const guardIdx = originalBuf.indexOf(Buffer.from('s["totalAttemptsUsed"] < s["totalAttemptCap"]'));
    assert.ok(guardIdx > 0, 'Expected totalAttemptsUsed < totalAttemptCap guard in artifact');
    const flipIndex = guardIdx + 's["totalAttemptsUsed"] '.length;
    assert.equal(mutatedBuf[flipIndex], '<'.charCodeAt(0));
    mutatedBuf[flipIndex] = '='.charCodeAt(0);
    let diffCount = 0;
    for (let i = 0; i < originalBuf.length; i += 1) {
      if (originalBuf[i] !== mutatedBuf[i]) diffCount += 1;
    }
    assert.equal(diffCount, 1, 'Tamper fixture must differ by exactly 1 byte');
    writeFileSync(artifactPath, mutatedBuf);

    const tamperCli = spawnSync(process.execPath, [VERIFY_MANIFEST_SCRIPT, tamperDir], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    });
    assert.notEqual(
      tamperCli.status,
      0,
      'Expected verify-manifest.mjs CLI to exit non-zero on 1-byte tampered artifact',
    );
    const tamperError = (tamperCli.stderr || tamperCli.stdout).trim();
    assert.ok(
      tamperError.includes('Artifact hash mismatch for generated/attempt-budget.js'),
      `Expected manifest check to detect 1-byte tamper, got: ${tamperError}`,
    );

    const summary = {
      prover: verifiedManifest.prover,
      compile1RawSha256: outA.rawCompileJsSha256,
      compile2RawSha256: outB.rawCompileJsSha256,
      byteIdentical: true,
      comparedFiles,
      emittedHelpers: verifiedManifest.emittedHelpers,
      prunedHelpers: verifiedManifest.prunedHelpers,
      manifestOutputs: verifiedManifest.outputs,
      oneByteTamperDetected: true,
      tamperByteOffset: flipIndex,
      tamperExitCode: tamperCli.status,
      tamperOriginalSha256: sha256(originalBuf),
      tamperMutatedSha256: sha256(mutatedBuf),
      tamperError,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  });
}

function check2ProofFromAnyState() {
  printSection(2, "Proof over every step from any state (from: 'any') and crossCheck");
  const { laws, stepLaws } = makeAttemptBudgetLaws(attemptBudgetRule);
  const verdict = proveSteps(attemptBudgetRule, laws, stepLaws, { from: 'any' });
  console.log('Full verdict object:');
  console.log(JSON.stringify(verdict, null, 2));

  assert.equal(verdict.proven, true, `Expected proven === true, got ${JSON.stringify(verdict)}`);
  assert.equal(verdict.checked, true, `Expected checked === true, got ${JSON.stringify(verdict)}`);
  assert.equal(
    verdict.assumes,
    undefined,
    `Expected no assumptions (assumes === undefined), got ${JSON.stringify(verdict.assumes)}`,
  );

  const cross = attemptBudgetRule.crossCheck(laws, stepLaws);
  console.log('crossCheck result:');
  console.log(JSON.stringify(cross, null, 2));
  assert.equal(cross.failure, undefined, `crossCheck failed: ${cross.failure}`);
  assert.ok(cross.checked > 0, `Expected crossCheck.checked > 0, got ${cross.checked}`);

  return { verdict, crossCheck: cross };
}

function check3BrokenVariantRefuted() {
  printSection(3, 'Broken <= variant refuted with concrete counterexample (sat, not timeout/unknown)');
  const { laws, stepLaws } = makeAttemptBudgetLaws(attemptBudgetBrokenLeqRule);
  const verdict = proveSteps(attemptBudgetBrokenLeqRule, laws, stepLaws, { from: 'any' });
  console.log('Broken variant verdict:');
  console.log(JSON.stringify(verdict, null, 2));

  assert.equal(verdict.proven, false, 'Broken <= variant must NOT be proven');
  assert.equal(verdict.checked, false, 'Broken <= variant must NOT be checked');
  assert.equal(
    verdict.stuck,
    'sat',
    `Broken <= variant must be refuted with stuck === "sat" (not timeout/unknown), got ${JSON.stringify(verdict.stuck)}`,
  );
  assert.ok(
    verdict.witness && typeof verdict.witness === 'object' && Object.keys(verdict.witness).length > 0,
    'Broken <= variant must return a concrete witness',
  );

  const searchCounterexample = search(attemptBudgetBrokenLeqRule.machine, laws[0]);
  assert.ok(
    searchCounterexample && Array.isArray(searchCounterexample.trace) && searchCounterexample.trace.length > 0,
    'Expected bounded search to return a concrete counterexample trace from the initial state',
  );

  const minimized = verdict.run
    ? minimizeRun(attemptBudgetBrokenLeqRule, laws[0], verdict.run)
    : searchCounterexample;

  // Replay the concrete counterexample on the broken interpreter to verify actual law violation.
  const brokenInterp = attemptBudgetBrokenLeqRule.interpreter();
  let brokenState = brokenInterp.init(minimized.params);
  for (const input of minimized.trace) {
    brokenState = brokenInterp.step(minimized.params, brokenState, input);
  }
  assert.ok(
    brokenState.scalars.totalAttemptsUsed > brokenState.scalars.totalAttemptCap,
    `Expected counterexample replay to violate totalAttemptsUsed <= totalAttemptCap; got ${JSON.stringify(brokenState.scalars)}`,
  );

  const concrete = {
    minimizedRun: {
      params: minimized.params,
      trace: minimized.trace.map((step) => ({
        ...step,
        eventName: EVENT_NAMES[step.event],
      })),
    },
    brokenReplayAfterScalars: brokenState.scalars,
    searchCounterexample: {
      params: searchCounterexample.params,
      trace: searchCounterexample.trace.map((step) => ({
        ...step,
        eventName: EVENT_NAMES[step.event],
      })),
    },
  };
  console.log('Concrete counterexample & broken-rule replay:');
  console.log(JSON.stringify(concrete, null, 2));

  return { verdict, minimized, searchCounterexample };
}

async function check4CompiledVsInterpreterEquivalence(brokenCheck) {
  printSection(4, 'Compiled artifact vs rule.interpreter() equivalence (counterexample + boundaries + exhaustive)');
  const artifactUrl = pathToFileURL(resolve(PACKAGE_ROOT, 'generated/attempt-budget.js')).href;
  const { attemptBudget: compiled, EVENT_CODES } = await import(artifactUrl);
  const interp = attemptBudgetRule.interpreter();

  let totalStepsCompared = 0;

  function assertTraceEquivalent(label, params, trace) {
    let stC = compiled.init(params);
    let stI = interp.init(params);
    assert.deepEqual(stC.scalars, stI.scalars, `[${label}] init scalars diverged`);

    for (let i = 0; i < trace.length; i += 1) {
      const input = trace[i];
      stC = compiled.step(params, stC, input);
      stI = interp.step(params, stI, input);
      assert.deepEqual(
        stC.scalars,
        stI.scalars,
        `[${label}] step ${i} (input=${JSON.stringify(input)}) diverged`,
      );
      // Good rule must also satisfy all laws at every concrete step.
      assert.ok(stC.scalars.totalAttemptsUsed <= stC.scalars.totalAttemptCap);
      assert.ok(stC.scalars.fixRoundsUsed <= stC.scalars.fixRoundCap);
      assert.ok(stC.scalars.openAttempts <= 1);
      totalStepsCompared += 1;
    }
    return stC.scalars;
  }

  // 1. Exact counterexample inputs from Check 3
  const ceFromVerdictFinal = assertTraceEquivalent(
    'counterexample-from-verdict',
    brokenCheck.minimized.params,
    brokenCheck.minimized.trace,
  );
  const ceFromSearchFinal = assertTraceEquivalent(
    'counterexample-from-search',
    brokenCheck.searchCounterexample.params,
    brokenCheck.searchCounterexample.trace,
  );

  // 2. Boundary scenarios
  const B = { event: EVENT_CODES.open_build };
  const F = { event: EVENT_CODES.open_fix };
  const S = { event: EVENT_CODES.settle };

  assertTraceEquivalent('zero-caps', { initialTotalAttemptCap: 0, initialFixRoundCap: 0 }, [B, F, S]);
  assertTraceEquivalent('cap-1-0', { initialTotalAttemptCap: 1, initialFixRoundCap: 0 }, [F, B, B, S, B, F]);
  assertTraceEquivalent('cap-1-1', { initialTotalAttemptCap: 1, initialFixRoundCap: 1 }, [F, F, S, B, F]);
  assertTraceEquivalent(
    'fix-cap-exceeds-total-cap',
    { initialTotalAttemptCap: 2, initialFixRoundCap: 5 },
    [F, S, F, S, F, B],
  );
  assertTraceEquivalent(
    'default-caps-12-3',
    { initialTotalAttemptCap: 12, initialFixRoundCap: 3 },
    [
      S, B, B, F, S,
      F, S, F, S, F, S,
      F, // 4th fix refused
      B, S, B, S, B, S, B, S, B, S, B, S, B, S, B, S,
      B, // 13th build refused
    ],
  );

  // 3. Reloaded arbitrary valid boundary states (testing from-any-state equivalence, including MAX_SAFE_INTEGER)
  let reloadedStatesCompared = 0;
  for (const totalCap of [0, 1, 2, 12, Number.MAX_SAFE_INTEGER]) {
    for (const fixCap of [0, 1, 3]) {
      const totalUsedSet = [...new Set([0, Math.max(0, totalCap - 1), totalCap])];
      const fixUsedSet = [...new Set([0, Math.max(0, fixCap - 1), fixCap])];
      for (const totalAttemptsUsed of totalUsedSet) {
        for (const fixRoundsUsed of fixUsedSet) {
          for (const openAttempts of [0, 1]) {
            const params = { initialTotalAttemptCap: totalCap, initialFixRoundCap: fixCap };
            const scalars = {
              totalAttemptsUsed,
              totalAttemptCap: totalCap,
              fixRoundsUsed,
              fixRoundCap: fixCap,
              openAttempts,
            };
            for (const event of [0, 1, 2]) {
              const stC = compiled.step(params, { scalars: { ...scalars }, maps: {} }, { event });
              const stI = interp.step(params, { scalars: { ...scalars }, maps: {} }, { event });
              assert.deepEqual(
                stC.scalars,
                stI.scalars,
                `Reloaded state ${JSON.stringify(scalars)} event=${event} diverged`,
              );
              reloadedStatesCompared += 1;
              totalStepsCompared += 1;
            }
          }
        }
      }
    }
  }

  // 4. Exhaustive small-domain sequences (lengths 1..4 across caps 0..3 x 0..3)
  let exhaustiveTraces = 0;
  function walkSequences(params, stC, stI, depth) {
    if (depth === 0) {
      exhaustiveTraces += 1;
      return;
    }
    for (const event of [0, 1, 2]) {
      const nextC = compiled.step(
        params,
        { scalars: { ...stC.scalars }, maps: {} },
        { event },
      );
      const nextI = interp.step(params, stI, { event });
      assert.deepEqual(nextC.scalars, nextI.scalars);
      totalStepsCompared += 1;
      walkSequences(params, nextC, nextI, depth - 1);
    }
  }
  for (let tCap = 0; tCap <= 3; tCap += 1) {
    for (let fCap = 0; fCap <= 3; fCap += 1) {
      const params = { initialTotalAttemptCap: tCap, initialFixRoundCap: fCap };
      walkSequences(params, compiled.init(params), interp.init(params), 4);
    }
  }

  // 5. Invalid inputs throw RangeError in BOTH compiled artifact and interpreter
  const validParams = { initialTotalAttemptCap: 2, initialFixRoundCap: 1 };
  const validState = compiled.init(validParams);
  const badParamCases = [
    { initialTotalAttemptCap: -1, initialFixRoundCap: 0 },
    { initialTotalAttemptCap: 1.5, initialFixRoundCap: 0 },
    { initialTotalAttemptCap: Number.MAX_SAFE_INTEGER + 1, initialFixRoundCap: 0 },
  ];
  for (const badParams of badParamCases) {
    assert.throws(() => compiled.init(badParams), RangeError);
    assert.throws(() => interp.init(badParams), RangeError);
  }
  const badInputCases = [{ event: -1 }, { event: 3 }, { event: 1.5 }];
  for (const badInput of badInputCases) {
    assert.throws(() => compiled.step(validParams, { scalars: { ...validState.scalars }, maps: {} }, badInput), RangeError);
    assert.throws(() => interp.step(validParams, validState, badInput), RangeError);
  }

  const summary = {
    equivalent: true,
    counterexampleVerdictInputFinal: ceFromVerdictFinal,
    counterexampleSearchInputFinal: ceFromSearchFinal,
    reloadedBoundaryTransitionsCompared: reloadedStatesCompared,
    exhaustiveDepth4Traces: exhaustiveTraces,
    totalStepsCompared,
    invalidInputRangeErrorsMatched: badParamCases.length + badInputCases.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function check5OfflineExecution() {
  printSection(5, 'Offline execution with network unavailable (unshare -rn) and zero runtime install');
  return withScratchDir('herdr-captain-p4-offline-', (scratch) => {
    const runtimeDir = join(scratch, 'runtime');
    const emptyHome = join(scratch, 'empty-home');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(emptyHome, { recursive: true });

    // Copy ONLY the compiled artifact and the zero-dependency verifier (no package.json, no node_modules).
    const copiedArtifact = join(runtimeDir, 'attempt-budget.js');
    const copiedRunner = join(runtimeDir, 'run-compiled-offline.mjs');
    cpSync(resolve(PACKAGE_ROOT, 'generated/attempt-budget.js'), copiedArtifact);
    cpSync(OFFLINE_SCRIPT, copiedRunner);

    const result = spawnSync(
      'unshare',
      [
        '-rn',
        process.execPath,
        copiedRunner,
        '--artifact',
        copiedArtifact,
        '--expect-no-network',
        '--expect-no-gdp-wired',
      ],
      {
        cwd: runtimeDir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: emptyHome,
          NODE_PATH: '',
          npm_config_cache: join(scratch, 'empty-npm-cache'),
        },
      },
    );

    if (result.error) {
      throw new Error(`Failed to spawn unshare -rn offline check: ${result.error.message}`);
    }
    assert.equal(
      result.status,
      0,
      `Offline check failed with exit ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.networkProof?.nonInternalCount, 0);
    assert.ok(parsed.networkProof?.outboundTcpError, 'Expected outbound TCP probe error');
    assert.ok(parsed.networkProof?.registryFetchError, 'Expected registry HTTPS fetch probe error');
    assert.equal(parsed.noInstallProof?.gdpWiredImportError, 'ERR_MODULE_NOT_FOUND');

    const summary = {
      isolationMethod:
        'Linux user+network namespace (`unshare -rn`, zero external interfaces, lo DOWN) + scratch dir `<scratch>/runtime` containing only `attempt-budget.js` and `run-compiled-offline.mjs` (no `package.json`, no `node_modules`, empty `HOME`)',
      exitCode: result.status,
      offlineOutput: parsed,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  });
}

function check6LicenceAudit() {
  printSection(6, 'Licence audit of gdp-wired and every emitted helper (files and line numbers)');
  const gdpRoot = resolve(PACKAGE_ROOT, 'node_modules/gdp-wired');
  const pkgPath = join(gdpRoot, 'package.json');
  const licensePath = join(gdpRoot, 'LICENSE');
  const readmePath = join(gdpRoot, 'README.md');
  const codegenPath = join(gdpRoot, 'dist/core/codegen.js');
  const machinePath = join(gdpRoot, 'dist/core/machine.js');
  const wordDivPath = join(gdpRoot, 'dist/kernel/word-division.js');
  const artifactPath = resolve(PACKAGE_ROOT, 'generated/attempt-budget.js');
  const noticesPath = resolve(PACKAGE_ROOT, 'THIRD_PARTY_NOTICES.md');

  const pkgLicense = findLineNumber(pkgPath, '"license": "MIT"');
  const pkgAuthor = findLineNumber(pkgPath, '"author":');
  const licenseTitle = findLineNumber(licensePath, /^MIT License$/);
  const licenseCopyright = findLineNumber(licensePath, /^Copyright \(c\)/);
  const licenseCondition = findLineNumber(
    licensePath,
    'The above copyright notice and this permission notice shall be included in all',
  );
  const readmeLicenseHeading = findLineNumber(readmePath, /^## License$/);
  const readmeLicenseValue = findLineNumber(readmePath, /^MIT$/);

  // Extract every helper declared in generated/attempt-budget.js before EVENT_CODES.
  const artifactText = readFileSync(artifactPath, 'utf8');
  const declaredHelpers = [...artifactText.matchAll(/^function (\$\w+)\(/gm)].map((m) => m[1]);
  assert.ok(declaredHelpers.length > 0, 'Expected at least one emitted helper in attempt-budget.js');
  assert.equal(
    artifactText.includes('$wordDivisionValue'),
    false,
    'Unused $wordDivisionValue helper should be pruned from generated/attempt-budget.js',
  );

  const scanForLicenceMentions = (filePath) =>
    readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => /\b(?:license|licence|copyright|spdx)\b/i.test(text));

  const codegenLicenceMatches = scanForLicenceMentions(codegenPath);
  const wordDivLicenceMatches = scanForLicenceMentions(wordDivPath);
  assert.equal(codegenLicenceMatches.length, 0, `Unexpected license header in codegen.js: ${JSON.stringify(codegenLicenceMatches)}`);
  assert.equal(wordDivLicenceMatches.length, 0, `Unexpected license header in word-division.js: ${JSON.stringify(wordDivLicenceMatches)}`);

  const helperSources = declaredHelpers.map((name) => {
    const loc = findLineNumber(codegenPath, `['${name}',`);
    return {
      helper: name,
      definedIn: `node_modules/gdp-wired/dist/core/codegen.js:${loc.line}`,
      separateLicenceHeaderMatches: codegenLicenceMatches.length,
    };
  });

  const wordDivEmit = findLineNumber(machinePath, 'const $wordDivisionValue =');
  const wordDivDef = findLineNumber(wordDivPath, 'export function wordDivisionValue(');

  // Verify THIRD_PARTY_NOTICES.md preserves the MIT copyright and permission notice.
  const noticesText = readFileSync(noticesPath, 'utf8');
  assert.ok(
    noticesText.includes(licenseCopyright.text),
    'probes/p4/THIRD_PARTY_NOTICES.md must include the MIT copyright line',
  );
  assert.ok(
    noticesText.includes('The above copyright notice and this permission notice shall be included in all'),
    'probes/p4/THIRD_PARTY_NOTICES.md must include the MIT permission notice',
  );

  const summary = {
    packageLicence: 'MIT',
    sources: {
      packageJsonLicense: `node_modules/gdp-wired/package.json:${pkgLicense.line} (${pkgLicense.text})`,
      packageJsonAuthor: `node_modules/gdp-wired/package.json:${pkgAuthor.line} (${pkgAuthor.text})`,
      licenseTitle: `node_modules/gdp-wired/LICENSE:${licenseTitle.line} (${licenseTitle.text})`,
      licenseCopyright: `node_modules/gdp-wired/LICENSE:${licenseCopyright.line} (${licenseCopyright.text})`,
      licenseCondition: `node_modules/gdp-wired/LICENSE:${licenseCondition.line}-${licenseCondition.line + 1}`,
      readmeLicense: `node_modules/gdp-wired/README.md:${readmeLicenseHeading.line}-${readmeLicenseValue.line}`,
      unconditionalCompileJsHelper: {
        helper: '$wordDivisionValue (pruned as unused in generated/attempt-budget.js)',
        emittedAt: `node_modules/gdp-wired/dist/core/machine.js:${wordDivEmit.line}`,
        definedAt: `node_modules/gdp-wired/dist/kernel/word-division.js:${wordDivDef.line}`,
      },
    },
    emittedHelpers: helperSources,
    thirdPartyNoticePreservedInProbe: true,
    publicRepoCompatibility:
      'Compatible under MIT License, provided the repository preserves the gdp-wired MIT copyright and permission notice (LICENSE:3,12-13) alongside shipped generated artifacts.',
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  console.log(`Probe P4 runner | node ${process.version} | gdp-wired ${readInstalledGdpWiredVersion(PACKAGE_ROOT)}`);
  check1ReproducibilityAndTamper();
  check2ProofFromAnyState();
  const brokenCheck = check3BrokenVariantRefuted();
  await check4CompiledVsInterpreterEquivalence(brokenCheck);
  check5OfflineExecution();
  check6LicenceAudit();
  console.log('\nALL PROBE P4 CHECKS PASSED (Checks 1-6).');
}

main().catch((err) => {
  console.error('\nPROBE P4 FAILED:');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
