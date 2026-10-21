/**
 * One machine's client-side runtime: its bound client, connection summary,
 * summary store, prefetch cache, in-flight reads and recovery state.
 *
 * The runtime observes; it never owns execution. Agents, workflows,
 * approvals and queues keep running on the backend whatever happens here.
 * Disposing a runtime releases observation only.
 *
 * Isolation rules this module keeps:
 * - Events mutate only the runtime whose connection delivered them.
 * - A read result applies only if the connection epoch it started under is
 *   still current; navigation never retargets an outstanding read.
 * - Revisions are compared only within this backend.
 * - Summary reads are bounded (pages, counts) and never fetch transcripts.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  provisionalBackendId,
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
  type EnvironmentRef,
  type ProjectRef,
} from "@orkestrator/protocol/federation";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfile,
} from "@orkestrator/protocol/backend-profile";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { PrefetchedCommandCache } from "@/lib/prefetched-command-responses";
import type { BackendClient } from "./backend-client";
import { OperationRecovery } from "./operation-recovery";

export const MAX_SUMMARY_PROJECTS = 500;
export const MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT = 500;
const SUMMARY_READ_CONCURRENCY = 4;
const RESOURCE_REFRESH_DEBOUNCE_MS = 250;
const MAX_TEXT = 256;

export type SummaryFreshness = "initializing" | "current" | "catching-up" | "stale" | "degraded";

export type AgentActivity = "idle" | "working" | "waiting";

export interface FederatedProject {
  ref: ProjectRef;
  key: string;
  name: string;
  order: number;
  folder?: string;
  /** Sanitized repository identity hint (host/owner/name), never a credentialed URL. */
  repositoryHint?: string;
}

export interface FederatedEnvironment {
  ref: EnvironmentRef;
  key: string;
  projectId: string;
  name: string;
  branch?: string;
  status: string;
  activity: AgentActivity;
  /** Backend-reported timestamps (backend clock; presentation sort only). */
  activityUpdatedAt?: string;
  lastActivityAt?: string;
  hasUnreadWork: boolean;
  environmentType?: string;
  deleting: boolean;
  isProjectHome: boolean;
}

export interface MachineSummaryState {
  backendId: BackendId;
  connectionId: string;
  connection: ConnectionSummary;
  freshness: SummaryFreshness;
  projects: FederatedProject[];
  environmentsByProject: ReadonlyMap<string, FederatedEnvironment[]>;
  loadedAt: number | null;
  lastError: string | null;
  /** Records beyond the client cap exist but were not loaded. */
  truncated: boolean;
  /** Connection epoch the summaries were read under. */
  epoch: number;
}

