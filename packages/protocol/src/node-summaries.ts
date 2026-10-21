/**
 * Node-qualified project and environment summaries for the portal.
 *
 * A command node keeps a live read model of each connected node's projects
 * and environments and serves it to clients (`get_node_summaries`). These
 * are the bounded projections of a node's ordinary summary reads
 * (`get_projects`, `get_environment_snapshots`): names, status and activity
 * only, never transcripts, prompts, paths or credentials.
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

export const NODE_SUMMARY_CHANGED_EVENT = "node-summary-changed";

export const MAX_SUMMARY_PROJECTS = 500;
export const MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT = 500;
const MAX_TEXT = 256;

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
  deleting: boolean;
  isProjectHome: boolean;
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
  return {
    ref,
    key: projectKey(ref),
    name: boundedText(raw.name) || "Untitled project",
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : index,
    ...(typeof raw.folder === "string" && raw.folder
      ? { folder: boundedText(raw.folder, 64) }
      : {}),
    ...(hint ? { repositoryHint: hint } : {}),
  };
}

export function toNodeEnvironmentSummary(
  nodeId: BackendId,
  raw: Record<string, unknown>,
  index = 0,
): NodeEnvironmentSummary | null {
  if (typeof raw.id !== "string" || !raw.id || typeof raw.projectId !== "string") return null;
  const ref = environmentRef(nodeId, raw.id);
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
      ? { activityUpdatedAt: raw.agentActivityUpdatedAt.slice(0, 64) }
      : {}),
    ...(typeof raw.lastActivityAt === "string"
      ? { lastActivityAt: raw.lastActivityAt.slice(0, 64) }
      : {}),
    hasUnreadWork: raw.hasUnreadWork === true,
    ...(typeof raw.environmentType === "string"
      ? { environmentType: boundedText(raw.environmentType, 32) }
      : {}),
    deleting:
      raw.lifecycleOperation === "deleting" ||
      (typeof raw.deletionRequestedAt === "string" && raw.deletionRequestedAt.length > 0),
    isProjectHome: raw.projectHome === true,
  };
}
