/**
 * Node-qualified project and environment summaries for the portal.
 *
 * A command node keeps a live read model of each connected node's projects
 * and environments and serves it to clients (`get_node_summaries`). These
 * are the bounded projections of a node's ordinary summary reads
 * (`get_projects`, `get_environment_snapshots`): names, status and activity
 * only, never transcripts, prompts, paths or credentials. Summary reads ask
 * for {@link NODE_SUMMARY_ENVIRONMENT_READ_ARGS}, which adds the node's PR
 * monitor health and live pipeline membership to each environment. The search fields
 * (`pathName`, `worktreeName`, `defaultBranch`, `createdAt`) carry what the
 * project search matches on: a directory's last segment, never its path.
 */

import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
  type EnvironmentRef,
  type ProjectRef,
} from "./federation.js";
import type { NodeView } from "./command-nodes.js";
import type { GitHubPullRequestMergeability } from "./github-pull-requests.js";
import { isPrMergeability } from "./pr-merge-readiness.js";
import { normalizeProjectIcon } from "./project-icon.js";
import {
  copyPrCheckSummary,
  isPrCheckSummary,
  type PrCheckSummary,
  type PrState,
} from "./pr-monitor.js";

export const NODE_SUMMARY_CHANGED_EVENT = "node-summary-changed";

/**
 * Extra `get_environment_snapshots` arguments for a summary read: each
 * environment then carries confirmation, viewer permission and check counts from the
 * node's runtime PR monitor, plus pipeline membership from existing records.
 * Nodes that predate it ignore the argument.
 */
export const NODE_SUMMARY_ENVIRONMENT_READ_ARGS = { includePrMonitorHealth: true } as const;

export const MAX_SUMMARY_PROJECTS = 500;
export const MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT = 500;
const MAX_TEXT = 256;
/** A directory name (the last path segment) is shown and matched, never the path. */
const MAX_PATH_NAME = 128;
const MAX_TIMESTAMP = 64;

export type SummaryFreshness = "initializing" | "current" | "catching-up" | "stale" | "degraded";

export type AgentActivity = "idle" | "working" | "waiting";

export interface NodeProjectSummary {
  ref: ProjectRef;
  key: string;
  name: string;
  order: number;
  folder?: string;
  /** Sanitized repository identity (host/owner/name), never a credentialed URL. */
  repositoryHint?: string;
  /**
   * Last segment of the project's checkout path, for search. Absent from
   * summaries read before it was added and for projects without a checkout.
   */
  pathName?: string;
  /**
   * The project's configured default branch, when the node sends it
   * (`get_projects` with `includeDefaultBranch`); older nodes do not.
   */
  defaultBranch?: string;
  /** The project's sidebar icon, a bounded raster data URL (`project-icon`). */
  icon?: string;
}

export interface NodeEnvironmentSummary {
  ref: EnvironmentRef;
  key: string;
  projectId: string;
  name: string;
  /** The node's own sidebar position within the project. */
  order: number;
  branch?: string;
  status: string;
  activity: AgentActivity;
  activityUpdatedAt?: string;
  lastActivityAt?: string;
  hasUnreadWork: boolean;
  environmentType?: string;
  /** Last segment of the environment's worktree path, for search. */
  worktreeName?: string;
  /** Owner clock; the search falls back to it when there is no activity time. */
  createdAt?: string;
  deleting: boolean;
  isProjectHome: boolean;
  /**
   * An existing build pipeline record names this environment, so
   * another machine's row can carry the same pipe marker as the node's own.
   * Absent otherwise, and from nodes that predate it.
   */
  buildPipeline?: true;
  /** The node will merge this environment's PR once it is ready. */
  autoMerge?: true;
  /**
   * The node's last PR reading, so a command node can decide "ready to merge"
   * (`pr-merge-readiness.ts`) for another machine's rows. States only, never
   * the PR URL. Absent from nodes that predate them, or without a PR.
   */
  prState?: PrState;
  prHasMergeConflicts?: boolean;
  prMergeability?: GitHubPullRequestMergeability;
  /**
   * The node's own monitor vouches for that reading
   * (`isPrReadingConfirmedByMonitor`): it answered a check for this PR in its
   * current lifetime and the latest check did not fail. Present only as `true`
   * from nodes asked with `includePrMonitorHealth`; absent means unconfirmed,
   * including from nodes that predate it.
   */
  prMonitorConfirmed?: true;
  /**
   * The node's cached merge permission for the credential it merges with.
   * Absent when unknown or from older nodes; only `false` blocks readiness.
   */
  prViewerCanMerge?: boolean;
  /** Bounded check counts from the leaf monitor; failing or pending checks veto readiness. */
  prCheckSummary?: PrCheckSummary;
}

/** One node in the portal: registry view, availability and last-known summaries. */
export interface NodeSummary {
  nodeId: BackendId;
  view: NodeView;
  /** Writes are allowed only while available. */
  available: boolean;
  freshness: SummaryFreshness;
  /** When the summaries were last read from the node (command-node clock, ms). */
  loadedAt: number | null;
  truncated: boolean;
  lastError: string | null;
  projects: NodeProjectSummary[];
  environments: NodeEnvironmentSummary[];
}

/**
 * The command node's own projects and environments, in the same bounded
 * form, for a client whose workspace is on another node and whose stores
 * therefore hold that node's state instead.
 */
export interface SelfNodeSummary {
  nodeId: BackendId;
  displayName: string;
  colorToken?: string;
  /** When the summaries were last read (command-node clock, ms). */
  loadedAt: number;
  truncated: boolean;
  projects: NodeProjectSummary[];
  environments: NodeEnvironmentSummary[];
}

