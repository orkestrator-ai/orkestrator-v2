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
import {
  readOnlyTurnReportedPolicy,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import type { PermissionMode, PromptOptions, SessionState } from "../types/index.js";
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
  // Process authority is applied last: a coordinator keeps its launcher-approved
  // research exception, while an ordinary read-only review keeps search denied.
  return effectiveExecutionPolicy(
    readOnly ? structuredClone(READ_ONLY_TURN_POLICY) : sessionPolicy,
  );
}

/**
 * The policy Agent Info should describe now. While a `readOnly` turn runs it
 * is that turn's policy, not the session's: reporting the session's would
 * understate what the running turn may do. `commandDiscoveryInputs` records
 * the inputs of the query the running turn started.
 */
export function claudeReportedPolicy(
  session: Pick<SessionState, "executionPolicy" | "status" | "commandDiscoveryInputs">,
): NativeAgentExecutionPolicy | undefined {
  if (session.status === "running" && session.commandDiscoveryInputs?.readOnly === true) {
    const turnPolicy = claudeTurnPolicy(session.executionPolicy, true);
    if (turnPolicy) return readOnlyTurnReportedPolicy(turnPolicy);
  }
  return session.executionPolicy;
}

/**
 * The permission mode a policy implies when the prompt names none.
 *
 * `deny` runs in `default` as `ask` does, not in `dontAsk`: the pinned CLI
 * refuses AskUserQuestion outright in `dontAsk` without consulting
 * `canUseTool`, so a denying session (every coordinator among them) could not
 * ask the user anything. `canUseTool` refuses every other tool that reaches it
 * instead, which is what `dontAsk` would have done.
 */
export function claudePolicyPermissionMode(
  policy: NativeAgentExecutionPolicy | undefined,
): PermissionMode {
  return isRestrictivePolicy(policy) ? "default" : "bypassPermissions";
}

function isRestrictivePolicy(policy: NativeAgentExecutionPolicy | undefined): boolean {
  return policy?.approvals === "ask" || policy?.approvals === "deny";
}

/** Modes that run nothing more without asking than `default` does. */
const RESTRICTIVE_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "plan",
  "dontAsk",
]);

/**
 * The permission mode a turn runs in: the prompt's, capped by the policy.
 *
 * The backend sends `bypassPermissions` with every build prompt, so taking
 * the prompt's mode as given meant an `ask` policy never asked and a `deny`
 * policy never refused. A prompt may still narrow the mode (plan mode, or a
 * read-only turn's `dontAsk`); anything wider falls back to `default`.
 */
export function claudePermissionMode(
  policy: NativeAgentExecutionPolicy | undefined,
  requested: PermissionMode | undefined,
): PermissionMode {
  const policyMode = claudePolicyPermissionMode(policy);
  if (requested === undefined) return policyMode;
  if (!isRestrictivePolicy(policy)) return requested;
  return RESTRICTIVE_PERMISSION_MODES.has(requested) ? requested : policyMode;
}

/** Modes in which the CLI hands a tool it was not told to allow to `canUseTool`. */
const ASKING_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "acceptEdits",
  "auto",
]);

/**
 * Whether a turn's tool approvals go to the user.
 *
 * An `ask` policy always asks and a `deny` policy never does. Under
 * `auto-approve` the session's approval mode decides, so that choosing an
 * asking mode in the composer actually parks the tools the CLI wants approved
 * instead of allowing every one that reaches `canUseTool`.
 */
export function claudeAsksForApproval(
  policy: NativeAgentExecutionPolicy | undefined,
  options: Pick<PromptOptions, "permissionMode" | "approvalMode"> | undefined,
): boolean {
  if (policy?.approvals === "ask") return true;
  if (policy?.approvals === "deny") return false;
  return ASKING_PERMISSION_MODES.has(
    claudePermissionMode(policy, options?.approvalMode ?? options?.permissionMode),
  );
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

/** Chrome is opt-in and never available inside the coordinator boundary. */
export function effectiveClaudeChrome(
  policy: NativeAgentExecutionPolicy | undefined,
  options: PromptOptions | undefined,
): boolean {
  return options?.parameterValues?.chrome === true && !isCoordinatorReadOnlyPolicy(policy);
}
