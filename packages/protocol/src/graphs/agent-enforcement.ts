/**
 * The enforcement tier one agent node gets on a provider, and the model
 * pickers that follow from it (plan P2.9, D4; report §6.4).
 *
 * The launch dialog and the runtime both judge a node here, so what a picker
 * offers at launch is exactly what dispatch re-checks:
 *
 * - {@link graphAgentNodeEnforcement}: the tier and turn mode for one node on
 *   one provider and host, with the one documented exception (a Claude
 *   researcher runs as an ordinary turn so hosted search stays available);
 * - {@link graphRoleProviderChoices}: per role, every provider with the
 *   weakest tier over the role's agent nodes and whether it meets each
 *   node's `minEnforcement` (the picker filter);
 * - {@link graphBindingFloorProblems}: the bound models that miss a floor
 *   (a launch refuses them; dispatch fails the activation instead when the
 *   host changed in between, for example the sandbox stopped working);
 * - {@link graphActivationEnforcementView}: the applied tier and the guard
 *   results of one activation, labelled for the inspector.
 *
 * Browser-safe: the host's sandbox probe is an input. The backend passes its
 * live probe; a browser without one uses `agentEnforcementHostForOs`.
 */
import { AGENT_PLATFORMS, AGENT_PLATFORM_LABELS, type AgentPlatform } from "../agent-platforms.js";
import {
  agentEnforcementTierSatisfies,
  agentPolicyEnforcement,
  weakestAgentEnforcementTier,
  type AgentEnforcementHost,
  type AgentEnforcementTier,
} from "./capability-enforcement.js";
import type { CompiledGraphCapabilities } from "./capability-profiles.js";
import type { CompiledGraphPlan, GraphPlanAgentNode } from "./plan.js";
import type {
  GraphGuardKind,
  GraphGuardResult,
  GraphModelBinding,
  GraphRunBindings,
  NodeActivation,
} from "./run-model.js";

export const GRAPH_RESEARCHER_ON_CLAUDE_REASON =
  "Runs as an ordinary Claude turn so hosted web search stays available; file writes, the shell and fetching are denied by Claude's permission rules, not by its read-only turn.";

/** How an agent activation's turn runs. */
export type GraphAgentNodeTurnMode = "read-only" | "build";

export interface GraphAgentNodeEnforcement {
  tier: AgentEnforcementTier;
  /** Why the tier is not `enforced`, as the matrix states it (at most 512 characters). */
  reason?: string;
  turnMode: GraphAgentNodeTurnMode;
}

const TIER_ORDER: readonly AgentEnforcementTier[] = ["advisory", "provider-configured", "enforced"];

function weaker(left: AgentEnforcementTier, right: AgentEnforcementTier): AgentEnforcementTier {
  return TIER_ORDER.indexOf(left) <= TIER_ORDER.indexOf(right) ? left : right;
}

/**
 * Whether a compiled policy runs as a read-only turn on `platform`. A Claude
 * read-only turn turns hosted web search off, so a node that keeps it (the
 * `researcher` profile) runs on Claude as an ordinary turn.
 */
export function graphAgentReadOnlyTurn(
  compiled: Pick<CompiledGraphCapabilities, "readOnly" | "webSearch">,
  platform: AgentPlatform,
): boolean {
  return compiled.readOnly && !(platform === "claude" && compiled.webSearch);
}

/** The tier and turn mode a node's compiled policy gets on `platform` and `host`. */
export function graphAgentNodeEnforcement(
  compiled: Pick<CompiledGraphCapabilities, "policy" | "readOnly" | "webSearch">,
  platform: AgentPlatform,
  host: AgentEnforcementHost,
): GraphAgentNodeEnforcement {
  const readOnlyTurn = graphAgentReadOnlyTurn(compiled, platform);
  const judged = agentPolicyEnforcement(compiled.policy, platform, host);
  if (compiled.readOnly && !readOnlyTurn) {
    // Claude's own permission rules hold the denials, not its read-only turn.
    return {
      tier: weaker(judged.tier, "provider-configured"),
      reason: GRAPH_RESEARCHER_ON_CLAUDE_REASON,
      turnMode: "build",
    };
  }
  return {
    tier: judged.tier,
    ...(judged.reason ? { reason: judged.reason.slice(0, 512) } : {}),
    turnMode: readOnlyTurn ? "read-only" : "build",
  };
}

/**
 * The person-facing refusal when a tier misses a node's floor, or null when
 * it meets it. Names the provider, the tier, the floor and the matrix's
 * reason, so a tier that dropped since launch says why.
 */
export function graphAgentFloorMessage(
  node: Pick<GraphPlanAgentNode, "id" | "label" | "minEnforcement">,
  platform: AgentPlatform,
  enforcement: Pick<GraphAgentNodeEnforcement, "tier" | "reason">,
): string | null {
  const floor = node.minEnforcement;
  if (!floor || agentEnforcementTierSatisfies(enforcement.tier, floor)) return null;
  const reason = enforcement.reason ? ` ${enforcement.reason}` : "";
  return `${AGENT_PLATFORM_LABELS[platform]} holds step ${node.label ?? node.id} only at ${enforcement.tier} on this host, below the step's floor (${floor}), so it was not started.${reason}`.slice(
    0,
    1_000,
  );
}

export interface GraphRoleProviderChoice {
  platform: AgentPlatform;
  /** The weakest tier over the role's agent nodes. */
  tier: AgentEnforcementTier;
  /** The matrix's reason for that tier, when it is not `enforced`. */
  reason?: string;
  /** Meets every floor of the role's nodes: the picker offers it. */
  allowed: boolean;
  /** The first node whose floor it misses. */
  blockedBy?: { nodeId: string; tier: AgentEnforcementTier; floor: AgentEnforcementTier };
}

