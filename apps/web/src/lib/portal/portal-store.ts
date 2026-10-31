/**
 * The portal: what the command node this client is connected to knows about
 * its other nodes. Everything here goes over the portal channel, which stays
 * on the command node even while the window's workspace is on a leaf.
 *
 * The command node keeps the registry, the links and a live read model of
 * every node's projects and environments; this client only reads that model
 * (`get_node_summaries`) and refreshes on `node-summary-changed`. It holds no
 * other node's credential and keeps no per-node runtime of its own. Commands
 * for another node's resources go through the command node
 * (`invoke_on_node`), which routes them to the owner.
 */

import type { AgentsMdChange, AgentsMdSection } from "@orkestrator/protocol/agents-md-orkestrator";
import type { RootChangeFile } from "@orkestrator/protocol/coordinator-surfaces";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  isNodeReadCommand,
  NODE_STATUS_CHANGED_EVENT,
  NODES_CHANGED_EVENT,
  type NodeStatus,
} from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfile,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import {
  NODE_SUMMARY_CHANGED_EVENT,
  type NodeSummariesResult,
  type NodeSummary,
  type SelfNodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { portalInvoke, portalListen, workspaceTarget } from "./portal-transport";

export interface PortalState {
  /** This (command) node's identity, once known. */
  selfId: BackendId | null;
  status: NodeStatus | null;
  nodes: NodeSummary[];
  /** The command node's own summary, while the workspace is on another node. */
  self: SelfNodeSummary | null;
  loaded: boolean;
  /** The connected backend has no command-node support (an older backend). */
  unsupported: boolean;
  /** Bumped when a routed write's outcome became unknown (the notices re-read). */
  outcomesRevision: number;
}

const REFRESH_DEBOUNCE_MS = 100;

/** A routed write's answer was lost; the command node recorded it against the node. */
export class OutcomeUnknownError extends Error {
  constructor(
    readonly nodeId: BackendId,
    readonly command: string,
    readonly requestKey: string,
  ) {
    super(
      "The connection was lost before the machine answered. Check its state before trying again; nothing will be resent automatically.",
    );
    this.name = "OutcomeUnknownError";
  }
}

export class PortalStore {
  readonly store: StoreApi<PortalState> = createStore<PortalState>(() => ({
    selfId: null,
    status: null,
    nodes: [],
    self: null,
    loaded: false,
    unsupported: false,
    outcomesRevision: 0,
  }));
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private dirty = false;
  private unlisteners: Array<() => void> = [];
  private started = 0;

  /** Start observing; reference-counted. The last release stops the subscriptions only. */
  start(): () => void {
    this.started += 1;
    if (this.started === 1) {
      void this.refresh();
      for (const event of [
        NODE_SUMMARY_CHANGED_EVENT,
        NODES_CHANGED_EVENT,
        NODE_STATUS_CHANGED_EVENT,
        NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      ]) {
        void portalListen(event, () => this.scheduleRefresh()).then((stop) => {
          if (this.started === 0) stop();
          else this.unlisteners.push(stop);
        });
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.started -= 1;
      if (this.started > 0) return;
      for (const stop of this.unlisteners) stop();
      this.unlisteners = [];
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    };
  }

  getState(): PortalState {
    return this.store.getState();
  }

  node(nodeId: string): NodeSummary | null {
    return this.store.getState().nodes.find((node) => node.nodeId === nodeId) ?? null;
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true;
      return this.refreshing;
    }
    const run = this.read().finally(() => {
      this.refreshing = null;
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      }
    });
    this.refreshing = run;
    return run;
  }

  private async read(): Promise<void> {
    // Status and summaries are read independently, so an older or
    // non-command backend still reports its status.
    const includeSelf = workspaceTarget() !== null;
    const [status, summaries] = await Promise.allSettled([
      portalInvoke<NodeStatus>("get_node_status"),
      portalInvoke<NodeSummariesResult>(
        "get_node_summaries",
        includeSelf ? { includeSelf: true } : {},
      ),
    ]);
    const statusValue = status.status === "fulfilled" ? status.value : null;
    const summariesValue =
      summaries.status === "fulfilled" && summaries.value && Array.isArray(summaries.value.nodes)
        ? summaries.value
        : null;
    const failure = status.status === "rejected" ? status.reason : null;
    const message = failure instanceof Error ? failure.message : failure ? String(failure) : "";
    this.store.setState((state) => ({
      selfId: summariesValue?.selfId ?? statusValue?.nodeId ?? state.selfId,
      status: statusValue ?? state.status,
      nodes: summariesValue?.nodes ?? state.nodes,
      self: summariesValue ? (summariesValue.self ?? null) : state.self,
      loaded: true,
      unsupported: /unknown command|not available in this backend/i.test(message),
    }));
  }

  /**
   * Run a command on another node through the command node. The destination
   * is the reference the caller captured; nothing falls back to this node.
   */
  async invokeOnNode<T>(
    nodeId: BackendId,
    command: string,
    args: Record<string, unknown> = {},
    requestKey: string = crypto.randomUUID(),
  ): Promise<T> {
    // The command node's own resources (listed from its self summary while
    // the workspace is elsewhere) are its ordinary commands.
    if (nodeId === this.store.getState().selfId) {
      const result = await portalInvoke<T>(command, args);
      if (!isNodeReadCommand(command)) this.scheduleRefresh();
      return result;
    }
    const routed = await portalInvoke<
      { outcome: "ok"; result: T } | { outcome: "unknown"; requestKey: string; outcomeId: string }
    >("invoke_on_node", { nodeId, command, args, requestKey });
    if (routed.outcome === "unknown") {
      this.store.setState((state) => ({ outcomesRevision: state.outcomesRevision + 1 }));
      throw new OutcomeUnknownError(nodeId, command, routed.requestKey);
    }
    if (!isNodeReadCommand(command)) this.scheduleRefresh();
    return routed.result;
  }
}

