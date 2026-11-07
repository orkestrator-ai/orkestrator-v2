/**
 * Per-node Zustand stores (report §7.2).
 *
 * A store module exports a definition instead of a singleton. Each node scope
 * creates its own instance on first use (`scope.store(def)`) and drops it when
 * the scope is disposed, so two nodes never share state:
 *
 * ```ts
 * export const environmentStore = defineScopedStore<EnvironmentState>(
 *   "environment",
 *   (scope) => (set, get) => ({
 *     environments: [],
 *     load: async (projectId) => {
 *       const list = await scope.client.invokeRaw<Environment[]>("list_environments", { projectId });
 *       set({ environments: list });
 *     },
 *   }),
 * );
 * // In components (reads the nearest NodeScopeProvider):
 * export const useEnvironmentStore = <U>(selector: (s: EnvironmentState) => U) =>
 *   useScopedStore(environmentStore, selector);
 * // Outside React the caller names its node:
 * scope.store(environmentStore).getState().load(projectId);
 * ```
 *
 * A creator that starts work of its own (a timer, a listener) registers its
 * stop with `scope.onDispose`, which runs when the scope ends (invariant 15).
 * Long-running work belongs in a scoped service instead.
 */

import { useStore } from "zustand";
import type { StateCreator } from "zustand/vanilla";
import type { NodeScope } from "./node-scope";
import { useNodeScope } from "./providers";

export interface ScopedStoreDef<S> {
  readonly kind: "scoped-store";
  /** Unique, bounded and stable: it names the store in logs, guards and baselines. */
  readonly name: string;
  create(scope: NodeScope): StateCreator<S>;
}

export function defineScopedStore<S>(
  name: string,
  create: (scope: NodeScope) => StateCreator<S>,
): ScopedStoreDef<S> {
  return Object.freeze({ kind: "scoped-store" as const, name, create });
}

/** Reads `def`'s instance in the nearest `NodeScopeProvider`'s scope. */
export function useScopedStore<S, U>(def: ScopedStoreDef<S>, selector: (state: S) => U): U {
  return useStore(useNodeScope().store(def), selector);
}
