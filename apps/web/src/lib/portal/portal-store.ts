/**
 * The portal: what the command node this client is connected to knows about
 * its other nodes. Everything here is a call on the window's command scope
 * (`./command-scope`, plan item 5004), whichever node the window shows.
 *
 * The command node keeps the registry, the links and a live read model of
 * every node's projects and environments; this client only reads that model
 * (`get_node_summaries`) and refreshes on `node-summary-changed`. It holds no
 * other node's credential and keeps no per-node runtime of its own. Commands
 * for another node's resources go through the command node
 * (`invoke_on_node`), which routes them to the owner.
 */

import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { AgentsMdChange, AgentsMdSection } from "@orkestrator/protocol/agents-md-orkestrator";
import type { RootChangeFile } from "@orkestrator/protocol/coordinator-surfaces";
import type { AgentInteractionQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import type { WorkerQuestionRelay } from "@orkestrator/protocol/worker-question-relay";
import type { ProjectHomeMessage } from "@orkestrator/protocol/project-home-message";
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
  NODE_OUTCOMES_CHANGED_EVENT,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import type { MachineRelease } from "@orkestrator/protocol/fleet-currency";
import { invoke } from "@/lib/native/backend";
import { coordinatorApi } from "@/lib/node-scope/domains/coordinator";
import { backendClientOver } from "@/lib/node-scope/domains/invoke-over";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { nodeMailClient } from "@orkestrator/protocol/contract/domains/node-mail";
import { NO_ARGS, nodesApiOver, portalNodesApi } from "@/lib/node-scope/domains/nodes";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { commandScopeInvoke, commandScopeListen } from "./command-scope";

export interface PortalState {
  /** This (command) node's identity, once known. */
  selfId: BackendId | null;
  status: NodeStatus | null;
  nodes: NodeSummary[];
  /**
   * The command node's own version and hello domains, which every machine's
   * is compared with (plan item 5006); null until read, or from a command
   * node that predates them.
   */
  commandRelease: MachineRelease | null;
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
    commandRelease: null,
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
        void commandScopeListen(event, () => this.scheduleRefresh()).then((stop) => {
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
    const [status, summaries] = await Promise.allSettled([
      portalNodesApi().get_node_status(NO_ARGS),
      portalNodesApi().get_node_summaries({}),
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
      commandRelease: summariesValue
        ? summariesValue.selfVersion
          ? { version: summariesValue.selfVersion, domains: summariesValue.selfDomains ?? null }
          : null
        : state.commandRelease,
      loaded: true,
      // A backend older than the portal commands, or one without the portal.
      unsupported:
        incompatibility(failure, "get_node_status") !== null ||
        /not available in this backend/i.test(message),
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
    // The command node's own resources are its ordinary commands.
    if (nodeId === this.store.getState().selfId) {
      const result = await commandScopeInvoke<T>(command, args);
      if (!isNodeReadCommand(command)) this.scheduleRefresh();
      return result;
    }
    const routed = await portalNodesApi().invoke_on_node({ nodeId, command, args, requestKey });
    if (routed.outcome === "unknown") {
      this.store.setState((state) => ({ outcomesRevision: state.outcomesRevision + 1 }));
      throw new OutcomeUnknownError(nodeId, command, routed.requestKey);
    }
    if (!isNodeReadCommand(command)) this.scheduleRefresh();
    return routed.result as T;
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
  return parseBackendProfile(await nodesApiOver(invoke).get_backend_profile(NO_ARGS));
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
  const value = await portalNodesApi().list_node_outcomes({ nodeId });
  return Array.isArray(value) ? value : [];
}

/** How long outcome and node summary changes are gathered before lists are read again. */
export const NODE_OUTCOMES_REFRESH_DEBOUNCE_MS = 250;

type NodeOutcomesEntry = {
  listeners: Set<(outcomes: NodeOutcomeRecord[]) => void>;
  value: NodeOutcomeRecord[] | null;
  reading: Promise<void> | null;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * One window's view of the outcome-unknown records, shared by every notice
 * that shows them. Each sidebar machine section used to read its own list on
 * every `node-summary-changed` for any node, so N sections cost N reads per
 * event. Here one subscription serves them all: a change re-reads only the
 * node it names, after a short debounce, with one read in flight per node.
 */
export class NodeOutcomesStore {
  private readonly entries = new Map<string, NodeOutcomesEntry>();
  private unlisteners: Array<() => void> = [];
  private listening = false;
  private listeningGeneration = 0;

  constructor(
    private readonly read: (nodeId: string) => Promise<NodeOutcomeRecord[]> = listNodeOutcomes,
    private readonly listenTo: typeof commandScopeListen = commandScopeListen,
  ) {}

  /** Calls `listener` with the node's records now (when held) and on every change. */
  subscribe(nodeId: string, listener: (outcomes: NodeOutcomeRecord[]) => void): () => void {
    let entry = this.entries.get(nodeId);
    if (!entry) {
      entry = { listeners: new Set(), value: null, reading: null, dirty: false, timer: null };
      this.entries.set(nodeId, entry);
    }
    const fresh = entry.listeners.size === 0;
    entry.listeners.add(listener);
    this.startListening();
    if (entry.value) listener(entry.value);
    // A node nobody watched may have changed unobserved; read it once.
    if (fresh) void this.refresh(nodeId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.entries.get(nodeId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      if (current.timer) clearTimeout(current.timer);
      current.timer = null;
      if (!current.reading) this.entries.delete(nodeId);
      if (![...this.entries.values()].some((other) => other.listeners.size > 0)) {
        this.stopListening();
      }
    };
  }

  /** Re-reads one node's records now, sharing a read already in flight. */
  refresh(nodeId: string): Promise<void> {
    const entry = this.entries.get(nodeId);
    if (!entry || entry.listeners.size === 0) return Promise.resolve();
    if (entry.reading) {
      entry.dirty = true;
      return entry.reading;
    }
    const run = this.read(nodeId)
      .then((outcomes) => {
        entry.value = outcomes;
        for (const listener of Array.from(entry.listeners)) listener(outcomes);
      })
      .catch(() => undefined)
      .finally(() => {
        entry.reading = null;
        if (entry.listeners.size === 0) {
          if (this.entries.get(nodeId) === entry) this.entries.delete(nodeId);
          return;
        }
        if (entry.dirty) {
          entry.dirty = false;
          void this.refresh(nodeId);
        }
      });
    entry.reading = run;
    return run;
  }

  /** Re-reads every watched node. */
  refreshAll(): void {
    for (const nodeId of Array.from(this.entries.keys())) this.scheduleRefresh(nodeId);
  }

  private scheduleRefresh(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (!entry || entry.listeners.size === 0 || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.refresh(nodeId);
    }, NODE_OUTCOMES_REFRESH_DEBOUNCE_MS);
  }

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    const generation = ++this.listeningGeneration;
    const attach = (event: string, handler: (payload: unknown) => void) => {
      void this.listenTo<unknown>(event, ({ payload }) => {
        if (this.listening && generation === this.listeningGeneration) handler(payload);
      })
        .then((stop) => {
          if (this.listening && generation === this.listeningGeneration)
            this.unlisteners.push(stop);
          else stop();
        })
        .catch(() => undefined);
    };
    const refreshChangedNode = (payload: unknown) => {
      const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId;
      if (typeof nodeId === "string") this.scheduleRefresh(nodeId);
      else this.refreshAll();
    };
    attach(NODE_SUMMARY_CHANGED_EVENT, refreshChangedNode);
    attach(NODE_OUTCOMES_CHANGED_EVENT, refreshChangedNode);
    // Records written while the stream was down arrive with no event.
    attach(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => this.refreshAll());
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    this.listeningGeneration += 1;
    for (const stop of this.unlisteners) stop();
    this.unlisteners = [];
  }
}

/** One per window, like {@link portalStore}. */
export const nodeOutcomesStore = new NodeOutcomesStore();

export async function dismissNodeOutcome(outcomeId: string): Promise<void> {
  await portalNodesApi().dismiss_node_outcome({ outcomeId });
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
    | "switch-agent-account"
    | "answer-worker-question"
    | "message-project-home";
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
  /** `answer-worker-question`: the worker's question and the coordinator's proposed answer. */
  workerQuestion?: WorkerQuestionRelay;
  /** `message-project-home`: the coordinator's message, held for approval. */
  projectHomeMessage?: ProjectHomeMessage;
  /** Why the user is asked although Settings lets coordinators act without asking. */
  askedBecause?: string;
  state: string;
  /** `url`: the pull request an `update-agents-md` approval opened. */
  result?: { code: string; message: string; url?: string };
}

/** The `node-mail` domain on the window's command node (version 0: today's calls). */
function nodeMailOnCommandScope() {
  return domainApi(backendClientOver(commandScopeInvoke), nodeMailClient);
}

/** Requests from coordinators that wait for this user's decision. */
export async function listNodeActionRequests(): Promise<NodeActionRequestView[]> {
  const value: unknown = await nodeMailOnCommandScope().actionRequests({ pendingOnly: true });
  return Array.isArray(value) ? (value as NodeActionRequestView[]) : [];
}

export async function resolveNodeActionRequest(
  requestId: string,
  decision: "approve" | "reject",
  /**
   * A copy request's final location and files, an AGENTS.md request's
   * entries, or a worker question's answers, as the user settled them.
   */
  approval?: {
    location?: string;
    paths?: string[];
    rememberFiles?: boolean;
    changes?: AgentsMdChange[];
    answers?: AgentInteractionQuestionAnswer[];
  },
): Promise<NodeActionRequestView> {
  // The request is an open record (every key kept); `NodeActionRequestView` is its shape.
  return nodeMailOnCommandScope().resolveActionRequest({
    requestId,
    decision,
    ...(approval ? { approval } : {}),
  }) as Promise<unknown> as Promise<NodeActionRequestView>;
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
  // The section's own shape is the web's (`AgentsMdSection`); the definition keeps it open.
  return portalNodesApi().preview_agents_md_update({ requestId }) as Promise<AgentsMdPreview>;
}

/**
 * The project checkout's uncommitted changes, for the user to pick which go
 * to a worker when approving an `apply-root-changes` request. Read-only.
 */
export async function listProjectRootChanges(projectId: string): Promise<RootChangesListing> {
  // The listing's own shape is the web's; the definition keeps its records open.
  return coordinatorApi(backendClientOver(commandScopeInvoke)).list_project_root_changes({
    projectId,
  }) as Promise<RootChangesListing>;
}

export interface RootChangesListing {
  files: RootChangeFile[];
  truncated: boolean;
  conflicts: number;
  headCommit: string | null;
}

/** One portal per window: it reads the window's command scope. */
export const portalStore = new PortalStore();
