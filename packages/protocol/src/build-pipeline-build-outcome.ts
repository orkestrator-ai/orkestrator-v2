/**
 * The Build stage's decision on whether the rest of the pipeline should run.
 *
 * Not every build ends in a change worth reviewing. A Build turn may find that
 * the ticket needs no work (the behaviour already exists, an investigation
 * shows nothing to change), or it may have to stop (a missing dependency, a
 * contradiction in the ticket only a person can settle). Running package
 * preparation, validation, review, Address, Verify and Ship after either
 * spends every one of those sessions' tokens for nothing.
 *
 * The Build agent reports the decision with `update_key_information`
 * (`continueReview`, `stopKind`, `stopReason`), alongside the brief it already
 * writes there. The backend records it on that Build session
 * (`PipelineSession.buildOutcome`) and acts on it once, when the turn ends:
 *
 * - `continueReview: true`, or no report at all: the pipeline carries on as
 *   before. A missing report is never read as a stop.
 * - `no-work-needed`: the pipeline completes without review or Ship, and the
 *   ticket gets the reason.
 * - `blocked`: the pipeline pauses with the reason. Resume gives the Build
 *   session another turn, whose own report (or the lack of one) decides again.
 *
 * Kept in its own module so `build-pipeline.ts` only imports the validator;
 * nothing here imports that module's values.
 */

/** Why a Build turn says the pipeline should not continue. */
export const PIPELINE_BUILD_STOP_KINDS = ["no-work-needed", "blocked"] as const;
export type PipelineBuildStopKind = (typeof PIPELINE_BUILD_STOP_KINDS)[number];

/** The stored reason is cut to this many characters. */
export const MAX_PIPELINE_BUILD_STOP_REASON_LENGTH = 2_000;

export interface PipelineBuildOutcome {
  /** False when the Build turn says review and the stages after it should not run. */
  continueReview: boolean;
  /** Set only when {@link continueReview} is false. */
  stopKind?: PipelineBuildStopKind;
  /** Why the pipeline stops; required when {@link continueReview} is false. */
  stopReason?: string;
  /** When the Build agent last reported it. */
  reportedAt: string;
  /**
   * When the supervisor acted on a stop. A stop is acted on once: Resume after
   * a `blocked` pause gives Build another turn, and only a new report from
   * that turn can stop the pipeline again.
   */
  appliedAt?: string;
}

/** What the Build agent passes; validated before anything is written. */
export interface PipelineBuildOutcomeInput {
  continueReview: boolean;
  stopKind?: PipelineBuildStopKind;
  stopReason?: string;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isPipelineBuildOutcome(value: unknown): value is PipelineBuildOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  if (typeof outcome.continueReview !== "boolean") return false;
  if (!isIsoDate(outcome.reportedAt)) return false;
  if (outcome.appliedAt !== undefined && !isIsoDate(outcome.appliedAt)) return false;
  if (outcome.continueReview) {
    return outcome.stopKind === undefined && outcome.stopReason === undefined;
  }
  return (
    PIPELINE_BUILD_STOP_KINDS.includes(outcome.stopKind as PipelineBuildStopKind) &&
    typeof outcome.stopReason === "string" &&
    outcome.stopReason.trim().length > 0 &&
    outcome.stopReason.length <= MAX_PIPELINE_BUILD_STOP_REASON_LENGTH
  );
}

/**
 * The stored outcome for an agent's report, or an error message the tool
 * returns to the agent. A stop needs a reason the user can act on; a stop kind
 * defaults to `no-work-needed`, and is dropped when the review continues.
 */
export function pipelineBuildOutcomeFromInput(
  input: PipelineBuildOutcomeInput,
  reportedAt: string,
): PipelineBuildOutcome | { error: string } {
  if (input.continueReview) return { continueReview: true, reportedAt };
  const reason = input.stopReason?.trim();
  if (!reason) {
    return {
      error:
        "`stopReason` is required when `continueReview` is false: say why the pipeline stops, for the user who reads it.",
    };
  }
  if (input.stopKind !== undefined && !PIPELINE_BUILD_STOP_KINDS.includes(input.stopKind)) {
    return { error: "`stopKind` must be `no-work-needed` or `blocked`." };
  }
  return {
    continueReview: false,
    stopKind: input.stopKind ?? "no-work-needed",
    stopReason:
      reason.length > MAX_PIPELINE_BUILD_STOP_REASON_LENGTH
        ? `${reason.slice(0, MAX_PIPELINE_BUILD_STOP_REASON_LENGTH - 1)}…`
        : reason,
    reportedAt,
  };
}

/** A stop the supervisor has acted on, as the UI and the ticket comment show it. */
export interface PipelineBuildStop {
  stopKind: PipelineBuildStopKind;
  stopReason: string;
  appliedAt: string;
}

interface BuildOutcomeSession {
  phase: string;
  supersededBy?: string;
  buildOutcome?: PipelineBuildOutcome;
}

/**
 * The stop that ended or paused this pipeline after Build, or undefined.
 *
 * Only the newest live Build session counts, and only while the pipeline is
 * still where that stop left it: complete, or paused from `building`. A
 * restart supersedes the session, and a Resume that let the review go ahead
 * moves the phase on, so neither keeps showing a stale stop.
 */
export function pipelineBuildStop(pipeline: {
  phase: string;
  pausedFromPhase?: string;
  sessions: readonly BuildOutcomeSession[];
}): PipelineBuildStop | undefined {
  const where =
    pipeline.phase === "complete" ||
    (pipeline.phase === "paused" && pipeline.pausedFromPhase === "building");
  if (!where) return undefined;
  const build = [...pipeline.sessions]
    .reverse()
    .find((session) => session.phase === "build" && session.supersededBy === undefined);
  const outcome = build?.buildOutcome;
  if (!outcome || outcome.continueReview || !outcome.appliedAt) return undefined;
  if (!outcome.stopKind || !outcome.stopReason) return undefined;
  // A later stage ran after Build: the stop was overridden (a resumed turn
  // that went on to review), so the pipeline is not where the stop left it.
  const buildIndex = pipeline.sessions.lastIndexOf(build!);
  if (
    pipeline.sessions
      .slice(buildIndex + 1)
      .some((session) => session.supersededBy === undefined && session.phase !== "build")
  ) {
    return undefined;
  }
  return {
    stopKind: outcome.stopKind,
    stopReason: outcome.stopReason,
    appliedAt: outcome.appliedAt,
  };
}

/** One line for the ticket comment and the pause message. */
export function pipelineBuildStopSummary(stop: Pick<PipelineBuildStop, "stopKind" | "stopReason">) {
  return stop.stopKind === "blocked"
    ? `Build stopped before review: ${stop.stopReason}`
    : `Build found no further work, so review, fixes and the pull request were skipped: ${stop.stopReason}`;
}
