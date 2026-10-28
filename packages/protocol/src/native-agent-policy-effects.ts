/**
 * What an execution policy means in practice, one axis at a time.
 *
 * Agent Info renders this model rather than the raw policy fields, and the
 * execution-policy conformance suite (`tests/conformance/execution-policy`)
 * decodes the options each adapter actually hands its SDK or CLI into the
 * same axes and compares the two. A summary and an adapter that disagree on an
 * axis therefore fail a test instead of quietly telling the user something the
 * agent does not do.
 *
 * Each bridge reports the policy it applies, not the one it was sent: where an
 * agent cannot apply an axis, the reported policy says what is true instead
 * and its `note` says why (`withoutProviderSandbox`, `appendNativeAgentPolicyNote`).
 */
import type { NativeAgentExecutionPolicy } from "./native-agent.js";

export interface NativeAgentPolicyEffects {
  /**
   * What confines the agent's own commands. A container is the environment's
   * boundary, outside every adapter; a provider sandbox is the vendor's, which
   * the adapter has to turn on.
   */
  isolation: "container" | "provider-sandbox" | "none";
  /**
   * What becomes of an action the session has not already allowed: a person
   * is asked, it runs, or it is refused. Inside a sandbox, "runs" still means
   * inside it.
   */
  approvals: "ask" | "auto-approve" | "deny";
  /**
   * Whether repository-owned configuration loads: project settings, hooks, MCP
   * servers, extensions, plugins and skills. Instruction files such as
   * `AGENTS.md` are not part of this axis.
   */
  projectResources: boolean;
  /** Whether the agent's commands can reach the network. */
  network: "full" | "restricted";
  /** A capability denial also removes provider-hosted internet tools. */
  networkDenial?: "all" | "except-hosted-search";
  /**
   * What holds a restriction: the container's firewall, the provider sandbox,
   * or a toolset with nothing that can reach the network. Absent for full access.
   */
  networkHeldBy?: "container" | "provider-sandbox" | "toolset";
}

export function nativeAgentPolicyEffects(
  policy: NativeAgentExecutionPolicy,
): NativeAgentPolicyEffects {
  const isolation =
    policy.sandbox === "container"
      ? "container"
      : policy.sandbox === "provider"
        ? "provider-sandbox"
        : "none";
  return {
    isolation,
    approvals: policy.approvals,
    projectResources: policy.projectResources,
    network: policy.networkAccess,
    ...(policy.capabilityPolicy?.deny.includes("network")
      ? {
          networkDenial:
            !policy.capabilityPolicy.deny.includes("web.search") &&
            policy.capabilityPolicy.allow?.includes("web.search")
              ? ("except-hosted-search" as const)
              : ("all" as const),
        }
      : {}),
    ...(policy.networkAccess === "restricted"
      ? {
          networkHeldBy:
            isolation === "none" ||
            (isolation === "container" && policy.containerNetworkAccess === "full")
              ? ("toolset" as const)
              : isolation,
        }
      : {}),
  };
}

export const SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE =
  "Restricted network access is enforced by the provider sandbox, so this session runs sandboxed.";

/** Stable, provider-neutral copy for the agent information panel. */
export function describeNativeAgentPolicyEffects(effects: NativeAgentPolicyEffects): string {
  const isolation =
    effects.isolation === "container"
      ? "Container sandbox"
      : effects.isolation === "provider-sandbox"
        ? "Provider sandbox"
        : "No sandbox";
  const approvals =
    effects.approvals === "ask"
      ? "approvals on request"
      : effects.approvals === "deny"
        ? "approvals denied"
        : "approvals off";
  const network =
    effects.networkDenial === "all"
      ? "no network, web search and web fetch off"
      : effects.networkDenial === "except-hosted-search"
        ? "no network except hosted web search, web fetch off"
        : `${effects.network} network`;
  return `${isolation}, ${approvals}, project resources ${effects.projectResources ? "on" : "off"}, ${network}`;
}

