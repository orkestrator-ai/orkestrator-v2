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

import type { DomainAdapterUsageRecorder } from "@orkestrator/protocol/contract/client";
import { isProvisionalBackendId, type BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createWindowByteBudgets, type WindowByteBudgets } from "./byte-budget";
import { ScopeLifecycle, type ScopeLifecycleDeps } from "./lifecycle";
import {
  lifecycleConfigFor,
  type LifecycleConfig,
  type LifecycleConfigOverrides,
} from "./lifecycle-config";
import { Lifetime } from "./lifetime";
import { NodeScope, type NodeScopeRole, type NodeScopeTier } from "./node-scope";
import { createSignal, type WritableSignal } from "./signal";

/**
 * A selection that says which node it belongs to, so a project or
 * environment id is never read against the wrong node. The window's one
 * selection (plan item 3006): its node is the node the window shows, and
 * each node scope's `uiStore` projects it (`stores/windowSelectionStore.ts`).
 */
export interface NodeSelection {
  readonly nodeId: BackendId;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  /** The environment is its project's home (the node knows it before summaries list it). */
  readonly projectHome?: boolean;
}

/** Whether two selections name the same node, project, environment and home flag. */
export function sameNodeSelection(a: NodeSelection | null, b: NodeSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.nodeId === b.nodeId &&
    a.projectId === b.projectId &&
    a.environmentId === b.environmentId &&
    Boolean(a.projectHome) === Boolean(b.projectHome)
  );
}

/** The window each open node scope belongs to. */
const windowOfScope = new WeakMap<NodeScope, WindowScope>();

/** The window `scope` was opened in, or `null` for a scope built outside one. */
export function windowScopeOf(scope: NodeScope): WindowScope | null {
  return windowOfScope.get(scope) ?? null;
}

export interface WindowScopeOptions {
  /**
   * Totals in bytes; omitted kinds use the host's lifecycle defaults
   * (`HOST_LIFECYCLE_DEFAULTS[host].byteBudgets`, which on desktop and in a
   * browser are `DEFAULT_WINDOW_BYTE_BUDGETS`).
   */
  readonly budgets?: Partial<Record<keyof WindowByteBudgets, number>>;
  /**
   * The node-scope lifecycle's per-host settings (plan item 4002): the host
   * (detected when omitted) and any of its defaults to override.
   */
  readonly lifecycle?: LifecycleConfigOverrides;
  /** The lifecycle's clock, heap reader, visibility and memory warnings; tests pass fakes. */
  readonly lifecycleDeps?: ScopeLifecycleDeps;
  /** Every scope's domain adapter usage recorder; defaults to the renderer ring. */
  readonly domainUsage?: DomainAdapterUsageRecorder;
}

export interface OpenNodeScopeOptions {
  readonly role: NodeScopeRole;
  /** The scope's node is `client.nodeId`; the scope owns and disposes the client. */
  readonly client: NodeClient;
  readonly tier?: NodeScopeTier;
}

export class WindowScope {
  readonly budgets: WindowByteBudgets;
  /** This window's per-host lifecycle settings (report §8.2). */
  readonly lifecycleConfig: LifecycleConfig;
  readonly selection: ReadableSignal<NodeSelection | null>;
  /** Every open node scope, in opening order; a new array on each change. */
  readonly nodeScopes: ReadableSignal<readonly NodeScope[]>;

  private readonly lifetime = Lifetime.root("window");
  private readonly registry = new Map<BackendId, NodeScope>();
  /**
   * Former ids of scopes that moved to a proven one: a value captured under
   * the provisional id before the hello answered still finds its scope.
   */
  private readonly aliases = new Map<BackendId, NodeScope>();
  private readonly domainUsage: DomainAdapterUsageRecorder | undefined;
  private readonly selectionSignal: WritableSignal<NodeSelection | null>;
  private readonly scopesSignal: WritableSignal<readonly NodeScope[]>;
  private readonly lifecycleDeps: ScopeLifecycleDeps;
  private lifecycleInstance: ScopeLifecycle | null = null;

