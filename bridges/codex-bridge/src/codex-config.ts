import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import {
  coordinatorCapabilityPolicy,
  coordinatorResearchMcpServersFromEnv,
  coordinatorWebResearchFromEnv,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  nativeAgentPolicyDeniesNetwork,
  nativeAgentPolicyDeniesWebSearch,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export const CODEX_MAX_CONCURRENT_THREADS_ENV = "CODEX_MAX_CONCURRENT_THREADS_PER_SESSION";
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
export const ORKESTRATOR_AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
export const ORKESTRATOR_AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";
/** The launcher-supplied directory a coordinator's attachments are staged in. */
export const BRIDGE_ATTACHMENT_ROOT_ENV = "ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT";
/**
 * Multi-agent V2 counts the root thread in its limit, while Orkestrator's
 * setting and the legacy `agents` key count only spawned children. Leave room
 * for that root before converting between the two representations.
 */
export const MAX_CODEX_CONCURRENT_THREADS = Number.MAX_SAFE_INTEGER - 1;

/**
 * Codex's hosted web search modes a network-denied session may run under.
 *
 * The permission profile's `network.enabled = false` stops commands the agent
 * runs, but web search is a hosted tool: OpenAI's servers do the work, so
 * nothing on this machine sees the request. Under 0.162.1 it is offered to the
 * model as `web__run` ("Tool for accessing the internet") even with network
 * off, and in `live` mode it opens any URL the model names — verified on
 * 2026-10-16 by having it open a Wikipedia search for a fresh random token,
 * which came back in the page title. A URL can carry data out to whoever owns
 * the page, so a network-denied session never gets `live`:
 *
 * - `disabled` removes the tool. It wins over every legacy switch
 *   (`features.web_search_request`, `features.web_search_cached`,
 *   `tools.web_search`) and over `features.standalone_web_search`.
 * - `cached` keeps search but serves pages only from OpenAI's index. The same
 *   fresh-token URL was refused with "Cache miss", and an echo service with
 *   "not accessible via this tool".
 *
 * The legacy feature flags are not set: they cannot re-enable search, and
 * naming them makes app-server emit a deprecation notice on every thread.
 * `standalone_web_search` is still under development and is pinned off so it
 * cannot become a second, unreviewed path once it ships.
 */
export type CodexNetworkDeniedSearchMode = "disabled" | "cached";

/** The web search mode a network-denied policy runs Codex under. */
export function codexNetworkDeniedSearchMode(
  policy: NativeAgentExecutionPolicy | undefined,
): CodexNetworkDeniedSearchMode {
  return nativeAgentPolicyDeniesNetwork(policy) && !nativeAgentPolicyDeniesWebSearch(policy)
    ? "cached"
    : "disabled";
}

/** Thread configuration for a policy that denies the network; empty otherwise. */
export function codexNetworkDeniedConfig(
  policy: NativeAgentExecutionPolicy | undefined,
): Record<string, unknown> {
  if (!nativeAgentPolicyDeniesNetwork(policy) && !nativeAgentPolicyDeniesWebSearch(policy)) {
    return {};
  }
  return {
    web_search: codexNetworkDeniedSearchMode(policy),
    "features.standalone_web_search": false,
  };
}

/**
 * Thread configuration that keeps a checkout's own `.codex` configuration out
 * of a session whose policy turns project resources off; empty otherwise.
 *
 * Codex loads a project's `.codex` layer (model settings, MCP servers, hooks)
 * once the user trusts the project, or its main checkout, in Codex. Pinning
 * the thread's cwd untrusted drops that layer for this thread only, and stops
 * a writable thread from marking the project trusted in the user's
 * `config.toml`. Verified against 0.164.0 (`live-project-trust.test.ts`):
 *
 * - The pin must be a nested table. A dotted `projects."<path>".trust_level`
 *   key, which works as a process `-c` override, is ignored in thread config.
 * - Pinning the worktree wins over a trusted main checkout, and holds for a
 *   cwd below the pinned root.
 *
 * Both the given path and its canonical form are pinned, because Codex may
 * compare either. Without a policy (an older backend) Codex keeps its own
 * trust decision.
 */
export function codexProjectTrustConfig(
  policy: NativeAgentExecutionPolicy | undefined,
  cwd: string | undefined,
): Record<string, unknown> {
  if (!policy || policy.projectResources || !cwd || !isAbsolute(cwd)) return {};
  const roots = new Set([cwd]);
  try {
    roots.add(realpathSync(cwd));
  } catch {
    // A missing cwd fails thread/start on its own; the given path is pinned.
  }
  return {
    projects: Object.fromEntries([...roots].map((root) => [root, { trust_level: "untrusted" }])),
  };
}

/** More skills than any real inventory; past it the thread is refused. */
export const MAX_CODEX_DISABLED_SKILLS = 1_024;

const KEPT_SKILL_SCOPES = new Set(["user", "system", "admin"]);

/**
 * Thread `skills.config` that keeps a checkout's own skills out of a session
 * whose policy turns project resources off, from a `skills/list` answer for
 * the thread's cwd.
 *
 * The untrusted pin (`codexProjectTrustConfig`) does not reach skills: Codex
 * 0.162.1 still offers `.codex/skills` and `.agents/skills` from an untrusted
 * checkout. A thread-scoped `{ path, enabled: false }` entry does remove one
 * (`live-project-trust.test.ts`). The thread's list replaces the user's own
 * `skills.config` list rather than adding to it, so every skill Codex already
 * reports disabled is listed again. Anything else that is not an enabled
 * user, system or admin skill is disabled too, which is the safe direction
 * for a scope this bridge does not know. A skill that cannot be disabled by
 * path, or an inventory too large to list, refuses the thread.
 */
export function codexProjectSkillsConfig(listed: unknown): Record<string, unknown> {
  const data =
    listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
      ? ((listed as { data: unknown[] }).data as unknown[])
      : undefined;
  if (!data) throw new Error("Codex skills/list returned no skill inventory");
  const disabled = new Set<string>();
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    for (const skill of Array.isArray(skills) ? skills : []) {
      const { path, scope, enabled } = (skill ?? {}) as Record<string, unknown>;
      if (enabled === true && typeof scope === "string" && KEPT_SKILL_SCOPES.has(scope)) continue;
      if (typeof path !== "string" || !isAbsolute(path)) {
        throw new Error("Codex listed a project skill without a path it can be disabled by");
      }
      disabled.add(path);
    }
  }
  if (disabled.size > MAX_CODEX_DISABLED_SKILLS) {
    throw new Error(`Codex listed more than ${MAX_CODEX_DISABLED_SKILLS} skills to disable`);
  }
  if (disabled.size === 0) return {};
  return { skills: { config: [...disabled].map((path) => ({ path, enabled: false })) } };
}

