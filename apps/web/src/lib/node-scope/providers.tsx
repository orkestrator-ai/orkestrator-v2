/**
 * React access to scopes (decision 13.2 B: an explicit scope handle for
 * plain code, plus context for hooks).
 *
 * ```tsx
 * <WindowScopeProvider>
 *   <CommandNodeScopeProvider>
 *     <AppShell />                       // useNodeScope() is the command scope
 *     <NodeScopeProvider nodeId={shown}>  // a leaf, later (plan item 4001)
 *       <Workspace />
 *     </NodeScopeProvider>
 *   </CommandNodeScopeProvider>
 * </WindowScopeProvider>
 * ```
 *
 * Providers only choose which scope a subtree reads; mounting one never opens
 * a scope and unmounting never disposes one (invariant 2). Scopes are opened
 * and disposed through `WindowScope`.
 *
 * Outside a provider, `useNodeScope()` and `useWindowScope()` throw in
 * development and tests, so a component that forgot its provider fails
 * loudly; in production they fall back to the app's window and command scope,
 * which is today's behaviour.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type { ReadableSignal } from "@orkestrator/protocol/node-client";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { getWindowScope } from "./app-window-scope";
import type { NodeScope } from "./node-scope";
import type { WindowScope } from "./window-scope";

const WindowScopeContext = createContext<WindowScope | null>(null);
const NodeScopeContext = createContext<NodeScope | null>(null);

function strictScopeChecks(): boolean {
  // Vite sets DEV and MODE; under `bun test`, import.meta.env is process.env.
  const env = import.meta.env as unknown as Record<string, unknown> | undefined;
  return env?.DEV === true || env?.MODE === "test" || env?.NODE_ENV === "test";
}

export function WindowScopeProvider({
  windowScope,
  children,
}: {
  /** Defaults to the app's window scope (`getWindowScope()`). */
  windowScope?: WindowScope;
  children: ReactNode;
}) {
  return (
    <WindowScopeContext.Provider value={windowScope ?? getWindowScope()}>
      {children}
    </WindowScopeContext.Provider>
  );
}

/**
 * Supplies the scope of `nodeId` from the nearest window scope, or `scope`
 * directly. Throws if the window has no scope for `nodeId`; the caller opens
 * it first.
 */
export function NodeScopeProvider(
  props: { children: ReactNode } & (
    { nodeId: BackendId; scope?: never } | { scope: NodeScope; nodeId?: never }
  ),
) {
  const windowScope = useWindowScope();
  // Re-render when scopes open or close, so a reopened node is picked up.
  useSignal(windowScope.nodeScopes);
  const scope = props.scope ?? windowScope.get(props.nodeId);
  if (!scope) throw new Error(`No node scope is open for ${props.nodeId}.`);
  return <NodeScopeContext.Provider value={scope}>{props.children}</NodeScopeContext.Provider>;
}

/** Supplies the nearest window scope's command scope. */
export function CommandNodeScopeProvider({ children }: { children: ReactNode }) {
  const windowScope = useWindowScope();
  useSignal(windowScope.nodeScopes);
  return (
    <NodeScopeContext.Provider value={windowScope.commandScope()}>
      {children}
    </NodeScopeContext.Provider>
  );
}

export function useWindowScope(): WindowScope {
  const windowScope = useContext(WindowScopeContext);
  if (windowScope) return windowScope;
  if (strictScopeChecks()) throw new Error("useWindowScope() needs a WindowScopeProvider.");
  return getWindowScope();
}

export function useNodeScope(): NodeScope {
  const scope = useContext(NodeScopeContext);
  if (scope) return scope;
  if (strictScopeChecks()) {
    throw new Error(
      "useNodeScope() needs a NodeScopeProvider; in tests render with renderInNodeScope.",
    );
  }
  return getWindowScope().commandScope();
}

/**
 * The nearest `NodeScopeProvider`'s scope, or `null` outside one, in every
 * mode. For the converted-store shim (`scopedStoreHook`, plan item 3001),
 * which must know when it falls back to the command scope; new code uses
 * `useNodeScope()`.
 */
export function useOptionalNodeScope(): NodeScope | null {
  return useContext(NodeScopeContext);
}

/**
 * The nearest window and node scope without the strict check: outside a
 * provider they are the app's window scope and its command scope, in every
 * mode. Only for window-level stores whose producers and readers still render
 * in trees with no provider (plan item 3017: dialogs, merge PR, scroll
 * targets, the host path picker); new code uses `useNodeScope()`.
 */
export function useScopesWithCommandFallback(): { windowScope: WindowScope; scope: NodeScope } {
  const windowScope = useWindowScopeWithFallback();
  const scope = useContext(NodeScopeContext);
  return { windowScope, scope: scope ?? windowScope.commandScope() };
}

/**
 * The nearest window scope, or the app's outside a provider, in every mode,
 * without requiring a command scope. For window-level readers that render in
 * trees with no provider (the sidebar's machine views, plan item 5007).
 */
export function useWindowScopeWithFallback(): WindowScope {
  return useContext(WindowScopeContext) ?? getWindowScope();
}

/** Reads a signal and re-renders when it changes. */
export function useSignal<T>(signal: ReadableSignal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get, signal.get);
}
