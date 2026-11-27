import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const opts = {
    artifact: resolve(dirname(fileURLToPath(import.meta.url)), '../generated/attempt-budget.js'),
    expectNoNetwork: false,
    expectNoGdpWired: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifact') {
      if (i + 1 >= argv.length) throw new Error('--artifact requires a path');
      opts.artifact = resolve(argv[++i]);
    } else if (arg === '--expect-no-network') {
      opts.expectNoNetwork = true;
    } else if (arg === '--expect-no-gdp-wired') {
      opts.expectNoGdpWired = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function probeTcpUnreachable(host, port) {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveProbe({ reachable: false, errorCode: 'ETIMEDOUT' });
    }, 1500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe({ reachable: true, errorCode: null });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe({ reachable: false, errorCode: err.code ?? err.message });
    });
  });
}

async function verifyNoNetwork() {
  const ifaces = os.networkInterfaces();
  const nonInternal = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (!addr.internal) {
        nonInternal.push(`${name}:${addr.address}`);
      }
    }
  }
  assert.deepEqual(
    nonInternal,
    [],
    `Expected zero non-internal network interfaces, found: ${nonInternal.join(', ')}`,
  );

  // Prove an outbound TCP connection attempt fails immediately with no route.
  const tcpProbe = await probeTcpUnreachable('1.1.1.1', 443);
  assert.equal(
    tcpProbe.reachable,
    false,
    'Expected outbound TCP connection to 1.1.1.1:443 to fail when network is unavailable',
  );

  // Prove the npm registry HTTPS endpoint is also unreachable.
  let registryReachable = false;
  let registryError = null;
  try {
    await fetch('https://registry.npmjs.org/gdp-wired', {
      signal: AbortSignal.timeout(1500),
    });
    registryReachable = true;
  } catch (err) {
    registryError = err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
  }
  assert.equal(
    registryReachable,
    false,
    'Expected HTTPS fetch to registry.npmjs.org to fail when network is unavailable',
  );

  return {
    interfaceNames: Object.keys(ifaces),
    nonInternalCount: nonInternal.length,
    outboundTcpError: tcpProbe.errorCode,
    registryFetchError: registryError,
  };
}

async function verifyNoGdpWiredInstalled() {
  let resolved = false;
  let errorCode = null;
  try {
    await import('gdp-wired');
    resolved = true;
  } catch (err) {
    errorCode = err?.code ?? err?.message ?? String(err);
  }
  assert.equal(resolved, false, 'Expected gdp-wired not to be resolvable at runtime');
  assert.equal(
    errorCode,
    'ERR_MODULE_NOT_FOUND',
    `Expected ERR_MODULE_NOT_FOUND for gdp-wired, got: ${errorCode}`,
  );
  return { gdpWiredImportError: errorCode };
}

