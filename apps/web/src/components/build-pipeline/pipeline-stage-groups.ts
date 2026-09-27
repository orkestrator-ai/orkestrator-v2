import {
  isReviewPackagePreparationSession,
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewSlot,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { BuildPipeline, PipelineSession } from "@/stores/buildPipelineStore";
import { formatElapsedWithHours } from "@/lib/format-elapsed";

export type PipelineStageItem =
  | { kind: "session"; id: string; key: string; session: PipelineSession }
  | { kind: "validation"; id: string; key: string };

export type ValidationRun = NonNullable<BuildPipeline["validationRun"]>;
export type ValidationOutcome = "running" | "failed" | "cancelled" | "incomplete" | "passed";

/**
 * Lifecycle `completed` means every command finished, not that they passed.
 * Failed is reserved for run-level faults (HEAD moved, runner died), so the
 * stage icon has to read the per-command results as well. Cancellation is a
 * distinct terminal state: the run stopped, it did not fail.
 */
export function validationOutcome(run: ValidationRun | undefined): ValidationOutcome {
  const status = run?.status;
  if (status === "planned" || status === "running") return "running";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  const results = run?.results ?? [];
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "incomplete")) return "incomplete";
  return "passed";
}

export function validationStageSummary(run: ValidationRun): string {
  if (run.status === "failed") {
    const error = run.error?.trim();
    return error && error.length > 0 ? error : "Validation failed";
  }
  if (run.status === "cancelled") {
    const error = run.error?.trim();
    return error && error.length > 0 ? error : "Validation cancelled";
  }
  const commandCount = run.plan.commands.length;
  const checkWord = commandCount === 1 ? "check" : "checks";
  const outcome = validationOutcome(run);
  if (outcome === "failed" && run.status === "completed") {
    const failed = run.results.filter((result) => result.status === "failed").length;
    return failed === commandCount
      ? `${failed} ${checkWord} failed`
      : `${failed} of ${commandCount} ${checkWord} failed`;
  }
  if (outcome === "incomplete") {
    const incomplete = run.results.filter((result) => result.status === "incomplete").length;
    return incomplete === commandCount
      ? `${incomplete} ${checkWord} incomplete`
      : `${incomplete} of ${commandCount} ${checkWord} incomplete`;
  }
  return `${commandCount} ${checkWord}`;
}

/**
 * Validation is backend-owned work rather than an agent session, but it is a
 * first-class pipeline stage to the reader. Insert it immediately after the
 * package-preparation turn that discovered the commands, leaving the review
 * sessions below it in their existing order.
 */
export function pipelineStageItems(pipeline: BuildPipeline): PipelineStageItem[] {
  const items: PipelineStageItem[] = pipeline.sessions.map((session) => ({
    kind: "session",
    id: session.sdkSessionId,
    key: session.sessionKey,
    session,
  }));
  if (!pipeline.validationRun) return items;

  const validationItem: PipelineStageItem = {
    kind: "validation",
    id: `validation:${pipeline.validationRun.id}`,
    key: `validation-${pipeline.validationRun.id}`,
  };
  let preparationIndex = -1;
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    if (isReviewPackagePreparationSession(pipeline.sessions[index], pipeline)) {
      preparationIndex = index;
      break;
    }
  }
  if (preparationIndex >= 0) {
    items.splice(preparationIndex + 1, 0, validationItem);
    return items;
  }

  // Old persisted snapshots can have validation evidence without the labelled
  // preparation session. It still belongs before the first review it supplied.
  const firstReviewIndex = pipeline.sessions.findIndex((session) => session.phase === "review");
  items.splice(firstReviewIndex >= 0 ? firstReviewIndex : items.length, 0, validationItem);
  return items;
}

export type PipelineStageGroupKind =
  | "setup"
  | "build"
  | "review"
  | "address"
  | "verify"
  | "fix"
  | "ship";

/**
 * `paused` and `error` describe the group the pipeline stopped in; `running`
 * is the group it is working through now, or one with a member still running.
 * Terminal Tests outcomes that did not pass stay distinct from `done`.
 */
export type PipelineStageGroupStatus =
  | "running"
  | "paused"
  | "error"
  | "incomplete"
  | "cancelled"
  | "done";