/** Stands in for a session restored without a policy; only its denial matters. */
const READ_ONLY_TURN_FALLBACK_POLICY: NativeAgentExecutionPolicy = Object.freeze({
  id: "interactive-host",
  sandbox: "provider",
  approvals: "deny",
  projectResources: false,
  networkAccess: "restricted",
});

/**
 * The policy a `readOnly` turn runs under: the session's, with the network
 * denied.
 *
 * The prompt override separately sets networkAccessEnabled:false to stop
 * command networking. Hosted web search runs on OpenAI's servers, so this
 * denial takes it away (`codexNetworkDeniedConfig`). Every other bridge's read-only turn
 * denies `network` too. Search exceptions are dropped with it: an ordinary
 * review never searches. A policy that already denies the network is kept as
 * it is, so a coordinator keeps its launcher-approved research mode, which its
 * process configuration and `config/read` readback also hold.
 */
export function codexReadOnlyTurnPolicy(
  policy: NativeAgentExecutionPolicy | undefined,
): NativeAgentExecutionPolicy {
  if (policy && nativeAgentPolicyDeniesNetwork(policy)) return policy;
  const base = policy ?? READ_ONLY_TURN_FALLBACK_POLICY;
  const denied = base.capabilityPolicy?.deny ?? [];
  return { ...base, capabilityPolicy: { deny: [...denied, "network"] } };
}

/**
 * Whether an effective configuration (`config/read`) keeps tool declarations
 * out of thread history.
 *
 * With `features.incremental_tools` (stable and on by default since codex
 * 0.164.0) each turn's tools are appended to the history as an
 * `additional_tools` record, and a resumed thread replays them: a turn that
 * denies hosted search would still carry an earlier turn's `web__run`. Off,
 * the request declares only the current turn's tools and writes no record
 * (`live-network-lock.test.ts`). Thread configuration cannot turn it off, so
 * the process override must hold; only an explicit `false` passes.
 */
export function codexToolHistoryGaps(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config/read returned no configuration"];
  }
  const features = (config as Record<string, unknown>).features;
  const value =
    features && typeof features === "object" && !Array.isArray(features)
      ? (features as Record<string, unknown>).incremental_tools
      : undefined;
  return value === false
    ? []
    : [`features.incremental_tools is ${JSON.stringify(value ?? null)}, not false`];
}

