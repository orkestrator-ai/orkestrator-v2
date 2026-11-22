/**
 * Long checks: slow commands a Build Pipeline stage hands to the pipeline
 * instead of running them in its own turn.
 *
 * A corpus parity run, a byte-identity comparison or a full browser suite can
 * take longer than an agent turn, a tool call or a monitor survives. A stage
 * agent starts one with `start_long_check`; the backend runs it on the
 * environment's own validation worker (the same detached, restart-safe runner
 * review preparation uses), polls it from the supervisor, writes its result on
 * the ticket when it settles, and holds the stage until the result has been
 * handed back to the stage's session as a follow-up turn. The agent never
 * polls, and a stage cannot finish on a criterion whose check is still
 * running. See `docs/architecture/pipeline-long-checks.md`.
 */
import {
  isReviewValidationRun,
  type ReviewValidationResult,
  type ReviewValidationRun,
  type ReviewValidationScope,
} from "./review-validation.js";

/** The agent tools that start and read long checks. */
export const PIPELINE_LONG_CHECK_TOOL_NAMES = Object.freeze([
  "start_long_check",
  "get_long_checks",
] as const);

/** The stages that may start a long check. Review runs read-only; later stages run none. */
export const PIPELINE_LONG_CHECK_PHASES = Object.freeze([
  "build",
  "rework",
  "address-findings",
  "verify",
] as const);
export type PipelineLongCheckPhase = (typeof PIPELINE_LONG_CHECK_PHASES)[number];

export const PIPELINE_LONG_CHECK_LIMITS = Object.freeze({
  commentAttempts: 3,
  /** Checks kept on one pipeline record; the oldest settled ones are dropped first. */
  retained: 8,
  /** Commands in one check. */
  commands: 8,
  nameLength: 120,
  criterionLength: 600,
  commandLength: 4000,
  cwdLength: 512,
  /** Per-command timeout bounds, in minutes (the worker's own ceiling is two hours). */
  minTimeoutMinutes: 1,
  maxTimeoutMinutes: 120,
  defaultTimeoutMinutes: 60,
  errorLength: 1000,
});

/**
 * Where a check stands.
 *
 * - `running`: planned or running on the worker.
 * - `passed`: every command passed or was covered by a passing command.
 * - `failed`: at least one command exited non-zero.
 * - `incomplete`: at least one command did not finish (timed out, cancelled,
 *   capacity wait expired); nothing it did not finish counts as evidence.
 * - `error`: the worker could not run or report the check.
 */
export const PIPELINE_LONG_CHECK_STATUSES = [
  "running",
  "passed",
  "failed",
  "incomplete",
  "error",
] as const;
export type PipelineLongCheckStatus = (typeof PIPELINE_LONG_CHECK_STATUSES)[number];

export interface PipelineLongCheck {
  /** Also the validation run id, so its evidence lives under `.orkestrator/review-artifacts/<id>/`. */
  id: string;
  name: string;
  /** The ticket criterion ID this check settles. Older records may have criterion text. */
  criterion?: string;
  /** The stage that started it, and the pipeline iteration (zero-based round) it belongs to. */
  phase: PipelineLongCheckPhase;
  iteration: number;
  /** The stage session that started it. */
  sessionKey: string;
  status: PipelineLongCheckStatus;
  startedAt: string;
  settledAt?: string;
  /** The worker's authoritative projection. */
  run: ReviewValidationRun;
  error?: string;
  /** Supervisor poll bookkeeping; a failed read does not settle the check. */
  lastPolledAt?: string;
  pollFailures?: number;
  /** When the result was handed to the stage's session as a follow-up turn. */
  deliveredAt?: string;
  /** The ticket comment carrying the result. */
  ticketComment?: "posted" | "failed" | "skipped";
  ticketCommentAttempts?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

export function isPipelineLongCheck(value: unknown): value is PipelineLongCheck {
  const limits = PIPELINE_LONG_CHECK_LIMITS;
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    /^long-check-[A-Za-z0-9_-]{1,100}$/.test(value.id) &&
    isText(value.name, limits.nameLength) &&
    (value.criterion === undefined || isText(value.criterion, limits.criterionLength)) &&
    PIPELINE_LONG_CHECK_PHASES.includes(value.phase as PipelineLongCheckPhase) &&
    isCount(value.iteration) &&
    isText(value.sessionKey, 1024) &&
    PIPELINE_LONG_CHECK_STATUSES.includes(value.status as PipelineLongCheckStatus) &&
    isIso(value.startedAt) &&
    (value.settledAt === undefined || isIso(value.settledAt)) &&
    isReviewValidationRun(value.run) &&
    value.run.id === value.id &&
    (value.error === undefined || isText(value.error, limits.errorLength)) &&
    (value.lastPolledAt === undefined || isIso(value.lastPolledAt)) &&
    (value.pollFailures === undefined || isCount(value.pollFailures)) &&
    (value.deliveredAt === undefined || isIso(value.deliveredAt)) &&
    (value.ticketComment === undefined ||
      value.ticketComment === "posted" ||
      value.ticketComment === "failed" ||
      value.ticketComment === "skipped") &&
    (value.ticketCommentAttempts === undefined || isCount(value.ticketCommentAttempts)) &&
    // A settled check records when; a running one has not.
    (value.status === "running") === (value.settledAt === undefined)
  );
}

export function isPipelineLongCheckList(value: unknown): value is PipelineLongCheck[] {
  return (
    Array.isArray(value) &&
    value.length <= PIPELINE_LONG_CHECK_LIMITS.retained &&
    value.every(isPipelineLongCheck) &&
    new Set(value.map((check) => check.id)).size === value.length
  );
}

