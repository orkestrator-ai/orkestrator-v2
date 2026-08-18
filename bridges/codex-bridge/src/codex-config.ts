export const CODEX_MAX_CONCURRENT_THREADS_ENV = "CODEX_MAX_CONCURRENT_THREADS_PER_SESSION";
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
export const ORKESTRATOR_AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
export const ORKESTRATOR_AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";
/**
 * Multi-agent V2 counts the root thread in its limit, while Orkestrator's
 * setting and the legacy `agents` key count only spawned children. Leave room
 * for that root before converting between the two representations.
 */
export const MAX_CODEX_CONCURRENT_THREADS = Number.MAX_SAFE_INTEGER - 1;

export function resolveCodexMaxConcurrentThreads(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_CODEX_CONCURRENT_THREADS
    ? parsed
    : DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
}

export function codexAppServerConfigOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const childLimit = resolveCodexMaxConcurrentThreads(env[CODEX_MAX_CONCURRENT_THREADS_ENV]);
  const overrides: Record<string, string> = {
    "features.goals": "true",
    // Codex 0.147+ negotiates the stateless MCP 2026-07-28 protocol and falls
    // back to the 2025 era for third-party servers that have not upgraded yet.
    "features.mcp_2026_07_28": "true",
    // V1 reads the child-only compatibility key.
    "agents.max_concurrent_threads_per_session": String(childLimit),
    // V2 prefers this root-inclusive key whenever it is present in config.toml.
    // Supplying both CLI overrides makes the Orkestrator setting authoritative
    // regardless of which multi-agent implementation Codex selects.
    "features.multi_agent_v2.max_concurrent_threads_per_session": String(childLimit + 1),
  };
  const rawUrl = env[ORKESTRATOR_AGENT_MCP_URL_ENV]?.trim();
  const token = env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV]?.trim();
  if (rawUrl && token) {
    try {
      const url = new URL(rawUrl);
      if (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) &&
        url.pathname === "/mcp" &&
        !url.username &&
        !url.password
      ) {
        overrides["mcp_servers.orkestrator.url"] = JSON.stringify(url.toString());
        // The token stays in the child environment rather than argv/config,
        // where process listings and diagnostics could expose its value.
        overrides["mcp_servers.orkestrator.bearer_token_env_var"] = JSON.stringify(
          ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
        );
        // Ticket tools are useful but must never delay an app-server becoming
        // ready. Codex 0.147 starts optional MCP servers in the background.
        overrides["mcp_servers.orkestrator.required"] = "false";
        overrides["mcp_servers.orkestrator.startup_timeout_sec"] = "3";
      }
    } catch {
      // Invalid injected configuration is ignored; user MCP config still loads.
    }
  }
  return overrides;
}
