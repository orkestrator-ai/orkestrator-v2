/**
 * Snapshot-first rehydration (plan item 4003, report §8.3): what a node scope
 * writes to the bounded local snapshot store, how a newly opened scope is
 * hydrated from it, and when snapshots are dropped.
 *
 * - **Capture** (`captureNodeSnapshot`) copies list metadata out of a scope's
 *   light stores: projects, environments, presentation config, pane layout
 *   ids and the last selection. It picks fields one by one; the store's schema
 *   then refuses anything outside its allow-list (invariant 12).
 * - **Writes** (`nodeSnapshotService`, a warm service of every leaf scope)
 *   happen periodically, when the scope turns `live`, and when it stops, and
 *   only once the scope holds authoritative projects and environments, so an
 *   empty or half-loaded scope never overwrites a good snapshot.
 * - **Hydration** (`hydrateScopeFromSnapshot`) fills a newly opened scope's
 *   empty stores before its services start, without claiming they loaded
 *   (`hasLoaded` stays false), and marks the scope `resyncing`
 *   (`snapshot-sync.ts`). The authoritative reads take it to `live`: the
 *   project and config stores' `hasLoaded`, and the environment resync's
 *   `noteAuthoritativeRead`. The pane layout is backend-owned and loads per
 *   environment when its workspace mounts, so its ids are kept for the
 *   preview only and never written into the pane store (that store's
 *   persistence would write them back to the node).
 * - **Clearing**: a node that leaves the command node's registry loses its
 *   snapshot (the command scope's service watches the portal's node list);
 *   every whole-window clear of protected content (sign-out, new credentials,
 *   another gateway or connection) drops them all, and a node clear (its
 *   credential or identity changed) drops that node's. A sign-out that
 *   reloads the page at once still clears: the request is recorded in
 *   `localStorage` first and finished on the next start.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import { isWorkspaceRealm } from "@/lib/federation/workspace-realm";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedService } from "@/lib/node-scope/scoped-service";
import {
  createNodeSnapshotStore,
  indexedDbSnapshotBackend,
  NODE_SNAPSHOT_VERSION,
  SNAPSHOT_LIMITS,
  SnapshotContentError,
  SnapshotTooLargeError,
  type NodeSnapshot,
  type NodeSnapshotStore,
  type SnapshotConfig,
  type SnapshotEnvironment,
  type SnapshotPaneLayout,
  type SnapshotProject,
} from "@/lib/node-scope/snapshot-store";
import {
  hasAuthoritativeReads,
  markScopeResyncing,
  noteAuthoritativeRead,
  scopeSnapshotSync,
} from "@/lib/node-scope/snapshot-sync";
import { portalStore } from "@/lib/portal/portal-store";
import type { PortalState } from "@/lib/portal/portal-store";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import type { AppConfig, Environment, Project, RepositoryConfig } from "@/types";
import type { PaneNode } from "@/types/paneLayout";

const log = createLogger("web.node-snapshot");

/** How often a live leaf scope rewrites its snapshot (only when it changed). */
export const NODE_SNAPSHOT_WRITE_INTERVAL_MS = 30_000;
/** The first write after a scope starts, so a short visit still leaves a snapshot. */
export const NODE_SNAPSHOT_FIRST_WRITE_MS = 5_000;
/** How long opening a scope waits for its snapshot read before going on without it. */
export const NODE_SNAPSHOT_READ_BUDGET_MS = 1_000;

const PENDING_CLEAR_KEY = "orkestrator-node-snapshots-clear-pending";

// --- The store this renderer uses ------------------------------------------------

let configured: { store: NodeSnapshotStore | null } | null = null;
let appStore: NodeSnapshotStore | null | undefined;
/** Bumped by every clear, so a writer rewrites what a clear removed. */
let clearGeneration = 0;

function pendingClearStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The renderer's snapshot store: IndexedDB when the window has it, else
 * `null` (no snapshots). Tests replace it with `configureNodeSnapshots`.
 */
export function nodeSnapshotStore(): NodeSnapshotStore | null {
  if (configured) return configured.store;
  if (appStore !== undefined) return appStore;
  const backend = indexedDbSnapshotBackend();
  appStore = backend ? createNodeSnapshotStore(backend) : null;
  // A clear the last page could not finish (a sign-out reloads at once).
  if (appStore && pendingClearStorage()?.getItem(PENDING_CLEAR_KEY)) clearAllNodeSnapshots();
  return appStore;
}

