/**
 * The Build Pipeline's stages as one table, in the order a run meets them.
 *
 * The supervisor takes session labels, phases, result kinds and each stage's
 * workspace boundary from here. The built-in Build Pipeline template
 * (`@orkestrator/protocol/graphs/builtins`) describes the same stages, and
 * `graph-builtin-templates.test.ts` pins the two together: a change to a
 * stage here fails that test until the template says the same.
 */
import {
  REVIEW_PACKAGE_SESSION_LABEL,
  usesReviewFanout,
  type BuildPipeline,
  type PipelineSessionPhase,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";

/** `maxIterations` when a launch names none; the protocol accepts 1 to `MAX_BUILD_PIPELINE_ITERATIONS`. */
export const DEFAULT_BUILD_PIPELINE_ITERATIONS = 3;

/**
 * How a stage may touch the workspace.
 *
 * - `write`: a writable build-mode turn.
 * - `read-only`: a plan-mode, read-only turn, and the git guard refuses a
 *   result once the HEAD moved or a new path appeared (item 001). A review
 *   without a sealed package (a record from before packages) runs writable.
 * - `guarded`: a build-mode turn whose shell may write build outputs; the git
 *   guard refuses a result once the HEAD moved or a new path appeared.
 * - `system`: no agent turn; the backend does the work.
 */
export type BuildPipelineStageTurn = "write" | "read-only" | "guarded" | "system";

/**
 * Where a stage sits in the loop of rounds: once before it, in every round,
 * in every round after the first, or once after it.
 */
export type BuildPipelineStageRound = "before" | "every" | "later" | "after";

export type BuildPipelineStageKey =
  | "setup"
  | "build"
  | "fix"
  | "preparation"
  | "validation"
  | "review"
  | "consolidation"
  | "address"
  | "verify"
  | "pr"
  | "resolve-conflicts";

export interface BuildPipelineStage {
  key: BuildPipelineStageKey;
  round: BuildPipelineStageRound;
  turn: BuildPipelineStageTurn;
  /**
   * The workflow result the stage's turn submits, or null for none. Build and
   * Fix submit `review-preparation` only when they prepare the review package
   * themselves ({@link usesPackagePreparationSession} false); otherwise none.
   */
  result: WorkflowResultKind | null;
  /**
   * Runs only with a reviewer panel (`review-fanout`) or with a dedicated
   * package preparation session (`preparation-session`).
   */
  only?: "review-fanout" | "preparation-session";
  /** The pipeline session that runs the stage, for stages with one. */
  session?: { phase: PipelineSessionPhase; buildPhase: ResumableBuildPhase; label: string };
}

export const BUILD_PIPELINE_STAGES: readonly BuildPipelineStage[] = Object.freeze(
  (
    [
      { key: "setup", round: "before", turn: "system", result: null },
      {
        key: "build",
        round: "before",
        turn: "write",
        result: "review-preparation",
        session: { phase: "build", buildPhase: "building", label: "Build Session" },
      },
      {
        key: "fix",
        round: "later",
        turn: "write",
        result: "review-preparation",
        session: { phase: "fix", buildPhase: "fixing", label: "Fix Session" },
      },
      {
        key: "preparation",
        round: "every",
        turn: "write",
        result: "validation-plan",
        only: "preparation-session",
        session: { phase: "fix", buildPhase: "fixing", label: REVIEW_PACKAGE_SESSION_LABEL },
      },
      { key: "validation", round: "every", turn: "system", result: null },
      {
        key: "review",
        round: "every",
        turn: "read-only",
        result: "review-report",
        session: { phase: "review", buildPhase: "reviewing", label: "Review Session" },
      },
      {
        key: "consolidation",
        round: "every",
        turn: "read-only",
        result: "consolidated-review",
        only: "review-fanout",
      },
      {
        key: "address",
        round: "every",
        turn: "write",
        result: "fix-result",
        session: { phase: "address", buildPhase: "addressing", label: "Address Issues Session" },
      },
      {
        key: "verify",
        round: "every",
        turn: "guarded",
        result: "verification-result",
        session: { phase: "verify", buildPhase: "verifying", label: "Verification Session" },
      },
      {
        key: "pr",
        round: "after",
        turn: "write",
        result: null,
        session: { phase: "pr", buildPhase: "creating-pr", label: "PR Creation Session" },
      },
      {
        key: "resolve-conflicts",
        round: "after",
        turn: "write",
        result: null,
        session: {
          phase: "resolve-conflicts",
          buildPhase: "resolving-conflicts",
          label: "Conflict Resolution Session",
        },
      },
    ] satisfies BuildPipelineStage[]
  ).map((stage) => Object.freeze(stage)),
);

const BY_KEY = new Map(BUILD_PIPELINE_STAGES.map((stage) => [stage.key, stage]));

export function buildPipelineStage(key: BuildPipelineStageKey): BuildPipelineStage {
  return BY_KEY.get(key)!;
}

/**
 * The stage a session phase names. `fix` is the Fix stage; the dedicated
 * package preparation also runs as a `fix` session, under its own label.
 */
export function buildPipelineSessionStage(phase: PipelineSessionPhase): BuildPipelineStage {
  return buildPipelineStage(phase);
}

/** The pipeline phase a session phase runs in. */
export function buildPhaseForSessionPhase(phase: PipelineSessionPhase): ResumableBuildPhase {
  return buildPipelineSessionStage(phase).session!.buildPhase;
}

/** The stages a session phase names, one per phase. */
const SESSION_STAGES = BUILD_PIPELINE_STAGES.filter((stage) => stage.session?.phase === stage.key);

/** Each session phase's default session label. */
export const BUILD_PIPELINE_SESSION_LABELS: Readonly<Record<PipelineSessionPhase, string>> =
  Object.freeze(
    Object.fromEntries(SESSION_STAGES.map((stage) => [stage.key, stage.session!.label])) as Record<
      PipelineSessionPhase,
      string
    >,
  );

/** The session phase that runs a pipeline phase, or null for the setup phases. */
export function sessionPhaseForBuildPhase(phase: ResumableBuildPhase): PipelineSessionPhase | null {
  return (
    SESSION_STAGES.find((stage) => stage.session!.buildPhase === phase)?.session!.phase ?? null
  );
}

/**
 * Whether the review package is prepared by a session of its own (a reviewer
 * panel, or a configured preparation step) rather than by the Build or Fix
 * turn itself.
 */
export function usesPackagePreparationSession(
  pipeline: Pick<BuildPipeline, "reviewers" | "steps" | "agentType" | "reviewPreparation">,
): boolean {
  return usesReviewFanout(pipeline) || Boolean(pipeline.reviewPreparation);
}

/**
 * The provider turn options of a stage without a session of its own (the
 * panel's consolidation): plan mode with the read-only boundary for a
 * `read-only` stage, otherwise build mode.
 */
export function buildPipelineStageTurn(
  stage: BuildPipelineStage,
): { mode: "plan"; readOnly: true } | { mode: "build" } {
  return stage.turn === "read-only" ? { mode: "plan", readOnly: true } : { mode: "build" };
}
