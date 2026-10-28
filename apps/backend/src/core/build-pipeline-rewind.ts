/**
 * Where a restart rewinds a build pipeline to, and what it supersedes.
 *
 * The pipeline's loop is a sequence of rounds (`iteration`): Build or Fix, the
 * review package and its validation, Review, Address, Verify, and in the last
 * round Ship and conflict resolution. Restarting a step returns the pipeline
 * to that step's round and position; every session at or after that point is
 * superseded. The code is not rewound: the new run starts on the current
 * worktree, including what later rounds committed.
 */
import {
  MAX_PIPELINE_REWINDS,
  MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES,
  MAX_PIPELINE_ROUND_REVIEW_REPORTS,
  REVIEW_PACKAGE_SESSION_LABEL,
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineRestartRequest,
  type PipelineRewind,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

/** Position of a step within one round, in the order the loop runs them. */
const PHASE_ORDER: Record<PipelineSessionPhase, number> = {
  build: 0,
  fix: 0,
  review: 2,
  address: 3,
  verify: 4,
  pr: 5,
  "resolve-conflicts": 6,
};
const PACKAGE_ORDER = 1;
/** Validation runs after the preparation that planned it, before review. */
const VALIDATION_ORDER = 1.5;

/**
 * A session's position within its round. A build or fix turn that also wrote
 * the package plan is still the implementation step: a package restart keeps
 * it and prepares again from its result.
 */
export function sessionStepOrder(session: Pick<PipelineSession, "phase" | "label">): number {
  return session.label === REVIEW_PACKAGE_SESSION_LABEL
    ? PACKAGE_ORDER
    : PHASE_ORDER[session.phase];
}

/** The position a restart request runs from. */
export function restartStepOrder(request: PipelineRestartRequest): number {
  switch (request.kind) {
    case "session":
      return PHASE_ORDER[request.phase];
    case "review-package":
      return PACKAGE_ORDER;
    case "validation":
      return VALIDATION_ORDER;
  }
}

/**
 * Marks every live session at or after (`iteration`, `order`) as superseded
 * by `rewindId` and returns how many it marked. Sessions of a later round are
 * always after the point; sessions an earlier rewind superseded keep the
 * rewind that superseded them.
 */
export function supersedeSessionsFrom(
  pipeline: Pick<BuildPipeline, "sessions">,
  point: { iteration: number; order: number },
  rewindId: string,
  at: string,
): number {
  let superseded = 0;
  for (const session of pipeline.sessions) {
    if (isSupersededPipelineSession(session)) continue;
    const after =
      session.iteration > point.iteration ||
      (session.iteration === point.iteration && sessionStepOrder(session) >= point.order);
    if (!after) continue;
    session.supersededBy = rewindId;
    session.supersededAt = at;
    // A superseded running turn was aborted by the restart; it is history now.
    if (session.status === "running") {
      session.status = "idle";
      session.completedAt ??= at;
    }
    superseded += 1;
  }
  return superseded;
}

/** Appends a rewind, keeping only the newest {@link MAX_PIPELINE_REWINDS}. */
export function recordRewind(
  pipeline: Pick<BuildPipeline, "rewinds">,
  rewind: PipelineRewind,
): void {
  const rewinds = [...(pipeline.rewinds ?? []), rewind];
  pipeline.rewinds = rewinds.slice(-MAX_PIPELINE_REWINDS);
}

/**
 * The verdict of the verification that sent the pipeline into `iteration`'s
 * fix, read from the live run. Undefined for records written before verify
 * sessions kept their verdict.
 */
export function verificationFeedbackBefore(
  pipeline: Pick<BuildPipeline, "sessions">,
  iteration: number,
): string | undefined {
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    const session = pipeline.sessions[index]!;
    if (
      session.phase === "verify" &&
      session.iteration === iteration - 1 &&
      !isSupersededPipelineSession(session) &&
      session.verificationFeedback !== undefined
    ) {
      return session.verificationFeedback;
    }
  }
  return undefined;
}

