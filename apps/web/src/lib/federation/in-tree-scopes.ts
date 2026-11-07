/**
 * The node scopes of workspaces shown in the window's own tree (plan item
 * 4001, `InTreeWorkspace`).
 *
 * `holdInTreeScope(nodeId)` opens the node's leaf scope in the app's window
 * scope, the way plan item 2013's proof does: in a browser or the iOS app
 * through the node-client registry (2004: a workspace grant from the command
 * node, direct first then the relay), on the desktop through main's node
 * scope (`window.orkestrator.node(nodeId)`, `orkestrator:nodes:open`). It
 * then hands the scope to the window's lifecycle (`WindowScope.lifecycle`,
 * plan item 4002), which starts its warm services (`WARM_SCOPE_SERVICES`,
 * 3014: the node's change feed, store bindings, connectivity, pane-layout
 * persistence and completion notes) and moves it between tiers:
 *
 * - shown: `live`; hidden: `warm`, with its reads paused;
 * - hidden past the host's `suspendAfterMs`: `suspended` (services stopped,
 *   streams closed with their cursors kept), resumed with a resync when it is
 *   shown again;
 * - under memory pressure: its heavy data goes, then it suspends, then it is
 *   disposed back to `summary`, which closes this window's streams and
 *   revokes its grant (on the desktop main then releases its node scope).
 *
 * None of it cancels work on the node (invariant 2): the node's agents,
 * terminals and pipelines keep running. Holds are counted for the views that
 * show the node; releasing the last one leaves the scope to its tiers (this
 * replaced 4001's 60 s grace timer). A disposed scope's next hold reopens it.
 *
 * A scope this module did not open (one already in the window scope) is
 * reused and never disposed here: pressure gives it back with its services
 * stopped instead.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { createDesktopNodeClient } from "@/lib/node-scope/desktop-node-client";
import type { ManagedScope, ManagedScopeHooks } from "@/lib/node-scope/lifecycle";
import { createNodeClientRegistry, type NodeClientRegistry } from "@/lib/node-scope/node-clients";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { prepareScopeSnapshot, type ScopeSnapshotPreparation } from "@/lib/node-snapshots";
import { attentionHandoff } from "@/lib/federation/window-attention";
import {
  notifyReadCoordinatorReconnected,
  setReadCoordinatorScopeHidden,
} from "@/lib/read-coordinator";
import { startScopeServices, WARM_SCOPE_SERVICES } from "@/lib/scope-services";

/** How one host opens a leaf scope in a window scope. */
export interface InTreeScopeHost {
  readonly kind: "browser" | "desktop";
  openLeafScope(windowScope: WindowScope, nodeId: BackendId): Promise<NodeScope>;
}

export interface InTreeScopeOptions {
  readonly windowScope?: WindowScope;
  readonly host?: InTreeScopeHost;
  /**
   * Reads the node's local snapshot while its scope opens, and hydrates the
   * opened scope from it before its services start (plan item 4003);
   * defaults to `prepareScopeSnapshot`. `null`: no snapshot.
   */
  readonly prepare?: ((nodeId: BackendId) => ScopeSnapshotPreparation) | null;
  /** Starts the scope's services and returns the stop; defaults to `WARM_SCOPE_SERVICES`. */
  readonly startServices?: (scope: NodeScope) => () => void;
  /**
   * The scope's reads pause while it is hidden and reconcile after a resume;
   * defaults to its read coordinator (`setReadCoordinatorScopeHidden`,
   * `notifyReadCoordinatorReconnected`).
   */
  readonly readHooks?: Pick<ManagedScopeHooks, "setHidden" | "resync">;
  /**
   * Before a suspend closes the scope's streams: moves the window's attention
   * for the node to the command node's relay (plan item 5001); defaults to
   * `attentionHandoff`.
   */
  readonly handoff?: (scope: NodeScope) => Promise<void>;
}