/**
 * Whether an effective configuration (`config/read`) runs search in the
 * expected mode, with tool declarations kept out of history.
 *
 * Returns what is wrong, so a refusal can say which switch failed. An empty
 * list is the only passing answer; a missing or unparseable `config` fails.
 */
export function codexHostedNetworkLockGaps(
  config: unknown,
  expected: CodexNetworkDeniedSearchMode = "disabled",
): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config/read returned no configuration"];
  }
  const record = config as Record<string, unknown>;
  const gaps: string[] = [];
  if (record.web_search !== expected) {
    gaps.push(`web_search is ${JSON.stringify(record.web_search ?? null)}, not "${expected}"`);
  }
  const features = record.features;
  if (
    features &&
    typeof features === "object" &&
    (features as Record<string, unknown>).standalone_web_search === true
  ) {
    gaps.push("features.standalone_web_search is on");
  }
  gaps.push(...codexToolHistoryGaps(config));
  return gaps;
}

/**
 * Whether this process was launched to serve a read-only coordinator.
 *
 * `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` is the provider-neutral name every
 * bridge now answers to; the Codex-specific variable predates it and is still
 * honoured so an older launcher keeps working.
 */
export function isCoordinatorReadOnlyEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY === "coordinator-read-only" ||
    env.CODEX_BRIDGE_EXECUTION_POLICY === "coordinator-read-only"
  );
}

/**
 * The policy a coordinator process runs under, whatever a request body or a
 * persisted record carries.
 *
 * `capabilityPolicy` is what the agent information panel reads to say the
 * network is off, and what `toThreadParams` reads to set the thread's search
 * mode; it follows the research setting the launcher passed. `toolPolicy`
 * keeps Codex's own tool names.
 */
