/**
 * Long checks (`@orkestrator/protocol/build-pipeline-long-checks`): slow
 * commands a stage agent hands to the pipeline instead of running them in its
 * own turn.
 *
 * Three parts, all here:
 *
 * - {@link createBuildPipelineLongCheckHost} is what the `start_long_check` and
 *   `get_long_checks` agent tools call (`long-check-tools.ts`). Starting a
 *   check records it on the pipeline under the pipeline's lock *before* the
 *   worker is asked to run it, so a lost reply or a restart can never run it
 *   twice or lose it: the worker claims a run id exactly once.
 * - {@link BuildPipelineLongChecks} is the supervisor's side. Each pass reads
 *   the running checks' status from the worker (never the agent), records
 *   their progress, settles them, and writes each settled result on the ticket.
 * - {@link longCheckResultsPrompt} is the follow-up turn that hands the results
 *   back to the stage. The supervisor holds a stage whose checks are still
 *   running instead of finishing it, so a criterion cannot be judged on a run
 *   that has not ended.
 *
 * The runs themselves use the environment's review validation worker
 * (`review/validation-worker.ts`): detached from every agent turn and from
 * the backend, bounded by per-command timeouts, and recoverable after a
 * restart from the state file it keeps in the workspace.
 */
import { randomUUID } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  isActiveBuildPhase,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import {
  PIPELINE_LONG_CHECK_LIMITS,
  PIPELINE_LONG_CHECK_PHASES,
  formatLongCheckDuration,
  isLongCheckRunUnsettled,
  longCheckCommandLines,
  longCheckElapsedMs,
  longCheckStatusFromRun,
  longCheckTicketComment,
  retainLongChecks,
  type PipelineLongCheck,
  type PipelineLongCheckPhase,
} from "@orkestrator/protocol/build-pipeline-long-checks";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import {
  isReviewValidationPlan,
  isReviewValidationRun,
  newReviewValidationRun,
  type ReviewValidationPlan,
  type ReviewValidationRun,
  type ReviewValidationScope,
} from "@orkestrator/protocol/review-workflow";
import { probeReviewWorktreeOnce } from "../review/index.js";
import type { PersistedBuildPipeline } from "../models.js";
import { pipelineRecordForEnvironment, type KeyInformationScope } from "./key-information.js";
import { errorMessage, sessionForCurrentPhase, type CommandInvoker } from "./service-helpers.js";

const log = createLogger("build-pipeline");

/** How often the supervisor reads a running check's status from the worker. */
export const LONG_CHECK_POLL_MS = 5_000;
/** How often a running check's progress is written to the pipeline record when nothing settled. */
export const LONG_CHECK_PROGRESS_PERSIST_MS = 60_000;
/** Consecutive failed reads (about a minute of them) after which a check settles as `error`. */
export const LONG_CHECK_MAX_POLL_FAILURES = 12;
/** Ticket comment attempts for one settled check. */
export const LONG_CHECK_MAX_COMMENT_ATTEMPTS = 3;

/** One command of a check, as the agent asks for it. */
export interface LongCheckCommandInput {
  command: string;
  cwd?: string;
  timeoutMinutes?: number;
  scope?: ReviewValidationScope;
}

export interface StartLongCheckInput {
  name: string;
  criterion?: string;
  commands: LongCheckCommandInput[];
}

/** What a tool caller sees of one check: status and progress, never output. */
export interface LongCheckSummary {
  id: string;
  name: string;
  criterion?: string;
  stage: PipelineLongCheckPhase;
  round: number;
  status: PipelineLongCheck["status"];
  startedAt: string;
  settledAt?: string;
  elapsed: string;
  delivered: boolean;
  error?: string;
  queueReason?: string;
  commands: Array<{
    command: string;
    cwd: string;
    scope: ReviewValidationScope;
    status: ReviewValidationRun["results"][number]["status"];
    exitCode: number | null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    lastOutputAt?: string;
    stdoutPath: string | null;
    stderrPath: string | null;
    limitation: string | null;
  }>;
}

export interface LongCheckView {
  pipelineId: string;
  checks: LongCheckSummary[];
}

/** What the agent tools need from the build pipeline service. */
export interface BuildPipelineLongCheckHost {
  /** Whether a build pipeline owns the scope's environment. */
  owns(scope: KeyInformationScope): Promise<boolean>;
  start(scope: KeyInformationScope, input: StartLongCheckInput): Promise<LongCheckSummary>;
  list(scope: KeyInformationScope): Promise<LongCheckView>;
}

