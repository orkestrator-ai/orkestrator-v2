/**
 * The Multi Review flow graph's model: what state each node and edge is in,
 * where the nodes sit, and the findings the completed reviewers have reported.
 *
 * Everything here is a pure reading of the workflow snapshot. The tab decides
 * the step states (`reviewPackageGenerationStep` and friends); this module only
 * maps them onto the graph so the mapping can be tested phase by phase.
 */

import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { ReviewSeverity } from "@orkestrator/protocol/structured-review";
import { MULTI_REVIEW_STEP_KINDS } from "@orkestrator/protocol/multi-review";

type Reviewer = MultiReviewWorkflow["reviewers"][number];

/**
 * One state vocabulary for every node. A queued reviewer and a step that has
 * not started look the same on the graph, so both are `not-started`.
 */
export type MultiReviewFlowState =
  | "not-started"
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "cancelling"
  | "cancelled";

export function reviewerFlowState(status: Reviewer["status"]): MultiReviewFlowState {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "not-started";
  }
}

/**
 * What an edge says about the work flowing along it.
 *
 * - `complete`: the source's output was consumed by a finished target.
 * - `active`: the target is working on it now.
 * - `ready`: the output exists and the target is waiting for its other inputs
 *   (a finished report before consolidation, a report before Fix).
 * - `pending`: nothing has flowed, or the source produced nothing usable.
 * - `failed`: the target failed while working on it.
 */
export type MultiReviewFlowEdgeState = "complete" | "active" | "ready" | "pending" | "failed";

/**
 * An edge carries its source's output, so an unfinished source flows nothing,
 * whatever the target is doing. A failed or stopped reviewer therefore never
 * lights the edge into consolidation: its report was not part of it.
 */
export function multiReviewFlowEdgeState(
  from: MultiReviewFlowState,
  to: MultiReviewFlowState,
  { waitingIsReady }: { waitingIsReady: boolean },
): MultiReviewFlowEdgeState {
  if (from !== "complete") return "pending";
  switch (to) {
    case "running":
      return "active";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "paused":
    case "not-started":
      return waitingIsReady ? "ready" : "pending";
    default:
      return "pending";
  }
}

export interface MultiReviewFlowEdges {
  /** Package → reviewer, one per reviewer in panel order. */
  intoReviewers: MultiReviewFlowEdgeState[];
  /** Reviewer → consolidation, one per reviewer in panel order. */
  intoConsolidation: MultiReviewFlowEdgeState[];
  intoFix: MultiReviewFlowEdgeState;
  intoPr: MultiReviewFlowEdgeState;
  prSource?: "consolidation" | "fix";
}

export function multiReviewFlowEdges(states: {
  package: MultiReviewFlowState;
  reviewers: readonly MultiReviewFlowState[];
  consolidation: MultiReviewFlowState;
  fix: MultiReviewFlowState;
  pr: MultiReviewFlowState;
  /**
   * A clean report goes straight to the PR without a Fix, so the work flowing
   * into the PR is consolidation's.
   */
  prFromConsolidation?: boolean;
}): MultiReviewFlowEdges {
  return {
    // A queued reviewer is waiting for admission, not for more input, so the
    // edge into it stays pending rather than ready.
    intoReviewers: states.reviewers.map((reviewer) =>
      multiReviewFlowEdgeState(states.package, reviewer, { waitingIsReady: false }),
    ),
    intoConsolidation: states.reviewers.map((reviewer) =>
      multiReviewFlowEdgeState(reviewer, states.consolidation, { waitingIsReady: true }),
    ),
    intoFix: multiReviewFlowEdgeState(states.consolidation, states.fix, { waitingIsReady: true }),
    prSource: states.prFromConsolidation ? "consolidation" : "fix",
    intoPr: multiReviewFlowEdgeState(
      states.prFromConsolidation ? states.consolidation : states.fix,
      states.pr,
      { waitingIsReady: true },
    ),
  };
}

/**
 * One connector standing for a whole group of edges, for the stacked layout
 * where reviewers share a single line in and a single line out.
 */