export function codexCoordinatorPolicy(
  env: NodeJS.ProcessEnv = process.env,
): NativeAgentExecutionPolicy {
  return {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
    capabilityPolicy: coordinatorCapabilityPolicy(coordinatorWebResearchFromEnv(env)),
    networkAccess: "restricted",
  };
}

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
    // Do not force `features.mcp_2026_07_28`. Codex CLI leaves that flag off
    // (under development). Enabling it makes app-server probe with
    // `server/discover` / 2026-07-28 first. Third-party HTTP servers such as
    // Paper.design reject that with JSON-RPC -32020, and Codex does not fall
    // back to `initialize`, so they work in CLI and fail in native sessions.
    // Orkestrator's own agent MCP is dual-era (`legacy: "stateless"`), so it
    // still works when Codex uses the 2025 handshake.
    // V1 reads the child-only compatibility key.
    "agents.max_concurrent_threads_per_session": String(childLimit),
    // V2 prefers this root-inclusive key whenever it is present in config.toml.
    // Supplying both CLI overrides makes the Orkestrator setting authoritative
    // regardless of which multi-agent implementation Codex selects.
    "features.multi_agent_v2.max_concurrent_threads_per_session": String(childLimit + 1),
    // Off for every bridge, since any thread can later run a turn that denies
    // hosted search. See `codexToolHistoryGaps`.
    "features.incremental_tools": "false",
  };
  const rawUrl = env[ORKESTRATOR_AGENT_MCP_URL_ENV]?.trim();
  const token = env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV]?.trim();
  if (isCoordinatorReadOnlyEnvironment(env)) {
    const permissionProfile = env.CODEX_BRIDGE_PERMISSION_PROFILE?.trim();
    const readableRuntimeRoot = env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT?.trim();
    const projectRoot = env.CWD?.trim();
    // A coordinator's prompt attachments are staged outside the checkout, so
    // the path Codex is handed for a `local_image` resolves through neither the
    // workspace root nor the runtime root. Granting read on that one
    // conversation-scoped directory is what makes an attached image legible;
    // it contains nothing but images the user attached to this conversation.
    const attachmentRoot = env[BRIDGE_ATTACHMENT_ROOT_ENV]?.trim();
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
      (attachmentRoot && isAbsolute(attachmentRoot)
        ? `${JSON.stringify(attachmentRoot)} = "read", `
        : "") +
      `":workspace_roots" = { "." = "read" } }`;
    overrides[`permissions.${permissionProfile}.network.enabled`] = "false";
    // The profile above stops commands; hosted web search runs on OpenAI's
    // servers and is governed only by configuration: off, or `cached` when the
    // research setting allows search, never `live`. The engine reads this
    // back through `config/read` before every coordinator thread and refuses
    // to run one in any other mode.
    overrides.web_search = JSON.stringify(
      codexNetworkDeniedSearchMode(codexCoordinatorPolicy(env)),
    );
    overrides["features.standalone_web_search"] = "false";
    // Research servers the user listed. Remote HTTPS only (validated in the
    // protocol): a stdio server would be a local program outside the profile.
    // app-server makes these calls itself, so the profile's network denial
    // does not apply to them. Their tools are approved like the Orkestrator
    // server's: under `approvalPolicy: never` and a read-only profile, Codex
    // would otherwise refuse every call before it is made.
    for (const server of coordinatorResearchMcpServersFromEnv(env)) {
      const key = `mcp_servers.${server.name}`;
      overrides[`${key}.url`] = JSON.stringify(server.url);
      overrides[`${key}.required`] = "false";
      overrides[`${key}.startup_timeout_sec`] = "10";
      overrides[`${key}.default_tools_approval_mode`] = JSON.stringify("approve");
    }
    // A coordinator checkout is data, not trusted runtime configuration.
    // Explicitly pin this project untrusted so repository-local config, hooks,
    // and extensions stay disabled even if a future Codex release changes the
    // trust side effect of starting a thread with a permission profile.
    overrides[`projects.${JSON.stringify(projectRoot)}.trust_level`] = JSON.stringify("untrusted");
    // `features.code_mode_host` is deliberately left at its default, unlike
    // every other entry below. Each model the catalog now serves declares
    // `tool_mode = "code_mode_only"`, so Codex dispatches *all* tool calls —
    // shell reads and Orkestrator MCP controls alike — through the code-mode
    // host. Turning that host off does not narrow the coordinator to
    // inspection: it fails every tool call with "code-mode host is disabled",
    // which is what left the coordinator unable to run `launch_environment`.
    //
    // The guard this replaces asked for proof that the permission profile and
    // environment exclusions survive inside the host, because the host is a
    // separate process (`codex-code-mode-host`, spawned per code-mode turn) and
    // the coordinator runs on the host machine rather than in a container, so
    // config is the whole boundary. What the shipped binary shows:
    //
    //   - It embeds bare V8 (`rusty_v8`) and no JS runtime layer — no
    //     `deno_core`/`deno_runtime`, no `Deno.*` bindings, no `allow-read`,
    //     `allow-write`, or `allow-net` permission surface. Model-authored
    //     TypeScript therefore has no filesystem, network, or environment
    //     syscall of its own to reach for.
    //   - Its only outward edge is a gRPC channel that delegates each tool call
    //     back to Codex ("code mode delegate request", "code-mode cell closed
    //     before dispatching its tool call"), where `codex_core::tools::router`
    //     applies `default_permissions`.
    //
    // So the permission profile, the network denial, and the untrusted project
    // pin set above are the enforcement, and the host toggle is not. The
    // coordinator overrides are pinned as one unit in `codex-config.test.ts`:
    // code mode may not be enabled without all three still in place.
    //
    // Residual risk, not resolved here: the host also links transport code for
    // a TCP listener alongside a Unix socket. Which one Codex selects on Linux,
    // and how that channel is authenticated, is upstream behaviour we cannot
    // determine from the binary, and it is a local attack surface if it is TCP.
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
        if (isCoordinatorReadOnlyEnvironment(env)) {
          // MCP tool calls carry their own approval gate, separate from the
          // command and file approvals answered in `server-request-router.ts`.
          // Under `approvalPolicy: "never"` Codex auto-approves one only when the
          // permission profile grants full disk write, so a coordinator's
          // read-only managed profile would otherwise refuse mutating controls
          // such as `launch_environment` before the backend sees them.
          //
          // This exception is coordinator-only. Setting `approve` for an
          // ordinary process would override that session's ask/deny policy.
          // The backend's caller-scoped token remains the authority for which
          // control tools the coordinator can invoke.
          overrides["mcp_servers.orkestrator.default_tools_approval_mode"] =
            JSON.stringify("approve");
        } else {
          // A worker's mail tools are always approved, whatever its ask/deny
          // policy: they are how it reports back. Artifact tools likewise only
          // write to Orkestrator's own store. Its other Orkestrator tools keep
          // Codex's defaults.
          for (const name of [...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES]) {
            overrides[`mcp_servers.orkestrator.tools.${name}.approval_mode`] =
              JSON.stringify("approve");
          }
        }
      }
    } catch {
      // Invalid injected configuration is ignored; user MCP config still loads.
    }
  }
  return overrides;
}
