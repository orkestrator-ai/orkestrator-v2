export const APP_SLUG = "orkestrator-v2";
export const PRODUCT_NAME = "Orkestrator AI";

export const DOCKER_IMAGE = "orkestrator-v2:latest";
export const DOCKER_LABEL_APP = "app";
export const DOCKER_LABEL_APP_VALUE = APP_SLUG;
export const DOCKER_LABEL_ENVIRONMENT_ID = "environment-id";
export const DOCKER_LABEL_ENVIRONMENT_NAME = "environment-name";
export const DOCKER_LABEL_OWNER = "orkestrator-owner";
export const DOCKER_LABEL_PROJECT_ID = "project-id";

/** Endpoints each managed ACP provider requires in restricted containers. */
export const AGENT_NETWORK_DOMAINS_BY_PLATFORM = Object.freeze({
  cursor: Object.freeze([
    "api2.cursor.sh",
    "api3.cursor.sh",
    "api4.cursor.sh",
    "api5.cursor.sh",
    "repo42.cursor.sh",
    "authenticator.cursor.sh",
    "marketplace.cursorapi.com",
    "cursor-cdn.com",
    "cursor.com",
  ] as readonly string[]),
  grok: Object.freeze([
    "x.ai",
    "auth.x.ai",
    "api.x.ai",
    "cli-chat-proxy.grok.com",
  ] as readonly string[]),
  /**
   * Pi is a harness in front of other people's models, so "the hosts Pi needs"
   * is really "the hosts the user's own providers need". This list covers Pi's
   * own catalogue router and the mainstream providers it ships credentials
   * support for; a provider outside it — a self-hosted endpoint, a regional
   * mirror, an OpenAI-compatible gateway — is a host only the user knows, and
   * belongs in the environment's `allowedDomains` rather than being guessed at
   * here. Adding all of them unconditionally would quietly widen the isolation
   * boundary for every Pi environment to reach every vendor Pi has ever known.
   */
  pi: Object.freeze([
    "pi.dev",
    "radius.pi.dev",
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
    "api.mistral.ai",
    "api.groq.com",
    "api.deepseek.com",
    "api.cerebras.ai",
    "api.together.ai",
    "openrouter.ai",
  ] as readonly string[]),
} as const);

/**
 * Hosts that must be reachable for the ACP platforms this install has enabled.
 *
 * These are deliberately NOT part of the default allowlist: an explicit
 * allowlist is the isolation boundary the user configured, and a restricted
 * container running neither Cursor nor Grok has no reason to reach either
 * vendor. Container creation unions in only what the enabled platforms need.
 */
export function requiredAgentNetworkDomains(
  enabledPlatforms: readonly string[] | undefined,
): readonly string[] {
  if (!enabledPlatforms) return [];
  const domains = new Set<string>();
  for (const platform of ["cursor", "grok", "pi"] as const) {
    if (enabledPlatforms.includes(platform)) {
      for (const domain of AGENT_NETWORK_DOMAINS_BY_PLATFORM[platform]) {
        domains.add(domain);
      }
    }
  }
  return Array.from(domains);
}

export const OPENCODE_SERVER_PORT = 4096;
export const CLAUDE_BRIDGE_PORT = 4097;
export const CODEX_BRIDGE_PORT = 4098;
export const CURSOR_ACP_BRIDGE_PORT = 4099;
export const GROK_ACP_BRIDGE_PORT = 4100;
export const PI_BRIDGE_PORT = 4101;
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
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
 * Sanitized to a conservative charset because it is interpolated into the
 * `docker exec` script that starts the container bridge. It comes from the
 * environment, so anything not matching gets replaced rather than trusted — an
 * unexpected value should degrade the reported version, never execute.
 */
export function sanitizeAppVersion(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  return /^[A-Za-z0-9._+-]{1,64}$/.test(trimmed) ? trimmed : "0.0.0";
}

export const APP_VERSION = sanitizeAppVersion(process.env.ORKESTRATOR_VERSION);
