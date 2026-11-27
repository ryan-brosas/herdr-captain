import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi loads installed packages with separate module roots (Pi docs/packages.md),
// so this extension speaks the versioned pi-fabric v1 event channels directly
// rather than importing pi-fabric/protocol at runtime.
export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";
export const FABRIC_PROVIDER_DISCOVER_EVENT = "pi-fabric:provider:discover:v1";
export const FABRIC_PROVIDER_WITHDRAW_EVENT = "pi-fabric:provider:withdraw:v1";

const PROVIDER_NAME = "fleet";
const PROVIDER_DESCRIPTION = "Herdr Captain deterministic execution provider";

interface FabricActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
  effect?: {
    kind: "none" | "scoped" | "transactional" | "emission";
    resources?: string[];
    ordering?: "commutative" | "ordered" | "unknown";
  };
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

interface FabricProviderListRequest {
  namespace?: string;
  query?: string;
  limit?: number;
}

interface FabricProvider {
  name: string;
  description: string;
  list(request: FabricProviderListRequest, context: unknown): Promise<FabricActionDescriptor[]>;
  describe(actionName: string, context: unknown): Promise<FabricActionDescriptor | undefined>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<unknown>;
}

interface FabricProviderRegistration {
  version: 1;
  provider: FabricProvider;
  overwrite?: boolean;
}

interface FabricProviderDiscovery {
  version: 1;
  register(provider: FabricProvider, options?: { overwrite?: boolean }): void;
}

interface FabricProviderWithdrawalV1 {
  name: string;
  generation?: number | string;
}

const STATUS_ACTION: FabricActionDescriptor = {
  name: "status",
  description: "Return herdr-captain package version and provider readiness.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      version: { type: "string" },
    },
    required: ["ok", "version"],
    additionalProperties: false,
  },
  risk: "read",
  effect: {
    kind: "none",
    ordering: "commutative",
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

function readPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string" &&
    parsed.version.length > 0
  ) {
    return parsed.version;
  }
  throw new Error("herdr-captain package.json is missing a valid version string");
}

function isFabricProviderDiscovery(value: unknown): value is FabricProviderDiscovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { version?: unknown; register?: unknown };
  return candidate.version === 1 && typeof candidate.register === "function";
}

function createFleetProvider(version: string): FabricProvider {
  return {
    name: PROVIDER_NAME,
    description: PROVIDER_DESCRIPTION,
    async list(request: FabricProviderListRequest) {
      if (request.limit !== undefined && request.limit <= 0) {
        return [];
      }
      if (request.namespace !== undefined && request.namespace !== STATUS_ACTION.namespace) {
        return [];
      }
      if (request.query !== undefined) {
        const normalizedQuery = request.query.normalize("NFKC").trim().toLowerCase();
        const haystack = `${PROVIDER_NAME}.${STATUS_ACTION.name} ${STATUS_ACTION.description}`.toLowerCase();
        if (normalizedQuery.length > 0 && !haystack.includes(normalizedQuery)) {
          return [];
        }
      }
      return [STATUS_ACTION];
    },
    async describe(actionName: string) {
      return actionName === STATUS_ACTION.name ? STATUS_ACTION : undefined;
    },
    async invoke(actionName: string, args: Record<string, unknown>) {
      if (actionName !== STATUS_ACTION.name) {
        throw new Error(`Unknown ${PROVIDER_NAME} action: ${actionName}`);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error(`${PROVIDER_NAME}.${STATUS_ACTION.name} expects an object argument`);
      }
      if (Object.keys(args).length > 0) {
        throw new Error(
          `${PROVIDER_NAME}.${STATUS_ACTION.name} takes no arguments; unexpected keys: ${Object.keys(args).join(", ")}`,
        );
      }
      return {
        ok: true,
        version,
      };
    },
  };
}

export default function herdrCaptainExtension(pi: ExtensionAPI): void {
  const version = readPackageVersion();
  const provider = createFleetProvider(version);
  let withdrawn = false;

  const registerProvider = (): void => {
    if (withdrawn) {
      return;
    }
    const registration: FabricProviderRegistration = {
      version: 1,
      provider,
      overwrite: true,
    };
    pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, registration);
  };

  let unsubscribeDiscover: (() => void) | undefined = pi.events.on(
    FABRIC_PROVIDER_DISCOVER_EVENT,
    (event: unknown) => {
      if (withdrawn || !isFabricProviderDiscovery(event)) {
        return;
      }
      event.register(provider, { overwrite: true });
    },
  );

  const withdrawProvider = (): void => {
    if (withdrawn) {
      return;
    }
    withdrawn = true;
    unsubscribeDiscover?.();
    unsubscribeDiscover = undefined;
    const withdrawal: FabricProviderWithdrawalV1 = {
      name: PROVIDER_NAME,
    };
    pi.events.emit(FABRIC_PROVIDER_WITHDRAW_EVENT, withdrawal);
  };

  // Register immediately if pi-fabric is already loaded, and again on
  // session_start so pi-fabric's outer registry tracks "fleet" even when
  // herdr-captain loads before pi-fabric.
  registerProvider();
  pi.on("session_start", () => {
    registerProvider();
  });
  pi.on("session_shutdown", () => {
    withdrawProvider();
  });
}
