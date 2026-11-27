import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";
const FABRIC_PROVIDER_DISCOVER_EVENT = "pi-fabric:provider:discover:v1";
const FABRIC_PROVIDER_WITHDRAW_EVENT = "pi-fabric:provider:withdraw:v1";
const FABRIC_PROGRAM_RUN_EVENT = "pi-fabric:program:run:v1";

interface CliArgs {
  scratchDir: string;
  agentDir: string;
  cwd: string;
  label: string;
  expectedVersion: string;
  expectedPackagePath?: string;
}

interface ProgramRunReply {
  ok: boolean;
  program?: string;
  value?: unknown;
  logs?: string[];
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token ?? ""}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for flag ${token}`);
    }
    values.set(token.slice(2), next);
    i += 1;
  }

  const requireFlag = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw new Error(`Missing required flag --${name}`);
    }
    return value;
  };

  const expectedPackagePath = values.get("expected-package-path");
  return {
    scratchDir: requireFlag("scratch"),
    agentDir: requireFlag("agent-dir"),
    cwd: requireFlag("cwd"),
    label: values.get("label") ?? "default",
    expectedVersion: requireFlag("expected-version"),
    ...(expectedPackagePath !== undefined ? { expectedPackagePath } : {}),
  };
}

function findPiCodingAgentPackageDir(): string {
  const envOverride = process.env.PI_CODING_AGENT_PACKAGE_DIR;
  if (envOverride && existsSync(join(envOverride, "package.json"))) {
    return realpathSync(envOverride);
  }

  const walkToPackage = (startPath: string): string | undefined => {
    let dir = realpathSync(startPath);
    while (true) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
          if (parsed.name === "@earendil-works/pi-coding-agent") {
            return dir;
          }
        } catch {
          // Keep walking upwards if an intermediate file is unreadable.
        }
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  };

  try {
    const bunBinDir = execFileSync("bun", ["pm", "bin", "-g"], { encoding: "utf8" }).trim();
    const bunPi = join(bunBinDir, "pi");
    if (existsSync(bunPi)) {
      const found = walkToPackage(dirname(realpathSync(bunPi)));
      if (found) {
        return found;
      }
    }
  } catch {
    // Fall through to npm global root lookup.
  }

  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const candidate = join(npmRoot, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
  } catch {
    // Fall through to explicit failure.
  }

  throw new Error(
    "Could not locate @earendil-works/pi-coding-agent; set PI_CODING_AGENT_PACKAGE_DIR",
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertWithinScratch(targetPath: string, scratchDir: string, label: string): string {
  const resolvedScratch = realpathSync(scratchDir);
  const resolvedTarget = realpathSync(targetPath);
  const prefix = resolvedScratch.endsWith(sep) ? resolvedScratch : `${resolvedScratch}${sep}`;
  assert(
    resolvedTarget.startsWith(prefix),
    `${label} (${resolvedTarget}) is outside scratch (${resolvedScratch})`,
  );
  return resolvedTarget;
}

function runFabricProgram(
  eventBus: { emit(channel: string, data: unknown): void },
  code: string,
  timeoutMs = 30_000,
): Promise<ProgramRunReply> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for Fabric program reply`));
    }, timeoutMs);

    eventBus.emit(FABRIC_PROGRAM_RUN_EVENT, {
      code,
      reply(result: ProgramRunReply) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      },
    });
  });
}

