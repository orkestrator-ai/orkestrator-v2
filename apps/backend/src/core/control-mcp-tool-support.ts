/**
 * Helpers shared by the Control MCP tool modules (`control-mcp-tools.ts` and
 * `control-mcp-coordinator-tools.ts`): small value guards, the plain tool
 * result, annotations, and the schemas and checks several coordinator tools
 * reuse.
 */

import { z } from "zod";
import {
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
  buildStepInstructionsBytes,
  isBuildStepInstructions,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  REVIEW_LENS_LABEL_MAX_CHARS,
  reviewLensInstructionBytes,
  reviewLensInstructionError,
  reviewLensLabelError,
} from "@orkestrator/protocol/review-lens";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/** The field every environment and workflow tool takes to act on another node. */
export const nodeIdField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "A nodeId from list_nodes: act on that machine (for a coordinator, on that node's copy of this project). Omit for this machine.",
  );

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A coordinator launch must name a real branch that contains the commit.
 *
 * That admits the base branch's tip and the checkout's own HEAD alike, and
 * rejects a commit copied from somewhere else or a branch that has moved away
 * from it, instead of silently starting the worker somewhere unexpected.
 */
export async function assertCoordinatorLaunchBaseOnBranch(
  invoke: ControlMcpInvoker,
  projectId: string,
  input: { baseBranch?: string; baseCommit?: string },
): Promise<void> {
  if (!input.baseBranch || !input.baseCommit) {
    throw new Error("Coordinator launches require an explicit baseBranch and baseCommit");
  }
  let verified: unknown;
  try {
    verified = await invoke<unknown>("verify_project_launch_base", {
      projectId,
      branch: input.baseBranch,
      commit: input.baseCommit,
    });
  } catch (error) {
    throw new Error(
      `Coordinator launch base could not be verified: ${
        error instanceof Error ? error.message : "git verification failed"
      }. Refresh get_launch_options and retry.`,
    );
  }
  if (!isRecord(verified) || verified.contained !== true) {
    const reason = isRecord(verified) ? nonEmptyString(verified.reason) : null;
    throw new Error(
      `Coordinator launch base ${input.baseBranch} @ ${input.baseCommit} is not valid${
        reason ? ` (${reason})` : ""
      }. Refresh get_launch_options and retry.`,
    );
  }
}

export function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function toolResult(value: JsonRecord, summary: JsonRecord = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: value,
  };
}

const buildStepFields = {
  agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
  model: z.string().trim().min(1).max(500).optional(),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
  fastMode: z.boolean().optional(),
  instructions: z
    .string()
    .refine(isBuildStepInstructions, {
      error: `instructions must be at most ${MAX_BUILD_STEP_INSTRUCTIONS_BYTES} bytes of UTF-8 (16 KiB).`,
    })
    .optional()
    .describe(
      "Optional. The user's own instructions for this step, at most 16 KiB. The step's prompt carries them after its own contract; Fix uses the build step's. Set only when the user asks for them.",
    ),
};

/**
 * A reviewer's focus. Both parts are the caller's text, so the bounds are the
 * protocol's (`review-lens.ts`), checked here so the tool refuses before the
 * launch does.
 */
export const reviewLensSchema = z
  .object({
    label: z.string().refine((label) => reviewLensLabelError(label) === null, {
      error: `lens.label must be one non-blank line of at most ${REVIEW_LENS_LABEL_MAX_CHARS} characters.`,
    }),
    instruction: z.string().refine((text) => reviewLensInstructionError(text) === null, {
      error: `lens.instruction must be non-blank and at most ${REVIEW_LENS_INSTRUCTION_MAX_BYTES} bytes of UTF-8 (4 KiB).`,
    }),
  })
  .strict()
  .describe(
    "Optional. This reviewer's focus: a short label (at most 64 characters) and an instruction (at most 4 KiB) saying what to look at hardest. The reviewer still reports critical issues outside it. Omit to use the saved focus for this position (only when reviewers are omitted) or none. Set only when the user asks for a focus.",
  );

/**
 * One build step's harness and model. Unlike a Multi Review row the model is
 * optional: naming only an agent runs that agent's own saved model.
 */
export const buildStepSchema = z.object(buildStepFields).strict();

/** A Build Pipeline reviewer row: a step that may also carry a focus. */
export const buildReviewerSchema = z
  .object({ ...buildStepFields, lens: reviewLensSchema.optional() })
  .strict();

/**
 * A named pipeline step. The agent is optional so that a step naming only
 * `instructions` keeps its saved agent and model
 * (`buildPipelineInputWithDefaults`).
 */
export const buildStepOverrideSchema = z
  .object({ ...buildStepFields, agent: buildStepFields.agent.optional() })
  .strict();

/**
 * A step as the start result reports it: the caller already has the text of
 * its instructions, so the result says how many bytes the pipeline stored.
 */
function selectedStep(step: unknown): unknown {
  if (!isRecord(step)) return step;
  const { instructions, lens, ...rest } = step;
  return {
    ...rest,
    ...(typeof instructions === "string"
      ? { instructionsBytes: buildStepInstructionsBytes(instructions) }
      : {}),
    ...selectedLens(lens),
  };
}

/**
 * A reviewer's lens as a result reports it: the label, which names the focus,
 * and the size of the instruction the caller already has.
 */
export function selectedLens(lens: unknown): {
  lens?: { label: string; instructionBytes: number };
} {
  if (!isRecord(lens) || typeof lens.label !== "string" || typeof lens.instruction !== "string")
    return {};
  return {
    lens: { label: lens.label, instructionBytes: reviewLensInstructionBytes(lens.instruction) },
  };
}

/** What a started build runs, and which choices the caller made. */
export function buildPipelineSelection(
  record: JsonRecord,
  input: {
    agentType?: unknown;
    steps?: Record<string, unknown>;
    reviewers?: unknown;
    reviewPreparation?: unknown;
  },
): JsonRecord {
  const source = (requested: boolean) => (requested ? "requested" : "default");
  const steps = isRecord(record.steps) ? record.steps : {};
  return {
    agentType: record.agentType ?? null,
    steps: Object.fromEntries(
      Object.entries(steps).map(([key, step]) => [key, selectedStep(step)]),
    ),
    reviewers: Array.isArray(record.reviewers) ? record.reviewers.map(selectedStep) : [],
    reviewPreparation: selectedStep(record.reviewPreparation ?? null),
    source: {
      agentType: source(input.agentType !== undefined || input.steps?.build !== undefined),
      steps: Object.fromEntries(
        Object.keys(steps).map((key) => [key, source(input.steps?.[key] !== undefined)]),
      ),
      reviewers: source(input.reviewers !== undefined),
      reviewPreparation: source(input.reviewPreparation !== undefined),
    },
  };
}

export const agentSelectionSchema = z.object({
  agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
  model: z.string().trim().min(1).max(500),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
});

/** A Multi Review reviewer row: a selection that may carry the reviewer's focus. */
export const reviewerSelectionSchema = agentSelectionSchema.extend({
  lens: reviewLensSchema.optional(),
});

export function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/** `nodeId` of a list that can also span every machine. */
export const listNodeIdField = nodeIdField.describe(
  "A nodeId from list_nodes: list that machine. all: this machine and every node it controls, each item tagged with its nodeId. Omit for this machine.",
);
