import {
  previewErrorFromUnknown,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";
import { previewServicesChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { PayloadOf } from "@orkestrator/protocol/contract/event";

import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createPreviewsApi } from "@/lib/backend/previews";
import { resolveGatewayBrowserPreviewUrl } from "@/lib/gateway-url";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { commandTransportAvailable } from "@/lib/node-scope/command-client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, isAppCommandScope } from "@/lib/node-scope-slots";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";

export interface EnvironmentPreviewState {
  snapshot: PreviewRegistrySnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface PreviewServiceStoreState {
  /** Every backend in the support window has preview services; any failure is `error`. */
  status: "idle" | "loading" | "ready" | "error";
  capabilities: PreviewCapabilities | null;
  error: string | null;
  environments: Record<string, EnvironmentPreviewState>;
  loadCapabilities(options?: { force?: boolean }): Promise<PreviewCapabilities | null>;
  refreshEnvironment(
    environmentId: string,
    options?: { force?: boolean },
  ): Promise<PreviewRegistrySnapshot | null>;
  /** An unconditional snapshot requested after any work already in progress. */
  confirmEnvironment(environmentId: string): Promise<PreviewRegistrySnapshot>;
  handleChanged(event: PayloadOf<typeof previewServicesChangedEvent>): void;
  service(environmentId: string, serviceId: string): PreviewServiceSnapshot | null;
  /**
   * The address a preview frame loads for a loopback page on this store's
   * node: the node client's preview URL (a leaf's goes through its relay,
   * plan item 2004), or the window gateway's on the command node.
   */
  resolvePreviewUrl(url: string): string;
  reset(): void;
}

/** A node client that can address its own preview frames (a leaf's, plan item 2004). */
interface PreviewUrlClient {
  resolvePreviewUrl(url: string): string;
}

function hasPreviewUrls(client: unknown): client is PreviewUrlClient {
  return typeof (client as Partial<PreviewUrlClient> | null)?.resolvePreviewUrl === "function";
}

/**
 * Renderer cache of backend preview snapshots. The backend registry is the
 * only owner; this store never invents or persists service state. It is keyed
 * by backend identity and epoch, and results that arrive after a backend
 * switch (a different identity or a reset) are discarded. Per node (plan item
 * 3012): each node scope reads its own node's registry.
 */
export const previewServiceStore = defineScopedStore<PreviewServiceStoreState>(
  "preview-service",
  (scope) => (set, get) => {
    /** The scope's node's preview commands (the named exports on the app's command scope). */
    const api = () => backendApiForScope(scope, createPreviewsApi, backend);
    let generation = 0;
    let capabilitiesRequest: Promise<PreviewCapabilities | null> | null = null;
    const inflight = new Map<string, Promise<PreviewRegistrySnapshot | null>>();
    const stale = new Set<string>();
    /** Environments whose in-flight request has already been sent to the backend. */
    const sent = new Set<string>();

    const setEnvironment = (environmentId: string, patch: Partial<EnvironmentPreviewState>) =>
      set((state) => {
        const current: EnvironmentPreviewState | undefined = state.environments[environmentId];
        return {
          environments: {
            ...state.environments,
            [environmentId]: {
              ...(current ?? { snapshot: null, loading: false, error: null }),
              ...patch,
            },
          },
        };
      });

    return {
      status: "idle",
      capabilities: null,
      error: null,
      environments: {},

      loadCapabilities: ({ force = false } = {}) => {
        if (!force && get().status === "ready") return Promise.resolve(get().capabilities);
        if (capabilitiesRequest && !force) return capabilitiesRequest;
        const requestGeneration = generation;
        set({ status: get().capabilities ? get().status : "loading" });
        const request = api()
          .getPreviewCapabilities()
          .then((capabilities) => {
            if (requestGeneration !== generation) return get().capabilities;
            // A malformed answer is a failure, not an old backend and not support.
            if (
              !capabilities ||
              typeof capabilities !== "object" ||
              typeof capabilities.backendInstanceId !== "string"
            ) {
              set({
                status: "error",
                error: "The backend returned malformed preview capabilities.",
              });
              return null;
            }
            const previous = get().capabilities;
            // A different backend identity or epoch invalidates every cached snapshot.
            if (
              previous &&
              (previous.backendInstanceId !== capabilities.backendInstanceId ||
                previous.backendEpoch !== capabilities.backendEpoch)
            ) {
              generation += 1;
              inflight.clear();
              sent.clear();
              set({ environments: {} });
            }
            set({ status: "ready", capabilities, error: null });
            return capabilities;
          })
          .catch((error: unknown) => {
            if (requestGeneration !== generation) return get().capabilities;
            set({
              status: "error",
              error: previewErrorFromUnknown(error)?.message ?? "Preview services are unavailable.",
            });
            return null;
          })
          .finally(() => {
            if (capabilitiesRequest === request) capabilitiesRequest = null;
          });
        capabilitiesRequest = request;
        return request;
      },

      refreshEnvironment: (environmentId, { force = false } = {}) => {
        const pending = inflight.get(environmentId);
        if (pending) {
          // Coalesce, but remember that a change arrived during the fetch. A
          // caller that arrives before the fetch is sent is already covered.
          if (sent.has(environmentId)) stale.add(environmentId);
          return pending;
        }
        const fetchSnapshot = async (): Promise<PreviewRegistrySnapshot | null> => {
          const capabilities = await get().loadCapabilities();
          if (!capabilities) return null;
          const requestGeneration = generation;
          const current = get().environments[environmentId]?.snapshot ?? null;
          setEnvironment(environmentId, { loading: current === null });
          if (inflight.get(environmentId) === request) sent.add(environmentId);
          try {
            const snapshot = await api().getPreviewServices(
              environmentId,
              !force && current
                ? { backendEpoch: current.backendEpoch, registryRevision: current.registryRevision }
                : undefined,
            );
            if (requestGeneration !== generation) return null;
            if (
              snapshot.backendInstanceId !== capabilities.backendInstanceId ||
              snapshot.backendEpoch !== capabilities.backendEpoch
            ) {
              // The backend restarted between calls: capabilities are stale too.
              void get().loadCapabilities({ force: true });
            }
            const next =
              snapshot.notModified && current
                ? { ...current, registryRevision: snapshot.registryRevision }
                : snapshot;
            // Never let an older answer from the same backend epoch replace a
            // newer snapshot that was stored while this one was in flight.
            const latest = get().environments[environmentId]?.snapshot ?? null;
            if (
              latest &&
              latest.backendInstanceId === next.backendInstanceId &&
              latest.backendEpoch === next.backendEpoch &&
              latest.registryRevision > next.registryRevision
            ) {
              setEnvironment(environmentId, { loading: false, error: null });
              return latest;
            }
            setEnvironment(environmentId, { snapshot: next, loading: false, error: null });
            return next;
          } catch (error: unknown) {
            if (requestGeneration === generation) {
              setEnvironment(environmentId, {
                loading: false,
                error:
                  previewErrorFromUnknown(error)?.message ?? "Could not load preview services.",
              });
            }
            return null;
          }
        };
        // Registered before the first await so same-tick callers coalesce onto it.
        const request: Promise<PreviewRegistrySnapshot | null> = fetchSnapshot().finally(() => {
          // A backend switch may have replaced this entry; the newer request owns it.
          if (inflight.get(environmentId) !== request) return;
          inflight.delete(environmentId);
          sent.delete(environmentId);
          if (stale.delete(environmentId)) void get().refreshEnvironment(environmentId);
        });
        inflight.set(environmentId, request);
        return request;
      },

      confirmEnvironment: async (environmentId) => {
        const requestGeneration = generation;
        // Drain coalesced work (including event-triggered follow-ups) before
        // starting the unconditional request owned by this confirmation.
        while (inflight.has(environmentId)) {
          await inflight.get(environmentId);
          if (generation !== requestGeneration) throw new Error("The preview backend changed.");
        }
        const snapshot = await get().refreshEnvironment(environmentId, { force: true });
        if (generation !== requestGeneration || !snapshot || snapshot.notModified)
          throw new Error(
            get().environments[environmentId]?.error ?? "Could not check preview services.",
          );
        return snapshot;
      },

      handleChanged: (event) => {
        const capabilities = get().capabilities;
        if (!capabilities) return;
        if (event.backendInstanceId !== capabilities.backendInstanceId) return;
        if (event.backendEpoch !== capabilities.backendEpoch) {
          void get()
            .loadCapabilities({ force: true })
            .then(() => {
              for (const environmentId of Object.keys(get().environments))
                void get().refreshEnvironment(environmentId, { force: true });
            });
          return;
        }
        for (const environmentId of event.environmentIds) {
          const cached = get().environments[environmentId]?.snapshot;
          // Only environments someone has looked at are kept warm.
          if (!cached || cached.registryRevision >= event.registryRevision) continue;
          void get().refreshEnvironment(environmentId);
        }
      },

      service: (environmentId, serviceId) =>
        get().environments[environmentId]?.snapshot?.services.find(
          (service) => service.definition.serviceId === serviceId,
        ) ?? null,

      resolvePreviewUrl: (url) =>
        hasPreviewUrls(scope.client)
          ? scope.client.resolvePreviewUrl(url)
          : resolveGatewayBrowserPreviewUrl(url),

      reset: () => {
        generation += 1;
        inflight.clear();
        sent.clear();
        stale.clear();
        capabilitiesRequest = null;
        set({ status: "idle", capabilities: null, error: null, environments: {} });
      },
    };
  },
);

/**
 * Reads the nearest node scope's preview snapshots; other code uses
 * `scope.store(previewServiceStore)`.
 */
export const usePreviewServiceStore = scopedStoreHook(previewServiceStore);

/** One node's change subscription; stopped when its scope is disposed. */
interface PreviewServiceSync {
  stops: Array<() => void>;
}

const previewServiceSync = defineScopedSlot<PreviewServiceSync>("preview-service-sync", (scope) => {
  const sync: PreviewServiceSync = { stops: [] };
  scope.onDispose("preview-service-sync", () => {
    for (const stop of sync.stops.splice(0)) stop();
  });
  return sync;
});

/**
 * Subscribe once per node scope (the app's command scope when omitted),
 * before any snapshot is fetched, so an invalidation that lands during a
 * fetch is not lost. A reconnected event stream refetches everything: events
 * are hints, snapshots are authoritative.
 */
export function ensurePreviewServiceSync(scope: NodeScope = appCommandScope()): void {
  if (scope.disposed) return;
  // The app's command scope listens through the window host, which a page
  // without a backend transport (some tests, a static preview) lacks.
  if (isAppCommandScope(scope) && !commandTransportAvailable()) return;
  const sync = previewServiceSync(scope);
  if (sync.stops.length > 0) return;
  const store = scope.store(previewServiceStore);
  const client = scope.client;
  sync.stops.push(
    client.listen(previewServicesChangedEvent, (event) => {
      store.getState().handleChanged(event);
    }),
    client.listenRaw(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      void store
        .getState()
        .loadCapabilities({ force: true })
        .then(() => {
          for (const environmentId of Object.keys(store.getState().environments)) {
            void store.getState().refreshEnvironment(environmentId, { force: true });
          }
        });
    }),
  );
}

/** Test seam: stops `scope`'s subscription and empties its store (default the command scope). */
export function resetPreviewServiceSyncForTests(scope: NodeScope = appCommandScope()): void {
  for (const stop of previewServiceSync(scope).stops.splice(0)) stop();
  scope.store(previewServiceStore).getState().reset();
}
