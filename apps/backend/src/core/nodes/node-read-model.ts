import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "@orkestrator/protocol/agent-account-shared-usage";
import { nodeSummaryChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendEmit } from "../backend-emit.js";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfile,
  parseBuildCommit,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import type { NodeListResult, NodeView } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT,
  MAX_SUMMARY_PROJECTS,
  boundedText,
  NODE_SUMMARY_ENVIRONMENT_READ_ARGS,
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeEnvironmentSummary,
  type NodeProjectSummary,
  type NodeSummariesResult,
  type NodeSummary,
  type SelfNodeSummary,
  type SummaryFreshness,
} from "@orkestrator/protocol/node-summaries";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { TICKET_SYNC_OUTBOX_READY_EVENT } from "@orkestrator/protocol/ticket-sync";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";

import { boundSummaryIcons } from "./project-summary-icons.js";

import { BackendActivityJobs } from "../backend-activity-jobs.js";
import { NodeEventStream, type NodeEventTransport } from "./node-event-stream.js";

/**
 * The portal's live read model: for every connected node, its projects and
 * environments (names, status, activity), fed by the command node's own
 * subscription to that node's event stream. Ported from the renderer's
 * per-machine runtime, so clients no longer hold one per machine.
 *
 * - Reads are fenced by the link epoch: a late answer from an older
 *   connection never applies.
 * - An unavailable node keeps its last-known summaries, labelled stale;
 *   last-known state survives a command-node restart. Its version and build
 *   commit do not: those are read from the live link, so they are never
 *   reported stale.
 * - Summary reads are bounded and never fetch transcripts or content.
 * - Events keep summaries current; a re-read of every connected node every
 *   {@link SUMMARY_RECONCILE_MS} bounds how long any missed change (an event
 *   lost in transit, a change the node did not announce) can show.
 * - On request it also summarizes the command node itself, for a client
 *   whose workspace (and so whose full stores) is on another node.
 */

export interface ReadModelLink {
  readonly connected: boolean;
  readonly view: { epoch: number };
  /** The hello of the active route, when connected. */
  readonly hello?: {
    appVersion?: string;
    buildCommit?: string;
    domains?: NegotiatedDomains;
  } | null;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  transport(): NodeEventTransport | null;
}

export interface ReadModelNodes {
  selfIdentity(): Promise<BackendId>;
  selfProfile(): Promise<{ displayName: string; colorToken?: string }>;
  listNodes(): Promise<NodeListResult>;
  link(nodeId: BackendId): ReadModelLink | null;
  subscribe(listener: () => void): () => void;
  /** Cache a node's changed profile so its views show the new name and colour. */
  recordProfile(nodeId: BackendId, profile: BackendProfile): Promise<void>;
}

