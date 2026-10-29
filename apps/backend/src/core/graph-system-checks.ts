/**
 * `wait-for-checks` (plan P2.7, D20): waits for a pull request's CI checks
 * through the PR monitor, within a bound, and reports `check-summary@1`.
 *
 * - **No polling of its own.** Every call reads the PR monitor's in-memory
 *   state for the run's environment (`checkSummary`: passed, total and
 *   pending counts); the executor subscribes to the monitor's events and
 *   flags the activation when one is announced for the environment, and
 *   otherwise looks again only when the deadline (or the no-checks grace)
 *   falls due. The first call asks the monitor to watch the environment's
 *   pull request (`pr_monitor_watch`), which checks it once at once.
 * - **The bound** is `timeoutMinutes` (default 60, at most 360), counted from
 *   the first call and recorded in the effect journal
 *   (`wait-for-checks:<slot>`), so a restart keeps the deadline.
 * - **The decision**: a failing check fails it at once (as GitHub's rollup
 *   does); no pending check and at least one passed passes it; still pending
 *   at the deadline reports `pending`; no checks at all for 2 minutes (or at
 *   the deadline) reports `none`. Then it reads the rollup once
 *   (`gh pr view --json headRefOid,statusCheckRollup`) for the failing
 *   checks' names and the head commit, and reports from that read.
 */