export interface GraphRoleProviders {
  role: string;
  /** Agent nodes bound to the role, in plan order. */
  nodes: string[];
  /** The strongest floor among them, if any has one. */
  floor?: AgentEnforcementTier;
  choices: GraphRoleProviderChoice[];
}

function agentNodes(plan: Pick<CompiledGraphPlan, "nodes">): GraphPlanAgentNode[] {
  return plan.nodes
    .filter((node): node is GraphPlanAgentNode => node.kind === "agent")
    .sort((left, right) => left.order - right.order);
}

/**
 * The launch pickers' providers per role: each platform in `platforms` (the
 * enabled ones) with its tier for the role and whether it meets every floor.
 * Roles no agent node uses are omitted.
 */
export function graphRoleProviderChoices(
  plan: Pick<CompiledGraphPlan, "nodes" | "roles">,
  host: AgentEnforcementHost,
  platforms: readonly AgentPlatform[] = AGENT_PLATFORMS,
): GraphRoleProviders[] {
  const nodes = agentNodes(plan);
  const result: GraphRoleProviders[] = [];
  for (const role of plan.roles) {
    const bound = nodes.filter((node) => node.role === role.key);
    if (bound.length === 0) continue;
    const floors = bound.flatMap((node) => (node.minEnforcement ? [node.minEnforcement] : []));
    const floor = floors.length > 0 ? strongest(floors) : undefined;
    const choices = platforms.map((platform): GraphRoleProviderChoice => {
      const judged = bound.map((node) => ({
        node,
        enforcement: graphAgentNodeEnforcement(node.capabilities, platform, host),
      }));
      const tier = weakestAgentEnforcementTier(judged.map((entry) => entry.enforcement.tier));
      const reason = judged.find(
        (entry) => entry.enforcement.tier === tier && entry.enforcement.reason,
      )?.enforcement.reason;
      const missed = judged.find(
        (entry) =>
          entry.node.minEnforcement &&
          !agentEnforcementTierSatisfies(entry.enforcement.tier, entry.node.minEnforcement),
      );
      return {
        platform,
        tier,
        ...(reason ? { reason } : {}),
        allowed: !missed,
        ...(missed
          ? {
              blockedBy: {
                nodeId: missed.node.id,
                tier: missed.enforcement.tier,
                floor: missed.node.minEnforcement!,
              },
            }
          : {}),
      };
    });
    result.push({
      role: role.key,
      nodes: bound.map((node) => node.id),
      ...(floor ? { floor } : {}),
      choices,
    });
  }
  return result;
}

function strongest(tiers: readonly AgentEnforcementTier[]): AgentEnforcementTier {
  return tiers.reduce((best, tier) =>
    TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(best) ? tier : best,
  );
}

export interface GraphBindingFloorProblem {
  role: string;
  nodeId: string;
  platform: AgentPlatform;
  tier: AgentEnforcementTier;
  floor: AgentEnforcementTier;
  message: string;
}

/**
 * Every bound model (a panel's members included) whose tier misses the floor
 * of a node bound to its role. Empty when the bindings are launchable.
 */
export function graphBindingFloorProblems(
  plan: Pick<CompiledGraphPlan, "nodes">,
  roles: GraphRunBindings["roles"],
  host: AgentEnforcementHost,
): GraphBindingFloorProblem[] {
  const problems: GraphBindingFloorProblem[] = [];
  for (const node of agentNodes(plan)) {
    if (!node.minEnforcement) continue;
    const bound = roles[node.role];
    const bindings: GraphModelBinding[] =
      bound === undefined ? [] : Array.isArray(bound) ? bound : [bound];
    for (const platform of new Set(bindings.map((binding) => binding.platform))) {
      const enforcement = graphAgentNodeEnforcement(node.capabilities, platform, host);
      const message = graphAgentFloorMessage(node, platform, enforcement);
      if (!message) continue;
      problems.push({
        role: node.role,
        nodeId: node.id,
        platform,
        tier: enforcement.tier,
        floor: node.minEnforcement,
        message,
      });
    }
  }
  return problems;
}

/** How the inspector names each guard (item 211 shows them). */
export const GRAPH_GUARD_LABELS: Readonly<Record<GraphGuardKind, string>> = Object.freeze({
  "read-only": "Read-only workspace",
  "remote-ref": "No pushes",
  enforcement: "Enforcement floor",
  worktree: "Isolated worktree",
});

export interface GraphActivationEnforcementView {
  /** The tier actually applied; absent before the activation was judged. */
  tier?: AgentEnforcementTier;
  reason?: string;
  /** Each guard's newest result, in record order, with its label. */
  guards: Array<GraphGuardResult & { label: string }>;
  /** A guard was violated or could not judge, and the activation failed on it. */
  failedOnGuard: boolean;
}

/**
 * What the inspector shows for an activation's enforcement (P2.9): the tier
 * and reason recorded before dispatch, and the guard results with labels. A
 * guard that could not judge an activation recorded before the guards
 * existed is `unavailable` without failing it, so `failedOnGuard` reads the
 * activation's own cause.
 */
export function graphActivationEnforcementView(
  activation: Pick<NodeActivation, "enforcement" | "enforcementReason" | "guards" | "errorCause">,
): GraphActivationEnforcementView {
  return {
    ...(activation.enforcement ? { tier: activation.enforcement } : {}),
    ...(activation.enforcementReason ? { reason: activation.enforcementReason } : {}),
    guards: (activation.guards ?? []).map((result) => ({
      ...result,
      label: GRAPH_GUARD_LABELS[result.guard],
    })),
    failedOnGuard: activation.errorCause === "guard-violation",
  };
}