async function verifyActiveFleet(
  eventBus: { emit(channel: string, data: unknown): void },
  expectedVersion: string,
  phase: string,
) {
  const statusProgram = `
    const providers = await tools.providers();
    const listed = await tools.list({ provider: "fleet" });
    const searched = await tools.search({ query: "fleet" });
    const described = await tools.describe({ ref: "fleet.status" });
    const directZeroArgs = await fleet.status();
    const directResult = await fleet.status({});
    const toolsCallResult = await tools.call({ ref: "fleet.status", args: {} });
    return { providers, listed, searched, described, directZeroArgs, directResult, toolsCallResult };
  `;
  const reply = await runFabricProgram(eventBus, statusProgram);
  assert(reply.ok, `${phase}: status program failed: ${reply.error ?? "unknown error"}`);

  const value = reply.value as {
    providers: Array<{ name?: string; description?: string }>;
    listed: Array<{ ref?: string; name?: string; provider?: string; risk?: string }>;
    searched: Array<{ ref?: string; name?: string; provider?: string; risk?: string }>;
    described: {
      ref?: string;
      name?: string;
      risk?: string;
      inputSchema?: { additionalProperties?: boolean };
    };
    directZeroArgs: { ok?: unknown; version?: unknown };
    directResult: { ok?: unknown; version?: unknown };
    toolsCallResult: { ok?: unknown; version?: unknown };
  };

  const fleetProviders = value.providers.filter((entry) => entry.name === "fleet");
  assert(
    fleetProviders.length === 1,
    `${phase}: expected exactly 1 fleet provider in tools.providers(), got ${fleetProviders.length}`,
  );
  assert(Array.isArray(value.listed), `${phase}: tools.list did not return an array`);
  assert(
    value.listed.length === 1,
    `${phase}: expected exactly 1 fleet action from tools.list, got ${value.listed.length}: ${JSON.stringify(value.listed)}`,
  );
  assert(
    value.listed[0]?.ref === "fleet.status",
    `${phase}: expected fleet.status in tools.list, got ${JSON.stringify(value.listed[0])}`,
  );
  assert(
    Array.isArray(value.searched) && value.searched.some((entry) => entry.ref === "fleet.status"),
    `${phase}: expected fleet.status in tools.search(query="fleet"), got ${JSON.stringify(value.searched)}`,
  );
  assert(
    value.described?.ref === "fleet.status" && value.described?.risk === "read",
    `${phase}: unexpected describe payload: ${JSON.stringify(value.described)}`,
  );
  assert(
    value.described?.inputSchema?.additionalProperties === false,
    `${phase}: expected closed inputSchema (additionalProperties: false)`,
  );
  assert(
    value.directZeroArgs?.ok === true && value.directZeroArgs?.version === expectedVersion,
    `${phase}: unexpected fleet.status() result: ${JSON.stringify(value.directZeroArgs)}`,
  );
  assert(
    value.directResult?.ok === true && value.directResult?.version === expectedVersion,
    `${phase}: unexpected fleet.status({}) result: ${JSON.stringify(value.directResult)}`,
  );
  assert(
    value.toolsCallResult?.ok === true && value.toolsCallResult?.version === expectedVersion,
    `${phase}: unexpected tools.call result: ${JSON.stringify(value.toolsCallResult)}`,
  );

  const rejectExtraArgProgram = `
    try {
      await tools.call({ ref: "fleet.status", args: { unexpected: true } });
      return { rejected: false };
    } catch (error) {
      return {
        rejected: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  `;
  const rejectReply = await runFabricProgram(eventBus, rejectExtraArgProgram);
  assert(
    rejectReply.ok,
    `${phase}: closed-schema check program failed: ${rejectReply.error ?? "unknown error"}`,
  );
  const rejectValue = rejectReply.value as { rejected?: boolean; error?: string };
  assert(
    rejectValue?.rejected === true,
    `${phase}: expected closed schema to reject unknown argument`,
  );

  return {
    providerCount: fleetProviders.length,
    listedRefs: value.listed.map((entry) => entry.ref),
    describedRisk: value.described.risk,
    directZeroArgs: value.directZeroArgs,
    directResult: value.directResult,
    toolsCallResult: value.toolsCallResult,
    closedSchemaError: rejectValue.error,
  };
}