export interface PipelineStageGroup {
  /** Stable across snapshots: new groups append, so the ordinal never shifts. */
  key: string;
  kind: PipelineStageGroupKind;
  iteration: number;
  name: string;
  items: PipelineStageItem[];
  status: PipelineStageGroupStatus;
  /** The group holding the pipeline's current stage, while it has not completed. */
  current: boolean;
  /** One-line account of a settled group, shown while it is collapsed. */
  summary: string | null;
  /** Issues in the accepted report this review group produced. */
  issueCount?: number;
  /** Rows for Ship work that has not happened yet. Not stages: nothing to select. */
  pending: Array<{ key: string; label: string; meta?: string }>;
  startMs?: number;
  /** Absent while the group is running, and for old snapshots without end times. */
  endMs?: number;
}

export interface UpcomingStageGroup {
  kind: PipelineStageGroupKind;
  name: string;
  /** Runs only on some paths, e.g. Address after a clean review is skipped. */
  conditional: boolean;
}

export interface PipelineStageTimeline {
  groups: PipelineStageGroup[];
  upcoming: UpcomingStageGroup[];
  /** Phases reached so far, counting the one in progress. */
  phasesReached: number;
  /** Reached plus the upcoming phases every pipeline still has to pass through. */
  phaseTotal: number;
  startMs?: number;
  /** Absent while the pipeline is still going, and when no end is recorded. */
  endMs?: number;
  /** Whether the elapsed clock is still running. */
  running: boolean;
}

export interface PipelineStageGroupOptions {
  /** Issues in the report a review session produced, when it has a current one. */
  reportIssueCount?: (session: PipelineSession) => number | undefined;
}

const GROUP_NAMES: Record<PipelineStageGroupKind, string> = {
  setup: "Setup",
  build: "Build",
  review: "Review",
  address: "Address",
  verify: "Verify",
  fix: "Fix",
  ship: "Ship",
};

const GROUP_KIND_BY_PHASE: Record<PipelineSessionPhase, PipelineStageGroupKind> = {
  build: "build",
  review: "review",
  address: "address",
  verify: "verify",
  fix: "fix",
  pr: "ship",
  "resolve-conflicts": "ship",
};

/** The route a pipeline takes when nothing fails. Fix only enters on a failed verify. */
const FORWARD_KINDS: readonly PipelineStageGroupKind[] = [
  "build",
  "review",
  "address",
  "verify",
  "ship",
];

const SETUP_PHASES = new Set<string>([
  "creating-environment",
  "starting-environment",
  "waiting-for-setup",
]);

const ITERATED_KINDS = new Set<PipelineStageGroupKind>([
  "build",
  "review",
  "address",
  "verify",
  "fix",
]);