export interface NodeOutcomeRecord {
  outcomeId: string;
  nodeId: string;
  command: string;
  recordedAt: string;
}

/** The profile (name and colour) of the machine the window's workspace is on. */
export async function getWorkspaceProfile(): Promise<BackendProfile> {
  return parseBackendProfile(await invoke<unknown>("get_backend_profile"));
}

export function listenWorkspaceProfile(
  onProfile: (profile: BackendProfile) => void,
): Promise<() => void> {
  return listen<unknown>(BACKEND_PROFILE_CHANGED_EVENT, ({ payload }) => {
    try {
      onProfile(parseBackendProfile(payload));
    } catch {
      // A malformed event changes nothing.
    }
  });
}

/** Outcome-unknown records the command node keeps for a node. */
export async function listNodeOutcomes(nodeId: string): Promise<NodeOutcomeRecord[]> {
  const value = await portalInvoke<NodeOutcomeRecord[]>("list_node_outcomes", { nodeId });
  return Array.isArray(value) ? value : [];
}

export async function dismissNodeOutcome(outcomeId: string): Promise<void> {
  await portalInvoke("dismiss_node_outcome", { outcomeId });
}

export interface NodeActionRequestView {
  requestId: string;
  kind:
    | "delete-environment"
    | "create-project"
    | "update-project-files"
    | "reveal-env-value"
    | "apply-root-changes"
    | "update-agents-md"
    | "switch-agent-account";
  targets: Array<{
    nodeId: string;
    nodeName: string;
    environmentId?: string;
    environmentName?: string;
    projectId?: string;
    projectName?: string;
    location?: string;
    gitRemote?: string;
    files?: string[];
    keys?: string[];
    /** `switch-agent-account`: the provider and the login to make active. */
    platform?: string;
    accountId?: string;
    accountLabel?: string;
  }>;
  reason?: string;
  /** The coordinator that asked; its project is the one a copy request copies. */
  requestedBy?: { projectId: string };
  /** `update-agents-md`: the proposed changes to the ## Orkestrator section. */
  agentsMd?: { changes: AgentsMdChange[] };
  state: string;
  /** `url`: the pull request an `update-agents-md` approval opened. */
  result?: { code: string; message: string; url?: string };
}

/** Requests from coordinators that wait for this user's decision. */
export async function listNodeActionRequests(): Promise<NodeActionRequestView[]> {
  const value = await portalInvoke<NodeActionRequestView[]>("list_node_action_requests", {
    pendingOnly: true,
  });
  return Array.isArray(value) ? value : [];
}

export async function resolveNodeActionRequest(
  requestId: string,
  decision: "approve" | "reject",
  /**
   * A copy request's final location and files, or an AGENTS.md request's
   * entries, as the user settled them.
   */
  approval?: {
    location?: string;
    paths?: string[];
    rememberFiles?: boolean;
    changes?: AgentsMdChange[];
  },
): Promise<NodeActionRequestView> {
  return portalInvoke<NodeActionRequestView>("resolve_node_action_request", {
    requestId,
    decision,
    ...(approval ? { approval } : {}),
  });
}

/** The ## Orkestrator section on the latest base branch, for an AGENTS.md request's review. */
export interface AgentsMdPreview {
  baseBranch: string;
  baseCommit: string;
  fetched: boolean;
  fetchError?: string;
  fileExists: boolean;
  section: AgentsMdSection;
  nodeName?: string;
}

export async function previewAgentsMdUpdate(requestId: string): Promise<AgentsMdPreview> {
  return portalInvoke<AgentsMdPreview>("preview_agents_md_update", { requestId });
}

/**
 * The project checkout's uncommitted changes, for the user to pick which go
 * to a worker when approving an `apply-root-changes` request. Read-only.
 */
export async function listProjectRootChanges(projectId: string): Promise<RootChangesListing> {
  return portalInvoke<RootChangesListing>("list_project_root_changes", { projectId });
}

export interface RootChangesListing {
  files: RootChangeFile[];
  truncated: boolean;
  conflicts: number;
  headCommit: string | null;
}

/** One portal per window: it reads the command node over the portal channel. */
export const portalStore = new PortalStore();
