/**
 * A worker's pull request as a coordinator sees it: the fields its
 * environment reads carry, and the statuses a followed PR wakes it for.
 *
 * Everything here is content-free: states, counts and the PR URL, never a
 * check's name, log or the PR's text. "Ready to merge" is decided by
 * `@orkestrator/protocol/pr-merge-readiness`, the rule the sidebar shimmer
 * uses, with the monitor's confirmation as its freshness.
 */
import { createHash } from "node:crypto";
import type { GitHubPullRequestMergeability } from "@orkestrator/protocol/github-pull-requests";
import {
  evaluatePrMergeReadiness,
  isPrMergeability,
  type PrMergeReadiness,
} from "@orkestrator/protocol/pr-merge-readiness";
import type { PrCheckSummary, PrState } from "@orkestrator/protocol/pr-monitor";
import type { CoordinatorStatus } from "./coordinator-status-wakes.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One environment's pull request reading, from its record and its node's PR monitor. */
export interface CoordinatorPrReading {
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  mergeability: GitHubPullRequestMergeability | null;
  checkSummary: PrCheckSummary | null;
  viewerCanMerge: boolean | null;
  /** The PR monitor that owns the worker vouches for the reading (its freshness). */
  confirmed: boolean;
  /** A Resolve tab's automatic PR recheck is still armed on the environment. */
  recheckArmed: boolean;
  /** When this node's monitor last had an answer from GitHub (ms); unknown for other nodes. */
  lastCheckAt?: number;
}

/** What a node summary or `RelayedPrMonitorHealth` carries about the monitor. */
export interface CoordinatorPrHealth {
  prMonitorConfirmed?: boolean;
  prCheckSummary?: PrCheckSummary | null;
  prViewerCanMerge?: boolean | null;
  lastSuccessfulCheckAt?: string | null;
}

const PR_STATES: ReadonlySet<unknown> = new Set(["open", "closed", "merged"]);

function checkSummaryFrom(value: unknown): PrCheckSummary | null {
  if (!isRecord(value)) return null;
  const { passed, total, pending } = value;
  if (
    typeof passed !== "number" ||
    typeof total !== "number" ||
    typeof pending !== "number" ||
    ![passed, total, pending].every((count) => Number.isSafeInteger(count) && count >= 0)
  )
    return null;
  return { passed, total, pending };
}

/**
 * The reading of an environment record (`get_environment`), with the health
 * of the monitor that owns it. Accepts the record's own field names
 * (`hasMergeConflicts`) and a node summary's (`prHasMergeConflicts`).
 */
export function prReadingFrom(environment: JsonRecord, health: CoordinatorPrHealth = {}) {
  const conflicts = environment.hasMergeConflicts ?? environment.prHasMergeConflicts;
  const lastCheck =
    typeof health.lastSuccessfulCheckAt === "string"
      ? Date.parse(health.lastSuccessfulCheckAt)
      : Number.NaN;
  const reading: CoordinatorPrReading = {
    prUrl: typeof environment.prUrl === "string" && environment.prUrl ? environment.prUrl : null,
    prState: PR_STATES.has(environment.prState) ? (environment.prState as PrState) : null,
    hasMergeConflicts: typeof conflicts === "boolean" ? conflicts : null,
    mergeability: isPrMergeability(environment.prMergeability) ? environment.prMergeability : null,
    checkSummary: checkSummaryFrom(health.prCheckSummary ?? environment.prCheckSummary),
    viewerCanMerge:
      typeof health.prViewerCanMerge === "boolean"
        ? health.prViewerCanMerge
        : typeof environment.prViewerCanMerge === "boolean"
          ? environment.prViewerCanMerge
          : null,
    // The health, when given, decides: a relayed row's own flag is not enough.
    confirmed:
      typeof health.prMonitorConfirmed === "boolean"
        ? health.prMonitorConfirmed
        : environment.prMonitorConfirmed === true,
    recheckArmed:
      typeof environment.prRecheckAfterAgentCompletionArmedAt === "string" &&
      environment.prRecheckAfterAgentCompletionArmedAt.length > 0,
    ...(Number.isFinite(lastCheck) ? { lastCheckAt: lastCheck } : {}),
  };
  return reading;
}

