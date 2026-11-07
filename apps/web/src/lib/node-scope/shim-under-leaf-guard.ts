/**
 * The runtime shim guard (plan item 4004, report §7.3 guard 2).
 *
 * A converted store's deprecated statics, and its hook outside a provider,
 * reach the app's **command scope** (`scoped-store-shim.ts`). Code acting for
 * an in-tree leaf that takes that path silently reads or writes the wrong
 * node. While any in-tree leaf workspace is mounted (`useInTreeLeafMount`,
 * called by `InTreeWorkspace`), a shim use of a store in the workspace
 * subtree (`WORKSPACE_SUBTREE_STORES`):
 *
 * - throws `ShimUnderLeafError` in development and tests;
 * - in production, is counted (`shimUnderLeafCounts()`) and logged once per
 *   store and kind as `web.node-scope` `shim-under-leaf`, with the store's
 *   name and how it was reached only (both static identifiers: no node,
 *   project, path or value).
 *
 * Stores outside the workspace subtree are exempt and listed explicitly
 * (`SHIM_GUARD_EXEMPT_STORES`). With no leaf mounted nothing is checked: the
 * command node's own workspace may still use the shim until its store item
 * retires it.
 *
 * `scoped-store-shim.ts` installs `shimUnderLeafGuard` as `noteShimUse`'s
 * observer, so the guard is on wherever the shim is loaded; a test that
 * observes shim uses itself replaces it through `setShimUseObserver`.
 *
 * The multi-node e2e (plan item 4006) turns the guard on explicitly with
 * `VITE_ORKESTRATOR_SHIM_GUARD=throw` (or `count`) in the renderer's
 * environment, which also installs a read-only probe,
 * `window.orkestratorShimGuard`, so the spec can assert that no use was
 * caught, including one thrown inside a callback that swallowed the error.
 */

import { createLogger } from "@orkestrator/protocol/logger";
import { useLayoutEffect } from "react";

const log = createLogger("web.node-scope");

/**
 * The stores a workspace's components reach (plan item 3013, from the value
 * import closure of `TerminalContainer` and `ProjectWorkspace`): every store
 * converted so far. A store item that converts another store adds it here or
 * to `SHIM_GUARD_EXEMPT_STORES`; a test fails on a `SHIMMED_STORES` entry in
 * neither.
 */
export const WORKSPACE_SUBTREE_STORES = [
  "agent-activity",
  "agent-mail",
  "agent-model-catalog",
  "build-pipeline",
  "change-projection",
  "claude-options",
  "claude-tmux",
  "config",
  "coordinator-activity",
  "coordinator-launch-override",
  "coordinator-pane-layout",
  "design",
  "environment",
  "environment-diff",
  "feature-plan",
  "file-dirty",
  "files-panel",
  "github-issues",
  "graph-describe",
  "graph-designer",
  "graph-run",
  "kanban",
  "multi-review",
  "native-agent-projection",
  "native-compose",
  "pane-layout",
  "pr-monitor",
  "preview-service",
  "project",
  "project-pull-requests",
  "prompt-draft",
  "pull-requests",
  "session",
  "tab-launch",
  "terminal-session",
  "ui",
  "web-annotation",
  "web-annotation-preferences",
  "worktree-snapshot",
] as const;

export type WorkspaceSubtreeStore = (typeof WORKSPACE_SUBTREE_STORES)[number];

export interface ExemptStore {
  /** The store's name in kebab case (its module is `stores/<camelCase>Store.ts`). */
  readonly store: string;
  /** Module id under `apps/web/src`. */
  readonly module: string;
  readonly kind: "window" | "command-only";
}

/**
 * The stores outside the workspace subtree: one instance per window (its
 * chrome, its selection, dialogs it shows, view state keyed by node), never
 * per node. None of them has a shim today, so none reaches `noteShimUse`; a
 * use under one of these names is never a misrouted node call and never
 * throws. No store is command-only yet.
 */
