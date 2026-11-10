/**
 * Which step a pipeline restart acts on. Each function runs inside the
 * pipeline lock, on the candidate being mutated, so it resolves against the
 * latest state rather than whatever the caller last saw.
 */
import {
  isCancelledBuildPipeline,
  isReviewPackagePreparationSession,
  isSupersededPipelineSession,
  reviewValidationStage,
  REVIEW_PACKAGE_SESSION_LABEL,
  type BuildPipeline,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  resumablePhase,
  sessionForCurrentPhase,
  sessionPhaseFor,
} from "./build-pipeline-service-helpers.js";

/** Stage IDs of this form ask to prepare the review package again from the named session. */
export const PACKAGE_STAGE_PREFIX = "review-package:";

/** The step a coordinator's restart named or resolved, reported back to it. */
export interface CoordinatorRestartedStep {
  /** The session phase (`build`, `fix`, `review`…), `review-preparation` or `validation`. */
  phase: string;
  /** One-based round. */
  round: number;
  sessionKey?: string;
  label?: string;
}

export type RestartTarget =
  | { kind: "validation" }
  | { kind: "satisfied" }
  | { kind: "review-package"; implementationPhase: "build" | "fix" }
  | {
      kind: "session";
      session?: PipelineSession;
      phase: PipelineSessionPhase;
      forceStage?: boolean;
    }
  | Error;

export function findStageSession(
  pipeline: BuildPipeline,
  stageId: string,
): PipelineSession | undefined {
  return pipeline.sessions.find(
    (session) => session.sdkSessionId === stageId || session.sessionKey === stageId,
  );
}

/**
 * The step a session stage ID names. A build or fix turn that also wrote the
 * package plan is still the Build or Fix step the user restarted: it runs
 * again. The dedicated preparation session restarts package preparation alone.
 */
export function locateSessionStep(
  pipeline: BuildPipeline,
  stageId: string,
): Extract<RestartTarget, { kind: "session" }> | Error {
  const session = findStageSession(pipeline, stageId);
  return session
    ? {
        kind: "session",
        session,
        phase: session.phase,
        forceStage: session.label !== REVIEW_PACKAGE_SESSION_LABEL,
      }
    : new Error("This pipeline stage is no longer available");
}

/** What `restartStep` restarts for a stage ID the UI or a coordinator named. */
export function namedStepTarget(
  candidate: BuildPipeline,
  stageId: string,
  withSelection: boolean,
): RestartTarget {
  // "Restart in…" changes an agent session's step only.
  if (withSelection) return locateSessionStep(candidate, stageId);
  if (candidate.validationRun && stageId === `validation:${candidate.validationRun.id}`) {
    return { kind: "validation" };
  }
  const latest = candidate.rewinds?.at(-1);
  if (
    latest?.step.kind === "validation" &&
    latest.validationRun &&
    stageId === `validation:${latest.validationRun.id}`
  ) {
    return { kind: "satisfied" };
  }
  if (stageId.startsWith(PACKAGE_STAGE_PREFIX)) {
    return locatePackageRestart(candidate, stageId.slice(PACKAGE_STAGE_PREFIX.length));
  }
  return locateSessionStep(candidate, stageId);
}

/**
 * Whichever stage the pipeline is on, resolved inside the lock so a caller
 * that has not yet seen the latest transition cannot restart the stage the
 * pipeline has already left.
 */
export function currentStepTarget(candidate: BuildPipeline): RestartTarget {
  const phase =
    candidate.phase === "paused" ? candidate.pausedFromPhase : resumablePhase(candidate.phase);
  const stagePhase = phase ? sessionPhaseFor(phase) : null;
  if (!phase || !stagePhase) {
    return new Error("This build has no running stage to restart");
  }
  if (
    candidate.restartRequest?.kind === "validation" ||
    (candidate.rewinds?.at(-1)?.replacementValidationRunId === candidate.validationRun?.id &&
      (candidate.validationRun?.status === "planned" ||
        candidate.validationRun?.status === "running"))
  )
    return { kind: "satisfied" };
  const validationTarget = reviewValidationStage(candidate, phase);
  if (validationTarget === "validation") return { kind: "validation" };
  if (validationTarget === "review-package") {
    return {
      kind: "review-package",
      implementationPhase: phase === "fixing" ? "fix" : "build",
    };
  }
  // Between a transition and the next tick the current session can still be
  // the previous stage's, so it only stands for this stage when it matches.
  const session = sessionForCurrentPhase(candidate);
  return session?.phase === stagePhase
    ? {
        kind: "session",
        session,
        phase: stagePhase,
        forceStage: session.label !== REVIEW_PACKAGE_SESSION_LABEL,
      }
    : { kind: "session", phase: stagePhase };
}