async function verifyWithdrawnFleet(
  eventBus: { emit(channel: string, data: unknown): void },
  phase: string,
) {
  const withdrawnProgram = `
    const providers = await tools.providers();
    const querySearch = await tools.search({ query: "fleet" });
    let providerListError = null;
    let providerListResult = null;
    try {
      providerListResult = await tools.list({ provider: "fleet" });
    } catch (error) {
      providerListError = error instanceof Error ? error.message : String(error);
    }
    let toolsCallError = null;
    try {
      await tools.call({ ref: "fleet.status", args: {} });
    } catch (error) {
      toolsCallError = error instanceof Error ? error.message : String(error);
    }
    const fleetGlobalType = typeof (globalThis as Record<string, unknown>).fleet;
    return {
      providers,
      querySearch,
      providerListResult,
      providerListError,
      toolsCallError,
      fleetGlobalType,
    };
  `;

  const reply = await runFabricProgram(eventBus, withdrawnProgram);
  assert(reply.ok, `${phase}: withdrawal verification program failed: ${reply.error ?? "unknown error"}`);
  const value = reply.value as {
    providers: Array<{ name?: string }>;
    querySearch: Array<{ ref?: string }>;
    providerListResult: unknown;
    providerListError: string | null;
    toolsCallError: string | null;
    fleetGlobalType: string;
  };

  const remainingProviders = value.providers.filter((entry) => entry.name === "fleet");
  assert(
    remainingProviders.length === 0,
    `${phase}: fleet still present in tools.providers(): ${JSON.stringify(remainingProviders)}`,
  );
  const remainingFleetRefs = value.querySearch.filter((entry) => entry.ref?.startsWith("fleet."));
  assert(
    remainingFleetRefs.length === 0,
    `${phase}: fleet still present in tools.search(query="fleet"): ${JSON.stringify(remainingFleetRefs)}`,
  );
  assert(
    value.providerListError !== null ||
      (Array.isArray(value.providerListResult) && value.providerListResult.length === 0),
    `${phase}: expected tools.list(provider="fleet") to fail or return empty after withdrawal`,
  );
  assert(
    value.toolsCallError !== null,
    `${phase}: expected tools.call("fleet.status") to fail after withdrawal`,
  );
  assert(
    value.fleetGlobalType === "undefined",
    `${phase}: expected global fleet to be undefined after withdrawal, got ${value.fleetGlobalType}`,
  );

  return {
    remainingProviders: remainingProviders.length,
    remainingFleetRefs,
    providerListError: value.providerListError,
    toolsCallError: value.toolsCallError,
    fleetGlobalType: value.fleetGlobalType,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const piPackageDir = findPiCodingAgentPackageDir();
  const piModuleUrl = pathToFileURL(join(piPackageDir, "dist", "index.js")).href;
  const piSdk = (await import(piModuleUrl)) as {
    createAgentSession: (options: Record<string, unknown>) => Promise<{
      session: {
        bindExtensions(bindings: Record<string, unknown>): Promise<void>;
        reload(options?: Record<string, unknown>): Promise<void>;
        dispose(): void;
      };
      extensionsResult: {
        extensions: Array<{ path: string; resolvedPath: string }>;
        errors: Array<{ path: string; error: string }>;
        warnings?: Array<{ path: string; warning: string }>;
      };
    }>;
    createEventBus: () => {
      emit(channel: string, data: unknown): void;
      on(channel: string, handler: (data: unknown) => void): () => void;
    };
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload(): Promise<void>;
      getExtensions(): {
        extensions: Array<{ path: string; resolvedPath: string }>;
        errors: Array<{ path: string; error: string }>;
        warnings?: Array<{ path: string; warning: string }>;
      };
    };
    getAgentDir: () => string;
    SessionManager: { inMemory(cwd?: string): unknown };
    SettingsManager: { create(cwd?: string, agentDir?: string): unknown };
  };

  // Isolation assertion using Pi's own getAgentDir() before any session loads.
  const expectedAgentDir = assertWithinScratch(args.agentDir, args.scratchDir, "agentDir");
  const resolvedPiAgentDir = assertWithinScratch(piSdk.getAgentDir(), args.scratchDir, "Pi getAgentDir()");
  assert(
    resolvedPiAgentDir === expectedAgentDir,
    `Pi getAgentDir() (${resolvedPiAgentDir}) !== expected agentDir (${expectedAgentDir})`,
  );
  assert(!existsSync(join(resolvedPiAgentDir, "auth.json")), "Fixture agentDir must not have auth.json");

  const resolvedCwd = assertWithinScratch(args.cwd, args.scratchDir, "cwd");
  const piFabricPkgPath = join(resolvedPiAgentDir, "npm", "node_modules", "pi-fabric", "package.json");
  assert(existsSync(piFabricPkgPath), `pi-fabric is not installed in fixture at ${piFabricPkgPath}`);
  const piFabricPkg = JSON.parse(readFileSync(piFabricPkgPath, "utf8")) as { version?: string };
  assert(
    piFabricPkg.version === "0.140.1",
    `Expected pi-fabric 0.140.1 in fixture, got ${String(piFabricPkg.version)}`,
  );

  // Passive observers on the real Pi event bus (no mocking or stubbing).
  const eventBus = piSdk.createEventBus();
  const counters = {
    fleetRegisterEvents: 0,
    discoverEventsEmitted: 0,
    fleetDiscoverResponses: 0,
    fleetWithdrawEvents: 0,
  };
  const resetCounters = () => {
    counters.fleetRegisterEvents = 0;
    counters.discoverEventsEmitted = 0;
    counters.fleetDiscoverResponses = 0;
    counters.fleetWithdrawEvents = 0;
  };

  eventBus.on(FABRIC_PROVIDER_REGISTER_EVENT, (payload: unknown) => {
    const provider = (payload as { provider?: { name?: unknown } } | null)?.provider;
    if (provider?.name === "fleet") {
      counters.fleetRegisterEvents += 1;
    }
  });
  eventBus.on(FABRIC_PROVIDER_DISCOVER_EVENT, (payload: unknown) => {
    const discovery = payload as {
      version?: unknown;
      register?: (provider: { name?: unknown }, options?: unknown) => void;
    } | null;
    if (!discovery || discovery.version !== 1 || typeof discovery.register !== "function") {
      return;
    }
    counters.discoverEventsEmitted += 1;
    const originalRegister = discovery.register.bind(discovery);
    discovery.register = (provider, options) => {
      if (provider?.name === "fleet") {
        counters.fleetDiscoverResponses += 1;
      }
      originalRegister(provider, options);
    };
  });
  eventBus.on(FABRIC_PROVIDER_WITHDRAW_EVENT, (payload: unknown) => {
    const name = (payload as { name?: unknown } | null)?.name;
    if (name === "fleet") {
      counters.fleetWithdrawEvents += 1;
    }
  });

  const settingsManager = piSdk.SettingsManager.create(resolvedCwd, resolvedPiAgentDir);
  const resourceLoader = new piSdk.DefaultResourceLoader({
    cwd: resolvedCwd,
    agentDir: resolvedPiAgentDir,
    settingsManager,
    eventBus,
  });
  await resourceLoader.reload();

  const initialExtensions = resourceLoader.getExtensions();
  assert(
    initialExtensions.errors.length === 0,
    `Extension load errors: ${JSON.stringify(initialExtensions.errors)}`,
  );
  assert(
    (initialExtensions.warnings ?? []).length === 0,
    `Extension load warnings: ${JSON.stringify(initialExtensions.warnings)}`,
  );

  const loadedPaths = initialExtensions.extensions.map((ext) => realpathSync(ext.resolvedPath));
  const hasPiFabric = loadedPaths.some((p) => p.startsWith(join(resolvedPiAgentDir, "npm", "node_modules", "pi-fabric")));
  assert(hasPiFabric, `pi-fabric extension did not load from fixture: ${JSON.stringify(loadedPaths)}`);
  if (args.expectedPackagePath) {
    const expectedRoot = realpathSync(resolve(args.expectedPackagePath));
    const hasCaptain = loadedPaths.some((p) => p === join(expectedRoot, "src", "index.ts"));
    assert(
      hasCaptain,
      `herdr-captain extension did not load from expected path ${expectedRoot}: ${JSON.stringify(loadedPaths)}`,
    );
  }

  const { session } = await piSdk.createAgentSession({
    cwd: resolvedCwd,
    agentDir: resolvedPiAgentDir,
    resourceLoader,
    settingsManager,
    sessionManager: piSdk.SessionManager.inMemory(resolvedCwd),
  });

  try {
    await session.bindExtensions({});

    // Phase 1: Startup registration, discovery, status invocation, closed schema.
    const startupProof = await verifyActiveFleet(eventBus, args.expectedVersion, "startup");
    const startupCounts = { ...counters };
    assert(
      startupCounts.discoverEventsEmitted === 1,
      `startup: expected 1 discovery event from pi-fabric, got ${startupCounts.discoverEventsEmitted}`,
    );
    assert(
      startupCounts.fleetDiscoverResponses === 1,
      `startup: expected 1 fleet discovery response, got ${startupCounts.fleetDiscoverResponses}`,
    );

    // Phase 2: Real Pi reload #1 (same AgentSession.reload() called by /reload).
    resetCounters();
    await session.reload();
    const reload1LifecycleCounts = { ...counters };
    assert(
      reload1LifecycleCounts.fleetWithdrawEvents === 1,
      `reload1: expected 1 fleet withdraw event on session_shutdown, got ${reload1LifecycleCounts.fleetWithdrawEvents}`,
    );
    const reload1Proof = await verifyActiveFleet(eventBus, args.expectedVersion, "reload1");
    const reload1DiscoverCounts = {
      discoverEventsEmitted: counters.discoverEventsEmitted,
      fleetDiscoverResponses: counters.fleetDiscoverResponses,
    };
    assert(
      reload1DiscoverCounts.discoverEventsEmitted === 1,
      `reload1: expected 1 discovery event, got ${reload1DiscoverCounts.discoverEventsEmitted}`,
    );
    assert(
      reload1DiscoverCounts.fleetDiscoverResponses === 1,
      `reload1: expected exactly 1 fleet discovery response (no duplicate handlers), got ${reload1DiscoverCounts.fleetDiscoverResponses}`,
    );

    // Phase 3: Real Pi reload #2 (confirm repeated reloads do not accumulate handlers).
    resetCounters();
    await session.reload();
    const reload2LifecycleCounts = { ...counters };
    assert(
      reload2LifecycleCounts.fleetWithdrawEvents === 1,
      `reload2: expected 1 fleet withdraw event on session_shutdown, got ${reload2LifecycleCounts.fleetWithdrawEvents}`,
    );
    const reload2Proof = await verifyActiveFleet(eventBus, args.expectedVersion, "reload2");
    const reload2DiscoverCounts = {
      discoverEventsEmitted: counters.discoverEventsEmitted,
      fleetDiscoverResponses: counters.fleetDiscoverResponses,
    };
    assert(
      reload2DiscoverCounts.discoverEventsEmitted === 1,
      `reload2: expected 1 discovery event, got ${reload2DiscoverCounts.discoverEventsEmitted}`,
    );
    assert(
      reload2DiscoverCounts.fleetDiscoverResponses === 1,
      `reload2: expected exactly 1 fleet discovery response (no duplicate handlers), got ${reload2DiscoverCounts.fleetDiscoverResponses}`,
    );

    // Phase 4: Direct withdrawal while Fabric runtime is active.
    resetCounters();
    eventBus.emit(FABRIC_PROVIDER_WITHDRAW_EVENT, { name: "fleet" });
    const withdrawProof = await verifyWithdrawnFleet(eventBus, "withdraw");

    // Verify a post-withdrawal reload cleanly restores exactly one registration.
    resetCounters();
    await session.reload();
    const postWithdrawReloadProof = await verifyActiveFleet(
      eventBus,
      args.expectedVersion,
      "post-withdraw-reload",
    );
    const postWithdrawDiscoverResponses = counters.fleetDiscoverResponses;
    assert(
      postWithdrawDiscoverResponses === 1,
      `post-withdraw-reload: expected 1 fleet discovery response, got ${postWithdrawDiscoverResponses}`,
    );

    // Phase 5: Unload herdr-captain from settings.json and reload.
    // Proves session_shutdown withdraws "fleet" and leaves zero stale discovery handlers.
    const settingsPath = join(resolvedPiAgentDir, "settings.json");
    const originalSettingsRaw = readFileSync(settingsPath, "utf8");
    let unloadReloadProof: Awaited<ReturnType<typeof verifyWithdrawnFleet>>;
    let unloadLifecycleWithdraws = 0;
    let unloadDiscoverResponses = -1;
    try {
      const parsedSettings = JSON.parse(originalSettingsRaw) as { packages?: unknown[] };
      const keptPackages = (parsedSettings.packages ?? []).filter((entry) => {
        const source = typeof entry === "string" ? entry : (entry as { source?: string }).source;
        return typeof source === "string" && source.includes("pi-fabric");
      });
      assert(
        keptPackages.length === 1,
        `unload: expected 1 pi-fabric package left after removing herdr-captain, got ${keptPackages.length}`,
      );
      writeFileSync(
        settingsPath,
        `${JSON.stringify({ ...parsedSettings, packages: keptPackages }, null, 2)}\n`,
        "utf8",
      );

      resetCounters();
      await session.reload();
      unloadLifecycleWithdraws = counters.fleetWithdrawEvents;
      assert(
        unloadLifecycleWithdraws === 1,
        `unload: expected 1 fleet withdraw event during session_shutdown, got ${unloadLifecycleWithdraws}`,
      );
      unloadReloadProof = await verifyWithdrawnFleet(eventBus, "unload-reload");
      unloadDiscoverResponses = counters.fleetDiscoverResponses;
      assert(
        counters.discoverEventsEmitted === 1,
        `unload: expected pi-fabric to emit 1 discovery event, got ${counters.discoverEventsEmitted}`,
      );
      assert(
        unloadDiscoverResponses === 0,
        `unload: expected 0 fleet discovery responses after unload, got ${unloadDiscoverResponses}`,
      );
    } finally {
      writeFileSync(settingsPath, originalSettingsRaw, "utf8");
    }

    const summary = {
      label: args.label,
      piFabricVersion: piFabricPkg.version,
      loadedExtensionCount: loadedPaths.length,
      extensionOrder: loadedPaths.map((p) =>
        p.includes(`${sep}pi-fabric${sep}`) ? "pi-fabric" : p.endsWith(`${sep}src${sep}index.ts`) ? "herdr-captain" : "other",
      ),
      startup: { counts: startupCounts, ...startupProof },
      reload1: {
        withdrawEventsOnReload: reload1LifecycleCounts.fleetWithdrawEvents,
        discoverCounts: reload1DiscoverCounts,
        ...reload1Proof,
      },
      reload2: {
        withdrawEventsOnReload: reload2LifecycleCounts.fleetWithdrawEvents,
        discoverCounts: reload2DiscoverCounts,
        ...reload2Proof,
      },
      withdraw: withdrawProof,
      postWithdrawReload: {
        discoverResponses: postWithdrawDiscoverResponses,
        directResult: postWithdrawReloadProof.directResult,
      },
      unloadReload: {
        withdrawEventsOnUnload: unloadLifecycleWithdraws,
        discoverResponsesAfterUnload: unloadDiscoverResponses,
        ...unloadReloadProof,
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    session.dispose();
  }
}

await main();