/** Uses `store` (or none) in place of IndexedDB until the returned restore runs. For tests. */
export function configureNodeSnapshots(store: NodeSnapshotStore | null): () => void {
  const previous = configured;
  configured = { store };
  return () => {
    configured = previous;
  };
}

/** Drops `nodeId`'s snapshot. */
export function clearNodeSnapshot(nodeId: string): Promise<void> {
  clearGeneration += 1;
  const store = nodeSnapshotStore();
  if (!store) return Promise.resolve();
  return store.clear(nodeId).catch((error: unknown) => {
    log.warn("clear-failed", { error: logErrorKind(error) });
  });
}

/** Drops every snapshot; recorded first, so a reload right after still clears. */
export function clearAllNodeSnapshots(): Promise<void> {
  clearGeneration += 1;
  const store = nodeSnapshotStore();
  if (!store) return Promise.resolve();
  const storage = pendingClearStorage();
  try {
    storage?.setItem(PENDING_CLEAR_KEY, "1");
  } catch {
    // Quota or a locked-down storage: the clear below still runs.
  }
  return store.clearAll().then(
    () => {
      try {
        storage?.removeItem(PENDING_CLEAR_KEY);
      } catch {
        // Retried on the next start.
      }
    },
    (error: unknown) => log.warn("clear-failed", { error: logErrorKind(error) }),
  );
}

/** Drops the snapshots of nodes not in `known`. */
export async function pruneNodeSnapshots(
  known: ReadonlySet<string>,
  store = nodeSnapshotStore(),
): Promise<string[]> {
  if (!store) return [];
  try {
    const gone = (await store.entries())
      .map((entry) => entry.nodeId)
      .filter((nodeId) => !known.has(nodeId));
    for (const nodeId of gone) await store.clear(nodeId);
    if (gone.length > 0) clearGeneration += 1;
    return gone;
  } catch (error) {
    log.warn("clear-failed", { error: logErrorKind(error) });
    return [];
  }
}

// Snapshots are content derived from a node under a credential: they go with
// it (rich-content-reset.ts lists the triggers).
registerProtectedRichCache("node-snapshots", {
  clearAll: () => void clearAllNodeSnapshots(),
  clearBackend: (nodeId) => void clearNodeSnapshot(nodeId),
});

/** Reads in flight, so the hold and the preview of one open share one read. */
const inflightReads = new WeakMap<NodeSnapshotStore, Map<string, Promise<NodeSnapshot | null>>>();

function sharedRead(store: NodeSnapshotStore, nodeId: string): Promise<NodeSnapshot | null> {
  let reads = inflightReads.get(store);
  if (!reads) {
    reads = new Map();
    inflightReads.set(store, reads);
  }
  const existing = reads.get(nodeId);
  if (existing) return existing;
  const read = store.read(nodeId).finally(() => {
    if (reads.get(nodeId) === read) reads.delete(nodeId);
  });
  reads.set(nodeId, read);
  return read;
}

/**
 * `nodeId`'s snapshot, or `null`; never slower than `budgetMs` (an IndexedDB
 * that does not answer must not hold up opening the node). Concurrent reads
 * of one node share one store read.
 */
export function readNodeSnapshot(
  nodeId: string,
  budgetMs = NODE_SNAPSHOT_READ_BUDGET_MS,
  store = nodeSnapshotStore(),
): Promise<NodeSnapshot | null> {
  if (!store) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), budgetMs);
    sharedRead(store, nodeId).then(
      (snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      },
      (error: unknown) => {
        clearTimeout(timer);
        log.warn("read-failed", { error: logErrorKind(error) });
        resolve(null);
      },
    );
  });
}

// --- Capture -------------------------------------------------------------------

const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/iu;

function text(value: string): string {
  return value.slice(0, SNAPSHOT_LIMITS.text);
}

