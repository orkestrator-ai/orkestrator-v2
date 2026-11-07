/**
 * One node as this window sees it (report §5.1): its client, its lazily
 * created store instances, its running services and its lifecycle tier.
 *
 * Scopes are opened by `WindowScope.open` and live outside React: a provider
 * only says which scope a subtree reads, and unmounting it never disposes one
 * (invariant 2). `dispose()` is the explicit end: it stops every service,
 * drops every store instance, releases the node's byte-budget reservations
 * and disposes the client, in that order.
 *
 * Code that is not a component must hold a scope explicitly (decision 13.2 B):
 * `scope.store(def)`, `scope.service(def)`, `scope.client.invokeRaw(...)`.
 * There is no ambient "current scope".
 *
 * The lifetime underneath is an Effect `Scope` (see `lifetime.ts`): the node
 * scope's lifetime is a child of the window's, and each running service has a
 * child of the node's, so disposal order and idempotence come from Effect.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { releaseNodeFromBudgets, type WindowByteBudgets } from "./byte-budget";
import type { Lifetime } from "./lifetime";
import type {
  ScopedServiceDef,
  ScopedServiceHandle,
  ScopedServiceInstance,
  ScopedServiceStatus,
} from "./scoped-service";
import type { ScopedStoreDef } from "./scoped-store";
import { createSignal, type WritableSignal } from "./signal";

const log = createLogger("web.node-scope");

/** `command`: the node this window is connected to. `leaf`: any other node shown in-tree. */
export type NodeScopeRole = "command" | "leaf";

/**
 * The hydration tier (report §8.1). Only the lifecycle manager (plan item
 * 4002) moves a scope between tiers; until then the command scope is the
 * only scope and is always `live`.
 */
export type NodeScopeTier = "summary" | "warm" | "live" | "suspended";

/**
 * `failed` names the services that failed; starting them again clears it
 * (report §10.3: failed scopes are retryable).
 */
export type NodeScopeHealth =
  | { readonly state: "ok" }
  | { readonly state: "failed"; readonly failedServices: readonly string[] }
  | { readonly state: "disposed" };

const HEALTH_OK: NodeScopeHealth = Object.freeze({ state: "ok" });
const HEALTH_DISPOSED: NodeScopeHealth = Object.freeze({ state: "disposed" });

export interface NodeScopeInit {
  readonly role: NodeScopeRole;
  /** Owned by the scope from now on: `dispose()` disposes it. */
  readonly client: NodeClient;
  readonly tier?: NodeScopeTier;
  /** The window's lifetime; the scope's own is a child of it. */
  readonly parent: Lifetime;
  readonly budgets: WindowByteBudgets;
}

interface ServiceRecord {
  status: ScopedServiceStatus;
  readonly handle: ScopedServiceHandle<ScopedServiceInstance>;
}

export class NodeScope {
  readonly nodeId: BackendId;
  readonly role: NodeScopeRole;
  readonly client: NodeClient;
  /** The window-wide budgets; reserve with this scope's `nodeId`. Released on dispose. */
  readonly budgets: WindowByteBudgets;
  readonly tier: ReadableSignal<NodeScopeTier>;
  readonly health: ReadableSignal<NodeScopeHealth>;

  private readonly lifetime: Lifetime;
  private readonly tierSignal: WritableSignal<NodeScopeTier>;
  private readonly healthSignal: WritableSignal<NodeScopeHealth>;
  private readonly stores = new Map<ScopedStoreDef<unknown>, StoreApi<unknown>>();
  private readonly storeNames = new Map<string, ScopedStoreDef<unknown>>();
  private readonly creating = new Set<ScopedStoreDef<unknown>>();
  private readonly services = new Map<ScopedServiceDef<ScopedServiceInstance>, ServiceRecord>();
  private readonly failedServices = new Set<string>();

  /** Use `WindowScope.open`, which registers the scope with its window. */
  constructor(init: NodeScopeInit) {
    this.nodeId = init.client.nodeId;
    this.role = init.role;
    this.client = init.client;
    this.budgets = init.budgets;
    this.tierSignal = createSignal<NodeScopeTier>(init.tier ?? "live");
    this.healthSignal = createSignal<NodeScopeHealth>(HEALTH_OK);
    this.tier = this.tierSignal;
    this.health = this.healthSignal;
    this.lifetime = init.parent.child(`node:${init.role}`);

    // Finalizers run in reverse: services (child lifetimes) and anything
    // registered later first, then stores, budgets, the client, and health.
    this.lifetime.onClose("health", () => this.healthSignal.set(HEALTH_DISPOSED));
    this.lifetime.onClose("client", () => this.client.dispose());
    this.lifetime.onClose("budgets", () => releaseNodeFromBudgets(this.budgets, this.nodeId));
    this.lifetime.onClose("stores", () => {
      this.stores.clear();
      this.storeNames.clear();
    });
  }