function runArtifactSuite(attemptBudget, EVENT_CODES) {
  const cases = [];

  // 1. Default caps (totalAttemptCap=12, fixRoundCap=3): build, double-open refusal, settle,
  //    3 fix rounds charging both counters, 4th fix refused while builds still allowed up to cap.
  const defaultParams = { initialTotalAttemptCap: 12, initialFixRoundCap: 3 };
  let st = attemptBudget.init(defaultParams);
  assert.deepEqual(st.scalars, {
    totalAttemptsUsed: 0,
    totalAttemptCap: 12,
    fixRoundsUsed: 0,
    fixRoundCap: 3,
    openAttempts: 0,
  });

  // Settle when nothing is open -> no-op
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.settle });
  assert.equal(st.scalars.openAttempts, 0);
  assert.equal(st.scalars.totalAttemptsUsed, 0);

  // Open build -> charges totalAttemptsUsed only
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_build });
  assert.deepEqual(st.scalars, {
    totalAttemptsUsed: 1,
    totalAttemptCap: 12,
    fixRoundsUsed: 0,
    fixRoundCap: 3,
    openAttempts: 1,
  });

  // Attempt to open fix while build is still open -> refused
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_fix });
  assert.deepEqual(st.scalars, {
    totalAttemptsUsed: 1,
    totalAttemptCap: 12,
    fixRoundsUsed: 0,
    fixRoundCap: 3,
    openAttempts: 1,
  });

  // Settle -> closes open attempt without changing counters
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.settle });
  assert.equal(st.scalars.openAttempts, 0);
  assert.equal(st.scalars.totalAttemptsUsed, 1);

  // 3 fix rounds -> each charges both counters
  for (let round = 1; round <= 3; round += 1) {
    st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_fix });
    assert.equal(st.scalars.totalAttemptsUsed, 1 + round);
    assert.equal(st.scalars.fixRoundsUsed, round);
    assert.equal(st.scalars.openAttempts, 1);
    st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.settle });
    assert.equal(st.scalars.openAttempts, 0);
  }

  // 4th fix round -> refused (fixRoundCap reached), counters stay at (4, 3)
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_fix });
  assert.equal(st.scalars.totalAttemptsUsed, 4);
  assert.equal(st.scalars.fixRoundsUsed, 3);
  assert.equal(st.scalars.openAttempts, 0);

  // Remaining 8 builds succeed, reaching totalAttemptsUsed === 12
  for (let i = 5; i <= 12; i += 1) {
    st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_build });
    assert.equal(st.scalars.totalAttemptsUsed, i);
    assert.equal(st.scalars.openAttempts, 1);
    st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.settle });
    assert.equal(st.scalars.openAttempts, 0);
  }

  // 13th build -> refused
  st = attemptBudget.step(defaultParams, st, { event: EVENT_CODES.open_build });
  assert.equal(st.scalars.totalAttemptsUsed, 12);
  assert.equal(st.scalars.fixRoundsUsed, 3);
  assert.equal(st.scalars.openAttempts, 0);
  cases.push('default-caps-12-3-lifecycle');

  // 2. Counterexample boundary (cap=0): both open_build and open_fix refused
  const zeroCapParams = { initialTotalAttemptCap: 0, initialFixRoundCap: 3 };
  let zst = attemptBudget.init(zeroCapParams);
  zst = attemptBudget.step(zeroCapParams, zst, { event: EVENT_CODES.open_fix });
  assert.equal(zst.scalars.totalAttemptsUsed, 0);
  assert.equal(zst.scalars.fixRoundsUsed, 0);
  assert.equal(zst.scalars.openAttempts, 0);
  zst = attemptBudget.step(zeroCapParams, zst, { event: EVENT_CODES.open_build });
  assert.equal(zst.scalars.totalAttemptsUsed, 0);
  assert.equal(zst.scalars.openAttempts, 0);
  cases.push('zero-total-cap-counterexample-boundary');

  // 3. Invalid inputs fail closed with RangeError
  assert.throws(
    () => attemptBudget.step(defaultParams, st, { event: 3 }),
    RangeError,
  );
  assert.throws(
    () => attemptBudget.step(defaultParams, st, { event: -1 }),
    RangeError,
  );
  assert.throws(
    () => attemptBudget.init({ initialTotalAttemptCap: -1, initialFixRoundCap: 3 }),
    RangeError,
  );
  assert.throws(
    () => attemptBudget.init({ initialTotalAttemptCap: Number.MAX_SAFE_INTEGER + 1, initialFixRoundCap: 0 }),
    RangeError,
  );
  cases.push('invalid-inputs-throw-RangeError');

  return { casesPassed: cases };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summary = {
    nodeVersion: process.version,
    expectNoNetwork: opts.expectNoNetwork,
    expectNoGdpWired: opts.expectNoGdpWired,
  };

  if (opts.expectNoNetwork) {
    summary.networkProof = await verifyNoNetwork();
  }
  if (opts.expectNoGdpWired) {
    summary.noInstallProof = await verifyNoGdpWiredInstalled();
  }

  const mod = await import(pathToFileURL(opts.artifact).href);
  assert.equal(typeof mod.attemptBudget?.init, 'function', 'compiled artifact missing init()');
  assert.equal(typeof mod.attemptBudget?.step, 'function', 'compiled artifact missing step()');
  assert.deepEqual(mod.EVENT_CODES, { open_build: 0, open_fix: 1, settle: 2 });

  summary.runtimeChecks = runArtifactSuite(mod.attemptBudget, mod.EVENT_CODES);
  summary.ok = true;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
