/**
 * The Claude tmux client of one node scope (plan item 4007).
 *
 * `claudeTmuxClientFor(scope)` sends a tab's tmux commands to its own node
 * and listens to that node's `claude-tmux:event` stream (`listenInScope`), so
 * a tmux tab in an in-tree leaf's workspace drives the leaf's tmux session and
 * sees the leaf's events. On the app's command scope it is the
 * `@/lib/claude-tmux-client` module itself, so suites that mock its named
 * exports keep seeing every call. Made once per scope, dropped with it.
 */

import { scopeBackendClient } from "@/lib/backend/client";
import * as commandTmux from "@/lib/claude-tmux-client";
import { claudeTmuxEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  createClaudeTmuxClient,
  type ClaudeTmuxClient,
  type TmuxEvent,
} from "@/lib/claude-tmux-client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { defineScopedSlot, isAppCommandScope, listenInScope } from "@/lib/node-scope-slots";

const scopeTmux = defineScopedSlot("claude-tmux-client", (scope): ClaudeTmuxClient =>
  createClaudeTmuxClient(scopeBackendClient(scope), (onEvent) =>
    // The definition pins each kind's routing fields; `TmuxEvent` is the
    // client's model of the same payload, delivered as sent.
    listenInScope(scope, claudeTmuxEvent, (payload) => onEvent(payload as TmuxEvent)),
  ),
);

/** `scope`'s node's tmux commands and events. */
export function claudeTmuxClientFor(scope: NodeScope): ClaudeTmuxClient {
  return isAppCommandScope(scope) ? commandTmux : scopeTmux(scope);
}

/**
 * The tmux client of the node this component renders in: the nearest
 * `NodeScopeProvider`'s, or the app's command scope outside one. Stable for
 * a scope, so it can be a hook dependency. Read functions off it at call
 * time, so a spy installed after render is still seen.
 */
export function useClaudeTmuxClient(): ClaudeTmuxClient {
  return claudeTmuxClientFor(useScopesWithCommandFallback().scope);
}