  constructor(options: WindowScopeOptions = {}) {
    this.lifecycleConfig = lifecycleConfigFor(options.lifecycle);
    this.lifecycleDeps = options.lifecycleDeps ?? {};
    this.budgets = createWindowByteBudgets({
      ...this.lifecycleConfig.byteBudgets,
      ...options.budgets,
    });
    this.domainUsage = options.domainUsage;
    this.selectionSignal = createSignal<NodeSelection | null>(null);
    this.scopesSignal = createSignal<readonly NodeScope[]>([]);
    this.selection = this.selectionSignal;
    this.nodeScopes = this.scopesSignal;
    // Registered first, so it runs after every node scope has closed.
    this.lifetime.onClose("lifecycle", () => this.lifecycleInstance?.dispose());
  }

  get disposed(): boolean {
    return this.lifetime.closed;
  }

  /**
   * The window's node-scope lifecycle (plan item 4002, `lifecycle.ts`): tiers,
   * suspension timers and memory pressure for the scopes handed to it.
   * Created on first use; it runs nothing until a scope is managed.
   */
  get lifecycle(): ScopeLifecycle {
    if (this.disposed) throw new Error("This window scope is disposed.");
    this.lifecycleInstance ??= new ScopeLifecycle(this, this.lifecycleConfig, this.lifecycleDeps);
    return this.lifecycleInstance;
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
      ...(this.domainUsage ? { domainUsage: this.domainUsage } : {}),
    });
    this.registry.set(nodeId, scope);
    windowOfScope.set(scope, this);
    // Runs after the scope's services have stopped and before its stores,
    // budgets and client are released, so nothing can look a closing scope up.
    scope.onDispose("window-registry", () => {
      for (const [alias, aliased] of Array.from(this.aliases)) {
        if (aliased === scope) this.aliases.delete(alias);
      }
      if (this.registry.get(scope.nodeId) !== scope) return;
      this.registry.delete(scope.nodeId);
      this.publishScopes();
    });
    this.publishScopes();
    return scope;
  }

  /** The scope of `nodeId`, also by a command scope's former provisional id. */
  get(nodeId: BackendId): NodeScope | null {
    return this.registry.get(nodeId) ?? this.aliases.get(nodeId) ?? null;
  }

  /**
   * Moves a command scope opened under a provisional id to the installation
   * id its hello proved (plan item 2011): the registry, the byte budgets and
   * the selection follow, and the provisional id stays an alias, so a value
   * captured before the hello answered still finds the scope. Refused (false)
   * when the command scope's id is already proven, `nodeId` is provisional,
   * or another scope holds `nodeId`.
   */
  adoptCommandNodeId(nodeId: BackendId): boolean {
    const scope = this.findCommandScope();
    if (!scope || scope.disposed) return false;
    const former = scope.nodeId;
    if (former === nodeId) return true;
    if (!isProvisionalBackendId(former) || isProvisionalBackendId(nodeId)) return false;
    if (this.registry.has(nodeId)) return false;
    scope.adoptNodeId(nodeId);
    // Re-keyed in place, so `nodeScopes` keeps its opening order.
    const entries = Array.from(this.registry);
    this.registry.clear();
    for (const [id, open] of entries) this.registry.set(id === former ? nodeId : id, open);
    this.aliases.set(former, scope);
    const selection = this.selectionSignal.get();
    if (selection?.nodeId === former) this.selectionSignal.set({ ...selection, nodeId });
    this.publishScopes();
    return true;
  }

  /** The scope of the node this window is connected to. Throws if none is open. */
  commandScope(): NodeScope {
    const scope = this.findCommandScope();
    if (!scope) throw new Error("This window has no command scope.");
    return scope;
  }

  /**
   * Sets the window's selection. A value equal to the current one (same
   * node, project, environment and home flag) changes nothing and notifies
   * nobody.
   */
  select(selection: NodeSelection | null): void {
    if (sameNodeSelection(selection, this.selectionSignal.get())) return;
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