export const SHIM_GUARD_EXEMPT_STORES: readonly ExemptStore[] = [
  { store: "active-coordinator-conversation", module: "stores/activeCoordinatorConversationStore" },
  { store: "app-dialog", module: "stores/appDialogStore" },
  { store: "artifact-live-host", module: "stores/artifactLiveHostStore" },
  { store: "bug-report", module: "stores/bugReportStore" },
  { store: "conversation-scroll-target", module: "stores/conversationScrollTargetStore" },
  { store: "error-dialog", module: "stores/errorDialogStore" },
  { store: "files-panel-chrome", module: "stores/filesPanelChromeStore" },
  { store: "flow-graph-view", module: "stores/flowGraphViewStore" },
  { store: "global-settings", module: "stores/globalSettingsStore" },
  { store: "machine-bulk-update", module: "stores/machineBulkUpdateStore" },
  { store: "machine-view", module: "stores/machineViewStore" },
  { store: "merge-pr-request", module: "stores/mergePrRequestStore" },
  { store: "message-part-expansion", module: "stores/messagePartExpansionStore" },
  { store: "native-notice-dismissal", module: "stores/nativeNoticeDismissalStore" },
  { store: "project-copy", module: "stores/projectCopyStore" },
  { store: "remote-workspace", module: "stores/remoteWorkspaceStore" },
  { store: "rich-content-view", module: "stores/richContentViewStore" },
  { store: "sidebar-action", module: "stores/sidebarActionStore" },
  { store: "static-html-frame-slots", module: "stores/staticHtmlFrameSlots" },
  { store: "terminal-portal", module: "stores/terminalPortalStore" },
  { store: "ui-chrome", module: "stores/uiChromeStore" },
  { store: "window-selection", module: "stores/windowSelectionStore" },
].map((entry) => ({ ...entry, kind: "window" as const }));

const guarded: ReadonlySet<string> = new Set(WORKSPACE_SUBTREE_STORES);

/** Whether a shim use of `store` under a mounted leaf is a misrouted call. */
export function isGuardedShimStore(store: string): boolean {
  return guarded.has(store);
}

/** What `noteShimUse` reports; the same shape as `ShimUse` in `scoped-store-shim.ts`. */
export interface GuardedShimUse {
  readonly store: string;
  readonly via: string;
}

/**
 * A shim use under a mounted in-tree leaf, in development and tests. The
 * message names the store and the remedy, never a value.
 */
export class ShimUnderLeafError extends Error {
  override readonly name = "ShimUnderLeafError";
  readonly store: string;
  readonly via: string;

  constructor(use: GuardedShimUse) {
    super(
      `The "${use.store}" store's command-scope shim (${use.via}) was used while an in-tree ` +
        "leaf workspace is mounted, so it reached the command node. Name the node: " +
        "`scope.store(def)` with the scope from `useNodeScope()` or the caller.",
    );
    this.store = use.store;
    this.via = use.via;
  }
}

/** `throw` in development and tests, `count` in production. */
export type ShimGuardMode = "throw" | "count";

/** The renderer environment variable that sets the mode explicitly (plan item 4006's e2e). */
export const SHIM_GUARD_ENV = "VITE_ORKESTRATOR_SHIM_GUARD";

function readEnv(): Record<string, unknown> | undefined {
  // Vite sets DEV and MODE; under `bun test`, import.meta.env is process.env.
  return import.meta.env as unknown as Record<string, unknown> | undefined;
}

function requestedMode(env = readEnv()): ShimGuardMode | null {
  const value = env?.[SHIM_GUARD_ENV];
  return value === "throw" || value === "count" ? value : null;
}

/** The mode this renderer runs the guard in: the explicit flag, else by build mode. */
export function defaultShimGuardMode(env = readEnv()): ShimGuardMode {
  const requested = requestedMode(env);
  if (requested) return requested;
  const strict = env?.DEV === true || env?.MODE === "test" || env?.NODE_ENV === "test";
  return strict ? "throw" : "count";
}

let mode: ShimGuardMode = defaultShimGuardMode();

/** Mounted in-tree leaf workspaces, by node, counted (two mounts of one node are two). */
const mountedLeaves = new Map<string, number>();