/** The command node's own commands, for its self summary. */
export interface ReadModelLocal {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

type SummaryInvoke = ReadModelLocal["invoke"];

export interface ReadModelPersistence {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

/**
 * Event prefixes the read model needs from each node, and those its other
 * consumers (`onNodeEvent`) act on: the mail outbox's `node-outbox-ready`
 * (under `node-`) and ticket sync's `ticket-sync-outbox-ready`. The node's
 * gateway sends nothing outside these, so an announcement left off this list
 * is only noticed by the 60 s reconcile (found live, #2059).
 */
export const NODE_SUMMARY_EVENT_PREFIXES = [
  AGENT_USAGE_READINGS_CHANGED_EVENT,
  RESOURCE_CHANGED_EVENT,
  BACKEND_PROFILE_CHANGED_EVENT,
  TICKET_SYNC_OUTBOX_READY_EVENT,
  "node-",
] as const;

const SUMMARY_READ_CONCURRENCY = 4;
const REFRESH_DEBOUNCE_MS = 250;
/**
 * Least time between two `node-summary-changed` events for one node. Every
 * client re-reads its summaries on each one, so a busy node (a pipeline
 * checkpointing, activity timestamps moving) is announced at most this often;
 * the last change in a window is always announced at its end.
 */
export const NODE_SUMMARY_CHANGE_MIN_INTERVAL_MS = 1_000;
const NODE_SUMMARY_CHANGE_BATCH_MS = 50;
/** Last-resort re-read of every connected node's summaries. */
export const SUMMARY_RECONCILE_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 5_000;
const MAX_PERSISTED_BYTES = 2 * 1024 * 1024;
/** The hello's own bound on `appVersion`. */
const MAX_NODE_VERSION_LENGTH = 64;

interface NodeState {
  nodeId: BackendId;
  epoch: number;
  freshness: SummaryFreshness;
  loadedAt: number | null;
  truncated: boolean;
  lastError: string | null;
  projects: NodeProjectSummary[];
  environmentsByProject: Map<string, NodeEnvironmentSummary[]>;
  stream: NodeEventStream | null;
  streamEpoch: number;
  hydrating: Promise<void> | null;
  dirty: boolean;
  dirtyProjects: Set<string>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  lastRevision: number | null;
}

/** The version a node's current connection announced; a dropped link has none. */
function connectedVersion(link: ReadModelLink | null): string | null {
  if (!link?.connected) return null;
  return boundedText(link.hello?.appVersion, MAX_NODE_VERSION_LENGTH) || null;
}

/** The commit a node's current connection announced; a dropped link or an older node has none. */
function connectedBuildCommit(link: ReadModelLink | null): string | null {
  if (!link?.connected) return null;
  return parseBuildCommit(link.hello?.buildCommit);
}

/**
 * The contract domains a node's current connection announced (plan item
 * 5006); `null` for a dropped link and for a hello without them (a release
 * from before domain contracts). The hello parser already bounds them.
 */
function connectedDomains(link: ReadModelLink | null): NegotiatedDomains | null {
  if (!link?.connected) return null;
  return link.hello?.domains ?? null;
}

/** What clients see of one node's summaries, to skip announcing an unchanged re-read. */
function summaryFingerprint(state: NodeState): string {
  return JSON.stringify([
    state.freshness,
    state.truncated,
    state.lastError,
    state.projects,
    [...state.environmentsByProject],
  ]);
}

/** What ticket sync pairs by: each project's id and repository identity. */
function projectListKey(projects: readonly NodeProjectSummary[]): string {
  return JSON.stringify(projects.map((project) => [project.ref.projectId, project.repositoryHint]));
}

export class NodeReadModel {
  private readonly states = new Map<BackendId, NodeState>();
  private readonly views = new Map<BackendId, NodeView>();
  private unsubscribe: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changed = new Set<BackendId>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimerDueAt: number | null = null;
  private readonly lastChangeEmittedAt = new Map<BackendId, number>();
  private reconcileJobs: BackendActivityJobs | null = null;
  private started = false;
  private readonly listeners = new Set<
    (event: string, payload: unknown, nodeId: BackendId) => void
  >();
  private readonly projectListeners = new Set<(nodeId: BackendId) => void>();
  private readonly self: {
    id: BackendId | null;
    summary: SelfNodeSummary | null;
    stale: boolean;
    reading: Promise<SelfNodeSummary | null> | null;
  } = { id: null, summary: null, stale: true, reading: null };

