/**
 * Per-node module state for code that is not a store (plan item 3016,
 * report §7.4 and Appendix B): caches, timers and identity notes held per
 * node scope (capability caches, the rich-content identity notes, the
 * persistence and subscription modules that 3003-3013 converted).
 *
 * Such state used to be module `let`s holding one answer per backend, so a
 * second live node would overwrite (or be answered with) the first node's.
 * Now each node scope holds its own slot, created on first use through
 * `scope.store(def)` and dropped when the scope is disposed. A caller that
 * names no scope gets the app's command scope, which is today's single
 * backend; scoped callers pass theirs.
 *
 * Raw commands and events follow the same rule: the app's command scope keeps
 * the `@/lib/native/backend` `invoke` and `@/lib/native/events` `listen` paths
 * (which are that scope's client and prefetched cache, plan item 2010, and
 * are what suites mock), and any other scope goes through its own client.
 * `lib/backend` factory calls do not use `scopeInvoker`: they take
 * `scopeBackendClient(scope)` or `backendApiForScope` from
 * `@/lib/backend/client` (plan item 3002), which apply the same rule.
 */

import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { invokeInScope } from "@/lib/node-scope/scope-transport";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";

/** The scope of the node this window is connected to. */
export function appCommandScope(): NodeScope {
  return getWindowScope().commandScope();
}

/** Whether `scope` is the app window's command scope (not a test's own window). */
export function isAppCommandScope(scope: NodeScope): boolean {
  return scope === appCommandScope();
}

/**
 * A slot of mutable per-node state. `slot(scope)` is `scope`'s instance,
 * created by `create` on first use; `slot()` is the app command scope's.
 * `create` may register cleanup with `scope.onDispose`. Calling it on a
 * disposed scope throws, so hold the instance you got, not the scope, across
 * an await.
 */
export type ScopedSlot<T> = (scope?: NodeScope) => T;

export function defineScopedSlot<T>(name: string, create: (scope: NodeScope) => T): ScopedSlot<T> {
  // The slot is the store's state object; nothing calls `setState` on it.
  const def = defineScopedStore<T>(name, (scope) => () => create(scope));
  return (scope = appCommandScope()) => scope.store(def).getState();
}

/** A raw command call in `@/lib/native/backend` `invoke`'s shape. */
export type ScopeInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * How to send a raw command, one with no `lib/backend` factory function, to
 * `scope`'s node (see the module comment). Today only the portal's
 * `invokeOnMachine` (`lib/portal/machine-scope.ts`) needs it.
 */
export function scopeInvoker(scope: NodeScope): ScopeInvoke {
  if (isAppCommandScope(scope)) return invoke;
  return (command, args) => invokeInScope(scope, command, args);
}

/** Listens for `event` on `scope`'s node (see the module comment). */
export function listenInScope<T>(
  scope: NodeScope,
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (isAppCommandScope(scope)) return listen<T>(event, (message) => handler(message.payload));
  return Promise.resolve(scope.client.listenRaw<T>(event, handler));
}

/**
 * Runs `handler` each time `scope`'s node connection comes back after a gap,
 * so a reader re-reads what it may have missed. The app's command scope keeps
 * the `native-event-stream-connected` event (what suites emit); any other
 * scope follows its client's `connection` signal into `live` (plan items
 * 3003, 3010). The state at subscription time is not a reconnect.
 */
export function onReconnectInScope(scope: NodeScope, handler: () => void): Promise<UnlistenFn> {
  if (isAppCommandScope(scope)) return listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => handler());
  const connection = scope.client.connection;
  let live = connection.get() === "live";
  return Promise.resolve(
    connection.subscribe((state) => {
      const wasLive = live;
      live = state === "live";
      if (live && !wasLive) handler();
    }),
  );
}
