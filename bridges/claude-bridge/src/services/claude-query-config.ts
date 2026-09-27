/**
 * Query configuration shared by real turns and command-discovery probes.
 *
 * Claude's command inventory is a function of the workspace, the settings
 * sources the CLI loads, and the plugins it is handed. A discovery probe that
 * spawned the CLI with defaults answered a different question from the one the
 * session's own turns answer: a coordinator loads no settings at all, a session
 * without project resources loads only user settings, and a turn that opted
 * into `.claude/settings.local.json` sees commands a probe without it would not.
 * Both call sites therefore derive those options here, from the same inputs.
 *
 * Deliberately excluded: MCP servers (starting them spawns more processes, and
 * the Orkestrator server carries a per-prompt credential), tool allow/deny
 * lists, model, effort and every other option that changes how a turn runs
 * rather than which commands exist.
 */
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { getPluginsForSdk, type SdkPluginConfig } from "./plugin-config.js";
import { effectiveExecutionPolicy, isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";

/** The policy a `readOnly` prompt runs under, whatever the session's own policy. */
export const READ_ONLY_TURN_POLICY: NativeAgentExecutionPolicy = Object.freeze({
  id: "coordinator-read-only",
  sandbox: "provider",
  approvals: "deny",
  projectResources: false,
  capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
  networkAccess: "restricted",
}) as NativeAgentExecutionPolicy;

/** The per-turn inputs that change which commands a query can see. */
export interface ClaudeDiscoveryInputs {
  readOnly: boolean;
  includeLocalSettings: boolean;
}

export function claudeWorkspaceCwd(): string {
  // CWD is set for local environments, where the bridge runs from its own
  // directory but the SDK must operate on the project.
  return process.env.CWD || process.cwd();
}

/**
 * The policy one turn runs under.
 *
 * Re-derived per turn rather than read once at create: a session restored from
 * disk must not carry a policy weaker than the one this process enforces.
 */
export function claudeTurnPolicy(
  sessionPolicy: NativeAgentExecutionPolicy | undefined,
  readOnly: boolean | undefined,
): NativeAgentExecutionPolicy | undefined {
  return readOnly
    ? structuredClone(READ_ONLY_TURN_POLICY)
    : effectiveExecutionPolicy(sessionPolicy);
}

/**
 * Settings sources for a turn.
 *
 * A coordinator loads nothing: user settings can declare their own hooks and
 * MCP servers, both of which run programs this boundary is supposed to exclude.
 */
export function claudeSettingSources(
  policy: NativeAgentExecutionPolicy | undefined,
  includeLocalSettings: boolean | undefined,
): SettingSource[] {
  if (isCoordinatorReadOnlyPolicy(policy)) return [];
  if (policy?.projectResources === false) return ["user"];
  return includeLocalSettings ? ["user", "project", "local"] : ["user", "project"];
}

export interface ClaudeDiscoveryConfig {
  cwd: string;
  settingSources: SettingSource[];
  plugins: SdkPluginConfig[];
  /**
   * Content-free identity of the configuration, so a probe answer computed for
   * one configuration is never served for another.
   */
  fingerprint: string;
}

/** Resolve the discovery-relevant options exactly as a real turn would. */
export async function resolveClaudeDiscoveryConfig(
  sessionPolicy: NativeAgentExecutionPolicy | undefined,
  inputs: ClaudeDiscoveryInputs,
): Promise<ClaudeDiscoveryConfig> {
  const policy = claudeTurnPolicy(sessionPolicy, inputs.readOnly);
  const cwd = claudeWorkspaceCwd();
  const settingSources = claudeSettingSources(policy, inputs.includeLocalSettings);
  const plugins = await getPluginsForSdk(cwd, policy?.projectResources !== false);
  return {
    cwd,
    settingSources,
    plugins,
    fingerprint: JSON.stringify([cwd, settingSources, plugins.map((plugin) => plugin.path)]),
  };
}