  get disposed(): boolean {
    return this.lifetime.closed;
  }

  /**
   * This scope's instance of `def`, created on first use. Throws once the
   * scope is disposed, so a late caller cannot resurrect state.
   */
  store<S>(def: ScopedStoreDef<S>): StoreApi<S> {
    const key = def as ScopedStoreDef<unknown>;
    const existing = this.stores.get(key);
    if (existing) return existing as StoreApi<S>;
    this.assertOpen(`store ${def.name}`);
    const sameName = this.storeNames.get(def.name);
    if (sameName && sameName !== key) {
      throw new Error(`Two scoped store definitions are both named ${def.name}.`);
    }
    if (this.creating.has(key)) {
      throw new Error(`Scoped store ${def.name} reads itself while it is being created.`);
    }
    this.creating.add(key);
    try {
      const store = createStore<S>()(def.create(this));
      this.stores.set(key, store as StoreApi<unknown>);
      this.storeNames.set(def.name, key);
      return store;
    } finally {
      this.creating.delete(key);
    }
  }

  /**
   * Starts `def` for this scope unless it is already running, and returns its
   * handle. See `scoped-service.ts` for the lifecycle and failure rules.
   */
  service<A extends ScopedServiceInstance>(def: ScopedServiceDef<A>): ScopedServiceHandle<A> {
    const key = def as unknown as ScopedServiceDef<ScopedServiceInstance>;
    const existing = this.services.get(key);
    if (existing?.status === "running") return existing.handle as ScopedServiceHandle<A>;
    this.assertOpen(`service ${def.name}`);
    if (this.failedServices.delete(def.name)) this.publishHealth();
    return this.startService(def, key);
  }

  /** Runs `finalizer` when the scope is disposed, before its stores are dropped. */
  onDispose(name: string, finalizer: () => void): void {
    this.lifetime.onClose(name, finalizer);
  }

  /** Lifecycle manager only (plan item 4002). */
  setTier(tier: NodeScopeTier): void {
    this.assertOpen("a tier change");
    this.tierSignal.set(tier);
  }

  /** Stops services, drops stores, releases budgets, disposes the client. Idempotent. */
  dispose(): void {
    this.lifetime.close();
  }

  private startService<A extends ScopedServiceInstance>(
    def: ScopedServiceDef<A>,
    key: ScopedServiceDef<ScopedServiceInstance>,
  ): ScopedServiceHandle<A> {
    const lifetime = this.lifetime.child(`service:${def.name}`);
    const controller = new AbortController();
    let instance: A | null = null;
    const record: ServiceRecord = {
      status: "running",
      handle: {
        name: def.name,
        get status() {
          return record.status;
        },
        get instance() {
          return instance;
        },
        signal: controller.signal,
        stop: () => {
          if (record.status !== "running") return;
          record.status = "stopped";
          lifetime.close();
        },
      },
    };
    this.services.set(key, record);

    // Registered first, so it runs last: the service's own stop sees an
    // unaborted signal, then in-flight work is cancelled.
    lifetime.onClose("abort", () => controller.abort());
    lifetime.onClose("status", () => {
      if (record.status === "running") record.status = "stopped";
    });

    const fail = (error: unknown) => {
      if (record.status !== "running") return;
      record.status = "failed";
      log.warn("service.failed", {
        service: def.name,
        role: this.role,
        error: logErrorKind(error),
      });
      this.failedServices.add(def.name);
      this.publishHealth();
      lifetime.close();
    };

    try {
      instance = def.start(this, controller.signal);
    } catch (error) {
      fail(error);
      return record.handle as ScopedServiceHandle<A>;
    }
    const started = instance;
    // On a lifetime that already ended (the service stopped itself during
    // start) this runs at once, so the stop is never lost.
    lifetime.onClose("stop", () => {
      if (typeof started?.stop === "function") started.stop();
    });
    if (started?.done) {
      Promise.resolve(started.done).catch((error: unknown) => {
        if (!controller.signal.aborted) fail(error);
      });
    }
    return record.handle as ScopedServiceHandle<A>;
  }

  private publishHealth(): void {
    if (this.disposed) return;
    this.healthSignal.set(
      this.failedServices.size === 0
        ? HEALTH_OK
        : { state: "failed", failedServices: Array.from(this.failedServices).sort() },
    );
  }

  private assertOpen(what: string): void {
    if (this.disposed) {
      throw new Error(`The ${this.role} scope for ${this.nodeId} is disposed; ${what} is refused.`);
    }
  }
}
