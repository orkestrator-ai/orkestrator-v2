/**
 * What the run view, and anything else that watches a graph run, reads
 * (plan P2.11, report §7.7): run summaries for a list, the revisioned run
 * snapshot, bounded artifact and transcript reads, and which user actions an
 * activation offers.
 *
 * The run record stays the authority (invariant 1). A view rehydrates from
 * `graph_run_get` when it mounts, when a `graph-run` change is announced and
 * on a safety check, and applies a snapshot only when its revision is newer
 * than the one it holds; `knownRevision` makes the refetch cheap when nothing
 * moved. Closing a view never cancels anything.
 *
 * Commands (backend `commands-registry-graph-runs.ts`):
 *
 * | Command | Arguments | Result |
 * | --- | --- | --- |
 * | `graph_runs_list` | `{environmentId}` | {@link GraphRunSummary}`[]`, newest first |
 * | `graph_run_get` | `{runId, knownRevision?}` | {@link GraphRunGetResult} |
 * | `graph_run_cancel`, `graph_run_pause`, `graph_run_resume` | `{runId}` | {@link GraphRunGetResult} (`changed`) |
 * | `graph_run_retry`, `graph_run_skip` | `{runId, activationKey}` | {@link GraphRunGetResult} (`changed`) |
 * | `graph_run_artifact` | `{runId, artifactId}` | {@link GraphRunArtifactView} |
 * | `graph_run_transcript` | `{runId, activationKey, fromIndex?, maxBytes?}` | {@link GraphRunTranscriptView} |
 * | `graph_run_answer` | items 204, 208 (`waitId`: a human node) | the activation's question or wait |
 * | `graph_run_pending` | `{runId}` or `{environmentId}` | `GraphRunPendingInteraction[]` (`run-human.ts`) |
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */
import type { GraphErrorCause } from "./types.js";
import {
  GRAPH_RUN_TERMINAL_STATUSES,
  type GraphActivationSession,
  type GraphArtifact,
  type GraphArtifactFile,
  type GraphRun,
  type GraphRunStatus,
  type GraphRunTemplateRef,
  type GraphRunUsage,
  type NodeActivation,
} from "./run-model.js";

const KIB = 1024;
const MIB = 1024 * KIB;

export const GRAPH_RUN_VIEW_BOUNDS = Object.freeze({
  /** Runs one `graph_runs_list` returns (an environment's newest). */
  maxListedRuns: 200,
  /** Canonical JSON bytes of a value an artifact read returns inline. */
  maxArtifactViewBytes: 512 * KIB,
  /** The default and the largest window one transcript read returns. */
  defaultTranscriptReadBytes: 2 * MIB,
  maxTranscriptReadBytes: 4 * MIB,
} as const);

/** One run in a list: what a row shows, without the frozen plan or the activations. */
export interface GraphRunSummary {
  id: string;
  projectId: string;
  environmentId?: string;
  template: GraphRunTemplateRef;
  /** The template's name when the run was launched (frozen in the plan). */
  name: string;
  status: GraphRunStatus;
  mock: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  errorCause?: GraphErrorCause;
  usage: GraphRunUsage;
  /** Activations that are not superseded, by what they are doing. */
  activations: {
    live: number;
    running: number;
    awaitingHuman: number;
    complete: number;
    failed: number;
  };
}

/** `graph_run_get`: the snapshot, or `unchanged` when `knownRevision` is current. */
export type GraphRunGetResult =
  { status: "changed"; run: GraphRun } | { status: "unchanged"; revision: number };

/**
 * `graph_run_artifact`: the envelope and, for a value that fits
 * {@link GRAPH_RUN_VIEW_BOUNDS.maxArtifactViewBytes}, the value. A reference
 * artifact returns its sealed file's metadata (path, hash, bytes) and its
 * descriptor value, never the file's contents.
 */
export interface GraphRunArtifactView {
  artifact: Omit<GraphArtifact, "body">;
  file?: GraphArtifactFile;
  value?: unknown;
  /** Why `value` is absent although the artifact has one. */
  valueOmitted?: "too-large";
}

/** `graph_run_transcript`: one window of an agent activation's stored display transcript. */
export type GraphRunTranscriptView =
  | {
      status: "found";
      /** Provider messages, as the pipeline stores them. */
      messages: unknown[];
      /** Index of `messages[0]` in the stored transcript. */
      startIndex: number;
      messageCount: number;
      /** The display revision the window was read at. */
      revision: number;
      /** False when the store had to omit messages for its size bounds. */
      complete: boolean;
      /** The window stopped at `maxBytes`; more messages follow. */
      truncated?: true;
    }
  /** The activation has no stored transcript yet (not started, or not an agent node). */
  | { status: "none" }
  /** A reference exists but the store no longer has it. */
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

