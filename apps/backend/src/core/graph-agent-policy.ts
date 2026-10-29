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
 * reason says so. The judgement itself is the protocol's
 * `graphAgentNodeEnforcement`, shared with the launch pickers.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  graphAgentFloorMessage,
  graphAgentNodeEnforcement,
} from "@orkestrator/protocol/graphs/agent-enforcement";
import {
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

export {
  GRAPH_RESEARCHER_ON_CLAUDE_REASON,
  graphAgentReadOnlyTurn,
} from "@orkestrator/protocol/graphs/agent-enforcement";

export interface GraphAgentPolicyDecision {
  compiled: CompiledGraphCapabilities;
  turnMode: GraphAgentTurnMode;
  enforcement: GraphEnforcementTier;
  enforcementReason?: string;
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
  // The same judgement the launch pickers make (`graphRoleProviderChoices`).
  const judged = graphAgentNodeEnforcement(compiled, input.platform, input.host);
  return {
    compiled,
    turnMode: judged.turnMode,
    enforcement: judged.tier,
    ...(judged.reason ? { enforcementReason: judged.reason } : {}),
  };
}

/**
 * The node's enforcement floor check at dispatch (P2.9, item 209), judged on
 * the live host. Null when the tier meets the floor; otherwise the message
 * the activation fails with, naming the provider, tier, floor and reason.
 */
export function graphAgentFloorProblem(
  node: Pick<GraphPlanAgentNode, "id" | "label" | "minEnforcement">,
  platform: AgentPlatform,
  enforcement: { tier: GraphEnforcementTier; reason?: string },
): string | null {
  return graphAgentFloorMessage(node, platform, enforcement);
}
