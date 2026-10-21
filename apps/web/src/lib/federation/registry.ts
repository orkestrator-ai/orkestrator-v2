/**
 * The set of machine runtimes this renderer observes.
 *
 * One runtime per authorized machine, created from the connection layer's
 * list and disposed when the machine is forgotten or federation is turned
 * off. The machine this renderer is *bound* to is not a runtime here: its
 * full single-backend stores already exist in this realm, and the
 * aggregate views read them through an adapter rather than reading the
 * same backend twice.
 *
 * Lookups are by connection ID or proved backend ID. A missing destination
 * throws; nothing ever falls back to Local or to the first machine.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { BackendClient } from "./backend-client";
import { BackendRuntime, type SummaryPersistence } from "./backend-runtime";

export type BackendClientFactory = (connection: ConnectionSummary) => BackendClient | null;

export interface RegistryState {
  /** Bumped whenever the set of runtimes changes. */
  version: number;
  boundConnectionId: string | null;
  enabled: boolean;
}

export class BackendClientRegistry {
  readonly store: StoreApi<RegistryState> = createStore(() => ({
    version: 0,
    boundConnectionId: null as string | null,
    enabled: false,
  }));
  private readonly runtimes = new Map<string, BackendRuntime>();
  private readonly demandReleases = new Map<string, () => void>();

  constructor(
    private readonly createClient: BackendClientFactory,
    private readonly persistence: SummaryPersistence | null = null,
  ) {}

  /**
   * Reconcile with the connection layer. Every other saved machine gets a
   * runtime holding summary demand; each connects independently, so a slow
   * or offline machine never delays the others.
   */
  sync(list: ConnectionList, options: { enabled: boolean }): void {
    const boundConnectionId = list.activeConnectionId;
    const wanted = new Map<string, ConnectionSummary>();
    if (options.enabled) {
      for (const connection of list.connections) {
        if (connection.id === boundConnectionId) continue;
        if (connection.transport === "disabled" && connection.kind === "local") continue;
        // A machine the user set not to connect automatically stays saved but
        // is not observed until they turn it back on.
        if (connection.autoConnect === false) continue;
        wanted.set(connection.id, connection);
      }
    }
    let changed =
      this.store.getState().boundConnectionId !== boundConnectionId ||
      this.store.getState().enabled !== options.enabled;
    const saved = new Set(list.connections.map((connection) => connection.id));
    for (const [connectionId, runtime] of Array.from(this.runtimes)) {
      if (wanted.has(connectionId)) continue;
      this.demandReleases.get(connectionId)?.();
      this.demandReleases.delete(connectionId);
      // Forgotten on this device: drop its cached summaries. Merely hidden
      // (federation off, auto-connect off) keeps them for next time.
      if (!saved.has(connectionId)) runtime.forgetLastKnown();
      runtime.dispose();
      this.runtimes.delete(connectionId);
      changed = true;
    }
    for (const [connectionId, connection] of wanted) {
      const existing = this.runtimes.get(connectionId);
      if (existing) {
        existing.updateConnection(connection);
        continue;
      }
      const client = this.createClient(connection);
      if (!client) continue;
      const runtime = new BackendRuntime({ client, connection, persistence: this.persistence });
      this.runtimes.set(connectionId, runtime);
      this.demandReleases.set(connectionId, runtime.acquireSummaryDemand());
      changed = true;
    }
    if (changed) {
      this.store.setState((state) => ({
        version: state.version + 1,
        boundConnectionId,
        enabled: options.enabled,
      }));
    }
  }

  list(): BackendRuntime[] {
    return Array.from(this.runtimes.values());
  }

  get(connectionId: string): BackendRuntime | null {
    return this.runtimes.get(connectionId) ?? null;
  }

  /** The runtime for a proved or provisional backend identity. */
  require(backendId: BackendId): BackendRuntime {
    for (const runtime of this.runtimes.values()) {
      if (runtime.id === backendId) return runtime;
    }
    throw new Error(
      "That machine is not connected in this window. Reconnect it from Connections and try again.",
    );
  }

  dispose(): void {
    for (const release of this.demandReleases.values()) release();
    this.demandReleases.clear();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.store.setState((state) => ({ version: state.version + 1 }));
  }
}
