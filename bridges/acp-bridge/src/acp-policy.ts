import { coordinatorCapabilityPolicy } from "@orkestrator/protocol/coordinator-web-research";
import {
  appendNativeAgentPolicyNote,
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
    // Research mode is not honoured here: Grok's only verified switch,
    // `--disable-web-search`, removes search and fetch together, and a
    // coordinator never gets fetch. Search stays off until a fetch-only
    // switch is verified on the pinned build.
    capabilityPolicy: coordinatorCapabilityPolicy("off"),
    networkAccess: "restricted",
    note: "Grok's web search and web fetch are switched off. Every other tool is asked to request permission and every request is denied; a tool that does not ask is not stopped.",
  };
}

export function effectiveExecutionPolicy(
  requested: NativeAgentExecutionPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NativeAgentExecutionPolicy | undefined {
  if (!processExecutionPolicyIsCoordinator(env)) return requested;
  return coordinatorProcessPolicy();
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