export function prChecks(
  summary: PrCheckSummary | null,
): { passed: number; failed: number; pending: number; total: number } | null {
  if (!summary || summary.total <= 0) return null;
  return {
    passed: summary.passed,
    failed: Math.max(0, summary.total - summary.passed - summary.pending),
    pending: summary.pending,
    total: summary.total,
  };
}

export function prReadiness(reading: CoordinatorPrReading): PrMergeReadiness {
  return evaluatePrMergeReadiness({
    prState: reading.prState,
    hasMergeConflicts: reading.hasMergeConflicts,
    mergeability: reading.mergeability,
    checkSummary: reading.checkSummary,
    viewerCanMerge: reading.viewerCanMerge,
    fresh: reading.confirmed,
  });
}

/**
 * The PR fields a coordinator's `get_environment` and `list_environments`
 * rows add to `prUrl` and `prState`; none for a worker without a pull request.
 */
export function coordinatorPrFields(reading: CoordinatorPrReading): JsonRecord {
  if (!reading.prUrl && !reading.prState) return {};
  const readiness = prReadiness(reading);
  return {
    prHasMergeConflicts: reading.hasMergeConflicts,
    prMergeability: reading.mergeability,
    prChecks: prChecks(reading.checkSummary),
    prReadyToMerge: readiness.ready,
    ...(readiness.ready ? {} : { prNotReadyReason: readiness.reason }),
  };
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * A `pull-request` association's follow for `list_workflows`: what started
 * it, the PR, whether it is still followed, the last state reported (the
 * state part of its status key) and a Resolve tab's progress. Content-free.
 */
export function pullRequestFollowSummary(association: JsonRecord): JsonRecord {
  const follow = isRecord(association.pullRequest) ? association.pullRequest : {};
  const notice = isRecord(association.statusNotice) ? association.statusNotice : null;
  const key = notice && typeof notice.key === "string" ? notice.key : null;
  const resolve = isRecord(follow.resolve) ? follow.resolve : null;
  return {
    source: follow.source ?? null,
    prUrl: typeof follow.prUrl === "string" ? follow.prUrl : null,
    following: !association.terminalNotifiedAt,
    lastReportedState: key ? `pr-${key.slice(0, key.indexOf(":"))}` : null,
    ...(resolve && typeof resolve.tabId === "string"
      ? {
          resolve: {
            tabId: resolve.tabId,
            state: resolve.notifiedAt ? "reported" : resolve.finishedAt ? "finished" : "running",
          },
        }
      : {}),
  };
}

/**
 * This node's monitor health for the listed rows that have a pull request,
 * in one read (`get_environment_pr_health`). Empty when it cannot be read: a
 * row then reports its PR fields but is never "ready to merge".
 */
export async function thisNodePrHealth(
  invoke: Invoke,
  projectId: string | undefined,
  environments: JsonRecord[],
): Promise<Map<string, CoordinatorPrHealth>> {
  const environmentIds = environments
    .filter((environment) => typeof environment.prUrl === "string" && environment.prUrl)
    .map((environment) => environment.id)
    .filter((id): id is string => typeof id === "string");
  if (!projectId || environmentIds.length === 0) return new Map();
  const health = await invoke<unknown>("get_environment_pr_health", {
    projectId,
    environmentIds,
  }).catch(() => null);
  if (!isRecord(health)) return new Map();
  return new Map(
    Object.entries(health).flatMap(([id, value]) =>
      isRecord(value) ? [[id, value as CoordinatorPrHealth] as const] : [],
    ),
  );
}

/**
 * The health another node relays for one of its rows (`NodeEnvironmentSummary`).
 * It vouches only while that node is connected and its summaries current, as
 * the renderer's own rows for that machine require.
 */
export function summaryPrHealth(node: JsonRecord, row: JsonRecord): CoordinatorPrHealth {
  return {
    prMonitorConfirmed:
      node.available === true &&
      node.freshness === "current" &&
      row.deleting !== true &&
      row.prMonitorConfirmed === true,
    prCheckSummary: checkSummaryFrom(row.prCheckSummary),
    prViewerCanMerge: typeof row.prViewerCanMerge === "boolean" ? row.prViewerCanMerge : null,
  };
}

/** Every row's relayed health on one connected node, from this node's summaries. */
export async function nodePrHealth(
  invoke: Invoke,
  nodeId: string,
): Promise<Map<string, CoordinatorPrHealth>> {
  const summaries = await invoke<unknown>("get_node_summaries").catch(() => null);
  const nodes = isRecord(summaries) && Array.isArray(summaries.nodes) ? summaries.nodes : [];
  const node = nodes.find(
    (entry): entry is JsonRecord => isRecord(entry) && entry.nodeId === nodeId,
  );
  if (!node || !Array.isArray(node.environments)) return new Map();
  return new Map(
    node.environments.flatMap((row: unknown) =>
      isRecord(row) && isRecord(row.ref) && typeof row.ref.environmentId === "string"
        ? [[row.ref.environmentId, summaryPrHealth(node, row)] as const]
        : [],
    ),
  );
}

/** What a followed PR's state amounts to, before any key is chosen. */
type PrCondition =
  | "merged"
  | "closed"
  | "conflicts"
  | "checks-failed"
  | "ready"
  /** Open, known, and nothing to act on (checks running, review required, behind). */
  | "quiet"
  /** Open, but the reading cannot tell yet (GitHub computing, monitor unconfirmed). */
  | "unknown"
  | "none";

function prCondition(reading: CoordinatorPrReading): PrCondition {
  if (!reading.prUrl) return "none";
  if (reading.prState === "merged") return "merged";
  if (reading.prState === "closed") return "closed";
  if (reading.prState !== "open") return "unknown";
  if (reading.hasMergeConflicts === true || reading.mergeability === "dirty") return "conflicts";
  const checks = prChecks(reading.checkSummary);
  if (checks && checks.failed > 0) return "checks-failed";
  const readiness = prReadiness(reading);
  if (readiness.ready) return "ready";
  if (
    !reading.confirmed ||
    readiness.reason === "stale" ||
    readiness.reason === "mergeability-unknown"
  )
    return "unknown";
  return "quiet";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The suffix every status key of one pull request ends with. */
export function prKeyTag(prUrl: string): string {
  return hash(prUrl);
}

function bounded(value: string, limit = 400): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** One line of the PR's state, for a notice. Content-free: states and counts. */
export function prStateLine(reading: CoordinatorPrReading): string {
  const checks = prChecks(reading.checkSummary);
  const readiness = prReadiness(reading);
  return [
    `State: ${reading.prState ?? "unknown"}`,
    `conflicts: ${reading.hasMergeConflicts === null ? "unknown" : reading.hasMergeConflicts ? "yes" : "no"}`,
    `mergeability: ${reading.mergeability ?? "unknown"}`,
    checks
      ? `checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending of ${checks.total}`
      : "checks: none reported",
    `ready to merge: ${readiness.ready ? "yes" : `no (${readiness.reason})`}`,
  ].join("; ");
}

function tools(environmentId: string, conflicts: boolean): string[] {
  return [
    `get_environment { "environmentId": "${environmentId}" }`,
    ...(conflicts ? [`resolve_conflicts { "environmentId": "${environmentId}" }`] : []),
  ];
}

/** A status recorded on the association without waking anyone. */
export interface PullRequestStatus {
  status: CoordinatorStatus;
  wake: boolean;
}

/**
 * The status of a followed pull request, or null while the reading says
 * nothing new (no PR yet, or GitHub still computing).
 *
 * Every wake is a change of state, keyed per PR URL: it opened, it
 * conflicts, a check failed, it is ready to merge, it merged, it closed.
 * Opened is sent once per PR; when the first reading is already conflicting,
 * failing or ready, that notice carries the URL instead. An open PR with
 * nothing to act on (`quiet`) is recorded without a wake, so the next failure
 * or conflict after a fix is news again, while an unknown reading in between
 * (GitHub recomputing after a push) is not a change at all.
 */
export function pullRequestStatus(
  reading: CoordinatorPrReading,
  environmentId: string,
  previousKey: string | undefined,
): PullRequestStatus | null {
  const condition = prCondition(reading);
  if (condition === "none" || !reading.prUrl) return null;
  const tag = prKeyTag(reading.prUrl);
  const told = previousKey?.endsWith(`:${tag}`) === true;
  const url = `Pull request: ${bounded(reading.prUrl)}`;
  const state = prStateLine(reading);
  const make = (
    key: string,
    noticeState: string,
    tone: CoordinatorStatus["tone"],
    headline: string,
    details: string[],
    terminal = false,
  ): CoordinatorStatus => ({
    key: `${key}:${tag}`,
    state: noticeState,
    tone,
    terminal,
    headline,
    details: [url, ...details],
    tools: tools(environmentId, key === "conflicts"),
    mode: "settled",
  });
  switch (condition) {
    case "merged":
      return {
        wake: true,
        status: make("merged", "pr-merged", "success", "was merged", [], true),
      };
    case "closed":
      return {
        wake: true,
        status: make(
          "closed",
          "pr-closed",
          "info",
          "was closed without merging",
          ["It is no longer followed; a reopened PR is not reported."],
          true,
        ),
      };
    case "conflicts":
      return {
        wake: true,
        status: make("conflicts", "pr-conflicts", "attention", "conflicts with its base branch", [
          state,
          "Resolve them with resolve_conflicts (the worker's Resolve tab), or tell the user.",
        ]),
      };
    case "checks-failed":
      return {
        wake: true,
        status: make("checks-failed", "pr-checks-failed", "failure", "has failing checks", [
          state,
          "Read the failing checks in the pull request; a worker can fix them on its branch.",
        ]),
      };
    case "ready":
      return {
        wake: true,
        status: make("ready", "pr-ready", "success", "is ready to merge", [
          state,
          "The user merges it; the coordinator never merges.",
        ]),
      };
    default:
      if (reading.prState !== "open") return null;
      if (!told)
        return {
          wake: true,
          status: make("opened", "pr-opened", "success", "is open", [
            state,
            "You will be woken when it conflicts, fails its checks, becomes ready to merge, or is merged or closed.",
          ]),
        };
      return condition === "quiet"
        ? { wake: false, status: make("open", "pr-open", "info", "is open", [state]) }
        : null;
  }
}

/**
 * The one report of a finished Resolve tab: what the pull request looks like
 * now. `refreshed` is false when the monitor had not rechecked it yet and
 * this is the last reading the report waited for.
 */
export function resolveFinishedStatus(
  reading: CoordinatorPrReading,
  environmentId: string,
  resolve: { tabId: string; requestedAt: string },
  refreshed: boolean,
): CoordinatorStatus {
  const condition = prCondition(reading);
  const headline =
    condition === "conflicts"
      ? "Resolve tab finished, but the pull request still conflicts"
      : condition === "merged"
        ? "Resolve tab finished; the pull request was merged"
        : condition === "closed"
          ? "Resolve tab finished; the pull request is closed"
          : condition === "checks-failed"
            ? "Resolve tab finished; the conflicts are gone but checks are failing"
            : condition === "ready"
              ? "Resolve tab finished; the pull request is ready to merge"
              : condition === "none"
                ? "Resolve tab finished; the worker has no pull request now"
                : "Resolve tab finished; the pull request no longer reports conflicts";
  return {
    key: `resolve:${hash(`${resolve.tabId}:${resolve.requestedAt}`)}`,
    state: "resolve-finished",
    tone:
      condition === "conflicts"
        ? "attention"
        : condition === "checks-failed"
          ? "failure"
          : condition === "ready" || condition === "merged"
            ? "success"
            : "info",
    terminal: false,
    headline,
    details: [
      ...(reading.prUrl ? [`Pull request: ${bounded(reading.prUrl)}`] : []),
      prStateLine(reading),
      `Resolve tab: ${resolve.tabId}.`,
      ...(refreshed ? [] : ["The PR monitor had not rechecked it yet; this is its last reading."]),
    ],
    tools: [
      ...tools(environmentId, condition === "conflicts"),
      `get_tab_transcript { "environmentId": "${environmentId}", "tabId": "${resolve.tabId}" }`,
    ],
    mode: "settled",
  };
}