export function longCheckSummary(check: PipelineLongCheck, now = Date.now()): LongCheckSummary {
  return {
    id: check.id,
    name: check.name,
    ...(check.criterion ? { criterion: check.criterion } : {}),
    stage: check.phase,
    round: check.iteration + 1,
    status: check.status,
    startedAt: check.startedAt,
    ...(check.settledAt ? { settledAt: check.settledAt } : {}),
    elapsed: formatLongCheckDuration(longCheckElapsedMs(check, now)),
    delivered: check.deliveredAt !== undefined,
    ...(check.error ? { error: check.error } : {}),
    ...(check.run.queueReason ? { queueReason: check.run.queueReason } : {}),
    commands: check.run.results.map((result) => {
      const planned = check.run.plan.commands.find((command) => command.id === result.id)!;
      return {
        command: result.executedCommand ?? result.command,
        cwd: planned.cwd,
        scope: planned.scope ?? "general",
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        ...(result.lastOutputAt ? { lastOutputAt: result.lastOutputAt } : {}),
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
        limitation: result.limitation,
      };
    }),
  };
}

const BUILD_PHASE_BY_STAGE: Record<PipelineLongCheckPhase, BuildPipeline["phase"]> = {
  build: "building",
  rework: "reworking",
  "address-findings": "addressing-findings",
  verify: "verifying",
};

/**
 * The stage session a caller may start a check for: the pipeline's running
 * Build, Rework, Address Findings or Verify session, and only when the caller
 * is that session's own worker (its tab) or its current dispatch (its result
 * key). Throws with what the caller can do otherwise.
 */
export function longCheckOwnerSession(
  pipeline: BuildPipeline,
  scope: KeyInformationScope,
): PipelineSession & { phase: PipelineLongCheckPhase } {
  if (!isActiveBuildPhase(pipeline.phase)) {
    throw new Error("This build pipeline is not running a stage, so it cannot start a long check.");
  }
  const session = sessionForCurrentPhase(pipeline);
  const phase = session?.phase as PipelineLongCheckPhase | undefined;
  if (
    !session ||
    !phase ||
    !PIPELINE_LONG_CHECK_PHASES.includes(phase) ||
    BUILD_PHASE_BY_STAGE[phase] !== pipeline.phase
  ) {
    throw new Error(
      "Long checks can be started only by the Build, Rework, Address Findings or Verify stage while it runs.",
    );
  }
  const ownsWorker =
    scope.tabId !== undefined && scope.tabId === pipelineWorkerTabId(session.sessionKey);
  const ownsDispatch =
    scope.workflowResultKey !== undefined &&
    (scope.workflowResultKey === session.structuredRequestId ||
      (pipeline.activePromptContext?.sessionId === session.sdkSessionId &&
        pipeline.activePromptContext.requestId === scope.workflowResultKey));
  if (!ownsWorker && !ownsDispatch) {
    throw new Error(
      "Only the running stage's authenticated worker can start a long check. On a shared connection, pass the signed worker or workflow capability from your turn instructions as `capability`.",
    );
  }
  return session as PipelineSession & { phase: PipelineLongCheckPhase };
}

function checkText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new Error(`\`${label}\` is longer than ${max} characters.`);
  if (text.includes("\0")) throw new Error(`\`${label}\` contains a NUL character.`);
  return text;
}