  constructor(
    private readonly options: {
      nodes: ReadModelNodes;
      emit: BackendEmit;
      persistence?: ReadModelPersistence;
      local?: ReadModelLocal;
      /** This node's own version and hello domains, reported beside every node's (5006). */
      selfHello?: () => Promise<{ appVersion: string; domains: NegotiatedDomains }>;
      fetchImpl?: typeof fetch;
      now?: () => number;
      /** Test seam; production uses {@link SUMMARY_RECONCILE_MS}. */
      reconcileMs?: number;
      /** Test seam for the per-node environment refresh debounce (250 ms). */
      refreshDebounceMs?: number;
      /** Test seam for {@link NODE_SUMMARY_CHANGE_MIN_INTERVAL_MS}. */
      changeMinIntervalMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.restore();
    this.unsubscribe = this.options.nodes.subscribe(() => void this.sync());
    await this.sync();
    if (!this.started) return;
    this.reconcileJobs = new BackendActivityJobs([
      {
        name: "node-summary-reconcile",
        kind: "node-summary-reconcile",
        priority: "discovery",
        intervalMs: this.options.reconcileMs ?? SUMMARY_RECONCILE_MS,
        run: () => this.reconcile(),
        onError: () => undefined,
      },
    ]);
    this.reconcileJobs.start();
  }

  /** Re-read every node whose subscription is up; a hydrate already running absorbs it. */
  private async reconcile(): Promise<void> {
    if (!this.started) return;
    const reads: Promise<void>[] = [];
    for (const [nodeId, state] of this.states) {
      if (state.stream && this.options.nodes.link(nodeId)?.connected) {
        reads.push(this.requestHydrate(nodeId));
      }
    }
    await Promise.all(reads);
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.reconcileJobs?.stop();
    this.reconcileJobs = null;
    for (const state of this.states.values()) {
      state.stream?.stop();
      state.stream = null;
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.persist();
    }
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.changeTimerDueAt = null;
  }

  /**
   * A node's project list (ids and repository identities) changed on a read:
   * its first read after it connected, or a copy added or removed there.
   * Ticket sync pairs boards by this list, so it syncs then rather than at its
   * next reconcile. Listeners must not throw.
   */
  onProjectsChanged(listener: (nodeId: BackendId) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  /** Other consumers (coordinator mail, outbox collection) of the same streams. */
  onNodeEvent(listener: (event: string, payload: unknown, nodeId: BackendId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async summaries(
    nodeIds?: readonly string[],
    options: { includeSelf?: boolean } = {},
  ): Promise<NodeSummariesResult> {
    const list = await this.options.nodes.listNodes();
    for (const view of list.nodes) this.views.set(view.nodeId, view);
    const wanted = nodeIds ? new Set(nodeIds) : null;
    const nodes: NodeSummary[] = [];
    for (const view of list.nodes) {
      if (wanted && !wanted.has(view.nodeId)) continue;
      const state = this.states.get(view.nodeId);
      const available = view.connection.state === "connected";
      const link = available ? this.options.nodes.link(view.nodeId) : null;
      nodes.push({
        nodeId: view.nodeId,
        view,
        available,
        version: connectedVersion(link),
        buildCommit: connectedBuildCommit(link),
        domains: connectedDomains(link),
        freshness: state
          ? available
            ? state.freshness
            : state.loadedAt === null
              ? "initializing"
              : "stale"
          : "initializing",
        loadedAt: state?.loadedAt ?? null,
        truncated: state?.truncated ?? false,
        lastError: state?.lastError ?? null,
        projects: state?.projects ?? [],
        environments: state ? [...state.environmentsByProject.values()].flat() : [],
      });
    }
    const self = options.includeSelf ? await this.readSelf() : null;
    const hello = await this.options.selfHello?.().catch(() => null);
    return {
      selfId: await this.options.nodes.selfIdentity(),
      ...(hello
        ? {
            selfVersion: boundedText(hello.appVersion, MAX_NODE_VERSION_LENGTH),
            selfDomains: hello.domains,
          }
        : {}),
      nodes,
      ...(self ? { self } : {}),
    };
  }

  /**
   * A local change that may alter the self summary. Announced as a summary
   * change once self summaries have been requested. Notifications are cheap
   * invalidations; reads remain demand-driven and reconnect reads reconcile gaps.
   */
  noteLocalEvent(event: string, payload: unknown): void {
    if (event === RESOURCE_CHANGED_EVENT) {
      const resource = (payload as { resource?: unknown } | null)?.resource;
      if (
        resource !== "project" &&
        resource !== "environment" &&
        resource !== "environment-pr-health" &&
        resource !== "build-pipeline" &&
        resource !== "agent-mail-summary" &&
        resource !== "config"
      ) {
        return;
      }
    } else if (event !== BACKEND_PROFILE_CHANGED_EVENT) {
      return;
    }
    this.self.stale = true;
    if (this.self.id) this.noteChanged(this.self.id);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private readSelf(): Promise<SelfNodeSummary | null> {
    const local = this.options.local;
    if (!local) return Promise.resolve(null);
    if (this.self.summary && !this.self.stale) return Promise.resolve(this.self.summary);
    if (this.self.reading) return this.self.reading;
    // Cleared before reading, so a change during the read marks it stale again.
    this.self.stale = false;
    const run = (async () => {
      try {
        const [nodeId, profile] = await Promise.all([
          this.options.nodes.selfIdentity(),
          this.options.nodes.selfProfile(),
        ]);
        this.self.id = nodeId;
        const { projects, truncated: projectsTruncated } = await readProjects(nodeId, local.invoke);
        const environments = await this.readEnvironments(
          nodeId,
          local.invoke,
          projects.map((project) => project.ref.projectId),
        );
        let truncated = projectsTruncated;
        const rows: NodeEnvironmentSummary[] = [];
        for (const project of projects) {
          const result = environments.get(project.ref.projectId);
          if (!result) {
            this.self.stale = true;
            truncated = true;
            rows.push(
              ...(this.self.summary?.environments.filter(
                (row) => row.projectId === project.ref.projectId,
              ) ?? []),
            );
            continue;
          }
          truncated ||= result.truncated;
          rows.push(...result.environments);
        }
        this.self.summary = {
          nodeId,
          displayName: profile.displayName,
          ...(profile.colorToken ? { colorToken: profile.colorToken } : {}),
          loadedAt: this.now(),
          truncated,
          projects,
          environments: rows,
        };
      } catch {
        this.self.stale = true;
      }
      return this.self.summary;
    })().finally(() => {
      this.self.reading = null;
    });
    this.self.reading = run;
    return run;
  }

  /** Start, stop or re-read node subscriptions after any registry or connection change. */
  private async sync(): Promise<void> {
    if (!this.started) return;
    let list: NodeListResult;
    try {
      list = await this.options.nodes.listNodes();
    } catch {
      return;
    }
    const known = new Set<BackendId>();
    for (const view of list.nodes) {
      known.add(view.nodeId);
      this.views.set(view.nodeId, view);
      const state = this.stateFor(view.nodeId);
      const link = this.options.nodes.link(view.nodeId);
      if (!link?.connected) {
        state.stream?.stop();
        state.stream = null;
        if (state.freshness !== "stale" && state.loadedAt !== null) {
          state.freshness = "stale";
          this.noteChanged(view.nodeId);
        }
        continue;
      }
      const epoch = link.view.epoch;
      if (state.stream && state.streamEpoch === epoch) continue;
      state.stream?.stop();
      state.epoch = epoch;
      state.streamEpoch = epoch;
      state.lastRevision = null;
      if (state.loadedAt !== null) state.freshness = "catching-up";
      state.stream = new NodeEventStream({
        transport: () => (link.connected && link.view.epoch === epoch ? link.transport() : null),
        prefixes: NODE_SUMMARY_EVENT_PREFIXES,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        onOpen: () => void this.requestHydrate(view.nodeId),
        onEvent: (event, payload) => void this.handleEvent(view.nodeId, epoch, event, payload),
      });
      state.stream.start();
      void this.requestHydrate(view.nodeId);
    }
    for (const [nodeId, state] of this.states) {
      if (known.has(nodeId)) continue;
      // Forgotten: its summaries go too.
      state.stream?.stop();
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      this.states.delete(nodeId);
      this.views.delete(nodeId);
      this.noteChanged(nodeId);
    }
  }

  private stateFor(nodeId: BackendId): NodeState {
    let state = this.states.get(nodeId);
    if (!state) {
      state = {
        nodeId,
        epoch: -1,
        freshness: "initializing",
        loadedAt: null,
        truncated: false,
        lastError: null,
        projects: [],
        environmentsByProject: new Map(),
        stream: null,
        streamEpoch: -1,
        hydrating: null,
        dirty: false,
        dirtyProjects: new Set(),
        refreshTimer: null,
        lastRevision: null,
      };
      this.states.set(nodeId, state);
    }
    return state;
  }

  private async handleEvent(
    nodeId: BackendId,
    epoch: number,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const state = this.states.get(nodeId);
    if (!state || state.epoch !== epoch) return;
    for (const listener of this.listeners) {
      try {
        listener(event, payload, nodeId);
      } catch {
        // A consumer's failure never stops the read model.
      }
    }
    if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
      state.lastRevision = null;
      void this.requestHydrate(nodeId);
      return;
    }
    if (event === BACKEND_PROFILE_CHANGED_EVENT) {
      // The registry's cached profile feeds every view of this node; refresh
      // it now instead of on the next hello, then tell clients.
      try {
        await this.options.nodes.recordProfile(nodeId, parseBackendProfile(payload));
        if (this.started && this.states.get(nodeId) === state && state.epoch === epoch) {
          this.noteChanged(nodeId);
        }
      } catch {
        // A malformed profile event changes nothing; the next hello reconciles.
      }
      return;
    }
    if (event !== RESOURCE_CHANGED_EVENT || !payload || typeof payload !== "object") return;
    const change = payload as {
      resource?: unknown;
      id?: unknown;
      projectId?: unknown;
      revision?: unknown;
    };
    if (typeof change.revision === "number") {
      const gap =
        state.lastRevision !== null &&
        (change.revision <= state.lastRevision || change.revision > state.lastRevision + 1);
      state.lastRevision = change.revision;
      if (gap) {
        void this.requestHydrate(nodeId);
        return;
      }
    }
    // Repository config owns defaultBranch without advancing the project manifest.
    if (change.resource === "project" || change.resource === "config") {
      void this.requestHydrate(nodeId);
    } else if (
      change.resource === "environment" ||
      change.resource === "environment-pr-health" ||
      change.resource === "build-pipeline"
    ) {
      const projectId =
        typeof change.projectId === "string"
          ? change.projectId
          : this.projectOfEnvironment(state, change.id);
      if (projectId) this.scheduleProjectRefresh(state, projectId);
      else void this.requestHydrate(nodeId);
    } else if (change.resource === "agent-mail-summary") {
      // The rows' mail badges. The change names no project, so every known
      // project is re-read, through the same debounce as environment changes.
      for (const project of state.projects) {
        this.scheduleProjectRefresh(state, project.ref.projectId);
      }
    }
  }

  private projectOfEnvironment(state: NodeState, environmentId: unknown): string | null {
    if (typeof environmentId !== "string") return null;
    for (const [projectId, environments] of state.environmentsByProject) {
      if (environments.some((environment) => environment.ref.environmentId === environmentId)) {
        return projectId;
      }
    }
    return null;
  }

  private scheduleProjectRefresh(state: NodeState, projectId: string): void {
    state.dirtyProjects.add(projectId);
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      const projectIds = [...state.dirtyProjects];
      state.dirtyProjects.clear();
      void this.refreshProjects(state.nodeId, projectIds);
    }, this.options.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS);
    state.refreshTimer.unref?.();
  }

  private async refreshProjects(nodeId: BackendId, projectIds: string[]): Promise<void> {
    const state = this.states.get(nodeId);
    const link = this.options.nodes.link(nodeId);
    if (!state || !link?.connected) return;
    const epoch = state.epoch;
    const updates = await this.readEnvironments(
      nodeId,
      (command, args) => link.invoke(command, args),
      projectIds,
    );
    if (this.states.get(nodeId) !== state || state.epoch !== epoch) return;
    const before = summaryFingerprint(state);
    for (const [projectId, result] of updates) {
      if (!result) continue;
      state.environmentsByProject.set(projectId, result.environments);
      state.truncated ||= result.truncated;
    }
    // A node's own change events often leave its summary as it was (a
    // pipeline checkpoint, a mail count elsewhere); clients re-read on every
    // announcement, so only a summary that changed is announced.
    if (summaryFingerprint(state) !== before) this.noteChanged(nodeId);
  }

  /** Re-read one node's summaries; coalesces concurrent requests. */
  requestHydrate(nodeId: BackendId): Promise<void> {
    const state = this.states.get(nodeId);
    if (!state) return Promise.resolve();
    if (state.hydrating) {
      state.dirty = true;
      return state.hydrating;
    }
    const run = this.hydrate(state).finally(() => {
      state.hydrating = null;
      if (state.dirty && this.states.get(nodeId) === state) {
        state.dirty = false;
        void this.requestHydrate(nodeId);
      }
    });
    state.hydrating = run;
    return run;
  }

  private async hydrate(state: NodeState): Promise<void> {
    const link = this.options.nodes.link(state.nodeId);
    if (!link?.connected) return;
    const epoch = state.epoch;
    try {
      const invoke: SummaryInvoke = (command, args) => link.invoke(command, args);
      const { projects, truncated: projectsTruncated } = await readProjects(state.nodeId, invoke);
      const environments = await this.readEnvironments(
        state.nodeId,
        invoke,
        projects.map((project) => project.ref.projectId),
      );
      if (this.states.get(state.nodeId) !== state || state.epoch !== epoch) return;
      const environmentsByProject = new Map<string, NodeEnvironmentSummary[]>();
      let truncated = projectsTruncated;
      let failed = false;
      for (const project of projects) {
        const result = environments.get(project.ref.projectId);
        if (!result) {
          failed = true;
          environmentsByProject.set(
            project.ref.projectId,
            state.environmentsByProject.get(project.ref.projectId) ?? [],
          );
          continue;
        }
        truncated ||= result.truncated;
        environmentsByProject.set(project.ref.projectId, result.environments);
      }
      const before = summaryFingerprint(state);
      const projectsBefore = projectListKey(state.projects);
      state.projects = projects;
      state.environmentsByProject = environmentsByProject;
      state.loadedAt = (this.options.now ?? Date.now)();
      state.truncated = truncated;
      state.lastError = failed ? "Some environments could not be loaded." : null;
      state.freshness = failed ? "degraded" : "current";
      if (projectListKey(projects) !== projectsBefore) {
        for (const listener of this.projectListeners) {
          try {
            listener(state.nodeId);
          } catch {
            // A consumer's failure never stops the read model.
          }
        }
      }
      // A periodic re-read that found nothing new tells no client.
      if (summaryFingerprint(state) === before) return;
      this.noteChanged(state.nodeId);
      this.schedulePersist();
    } catch (error) {
      if (this.states.get(state.nodeId) !== state) return;
      state.lastError = safeMessage(error);
      state.freshness = state.loadedAt === null ? "initializing" : "stale";
      this.noteChanged(state.nodeId);
    }
  }

  private async readEnvironments(
    nodeId: BackendId,
    invoke: SummaryInvoke,
    projectIds: string[],
  ): Promise<Map<string, { environments: NodeEnvironmentSummary[]; truncated: boolean } | null>> {
    const results = new Map<
      string,
      { environments: NodeEnvironmentSummary[]; truncated: boolean } | null
    >();
    let next = 0;
    const worker = async () => {
      while (next < projectIds.length) {
        const projectId = projectIds[next++]!;
        try {
          const raw = await invoke<unknown>("get_environment_snapshots", {
            projectId,
            ...NODE_SUMMARY_ENVIRONMENT_READ_ARGS,
          });
          const list = Array.isArray(raw) ? raw : [];
          const environments = list
            .flatMap((entry, index) => {
              const environment =
                entry && typeof entry === "object"
                  ? toNodeEnvironmentSummary(nodeId, entry as Record<string, unknown>, index)
                  : null;
              return environment ? [environment] : [];
            })
            // The node's own sidebar order; its storage order is creation order.
            .sort((a, b) => a.order - b.order)
            .slice(0, MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT);
          results.set(projectId, {
            environments,
            truncated: list.length > MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT,
          });
        } catch {
          results.set(projectId, null);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SUMMARY_READ_CONCURRENCY, projectIds.length) }, () => worker()),
    );
    return results;
  }

  private noteChanged(nodeId: BackendId): void {
    this.changed.add(nodeId);
    const now = (this.options.now ?? Date.now)();
    const last = this.lastChangeEmittedAt.get(nodeId);
    const eligibleAt =
      last === undefined
        ? now
        : last + (this.options.changeMinIntervalMs ?? NODE_SUMMARY_CHANGE_MIN_INTERVAL_MS);
    const dueAt = Math.max(now + NODE_SUMMARY_CHANGE_BATCH_MS, eligibleAt);
    if (this.changeTimerDueAt === null || dueAt < this.changeTimerDueAt) {
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.scheduleChangeFlush(dueAt - now);
    }
  }

  private scheduleChangeFlush(delayMs: number): void {
    this.changeTimerDueAt = (this.options.now ?? Date.now)() + delayMs;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.changeTimerDueAt = null;
      this.flushChanged();
    }, delayMs);
    this.changeTimer.unref?.();
  }