/** Uses caught under a mounted leaf, by `store|via`. Bounded by the guarded stores times the kinds. */
const counts = new Map<string, { store: string; via: string; count: number }>();

/** Marks `nodeId`'s in-tree workspace mounted until the returned release runs (idempotent). */
export function markInTreeLeafMounted(nodeId: string): () => void {
  mountedLeaves.set(nodeId, (mountedLeaves.get(nodeId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (mountedLeaves.get(nodeId) ?? 1) - 1;
    if (left > 0) mountedLeaves.set(nodeId, left);
    else mountedLeaves.delete(nodeId);
  };
}

/**
 * Marks `nodeId`'s in-tree workspace mounted while the calling component is.
 * A layout effect, so the mark is set before the leaf's scope opens and its
 * subtree renders.
 */
export function useInTreeLeafMount(nodeId: string): void {
  useLayoutEffect(() => markInTreeLeafMounted(nodeId), [nodeId]);
}

/** Whether any in-tree leaf workspace is mounted in this renderer. */
export function inTreeLeafMounted(): boolean {
  return mountedLeaves.size > 0;
}

/** The nodes whose in-tree workspaces are mounted; for the probe and tests. */
export function mountedInTreeLeaves(): string[] {
  return Array.from(mountedLeaves.keys()).sort();
}

export interface ShimUnderLeafCount {
  readonly store: string;
  readonly via: string;
  readonly count: number;
}

/** Every use caught under a mounted leaf since load (or the last reset), in both modes. */
export function shimUnderLeafCounts(): ShimUnderLeafCount[] {
  return Array.from(counts.values(), (entry) => ({ ...entry }));
}

/**
 * `noteShimUse`'s observer. Does nothing with no in-tree leaf mounted or for
 * a store outside the workspace subtree; otherwise counts the use, then
 * throws (`throw`) or logs its first occurrence (`count`).
 */
export function shimUnderLeafGuard(use: GuardedShimUse): void {
  if (mountedLeaves.size === 0 || !guarded.has(use.store)) return;
  const key = `${use.store}|${use.via}`;
  const entry = counts.get(key);
  if (entry) entry.count = Math.min(entry.count + 1, Number.MAX_SAFE_INTEGER);
  else counts.set(key, { store: use.store, via: use.via, count: 1 });
  if (mode === "throw") throw new ShimUnderLeafError(use);
  if (!entry) log.warn("shim-under-leaf", { store: use.store, via: use.via });
}

/**
 * Sets the mode (and clears the counts and mounts when `reset`) until the
 * returned restore runs. For tests.
 */
export function configureShimUnderLeafGuard(next: {
  mode?: ShimGuardMode;
  reset?: boolean;
}): () => void {
  const previous = mode;
  if (next.mode) mode = next.mode;
  if (next.reset) resetShimUnderLeafGuardForTests();
  return () => {
    mode = previous;
  };
}

/** Clears the counts and every mount mark. For tests. */
export function resetShimUnderLeafGuardForTests(): void {
  counts.clear();
  mountedLeaves.clear();
}

/** The read-only probe the multi-node e2e reads (`window.orkestratorShimGuard`). */
export interface ShimGuardProbe {
  readonly mode: ShimGuardMode;
  mountedLeaves(): string[];
  uses(): ShimUnderLeafCount[];
}

declare global {
  interface Window {
    /** Present only when the renderer runs with `VITE_ORKESTRATOR_SHIM_GUARD` (plan item 4006). */
    orkestratorShimGuard?: ShimGuardProbe;
  }
}

/** Installs `target.orkestratorShimGuard`. Called at load only when the flag is set. */
export function installShimGuardProbe(target: Window): ShimGuardProbe {
  const probe: ShimGuardProbe = {
    get mode() {
      return mode;
    },
    mountedLeaves: mountedInTreeLeaves,
    uses: shimUnderLeafCounts,
  };
  target.orkestratorShimGuard = probe;
  return probe;
}

if (requestedMode() && typeof window !== "undefined") installShimGuardProbe(window);