/** Add a caveat to a policy, keeping any it already carries. */
export function appendNativeAgentPolicyNote(
  policy: NativeAgentExecutionPolicy,
  note: string,
): NativeAgentExecutionPolicy {
  return { ...policy, note: policy.note ? `${policy.note} ${note}` : note };
}

/** Why a session reports the read-only policy rather than its own. */
export const READ_ONLY_TURN_POLICY_NOTE =
  "The current turn is read-only, so it runs under the read-only policy rather than this session's own.";

/**
 * What a bridge reports while a `readOnly` turn runs: the policy that turn
 * applies, marked so Agent Info says why it differs from the session's.
 */
export function readOnlyTurnReportedPolicy(
  turnPolicy: NativeAgentExecutionPolicy,
  options: {
    /**
     * Why the provider's command sandbox cannot run where this turn runs, when
     * the turn therefore runs its commands without it (Claude on a Linux host
     * without a working bubblewrap).
     */
    commandSandboxOff?: string;
  } = {},
): NativeAgentExecutionPolicy {
  const reported = appendNativeAgentPolicyNote(turnPolicy, READ_ONLY_TURN_POLICY_NOTE);
  if (options.commandSandboxOff === undefined) return reported;
  return appendNativeAgentPolicyNote(
    // Isolation says what holds now: no OS sandbox. The network stays
    // restricted because no admitted tool or command can reach it.
    { ...reported, sandbox: reported.sandbox === "provider" ? "none" : reported.sandbox },
    readOnlyCommandSandboxOffNote(options.commandSandboxOff),
  );
}

/** Bound on a stored reason why a read-only turn's command sandbox was off. */
export const READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS = 1_024;

/**
 * What a read-only turn whose commands ran without the provider's command
 * sandbox says about its boundary, in Agent Info and on a Multi Review step.
 */
export function readOnlyCommandSandboxOffNote(reason: string): string {
  return `Commands run without the command sandbox, so the read-only command filter and tool allowlist are their only boundary. ${reason}`;
}

/**
 * The policy an agent with no sandbox of its own actually runs under.
 *
 * Pi, Grok and OpenCode have no switch for `sandbox: "provider"`, so their
 * commands run unsandboxed whatever the backend asked for, and a network
 * restriction held only by that sandbox is not held at all. The one exception
 * is a session whose toolset already refuses every command and fetch (a
 * read-only coordinator, or `deny` where nothing asks): its commands cannot
 * reach the network because it cannot run any. A container keeps both axes;
 * the container, not the agent, holds them.
 */
export function withoutProviderSandbox(
  policy: NativeAgentExecutionPolicy,
  options: { agent: string; toolsetBlocksNetwork: boolean },
): NativeAgentExecutionPolicy {
  if (policy.sandbox === "container") return policy;
  const sandboxed = policy.sandbox === "provider";
  const container = policy.containerNetworkAccess !== undefined;
  const losesRestriction =
    policy.networkAccess === "restricted" &&
    policy.containerNetworkAccess !== "restricted" &&
    !options.toolsetBlocksNetwork;
  if (!sandboxed && !losesRestriction) return policy;
  const applied: NativeAgentExecutionPolicy = {
    ...policy,
    sandbox: container ? "container" : "none",
    // The old sandbox explanation is no longer true, even if the toolset or
    // outer firewall still holds the restriction. Keep unrelated caveats.
    note: policy.note?.replace(SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE, "").trim() || undefined,
    ...(losesRestriction ? { networkAccess: "full" as const } : {}),
  };
  const network = losesRestriction
    ? " with full network access"
    : policy.networkAccess === "restricted"
      ? "; it has no tool that can reach the network"
      : "";
  return appendNativeAgentPolicyNote(
    applied,
    container
      ? `${options.agent} has no sandbox of its own; this session keeps the container boundary.${applied.networkAccess === "restricted" && policy.containerNetworkAccess === "full" ? " Tool denials restrict network access." : ""}`
      : `${options.agent} has no sandbox of its own, so this session runs unsandboxed${network}.`,
  );
}
