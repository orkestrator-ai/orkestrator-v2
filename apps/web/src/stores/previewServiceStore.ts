import { create } from "zustand";

import {
  isUnknownPreviewCommandError,
  PREVIEW_SERVICES_CHANGED_EVENT,
  previewErrorFromUnknown,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServicesChangedEvent,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";

import * as backend from "@/lib/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";

export interface EnvironmentPreviewState {
  snapshot: PreviewRegistrySnapshot | null;
  loading: boolean;
  error: string | null;
}

interface PreviewServiceStoreState {
  /**
   * `unsupported` means the backend specifically reported the preview commands
   * as unknown (an older backend). Network or auth failures are `error`.
   */
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  capabilities: PreviewCapabilities | null;
  error: string | null;
  environments: Record<string, EnvironmentPreviewState>;
  loadCapabilities(options?: { force?: boolean }): Promise<PreviewCapabilities | null>;
  refreshEnvironment(
    environmentId: string,
    options?: { force?: boolean },
  ): Promise<PreviewRegistrySnapshot | null>;
  handleChanged(event: PreviewServicesChangedEvent): void;
  service(environmentId: string, serviceId: string): PreviewServiceSnapshot | null;
  reset(): void;
}

/**
 * Renderer cache of backend preview snapshots. The backend registry is the
 * only owner; this store never invents or persists service state. It is keyed
 * by backend identity and epoch, and results that arrive after a backend
 * switch (a different identity or a reset) are discarded.
 */
export const usePreviewServiceStore = create<PreviewServiceStoreState>((set, get) => {
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
      if (!force && get().status === "unsupported") return Promise.resolve(null);
      if (capabilitiesRequest && !force) return capabilitiesRequest;
      const requestGeneration = generation;
      set({ status: get().capabilities ? get().status : "loading" });
      const request = backend
        .getPreviewCapabilities()
        .then((capabilities) => {
          if (requestGeneration !== generation) return get().capabilities;
          // A malformed answer is a failure, not an old backend and not support.
          if (
            !capabilities ||
            typeof capabilities !== "object" ||
            typeof capabilities.backendInstanceId !== "string"
          ) {
            set({ status: "error", error: "The backend returned malformed preview capabilities." });
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
          if (isUnknownPreviewCommandError(error)) {
            set({ status: "unsupported", capabilities: null, error: null });
          } else {
            set({
              status: "error",
              error: previewErrorFromUnknown(error)?.message ?? "Preview services are unavailable.",
            });
          }
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
          const snapshot = await backend.getPreviewServices(
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
              error: previewErrorFromUnknown(error)?.message ?? "Could not load preview services.",
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

    reset: () => {
      generation += 1;
      inflight.clear();
      sent.clear();
      stale.clear();
      capabilitiesRequest = null;
      set({ status: "idle", capabilities: null, error: null, environments: {} });
    },
  };
});

let syncStarted = false;

/**
 * Subscribe once, before any snapshot is fetched, so an invalidation that lands
 * during a fetch is not lost. A reconnected event stream refetches everything:
 * events are hints, snapshots are authoritative.
 */
export function ensurePreviewServiceSync(): void {
  if (syncStarted || typeof window === "undefined" || !window.orkestrator?.listen) return;
  syncStarted = true;
  window.orkestrator.listen<PreviewServicesChangedEvent>(
    PREVIEW_SERVICES_CHANGED_EVENT,
    (event) => {
      usePreviewServiceStore.getState().handleChanged(event);
    },
  );
  window.orkestrator.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
    const store = usePreviewServiceStore.getState();
    void store.loadCapabilities({ force: true }).then(() => {
      for (const environmentId of Object.keys(usePreviewServiceStore.getState().environments)) {
        void usePreviewServiceStore.getState().refreshEnvironment(environmentId, { force: true });
      }
    });
  });
}

/** Test seam. */
export function resetPreviewServiceSyncForTests(): void {
  syncStarted = false;
  usePreviewServiceStore.getState().reset();
}
