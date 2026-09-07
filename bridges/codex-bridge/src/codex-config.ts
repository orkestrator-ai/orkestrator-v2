import { isAbsolute } from "node:path";

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
  if (env.CODEX_BRIDGE_EXECUTION_POLICY === "coordinator-read-only") {
    const permissionProfile = env.CODEX_BRIDGE_PERMISSION_PROFILE?.trim();
    const readableRuntimeRoot = env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT?.trim();
    const projectRoot = env.CWD?.trim();
    if (
      !permissionProfile ||
      !/^[A-Za-z0-9_-]+$/.test(permissionProfile) ||
      !readableRuntimeRoot ||
      !isAbsolute(readableRuntimeRoot) ||
      !projectRoot ||
      !isAbsolute(projectRoot)
    ) {
      throw new Error("Coordinator Codex permission profile configuration is invalid");
    }
    // Permission profiles replace the legacy sandbox override and make read
    // access deny-by-default. The workspace root and the shipped Codex runtime
    // are the only non-platform paths visible to sandboxed commands.
    overrides.default_permissions = JSON.stringify(permissionProfile);
    overrides[`permissions.${permissionProfile}.filesystem`] =
      `{ ":root" = "deny", ":minimal" = "read", ":tmpdir" = "deny", ` +
      `":slash_tmp" = "deny", ${JSON.stringify(readableRuntimeRoot)} = "read", ` +
      `":workspace_roots" = { "." = "read" } }`;
    overrides[`permissions.${permissionProfile}.network.enabled`] = "false";
    // A coordinator checkout is data, not trusted runtime configuration.
    // Explicitly pin this project untrusted so repository-local config, hooks,
    // and extensions stay disabled even if a future Codex release changes the
    // trust side effect of starting a thread with a permission profile.
    overrides[`projects.${JSON.stringify(projectRoot)}.trust_level`] = JSON.stringify("untrusted");
    // `features.code_mode_host` is deliberately left at its default. Every model
    // the catalog now serves declares `tool_mode = "code_mode_only"`, so Codex
    // dispatches *all* tool calls — shell reads and Orkestrator MCP controls
    // alike — through the code-mode host. Turning that host off does not narrow
    // the coordinator to inspection: it fails every tool call with "code-mode
    // host is disabled", which is what left the coordinator unable to run
    // `launch_environment`. Code-mode calls still resolve through
    // `codex_core::tools::router`, so the permission profile set above is what
    // enforces read-only, network-free execution, not the host toggle.
    for (const feature of [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "hooks",
      "image_generation",
      "in_app_browser",
      "plugin_sharing",
      "plugins",
      "remote_plugin",
      "skill_mcp_dependency_install",
      "tool_call_mcp_elicitation",
      "tool_suggest",
      "workspace_dependencies",
    ] as const) {
      overrides[`features.${feature}`] = "false";
    }
    // These variables remain available to the trusted app-server process so it
    // can authenticate, but never enter model-created shell processes. Keep
    // Codex's own default secret exclusions enabled and add coordinator-specific
    // runtime identities explicitly.
    overrides["shell_environment_policy.inherit"] = JSON.stringify("core");
    overrides["shell_environment_policy.ignore_default_excludes"] = "false";
    overrides["shell_environment_policy.exclude"] = JSON.stringify([
      "*_KEY",
      "*_SECRET",
      "*_TOKEN",
      "CODEX_HOME",
      "CODEX_BRIDGE_TOKEN",
      "CODEX_BRIDGE_PERMISSION_PROFILE",
      "CODEX_BRIDGE_READABLE_RUNTIME_ROOT",
      ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
      ORKESTRATOR_AGENT_MCP_URL_ENV,
    ]);
  }
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