/** A backend-sourced string rendered as text: bounded, no control characters. */
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
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(gitUrl);
  if (scp) return `${scp[1]}/${scp[2]}/${scp[3]}`.toLowerCase();
  try {
    const url = new URL(gitUrl);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    const parts = url.pathname
      .replace(/\.git\/?$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return undefined;
    return `${url.hostname}/${parts.slice(-2).join("/")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

export function backendIdForConnection(connection: ConnectionSummary): BackendId {
  return connection.backendId && connection.identity === "verified"
    ? connection.backendId
    : provisionalBackendId(connection.id);
}

function normalizeActivity(value: unknown): AgentActivity {
  return value === "working" || value === "waiting" ? value : "idle";
}

export function toFederatedProject(
  backendId: BackendId,
  raw: Record<string, unknown>,
  index: number,
): FederatedProject | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const ref = projectRef(backendId, raw.id);
  const hint = repositoryHint(raw.gitUrl);
  return {
    ref,
    key: projectKey(ref),
    name: boundedText(raw.name) || "Untitled project",
    order: typeof raw.order === "number" ? raw.order : index,
    ...(typeof raw.folder === "string" && raw.folder
      ? { folder: boundedText(raw.folder, 64) }
      : {}),
    ...(hint ? { repositoryHint: hint } : {}),
  };
}

export function toFederatedEnvironment(
  backendId: BackendId,
  raw: Record<string, unknown>,
): FederatedEnvironment | null {
  if (typeof raw.id !== "string" || !raw.id || typeof raw.projectId !== "string") return null;
  const ref = environmentRef(backendId, raw.id);
  const projectHome = raw.projectHome === true;
  return {
    ref,
    key: environmentKey(ref),
    projectId: raw.projectId,
    name: boundedText(raw.name) || "Environment",
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
    isProjectHome: projectHome,
  };
}

/** Where a runtime keeps its last-known summaries between sessions. */
export interface SummaryPersistence {
  load(backendId: BackendId): unknown;
  save(backendId: BackendId, value: unknown): void;
  remove(backendId: BackendId): void;
}

export const MAX_PERSISTED_SUMMARY_BYTES = 256 * 1024;

type PersistedSummary = {
  version: 1;
  savedAt: number;
  projects: FederatedProject[];
  environments: Array<[string, FederatedEnvironment[]]>;
  truncated: boolean;
};

function parsePersistedSummary(value: unknown, backendId: BackendId): PersistedSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PersistedSummary>;
  if (record.version !== 1 || typeof record.savedAt !== "number") return null;
  if (!Array.isArray(record.projects) || !Array.isArray(record.environments)) return null;
  const projects = record.projects
    .slice(0, MAX_SUMMARY_PROJECTS)
    .flatMap((project) =>
      project && typeof project === "object" && project.ref?.backendId === backendId
        ? [project]
        : [],
    );
  const environments = record.environments
    .slice(0, MAX_SUMMARY_PROJECTS)
    .flatMap((entry): Array<[string, FederatedEnvironment[]]> => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) {
        return [];
      }
      // Never adopt rows recorded for another machine.
      const rows = (entry[1] as FederatedEnvironment[])
        .slice(0, MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT)
        .filter((row) => row?.ref?.backendId === backendId);
      return [[entry[0], rows]];
    });
  return {
    version: 1,
    savedAt: record.savedAt,
    projects,
    environments,
    truncated: record.truncated === true,
  };
}

export type BackendRuntimeOptions = {
  client: BackendClient;
  connection: ConnectionSummary;
  now?: () => number;
  persistence?: SummaryPersistence | null;
};

export class BackendRuntime {
  readonly connectionId: string;
  readonly api: BackendClient;
  readonly store: StoreApi<MachineSummaryState>;
  /** Per-backend cache: identical reads on two machines never share an answer. */
  readonly prefetch = new PrefetchedCommandCache();
  readonly recovery: OperationRecovery;
  private demand = 0;
  private unsubscribe: (() => void) | null = null;
  private hydrating: Promise<void> | null = null;
  private dirty = false;
  private readonly dirtyProjects = new Set<string>();
  private projectRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRevision: number | null = null;
  /** Owned by this runtime: aborted when observation stops, never by a view. */
  private readAbort = new AbortController();
  private disposed = false;
  private readonly now: () => number;
  private readonly persistence: SummaryPersistence | null;

  constructor(options: BackendRuntimeOptions) {
    this.connectionId = options.connection.id;
    this.api = options.client;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence ?? null;
    const backendId = backendIdForConnection(options.connection);
    this.recovery = new OperationRecovery(backendId);
    this.store = createStore<MachineSummaryState>(() => ({
      backendId,
      connectionId: options.connection.id,
      connection: options.connection,
      freshness: "initializing",
      projects: [],
      environmentsByProject: new Map(),
      loadedAt: null,
      lastError: null,
      truncated: false,
      epoch: 0,
    }));
    this.restoreLastKnown();
  }

  /**
   * Last-known summaries from an earlier session, labelled stale until this
   * machine answers. Only rows recorded for this exact identity are adopted.
   */
  private restoreLastKnown(): void {
    const state = this.store.getState();
    if (!this.persistence) return;
    const transport = state.connection.transport;
    if (transport === "authentication-required" || transport === "trust-blocked") {
      this.persistence.remove(state.backendId);
      return;
    }
    let saved: PersistedSummary | null = null;
    try {
      saved = parsePersistedSummary(this.persistence.load(state.backendId), state.backendId);
    } catch {
      saved = null;
    }
    if (!saved) return;
    this.store.setState({
      projects: saved.projects,
      environmentsByProject: new Map(saved.environments),
      loadedAt: saved.savedAt,
      truncated: saved.truncated,
      freshness: "stale",
    });
  }

  private persistLastKnown(): void {
    if (!this.persistence) return;
    const state = this.store.getState();
    const value: PersistedSummary = {
      version: 1,
      savedAt: state.loadedAt ?? this.now(),
      projects: state.projects,
      environments: Array.from(state.environmentsByProject.entries()),
      truncated: state.truncated,
    };
    try {
      if (JSON.stringify(value).length > MAX_PERSISTED_SUMMARY_BYTES) {
        this.persistence.remove(state.backendId);
        return;
      }
      this.persistence.save(state.backendId, value);
    } catch {
      // Storage full or unavailable: last-known state just isn't kept.
    }
  }

  /** The machine was forgotten on this device: its cached summaries go too. */
  forgetLastKnown(): void {
    this.persistence?.remove(this.store.getState().backendId);
  }

  get id(): BackendId {
    return this.store.getState().backendId;
  }

  getSnapshot(): MachineSummaryState {
    return this.store.getState();
  }

  /**
   * Keep this machine's summaries live while someone shows them. Demand is
   * reference-counted; the last release stops observation, not remote work.
   */
  acquireSummaryDemand(): () => void {
    if (this.disposed) return () => undefined;
    this.demand += 1;
    if (this.demand === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.demand -= 1;
      if (this.demand === 0) this.stop();
    };
  }

  /** New connection-layer facts (transport, identity, profile) for this machine. */
  updateConnection(connection: ConnectionSummary): void {
    const previous = this.store.getState();
    const backendId = backendIdForConnection(connection);
    const reconnected =
      previous.connection.transport !== "connected" && connection.transport === "connected";
    const revoked =
      connection.transport === "authentication-required" ||
      connection.transport === "trust-blocked";
    if (backendId !== previous.backendId) {
      // Identity became verified (or changed): resource references are
      // rebuilt under the proved identity. Nothing from another identity is kept.
      this.store.setState({
        backendId,
        connection,
        projects: [],
        environmentsByProject: new Map(),
        freshness: "initializing",
        loadedAt: null,
      });
      this.prefetch.clear();
      if (this.demand > 0) this.requestHydrate();
      return;
    }
    if (revoked) {
      // A rejected credential or broken trust is not an offline state: drop
      // protected content rather than keep showing it as merely stale.
      this.prefetch.clear();
      this.persistence?.remove(previous.backendId);
      this.store.setState({
        connection,
        projects: [],
        environmentsByProject: new Map(),
        freshness: "stale",
        loadedAt: null,
      });
      return;
    }
    const keepProfile =
      previous.connection.profile &&
      (!connection.profile || connection.profile.revision < previous.connection.profile.revision);
    this.store.setState({
      connection: keepProfile
        ? { ...connection, profile: previous.connection.profile }
        : connection,
      freshness:
        connection.transport === "connected"
          ? previous.freshness === "stale"
            ? "catching-up"
            : previous.freshness
          : previous.loadedAt === null
            ? "initializing"
            : "stale",
    });
    if (reconnected && this.demand > 0) this.requestHydrate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.demand = 0;
    this.prefetch.clear();
  }

  /** Read through this runtime's own cache, fenced to the current epoch. */
  async read<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const prefetched = this.prefetch.read(command, args);
    if (prefetched.found) return prefetched.value as T;
    return this.api.invoke<T>(command, args, { signal: this.readAbort.signal });
  }

  /**
   * A write to this machine. It invalidates this runtime's cache, and an
   * ambiguous failure becomes an outcome-unknown record rather than a retry.
   */
  async mutate<T>(
    command: string,
    args: Record<string, unknown> = {},
    options: { label: string; requestKey?: string } = { label: command },
  ): Promise<T> {
    this.prefetch.noteInvocation(command);
    return this.recovery.run(command, args, options, () => this.api.invoke<T>(command, args));
  }

  /** Resolves once no summary read is running or queued. */
  async whenIdle(): Promise<void> {
    while (this.hydrating) await this.hydrating;
  }

  requestHydrate(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.hydrating) {
      this.dirty = true;
      return this.hydrating;
    }
    const run = this.hydrate().finally(() => {
      this.hydrating = null;
      if (this.dirty && !this.disposed && this.demand > 0) {
        this.dirty = false;
        void this.requestHydrate();
      }
    });
    this.hydrating = run;
    return run;
  }

  private start(): void {
    this.unsubscribe = this.api.subscribe((event, payload, epoch) =>
      this.handleEvent(event, payload, epoch),
    );
    // Identity and capabilities first (the connection layer's hello), then
    // the machine's entities: nothing is published for an unproved peer.
    void this.api
      .observe()
      .then((summary) => {
        if (this.disposed || this.demand === 0) return;
        if (summary) this.updateConnection(summary);
        const transport = this.store.getState().connection.transport;
        if (transport === "authentication-required" || transport === "trust-blocked") return;
        void this.requestHydrate();
      })
      .catch((error: unknown) => {
        this.store.setState({ lastError: boundedText(errorMessage(error)) });
      });
  }

  private stop(): void {
    // Abandon in-flight summary reads; a fresh controller serves the next start.
    this.readAbort.abort(new DOMException("Observation stopped", "AbortError"));
    this.readAbort = new AbortController();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    this.projectRefreshTimer = null;
    this.dirtyProjects.clear();
    this.api.release();
  }

  private handleEvent(event: string, payload: unknown, epoch: number): void {
    if (this.disposed) return;
    if (epoch !== this.store.getState().epoch) {
      // A new connection epoch: anything read on the older one is fenced off
      // (an in-flight read is discarded) and authoritative summaries reloaded.
      this.lastRevision = null;
      this.store.setState((current) => ({
        epoch,
        freshness: current.loadedAt === null ? current.freshness : "catching-up",
      }));
      void this.requestHydrate();
      return;
    }
    if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
      this.lastRevision = null;
      void this.requestHydrate();
      return;
    }
    if (event === BACKEND_PROFILE_CHANGED_EVENT) {
      this.applyProfile(payload);
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
      // A gap on this machine reconciles this machine only.
      const gap =
        this.lastRevision !== null &&
        (change.revision <= this.lastRevision || change.revision > this.lastRevision + 1);
      this.lastRevision = change.revision;
      if (gap) {
        void this.requestHydrate();
        return;
      }
    }
    if (change.resource === "project") {
      void this.requestHydrate();
    } else if (change.resource === "environment") {
      const projectId =
        typeof change.projectId === "string"
          ? change.projectId
          : this.projectOfEnvironment(change.id);
      if (projectId) this.scheduleProjectRefresh(projectId);
      else void this.requestHydrate();
    }
  }

  /** The machine's shared name/colour changed (from any client); newer revisions only. */
  private applyProfile(payload: unknown): void {
    let profile;
    try {
      profile = parseBackendProfile(payload);
    } catch {
      return;
    }
    const connection = this.store.getState().connection;
    if (connection.profile && connection.profile.revision > profile.revision) return;
    this.store.setState({
      connection: {
        ...connection,
        profile: {
          displayName: profile.displayName,
          colorToken: profile.colorToken,
          revision: profile.revision,
          cached: false,
        },
      },
    });
  }

  private projectOfEnvironment(environmentId: unknown): string | null {
    if (typeof environmentId !== "string") return null;
    for (const [projectId, environments] of this.store.getState().environmentsByProject) {
      if (environments.some((environment) => environment.ref.environmentId === environmentId)) {
        return projectId;
      }
    }
    return null;
  }

  private scheduleProjectRefresh(projectId: string): void {
    this.dirtyProjects.add(projectId);
    if (this.projectRefreshTimer) return;
    this.projectRefreshTimer = setTimeout(() => {
      this.projectRefreshTimer = null;
      const projectIds = Array.from(this.dirtyProjects);
      this.dirtyProjects.clear();
      void this.refreshProjects(projectIds);
    }, RESOURCE_REFRESH_DEBOUNCE_MS);
  }

  private async refreshProjects(projectIds: string[]): Promise<void> {
    const startEpoch = this.store.getState().epoch;
    const backendId = this.store.getState().backendId;
    const updates = await this.readEnvironments(backendId, projectIds);
    if (this.disposed || this.store.getState().epoch !== startEpoch) return;
    if (this.store.getState().backendId !== backendId) return;
    const next = new Map(this.store.getState().environmentsByProject);
    let truncated = this.store.getState().truncated;
    for (const [projectId, result] of updates) {
      if (result === null) continue;
      next.set(projectId, result.environments);
      truncated ||= result.truncated;
    }
    this.store.setState({ environmentsByProject: next, truncated });
  }

  private async hydrate(): Promise<void> {
    const state = this.store.getState();
    const startEpoch = state.epoch;
    const backendId = state.backendId;
    if (state.loadedAt !== null) this.store.setState({ freshness: "catching-up" });
    try {
      const rawProjects = await this.read<unknown>("get_projects");
      const list = Array.isArray(rawProjects) ? rawProjects : [];
      const projects = list
        .slice(0, MAX_SUMMARY_PROJECTS)
        .flatMap((raw, index) => {
          const project =
            raw && typeof raw === "object"
              ? toFederatedProject(backendId, raw as Record<string, unknown>, index)
              : null;
          return project ? [project] : [];
        })
        .sort((a, b) => a.order - b.order);
      const environments = await this.readEnvironments(
        backendId,
        projects.map((project) => project.ref.projectId),
      );
      if (this.disposed) return;
      const current = this.store.getState();
      // Late results from an older epoch or another identity never apply.
      if (current.epoch !== startEpoch || current.backendId !== backendId) return;
      const environmentsByProject = new Map<string, FederatedEnvironment[]>();
      let truncated = list.length > MAX_SUMMARY_PROJECTS;
      let failed = false;
      for (const project of projects) {
        const result = environments.get(project.ref.projectId);
        if (result === null || result === undefined) {
          failed = true;
          environmentsByProject.set(
            project.ref.projectId,
            current.environmentsByProject.get(project.ref.projectId) ?? [],
          );
          continue;
        }
        truncated ||= result.truncated;
        environmentsByProject.set(project.ref.projectId, result.environments);
      }
      this.store.setState({
        projects,
        environmentsByProject,
        loadedAt: this.now(),
        lastError: failed ? "Some environments could not be loaded." : null,
        freshness: failed
          ? "degraded"
          : current.connection.transport === "connected" ||
              current.connection.transport === undefined
            ? "current"
            : "stale",
        truncated,
      });
      this.persistLastKnown();
    } catch (error) {
      if (this.disposed) return;
      this.store.setState((current) => ({
        lastError: boundedText(errorMessage(error)),
        freshness: current.loadedAt === null ? "initializing" : "stale",
      }));
    }
  }

  private async readEnvironments(
    backendId: BackendId,
    projectIds: string[],
  ): Promise<Map<string, { environments: FederatedEnvironment[]; truncated: boolean } | null>> {
    const results = new Map<
      string,
      { environments: FederatedEnvironment[]; truncated: boolean } | null
    >();
    let next = 0;
    const worker = async () => {
      while (next < projectIds.length) {
        const projectId = projectIds[next++]!;
        try {
          const raw = await this.read<unknown>("get_environment_snapshots", { projectId });
          const list = Array.isArray(raw) ? raw : [];
          const environments = list
            .slice(0, MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT)
            .flatMap((entry) => {
              const environment =
                entry && typeof entry === "object"
                  ? toFederatedEnvironment(backendId, entry as Record<string, unknown>)
                  : null;
              return environment ? [environment] : [];
            });
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