export function summarizeFlowEdges(
  edges: readonly MultiReviewFlowEdgeState[],
): MultiReviewFlowEdgeState {
  for (const state of ["active", "failed", "complete", "ready"] as const) {
    if (edges.includes(state)) return state;
  }
  return "pending";
}

/** Small label shown where a node that has not run would show its runtime. */
export function flowPendingLabel(
  kind: "package" | "reviewer" | "step",
  statusLabel: string,
): string {
  if (kind === "reviewer") return "queued";
  if (statusLabel.startsWith("Waiting")) return "waiting";
  if (statusLabel === "Ready to start") return "ready";
  return "not started";
}

/**
 * The node shown in the inspector when the user has not picked one: whatever
 * is running, else what is paused, else the node that was active most
 * recently. The pipeline runs in order, so the furthest stage that has been
 * reached is the most recent; among parallel reviewers the latest timestamp
 * decides, with ties going to the later node. A step that was cancelled
 * before it ever ran has not been reached.
 */
export function defaultFlowSelection(
  nodes: readonly {
    id: string;
    state: MultiReviewFlowState;
    /** Pipeline column: package 0, reviewers 1, consolidation 2, fix 3, PR 4. */
    stage: number;
    activityAt?: number;
  }[],
): string | null {
  for (const state of ["running", "paused"] as const) {
    const match = nodes.find((node) => node.state === state);
    if (match) return match.id;
  }
  const reached = nodes.filter(
    (node) =>
      node.state !== "not-started" &&
      !(
        (node.state === "cancelled" || node.state === "cancelling") &&
        node.activityAt === undefined
      ),
  );
  if (reached.length === 0) return nodes[0]?.id ?? null;
  const stage = Math.max(...reached.map((node) => node.stage));
  let latest = reached.find((node) => node.stage === stage)!;
  for (const node of reached) {
    if (node.stage !== stage) continue;
    if ((node.activityAt ?? -Infinity) >= (latest.activityAt ?? -Infinity)) latest = node;
  }
  return latest.id;
}

/** The latest moment a timing record shows activity, or undefined if none. */
export function latestActivityAt(
  ...timings: Array<{ startedAt?: string; completedAt?: string } | undefined>
): number | undefined {
  let latest: number | undefined;
  for (const timing of timings) {
    for (const value of [timing?.startedAt, timing?.completedAt]) {
      if (!value) continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) latest = parsed;
    }
  }
  return latest;
}

/**
 * Tokens the whole workflow has consumed: every reviewer plus each step's own
 * record. Workflows from before per-step records only have the sessions, which
 * are counted once each. Null when nothing has reported usage yet.
 */
export function multiReviewTotalTokens(workflow: MultiReviewWorkflow): number | null {
  let total = 0;
  let reported = false;
  const add = (count: number | undefined) => {
    if (count === undefined || !Number.isFinite(count)) return;
    total += count;
    reported = true;
  };
  for (const reviewer of workflow.reviewers) add(reviewer.tokenCount);
  if (workflow.stepRuntimes) {
    for (const kind of MULTI_REVIEW_STEP_KINDS) add(workflow.stepRuntimes[kind]?.tokenCount);
  } else {
    const sessions = new Map<string, number | undefined>();
    for (const session of [
      workflow.preparationSession,
      workflow.reviewSession,
      workflow.fixSession,
    ]) {
      if (session) sessions.set(session.sessionKey, session.tokenCount);
    }
    for (const count of sessions.values()) add(count);
  }
  return reported ? total : null;
}

/**
 * Wall time since the workflow was created. While something runs the clock is
 * live; once everything has settled it stops at the last recorded activity, so
 * a report waiting for the user does not keep counting.
 */