function groupName(kind: PipelineStageGroupKind, iteration: number): string {
  const name = GROUP_NAMES[kind];
  return iteration > 0 && ITERATED_KINDS.has(kind) ? `${name} · ${iteration + 1}` : name;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function itemTiming(
  item: PipelineStageItem,
  pipeline: BuildPipeline,
): {
  start?: number;
  end?: number;
  running: boolean;
  error: boolean;
  incomplete: boolean;
  cancelled: boolean;
} {
  if (item.kind === "validation") {
    const run = pipeline.validationRun;
    const outcome = validationOutcome(run);
    return {
      start: timestamp(run?.startedAt),
      end: timestamp(run?.completedAt),
      running: outcome === "running",
      error: outcome === "failed",
      incomplete: outcome === "incomplete",
      cancelled: outcome === "cancelled",
    };
  }
  return {
    start: timestamp(item.session.startedAt),
    end: timestamp(item.session.completedAt),
    running: item.session.status === "running",
    error: item.session.status === "error",
    incomplete: false,
    cancelled: false,
  };
}

function isIndependentReview(session: PipelineSession): boolean {
  return session.phase === "review" && pipelineIndependentReviewSlot(session.label) !== null;
}

/** "Build Session" reads as "Build" inside a group summary. */
function shortStageName(item: PipelineStageItem, pipeline: BuildPipeline): string {
  if (item.kind === "validation") {
    const run = pipeline.validationRun;
    if (!run) return "Tests";
    if (validationOutcome(run) === "passed") {
      const passed = run.results.filter((result) => result.status === "passed").length;
      return `Tests ${passed}/${run.plan.commands.length} passed`;
    }
    if (validationOutcome(run) === "running") return "Tests running";
    return `Tests: ${validationStageSummary(run)}`;
  }
  if (item.session.label === REVIEW_PACKAGE_SESSION_LABEL) return "Package prep";
  return item.session.label.replace(/ Session$/, "");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function groupSummary(
  group: PipelineStageGroup,
  pipeline: BuildPipeline,
  later: readonly PipelineStageGroup[],
  previous: PipelineStageGroup | undefined,
): string | null {
  switch (group.kind) {
    case "setup":
      return null;
    case "review": {
      const reviewers = group.items.filter(
        (item) => item.kind === "session" && isIndependentReview(item.session),
      ).length;
      if (reviewers === 0) return null;
      const consolidated = group.items.some(
        (item) => item.kind === "session" && !isIndependentReview(item.session),
      );
      return `${plural(reviewers, "reviewer")}${consolidated ? " · consolidated" : ""}`;
    }
    case "address":
      return previous?.kind === "review" && previous.issueCount !== undefined
        ? `Addressed ${plural(previous.issueCount, "issue")}`
        : null;
    case "verify": {
      // A later fix group can only exist because this verification failed.
      if (later.some((next) => next.kind === "fix")) return "Verdict: failed";
      if (later.some((next) => next.kind === "verify")) return null;
      if (pipeline.verificationResult === "pass") return "Verdict: passed";
      if (pipeline.verificationResult === "fail") return "Verdict: failed";
      return null;
    }
    default: {
      const names = group.items.map((item) => shortStageName(item, pipeline));
      return names.length > 0 ? names.join(" · ") : null;
    }
  }
}

function groupIssueCount(
  group: PipelineStageGroup,
  options: PipelineStageGroupOptions,
): number | undefined {
  if (group.kind !== "review" || !options.reportIssueCount) return undefined;
  // The accepted report is the consolidated one, or the classic single review's.
  for (let index = group.items.length - 1; index >= 0; index -= 1) {
    const item = group.items[index]!;
    if (item.kind !== "session" || isIndependentReview(item.session)) continue;
    const count = options.reportIssueCount(item.session);
    if (count !== undefined) return count;
  }
  return undefined;
}

/**
 * The stage list as a timeline of phases.
 *
 * Walks the stage items in pipeline order and starts a new group whenever the
 * phase kind or the iteration changes, so a fix loop's second review is its own
 * group rather than being folded into the first. Setup is derived: it has no
 * session, but it is time the reader waited through.
 */
export function pipelineStageGroups(
  pipeline: BuildPipeline,
  items: readonly PipelineStageItem[] = pipelineStageItems(pipeline),
  options: PipelineStageGroupOptions = {},
): PipelineStageTimeline {
  const createdMs = timestamp(pipeline.createdAt);
  const groups: PipelineStageGroup[] = [];
  const seen = new Map<string, number>();
  const newGroup = (kind: PipelineStageGroupKind, iteration: number): PipelineStageGroup => {
    const base = kind === "setup" ? "setup" : `${kind}-${iteration + 1}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const group: PipelineStageGroup = {
      key: occurrence === 1 ? base : `${base}-${occurrence}`,
      kind,
      iteration,
      name: groupName(kind, iteration),
      items: [],
      status: "done",
      current: false,
      summary: null,
      pending: [],
    };
    groups.push(group);
    return group;
  };

  const setup = newGroup("setup", 0);
  let open: PipelineStageGroup | undefined;
  for (const item of items) {
    if (item.kind === "validation") {
      // Tests belong to the implementation work whose package they checked.
      if (!open || (open.kind !== "build" && open.kind !== "fix")) {
        open = newGroup("build", open?.iteration ?? 0);
      }
      open.items.push(item);
      continue;
    }
    const { session } = item;
    // The backend runs package preparation as a fix-phase turn even after the
    // first build, but to the reader it finishes the implementation it follows.
    const preparesPackage =
      session.label === REVIEW_PACKAGE_SESSION_LABEL &&
      (open?.kind === "build" || open?.kind === "fix") &&
      open.iteration === session.iteration;
    const kind = preparesPackage ? open!.kind : GROUP_KIND_BY_PHASE[session.phase];
    // Ship is not re-entered per iteration: a conflict fix is part of shipping.
    if (!open || open.kind !== kind || (kind !== "ship" && open.iteration !== session.iteration)) {
      open = newGroup(kind, session.iteration);
    }
    open.items.push(item);
  }

  const phase = pipeline.phase;
  const stoppedFrom =
    phase === "paused"
      ? pipeline.pausedFromPhase
      : phase === "failed"
        ? pipeline.failureContext?.phase
        : undefined;
  const complete = phase === "complete";
  const hasSessions = groups.length > 1;
  const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
  let currentGroup: PipelineStageGroup | undefined;
  if (!complete) {
    if (!hasSessions || SETUP_PHASES.has(phase) || (stoppedFrom && SETUP_PHASES.has(stoppedFrom))) {
      currentGroup = setup;
    } else if (currentSession) {
      currentGroup = groups.find((group) =>
        group.items.some(
          (item) =>
            item.kind === "session" && item.session.sessionKey === currentSession.sessionKey,
        ),
      );
    }
    currentGroup ??= groups.at(-1);
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const timings = group.items.map((item) => itemTiming(item, pipeline));
    if (group.kind === "setup") {
      group.startMs = createdMs;
    } else {
      const starts = timings.flatMap((timing) =>
        timing.start === undefined ? [] : [timing.start],
      );
      group.startMs = starts.length > 0 ? Math.min(...starts) : undefined;
    }
    group.current = group === currentGroup;
    const memberRunning = timings.some((timing) => timing.running);
    const memberError = timings.some((timing) => timing.error);
    const memberIncomplete = timings.some((timing) => timing.incomplete);
    const memberCancelled = timings.some((timing) => timing.cancelled);
    if (group.current && phase === "failed") group.status = "error";
    else if (group.current && phase === "paused") group.status = "paused";
    else if (group.current || memberRunning) group.status = "running";
    else if (memberError) group.status = "error";
    else if (memberIncomplete) group.status = "incomplete";
    else if (memberCancelled) group.status = "cancelled";
    else group.status = "done";
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const nextStart = groups.slice(index + 1).find((later) => later.startMs !== undefined)?.startMs;
    if (group.status === "running") {
      group.endMs = undefined;
    } else if (group.kind === "setup") {
      group.endMs = nextStart;
    } else {
      const timings = group.items.map((item) => itemTiming(item, pipeline));
      const ends = timings.flatMap((timing) => (timing.end === undefined ? [] : [timing.end]));
      group.endMs =
        timings.length > 0 && ends.length === timings.length ? Math.max(...ends) : nextStart;
    }
    group.issueCount = groupIssueCount(group, options);
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    group.summary = groupSummary(group, pipeline, groups.slice(index + 1), groups[index - 1]);
    if (group.kind === "ship" && group.current && phase !== "failed") {
      const conflictsRan = group.items.some(
        (item) => item.kind === "session" && item.session.phase === "resolve-conflicts",
      );
      if (!conflictsRan) {
        group.pending.push({
          key: "conflicts",
          label: "Conflict check",
          meta: "if needed",
        });
      }
      group.pending.push({ key: "complete", label: "Complete" });
    }
  }

  const last = hasSessions ? groups.at(-1)! : setup;
  const upcoming: UpcomingStageGroup[] = [];
  if (!complete && phase !== "failed") {
    const lastKind = last.kind === "fix" ? "build" : last.kind;
    const from = last.kind === "setup" ? 0 : FORWARD_KINDS.indexOf(lastKind) + 1;
    for (const kind of FORWARD_KINDS.slice(from)) {
      upcoming.push({
        kind,
        name: groupName(kind, last.kind === "setup" ? 0 : last.iteration),
        conditional: kind === "address",
      });
    }
  }

  const running = !complete && phase !== "failed" && phase !== "paused";
  let endMs: number | undefined;
  if (!running) {
    const ends = groups.flatMap((group) => (group.endMs === undefined ? [] : [group.endMs]));
    endMs = ends.length > 0 ? Math.max(...ends) : undefined;
  }
  const phaseTotal = groups.length + upcoming.filter((group) => !group.conditional).length;
  return {
    groups,
    upcoming,
    phasesReached: groups.length,
    phaseTotal,
    startMs: createdMs,
    endMs,
    running,
  };
}

/** Which group each stage item sits in, keyed by the item's selection id. */
export function stageGroupKeyByItemId(timeline: PipelineStageTimeline): Map<string, string> {
  const byItem = new Map<string, string>();
  for (const group of timeline.groups) {
    for (const item of group.items) byItem.set(item.id, group.key);
  }
  return byItem;
}

/** Elapsed time for a span, or null when either end is unknown. */
export function formatStageSpan(
  startMs: number | undefined,
  endMs: number | undefined,
  running: boolean,
  now: number,
): string | null {
  if (startMs === undefined) return null;
  const end = running ? now : endMs;
  if (end === undefined) return null;
  return formatElapsedWithHours(Math.max(0, Math.floor((end - startMs) / 1_000)));
}
