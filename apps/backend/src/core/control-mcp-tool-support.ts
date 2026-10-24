/**
 * Helpers shared by the Control MCP tool modules (`control-mcp-tools.ts` and
 * `control-mcp-coordinator-tools.ts`): small value guards, the plain tool
 * result, annotations, and the schemas and checks several coordinator tools
 * reuse.
 */

import { z } from "zod";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/** The field every environment and workflow tool takes to act on another node. */
export const nodeIdField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Coordinators only: a nodeId from list_nodes, to act on that node's copy of this project. Omit for this node.",
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

/**
 * One build step's harness and model. Unlike a Multi Review row the model is
 * optional: naming only an agent runs that agent's own saved model.
 */
export const buildStepSchema = z
  .object({
    agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    model: z.string().trim().min(1).max(500).optional(),
    reasoningEffort: z.string().trim().min(1).max(100).optional(),
    fastMode: z.boolean().optional(),
  })
  .strict();

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
    steps,
    reviewers: Array.isArray(record.reviewers) ? record.reviewers : [],
    reviewPreparation: record.reviewPreparation ?? null,
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
