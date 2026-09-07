import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import type {
  NativeAgentExecutionPolicy,
  NativeAgentExecutionPolicyOverride,
} from "@orkestrator/protocol/native-agent";
import type { Environment } from "./models.js";

/** Shown when the resolved session does not apply the environment's restriction. */
export const UNAPPLIED_NETWORK_RESTRICTION_NOTE =
  "This environment requests restricted network access, which this session does not apply. Set both a sandbox and restricted network access under Settings -> Execution policy to enforce it.";

/** Shown when an override asked for a restriction and got the sandbox that applies it. */
export const SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE =
  "Restricted network access is enforced by the provider sandbox, so this session runs sandboxed.";

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
        toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
        networkAccess: "restricted",
      }
    : {
        id: pipeline ? "pipeline" : container ? "interactive-container" : "interactive-host",
        // A container is its own boundary, so the isolation lives there and the
        // vendor sandbox stays off. On a host we also run unsandboxed: every
        // vendor sandbox holds `.git` read-only, which stalls ordinary Git work
        // in a worktree on an approval the session then has to answer. No
        // sandbox is the honest default for a checkout the user already trusts;
        // tighten it per environment under Settings -> Execution policy.
        sandbox: container ? "container" : "none",
        // Approvals follow that decision rather than the origin. An unsandboxed
        // session has no boundary to escalate at, so a prompt would only ever
        // collect a "yes" the user cannot meaningfully refuse; a container
        // already holds the boundary. `ask` stays reachable as an override for
        // an environment that wants a human in the loop.
        approvals: "auto-approve",
        projectResources: container,
        // A container enforces its own network boundary, so it can honour what
        // the environment asked for. An unsandboxed host session has no such
        // mechanism, so it reports the access it actually has rather than a
        // restriction nothing applies; `reconcileNetworkAccess` then says so.
        networkAccess: container ? environment.networkAccessMode : "full",
      };

  // Coordinator safety is not user-overridable. All other policies can be
  // tightened or loosened through the per-environment settings tier.
  if (coordinator) return policy;
  const restrictionRequested = environment.networkAccessMode === "restricted";
  if (!override) return reconcileNetworkAccess(policy, restrictionRequested);
  return reconcileNetworkAccess(
    {
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
    },
    restrictionRequested,
  );
}

/**
 * Keep the network axis of a policy something a provider can actually apply.
 *
 * `restricted` is only expressible while a sandbox is on, because every bridge
 * carries that axis as a field of the sandbox policy it hands its provider:
 * Codex resolves `sandbox: "none"` to `dangerFullAccess`, whose policy object
 * has no network field at all, and the Claude bridge omits its whole sandbox
 * block — `network` option included — unless the sandbox is `provider`. So an
 * unsandboxed request for a restriction turns the sandbox that applies it back
 * on, and an environment restriction the resolved policy does not carry is
 * disclosed rather than dropped in silence. Cursor already reconciles the first
 * case inside its own bridge; doing it here covers every provider, including
 * any added later, and keeps the agent information panel truthful.
 *
 * Neither branch fires on a default host policy, which reports the full network
 * access it has, or on a container, which carries its restriction into a real
 * boundary.
 */
function reconcileNetworkAccess(
  policy: NativeAgentExecutionPolicy,
  restrictionRequested: boolean,
): NativeAgentExecutionPolicy {
  if (policy.sandbox === "none" && policy.networkAccess === "restricted") {
    return { ...policy, sandbox: "provider", note: SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE };
  }
  if (restrictionRequested && policy.networkAccess !== "restricted") {
    return { ...policy, note: UNAPPLIED_NETWORK_RESTRICTION_NOTE };
  }
  return policy;
}