function isTerminal(status: GraphRunStatus): boolean {
  return (GRAPH_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function graphRunSummary(run: GraphRun): GraphRunSummary {
  const counts = { live: 0, running: 0, awaitingHuman: 0, complete: 0, failed: 0 };
  for (const activation of run.activations) {
    if (activation.state === "superseded") continue;
    counts.live += 1;
    if (activation.state === "running" || activation.state === "admitting") counts.running += 1;
    else if (activation.state === "awaiting-human") counts.awaitingHuman += 1;
    else if (activation.state === "complete") counts.complete += 1;
    else if (activation.state === "failed") counts.failed += 1;
  }
  return {
    id: run.id,
    projectId: run.projectId,
    ...(run.environmentId !== undefined ? { environmentId: run.environmentId } : {}),
    template: { ...run.template },
    name: run.plan.template.name,
    status: run.status,
    mock: run.mock,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.errorCause !== undefined ? { errorCause: run.errorCause } : {}),
    usage: { ...run.usage },
    activations: counts,
  };
}

/** Session fields the runtime keeps for itself: prompt text the view never shows. */
const VIEW_OMITTED_SESSION_FIELDS = ["repairPrompt", "continuationPrompt"] as const;

/**
 * The run as a view receives it: the record without the session fields that
 * hold the runtime's own prompts (a schema repair or continuation can be
 * 192 KiB each), so a snapshot stays small. Everything the view shows is kept.
 */
export function graphRunViewSnapshot(run: GraphRun): GraphRun {
  if (!run.activations.some((activation) => activation.session && hasOmitted(activation.session))) {
    return run;
  }
  return {
    ...run,
    activations: run.activations.map((activation) => {
      if (!activation.session || !hasOmitted(activation.session)) return activation;
      const session: Record<string, unknown> = { ...activation.session };
      for (const field of VIEW_OMITTED_SESSION_FIELDS) delete session[field];
      return { ...activation, session: session as unknown as GraphActivationSession };
    }),
  };
}

function hasOmitted(session: GraphActivationSession): boolean {
  return VIEW_OMITTED_SESSION_FIELDS.some((field) => session[field] !== undefined);
}

/** Newest first; ties by id, so the order is stable. */
export function compareGraphRunsNewestFirst(
  left: Pick<GraphRun, "createdAt" | "id">,
  right: Pick<GraphRun, "createdAt" | "id">,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// ---------------------------------------------------------------- user actions

/** Run statuses in which the runtime still plans and admits work (or will, once resumed). */
const LIVE_RUN_STATUSES: readonly GraphRunStatus[] = ["running", "waiting", "paused"];

/** Whether the run takes a run-wide action now. */
export function graphRunActions(run: Pick<GraphRun, "status">): {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
} {
  return {
    pause: run.status === "running" || run.status === "waiting",
    resume: run.status === "paused",
    cancel: !isTerminal(run.status) && run.status !== "cancelling",
  };
}

/** The newest activation of one node position (iteration and branch), superseded ones included. */
function latestOfSlot(run: GraphRun, activation: NodeActivation): NodeActivation {
  let latest = activation;
  for (const candidate of run.activations) {
    if (
      candidate.nodeId === activation.nodeId &&
      candidate.iteration === activation.iteration &&
      candidate.branchKey === activation.branchKey &&
      candidate.attempt > latest.attempt
    ) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * Why `graph_run_retry` refuses an activation, or null when it takes it.
 * Retry reruns one failed node position as a new attempt with the same
 * inputs (report §8.4: "the user can retry one branch"), while the run is
 * still live: running, waiting or paused. A failed run is restarted from a
 * node instead (item 210).
 */
export function graphActivationRetryRefusal(
  run: GraphRun,
  activation: NodeActivation,
): string | null {
  if (!LIVE_RUN_STATUSES.includes(run.status)) {
    return `A ${run.status} run takes no retries; restart from a node instead`;
  }
  if (activation.state !== "failed") return `A ${activation.state} activation cannot be retried`;
  if (latestOfSlot(run, activation).key !== activation.key) {
    return "A newer attempt of this node already exists";
  }
  return null;
}

/**
 * Why `graph_run_skip` refuses an activation, or null when it takes it. Skip
 * settles a position that has not been admitted yet (`waiting` or `ready`:
 * held back by a pause, a workspace lock or the run's limits) as `skipped`,
 * so consumers that require its outputs are skipped too.
 */
export function graphActivationSkipRefusal(
  run: GraphRun,
  activation: NodeActivation,
): string | null {
  if (!LIVE_RUN_STATUSES.includes(run.status)) {
    return `A ${run.status} run takes no skips`;
  }
  if (activation.state !== "waiting" && activation.state !== "ready") {
    return `A ${activation.state} activation cannot be skipped`;
  }
  return null;
}
