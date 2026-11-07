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
 * - **The window's command scope** (plan item 4003's last box) writes its
 *   snapshot like a leaf, under its proven id only, and remembers that id per
 *   window (`nodeStorageKey`, the command node's key). The next start reads
 *   the snapshot of the page's proven id, else of the remembered one, before
 *   the first render (`primeCommandScopeSnapshot`), and `App` hydrates the
 *   command scope from it just before its services start
 *   (`hydrateCommandScopeFromSnapshot`); `ScopeSnapshotGate` shows it
 *   read-only in the main area while it resyncs. A first-ever start has
 *   nothing to read and changes nothing. A browser command scope opens
 *   provisional; when its hello proves another id than the remembered one,
 *   the hydration is undone and any mutation waiting on it is refused.
 * - **Clearing**: a node that leaves the command node's registry loses its
 *   snapshot (the command scope's service watches the portal's node list);
 *   every whole-window clear of protected content (sign-out, new credentials,
 *   another gateway or connection) drops them all, and a node clear (its
 *   credential or identity changed) drops that node's. A sign-out that
 *   reloads the page at once still clears: the request is recorded in
 *   `localStorage` first and finished on the next start.
 */

import { isProvisionalBackendId, type BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import { commandNodeIdFromPage } from "@/lib/node-scope/app-window-scope";
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
  discardScopeResyncing,
  hasAuthoritativeReads,
  markScopeResyncing,
  noteAuthoritativeRead,
  scopeSnapshotSync,
} from "@/lib/node-scope/snapshot-sync";
import { COMMAND_STORAGE_NODE, nodeStorageKey } from "@/lib/persistence-keys";
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

function localStorageOrNull(): Storage | null {
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
  if (appStore && localStorageOrNull()?.getItem(PENDING_CLEAR_KEY)) clearAllNodeSnapshots();
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
  const storage = localStorageOrNull();
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

/** What a hydration put into a scope's stores, so it can be shown and undone. */
interface ScopeHydration {
  readonly snapshot: NodeSnapshot;
  /** Whether the environments were filled (they were empty). */
  readonly environments: boolean;
  /** The config before the overlay; `null` when untouched. */
  readonly config: { readonly before: AppConfig } | null;
}

const hydrations = new WeakMap<NodeScope, ScopeHydration>();

/**
 * Fills `scope`'s empty light stores from `snapshot` and marks it
 * `resyncing`. Does nothing (and returns false) for another node's snapshot,
 * a disposed scope, or a scope whose projects already arrived: authoritative
 * data always wins. `provisional`: a command scope still under its
 * provisional id takes the snapshot of the id it is expected to prove
 * (`hydrateCommandScopeFromSnapshot`).
 */
export function hydrateScopeFromSnapshot(
  scope: NodeScope,
  snapshot: NodeSnapshot,
  options: { readonly provisional?: boolean } = {},
): boolean {
  if (scope.disposed) return false;
  const sameNode =
    snapshot.nodeId === scope.nodeId ||
    (options.provisional === true && isProvisionalBackendId(scope.nodeId));
  if (!sameNode) return false;
  const projects = scope.store(projectStore);
  if (projects.getState().hasLoaded || projects.getState().projects.length > 0) return false;
  // `setState`, not `setProjects`: the stores must not claim they loaded.
  projects.setState({
    projects: [...snapshot.projects].sort((a, b) => a.order - b.order) as Project[],
  });
  const environments = scope.store(environmentStore);
  const fillEnvironments = environments.getState().environments.length === 0;
  if (fillEnvironments) {
    environments.setState({
      environments: [...snapshot.environments].sort(
        (a, b) => a.order - b.order,
      ) as unknown as Environment[],
    });
  }
  const config = scope.store(configStore);
  let hydratedConfig: ScopeHydration["config"] = null;
  if (!config.getState().hasLoaded && snapshot.config) {
    const before = config.getState().config;
    config.setState({ config: overlayConfig(before, snapshot.config) });
    hydratedConfig = { before };
  }
  hydrations.set(scope, { snapshot, environments: fillEnvironments, config: hydratedConfig });
  noteWhenLoaded(scope, "project", projects, (state) => state.hasLoaded);
  noteWhenLoaded(scope, "config", config, (state) => state.hasLoaded);
  markScopeResyncing(scope, snapshot.savedAt);
  return true;
}

/**
 * The snapshot `scope` was hydrated from, while it still shows it
 * (`resyncing`); `null` once it is `live` or when it never was hydrated.
 */
export function hydratedScopeSnapshot(scope: NodeScope): NodeSnapshot | null {
  if (scopeSnapshotSync(scope).get().state !== "resyncing") return null;
  return hydrations.get(scope)?.snapshot ?? null;
}

/**
 * Takes back what `hydrateScopeFromSnapshot` put into `scope`'s stores, where
 * no authoritative read has replaced it yet, and makes the scope `live`
 * without counting a read; mutations waiting on the snapshot are refused
 * (`discardScopeResyncing`). For a snapshot that turned out to be another
 * node's. Returns whether there was a hydration to undo.
 */
export function undoSnapshotHydration(scope: NodeScope): boolean {
  const hydration = hydrations.get(scope);
  if (!hydration) return false;
  hydrations.delete(scope);
  if (!scope.disposed) {
    // Until a store's authoritative read, what it holds stands on the snapshot.
    const projects = scope.store(projectStore);
    if (!projects.getState().hasLoaded) projects.setState({ projects: [] });
    if (hydration.environments && !hasAuthoritativeReads(scope, ["environment"])) {
      scope.store(environmentStore).setState({ environments: [] });
    }
    const config = scope.store(configStore);
    if (hydration.config && !config.getState().hasLoaded) {
      config.setState({ config: hydration.config.before });
    }
  }
  discardScopeResyncing(scope);
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
      // A command scope's snapshot is keyed by its proven id only.
      if (scope.disposed || isProvisionalBackendId(scope.nodeId) || !readyToWrite(scope)) return;
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

// --- The window's command scope --------------------------------------------------

const COMMAND_NODE_ID_BASE_KEY = "orkestrator-command-node-snapshot-id";

function commandNodeIdKey(): string {
  return nodeStorageKey(COMMAND_NODE_ID_BASE_KEY, COMMAND_STORAGE_NODE);
}

/** The command node id this window last proved, or `null` (a first-ever start). */
export function rememberedCommandNodeId(): BackendId | null {
  try {
    const value = localStorageOrNull()?.getItem(commandNodeIdKey());
    return value &&
      value.length <= SNAPSHOT_LIMITS.text &&
      !isProvisionalBackendId(value as BackendId)
      ? (value as BackendId)
      : null;
  } catch {
    return null;
  }
}

/** Remembers `nodeId` as this window's command node; a provisional id is never kept. */
export function rememberCommandNodeId(nodeId: BackendId): void {
  if (isProvisionalBackendId(nodeId)) return;
  try {
    const storage = localStorageOrNull();
    const key = commandNodeIdKey();
    if (storage && storage.getItem(key) !== nodeId) storage.setItem(key, nodeId);
  } catch {
    // Quota or a locked-down storage: the next start simply paints nothing early.
  }
}

/** The command scope's snapshot read, started before the first render. */
interface CommandSnapshotRead {
  readonly nodeId: BackendId;
  settled: boolean;
  snapshot: NodeSnapshot | null;
}

let commandRead: CommandSnapshotRead | null = null;

/**
 * Starts reading the command node's snapshot (the page's proven id, else the
 * one this window remembers), so it has usually answered by the time `App`
 * starts the command scope's services. Called once before the first render
 * (`renderer-entry.tsx`); nothing happens without a snapshot store, or on
 * a first-ever start (no id to read).
 */
export function primeCommandScopeSnapshot(pageNodeId: BackendId = commandNodeIdFromPage()): void {
  if (commandRead) return;
  const store = nodeSnapshotStore();
  if (!store) return;
  const nodeId = isProvisionalBackendId(pageNodeId) ? rememberedCommandNodeId() : pageNodeId;
  if (!nodeId) return;
  const read: CommandSnapshotRead = { nodeId, settled: false, snapshot: null };
  commandRead = read;
  void readNodeSnapshot(nodeId, NODE_SNAPSHOT_READ_BUDGET_MS, store).then((snapshot) => {
    read.settled = true;
    read.snapshot = snapshot;
  });
}

/** Forgets the primed read. For tests. */
export function resetCommandScopeSnapshotForTests(): void {
  commandRead = null;
}

/** A client that learns its proven id (the window client), else nothing. */
function provenNodeIdSignal(client: NodeClient): ReadableSignal<BackendId | null> | null {
  const signal = (client as { provenNodeId?: ReadableSignal<BackendId | null> }).provenNodeId;
  return signal && typeof signal.subscribe === "function" ? signal : null;
}

/**
 * Hydrates the window's command scope from the snapshot primed before the
 * first render, if that read has answered; `App` calls it just before the
 * command scope's services start, so nothing authoritative has landed yet.
 * Returns whether it hydrated. Nothing happens when the read is still out
 * (the start goes on as before), when there was nothing to read, or when the
 * scope already proved another id. A scope still provisional is hydrated for
 * the remembered id, and if its hello then proves a different one (this
 * window now talks to another command node), the hydration is undone.
 */
export function hydrateCommandScopeFromSnapshot(scope: NodeScope): boolean {
  const read = commandRead;
  if (!read || scope.role !== "command") return false;
  // Once only, and only before the services start: a read still out is not used later.
  commandRead = null;
  if (!read.settled || !read.snapshot) return false;
  const provisional = isProvisionalBackendId(scope.nodeId);
  if (!provisional && scope.nodeId !== read.nodeId) return false;
  if (!hydrateScopeFromSnapshot(scope, read.snapshot, { provisional })) return false;
  log.info("command-hydrated", { provisional });
  const proven = provisional ? provenNodeIdSignal(scope.client) : null;
  if (proven) {
    let stop: (() => void) | null = null;
    const check = (nodeId: BackendId | null) => {
      if (!nodeId || isProvisionalBackendId(nodeId)) return;
      stop?.();
      stop = null;
      if (nodeId === read.nodeId) return;
      log.info("command-discarded", {});
      undoSnapshotHydration(scope);
    };
    stop = proven.subscribe(check);
    scope.onDispose("snapshot-proven-id", () => stop?.());
    check(proven.get());
  }
  return true;
}

/**
 * The command scope's duty: remember its proven id (now, or once its hello
 * proves it), write its snapshot like a leaf (`startNodeSnapshotWriter`
 * skips a provisional id) and prune removed nodes' snapshots. Returns the stop.
 */
export function startCommandScopeSnapshot(
  scope: NodeScope,
  store: NodeSnapshotStore,
  options: SnapshotWriterOptions & {
    readonly registry?: Parameters<typeof startSnapshotRegistryWatch>[1];
  } = {},
): () => void {
  const stops: Array<() => void> = [];
  rememberCommandNodeId(scope.nodeId);
  const proven = isProvisionalBackendId(scope.nodeId) ? provenNodeIdSignal(scope.client) : null;
  if (proven) {
    const remember = (nodeId: BackendId | null) => {
      if (nodeId) rememberCommandNodeId(nodeId);
    };
    stops.push(proven.subscribe(remember));
    remember(proven.get());
  }
  stops.push(startNodeSnapshotWriter(scope, store, options));
  stops.push(startSnapshotRegistryWatch(store, options.registry));
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}

/**
 * Every warm scope's snapshot duty (plan item 4003): a leaf writes its
 * snapshot; the window's command scope writes its own, remembers its id and
 * watches the registry for removed nodes (`startCommandScopeSnapshot`).
 * Nothing runs without a snapshot store.
 */
export const nodeSnapshotService = defineScopedService("node-snapshot", (scope) => {
  const store = nodeSnapshotStore();
  if (!store) return { stop: () => undefined };
  if (scope.role === "leaf") return { stop: startNodeSnapshotWriter(scope, store) };
  return { stop: startCommandScopeSnapshot(scope, store) };
});
