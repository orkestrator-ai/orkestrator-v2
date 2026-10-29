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
 * - `reviewInstruction` is an optional `markdown@1` run input wired to the
 *   discovery review's `instruction` port, which the built-in writes where
 *   today's reviewer prompt has the user's instruction
 *   (`graph-agent-builtins.ts`). A run input holds up to the type's budget
 *   (128 KiB), where a string parameter held 4 KiB; an instruction past it
 *   refuses the start rather than switching engines.
 *
 * The copy keeps the built-in's id and revision, so a run's template names
 * the built-in it came from. Nothing here holds content beyond the launch's
 * own branch name. Browser-free backend code.
 */
import { multiReviewBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType, validateGraphArtifactValue } from "@orkestrator/protocol/graphs/types";

/** The parameter agent prompts read their target branch from. */
export const MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM = "targetBranch";
/** The run input that carries the review instruction to the discovery review. */
export const MULTI_REVIEW_GRAPH_INSTRUCTION_INPUT = "reviewInstruction";
/** The run input's type: the largest text budget of the built-in types. */
export const MULTI_REVIEW_GRAPH_INSTRUCTION_TYPE = "markdown@1";
/** The discovery review's port the run input fills (the built-in's `instruction` input). */
const REVIEW_INSTRUCTION_PORT = "instruction";

/** System nodes of the copy that take the target branch as a literal. */
const TARGET_BRANCH_SYSTEM_NODES = new Set(["package", "pr"]);

/** The run input value of a review instruction; undefined when there is none. */
export function multiReviewGraphInstructionValue(
  instruction: string | undefined,
): { markdown: string } | undefined {
  return instruction?.trim() ? { markdown: instruction } : undefined;
}

/**
 * Why a review instruction cannot be the graph run's input (it exceeds the
 * `markdown@1` budget), or null when it can. Content-free: sizes only.
 */
export function multiReviewGraphInstructionProblem(instruction: string | undefined): string | null {
  const value = multiReviewGraphInstructionValue(instruction);
  if (!value) return null;
  const definition = graphBuiltInType(MULTI_REVIEW_GRAPH_INSTRUCTION_TYPE)!;
  if (validateGraphArtifactValue(definition, value).length === 0) return null;
  const limit = definition.budgets.maxBytes;
  return `The review instruction is too long for Multi Review on the graph runtime, which takes at most ${limit} bytes (${Math.floor(limit / 1024)} KiB, encoded). Shorten it, or start the review with the Multi Review engine set to bespoke.`;
}

/** The built-in Multi Review template as the graph runtime runs it for one launch. */
export function multiReviewGraphEngineTemplate(input: { targetBranch: string }): GraphTemplateV1 {
  const template = multiReviewBuiltInTemplate();
  delete template.engine;
  template.description =
    "Multi Review on the graph runtime (item 301): the built-in template inlined as a copy, with the review's target branch as a parameter and its instruction as a run input.";
  template.parameters = [
    ...(template.parameters ?? []),
    {
      key: MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM,
      label: "Target branch",
      description: "The branch the review compares against and the pull request targets.",
      type: "string",
      default: input.targetBranch,
    },
  ];
  template.inputs = [
    ...template.inputs,
    {
      name: MULTI_REVIEW_GRAPH_INSTRUCTION_INPUT,
      type: MULTI_REVIEW_GRAPH_INSTRUCTION_TYPE,
      label: "Review instruction",
      description: "What the reviewers should focus on; absent for the default review.",
      required: false,
    },
  ];
  template.nodes = template.nodes.map((node) => {
    if (node.kind === "system" && TARGET_BRANCH_SYSTEM_NODES.has(node.id)) {
      return { ...node, params: { ...node.params, targetBranch: input.targetBranch } };
    }
    if (node.kind === "agent" && node.id === "review") {
      return {
        ...node,
        inputs: [
          ...(node.inputs ?? []),
          {
            name: REVIEW_INSTRUCTION_PORT,
            type: MULTI_REVIEW_GRAPH_INSTRUCTION_TYPE,
            render: "markdown" as const,
            required: false,
          },
        ],
      };
    }
    return node;
  });
  template.edges = [
    ...template.edges,
    {
      id: "instruction-review",
      from: { input: MULTI_REVIEW_GRAPH_INSTRUCTION_INPUT },
      to: { node: "review", port: REVIEW_INSTRUCTION_PORT },
    },
  ];
  return template;
}
