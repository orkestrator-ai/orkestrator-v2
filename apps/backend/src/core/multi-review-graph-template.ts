/**
 * The template a graph-engine Multi Review runs (item 301, plan Phase 3, D5).
 *
 * It is the built-in Multi Review template (`builtins/multi-review.ts`) inlined
 * as a copy: its `engine` is dropped, so the graph runtime runs it, and two
 * launch values the built-in leaves to its engine become explicit:
 *
 * - `targetBranch` is a string parameter, which agent prompts read
 *   (`graph-agent-host.ts`), and a literal on the two system nodes that use
 *   it (system parameters take no references), so the copy is built per
 *   launch;
 * - `reviewInstruction` is a string parameter only the discovery review reads
 *   (`graph-agent-builtins.ts`).
 *
 * The copy keeps the built-in's id and revision, so a run's template names
 * the built-in it came from. Nothing here holds content beyond the launch's
 * own branch name. Browser-free backend code.
 */
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import { multiReviewBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";

/** The parameter agent prompts read their target branch from. */
export const MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM = "targetBranch";
/** The parameter the discovery review reads its instruction from. */
export const MULTI_REVIEW_GRAPH_INSTRUCTION_PARAM = "reviewInstruction";

/** System nodes of the copy that take the target branch as a literal. */
const TARGET_BRANCH_SYSTEM_NODES = new Set(["package", "pr"]);

/**
 * Whether a review instruction fits a graph string parameter. A longer one
 * cannot run on the graph engine; the service starts that review on the
 * bespoke engine instead and says so in its log line.
 */
export function multiReviewInstructionFitsGraph(instruction: string | undefined): boolean {
  return (
    instruction === undefined ||
    new TextEncoder().encode(instruction).length <= GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes
  );
}

/** The built-in Multi Review template as the graph runtime runs it for one launch. */
export function multiReviewGraphEngineTemplate(input: { targetBranch: string }): GraphTemplateV1 {
  const template = multiReviewBuiltInTemplate();
  delete template.engine;
  template.description =
    "Multi Review on the graph runtime (item 301): the built-in template inlined as a copy, with the review's target branch and instruction as parameters.";
  template.parameters = [
    ...(template.parameters ?? []),
    {
      key: MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM,
      label: "Target branch",
      description: "The branch the review compares against and the pull request targets.",
      type: "string",
      default: input.targetBranch,
    },
    {
      key: MULTI_REVIEW_GRAPH_INSTRUCTION_PARAM,
      label: "Review instruction",
      description: "What the reviewers should focus on; empty for the default review.",
      type: "string",
      default: "",
      maxBytes: GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes,
    },
  ];
  template.nodes = template.nodes.map((node) =>
    node.kind === "system" && TARGET_BRANCH_SYSTEM_NODES.has(node.id)
      ? { ...node, params: { ...node.params, targetBranch: input.targetBranch } }
      : node,
  );
  return template;
}
