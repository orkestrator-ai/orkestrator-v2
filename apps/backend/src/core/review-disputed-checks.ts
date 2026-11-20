import { createHash } from "node:crypto";
import {
  STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  STRUCTURED_REVIEW_MAX_COMMAND_BYTES,
  utf8Bytes,
  type ReviewCommandResult,
  type StructuredReviewReport,
  type ReviewContractValidationIssue,
} from "@orkestrator/protocol/structured-review";
import {
  isReviewValidationRun,
  newReviewValidationRun,
  type ReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { WORKFLOW_RESULT_MAX_BYTES } from "@orkestrator/protocol/workflow-results";

/** The quoting `validationPreparation` applies to a command's cwd (`quoteShell`). */
function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Every reason the backend records for a disputed check starts with this. */
export const DISPUTED_CHECK_REASON = "Review reports disagree.";

/** A disputed command the sealed validation plan does not contain. */
export const DISPUTED_CHECK_UNPLANNED_REASON = `${DISPUTED_CHECK_REASON} It is not a command of the sealed validation plan, so the backend has no approved way to re-run it.`;

/**
 * At most this many disputed checks are re-run per consolidation, together in
 * one validation run. The rest are recorded as not re-run.
 */
export const MAX_DISPUTED_CHECK_RERUNS = 4;

/**
 * Upper bound for one re-run command. A planned command with a longer budget
 * is re-run under this one, so a disputed full suite cannot hold the
 * consolidation for hours; running out is recorded, never read as a pass.
 */
export const DISPUTED_CHECK_RERUN_MAX_MS = 30 * 60_000;

/**
 * Prefix of the `summary` the backend writes on a re-run's `commandsRun`
 * entry. The result tool refuses every disputed `commandsRun` claim from a
 * model, so an entry with this prefix on an accepted report is the backend's.
 */
export const DISPUTED_CHECK_RERUN_SUMMARY_PREFIX =
  "Re-run by the backend after review reports disagreed";

const DISPUTE_LIMITATION_BYTES = 512;
// Reserve bounded space for backend evidence, including the reported command
// and both artifact paths for each of the four observed results.
const DISPUTE_PROJECTION_BYTES =
  MAX_DISPUTED_CHECK_RERUNS * (6 * STRUCTURED_REVIEW_MAX_COMMAND_BYTES + 1024) +
  DISPUTE_LIMITATION_BYTES;

const CHECK_LIMITATION = "Disputed validation outcomes:";

/** Compare each reviewer's last outcome for a check, preserving shell argument text. */
export function disputedReviewChecks(
  reports: readonly Pick<StructuredReviewReport, "reviewScope">[],
  plan?: ReviewValidationPlan,
): Set<string> {
  const results = new Map<string, "passed" | "failed">();
  const disputed = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  for (const report of reports) {
    const latest = new Map<string, "passed" | "failed">();
    for (const { command, result } of report.reviewScope?.commandsRun ?? []) {
      const planned = plan && plannedCommandFor(command, plan);
      const key = planned ? sealedCommand(planned) : command;
      latest.set(key, result);
      const spellings = aliases.get(key) ?? new Set<string>();
      spellings.add(command);
      if (planned) {
        if (utf8Bytes(key) <= STRUCTURED_REVIEW_MAX_COMMAND_BYTES) spellings.add(key);
        if (plannedCommandFor(planned.command, plan)?.id === planned.id) {
          if (utf8Bytes(planned.command) <= STRUCTURED_REVIEW_MAX_COMMAND_BYTES)
            spellings.add(planned.command);
        }
      }
      aliases.set(key, spellings);
    }
    for (const [key, result] of latest) {
      const previous = results.get(key);
      if (previous !== undefined && previous !== result) disputed.add(key);
      results.set(key, result);
    }
  }
  return new Set(Array.from(disputed).flatMap((key) => Array.from(aliases.get(key)!)));
}

/** What the backend observed when it re-ran one disputed check. */
export type DisputedCheckRerun =
  | {
      command: string;
      result: "passed" | "failed";
      headRef: string;
      exitCode: number | null;
      stdoutPath: string | null;
      stderrPath: string | null;
    }
  | { command: string; result: "not-run"; reason: string };

/**
 * The re-runs a consolidation records, keyed by the disputed command text.
 * Every disputed command has an entry once the re-run has settled.
 */
export type DisputedCheckReruns = ReadonlyMap<string, DisputedCheckRerun>;

/** One planned re-run: the validation run to execute and the disputes it settles. */
export interface DisputedCheckRerunRequest {
  /** Absent when no disputed command can be re-run. */
  run?: ReviewValidationRun;
  /** Disputed command → the validation result id that re-runs it. */
  commands: ReadonlyMap<string, string>;
  /** Disputed commands that are not re-run, with the recorded reason. */
  notRun: ReadonlyMap<string, string>;
  headRef: string;
}

/** Starts or reads a validation run in the environment (`start_review_validation`). */
export type DisputedCheckRerunControl = (run: ReviewValidationRun) => Promise<ReviewValidationRun>;

/**
 * The planned command a disputed command names. Sealed packages record a
 * command as `cd <quoted cwd> && <command>` (`validationPreparation`); a
 * reviewer may also have copied the bare command, which matches only when
 * exactly one planned command has that text.
 */
function sealedCommand(command: ReviewValidationPlan["commands"][number]): string {
  return `cd ${quoteShell(command.cwd)} && ${command.command}`;
}

function plannedCommandFor(
  disputed: string,
  plan: ReviewValidationPlan,
): ReviewValidationPlan["commands"][number] | undefined {
  const text = disputed.trim();
  const sealed = plan.commands.filter((command) => text === sealedCommand(command));
  if (sealed.length > 0) return sealed.length === 1 ? sealed[0] : undefined;
  const bare = plan.commands.filter((command) => command.command.trim() === text);
  return bare.length === 1 ? bare[0] : undefined;
}

/**
 * Deterministic so a backend restart, a schema repair or a second pass joins
 * the run already claimed in the environment instead of starting another.
 */
export function disputedCheckRerunId(scopeKey: string, headRef: string, commands: string[]) {
  const digest = createHash("sha256")
    .update([scopeKey, headRef, ...commands].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `review-dispute-rerun-${digest}`;
}

/**
 * Chooses which disputed checks to re-run and builds their validation run.
 *
 * Only a command of the sealed validation plan is re-run: reviewer text never
 * selects a shell command. The plan must have been discovered at the reviewed
 * commit, and the worker refuses to run when HEAD is anywhere else, so the
 * result describes the reviewed snapshot.
 */
export function disputedCheckRerunRequest(input: {
  disputes: ReadonlySet<string>;
  plan: ReviewValidationPlan | undefined;
  headRef: string;
  scopeKey: string;
}): DisputedCheckRerunRequest | undefined {
  if (input.disputes.size === 0) return undefined;
  const disputes = Array.from(input.disputes).sort();
  const notRun = new Map<string, string>();
  const selected: Array<{ disputed: string; planned: ReviewValidationPlan["commands"][number] }> =
    [];
  for (const disputed of disputes) {
    if (!input.plan) {
      notRun.set(
        disputed,
        `${DISPUTED_CHECK_REASON} The review has no sealed validation plan, so the backend has no approved way to re-run it.`,
      );
      continue;
    }
    if (input.plan.headRef !== input.headRef) {
      notRun.set(
        disputed,
        `${DISPUTED_CHECK_REASON} The sealed validation plan was not discovered at the reviewed commit, so it was not re-run.`,
      );
      continue;
    }
    const planned = plannedCommandFor(disputed, input.plan);
    if (!planned) {
      notRun.set(disputed, DISPUTED_CHECK_UNPLANNED_REASON);
    } else if (selected.some((entry) => entry.planned.id === planned.id)) {
      // Two spellings of one planned command share its single re-run.
      selected.push({ disputed, planned });
    } else if (
      new Set(selected.map((entry) => entry.planned.id)).size >= MAX_DISPUTED_CHECK_RERUNS
    ) {
      notRun.set(
        disputed,
        `${DISPUTED_CHECK_REASON} The backend re-runs at most ${MAX_DISPUTED_CHECK_RERUNS} disputed checks per review; this one was not re-run.`,
      );
    } else {
      selected.push({ disputed, planned });
    }
  }
  if (selected.length === 0) return { commands: new Map(), notRun, headRef: input.headRef };
  const needed = new Set(selected.map(({ planned }) => planned.id));
  // Plans are in dependency order. Walk backwards to collect transitive setup,
  // then preserve the original ordering and IDs in the worker's plan.
  for (const command of input.plan!.commands.toReversed()) {
    if (needed.has(command.id)) {
      for (const dependency of command.dependsOn) needed.add(dependency);
    }
  }
  const commands = input
    .plan!.commands.filter(({ id }) => needed.has(id))
    .map((command) => ({
      ...command,
      timeoutMs: Math.min(command.timeoutMs, DISPUTED_CHECK_RERUN_MAX_MS),
    }));
  const disputed = new Map(selected.map(({ disputed, planned }) => [disputed, planned.id]));
  const plan: ReviewValidationPlan = { headRef: input.headRef, commands, limitations: [] };
  const run = newReviewValidationRun(
    disputedCheckRerunId(input.scopeKey, input.headRef, ["v2", JSON.stringify(plan)]),
    plan,
  );
  return { run, commands: disputed, notRun, headRef: input.headRef };
}

const UNSETTLED_RUN = new Set(["planned", "running"]);

/**
 * Advances the re-run one step. Answers `"pending"` while the environment's
 * worker is still running it; the caller tries again on its next pass. Every
 * failure to obtain a result is recorded as not re-run, never as a pass.
 */
export async function advanceDisputedCheckRerun(
  request: DisputedCheckRerunRequest,
  control: DisputedCheckRerunControl | undefined,
): Promise<DisputedCheckReruns | "pending"> {
  const reruns = new Map<string, DisputedCheckRerun>();
  for (const [command, reason] of request.notRun) {
    reruns.set(command, { command, result: "not-run", reason });
  }
  if (!request.run) return reruns;
  const notRun = (reason: string) => {
    for (const command of request.commands.keys()) {
      reruns.set(command, {
        command,
        result: "not-run",
        reason: `${DISPUTED_CHECK_REASON} ${reason}`,
      });
    }
    return reruns;
  };
  if (!control) return notRun("No validation runner was available to re-run it.");
  let run: ReviewValidationRun;
  try {
    // The worker claims a run id once; a later start reads the claimed run.
    run = await control(request.run);
  } catch {
    return notRun("The backend could not start or read its re-run in the environment.");
  }
  if (!isReviewValidationRun(run) || run.id !== request.run.id) {
    return notRun("The environment returned no usable re-run record.");
  }
  if (UNSETTLED_RUN.has(run.status)) return "pending";
  if (JSON.stringify(run.plan) !== JSON.stringify(request.run.plan)) {
    return notRun("Its re-run did not use the sealed command plan.");
  }
  if (run.environmentChanges?.length || run.environmentChangesOmitted) {
    return notRun("The workspace differed from the reviewed commit during its re-run.");
  }
  const commandsById = new Map(request.run.plan.commands.map((command) => [command.id, command]));
  const resultsById = new Map(run.results.map((result) => [result.id, result]));
  const passedSetup = new Set<string>();
  for (const planned of request.run.plan.commands) {
    const observed = resultsById.get(planned.id);
    if (
      observed?.status === "passed" &&
      (observed.executedCommand ?? observed.command) === planned.command &&
      planned.dependsOn.every((id) => passedSetup.has(id))
    ) {
      passedSetup.add(planned.id);
    }
  }
  const setupPassed = (id: string) => passedSetup.has(id);
  if (run.status !== "completed") {
    return notRun(
      run.status === "cancelled"
        ? "Its re-run was cancelled before it finished."
        : "Its re-run did not complete on the reviewed commit.",
    );
  }
  const aliases = new Map<string, string>();
  for (const [command, id] of request.commands) {
    const planned = commandsById.get(id)!;
    const existing = aliases.get(id);
    if (!existing || command === sealedCommand(planned)) aliases.set(id, command);
  }
  for (const [id, command] of aliases) {
    const planned = commandsById.get(id)!;
    const result = resultsById.get(id);
    const executed = result?.executedCommand ?? result?.command;
    const reason =
      executed !== undefined && executed !== planned.command
        ? `The scheduler ran ${executed} in its place.`
        : !planned.dependsOn.every(setupPassed)
          ? "Its re-run prerequisites did not execute as planned and pass."
          : undefined;
    if (reason) {
      reruns.set(command, {
        command,
        result: "not-run",
        reason: `${DISPUTED_CHECK_REASON} ${reason}`,
      });
    } else if (result?.status === "passed" || result?.status === "failed") {
      reruns.set(command, {
        command,
        result: result.status,
        headRef: request.headRef,
        exitCode: result.exitCode,
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
      });
    } else {
      reruns.set(command, {
        command,
        result: "not-run",
        reason: `${DISPUTED_CHECK_REASON} Its re-run ${result?.status === "skipped" ? "was skipped" : "did not finish"}${result?.limitation && utf8Bytes(result.limitation) <= 512 ? `: ${result.limitation}` : "."}`,
      });
    }
  }
  for (const [alias, id] of request.commands) reruns.set(alias, reruns.get(aliases.get(id)!)!);
  return reruns;
}

function rerunSummary(rerun: Extract<DisputedCheckRerun, { result: "passed" | "failed" }>) {
  const output = [rerun.stdoutPath, rerun.stderrPath].filter(Boolean).join(" and ");
  return `${DISPUTED_CHECK_RERUN_SUMMARY_PREFIX}, on the reviewed commit ${rerun.headRef}: ${rerun.result}${rerun.exitCode === null ? "" : ` (exit ${rerun.exitCode})`}.${output ? ` Output: ${output}.` : ""}`;
}

function backendRerunEntry(entry: ReviewCommandResult): boolean {
  return entry.summary.startsWith(DISPUTED_CHECK_RERUN_SUMMARY_PREFIX);
}

/**
 * Reviewer and consolidator text carry no execution authority. Resolve the
 * representation in the backend, using the same rule regardless of transport.
 * Preserve an explicit count if the report schema cannot fit every entry.
 *
 * With `reruns`, each re-run that produced a result goes into `commandsRun`
 * with the backend's summary, and every other disputed check into
 * `commandsNotRun` with its reason. Without `reruns` (a report the backend
 * already recorded, such as an accepted graph artifact read back), the
 * backend's own re-run entries are kept and the rest are recorded as not
 * re-run.
 */
export function recordDisputedChecks(
  report: StructuredReviewReport,
  disputes: ReadonlySet<string>,
  reruns?: DisputedCheckReruns,
  plan?: ReviewValidationPlan,
) {
  if (disputes.size === 0) return report;
  const { reviewScope } = report;
  const kept = new Map<string, ReviewCommandResult | { command: string; reason: string }>();
  if (!reruns) {
    for (const entry of reviewScope.commandsRun) {
      if (disputes.has(entry.command) && backendRerunEntry(entry)) kept.set(entry.command, entry);
    }
    for (const entry of reviewScope.commandsNotRun) {
      if (
        disputes.has(entry.command) &&
        !kept.has(entry.command) &&
        entry.reason.startsWith(DISPUTED_CHECK_REASON)
      ) {
        kept.set(entry.command, entry);
      }
    }
  }
  const commandsRun = reviewScope.commandsRun.filter((entry) => !disputes.has(entry.command));
  const commandsNotRun = reviewScope.commandsNotRun.filter((entry) => !disputes.has(entry.command));
  const limitations = reviewScope.limitations.filter(
    (entry) => !entry.startsWith(CHECK_LIMITATION),
  );
  const scope = { ...reviewScope, commandsRun, commandsNotRun, limitations };
  const rerun: ReviewCommandResult[] = [];
  const pending: typeof commandsNotRun = [];
  // Leave room for the limitation and its omitted count in the final report.
  let remaining =
    WORKFLOW_RESULT_MAX_BYTES -
    utf8Bytes(JSON.stringify({ ...report, reviewScope: scope })) -
    DISPUTE_LIMITATION_BYTES;
  let omitted = 0;
  const entries = new Map<string, ReviewCommandResult | { command: string; reason: string }>();
  const group = (command: string) => {
    const planned = plan && plannedCommandFor(command, plan);
    return planned ? `plan:${planned.id}` : `command:${command}`;
  };
  for (const command of Array.from(disputes).sort()) {
    const observed = reruns?.get(command);
    const known = kept.get(command);
    const entry =
      known ??
      (observed && observed.result !== "not-run"
        ? { command: observed.command, result: observed.result, summary: rerunSummary(observed) }
        : {
            command: observed?.command ?? command,
            reason: observed?.reason ?? `${DISPUTED_CHECK_REASON} It was not re-run.`,
          });
    const key = group(entry.command);
    if (observed || known || !entries.has(key)) entries.set(key, entry);
  }
  // Observed results have priority over unresolved disputes and model scope.
  for (const entry of entries.values()) {
    if (!("result" in entry)) continue;
    const bytes = utf8Bytes(JSON.stringify(entry)) + 1;
    while (
      commandsRun.length &&
      (rerun.length + commandsRun.length >= STRUCTURED_REVIEW_MAX_LIST_ITEMS || bytes > remaining)
    ) {
      remaining += utf8Bytes(JSON.stringify(commandsRun.pop())) + 1;
    }
    rerun.push(entry);
    remaining -= bytes;
  }
  for (const entry of entries.values()) {
    if ("result" in entry) continue;
    const bytes = utf8Bytes(JSON.stringify(entry)) + 1;
    if (
      pending.length + commandsNotRun.length >= STRUCTURED_REVIEW_MAX_LIST_ITEMS ||
      bytes > remaining
    ) {
      omitted += 1;
      continue;
    }
    pending.push(entry);
    remaining -= bytes;
  }
  const parts = [
    rerun.length
      ? `${rerun.length} re-run by the backend on the reviewed commit, with the observed result in commandsRun`
      : "",
    pending.length ? `${pending.length} not re-run, with the reason in commandsNotRun` : "",
    omitted ? `${omitted} further disputed checks exceeded the report limit` : "",
  ].filter(Boolean);
  const limitation = `${CHECK_LIMITATION} ${parts.join("; ")}.`;
  return {
    ...report,
    reviewScope: {
      ...scope,
      commandsRun: [...rerun, ...commandsRun],
      commandsNotRun: [...pending, ...commandsNotRun],
      limitations: [limitation, ...limitations].slice(0, STRUCTURED_REVIEW_MAX_LIST_ITEMS),
    },
  };
}

function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export function disputedCheckDigests(disputes: ReadonlySet<string>): string[] {
  return Array.from(disputes, commandDigest);
}

/** Leave room for observed worker results before accepting a consolidator's report. */
export function disputedCheckProjectionBudgetIssues(
  value: unknown,
): ReviewContractValidationIssue[] {
  return utf8Bytes(JSON.stringify(value)) > WORKFLOW_RESULT_MAX_BYTES - DISPUTE_PROJECTION_BYTES
    ? [
        {
          path: "$",
          code: "invalid_value",
          message: "Shorten the report to leave room for the backend's disputed-check evidence.",
        },
      ]
    : [];
}

/** Refuse claims before the result becomes final. Re-run entries are backend-owned. */
export function disputedCheckSubmissionIssues(
  value: unknown,
  digests: readonly string[] | undefined,
): ReviewContractValidationIssue[] {
  if (!digests?.length) return [];
  const budget = disputedCheckProjectionBudgetIssues(value);
  if (budget.length > 0) return budget;
  const scope = (value as Partial<StructuredReviewReport>).reviewScope;
  if (!Array.isArray(scope?.commandsRun)) return [];
  const disputed = new Set(digests);
  return scope.commandsRun.flatMap((entry, index) =>
    typeof entry?.command === "string" && disputed.has(commandDigest(entry.command))
      ? [
          {
            path: `$.reviewScope.commandsRun[${index}]`,
            code: "invalid_value",
            message:
              "Remove this disputed outcome from commandsRun. The backend re-runs disputed checks and records the result itself.",
          },
        ]
      : [],
  );
}

/**
 * Plans and advances the re-run of a panel's disputed checks in one call.
 * Answers an empty map when nothing is disputed, and `"pending"` while the
 * environment's worker is still running the re-run.
 */
export async function settleDisputedCheckReruns(input: {
  disputes: ReadonlySet<string>;
  plan: ReviewValidationPlan | undefined;
  headRef: string | undefined;
  scopeKey: string;
  control: DisputedCheckRerunControl | undefined;
}): Promise<DisputedCheckReruns | "pending"> {
  const request = disputedCheckRerunRequest({
    disputes: input.disputes,
    plan: input.headRef ? input.plan : undefined,
    headRef: input.headRef ?? "",
    scopeKey: input.scopeKey,
  });
  return request ? advanceDisputedCheckRerun(request, input.control) : new Map();
}