import {
  GRAPH_FAILING_CHECK_CONCLUSIONS,
  type GraphCheckSummaryState,
} from "@orkestrator/protocol/graphs/types";
import { parsePrCheckSummary } from "./commands-review.js";
import { resolveGitHubRepository } from "./github.js";
import {
  GraphSystemActionError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import type { GraphWorkspaceValue } from "./graph-system-push.js";

/** No checks reported this long after the wait starts means the repository has none. */
export const GRAPH_CHECKS_NONE_GRACE_MS = 120_000;
/** Final rollup reads that may fail before the counts alone are reported. */
const MAX_FINAL_READ_FAILURES = 3;
/** A failed final read is tried again this soon. */
const FINAL_READ_RETRY_MS = 15_000;
const MAX_FAILING = 256;
const MAX_NAME_CHARS = 200;
const MAX_URL_CHARS = 1_000;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type FailingConclusion = (typeof GRAPH_FAILING_CHECK_CONCLUSIONS)[number];

export interface GraphCheckSummaryV1 {
  state: GraphCheckSummaryState;
  headRef: string | null;
  total: number;
  pending: number;
  failing: Array<{
    name: string;
    conclusion: FailingConclusion;
    detailsUrl: string | null;
    summary: string | null;
  }>;
}

const CONCLUSIONS: Readonly<Record<string, FailingConclusion>> = {
  FAILURE: "failure",
  STARTUP_FAILURE: "failure",
  ERROR: "failure",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed-out",
  ACTION_REQUIRED: "action-required",
  STALE: "stale",
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** The failing entries of GitHub's `statusCheckRollup` (check runs and status contexts). */
export function graphFailingChecks(rollup: unknown): GraphCheckSummaryV1["failing"] {
  if (!Array.isArray(rollup)) return [];
  const failing: GraphCheckSummaryV1["failing"] = [];
  for (const raw of rollup) {
    if (typeof raw !== "object" || raw === null) continue;
    const check = raw as Record<string, unknown>;
    const status = typeof check.status === "string" ? check.status.toUpperCase() : null;
    // A queued or running check run keeps a stale conclusion; it is pending, not failing.
    if (status !== null && status !== "COMPLETED") continue;
    const outcome =
      typeof check.conclusion === "string"
        ? check.conclusion.toUpperCase()
        : typeof check.state === "string"
          ? check.state.toUpperCase()
          : "";
    const conclusion = CONCLUSIONS[outcome];
    if (!conclusion) continue;
    failing.push({
      name: text(check.name, MAX_NAME_CHARS) ?? text(check.context, MAX_NAME_CHARS) ?? "check",
      conclusion,
      detailsUrl: text(check.detailsUrl, MAX_URL_CHARS) ?? text(check.targetUrl, MAX_URL_CHARS),
      summary: null,
    });
    if (failing.length >= MAX_FAILING) break;
  }
  return failing;
}

/** The rolled-up state of counts and failing checks (`check-summary@1`'s rules). */
export function graphCheckState(
  total: number,
  pending: number,
  failing: number,
): GraphCheckSummaryState {
  if (total === 0) return "none";
  if (failing > 0) return "failed";
  return pending > 0 ? "pending" : "passed";
}

/** Final-read failures per activation (process memory; a restart reads again). */
const readFailures = new Map<string, number>();

interface WaitRecord {
  startedAt: number;
  deadline: number;
}

async function waitRecord(ctx: GraphSystemActionContext): Promise<WaitRecord> {
  const key = ctx.slotKey();
  const existing = await ctx.effectRecord(key);
  const fromData = (data: Record<string, unknown> | undefined): WaitRecord | null => {
    const startedAt = typeof data?.startedAt === "string" ? Date.parse(data.startedAt) : NaN;
    const deadline = typeof data?.deadline === "string" ? Date.parse(data.deadline) : NaN;
    return Number.isFinite(startedAt) && Number.isFinite(deadline) ? { startedAt, deadline } : null;
  };
  const recorded = existing?.state === "done" ? fromData(existing.data) : null;
  if (recorded) return recorded;
  const minutes = typeof ctx.params.timeoutMinutes === "number" ? ctx.params.timeoutMinutes : 60;
  const started = ctx.now().getTime();
  const data = {
    startedAt: new Date(started).toISOString(),
    deadline: new Date(started + minutes * 60_000).toISOString(),
  };
  const stored = await ctx.effect(
    key,
    async () => {
      // One check now; afterwards the monitor's own cadence.
      await ctx.deps.prMonitor.watch(ctx.environmentId).catch(() => undefined);
      return data;
    },
    { data },
  );
  return fromData(stored) ?? { startedAt: started, deadline: started + minutes * 60_000 };
}

/** One read of the pull request's rollup; null when it could not be read. */
async function readRollup(
  ctx: GraphSystemActionContext,
  url: string,
): Promise<{ headRef: string | null; rollup: unknown[] } | null> {
  try {
    const environment = await ctx.environment();
    const project = await ctx.deps.storage.getProject(ctx.run.projectId);
    const repository = project ? resolveGitHubRepository(project.gitUrl) : null;
    const output = await ctx.deps.shell.gh(
      environment,
      [
        "pr",
        "view",
        url,
        ...(repository ? ["--repo", `${repository.owner}/${repository.name}`] : []),
        "--json",
        "headRefOid,statusCheckRollup",
      ],
      { signal: ctx.signal },
    );
    const parsed = JSON.parse(output) as { headRefOid?: unknown; statusCheckRollup?: unknown };
    return {
      headRef:
        typeof parsed.headRefOid === "string" && COMMIT.test(parsed.headRefOid)
          ? parsed.headRefOid
          : null,
      rollup: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [],
    };
  } catch {
    return null;
  }
}

export const waitForChecksAction: GraphSystemActionHandler = {
  action: "wait-for-checks",
  async wait(ctx) {
    const pr = await ctx.requireInput<{ url: string }>("pr-result@1");
    const workspace = await ctx.input<GraphWorkspaceValue>("workspace@1");
    const { startedAt, deadline } = await waitRecord(ctx);
    const now = ctx.now().getTime();
    const timedOut = now >= deadline;
    const memory = `${ctx.run.id}\0${ctx.activation.key}`;
    const waiting = (dueAt: number) => ({
      state: "waiting" as const,
      observeAfterMs: Math.max(0, Math.min(deadline, dueAt) - now),
      watchEnvironment: ctx.environmentId,
    });

    const monitored = ctx.deps.prMonitor.state(ctx.environmentId);
    if (monitored?.prUrl && monitored.prUrl !== pr.url) {
      throw new GraphSystemActionError(
        "The PR monitor watches another pull request on this environment; wait-for-checks follows the environment's own pull request",
      );
    }
    const summary = monitored?.checkSummary ?? null;
    const failingCount = summary ? summary.total - summary.passed - summary.pending : 0;
    const graceEnds = startedAt + GRAPH_CHECKS_NONE_GRACE_MS;
    const decided =
      timedOut ||
      (summary !== null &&
        (failingCount > 0 ||
          (summary.total > 0 && summary.pending === 0) ||
          (summary.total === 0 && now >= graceEnds)));
    if (!decided) {
      return waiting(summary?.total === 0 ? graceEnds : Number.POSITIVE_INFINITY);
    }

    const read = await readRollup(ctx, pr.url);
    let result: GraphCheckSummaryV1;
    if (read) {
      readFailures.delete(memory);
      const counts = parsePrCheckSummary(read.rollup);
      const failing = graphFailingChecks(read.rollup);
      const state = graphCheckState(counts.total, counts.pending, failing.length);
      // The read is newer than the monitor: keep waiting if it says so.
      if (!timedOut && (state === "pending" || (state === "none" && now < graceEnds))) {
        return waiting(state === "none" ? graceEnds : Number.POSITIVE_INFINITY);
      }
      result = {
        state,
        headRef: read.headRef ?? workspace?.headRef ?? null,
        total: counts.total,
        pending: counts.pending,
        failing,
      };
    } else {
      const failures = (readFailures.get(memory) ?? 0) + 1;
      readFailures.set(memory, failures);
      if (failures < MAX_FINAL_READ_FAILURES) return waiting(now + FINAL_READ_RETRY_MS);
      readFailures.delete(memory);
      // The counts alone: failing checks are listed without names.
      const total = summary?.total ?? 0;
      const pending = summary?.pending ?? 0;
      const failing = Array.from(
        { length: Math.min(MAX_FAILING, Math.max(0, failingCount)) },
        () => ({
          name: "check",
          conclusion: "failure" as const,
          detailsUrl: null,
          summary: "The check's name could not be read",
        }),
      );
      result = {
        state: graphCheckState(total, pending, failing.length),
        headRef: workspace?.headRef ?? null,
        total,
        pending,
        failing,
      };
    }
    await ctx.output("check-summary@1", result);
    return { state: "complete" };
  },
};
