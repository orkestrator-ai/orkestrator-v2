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
 * `scope.store(def)`, `scope.service(def)`, `scope.domain(def)`,
 * `scope.client.invoke(def, args)`. There is no ambient "current scope".
 *
 * `scope.domain(def)` (plan item 2011) is this node's version-adapted client
 * for one domain: built once per scope over `scope.client`, it picks its
 * adapter from the client's negotiated `domains` (and the hello's
 * `capabilities` for the legacy adapter) and picks again when a new
 * connection generation publishes new values. A reconnect that keeps them
 * (a node with no hello) resets the cached choice too, so a legacy adapter's
 * capability reads are not carried across a backend restart.
 *
 * The lifetime underneath is an Effect `Scope` (see `lifetime.ts`): the node
 * scope's lifetime is a child of the window's, and each running service has a
 * child of the node's, so disposal order and idempotence come from Effect.
 */

import {
  createDomainClient,
  type ApiOf,
  type DomainAdapterUsageRecorder,
  type DomainClient,
  type DomainClientDef,
} from "@orkestrator/protocol/contract/client";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { recordDomainAdapterUsage } from "@/lib/domain-adapter-usage-ring";
import { releaseNodeFromBudgets, renameNodeInBudgets, type WindowByteBudgets } from "./byte-budget";
import type { Lifetime } from "./lifetime";
import { PrefetchedCommandCache } from "./prefetched-command-cache";
import type {
  ScopedServiceDef,
  ScopedServiceHandle,
  ScopedServiceInstance,
  ScopedServiceStatus,
} from "./scoped-service";
import type { ScopedStoreDef } from "./scoped-store";
import { createSignal, type WritableSignal } from "./signal";
import { nodeDomainCall } from "./typed-invoke";

const log = createLogger("web.node-scope");

/** `command`: the node this window is connected to. `leaf`: any other node shown in-tree. */
export type NodeScopeRole = "command" | "leaf";

/**
 * The hydration tier (report §8.1). Only the window's lifecycle manager
 * (`WindowScope.lifecycle`, plan item 4002) moves a scope between tiers, and
 * only the scopes handed to it; the command scope is always `live`. A scope
 * the lifecycle disposes reads `summary` just before it goes.
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
  /** Counts calls through adapters below a domain's current version; defaults to the renderer ring. */
  readonly domainUsage?: DomainAdapterUsageRecorder;
}

interface ServiceRecord {
  status: ScopedServiceStatus;
  readonly handle: ScopedServiceHandle<ScopedServiceInstance>;
}

export class NodeScope {
  readonly role: NodeScopeRole;
  readonly client: NodeClient;
  /** The window-wide budgets; reserve with this scope's `nodeId`. Released on dispose. */
  readonly budgets: WindowByteBudgets;
  readonly tier: ReadableSignal<NodeScopeTier>;
  readonly health: ReadableSignal<NodeScopeHealth>;
  /**
   * Batched read answers in front of this node's commands (`invokeInScope`
   * consults it). Per scope because identical reads on two nodes differ;
   * cleared on dispose.
   */
  readonly prefetched = new PrefetchedCommandCache();

  private readonly lifetime: Lifetime;
  private readonly tierSignal: WritableSignal<NodeScopeTier>;
  private readonly healthSignal: WritableSignal<NodeScopeHealth>;
  private readonly stores = new Map<ScopedStoreDef<unknown>, StoreApi<unknown>>();
  private readonly storeNames = new Map<string, ScopedStoreDef<unknown>>();
  private readonly creating = new Set<ScopedStoreDef<unknown>>();
  private readonly services = new Map<ScopedServiceDef<ScopedServiceInstance>, ServiceRecord>();
  private readonly failedServices = new Set<string>();
  private readonly domainClients = new Map<DomainClientDef, DomainClient<unknown>>();
  private readonly domainUsage: DomainAdapterUsageRecorder;
  private stopWatchingGenerations: (() => void) | null = null;
  private currentNodeId: BackendId;
  /** Every id this scope has had; budgets are released under each on dispose. */
  private readonly formerNodeIds: BackendId[] = [];

  /** Use `WindowScope.open`, which registers the scope with its window. */
  constructor(init: NodeScopeInit) {
    this.currentNodeId = init.client.nodeId;
    this.domainUsage = init.domainUsage ?? recordDomainAdapterUsage;
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
    this.lifetime.onClose("budgets", () => {
      releaseNodeFromBudgets(this.budgets, this.nodeId);
      for (const former of this.formerNodeIds) releaseNodeFromBudgets(this.budgets, former);
    });
    this.lifetime.onClose("stores", () => {
      this.stores.clear();
      this.storeNames.clear();
      this.prefetched.clear();
    });
    this.lifetime.onClose("domains", () => {
      this.stopWatchingGenerations?.();
      this.stopWatchingGenerations = null;
      this.domainClients.clear();
    });
  }

  /**
   * The node's installation identity. Fixed for the scope's life, except
   * that a command scope opened under a provisional id moves to the id its
   * hello proves (`WindowScope.adoptCommandNodeId`).
   */
  get nodeId(): BackendId {
    return this.currentNodeId;
  }

  get disposed(): boolean {
    return this.lifetime.closed;
  }

  /**
   * This node's client for one domain (plan item 2011), created on first use
   * and kept for the scope's life. Call `api()` per use: it answers the
   * adapter for the current connection generation, and throws the coded
   * `unsupported-version` when the node's range has none.
   */
  domain<D extends DomainClientDef>(def: D): DomainClient<ApiOf<D>> {
    const existing = this.domainClients.get(def);
    if (existing) return existing as DomainClient<ApiOf<D>>;
    this.assertOpen(`domain ${def.domain.name}`);
    this.watchGenerations();
    const client = this.client;
    const created = createDomainClient(def as DomainClientDef<D["domain"], ApiOf<D>>, {
      call: nodeDomainCall(client),
      domains: () => client.domains.get(),
      capabilities: () => client.capabilities.get(),
      invoke: (command, args) => client.invokeRaw<unknown>(command, args),
      usage: this.domainUsage,
    });
    this.domainClients.set(def, created as DomainClient<unknown>);
    return created;
  }

  /** WindowScope only: the command scope learnt its proven id. */
  adoptNodeId(nodeId: BackendId): void {
    if (nodeId === this.currentNodeId) return;
    this.assertOpen("an identity change");
    const former = this.currentNodeId;
    this.formerNodeIds.push(former);
    this.currentNodeId = nodeId;
    renameNodeInBudgets(this.budgets, former, nodeId);
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

  /**
   * Resets every domain client's choice when the connection comes back after
   * a gap. New `domains` or `capabilities` objects already make them pick
   * again; this covers a reconnect that keeps them (a node with no hello).
   */
  private watchGenerations(): void {
    if (this.stopWatchingGenerations) return;
    let wasLive = this.client.connection.get() === "live";
    this.stopWatchingGenerations = this.client.connection.subscribe((state) => {
      const live = state === "live";
      if (live && !wasLive) for (const client of this.domainClients.values()) client.reset();
      wasLive = live;
    });
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
