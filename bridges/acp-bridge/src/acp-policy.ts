import { coordinatorCapabilityPolicy } from "@orkestrator/protocol/coordinator-web-research";
import {
  appendNativeAgentPolicyNote,
  nativeAgentDeniedCapabilities,
  readOnlyTurnReportedPolicy,
  withoutProviderSandbox,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

/**
 * Provider-neutral process authority, matching every other bridge.
 *
 * The ACP bridge cannot hold a read-only boundary on its own: enforcement is
 * the agent choosing to issue a permission request, which this bridge then
 * denies. That is why Orkestrator offers Grok as `advisory` rather than
 * `enforced` — but the policy still has to survive a restart and a caller's
 * request body, or a coordinator conversation would silently come back
 * permissive.
 */
export const BRIDGE_EXECUTION_POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";

export function processExecutionPolicyIsCoordinator(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRIDGE_EXECUTION_POLICY_ENV] === "coordinator-read-only";
}

export function coordinatorProcessPolicy(): NativeAgentExecutionPolicy {
  return {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    // Research mode is not honoured here, and cannot be on the pinned build.
    // Grok 1.0.67's hosted `web_search` brings `open_page` and
    // `open_page_with_find`, which open any URL, and neither the agent profile
    // nor `--disallowed-tools` removes them (read live with
    // `scripts/coordinator-probes/grok-web-tools-probe.mjs`). Search there is
    // fetch, and a coordinator never gets fetch, so `--disable-web-search`
    // stays and search stays off. `GROK_WEB_FETCH=0` removes only the
    // client-side `web_fetch`.
    capabilityPolicy: coordinatorCapabilityPolicy("off"),
    networkAccess: "restricted",
    note: "Grok's write, search_replace, shell, subagent, web search and web fetch tools are removed. Remaining permission requests are denied; other tools that do not ask, including xAI's hosted X search tools, remain advisory.",
  };
}

export function effectiveExecutionPolicy(
  requested: NativeAgentExecutionPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NativeAgentExecutionPolicy | undefined {
  if (!processExecutionPolicyIsCoordinator(env)) return requested;
  return coordinatorProcessPolicy();
}

/** What a request's policy is compared against: nothing until the session has a live one. */
export function liveExecutionPolicy(state: {
  policy?: NativeAgentExecutionPolicy;
  policyPending?: boolean;
}): NativeAgentExecutionPolicy | undefined {
  return state.policyPending ? undefined : state.policy;
}

export function effectiveTurnExecutionPolicy(input: {
  policy?: NativeAgentExecutionPolicy;
  readOnly?: boolean;
}): NativeAgentExecutionPolicy | undefined {
  return input.readOnly ? coordinatorProcessPolicy() : effectiveExecutionPolicy(input.policy);
}

/**
 * The policy a session runs under, as Agent Info should describe it.
 *
 * The bridge hands the agent no sandbox, network or project-configuration
 * option: Grok has no sandbox of its own and loads a project's MCP servers by
 * its own folder trust. Approvals are the one axis the bridge holds, and only
 * for a tool that asks, so even `deny` keeps nothing off the network.
 */
export function acpReportedPolicy(
  policy: NativeAgentExecutionPolicy,
  agent: string,
): NativeAgentExecutionPolicy {
  const applied = withoutProviderSandbox(policy, { agent, toolsetBlocksNetwork: false });
  if (applied.projectResources) return applied;
  return appendNativeAgentPolicyNote(
    { ...applied, projectResources: true },
    `${agent} loads a project's own configuration by its own folder trust, whatever this session's policy says.`,
  );
}

/**
 * The policy a session reports. A `readOnly` session runs under the
 * coordinator policy (`effectiveTurnExecutionPolicy`), so it reports that one
 * until a prompt clears `readOnly`; reporting the session's own would
 * understate the restrictions in force.
 */
export function acpSessionReportedPolicy(
  state: { policy?: NativeAgentExecutionPolicy; readOnly?: boolean },
  agent: string,
): NativeAgentExecutionPolicy | undefined {
  if (state.readOnly) {
    return readOnlyTurnReportedPolicy(acpReportedPolicy(coordinatorProcessPolicy(), agent));
  }
  return state.policy ? acpReportedPolicy(state.policy, agent) : undefined;
}

/**
 * Denials (`capabilityPolicy`, or a Codex-named `toolPolicy` override) that
 * rule out writing a file.
 */
export const ACP_FILE_MUTATION_DENIALS: readonly string[] = Object.freeze([
  "file.write",
  "file.patch",
  "write",
  "edit",
  "apply_patch",
]);

/** Denials that rule out running a command. */
export const ACP_SHELL_DENIALS: readonly string[] = Object.freeze(["shell", "shell.mutate"]);

/** The ACP client methods a child may use: what it is advertised and what it is served. */
export interface AcpClientMethodGrant {
  writeTextFile: boolean;
  terminal: boolean;
}

export const FULL_ACP_CLIENT_METHOD_GRANT: AcpClientMethodGrant = Object.freeze({
  writeTextFile: true,
  terminal: true,
});

/**
 * Which of the bridge's own mutating client methods (`fs/write_text_file`,
 * `terminal/*`) a child running under `policy` may use (security report M13).
 *
 * These calls never pass through a permission request, so without this the
 * agent could write a file or run a command whatever the session's policy
 * said, and read-only rested on the provider's own tool profile. A terminal
 * is refused under `shell.mutate` as well as `shell`: the bridge cannot tell a
 * reading command from a writing one. `approvals: "deny"` refuses both, as it
 * removes Grok's own write and shell tools (`acp-readonly-profile.ts`). No
 * policy (a probe) keeps the full grant; a coordinator process's probes
 * already run under its policy (`effectiveExecutionPolicy`).
 */
export function acpClientMethodGrant(
  policy: NativeAgentExecutionPolicy | undefined,
): AcpClientMethodGrant {
  if (!policy) return FULL_ACP_CLIENT_METHOD_GRANT;
  if (policy.approvals === "deny") return { writeTextFile: false, terminal: false };
  const denied = new Set<string>([
    ...nativeAgentDeniedCapabilities(policy),
    ...(policy.toolPolicy?.deny ?? []),
  ]);
  return {
    writeTextFile: !ACP_FILE_MUTATION_DENIALS.some((name) => denied.has(name)),
    terminal: !ACP_SHELL_DENIALS.some((name) => denied.has(name)),
  };
}