/** True while the worker may still change the run. */
export function isLongCheckRunUnsettled(run: ReviewValidationRun): boolean {
  return run.status === "planned" || run.status === "running";
}

/**
 * The check's status from its run. A run that has not settled is `running`;
 * a failed run (the worker itself stopped) is `error`; a cancelled one is
 * `incomplete`. A completed run is judged per command: any failure fails it,
 * otherwise any command it did not finish leaves it incomplete.
 */
export function longCheckStatusFromRun(run: ReviewValidationRun): PipelineLongCheckStatus {
  if (isLongCheckRunUnsettled(run)) return "running";
  if (run.status === "failed") return "error";
  if (run.status === "cancelled") return "incomplete";
  if (run.results.some((result) => result.status === "failed")) return "failed";
  const passed = new Set(
    run.results
      .filter(
        (result) =>
          result.status === "passed" &&
          (result.executedCommand === undefined || result.executedCommand === result.command),
      )
      .map((result) => result.id),
  );
  const covered = run.results.every((result) => {
    if (passed.has(result.id)) return true;
    const coveringId = /^Covered by ([A-Za-z0-9_-]+) \(.*\)$/.exec(result.limitation ?? "")?.[1];
    return result.status === "skipped" && coveringId !== undefined && passed.has(coveringId);
  });
  return passed.size > 0 && covered ? "passed" : "incomplete";
}

export function longCheckCommentPending(check: PipelineLongCheck): boolean {
  return (
    check.status !== "running" &&
    check.ticketComment !== "posted" &&
    check.ticketComment !== "skipped" &&
    (check.ticketCommentAttempts ?? 0) < PIPELINE_LONG_CHECK_LIMITS.commentAttempts
  );
}

/** Keep outstanding work and evidence that the current attempt still needs. */
export function retainLongChecks(
  checks: readonly PipelineLongCheck[],
  currentSessionKey?: string,
): PipelineLongCheck[] {
  const kept = [...checks];
  while (kept.length > PIPELINE_LONG_CHECK_LIMITS.retained) {
    const index = kept.findIndex(
      (check) =>
        check.status !== "running" &&
        !longCheckCommentPending(check) &&
        check.sessionKey !== currentSessionKey,
    );
    if (index < 0) break;
    kept.splice(index, 1);
  }
  return kept;
}

/** `1h 02m`, `31m 12s`, `45s`. */
export function formatLongCheckDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** Wall-clock time from the check's start to its settlement (or to `now` while it runs). */
export function longCheckElapsedMs(check: PipelineLongCheck, now = Date.now()): number {
  const end = check.settledAt ? Date.parse(check.settledAt) : now;
  return Math.max(0, end - Date.parse(check.startedAt));
}

const PHASE_LABELS: Record<PipelineLongCheckPhase, string> = {
  build: "Build",
  rework: "Rework",
  "address-findings": "Address Findings",
  verify: "Verify",
};

export function longCheckPhaseLabel(phase: PipelineLongCheckPhase): string {
  return PHASE_LABELS[phase];
}

function commandScope(run: ReviewValidationRun, id: string): ReviewValidationScope {
  return run.plan.commands.find((command) => command.id === id)?.scope ?? "general";
}

function shortCommand(command: string): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/** One line per command: what ran, how it ended, and where its output is. */
export function longCheckCommandLines(
  run: ReviewValidationRun,
  options: { paths?: boolean } = {},
): string[] {
  return run.results.map((result: ReviewValidationResult) => {
    const scope = commandScope(run, result.id);
    const parts = [
      `\`${shortCommand(result.executedCommand ?? result.command)}\` (${scope})`,
      result.status,
      ...(result.exitCode === null ? [] : [`exit ${result.exitCode}`]),
      ...(result.durationMs > 0 ? [formatLongCheckDuration(result.durationMs)] : []),
    ];
    const notes = [
      ...(result.limitation ? [result.limitation] : []),
      ...(options.paths
        ? [
            ...(result.stdoutPath
              ? [`stdout ${result.stdoutPath} (${result.stdoutBytes} bytes)`]
              : []),
            ...(result.stderrPath
              ? [`stderr ${result.stderrPath} (${result.stderrBytes} bytes)`]
              : []),
          ]
        : []),
    ];
    return `- ${parts.join(", ")}${notes.length ? `. ${notes.join("; ")}` : ""}`;
  });
}

/**
 * The ticket comment uses public display metadata and outcome only. Shell
 * text and diagnostics stay in the workspace evidence.
 */
export function longCheckTicketComment(check: PipelineLongCheck): string {
  const verdict =
    check.status === "running"
      ? "is still running"
      : check.status === "error"
        ? "could not be completed"
        : check.status;
  return [
    `**Long check “${check.name}”** (${longCheckPhaseLabel(check.phase)}, round ${check.iteration + 1}) ${verdict} after ${formatLongCheckDuration(longCheckElapsedMs(check))}.`,
    ...(check.criterion && /^ac-\d+$/.test(check.criterion)
      ? [`Criterion: ${check.criterion}`]
      : []),
    ...check.run.results.map(
      (result, index) =>
        `- Command ${index + 1} (${commandScope(check.run, result.id)}): ${result.status}`,
    ),
    `Evidence: \`.orkestrator/review-artifacts/${check.id}/\` in the pipeline environment.`,
  ].join("\n");
}
