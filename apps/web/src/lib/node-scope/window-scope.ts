/**
 * What one renderer window owns regardless of which node it shows (report
 * §5.1): the node-qualified selection, the shared byte budgets, and the
 * registry of node scopes, exactly one of which is the command scope.
 *
 * The window's lifetime is the root Effect `Scope` of the tree; every node
 * scope is a child of it, so `dispose()` ends them all. The app has one
 * window scope (`getWindowScope()` in `app-window-scope.ts`); tests create
 * their own and dispose it in `afterEach`.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createWindowByteBudgets, type WindowByteBudgets } from "./byte-budget";
import { Lifetime } from "./lifetime";
import { NodeScope, type NodeScopeRole, type NodeScopeTier } from "./node-scope";
import { createSignal, type WritableSignal } from "./signal";

/**
 * A selection that says which node it belongs to, so a project or
 * environment id is never read against the wrong node. Not wired yet: the UI
 * store still owns today's selection until plan items 3006 and 3017 move it.
 */
export interface NodeSelection {
  readonly nodeId: BackendId;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}

export interface WindowScopeOptions {
  /** Totals in bytes; omitted kinds use `DEFAULT_WINDOW_BYTE_BUDGETS`. */
  readonly budgets?: Partial<Record<keyof WindowByteBudgets, number>>;
}

export interface OpenNodeScopeOptions {
  readonly role: NodeScopeRole;
  /** The scope's node is `client.nodeId`; the scope owns and disposes the client. */
  readonly client: NodeClient;
  readonly tier?: NodeScopeTier;
}

export class WindowScope {
  readonly budgets: WindowByteBudgets;
  readonly selection: ReadableSignal<NodeSelection | null>;
  /** Every open node scope, in opening order; a new array on each change. */
  readonly nodeScopes: ReadableSignal<readonly NodeScope[]>;

  private readonly lifetime = Lifetime.root("window");
  private readonly registry = new Map<BackendId, NodeScope>();
  private readonly selectionSignal: WritableSignal<NodeSelection | null>;
  private readonly scopesSignal: WritableSignal<readonly NodeScope[]>;

  constructor(options: WindowScopeOptions = {}) {
    this.budgets = createWindowByteBudgets(options.budgets);
    this.selectionSignal = createSignal<NodeSelection | null>(null);
    this.scopesSignal = createSignal<readonly NodeScope[]>([]);
    this.selection = this.selectionSignal;
    this.nodeScopes = this.scopesSignal;
  }

  get disposed(): boolean {
    return this.lifetime.closed;
  }

  /**
   * Opens a scope for `client`'s node. A node has at most one scope per
   * window, and a window at most one command scope.
   */
  open(options: OpenNodeScopeOptions): NodeScope {
    if (this.disposed) throw new Error("This window scope is disposed.");
    const nodeId = options.client.nodeId;
    if (this.registry.has(nodeId)) throw new Error(`A scope for ${nodeId} is already open.`);
    if (options.role === "command" && this.findCommandScope()) {
      throw new Error("This window already has a command scope.");
    }
    const scope = new NodeScope({
      role: options.role,
      client: options.client,
      tier: options.tier,
      parent: this.lifetime,
      budgets: this.budgets,
    });
    this.registry.set(nodeId, scope);
    // Runs after the scope's services have stopped and before its stores,
    // budgets and client are released, so nothing can look a closing scope up.
    scope.onDispose("window-registry", () => {
      if (this.registry.get(nodeId) !== scope) return;
      this.registry.delete(nodeId);
      this.publishScopes();
    });
    this.publishScopes();
    return scope;
  }

  get(nodeId: BackendId): NodeScope | null {
    return this.registry.get(nodeId) ?? null;
  }

  /** The scope of the node this window is connected to. Throws if none is open. */
  commandScope(): NodeScope {
    const scope = this.findCommandScope();
    if (!scope) throw new Error("This window has no command scope.");
    return scope;
  }

  select(selection: NodeSelection | null): void {
    this.selectionSignal.set(selection);
  }

  /** Disposes every node scope, then the window. Idempotent. */
  dispose(): void {
    this.lifetime.close();
  }

  private findCommandScope(): NodeScope | null {
    for (const scope of this.registry.values()) if (scope.role === "command") return scope;
    return null;
  }

  private publishScopes(): void {
    this.scopesSignal.set(Array.from(this.registry.values()));
  }
}
