import { useMemo } from "react";
import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  agentPolicyEnforcementMatrix,
  compileGraphCapabilities,
  type CompiledGraphCapabilities,
  type GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_COMPILE_DEFAULT_ENVIRONMENT,
  GRAPH_COMPILE_DEFAULT_HOST,
  type GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import type { GraphAgentNode } from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import { GRAPH_ENFORCEMENT_LABELS } from "./graph-designer-model";

/**
 * The per-provider enforcement matrix of an agent node (item 106): how
 * strongly each provider holds the node's compiled policy. Shared by the
 * read-only inspector (110) and the capabilities form (212).
 */

/** The node's compiled capabilities: the plan's, else compiled in the browser. */
export function useGraphNodeCapabilities(
  node: GraphAgentNode,
  planNode: GraphPlanNode | undefined,
  ceiling: GraphCapabilityCeiling | undefined,
): CompiledGraphCapabilities | null {
  return useMemo(() => {
    if (planNode?.kind === "agent") return planNode.capabilities;
    try {
      return compileGraphCapabilities({
        spec: node.capabilities,
        environment: GRAPH_COMPILE_DEFAULT_ENVIRONMENT,
        ...(ceiling ? { ceiling } : {}),
      });
    } catch {
      return null;
    }
  }, [planNode, node.capabilities, ceiling]);
}

export function GraphEnforcementMatrix({
  compiled,
  providers,
}: {
  compiled: CompiledGraphCapabilities;
  /** Enabled providers; the matrix marks the others. */
  providers: readonly AgentPlatform[];
}) {
  const matrix = useMemo(
    () => agentPolicyEnforcementMatrix(compiled.policy, GRAPH_COMPILE_DEFAULT_HOST),
    [compiled],
  );
  return (
    <>
      <table data-graph-enforcement-matrix="" className="w-full border-collapse text-left">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-0.5 pr-2 font-normal">Provider</th>
            <th className="py-0.5 font-normal">Tier</th>
          </tr>
        </thead>
        <tbody>
          {AGENT_PLATFORMS.map((platform) => {
            const judgement = matrix[platform];
            if (!judgement) return null;
            const enabled = providers.length === 0 || providers.includes(platform);
            return (
              <tr
                key={platform}
                data-graph-enforcement-provider={platform}
                className={cn("align-top", !enabled && "opacity-50")}
              >
                <td className="py-0.5 pr-2 whitespace-nowrap">
                  {AGENT_PLATFORM_LABELS[platform]}
                  {enabled ? "" : " (off)"}
                </td>
                <td className="py-0.5">
                  <span
                    className={cn(
                      judgement.tier === "enforced" && "text-emerald-300",
                      judgement.tier === "provider-configured" && "text-sky-300",
                      judgement.tier === "advisory" && "text-amber-300",
                    )}
                  >
                    {GRAPH_ENFORCEMENT_LABELS[judgement.tier]}
                  </span>
                  {judgement.reason ? (
                    <p className="text-muted-foreground">{judgement.reason}</p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-muted-foreground">
        Rated without a Claude command sandbox, the conservative answer when the host is not probed;
        the backend compile uses the probed host.
      </p>
    </>
  );
}