export function multiReviewElapsedSeconds(
  workflow: MultiReviewWorkflow,
  running: boolean,
  now: number,
): number | null {
  const start = Date.parse(workflow.createdAt);
  if (!Number.isFinite(start)) return null;
  let end = now;
  if (!running) {
    const latest = latestActivityAt(
      ...workflow.reviewers,
      ...MULTI_REVIEW_STEP_KINDS.map((kind) => workflow.stepRuntimes?.[kind]),
      workflow.validationRun,
    );
    const updated = Date.parse(workflow.updatedAt);
    end = latest ?? (Number.isFinite(updated) ? updated : now);
  }
  return Math.max(0, Math.floor((end - start) / 1_000));
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { P0: 0, P1: 1, P2: 2 };

export const MULTI_REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["P0", "P1", "P2"];

export function severityCounts(
  issues: readonly { severity: ReviewSeverity }[],
): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

/**
 * How far a source stands behind a finding. `confirmed` is in an accepted
 * report. The rest come from `report_finding` before any report was accepted:
 * `provisional` while the reviewer runs, `failed` or `stopped` once it ended
 * without one.
 */
export type MultiReviewFindingStanding = "confirmed" | "provisional" | "failed" | "stopped";

export interface MultiReviewFindingSource {
  reviewerId: string;
  /** Zero-based panel position; the UI shows it one-based. */
  index: number;
  agent: Reviewer["agent"];
  model: string;
  standing: MultiReviewFindingStanding;
}

export interface MultiReviewMergedFinding {
  key: string;
  severity: ReviewSeverity;
  title: string;
  file: string;
  line: number | null;
  sources: MultiReviewFindingSource[];
  /** No accepted report has it yet: every source reported it provisionally. */
  provisional: boolean;
}

function findingKey(issue: { file: string; line: number | null; title: string }): string {
  const title = issue.title.trim().toLowerCase().replace(/\s+/g, " ");
  return `${issue.file}\u0000${issue.line ?? ""}\u0000${title}`;
}

function provisionalStanding(status: Reviewer["status"]): MultiReviewFindingStanding | null {
  if (status === "running") return "provisional";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  return null;
}

/**
 * The findings reviewers have reported so far, with an issue several raised at
 * the same place under the same title listed once. This is a reading aid
 * before consolidation, not consolidation: reviewers that word the same
 * finding differently stay separate rows.
 *
 * Completed reviewers contribute their accepted reports. A reviewer still
 * running contributes what it reported through `report_finding`, and so does
 * one that failed or was stopped before a report was accepted; those rows are
 * marked as not confirmed by any report. Findings are never read out of a
 * transcript.
 */
export function mergeReviewerFindings(reviewers: readonly Reviewer[]): {
  findings: MultiReviewMergedFinding[];
  /** Completed reviewers whose accepted reports are counted. */
  reviewerCount: number;
  /** Rows no accepted report confirms yet. */
  provisionalCount: number;
} {
  const merged = new Map<string, MultiReviewMergedFinding>();
  let reviewerCount = 0;
  const add = (
    issue: { severity: ReviewSeverity; title: string; file: string; line: number | null },
    source: MultiReviewFindingSource,
  ) => {
    const key = findingKey(issue);
    const existing = merged.get(key);
    const confirmed = source.standing === "confirmed";
    if (!existing) {
      merged.set(key, {
        key,
        severity: issue.severity,
        title: issue.title,
        file: issue.file,
        line: issue.line,
        sources: [source],
        provisional: !confirmed,
      });
      return;
    }
    // A confirmed report decides the severity; provisional ones only until then.
    if (confirmed && existing.provisional) {
      existing.severity = issue.severity;
      existing.provisional = false;
    } else if (
      confirmed === !existing.provisional &&
      SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.severity]
    ) {
      existing.severity = issue.severity;
    }
    const known = existing.sources.findIndex((entry) => entry.reviewerId === source.reviewerId);
    if (known < 0) existing.sources.push(source);
    else if (confirmed) existing.sources[known] = source;
  };
  reviewers.forEach((reviewer, index) => {
    const base = { reviewerId: reviewer.id, index, agent: reviewer.agent, model: reviewer.model };
    if (reviewer.status === "completed" && reviewer.report) {
      reviewerCount += 1;
      for (const issue of reviewer.report.issues) add(issue, { ...base, standing: "confirmed" });
      return;
    }
    const standing = provisionalStanding(reviewer.status);
    if (!standing) return;
    for (const finding of reviewer.provisionalFindings ?? [])
      add(finding.issue, { ...base, standing });
  });
  const findings = [...merged.values()].sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      Number(left.provisional) - Number(right.provisional) ||
      right.sources.length - left.sources.length ||
      left.file.localeCompare(right.file) ||
      (left.line ?? 0) - (right.line ?? 0),
  );
  return {
    findings,
    reviewerCount,
    provisionalCount: findings.filter((finding) => finding.provisional).length,
  };
}