export interface NodeSummariesResult {
  /** This command node's own identity: its environments come from the ordinary local reads. */
  selfId: BackendId;
  nodes: NodeSummary[];
  /** Present only when asked for with `includeSelf`. */
  self?: SelfNodeSummary;
}

/** A node-sourced string rendered as text: bounded, no control characters. */
export function boundedText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  // oxlint-disable-next-line no-control-regex -- remote text is rendered as plain text
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/**
 * Repository identity without credentials or paths: `host/owner/name` from
 * an HTTPS or SSH-style Git remote. Anything else yields no hint, so
 * grouping never guesses from names or local paths.
 */
export function repositoryHint(gitUrl: unknown): string | undefined {
  if (typeof gitUrl !== "string" || !gitUrl || gitUrl.length > 2048) return undefined;
  const scp = /^[\w.-]+@([\w.-]+):((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?$/.exec(gitUrl);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(gitUrl);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    const parts = url.pathname
      .replace(/\.git\/?$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return undefined;
    const host =
      (url.protocol === "ssh:" && url.port === "22") ||
      (url.protocol === "git:" && url.port === "9418")
        ? url.hostname
        : url.host;
    return `${host}/${parts.join("/")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The last segment of a filesystem path, bounded, or nothing. Only the name
 * leaves the node's summary projection: the rest of the path is private.
 */
export function pathName(path: unknown): string | undefined {
  if (typeof path !== "string" || !path || path.length > 4096) return undefined;
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  const name = boundedText(segments[segments.length - 1] ?? "", MAX_PATH_NAME).trim();
  return name || undefined;
}

const PR_STATES: ReadonlySet<unknown> = new Set<PrState>(["open", "merged", "closed"]);

function normalizeActivity(value: unknown): AgentActivity {
  return value === "working" || value === "waiting" ? value : "idle";
}

export function toNodeProjectSummary(
  nodeId: BackendId,
  raw: Record<string, unknown>,
  index: number,
): NodeProjectSummary | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const ref = projectRef(nodeId, raw.id);
  const hint = repositoryHint(raw.gitUrl);
  const checkout = pathName(raw.localPath);
  const defaultBranch =
    typeof raw.defaultBranch === "string" ? boundedText(raw.defaultBranch.trim()) : "";
  const icon = normalizeProjectIcon(raw.icon);
  return {
    ref,
    key: projectKey(ref),
    name: boundedText(raw.name) || "Untitled project",
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : index,
    ...(typeof raw.folder === "string" && raw.folder
      ? { folder: boundedText(raw.folder, 64) }
      : {}),
    ...(hint ? { repositoryHint: hint } : {}),
    ...(checkout ? { pathName: checkout } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(icon ? { icon } : {}),
  };
}

export function toNodeEnvironmentSummary(
  nodeId: BackendId,
  raw: Record<string, unknown>,
  index = 0,
): NodeEnvironmentSummary | null {
  if (typeof raw.id !== "string" || !raw.id || typeof raw.projectId !== "string") return null;
  const ref = environmentRef(nodeId, raw.id);
  const worktree = pathName(raw.worktreePath);
  return {
    ref,
    key: environmentKey(ref),
    projectId: raw.projectId,
    name: boundedText(raw.name) || "Environment",
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : index,
    ...(typeof raw.branch === "string" ? { branch: boundedText(raw.branch) } : {}),
    status: boundedText(raw.status, 32) || "stopped",
    activity: normalizeActivity(raw.agentActivityState),
    ...(typeof raw.agentActivityUpdatedAt === "string"
      ? { activityUpdatedAt: raw.agentActivityUpdatedAt.slice(0, MAX_TIMESTAMP) }
      : {}),
    ...(typeof raw.lastActivityAt === "string"
      ? { lastActivityAt: raw.lastActivityAt.slice(0, MAX_TIMESTAMP) }
      : {}),
    hasUnreadWork: raw.hasUnreadWork === true,
    ...(typeof raw.environmentType === "string"
      ? { environmentType: boundedText(raw.environmentType, 32) }
      : {}),
    ...(worktree ? { worktreeName: worktree } : {}),
    ...(typeof raw.createdAt === "string" && raw.createdAt
      ? { createdAt: raw.createdAt.slice(0, MAX_TIMESTAMP) }
      : {}),
    deleting:
      raw.lifecycleOperation === "deleting" ||
      (typeof raw.deletionRequestedAt === "string" && raw.deletionRequestedAt.length > 0),
    isProjectHome: raw.projectHome === true,
    ...(raw.buildPipeline === true ? { buildPipeline: true as const } : {}),
    ...(raw.autoMerge === true ? { autoMerge: true as const } : {}),
    ...(PR_STATES.has(raw.prState) ? { prState: raw.prState as PrState } : {}),
    ...(typeof raw.hasMergeConflicts === "boolean"
      ? { prHasMergeConflicts: raw.hasMergeConflicts }
      : {}),
    ...(isPrMergeability(raw.prMergeability) ? { prMergeability: raw.prMergeability } : {}),
    ...(isPrCheckSummary(raw.prCheckSummary)
      ? {
          prCheckSummary: copyPrCheckSummary(raw.prCheckSummary),
        }
      : {}),
    ...(raw.prMonitorConfirmed === true ? { prMonitorConfirmed: true as const } : {}),
    ...(typeof raw.prViewerCanMerge === "boolean"
      ? { prViewerCanMerge: raw.prViewerCanMerge }
      : {}),
  };
}