/** A remote or URL without its userinfo, so a token in a clone URL is never kept. */
function remote(value: string): string {
  return text(value.replace(URL_CREDENTIALS, "$1"));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** A nullable optional string kept only when it is short (icons may be data URLs). */
function optionalText<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string | null>> {
  if (value === null) return { [key]: null } as Record<K, null>;
  if (typeof value !== "string" || value.length > SNAPSHOT_LIMITS.text) return {};
  return { [key]: value } as Record<K, string>;
}

function captureProject(project: Project): SnapshotProject {
  return {
    id: text(project.id),
    name: text(project.name),
    gitUrl: remote(project.gitUrl),
    localPath: project.localPath === null ? null : text(project.localPath),
    addedAt: text(project.addedAt),
    order: finite(project.order),
    ...optionalText("folder", project.folder),
    ...optionalText("icon", project.icon),
  };
}

function captureEnvironment(environment: Environment): SnapshotEnvironment {
  return {
    id: text(environment.id),
    projectId: text(environment.projectId),
    name: text(environment.name),
    branch: text(environment.branch),
    containerId: environment.containerId === null ? null : text(environment.containerId),
    status: environment.status,
    prUrl: environment.prUrl === null ? null : remote(environment.prUrl),
    prState: environment.prState,
    hasMergeConflicts: environment.hasMergeConflicts,
    createdAt: text(environment.createdAt),
    networkAccessMode: environment.networkAccessMode,
    order: finite(environment.order),
    environmentType: environment.environmentType,
    ...(typeof environment.projectHome === "boolean"
      ? { projectHome: environment.projectHome }
      : {}),
    ...(typeof environment.lastActivityAt === "string"
      ? { lastActivityAt: text(environment.lastActivityAt) }
      : {}),
    ...(typeof environment.hasUnreadWork === "boolean"
      ? { hasUnreadWork: environment.hasUnreadWork }
      : {}),
  };
}

function captureConfig(config: AppConfig): SnapshotConfig {
  const global = config.global;
  const repositories = Object.entries(config.repositories ?? {})
    .slice(0, SNAPSHOT_LIMITS.repositories)
    .map(([projectId, repository]) => ({
      projectId: text(projectId),
      defaultBranch: text(repository.defaultBranch),
      prBaseBranch: text(repository.prBaseBranch),
    }));
  return {
    ...(global.enabledAgentPlatforms
      ? { enabledAgentPlatforms: global.enabledAgentPlatforms.slice(0, 32).map(text) }
      : {}),
    ...(global.preferredEditor ? { preferredEditor: global.preferredEditor } : {}),
    ...(global.terminalAppearance
      ? {
          terminalAppearance: {
            fontFamily: text(global.terminalAppearance.fontFamily),
            fontSize: finite(global.terminalAppearance.fontSize),
            backgroundColor: text(global.terminalAppearance.backgroundColor),
          },
        }
      : {}),
    repositories,
  };
}

function leavesOf(node: PaneNode): Array<Extract<PaneNode, { kind: "leaf" }>> {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leavesOf);
}

function capturePaneLayouts(scope: NodeScope): SnapshotPaneLayout[] {
  const layouts: SnapshotPaneLayout[] = [];
  for (const [environmentId, state] of scope.store(paneLayoutStore).getState().environments) {
    if (layouts.length >= SNAPSHOT_LIMITS.paneLayouts) break;
    const leaves = leavesOf(state.root);
    const active = leaves.find((leaf) => leaf.id === state.activePaneId) ?? leaves[0];
    layouts.push({
      environmentId: text(environmentId),
      activePaneId: text(state.activePaneId),
      activeTabId: active?.activeTabId ? text(active.activeTabId) : null,
      tabIds: leaves
        .flatMap((leaf) => leaf.tabs.map((tab) => text(tab.id)))
        .slice(0, SNAPSHOT_LIMITS.tabIdsPerLayout),
    });
  }
  return layouts;
}

/**
 * What `scope` shows now, as a snapshot record. Fields are copied one by one;
 * `NodeSnapshotStore.write` checks the result against the content rules.
 */