/**
 * The words a provisional row carries: still `provisional` while any of its
 * reviewers runs, `unconfirmed` once every one ended without a report.
 */
export function provisionalFindingLabel(finding: MultiReviewMergedFinding): string | null {
  if (!finding.provisional) return null;
  if (finding.sources.some((source) => source.standing === "provisional")) return "provisional";
  return finding.sources.some((source) => source.standing === "failed")
    ? "unconfirmed (reviewer failed)"
    : "unconfirmed (reviewer stopped)";
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Below this width the graph stacks into a single column. */
export const FLOW_GRAPH_STACK_BELOW = 960;
export const FLOW_GRAPH_MIN_HEIGHT = 460;
export const FLOW_NODE_HEIGHT = 64;
/** The package node carries a row of validation chips. */
export const FLOW_PACKAGE_NODE_HEIGHT = 92;

const MAX_CONTENT_WIDTH = 1440;
const PAD_X = 16;
/** Room above the nodes for the column labels. */
const NODE_TOP = 48;
const PAD_BOTTOM = 24;
const REVIEWER_GAP_MAX = 36;
const REVIEWER_GAP_MIN = 12;
/**
 * Package, reviewer, consolidation, fix and PR widths that fit each node's
 * name beside a typical `{elapsed} · {tokens}` without truncating.
 */
const COLUMN_NEEDS = [236, 266, 230, 160, 160] as const;
/** The same columns at full width, as designed. */
const COLUMN_FULL = [260, 270, 230, 230, 230] as const;
/**
 * The columns the width is shared between. The PR column follows them at the
 * same spacing, past the right edge when there is no room for it, so the
 * pipeline keeps its proportions and the canvas scrolls instead.
 */
const FITTED_COLUMNS = 4;
const COLUMN_GAP_MIN = 40;
const COLUMN_GAP_MAX = 140;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MultiReviewFlowLayout {
  width: number;
  height: number;
  /** Left edge of each column, where its label starts. */
  columns: { prepare: number; review: number; consolidate: number; fix: number; pr: number };
  package: FlowRect;
  reviewers: FlowRect[];
  consolidation: FlowRect;
  fix: FlowRect;
  pr: FlowRect;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Node positions for the left-to-right graph.
 *
 * Width goes to the nodes first, up to what their content needs and then to
 * their full size, and only then to the gaps that carry the edges, so a
 * narrower canvas shortens edges before it truncates names. Below the needed
 * width everything shrinks together. Package to Fix share the width; the PR
 * column follows at the same size and spacing, and widens the canvas past the
 * width when it does not fit beside them. Reviewers stack in the second
 * column; their spacing tightens to keep up to five inside the minimum height,
 * and past that the canvas grows rather than overlapping nodes. The other
 * nodes centre on the reviewer stack.
 */
export function multiReviewFlowLayout({
  width,
  reviewerCount,
  packageHasChips,
}: {
  width: number;
  reviewerCount: number;
  packageHasChips: boolean;
}): MultiReviewFlowLayout {
  const canvasWidth = Math.max(width, FLOW_GRAPH_STACK_BELOW);
  const span = Math.min(canvasWidth, MAX_CONTENT_WIDTH) - PAD_X * 2;
  const needs = COLUMN_NEEDS.slice(0, FITTED_COLUMNS);
  const gaps = FITTED_COLUMNS - 1;
  const fitted = sum(needs) + COLUMN_GAP_MIN * gaps;
  let widths: number[];
  let gap = COLUMN_GAP_MIN;
  if (span <= fitted) {
    const scale = (span - COLUMN_GAP_MIN * gaps) / sum(needs);
    widths = COLUMN_NEEDS.map((need) => need * scale);
  } else {
    const extra = span - fitted;
    const growth = sum(COLUMN_FULL.slice(0, FITTED_COLUMNS)) - sum(needs);
    const share = Math.min(1, extra / growth);
    widths = COLUMN_NEEDS.map((need, index) => need + (COLUMN_FULL[index]! - need) * share);
    gap = Math.min(COLUMN_GAP_MAX, COLUMN_GAP_MIN + Math.max(0, extra - growth) / gaps);
  }
  widths = widths.map((columnWidth) => Math.floor(columnWidth));
  const used = sum(widths) + gap * (widths.length - 1);
  // Centred when everything fits, otherwise flush left so only the PR column
  // runs past the right edge.
  const left = Math.max(PAD_X, (canvasWidth - used) / 2);
  const xs: number[] = [];
  let x = left;
  for (const columnWidth of widths) {
    xs.push(Math.round(x));
    x += columnWidth + gap;
  }
  const contentWidth = Math.max(canvasWidth, Math.ceil(xs.at(-1)! + widths.at(-1)! + PAD_X));

  const count = Math.max(0, Math.floor(reviewerCount));
  const fittingGap =
    count > 1
      ? (FLOW_GRAPH_MIN_HEIGHT - NODE_TOP - PAD_BOTTOM - count * FLOW_NODE_HEIGHT) / (count - 1)
      : REVIEWER_GAP_MAX;
  const reviewerGap = Math.floor(clamp(fittingGap, REVIEWER_GAP_MIN, REVIEWER_GAP_MAX));
  const stackHeight = count * FLOW_NODE_HEIGHT + Math.max(0, count - 1) * reviewerGap;
  const packageHeight = packageHasChips ? FLOW_PACKAGE_NODE_HEIGHT : FLOW_NODE_HEIGHT;
  const height = Math.max(
    FLOW_GRAPH_MIN_HEIGHT,
    NODE_TOP + Math.max(stackHeight, packageHeight) + PAD_BOTTOM,
  );
  const centerY = NODE_TOP + (height - NODE_TOP - PAD_BOTTOM) / 2;
  const stackTop = Math.round(centerY - stackHeight / 2);
  const centred = (rectHeight: number) => Math.round(centerY - rectHeight / 2);
  const single = (index: number): FlowRect => ({
    x: xs[index]!,
    y: centred(FLOW_NODE_HEIGHT),
    width: widths[index]!,
    height: FLOW_NODE_HEIGHT,
  });

  return {
    width: contentWidth,
    height,
    columns: { prepare: xs[0]!, review: xs[1]!, consolidate: xs[2]!, fix: xs[3]!, pr: xs[4]! },
    package: { x: xs[0]!, y: centred(packageHeight), width: widths[0]!, height: packageHeight },
    reviewers: Array.from({ length: count }, (_, index) => ({
      x: xs[1]!,
      y: stackTop + index * (FLOW_NODE_HEIGHT + reviewerGap),
      width: widths[1]!,
      height: FLOW_NODE_HEIGHT,
    })),
    consolidation: single(2),
    fix: single(3),
    pr: single(4),
  };
}

/**
 * A connector from the right edge of one node to the left edge of the next: a
 * cubic bézier that leaves and arrives horizontally, or a straight line when
 * the two are level.
 */
export function flowEdgePath(from: FlowRect, to: FlowRect): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

/** Route a clean report above the skipped Fix node. */
export function cleanReviewPrEdgePath(from: FlowRect, to: FlowRect): string {
  const start = from.x + from.width;
  const y = from.y + from.height / 2;
  const endY = to.y + to.height / 2;
  const bypassY = Math.min(from.y, to.y) - 24;
  return `M${start} ${y} C${start + 24} ${y} ${start + 24} ${bypassY} ${start + 48} ${bypassY} L${to.x - 48} ${bypassY} C${to.x - 24} ${bypassY} ${to.x - 24} ${endY} ${to.x} ${endY}`;
}
