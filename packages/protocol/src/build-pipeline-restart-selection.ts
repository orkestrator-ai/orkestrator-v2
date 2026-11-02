import {
  BUILD_PIPELINE_AGENTS,
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewSlot,
  stepKeyForSessionPhase,
  type BuildPipeline,
  type BuildPipelineAgent,
  type BuildStepConfig,
  type BuildStepKey,
  type PipelineSession,
} from "./build-pipeline.js";

/**
 * The harness, model, reasoning effort and speed a "Restart in…" runs a
 * pipeline step under.
 *
 * The choice replaces the step's configured selection from then on, so a
 * later round of the same step (Fix runs under Build's) keeps it too. The
 * step's own instructions and a reviewer's lens are kept.
 */
export interface BuildPipelineRestartSelection {
  agent: BuildPipelineAgent;
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

/** The configured selection a restarted session's step reads. */
export type BuildPipelineRestartSlot =
  | { kind: "step"; step: BuildStepKey }
  | { kind: "reviewer"; slot: number }
  | { kind: "review-preparation" };

/** The pipeline-session label of a fan-out consolidation turn. */
export const PIPELINE_CONSOLIDATION_SESSION_LABEL = "Consolidation";

const MAX_SELECTION_FIELD_LENGTH = 512;

function boundedNonBlank(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_SELECTION_FIELD_LENGTH
  );
}

export function isBuildPipelineRestartSelection(
  value: unknown,
): value is BuildPipelineRestartSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["agent", "model", "reasoningEffort", "fastMode"].includes(key),
    )
  ) {
    return false;
  }
  return (
    BUILD_PIPELINE_AGENTS.includes(record.agent as BuildPipelineAgent) &&
    boundedNonBlank(record.model) &&
    (record.reasoningEffort === undefined || boundedNonBlank(record.reasoningEffort)) &&
    (record.fastMode === undefined || typeof record.fastMode === "boolean")
  );
}

/**
 * Which configured selection a session's step runs under, or null when a
 * restart cannot choose one for it.
 *
 * Package preparation and consolidation share {@link BuildPipeline.reviewPreparation};
 * a fan-out reviewer runs under its own row of {@link BuildPipeline.reviewers};
 * every other session under its step, Fix under Build's.
 */
export function pipelineRestartSlot(
  pipeline: Pick<BuildPipeline, "reviewers">,
  session: Pick<PipelineSession, "phase" | "label">,
): BuildPipelineRestartSlot | null {
  if (session.label === REVIEW_PACKAGE_SESSION_LABEL) return { kind: "review-preparation" };
  if (session.phase === "review") {
    if (session.label === PIPELINE_CONSOLIDATION_SESSION_LABEL) {
      return { kind: "review-preparation" };
    }
    const slot = pipelineIndependentReviewSlot(session.label);
    if (slot !== null) {
      return slot < (pipeline.reviewers?.length ?? 0) ? { kind: "reviewer", slot } : null;
    }
  }
  return { kind: "step", step: stepKeyForSessionPhase(session.phase) };
}

function withSelection(
  existing: BuildStepConfig | undefined,
  selection: BuildPipelineRestartSelection,
  keepLens: boolean,
): BuildStepConfig {
  const next: BuildStepConfig = { agent: selection.agent, model: selection.model.trim() };
  const effort = selection.reasoningEffort?.trim();
  if (effort && effort !== "default") next.reasoningEffort = effort;
  if (typeof selection.fastMode === "boolean") next.fastMode = selection.fastMode;
  if (existing?.instructions !== undefined) next.instructions = existing.instructions;
  if (keepLens && existing?.lens !== undefined) next.lens = existing.lens;
  return next;
}

/**
 * Writes a restart's selection into the configuration its step reads.
 *
 * Reviewer one is both `steps.review` and `reviewers[0]`, so changing either
 * changes both; a single-reviewer review reads `steps.review`.
 */
export function applyBuildPipelineRestartSelection(
  pipeline: Pick<BuildPipeline, "steps" | "reviewers" | "reviewPreparation">,
  slot: BuildPipelineRestartSlot,
  selection: BuildPipelineRestartSelection,
): void {
  if (slot.kind === "review-preparation") {
    pipeline.reviewPreparation = withSelection(pipeline.reviewPreparation, selection, false);
    return;
  }
  const step: BuildStepKey = slot.kind === "step" ? slot.step : "review";
  const reviewerSlot = slot.kind === "reviewer" ? slot.slot : step === "review" ? 0 : null;
  if (reviewerSlot !== null && pipeline.reviewers?.[reviewerSlot]) {
    const reviewers = [...pipeline.reviewers];
    reviewers[reviewerSlot] = withSelection(reviewers[reviewerSlot], selection, true);
    pipeline.reviewers = reviewers;
  }
  if (slot.kind === "step" || reviewerSlot === 0) {
    pipeline.steps = {
      ...pipeline.steps,
      [step]: withSelection(pipeline.steps?.[step], selection, step === "review"),
    };
  }
}