/** The worker plan for a check, at `head`. Changed-scope commands keep their order and run first. */
export function longCheckPlan(input: StartLongCheckInput, head: string): ReviewValidationPlan {
  const limits = PIPELINE_LONG_CHECK_LIMITS;
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    throw new Error("A long check needs at least one command.");
  }
  if (input.commands.length > limits.commands) {
    throw new Error(`A long check holds at most ${limits.commands} commands.`);
  }
  const commands = input.commands.map((entry, index) => {
    const command = checkText(entry.command, `commands[${index}].command`, limits.commandLength);
    if (!command) throw new Error(`\`commands[${index}].command\` is empty.`);
    const cwd = checkText(entry.cwd, `commands[${index}].cwd`, limits.cwdLength) ?? ".";
    if (cwd.startsWith("/") || cwd.includes("\\") || cwd.split("/").includes("..")) {
      throw new Error(
        `\`commands[${index}].cwd\` must be a path relative to the workspace root, without \`..\`.`,
      );
    }
    const minutes = entry.timeoutMinutes ?? limits.defaultTimeoutMinutes;
    if (
      !Number.isFinite(minutes) ||
      minutes < limits.minTimeoutMinutes ||
      minutes > limits.maxTimeoutMinutes
    ) {
      throw new Error(
        `\`commands[${index}].timeoutMinutes\` must be between ${limits.minTimeoutMinutes} and ${limits.maxTimeoutMinutes}.`,
      );
    }
    return {
      id: `c${index + 1}`,
      command,
      cwd,
      dependsOn: [],
      resources: [],
      // Long checks are the heavy kind by definition: one at a time unless
      // the repository's scheduler profile says otherwise.
      weight: 2 as const,
      timeoutMs: Math.round(minutes * 60_000),
      scope: entry.scope ?? "general",
    };
  });
  const plan: ReviewValidationPlan = { headRef: head, commands, limitations: [] };
  if (!isReviewValidationPlan(plan)) {
    throw new Error("The long check's commands do not fit a validation plan; shorten them.");
  }
  return plan;
}

/** A new running check for `session`, not yet started on the worker. */
export function newLongCheck(
  pipeline: BuildPipeline,
  session: PipelineSession & { phase: PipelineLongCheckPhase },
  input: StartLongCheckInput,
  plan: ReviewValidationPlan,
): PipelineLongCheck {
  const limits = PIPELINE_LONG_CHECK_LIMITS;
  const name = checkText(input.name, "name", limits.nameLength);
  if (!name) throw new Error("A long check needs a `name`.");
  const criterion = checkText(input.criterion, "criterion", limits.criterionLength);
  const id = `long-check-${randomUUID()}`;
  const run = newReviewValidationRun(id, plan);
  return {
    id,
    name,
    ...(criterion ? { criterion } : {}),
    phase: session.phase,
    iteration: pipeline.iteration,
    sessionKey: session.sessionKey,
    status: "running",
    startedAt: run.startedAt,
    run,
  };
}

/** A worker reply for `check`, or a throw: a reply is never trusted unread. */
function workerRun(check: PipelineLongCheck, value: unknown): ReviewValidationRun {
  if (!isReviewValidationRun(value) || value.id !== check.id) {
    throw new Error("The validation worker returned an unusable status for this check");
  }
  return value;
}