  /** Announces changed nodes, holding back any announced within the minimum interval. */
  private flushChanged(): void {
    const interval = this.options.changeMinIntervalMs ?? NODE_SUMMARY_CHANGE_MIN_INTERVAL_MS;
    const now = (this.options.now ?? Date.now)();
    let nextDueMs: number | null = null;
    for (const id of Array.from(this.changed)) {
      const last = this.lastChangeEmittedAt.get(id);
      if (last !== undefined && now - last < interval) {
        const due = last + interval - now;
        nextDueMs = nextDueMs === null ? due : Math.min(nextDueMs, due);
        continue;
      }
      this.changed.delete(id);
      this.lastChangeEmittedAt.set(id, now);
      this.options.emit(nodeSummaryChangedEvent, {
        nodeId: id,
        epoch: this.states.get(id)?.epoch ?? 0,
      });
      // A forgotten node's last announcement needs no throttle record.
      if (!this.states.has(id) && id !== this.self.id) this.lastChangeEmittedAt.delete(id);
    }
    if (nextDueMs !== null) this.scheduleChangeFlush(Math.max(1, nextDueMs));
  }

  private schedulePersist(): void {
    if (!this.options.persistence || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist(): Promise<void> {
    if (!this.options.persistence) return;
    const value = {
      version: 1,
      nodes: [...this.states.values()]
        .filter((state) => state.loadedAt !== null)
        .map((state) => ({
          nodeId: state.nodeId,
          loadedAt: state.loadedAt,
          truncated: state.truncated,
          projects: state.projects,
          environments: [...state.environmentsByProject.entries()],
        })),
    };
    try {
      if (JSON.stringify(value).length > MAX_PERSISTED_BYTES) {
        // Project icons are the bulkiest optional field; the next read brings them back.
        for (const node of value.nodes) node.projects = node.projects.map(withoutIcon);
        if (JSON.stringify(value).length > MAX_PERSISTED_BYTES) return;
      }
      await this.options.persistence.save(value);
    } catch {
      // Last-known state is a convenience; losing it only shows "initializing".
    }
  }

  private async restore(): Promise<void> {
    if (!this.options.persistence) return;
    let raw: unknown;
    try {
      raw = await this.options.persistence.load();
    } catch {
      return;
    }
    const root = raw as { version?: unknown; nodes?: unknown } | null;
    if (!root || root.version !== 1 || !Array.isArray(root.nodes)) return;
    for (const entry of root.nodes.slice(0, 64) as Array<Record<string, unknown>>) {
      if (!entry || typeof entry.nodeId !== "string" || typeof entry.loadedAt !== "number")
        continue;
      const nodeId = entry.nodeId as BackendId;
      const projects = Array.isArray(entry.projects)
        ? (entry.projects as NodeProjectSummary[]).filter(
            (project) => project?.ref?.backendId === nodeId,
          )
        : [];
      const environments = Array.isArray(entry.environments)
        ? (entry.environments as Array<[string, NodeEnvironmentSummary[]]>).flatMap((pair) =>
            Array.isArray(pair) && typeof pair[0] === "string" && Array.isArray(pair[1])
              ? [[pair[0], pair[1].filter((row) => row?.ref?.backendId === nodeId)] as const]
              : [],
          )
        : [];
      const state = this.stateFor(nodeId);
      state.projects = boundSummaryIcons(projects.slice(0, MAX_SUMMARY_PROJECTS));
      state.environmentsByProject = new Map(environments);
      state.loadedAt = entry.loadedAt;
      state.truncated = entry.truncated === true;
      state.freshness = "stale";
    }
  }
}

async function readProjects(
  nodeId: BackendId,
  invoke: SummaryInvoke,
): Promise<{ projects: NodeProjectSummary[]; truncated: boolean }> {
  // A node older than `includeDefaultBranch` ignores it and sends none; the
  // search then falls back to "main", as it does for an unconfigured project.
  // Bound icons before transport on current nodes; bound again below for older nodes.
  const raw = await invoke<unknown>("get_projects", {
    includeDefaultBranch: true,
    summaryIcons: true,
  });
  const list = Array.isArray(raw) ? raw : [];
  const projects = list
    .slice(0, MAX_SUMMARY_PROJECTS)
    .flatMap((entry, index) => {
      const project =
        entry && typeof entry === "object"
          ? toNodeProjectSummary(nodeId, entry as Record<string, unknown>, index)
          : null;
      return project ? [project] : [];
    })
    .sort((a, b) => a.order - b.order);
  return { projects: boundSummaryIcons(projects), truncated: list.length > MAX_SUMMARY_PROJECTS };
}

function withoutIcon(project: NodeProjectSummary): NodeProjectSummary {
  if (!project.icon) return project;
  const { icon: _icon, ...rest } = project;
  return rest;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}
