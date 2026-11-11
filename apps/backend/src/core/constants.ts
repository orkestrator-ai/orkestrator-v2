import backendPackage from "../../package.json" with { type: "json" };

/** Replaced by the backend's bundlers (`buildCommitDefine`); undeclared when run from source. */
declare const __ORKESTRATOR_BUILD_COMMIT__: string | null | undefined;

export const APP_SLUG = "orkestrator-v2";
export const PRODUCT_NAME = "Orkestrator AI";

export const DOCKER_IMAGE = "orkestrator-v2:latest";
export const DOCKER_LABEL_APP = "app";
export const DOCKER_LABEL_APP_VALUE = APP_SLUG;
export const DOCKER_LABEL_ENVIRONMENT_ID = "environment-id";
export const DOCKER_LABEL_ENVIRONMENT_NAME = "environment-name";
export const DOCKER_LABEL_OWNER = "orkestrator-owner";
export const DOCKER_LABEL_PROJECT_ID = "project-id";
/** Lifecycle operation that created the resource; reconciles ambiguous creates. */
export const DOCKER_LABEL_OPERATION_ID = "orkestrator-operation-id";
/** Runtime generation of a container; changes whenever the runtime is replaced. */
export const DOCKER_LABEL_RUNTIME_GENERATION = "orkestrator-runtime-generation";
/** Network policy version a container was created with (step 09). */
export const DOCKER_LABEL_NETWORK_POLICY = "orkestrator-network-policy";
/** Staged portable-input revision a container binds (step 08). */
export const DOCKER_LABEL_INPUTS_REVISION = "orkestrator-inputs-revision";
/**
 * Project seed files (`.env`, `.env.local`, `opencode.json`) refused at
 * creation, as `name=reason` pairs from a fixed vocabulary.
 */
export const DOCKER_LABEL_PROJECT_SEED_REFUSED = "orkestrator-project-seed-refused";
/**
 * Host ports the backend chose for a rootless daemon's automatic mappings, as
 * comma-separated numbers (`container-host-ports.ts`). Published as fixed
 * ports, but not ports the user fixed, so the start path may retry them.
 */
export const DOCKER_LABEL_BACKEND_HOST_PORTS = "orkestrator-backend-host-ports";
/** Role of an owned volume/network/helper (workspace, state, network, helper…). */
export const DOCKER_LABEL_RESOURCE_ROLE = "orkestrator-resource-role";
/**
 * Kind of backend that made a host-reachability probe resource
 * (`<runtime flavor>/<temporary|persistent>`, `container-host-reachability-creator.ts`).
 * Content-free: never a path or a name.
 */
export const DOCKER_LABEL_CREATOR = "orkestrator-creator";

export {
  AGENT_NETWORK_DOMAINS_BY_PLATFORM,
  requiredAgentNetworkDomains,
} from "@orkestrator/protocol/network-allowlist";
import { DEFAULT_CODEX_MAX_CONCURRENT_THREADS } from "@orkestrator/protocol/app-config-defaults";

export const OPENCODE_SERVER_PORT = 4096;
export const CLAUDE_BRIDGE_PORT = 4097;
export const CODEX_BRIDGE_PORT = 4098;
export const CURSOR_BRIDGE_PORT = 4099;
export const GROK_ACP_BRIDGE_PORT = 4100;
export const PI_BRIDGE_PORT = 4101;
/**
 * The OpenCode 2.x server inside a container (`opencode2-container-server.ts`).
 * Published on every new container; only an image with `opencode2` runs it.
 */
export const OPENCODE2_SERVER_PORT = 4102;
export { DEFAULT_CODEX_MAX_CONCURRENT_THREADS };
// Codex multi-agent V2 counts the root thread in addition to these child
// threads, so reserve one safe-integer slot for the bridge's conversion.
export const MAX_CODEX_CONCURRENT_THREADS = Number.MAX_SAFE_INTEGER - 1;
export const CODEX_MAX_CONCURRENT_THREADS_ENV = "CODEX_MAX_CONCURRENT_THREADS_PER_SESSION";

export function isValidCodexMaxConcurrentThreads(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CODEX_CONCURRENT_THREADS
  );
}

export function resolveCodexMaxConcurrentThreads(value: unknown): number {
  return isValidCodexMaxConcurrentThreads(value) ? value : DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
}

export const ORKESTRATOR_PROJECT_CONFIG = "orkestrator-ai.json";

/**
 * Orkestrator version, forwarded to the Codex bridge and on to app-server as
 * `clientInfo.version` (app-server uses it for compliance logging).
 *
 * Launchers (Electron, the CLI) export `ORKESTRATOR_VERSION`. A backend started
 * directly (`bun dist/main.js`, e.g. `start:web-public`) has no launcher, so it
 * falls back to the version of the backend package it was built from.
 *
 * Sanitized to a conservative charset because it is interpolated into the
 * `docker exec` script that starts the container bridge. It comes from the
 * environment, so anything not matching gets replaced rather than trusted — an
 * unexpected value should degrade the reported version, never execute.
 */
export function sanitizeAppVersion(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  return /^[A-Za-z0-9._+-]{1,64}$/.test(trimmed) ? trimmed : "0.0.0";
}

/** Version of the backend package this code was built from. */
export const BACKEND_PACKAGE_VERSION = sanitizeAppVersion(backendPackage.version);

export const APP_VERSION = sanitizeAppVersion(
  process.env.ORKESTRATOR_VERSION?.trim() || BACKEND_PACKAGE_VERSION,
);

/**
 * The commit this backend was built from, embedded at build time. `null` for a
 * build with none to report: run from source, a test build, or a modified tree.
 * Never read from the environment at runtime, where it would describe the
 * process that started this one rather than the code it loaded.
 */
export const BUILD_COMMIT: string | null =
  typeof __ORKESTRATOR_BUILD_COMMIT__ === "string" ? __ORKESTRATOR_BUILD_COMMIT__ : null;
