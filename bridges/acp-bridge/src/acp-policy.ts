import { coordinatorCapabilityPolicy } from "@orkestrator/protocol/coordinator-web-research";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

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
