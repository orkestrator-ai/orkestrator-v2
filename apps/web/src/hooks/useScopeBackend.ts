import { backendApiForScope, type BackendClient } from "@/lib/backend/client";
import { backendForScope, type ScopeBackend } from "@/lib/backend/scope-backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

/**
 * Every `@/lib/backend` command function for the node this component renders
 * in (plan item 4007): the nearest `NodeScopeProvider`'s scope, or the app's
 * command scope outside one. On the command scope it is the `@/lib/backend`
 * module itself, so suites that mock it or spy on its exports still see the
 * call. Stable for a scope, so it can be a hook dependency.
 *
 * Read functions off it at call time (`api.getX(...)`), not by destructuring
 * during render, so a spy installed after render is still seen. The
 * `workspace-command-bound-call` source guard counts bare `@/lib/backend`
 * named exports inside a node's workspace.
 */
export function useScopeBackend(): ScopeBackend {
  return backendForScope(useScopesWithCommandFallback().scope);
}

/**
 * One `lib/backend` file's functions for the node this component renders in,
 * for files outside the `@/lib/backend` barrel (`graph-launch`, `graph-mock`,
 * …): `backendApiForScope(scope, create, command)`. Pass the file's
 * namespace (`import * as graphMock from "@/lib/backend/graph-mock"`) as
 * `command`, the command scope's answer.
 */
export function useScopeApi<A extends object, K extends keyof A>(
  create: (client: BackendClient) => A,
  command: Pick<A, K>,
): Pick<A, K> {
  return backendApiForScope(useScopesWithCommandFallback().scope, create, command);
}
