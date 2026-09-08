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
    capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
    networkAccess: "restricted",
    note: "The agent is asked to request permission and every request is denied. A tool that does not ask is not stopped.",
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
