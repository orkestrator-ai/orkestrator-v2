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
 * One build step's harness and model. Unlike a Multi Review row the model is
 * optional: naming only an agent runs that agent's own saved model.
 */
export const buildStepSchema = z.object(buildStepFields).strict();

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
  if (!isRecord(step) || typeof step.instructions !== "string") return step;
  const { instructions, ...rest } = step;
  return { ...rest, instructionsBytes: buildStepInstructionsBytes(instructions) };
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