export interface InTreeScopeHold {
  /** The node's scope once it is open; rejects when it cannot be opened. */
  readonly scope: Promise<NodeScope>;
  /** Ends this hold. Idempotent. */
  release(): void;
}

interface Entry {
  refs: number;
  readonly scope: Promise<NodeScope>;
  opened: NodeScope | null;
  owned: boolean;
  /** The lifecycle's handle, once the scope is open. */
  managed: ManagedScope | null;
}

const entries = new WeakMap<WindowScope, Map<string, Entry>>();

/** Defaults every hold uses unless it passes its own; tests replace them. */
let defaults: Omit<InTreeScopeOptions, "windowScope"> = {};

/**
 * Replaces the defaults of `holdInTreeScope` (the host, the services it
 * starts, the read hooks) until the returned restore runs. For tests that
 * render `InTreeWorkspace` on a fake node.
 */
export function configureInTreeScopes(next: Omit<InTreeScopeOptions, "windowScope">): () => void {
  const previous = defaults;
  defaults = { ...previous, ...next };
  return () => {
    defaults = previous;
  };
}

let browserRegistry: NodeClientRegistry | null = null;

type DesktopHost = NonNullable<Window["orkestrator"]>;

/**
 * The desktop preload API when this renderer has node scopes, else
 * `undefined`. (The scope-proof harness has its own copy; it is dev-only and
 * must not be pulled into a production bundle.)
 */
function desktopHostApi(target: Window): DesktopHost | undefined {
  if (typeof target.orkestrator?.node === "function") return target.orkestrator;
  const preload = target.orkestratorDesktopHost?.api;
  return typeof preload?.node === "function" ? (preload as DesktopHost) : undefined;
}

/** The desktop host: main's node scope through the preload's `node(nodeId)`. */
export function desktopInTreeScopeHost(): InTreeScopeHost {
  return {
    kind: "desktop",
    async openLeafScope(windowScope, nodeId) {
      const open = windowScope.get(nodeId);
      if (open) return open;
      const client = createDesktopNodeClient({ nodeId, host: () => desktopHostApi(window) });
      const scope = windowScope.open({ role: "leaf", client });
      try {
        // Opening the stream opens main's node scope (one hold) or refuses.
        await client.eventStreamReady();
      } catch (error) {
        scope.dispose();
        throw error;
      }
      return scope;
    },
  };
}

/** The browser and iOS host: the window's one node-client registry. */
export function browserInTreeScopeHost(registry?: NodeClientRegistry): InTreeScopeHost {
  return {
    kind: "browser",
    openLeafScope: (windowScope, nodeId) =>
      (registry ?? (browserRegistry ??= createNodeClientRegistry())).openLeafScope(
        windowScope,
        nodeId,
      ),
  };
}

/** This renderer's host: the desktop's when the preload has node scopes, else the browser's. */
export function defaultInTreeScopeHost(): InTreeScopeHost {
  return typeof window !== "undefined" && desktopHostApi(window)
    ? desktopInTreeScopeHost()
    : browserInTreeScopeHost();
}

function windowEntries(windowScope: WindowScope): Map<string, Entry> {
  let map = entries.get(windowScope);
  if (!map) {
    map = new Map();
    entries.set(windowScope, map);
  }
  return map;
}

function close(map: Map<string, Entry>, nodeId: string, entry: Entry): void {
  if (map.get(nodeId) === entry) map.delete(nodeId);
  // Out of the lifecycle first: its services stop and its client resumes.
  entry.managed?.release();
  entry.managed = null;
  if (entry.owned && entry.opened && !entry.opened.disposed) entry.opened.dispose();
}

const defaultReadHooks: Pick<ManagedScopeHooks, "setHidden" | "resync"> = {
  setHidden: (scope, hidden) => setReadCoordinatorScopeHidden(scope, hidden),
  resync: (scope) => notifyReadCoordinatorReconnected(scope),
};