/**
 * The step a failed pipeline failed in: the session its failure names, or,
 * when the step failed before its session existed, a fresh run of that step.
 */
export function failedStepTarget(candidate: BuildPipeline): RestartTarget {
  const failure = candidate.failureContext!;
  const stagePhase = sessionPhaseFor(failure.phase);
  if (!stagePhase) {
    return new Error(
      `This build failed while ${failure.phase.replaceAll("-", " ")}, before any step started, so there is no step to restart. Ask the user; a new build may be needed.`,
    );
  }
  const special = reviewValidationStage(candidate, resumablePhase(failure.phase) ?? undefined);
  if (special === "validation") return { kind: "validation" };
  if (special === "review-package")
    return {
      kind: "review-package",
      implementationPhase: failure.phase === "fixing" ? "fix" : "build",
    };
  const session = failure.sessionId ? findStageSession(candidate, failure.sessionId) : undefined;
  return session?.phase === stagePhase
    ? {
        kind: "session",
        session,
        phase: stagePhase,
        forceStage: session.label !== REVIEW_PACKAGE_SESSION_LABEL,
      }
    : { kind: "session", phase: stagePhase };
}

/**
 * Why a coordinator may not restart this pipeline at all, or `undefined`.
 * The cancelled refusal must not invite a new build: a coordinator told
 * "start a new build if the work is still wanted" did exactly that after the
 * user cancelled (to-do 7545 task 4).
 */
export function coordinatorRestartRefusal(
  candidate: BuildPipeline,
  stageId: string | undefined,
): Error | undefined {
  if (isCancelledBuildPipeline(candidate)) {
    return new Error(
      "This build pipeline was cancelled, so it cannot be restarted. If you did not cancel it yourself, the user did: that is their decision to stop this work, so do not start another build for this ticket unless the user asks you to.",
    );
  }
  if (candidate.phase === "complete") {
    return new Error(
      "This build pipeline has completed; there is no failed or current step to restart. Ask the user before redoing a finished build.",
    );
  }
  if (candidate.phase === "failed" && !candidate.failureContext) {
    return new Error(
      "This build pipeline failed outside any step, so there is no step to restart. Ask the user; a new build may be needed.",
    );
  }
  if (
    stageId !== undefined &&
    !findStageSession(candidate, stageId) &&
    !stageId.startsWith("validation:") &&
    !stageId.startsWith(PACKAGE_STAGE_PREFIX)
  ) {
    return new Error(
      `This build pipeline has no step "${stageId}". Use a worker address from get_build_pipeline, or omit stepId to restart the failed or current step.`,
    );
  }
  return undefined;
}

/**
 * Prepares the review package again from a build or fix turn that wrote its
 * plan, keeping that turn. The single-review path has no dedicated
 * preparation session to restart, so this is its package-only restart.
 */
export function locatePackageRestart(pipeline: BuildPipeline, stageId: string): RestartTarget {
  const session = findStageSession(pipeline, stageId);
  if (!session) return new Error("This pipeline stage is no longer available");
  if (!isReviewPackagePreparationSession(session, pipeline)) {
    return new Error("This step did not prepare the review package.");
  }
  const latest = pipeline.rewinds?.at(-1);
  const current = sessionForCurrentPhase(pipeline);
  if (
    !isSupersededPipelineSession(session) &&
    latest?.sessionKey === session.sessionKey &&
    latest.step.kind === "review-package" &&
    (pipeline.restartRequest?.kind === "review-package" ||
      (current?.label === REVIEW_PACKAGE_SESSION_LABEL &&
        current.status === "running" &&
        Date.parse(current.startedAt) >= Date.parse(latest.at)))
  ) {
    // The same request again (a double click, a retried command) while the
    // preparation it started is still pending or running.
    return { kind: "satisfied" };
  }
  return { kind: "session", session, phase: session.phase, forceStage: false };
}