function boundedError(message: string): string {
  const text = message.trim() || "The validation worker reported no reason.";
  const max = PIPELINE_LONG_CHECK_LIMITS.errorLength;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Applies a worker projection to a check. Returns whether the check settled
 * with this projection.
 */
export function applyLongCheckRun(
  check: PipelineLongCheck,
  run: ReviewValidationRun,
  at = new Date().toISOString(),
): boolean {
  if (run.id !== check.id || check.status !== "running") return false;
  check.run = run;
  check.lastPolledAt = at;
  delete check.pollFailures;
  const status = longCheckStatusFromRun(run);
  if (status === "running") return false;
  check.status = status;
  check.settledAt =
    run.completedAt && Date.parse(run.completedAt) <= Date.parse(at) ? run.completedAt : at;
  if (run.error) check.error = boundedError(run.error);
  return true;
}

/** Settles a check the worker cannot report on. */
export function settleLongCheckAsError(
  check: PipelineLongCheck,
  message: string,
  at = new Date().toISOString(),
): void {
  if (check.status !== "running") return;
  check.status = "error";
  check.settledAt = at;
  check.error = boundedError(message);
}

/**
 * The checks the current stage must receive before it may finish: those its
 * stage started in this round that have not been handed to it yet. Null when
 * there are none.
 */
export function undeliveredLongChecks(
  pipeline: BuildPipeline,
  session: PipelineSession,
): PipelineLongCheck[] | null {
  const checks = (pipeline.longChecks ?? []).filter(
    (check) =>
      check.deliveredAt === undefined &&
      check.phase === session.phase &&
      check.iteration === pipeline.iteration,
  );
  return checks.length > 0 ? checks : null;
}

/**
 * The follow-up turn that hands settled checks back to their stage. It carries
 * metadata and artifact paths only; the agent reads the output itself.
 */
export function longCheckResultsPrompt(checks: readonly PipelineLongCheck[]): string {
  const sections = checks.map((check) =>
    [
      `### “${check.name}”: ${check.status} after ${formatLongCheckDuration(longCheckElapsedMs(check))}`,
      ...(check.criterion ? [`Criterion: ${check.criterion}`] : []),
      ...longCheckCommandLines(check.run, { paths: true }),
      ...(check.error ? [`Error: ${check.error}`] : []),
    ].join("\n"),
  );
  return [
    "**Long check results**: the long checks this stage started have finished. The pipeline ran them in the background, and their results below are already on the ticket.",
    ...sections,
    "Output paths are relative to the workspace root. Read what you need with bounded reads (for example `tail -n 200 <path>`); do not run these commands again.",
    "A check that is `incomplete` or `error` did not finish and is no evidence either way: do not mark a criterion it was meant to settle as passed. Record it as not checked, say which check did not finish and why, unless what did finish already shows it failed.",
    "Now finish this stage as its instructions say. If the stage has a result to submit, submit it now, even if you submitted one before: a result submitted while a check was still running was set aside so it could take these results into account.",
  ].join("\n\n");
}

/**
 * The tool host: starts and lists checks for the pipeline that owns the
 * caller's environment.
 */
export function createBuildPipelineLongCheckHost(deps: {
  listPipelines(scope: KeyInformationScope): Promise<readonly PersistedBuildPipeline[]>;
  mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
  ): Promise<BuildPipeline>;
  invoke: CommandInvoker;
}): BuildPipelineLongCheckHost {
  const owner = async (scope: KeyInformationScope) =>
    pipelineRecordForEnvironment(await deps.listPipelines(scope), scope);
  return {
    async owns(scope) {
      return (await owner(scope)) !== null;
    },
    async list(scope) {
      const pipeline = await owner(scope);
      if (!pipeline) throw new Error("No build pipeline owns this environment.");
      const now = Date.now();
      return {
        pipelineId: pipeline.id,
        checks: (pipeline.longChecks ?? []).map((check) => longCheckSummary(check, now)),
      };
    },
    async start(scope, input) {
      const found = await owner(scope);
      if (!found) throw new Error("No build pipeline owns this environment.");
      // Refuse early, before reading the worktree, when the caller cannot start one.
      longCheckOwnerSession(found, scope);
      const snapshot = await probeReviewWorktreeOnce(deps.invoke, found.environmentId);
      if (snapshot.status === "unknown") {
        throw new Error(
          `The workspace HEAD could not be read (${snapshot.reason}), so the check was not started. Try again.`,
        );
      }
      const plan = longCheckPlan(input, snapshot.head);
      let started: PipelineLongCheck | undefined;
      // Admit before acting: the check is on the record before the worker
      // hears of it, so the supervisor owns it whatever happens to this call.
      await deps.mutate(found.id, (pipeline) => {
        const session = longCheckOwnerSession(pipeline, scope);
        const running = (pipeline.longChecks ?? []).find((check) => check.status === "running");
        if (running) {
          throw new Error(
            `Long check “${running.name}” is still running, and a pipeline runs one at a time because they share the workspace's validation worker. Put related commands in one check. Its result reaches you when it finishes.`,
          );
        }
        started = newLongCheck(pipeline, session, input, plan);
        pipeline.longChecks = retainLongChecks([...(pipeline.longChecks ?? []), started]);
      });
      const check = started!;
      try {
        const run = workerRun(
          check,
          await deps.invoke<unknown>("start_review_validation", {
            environmentId: found.environmentId,
            run: check.run,
          }),
        );
        const updated = await deps.mutate(found.id, (pipeline) => {
          const current = pipeline.longChecks?.find((candidate) => candidate.id === check.id);
          if (current && run.id === current.id && current.status === "running") {
            applyLongCheckRun(current, run);
          }
        });
        const current = updated.longChecks?.find((candidate) => candidate.id === check.id);
        return longCheckSummary(current ?? check);
      } catch (error) {
        // The record stays; the supervisor starts it on its next pass. The
        // worker claims a run id once, so a start that did land is not repeated.
        log.warn("long-check.start-failed", { error: formatLogError(error) });
        return longCheckSummary(check);
      }
    },
  };
}

/** The supervisor's side: polls running checks and writes settled ones on the ticket. */
export class BuildPipelineLongChecks {
  private readonly lastPolled = new Map<string, number>();
  private readonly lastPersisted = new Map<string, number>();