/**
 * `opening`, hydrated from the node's snapshot (read alongside, within its
 * budget) before anything else sees the scope: its services start after this,
 * so the first authoritative read replaces what the snapshot painted.
 */
async function openHydrated(
  opening: Promise<NodeScope>,
  preparation: ScopeSnapshotPreparation | null,
): Promise<NodeScope> {
  if (!preparation) return opening;
  const [scope, snapshot] = await Promise.all([opening, preparation.snapshot]);
  if (snapshot && !scope.disposed) preparation.hydrate(scope, snapshot);
  return scope;
}

/** Holds `nodeId`'s scope in the window's tree; see the module comment. */
export function holdInTreeScope(
  nodeId: string,
  explicit: InTreeScopeOptions = {},
): InTreeScopeHold {
  const options = { ...defaults, ...explicit };
  const windowScope = options.windowScope ?? getWindowScope();
  const map = windowEntries(windowScope);
  let entry = map.get(nodeId);
  // A scope disposed elsewhere (its node removed, the window closing) is reopened.
  if (entry?.opened?.disposed) {
    close(map, nodeId, entry);
    entry = undefined;
  }
  if (!entry) {
    const host = options.host ?? defaultInTreeScopeHost();
    const start =
      options.startServices ??
      ((scope: NodeScope) => startScopeServices(scope, WARM_SCOPE_SERVICES));
    const readHooks = options.readHooks ?? defaultReadHooks;
    const existing = windowScope.get(nodeId as BackendId);
    const created: Entry = {
      refs: 0,
      opened: null,
      owned: existing === null,
      managed: null,
      scope: (existing
        ? Promise.resolve(existing)
        : openHydrated(
            host.openLeafScope(windowScope, nodeId as BackendId),
            options.prepare === undefined
              ? prepareScopeSnapshot(nodeId as BackendId)
              : (options.prepare?.(nodeId as BackendId) ?? null),
          )
      ).then(
        (scope) => {
          created.opened = scope;
          // The window's in-tree scopes were closed while it opened.
          if (map.get(nodeId) !== created) {
            if (created.owned) scope.dispose();
            throw new Error("This workspace was closed while it opened.");
          }
          const handoff =
            options.handoff ??
            ((handed: NodeScope) => attentionHandoff(windowScope, handed.nodeId));
          created.managed = windowScope.lifecycle.manage(scope, {
            startServices: start,
            ...readHooks,
            handoff,
            toSummary: (summarised) => {
              // Pressure took it back to summary; the next hold reopens it.
              created.managed = null;
              if (map.get(nodeId) === created) map.delete(nodeId);
              if (created.owned) {
                summarised.dispose();
              } else {
                summarised.client.resume();
                readHooks.setHidden?.(summarised, false);
              }
            },
          });
          return scope;
        },
        (error: unknown) => {
          if (map.get(nodeId) === created) map.delete(nodeId);
          throw error;
        },
      ),
    };
    // Each hold observes the rejection; the entry's own copy must not be unhandled.
    created.scope.catch(() => undefined);
    map.set(nodeId, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    scope: held.scope,
    release() {
      if (released) return;
      released = true;
      // The scope stays in the lifecycle: hidden, it suspends on its timer
      // and pressure may take it back to summary.
      held.refs -= 1;
    },
  };
}

/** Holds of `nodeId` in `windowScope`; for tests and diagnostics. */
export function inTreeScopeHolds(nodeId: string, windowScope = getWindowScope()): number {
  return entries.get(windowScope)?.get(nodeId)?.refs ?? 0;
}

/** Closes every in-tree scope of `windowScope` now (tests; a window closing). */
export function closeInTreeScopes(windowScope = getWindowScope()): void {
  const map = entries.get(windowScope);
  if (!map) return;
  // A copy: closing deletes from the map.
  for (const [nodeId, entry] of Array.from(map)) close(map, nodeId, entry);
}
