/**
 * The policy and enforcement tier a graph agent activation actually gets
 * (item 204 on items 106 and 201; plan P2.1, P2.9).
 *
 * The node's capability spec is compiled against the environment's real
 * execution policy and the project's ceiling (`compileGraphCapabilities`;
 * capabilities only narrow, invariant 7), and the tier is judged by the
 * shared enforcement matrix for the binding's provider on this host. Both
 * are recorded on the activation before its session exists.
 *
 * **Turn mode.** A node whose policy is read-only (no file writes, no
 * mutating shell) runs as a read-only turn: that is where every provider
 * holds its strongest boundary and what the matrix rates. One exception,
 * decided here: a Claude read-only turn turns hosted web search off, so a
 * node that keeps hosted search (the `researcher` profile) runs on Claude as
 * an ordinary turn whose policy still denies file writes, the shell and
 * fetching. Its tier is then at most `provider-configured` — Claude's own
 * permission rules hold those denials, not its read-only turn — and the
 * reason says so.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  agentEnforcementTierSatisfies,
  agentPolicyEnforcement,
  compileGraphCapabilities,
  type AgentEnforcementHost,
  type CompiledGraphCapabilities,
  type GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphAgentTurnMode } from "@orkestrator/protocol/graphs/run";
import type { GraphEnforcementTier } from "@orkestrator/protocol/graphs/template";
import type { Environment } from "./models.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";

export const GRAPH_RESEARCHER_ON_CLAUDE_REASON =
  "Runs as an ordinary Claude turn so hosted web search stays available; file writes, the shell and fetching are denied by Claude's permission rules, not by its read-only turn.";

export interface GraphAgentPolicyDecision {
  compiled: CompiledGraphCapabilities;
  turnMode: GraphAgentTurnMode;
  enforcement: GraphEnforcementTier;
  enforcementReason?: string;
}

const TIER_ORDER: readonly GraphEnforcementTier[] = ["advisory", "provider-configured", "enforced"];

function weaker(left: GraphEnforcementTier, right: GraphEnforcementTier): GraphEnforcementTier {
  return TIER_ORDER.indexOf(left) <= TIER_ORDER.indexOf(right) ? left : right;
}

/** Whether a compiled policy runs as a read-only turn on `platform` (see the module note). */
export function graphAgentReadOnlyTurn(
  compiled: Pick<CompiledGraphCapabilities, "readOnly" | "webSearch">,
  platform: AgentPlatform,
): boolean {
  return compiled.readOnly && !(platform === "claude" && compiled.webSearch);
}

/** Compiles the node's capabilities for this environment and judges the tier on `platform`. */
export function graphAgentPolicy(input: {
  node: GraphPlanAgentNode;
  environment: Pick<Environment, "environmentType" | "networkAccessMode" | "agentSettings">;
  ceiling?: GraphCapabilityCeiling;
  platform: AgentPlatform;
  host: AgentEnforcementHost;
}): GraphAgentPolicyDecision {
  const spec = input.node.capabilities.spec;
  // Resolved for an unattended origin either way: read-only nodes are
  // automated reviewers, writers non-interactive build sessions.
  const probe = compileGraphCapabilities({
    spec,
    environment: resolveEnvironmentExecutionPolicy(input.environment, "automated-review"),
    ...(input.ceiling ? { ceiling: input.ceiling } : {}),
  });
  const compiled = probe.readOnly
    ? probe
    : compileGraphCapabilities({
        spec,
        environment: resolveEnvironmentExecutionPolicy(input.environment, "build-pipeline"),
        ...(input.ceiling ? { ceiling: input.ceiling } : {}),
      });
  const readOnlyTurn = graphAgentReadOnlyTurn(compiled, input.platform);
  const judged = agentPolicyEnforcement(compiled.policy, input.platform, input.host);
  if (compiled.readOnly && !readOnlyTurn) {
    const tier = weaker(judged.tier, "provider-configured");
    return {
      compiled,
      turnMode: "build",
      enforcement: tier,
      enforcementReason: GRAPH_RESEARCHER_ON_CLAUDE_REASON,
    };
  }
  return {
    compiled,
    turnMode: readOnlyTurn ? "read-only" : "build",
    enforcement: judged.tier,
    ...(judged.reason ? { enforcementReason: judged.reason.slice(0, 512) } : {}),
  };
}

/**
 * The node's enforcement floor check at dispatch (P2.9 re-checks it; item
 * 209 owns the guard). Null when the tier meets the floor.
 */
export function graphAgentFloorProblem(
  node: Pick<GraphPlanAgentNode, "minEnforcement">,
  tier: GraphEnforcementTier,
): string | null {
  if (!node.minEnforcement || agentEnforcementTierSatisfies(tier, node.minEnforcement)) return null;
  return `The provider's enforcement is ${tier}, below this step's floor (${node.minEnforcement})`;
}
