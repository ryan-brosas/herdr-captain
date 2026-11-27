import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_ENV_KEYS = new Set([
  "BUN_INSTALL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_SKIP_VERSION_CHECK",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

interface CliArgs {
  scratchDir: string;
  agentDir: string;
  cwd: string;
  label: string;
  expectedVersion: string;
  expectedPackagePath: string;
  piPackageDir?: string;
}

interface FabricProtocolModule {
  FABRIC_PROVIDER_REGISTER_EVENT?: unknown;
  FABRIC_PROVIDER_DISCOVER_EVENT?: unknown;
  FABRIC_PROVIDER_WITHDRAW_EVENT?: unknown;
  FABRIC_PROGRAM_RUN_EVENT?: unknown;
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

  const piPackageDir = values.get("pi-package-dir");
  return {
    scratchDir: requireFlag("scratch"),
    agentDir: requireFlag("agent-dir"),
    cwd: requireFlag("cwd"),
    label: values.get("label") ?? "default",
    expectedVersion: requireFlag("expected-version"),
    expectedPackagePath: requireFlag("expected-package-path"),
    ...(piPackageDir !== undefined ? { piPackageDir } : {}),
  };
}

function findPiCodingAgentPackageDir(explicitDir?: string): string {
  if (explicitDir && existsSync(join(explicitDir, "package.json"))) {
    return realpathSync(explicitDir);
  }
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
    const bunBinDir = execFileSync("bun", ["--no-env-file", "pm", "bin", "-g"], { encoding: "utf8" }).trim();
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
  programRunEvent: string,
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

    eventBus.emit(programRunEvent, {
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
  programRunEvent: string,
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
  const reply = await runFabricProgram(eventBus, programRunEvent, statusProgram);
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
  const rejectReply = await runFabricProgram(eventBus, programRunEvent, rejectExtraArgProgram);
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
  programRunEvent: string,
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

  const reply = await runFabricProgram(eventBus, programRunEvent, withdrawnProgram);
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

  // Verify process environment allowlist and scratch HOME before loading Pi or pi-fabric.
  const initialEnvKeys = Object.keys(process.env).sort();
  const unexpectedEnvKeys = initialEnvKeys.filter((key) => !ALLOWED_ENV_KEYS.has(key));
  assert(
    unexpectedEnvKeys.length === 0,
    `Unexpected inherited environment variables in fixture: ${unexpectedEnvKeys.join(", ")}`,
  );
  const resolvedHome = assertWithinScratch(homedir(), args.scratchDir, "os.homedir()");
  assert(
    typeof process.env.HOME === "string" && realpathSync(process.env.HOME) === resolvedHome,
    `process.env.HOME (${String(process.env.HOME)}) !== os.homedir() (${resolvedHome})`,
  );
  assertWithinScratch(process.cwd(), args.scratchDir, "process.cwd()");

  const piPackageDir = findPiCodingAgentPackageDir(args.piPackageDir);
  const piModuleUrl = pathToFileURL(join(piPackageDir, "dist", "index.js")).href;
  const piSdk = (await import(piModuleUrl)) as {
    createAgentSession: (options: Record<string, unknown>) => Promise<{
      session: {
        model?: { provider?: string; id?: string };
        modelRuntime: {
          getAvailableSnapshot(): unknown[];
          getProviders(): Array<{ id: string }>;
          hasConfiguredAuth(providerId: string): boolean;
          checkAuth(providerId: string): Promise<unknown>;
        };
        bindExtensions(bindings: Record<string, unknown>): Promise<void>;
        reload(options?: Record<string, unknown>): Promise<void>;
        dispose(): void;
      };
      extensionsResult: {
        extensions: Array<{ path: string; resolvedPath: string }>;
        errors: Array<{ path: string; error: string }>;
        warnings?: Array<{ path: string; warning: string }>;
      };
      modelFallbackMessage?: string;
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
  const piFabricDir = join(resolvedPiAgentDir, "npm", "node_modules", "pi-fabric");
  const piFabricPkgPath = join(piFabricDir, "package.json");
  assert(existsSync(piFabricPkgPath), `pi-fabric is not installed in fixture at ${piFabricPkgPath}`);
  const piFabricPkg = JSON.parse(readFileSync(piFabricPkgPath, "utf8")) as {
    version?: string;
    exports?: Record<string, { import?: string } | string>;
  };
  assert(
    piFabricPkg.version === "0.140.1",
    `Expected pi-fabric 0.140.1 in fixture, got ${String(piFabricPkg.version)}`,
  );

  // Verify the three event channel literals in src/index.ts match installed pi-fabric's protocol export.
  const protocolExport = piFabricPkg.exports?.["./protocol"];
  const protocolRelPath =
    typeof protocolExport === "string"
      ? protocolExport
      : typeof protocolExport === "object" && protocolExport !== null
        ? protocolExport.import
        : undefined;
  assert(
    typeof protocolRelPath === "string" && protocolRelPath.length > 0,
    "Installed pi-fabric package.json is missing ./protocol import export",
  );
  const fabricProtocolPath = realpathSync(resolve(piFabricDir, protocolRelPath));
  const fabricProtocol = (await import(pathToFileURL(fabricProtocolPath).href)) as FabricProtocolModule;

  const expectedRoot = realpathSync(resolve(args.expectedPackagePath));
  const captainEntryPath = join(expectedRoot, "src", "index.ts");
  assert(existsSync(captainEntryPath), `herdr-captain entry not found at ${captainEntryPath}`);
  const captainModule = (await import(pathToFileURL(captainEntryPath).href)) as FabricProtocolModule;

  const requireEventString = (value: unknown, label: string): string => {
    assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
    return value;
  };
  const fabricRegisterEvent = requireEventString(
    fabricProtocol.FABRIC_PROVIDER_REGISTER_EVENT,
    "pi-fabric FABRIC_PROVIDER_REGISTER_EVENT",
  );
  const fabricDiscoverEvent = requireEventString(
    fabricProtocol.FABRIC_PROVIDER_DISCOVER_EVENT,
    "pi-fabric FABRIC_PROVIDER_DISCOVER_EVENT",
  );
  const fabricWithdrawEvent = requireEventString(
    fabricProtocol.FABRIC_PROVIDER_WITHDRAW_EVENT,
    "pi-fabric FABRIC_PROVIDER_WITHDRAW_EVENT",
  );
  const fabricProgramRunEvent = requireEventString(
    fabricProtocol.FABRIC_PROGRAM_RUN_EVENT,
    "pi-fabric FABRIC_PROGRAM_RUN_EVENT",
  );

  assert(
    captainModule.FABRIC_PROVIDER_REGISTER_EVENT === fabricRegisterEvent,
    `FABRIC_PROVIDER_REGISTER_EVENT drift: src/index.ts=${String(captainModule.FABRIC_PROVIDER_REGISTER_EVENT)} vs pi-fabric=${fabricRegisterEvent}`,
  );
  assert(
    captainModule.FABRIC_PROVIDER_DISCOVER_EVENT === fabricDiscoverEvent,
    `FABRIC_PROVIDER_DISCOVER_EVENT drift: src/index.ts=${String(captainModule.FABRIC_PROVIDER_DISCOVER_EVENT)} vs pi-fabric=${fabricDiscoverEvent}`,
  );
  assert(
    captainModule.FABRIC_PROVIDER_WITHDRAW_EVENT === fabricWithdrawEvent,
    `FABRIC_PROVIDER_WITHDRAW_EVENT drift: src/index.ts=${String(captainModule.FABRIC_PROVIDER_WITHDRAW_EVENT)} vs pi-fabric=${fabricWithdrawEvent}`,
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

  eventBus.on(fabricRegisterEvent, (payload: unknown) => {
    const provider = (payload as { provider?: { name?: unknown } } | null)?.provider;
    if (provider?.name === "fleet") {
      counters.fleetRegisterEvents += 1;
    }
  });
  eventBus.on(fabricDiscoverEvent, (payload: unknown) => {
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
  eventBus.on(fabricWithdrawEvent, (payload: unknown) => {
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
  const hasPiFabric = loadedPaths.some((p) => p.startsWith(piFabricDir));
  assert(hasPiFabric, `pi-fabric extension did not load from fixture: ${JSON.stringify(loadedPaths)}`);
  const hasCaptain = loadedPaths.some((p) => p === captainEntryPath);
  assert(
    hasCaptain,
    `herdr-captain extension did not load from expected path ${expectedRoot}: ${JSON.stringify(loadedPaths)}`,
  );

  const { session, modelFallbackMessage } = await piSdk.createAgentSession({
    cwd: resolvedCwd,
    agentDir: resolvedPiAgentDir,
    resourceLoader,
    settingsManager,
    sessionManager: piSdk.SessionManager.inMemory(resolvedCwd),
  });

  try {
    // Prove Pi's ModelRuntime sees zero credentials and zero available models.
    const availableModels = session.modelRuntime.getAvailableSnapshot();
    assert(
      availableModels.length === 0,
      `Fixture ModelRuntime unexpectedly saw ${availableModels.length} available model(s)`,
    );
    const runtimeProviders = session.modelRuntime.getProviders();
    assert(runtimeProviders.length > 0, "Expected Pi ModelRuntime to expose builtin providers for auth audit");
    const configuredAuthProviders: string[] = [];
    for (const provider of runtimeProviders) {
      if (session.modelRuntime.hasConfiguredAuth(provider.id)) {
        configuredAuthProviders.push(provider.id);
        continue;
      }
      const checked = await session.modelRuntime.checkAuth(provider.id);
      if (checked !== undefined) {
        configuredAuthProviders.push(provider.id);
      }
    }
    assert(
      configuredAuthProviders.length === 0,
      `Fixture ModelRuntime unexpectedly detected auth for provider(s): ${configuredAuthProviders.join(", ")}`,
    );
    // When findInitialModel returns undefined, pi-agent-core fills Agent.state.model
    // with its sentinel DEFAULT_MODEL ({ provider: "unknown", id: "unknown" }) and
    // createAgentSession sets modelFallbackMessage to the no-models-available guidance.
    const selectedModel = session.model;
    const isUnconfiguredModel =
      selectedModel === undefined ||
      (selectedModel.provider === "unknown" && selectedModel.id === "unknown");
    assert(
      isUnconfiguredModel,
      `Fixture session unexpectedly selected model ${String(selectedModel?.provider)}/${String(selectedModel?.id)}`,
    );
    assert(
      typeof modelFallbackMessage === "string" && modelFallbackMessage.length > 0,
      "Expected Pi createAgentSession to report no available models in credential-free fixture",
    );

    await session.bindExtensions({});

    // Phase 1: Startup registration, discovery, status invocation, closed schema.
    const startupProof = await verifyActiveFleet(eventBus, fabricProgramRunEvent, args.expectedVersion, "startup");
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
    const reload1Proof = await verifyActiveFleet(eventBus, fabricProgramRunEvent, args.expectedVersion, "reload1");
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
    const reload2Proof = await verifyActiveFleet(eventBus, fabricProgramRunEvent, args.expectedVersion, "reload2");
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
    eventBus.emit(fabricWithdrawEvent, { name: "fleet" });
    const withdrawProof = await verifyWithdrawnFleet(eventBus, fabricProgramRunEvent, "withdraw");

    // Verify a post-withdrawal reload cleanly restores exactly one registration.
    resetCounters();
    await session.reload();
    const postWithdrawReloadProof = await verifyActiveFleet(
      eventBus,
      fabricProgramRunEvent,
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
      unloadReloadProof = await verifyWithdrawnFleet(eventBus, fabricProgramRunEvent, "unload-reload");
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
      isolation: {
        homeInScratch: true,
        cwdInScratch: true,
        agentDirInScratch: true,
        envKeys: initialEnvKeys,
        checkedProviderCount: runtimeProviders.length,
        configuredAuthProviders,
        availableModelCount: availableModels.length,
        selectedModel: selectedModel
          ? `${String(selectedModel.provider)}/${String(selectedModel.id)}`
          : null,
        noModelsFallbackReported: true,
      },
      protocolCheck: {
        matched: true,
        register: fabricRegisterEvent,
        discover: fabricDiscoverEvent,
        withdraw: fabricWithdrawEvent,
      },
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