/**
 * Whether an earlier fix attempt of the same round still describes the code
 * the next attempt starts from, so its unchanged-worktree baseline carries
 * over. A live attempt does, and so does one a restart inside the same round
 * superseded (restarting the current fix). A rewind from a later round ran
 * those rounds' commits in between, so its superseded fixes do not.
 */
export function carriesFixBaseline(
  pipeline: Pick<BuildPipeline, "rewinds">,
  session: Pick<PipelineSession, "supersededBy" | "iteration">,
): boolean {
  if (session.supersededBy === undefined) return true;
  const rewinds = pipeline.rewinds ?? [];
  const rewind = rewinds.find((entry) => entry.id === session.supersededBy);
  if (!rewind || rewind.iteration !== rewind.fromIteration) return false;
  // A later rewind from a later round back to this round or before means the
  // rounds in between changed the code after this attempt was superseded.
  return !rewinds.some(
    (entry) =>
      entry.at > rewind.at &&
      entry.iteration < entry.fromIteration &&
      entry.iteration <= session.iteration,
  );
}

/**
 * The newest live review-phase session of `iteration`: the single review, or
 * a fan-out pass's consolidation. A copy filed by an older session is stale,
 * because a later attempt of that round (a retry, a retried reviewer) has
 * started since.
 */
function newestLiveReviewSession(
  pipeline: Pick<BuildPipeline, "sessions">,
  iteration: number,
): PipelineSession | undefined {
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    const session = pipeline.sessions[index]!;
    if (
      session.phase === "review" &&
      session.iteration === iteration &&
      !isSupersededPipelineSession(session) &&
      session.superseded !== true
    ) {
      return session;
    }
  }
  return undefined;
}

function reportBytes(report: StructuredReviewReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}

/** Drops copies whose session a rewind or a later attempt replaced. */
export function pruneRoundReviewReports(
  pipeline: Pick<BuildPipeline, "sessions" | "roundReviewReports">,
): void {
  if (!pipeline.roundReviewReports) return;
  const kept = pipeline.roundReviewReports.filter(
    (entry) => newestLiveReviewSession(pipeline, entry.iteration)?.sessionKey === entry.sessionKey,
  );
  if (kept.length > 0) pipeline.roundReviewReports = kept;
  else delete pipeline.roundReviewReports;
}

/**
 * Keeps `report`, just accepted from `session`, as its round's copy. Older
 * rounds' copies give way first when the byte budget is exceeded; a report
 * that alone exceeds it is not kept, and a restarted Address of that round
 * reruns the review as before.
 */
export function retainRoundReviewReport(
  pipeline: Pick<BuildPipeline, "sessions" | "roundReviewReports">,
  session: Pick<PipelineSession, "iteration" | "sessionKey">,
  report: StructuredReviewReport,
): void {
  const others = (pipeline.roundReviewReports ?? []).filter(
    (entry) => entry.iteration !== session.iteration,
  );
  const size = reportBytes(report);
  const entries =
    size <= MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES
      ? [...others, { iteration: session.iteration, sessionKey: session.sessionKey, report }]
      : others;
  entries.sort((left, right) => left.iteration - right.iteration);
  let total = entries.reduce((sum, entry) => sum + reportBytes(entry.report), 0);
  while (
    (total > MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES ||
      entries.length > MAX_PIPELINE_ROUND_REVIEW_REPORTS) &&
    entries.length > 0
  ) {
    // The round just accepted is the one a restart is most likely to need.
    const dropAt = entries[0]!.iteration === session.iteration && entries.length > 1 ? 1 : 0;
    total -= reportBytes(entries.splice(dropAt, 1)[0]!.report);
  }
  pipeline.roundReviewReports = entries;
  pruneRoundReviewReports(pipeline);
}

/**
 * The accepted consolidated report of `iteration`, when its copy is still the
 * newest live review of that round.
 */
export function roundReviewReport(
  pipeline: Pick<BuildPipeline, "sessions" | "roundReviewReports">,
  iteration: number,
): StructuredReviewReport | undefined {
  const entry = pipeline.roundReviewReports?.find((candidate) => candidate.iteration === iteration);
  if (!entry) return undefined;
  return newestLiveReviewSession(pipeline, iteration)?.sessionKey === entry.sessionKey
    ? entry.report
    : undefined;
}
