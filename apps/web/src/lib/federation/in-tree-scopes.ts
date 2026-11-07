/**
 * The node scopes of workspaces shown in the window's own tree (plan item
 * 4001, `InTreeWorkspace`).
 *
 * `holdInTreeScope(nodeId)` opens the node's leaf scope in the app's window
 * scope, the way plan item 2013's proof does: in a browser or the iOS app
 * through the node-client registry (2004: a workspace grant from the command
 * node, direct first then the relay), on the desktop through main's node
 * scope (`window.orkestrator.node(nodeId)`, `orkestrator:nodes:open`). It
 * then starts the scope's warm services (`WARM_SCOPE_SERVICES`, 3014): the
 * node's change feed, store bindings, connectivity, pane-layout persistence
 * and completion notes.
 *
 * Holds are counted. The last release keeps the scope for a grace period
 * (`IN_TREE_RELEASE_GRACE_MS`), so a remount or a switch back is instant,
 * then stops its services and disposes it, which closes this window's
 * streams and revokes its grant. That never cancels work on the node
 * (invariant 2): the node's agents, terminals and pipelines keep running.
 * Plan item 4002's lifecycle manager replaces the grace timer with tiers and
 * budgets.
 *
 * A scope this module did not open (one already in the window scope) is
 * reused and never disposed here; only its services are started.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { createDesktopNodeClient } from "@/lib/node-scope/desktop-node-client";
import { createNodeClientRegistry, type NodeClientRegistry } from "@/lib/node-scope/node-clients";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { startScopeServices, WARM_SCOPE_SERVICES } from "@/lib/scope-services";

/** How long a released in-tree scope stays open, until plan item 4002's tiers. */
export const IN_TREE_RELEASE_GRACE_MS = 60_000;

/** How one host opens a leaf scope in a window scope. */
export interface InTreeScopeHost {
  readonly kind: "browser" | "desktop";
  openLeafScope(windowScope: WindowScope, nodeId: BackendId): Promise<NodeScope>;
}

export interface InTreeScopeOptions {
  readonly windowScope?: WindowScope;
  readonly host?: InTreeScopeHost;
  readonly graceMs?: number;
  /** Starts the scope's services and returns the stop; defaults to `WARM_SCOPE_SERVICES`. */
  readonly startServices?: (scope: NodeScope) => () => void;
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
  stopServices: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  readonly graceMs: number;
}

const entries = new WeakMap<WindowScope, Map<string, Entry>>();

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
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.stopServices?.();
  entry.stopServices = null;
  if (entry.owned && entry.opened && !entry.opened.disposed) entry.opened.dispose();
}

/** Holds `nodeId`'s scope in the window's tree; see the module comment. */
export function holdInTreeScope(nodeId: string, options: InTreeScopeOptions = {}): InTreeScopeHold {
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
    const existing = windowScope.get(nodeId as BackendId);
    const created: Entry = {
      refs: 0,
      opened: null,
      owned: existing === null,
      stopServices: null,
      timer: null,
      graceMs: options.graceMs ?? IN_TREE_RELEASE_GRACE_MS,
      scope: (existing
        ? Promise.resolve(existing)
        : host.openLeafScope(windowScope, nodeId as BackendId)
      ).then(
        (scope) => {
          created.opened = scope;
          // Every hold went away while it opened, past the grace period.
          if (map.get(nodeId) !== created) {
            if (created.owned) scope.dispose();
            throw new Error("This workspace was closed while it opened.");
          }
          created.stopServices = start(scope);
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
  if (held.timer) {
    clearTimeout(held.timer);
    held.timer = null;
  }
  let released = false;
  return {
    scope: held.scope,
    release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0 || map.get(nodeId) !== held) return;
      held.timer = setTimeout(() => {
        held.timer = null;
        if (held.refs === 0) close(map, nodeId, held);
      }, held.graceMs);
    },
  };
}

/** Holds (or a pending grace release) of `nodeId` in `windowScope`; for tests and diagnostics. */
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