  constructor(
    private readonly deps: {
      invoke: CommandInvoker;
      save(pipeline: BuildPipeline): Promise<void>;
      now?: () => number;
      /** Defaults to {@link LONG_CHECK_POLL_MS}. */
      pollMs?: number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Reads every running check whose poll is due, settles what finished, and
   * writes settled results on the ticket. Saves only when something changed
   * that a reader would see: a settlement, a command changing state, or the
   * periodic progress write.
   */
  async poll(pipeline: BuildPipeline): Promise<void> {
    const checks = pipeline.longChecks;
    if (!checks?.length) return;
    let dirty = false;
    const now = this.now();
    for (const check of checks) {
      if (check.status !== "running") continue;
      const due =
        (this.lastPolled.get(check.id) ?? -Infinity) + (this.deps.pollMs ?? LONG_CHECK_POLL_MS);
      if (now < due) continue;
      this.lastPolled.set(check.id, now);
      const at = new Date(now).toISOString();
      try {
        const run = workerRun(
          check,
          await this.deps.invoke<unknown>(
            check.run.status === "planned" ? "start_review_validation" : "status_review_validation",
            { environmentId: pipeline.environmentId, run: check.run },
          ),
        );
        const before = check.run.results.map((result) => result.status).join(",");
        const failuresBefore = check.pollFailures;
        const settled = applyLongCheckRun(check, run, at);
        const moved = run.results.map((result) => result.status).join(",") !== before;
        const progressDue =
          now - (this.lastPersisted.get(check.id) ?? 0) >= LONG_CHECK_PROGRESS_PERSIST_MS;
        if (settled || moved || progressDue || failuresBefore !== undefined) {
          dirty = true;
          this.lastPersisted.set(check.id, now);
        }
      } catch (error) {
        const failures = (check.pollFailures ?? 0) + 1;
        check.pollFailures = failures;
        dirty = true;
        log.warn("long-check.poll-failed", { failures, error: formatLogError(error) });
        if (failures >= LONG_CHECK_MAX_POLL_FAILURES) {
          settleLongCheckAsError(
            check,
            `The validation worker could not report on this check: ${errorMessage(error)}`,
            at,
          );
        }
      }
      if (check.status !== "running") {
        this.lastPolled.delete(check.id);
        this.lastPersisted.delete(check.id);
      }
    }
    if (await this.commentSettled(pipeline)) dirty = true;
    if (dirty) await this.deps.save(pipeline);
  }

  /** Writes each settled check's result on the pipeline's Kanban ticket once. */
  private async commentSettled(pipeline: BuildPipeline): Promise<boolean> {
    let changed = false;
    for (const check of pipeline.longChecks ?? []) {
      if (check.status === "running" || check.ticketComment === "posted") continue;
      if (check.ticketComment === "skipped") continue;
      if ((check.ticketCommentAttempts ?? 0) >= LONG_CHECK_MAX_COMMENT_ATTEMPTS) continue;
      changed = true;
      // A pipeline with no source at all was started on a ticket id by a
      // caller that predates sources; Linear and GitHub sources have no
      // Kanban ticket to write on.
      const taskId =
        pipeline.source?.type === "kanban"
          ? pipeline.source.taskId
          : pipeline.source
            ? undefined
            : pipeline.taskId;
      if (!taskId) {
        check.ticketComment = "skipped";
        continue;
      }
      check.ticketCommentAttempts = (check.ticketCommentAttempts ?? 0) + 1;
      try {
        await this.deps.invoke("add_kanban_comment", {
          taskId,
          text: longCheckTicketComment(check),
        });
        check.ticketComment = "posted";
      } catch (error) {
        check.ticketComment = "failed";
        log.warn("long-check.comment-failed", { error: formatLogError(error) });
      }
    }
    return changed;
  }

  /** Cancels every running check, for a pipeline that is being stopped for good. */
  async cancelAll(pipeline: BuildPipeline): Promise<void> {
    for (const check of pipeline.longChecks ?? []) {
      if (check.status !== "running") continue;
      try {
        const run = isLongCheckRunUnsettled(check.run)
          ? workerRun(
              check,
              await this.deps.invoke<unknown>("cancel_review_validation", {
                environmentId: pipeline.environmentId,
                run: check.run,
              }),
            )
          : check.run;
        if (!applyLongCheckRun(check, run)) {
          settleLongCheckAsError(check, "The pipeline stopped before this check finished.");
        }
      } catch (error) {
        log.warn("long-check.cancel-failed", { error: formatLogError(error) });
        settleLongCheckAsError(check, "The pipeline stopped before this check finished.");
      }
    }
  }
}