export function captureNodeSnapshot(scope: NodeScope, savedAt = Date.now()): NodeSnapshot {
  const projects = scope.store(projectStore).getState().projects;
  const environments = scope.store(environmentStore).getState().environments;
  const config = scope.store(configStore).getState();
  const ui = scope.store(uiStore).getState();
  return {
    version: NODE_SNAPSHOT_VERSION,
    nodeId: scope.nodeId,
    savedAt,
    projects: projects.slice(0, SNAPSHOT_LIMITS.projects).map(captureProject),
    environments: environments.slice(0, SNAPSHOT_LIMITS.environments).map(captureEnvironment),
    config: config.hasLoaded ? captureConfig(config.config) : null,
    paneLayouts: capturePaneLayouts(scope),
    selection: {
      projectId: ui.selectedProjectId === null ? null : text(ui.selectedProjectId),
      environmentId: ui.selectedEnvironmentId === null ? null : text(ui.selectedEnvironmentId),
    },
  };
}

// --- Hydration -----------------------------------------------------------------

function overlayConfig(base: AppConfig, snapshot: SnapshotConfig): AppConfig {
  const repositories: Record<string, RepositoryConfig> = { ...base.repositories };
  for (const repository of snapshot.repositories) {
    repositories[repository.projectId] = {
      ...repositories[repository.projectId],
      defaultBranch: repository.defaultBranch,
      prBaseBranch: repository.prBaseBranch,
    };
  }
  const editor = snapshot.preferredEditor;
  return {
    ...base,
    global: {
      ...base.global,
      ...(snapshot.enabledAgentPlatforms
        ? {
            enabledAgentPlatforms: [
              ...snapshot.enabledAgentPlatforms,
            ] as AppConfig["global"]["enabledAgentPlatforms"],
          }
        : {}),
      ...(editor === "vscode" || editor === "cursor" ? { preferredEditor: editor } : {}),
      ...(snapshot.terminalAppearance
        ? { terminalAppearance: { ...snapshot.terminalAppearance } }
        : {}),
    },
    repositories,
  };
}

/** Notes `kind` authoritative once `loaded(state)` turns true in `store`. */
function noteWhenLoaded<S>(
  scope: NodeScope,
  kind: "project" | "config",
  store: {
    getState(): S;
    subscribe(listener: (state: S) => void): () => void;
  },
  loaded: (state: S) => boolean,
): void {
  if (loaded(store.getState())) {
    noteAuthoritativeRead(scope, kind);
    return;
  }
  const stop = store.subscribe((state) => {
    if (!loaded(state)) return;
    stop();
    noteAuthoritativeRead(scope, kind);
  });
  scope.onDispose(`snapshot-watch:${kind}`, stop);
}

/**
 * Fills `scope`'s empty light stores from `snapshot` and marks it
 * `resyncing`. Does nothing (and returns false) for another node's snapshot,
 * a disposed scope, or a scope whose projects already arrived: authoritative
 * data always wins.
 */
export function hydrateScopeFromSnapshot(scope: NodeScope, snapshot: NodeSnapshot): boolean {
  if (scope.disposed || snapshot.nodeId !== scope.nodeId) return false;
  const projects = scope.store(projectStore);
  if (projects.getState().hasLoaded || projects.getState().projects.length > 0) return false;
  // `setState`, not `setProjects`: the stores must not claim they loaded.
  projects.setState({
    projects: [...snapshot.projects].sort((a, b) => a.order - b.order) as Project[],
  });
  const environments = scope.store(environmentStore);
  if (environments.getState().environments.length === 0) {
    environments.setState({
      environments: [...snapshot.environments].sort(
        (a, b) => a.order - b.order,
      ) as unknown as Environment[],
    });
  }
  const config = scope.store(configStore);
  if (!config.getState().hasLoaded && snapshot.config) {
    config.setState({ config: overlayConfig(config.getState().config, snapshot.config) });
  }
  noteWhenLoaded(scope, "project", projects, (state) => state.hasLoaded);
  noteWhenLoaded(scope, "config", config, (state) => state.hasLoaded);
  markScopeResyncing(scope, snapshot.savedAt);
  return true;
}

/** Plan item 4001's hold calls this when it opens a node's scope (`in-tree-scopes.ts`). */
export interface ScopeSnapshotPreparation {
  /** The node's snapshot, read while the scope opens; bounded by the read budget. */
  readonly snapshot: Promise<NodeSnapshot | null>;
  /** Hydrates the opened scope before its services start. */
  hydrate(scope: NodeScope, snapshot: NodeSnapshot): void;
}

