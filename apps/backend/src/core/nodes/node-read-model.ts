import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfile,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import type { NodeListResult, NodeView } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT,
  MAX_SUMMARY_PROJECTS,
  NODE_SUMMARY_CHANGED_EVENT,
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
 *   last-known state survives a command-node restart.
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

/** Event prefixes the read model needs from each node. */
export const NODE_SUMMARY_EVENT_PREFIXES = [
  RESOURCE_CHANGED_EVENT,
  BACKEND_PROFILE_CHANGED_EVENT,
  "node-",
] as const;

const SUMMARY_READ_CONCURRENCY = 4;
const REFRESH_DEBOUNCE_MS = 250;
/** Last-resort re-read of every connected node's summaries. */
export const SUMMARY_RECONCILE_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 5_000;
const MAX_PERSISTED_BYTES = 2 * 1024 * 1024;

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

export class NodeReadModel {
  private readonly states = new Map<BackendId, NodeState>();
  private readonly views = new Map<BackendId, NodeView>();
  private unsubscribe: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changed = new Set<BackendId>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileJobs: BackendActivityJobs | null = null;
  private started = false;
  private readonly listeners = new Set<
    (event: string, payload: unknown, nodeId: BackendId) => void
  >();
  private readonly self: {
    id: BackendId | null;
    summary: SelfNodeSummary | null;
    stale: boolean;
    reading: Promise<SelfNodeSummary | null> | null;
  } = { id: null, summary: null, stale: true, reading: null };

  constructor(
    private readonly options: {
      nodes: ReadModelNodes;
      emit: (event: string, payload: unknown) => void;
      persistence?: ReadModelPersistence;
      local?: ReadModelLocal;
      fetchImpl?: typeof fetch;
      now?: () => number;
      /** Test seam; production uses {@link SUMMARY_RECONCILE_MS}. */
      reconcileMs?: number;
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
      nodes.push({
        nodeId: view.nodeId,
        view,
        available,
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
    return { selfId: await this.options.nodes.selfIdentity(), nodes, ...(self ? { self } : {}) };
  }

  /**
   * A local change that may alter the self summary. Announced as a summary
   * change once self summaries have been requested. Notifications are cheap
   * invalidations; reads remain demand-driven and reconnect reads reconcile gaps.
   */
  noteLocalEvent(event: string, payload: unknown): void {
    if (event === RESOURCE_CHANGED_EVENT) {
      const resource = (payload as { resource?: unknown } | null)?.resource;
      if (resource !== "project" && resource !== "environment" && resource !== "config") return;
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
    } else if (change.resource === "environment") {
      const projectId =
        typeof change.projectId === "string"
          ? change.projectId
          : this.projectOfEnvironment(state, change.id);
      if (projectId) this.scheduleProjectRefresh(state, projectId);
      else void this.requestHydrate(nodeId);
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
    }, REFRESH_DEBOUNCE_MS);
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
    for (const [projectId, result] of updates) {
      if (!result) continue;
      state.environmentsByProject.set(projectId, result.environments);
      state.truncated ||= result.truncated;
    }
    this.noteChanged(nodeId);
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
      state.projects = projects;
      state.environmentsByProject = environmentsByProject;
      state.loadedAt = (this.options.now ?? Date.now)();
      state.truncated = truncated;
      state.lastError = failed ? "Some environments could not be loaded." : null;
      state.freshness = failed ? "degraded" : "current";
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
          const raw = await invoke<unknown>("get_environment_snapshots", { projectId });
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
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const nodeIds = [...this.changed];
      this.changed.clear();
      for (const id of nodeIds) {
        this.options.emit(NODE_SUMMARY_CHANGED_EVENT, {
          nodeId: id,
          epoch: this.states.get(id)?.epoch ?? 0,
        });
      }
    }, 50);
    this.changeTimer.unref?.();
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
      if (JSON.stringify(value).length > MAX_PERSISTED_BYTES) return;
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
      state.projects = projects.slice(0, MAX_SUMMARY_PROJECTS);
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
  const raw = await invoke<unknown>("get_projects", { includeDefaultBranch: true });
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
  return { projects, truncated: list.length > MAX_SUMMARY_PROJECTS };
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}
