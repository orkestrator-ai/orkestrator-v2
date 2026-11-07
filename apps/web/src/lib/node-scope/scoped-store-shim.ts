/**
 * The migration shim for converted stores (plan item 3001, report §7.3).
 *
 * A store converts to a `ScopedStoreDef` one at a time. Its hook keeps its
 * name and its call sites, and it keeps the zustand statics (`getState`,
 * `setState`, `subscribe`, `getInitialState`) as deprecated aliases that
 * resolve the app's **command scope**, which is the one backend every caller
 * meant before scopes existed:
 *
 * ```ts
 * export const claudeOptionsStore = defineScopedStore<ClaudeOptionsState>(
 *   "claude-options",
 *   () => (set, get) => ({ … }),
 * );
 * export const useClaudeOptionsStore = scopedStoreHook(claudeOptionsStore);
 *
 * useClaudeOptionsStore((state) => state.options[id]); // the nearest node scope
 * scope.store(claudeOptionsStore).getState();           // names its node
 * useClaudeOptionsStore.getState();                     // deprecated: the command scope
 * ```
 *
 * A static call made on behalf of another node silently reaches the command
 * node, so every one left is counted per store and file by the
 * `scoped-store-shim` source guard, whose baseline only falls
 * (`tests/source-guards/`). Each shim use also calls `noteShimUse`, which
 * does nothing until plan item 4004 installs the runtime guard.
 *
 * The recipe is in `docs/development/node-scopes.md`.
 */

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { getWindowScope } from "./app-window-scope";
import { useOptionalNodeScope } from "./providers";
import type { ScopedStoreDef } from "./scoped-store";

/** How the shim was reached: a deprecated static, or the hook with no node scope above it. */
export type ShimUseKind =
  "getState" | "setState" | "subscribe" | "getInitialState" | "hook-without-provider";

export interface ShimUse {
  /** The store def's name. */
  readonly store: string;
  readonly via: ShimUseKind;
}

export type ShimUseObserver = (use: ShimUse) => void;

let shimUseObserver: ShimUseObserver | null = null;

/**
 * Records one use of a store's command-scope shim. A no-op until plan item
 * 4004 installs an observer (it throws in development and tests while an
 * in-tree leaf is mounted, and records `node-scope.shim-under-leaf` in
 * production).
 */
export function noteShimUse(store: string, via: ShimUseKind): void {
  shimUseObserver?.({ store, via });
}

/**
 * Installs the observer `noteShimUse` reports to (`null` removes it) and
 * returns a function that restores the previous one. For plan item 4004 and
 * tests.
 */
export function setShimUseObserver(observer: ShimUseObserver | null): () => void {
  const previous = shimUseObserver;
  shimUseObserver = observer;
  return () => {
    shimUseObserver = previous;
  };
}

/** `def`'s instance in the app's command scope: what the deprecated statics use. */
export function commandScopeStore<S>(def: ScopedStoreDef<S>): StoreApi<S> {
  return getWindowScope().commandScope().store(def);
}

/** A converted store's hook: reads the nearest node scope, plus the deprecated statics. */
export interface ScopedStoreHook<S> {
  (): S;
  <U>(selector: (state: S) => U): U;
  /** The store's definition, for `scope.store(def)`. */
  readonly def: ScopedStoreDef<S>;
  /**
   * @deprecated The command scope's state. Name the node instead:
   * `scope.store(def).getState()`. Counted by the `scoped-store-shim` guard.
   */
  getState: StoreApi<S>["getState"];
  /**
   * @deprecated Sets the command scope's state. Name the node instead:
   * `scope.store(def).setState(...)`. Counted by the `scoped-store-shim` guard.
   */
  setState: StoreApi<S>["setState"];
  /**
   * @deprecated Subscribes to the command scope's instance as it is now (a
   * later window scope is not followed). Name the node instead:
   * `scope.store(def).subscribe(...)`. Counted by the `scoped-store-shim` guard.
   */
  subscribe: StoreApi<S>["subscribe"];
  /**
   * @deprecated The command scope's initial state. Name the node instead:
   * `scope.store(def).getInitialState()`. Counted by the `scoped-store-shim` guard.
   */
  getInitialState: StoreApi<S>["getInitialState"];
}

/**
 * The hook for a converted store, keeping the zustand hook's shape so call
 * sites do not change.
 *
 * Inside a `NodeScopeProvider` it reads that scope's instance, exactly as
 * `useScopedStore(def, selector)`. Outside one it reads the command scope's
 * instance in every mode, and notes a shim use, where `useScopedStore` would
 * throw in development and tests: components that render a converted store
 * without a provider in their tests keep working until their store item moves
 * those tests to `renderInNodeScope`. After that, the item may switch the
 * hook to `useScopedStore`.
 */
export function scopedStoreHook<S>(def: ScopedStoreDef<S>): ScopedStoreHook<S> {
  const identity = (state: S) => state;
  function useConvertedStore<U>(selector?: (state: S) => U): U {
    const scope = useOptionalNodeScope();
    if (!scope) noteShimUse(def.name, "hook-without-provider");
    const store = (scope ?? getWindowScope().commandScope()).store(def);
    // With no selector, U is S (the overload `(): S`).
    return useStore(store, (selector ?? identity) as (state: S) => U);
  }
  return Object.assign(useConvertedStore, {
    def,
    getState: () => {
      noteShimUse(def.name, "getState");
      return commandScopeStore(def).getState();
    },
    setState: ((partial: Parameters<StoreApi<S>["setState"]>[0], replace?: boolean) => {
      noteShimUse(def.name, "setState");
      // zustand's overloads tie `replace: true` to a full state; pass both through as given.
      const setState = commandScopeStore(def).setState as (
        next: typeof partial,
        replace?: boolean,
      ) => void;
      setState(partial, replace);
    }) as StoreApi<S>["setState"],
    subscribe: (listener: Parameters<StoreApi<S>["subscribe"]>[0]) => {
      noteShimUse(def.name, "subscribe");
      return commandScopeStore(def).subscribe(listener);
    },
    getInitialState: () => {
      noteShimUse(def.name, "getInitialState");
      return commandScopeStore(def).getInitialState();
    },
  }) as ScopedStoreHook<S>;
}