export function prepareScopeSnapshot(nodeId: BackendId | string): ScopeSnapshotPreparation {
  return {
    snapshot: readNodeSnapshot(nodeId),
    hydrate: (scope, snapshot) => {
      hydrateScopeFromSnapshot(scope, snapshot);
    },
  };
}

// --- The service ----------------------------------------------------------------

/** Whether `scope` holds authoritative lists worth keeping. */
function readyToWrite(scope: NodeScope): boolean {
  return (
    scopeSnapshotSync(scope).get().state === "live" &&
    scope.store(projectStore).getState().hasLoaded &&
    hasAuthoritativeReads(scope, ["environment"])
  );
}

export interface SnapshotWriterOptions {
  readonly intervalMs?: number;
  readonly firstWriteMs?: number;
  readonly now?: () => number;
}

/**
 * Writes `scope`'s snapshot to `store` after `firstWriteMs`, every
 * `intervalMs`, when the scope turns `live`, and once when stopped; each time
 * only when it is ready and the record changed. Returns the stop.
 */
export function startNodeSnapshotWriter(
  scope: NodeScope,
  store: NodeSnapshotStore,
  options: SnapshotWriterOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? NODE_SNAPSHOT_WRITE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let last: { body: string; generation: number } | null = null;
  let writing = false;
  let stopped = false;

  const write = (): void => {
    if (writing) return;
    let snapshot: NodeSnapshot;
    try {
      if (scope.disposed || !readyToWrite(scope)) return;
      snapshot = captureNodeSnapshot(scope, now());
    } catch {
      // The scope's stores went away while it stopped.
      return;
    }
    const body = JSON.stringify({ ...snapshot, savedAt: 0 });
    if (last?.body === body && last.generation === clearGeneration) return;
    const generation = clearGeneration;
    writing = true;
    void store
      .write(snapshot)
      .then(
        ({ evicted }) => {
          last = { body, generation };
          if (evicted.length > 0) log.info("evicted", { count: evicted.length });
        },
        (error: unknown) => {
          if (error instanceof SnapshotContentError || error instanceof SnapshotTooLargeError) {
            log.warn("refused", { reason: error._tag });
          } else {
            log.warn("write-failed", { error: logErrorKind(error) });
          }
        },
      )
      .finally(() => {
        writing = false;
      });
  };

  let timer: ReturnType<typeof setTimeout> | null = setTimeout(function tick() {
    write();
    timer = stopped ? null : setTimeout(tick, intervalMs);
  }, options.firstWriteMs ?? NODE_SNAPSHOT_FIRST_WRITE_MS);
  const unsubscribe = scopeSnapshotSync(scope).subscribe((sync) => {
    if (sync.state === "live") write();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
    write();
  };
}

/**
 * Drops the snapshots of nodes that left the command node's registry,
 * whenever its node list changes. Returns the stop.
 */
export function startSnapshotRegistryWatch(
  store: NodeSnapshotStore,
  source: {
    getState(): PortalState;
    subscribe(listener: (state: PortalState) => void): () => void;
  } = portalStore.store,
): () => void {
  let lastKey: string | null = null;
  const check = (state: PortalState) => {
    if (!state.loaded || state.unsupported) return;
    const known = new Set<string>(state.nodes.map((node) => node.nodeId));
    if (state.selfId) known.add(state.selfId);
    const key = Array.from(known).sort().join("\u0000");
    if (key === lastKey) return;
    lastKey = key;
    void pruneNodeSnapshots(known, store);
  };
  check(source.getState());
  return source.subscribe(check);
}

/**
 * Every warm scope's snapshot duty (plan item 4003): a leaf writes its
 * snapshot; the window's command scope watches the registry for removed
 * nodes. Nothing runs without a snapshot store, or in a realm document (its
 * command scope is the realm's own node, and realms keep their own storage).
 */
export const nodeSnapshotService = defineScopedService("node-snapshot", (scope) => {
  const store = nodeSnapshotStore();
  if (!store) return { stop: () => undefined };
  if (scope.role === "leaf") return { stop: startNodeSnapshotWriter(scope, store) };
  if (isWorkspaceRealm()) return { stop: () => undefined };
  return { stop: startSnapshotRegistryWatch(store) };
});
