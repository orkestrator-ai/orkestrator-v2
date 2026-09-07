import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import type {
  NativeAgentExecutionPolicy,
  NativeAgentExecutionPolicyOverride,
} from "@orkestrator/protocol/native-agent";
import type { Environment } from "./models.js";

/**
 * Resolve the immutable policy attached to a provider session.
 *
 * The matrix is deliberately independent of provider. Bridges only translate
 * this result into vendor options; they never decide whether a repository is
 * trusted because they cannot reliably distinguish a host from a container.
 */
export function resolveNativeAgentExecutionPolicy(
  environment: Pick<Environment, "environmentType" | "networkAccessMode">,
  origin: AgentInteractionOrigin,
  override?: NativeAgentExecutionPolicyOverride,
): NativeAgentExecutionPolicy {
  const container = environment.environmentType === "containerized";
  const pipeline = origin === "build-pipeline" || origin === "looped-review";
  const coordinator = origin === "coordinator";

  const policy: NativeAgentExecutionPolicy = coordinator
    ? {
        id: "coordinator-read-only",
        sandbox: "provider",
        approvals: "deny",
        projectResources: false,
        // Codex's own tool names, kept because its config consumes them
        // directly. Every other bridge reads `capabilityPolicy` instead, which
        // is why the same policy object can now be handed to any of them.
        toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
        capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
        networkAccess: "restricted",
      }
    : {
        id: pipeline ? "pipeline" : container ? "interactive-container" : "interactive-host",
        sandbox: container ? "container" : "provider",
        approvals: pipeline || container ? "auto-approve" : "ask",
        projectResources: container,
        networkAccess: environment.networkAccessMode,
      };

  // Coordinator safety is not user-overridable. All other policies can be
  // tightened or loosened through the per-environment settings tier.
  if (coordinator || !override) return policy;
  return {
    ...policy,
    ...override,
    id: policy.id,
    ...(override.toolPolicy
      ? {
          toolPolicy: {
            ...(override.toolPolicy.allow ? { allow: [...override.toolPolicy.allow] } : {}),
            ...(override.toolPolicy.deny ? { deny: [...override.toolPolicy.deny] } : {}),
          },
        }
      : {}),
  };
}
