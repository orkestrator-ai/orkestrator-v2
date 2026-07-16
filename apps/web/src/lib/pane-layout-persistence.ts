import * as backend from "@/lib/backend";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  PANE_LAYOUT_VERSION,
  type PaneNode,
  type PersistedPaneLayout,
  type TabInfo,
} from "@/types/paneLayout";

type PersistedPaneLayoutInput = Pick<
  PersistedPaneLayout,
  "version" | "containerId" | "activePaneId" | "root"
>;

type SavePaneLayout = (
  environmentId: string,
  layout: PersistedPaneLayoutInput,
) => Promise<PersistedPaneLayout>;

interface PendingPaneLayoutWrite {
  input: PersistedPaneLayoutInput;
  serialized: string;
}

export interface PaneLayoutPersistenceOptions {
  save?: SavePaneLayout;
  debounceMs?: number;
}

function sanitizeTab(tab: TabInfo): TabInfo {
  const { initialPrompt: _initialPrompt, initialCommands: _initialCommands, ...rest } = tab;

  if (rest.claudeNativeData) {
    const { hostPort: _hostPort, ...data } = rest.claudeNativeData;
    return { ...rest, claudeNativeData: data };
  }
  if (rest.codexNativeData) {
    const { hostPort: _hostPort, ...data } = rest.codexNativeData;
    return { ...rest, codexNativeData: data };
  }
  if (rest.openCodeNativeData) {
    const { hostPort: _hostPort, ...data } = rest.openCodeNativeData;
    return { ...rest, openCodeNativeData: data };
  }
  return rest;
}

function sanitizeRoot(node: PaneNode): PaneNode {
  if (node.kind === "leaf") {
    return {
      ...node,
      tabs: node.tabs.map(sanitizeTab),
    };
  }
  return {
    ...node,
    children: [sanitizeRoot(node.children[0]), sanitizeRoot(node.children[1])],
  };
}

export function createPersistedPaneLayoutInput(
  state: EnvironmentPaneState,
): PersistedPaneLayoutInput {
  return {
    version: PANE_LAYOUT_VERSION,
    containerId: state.containerId,
    activePaneId: state.activePaneId,
    root: sanitizeRoot(state.root),
  };
}

export function startPaneLayoutPersistence(
  options: PaneLayoutPersistenceOptions = {},
): () => void {
  const save = options.save ?? backend.savePaneLayout;
  const debounceMs = options.debounceMs ?? 1_000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEnqueued = new Map<string, string>();
  const writeChains = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, PendingPaneLayoutWrite>();

  const cancelTimer = (environmentId: string) => {
    const timer = timers.get(environmentId);
    if (timer) clearTimeout(timer);
    timers.delete(environmentId);
  };

  const enqueueWrite = (
    environmentId: string,
    { input, serialized }: PendingPaneLayoutWrite,
  ): Promise<void> => {
    const previousWrite = writeChains.get(environmentId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .then(async () => {
        await save(environmentId, input);
      })
      .catch((error) => {
        if (lastEnqueued.get(environmentId) === serialized) {
          lastEnqueued.delete(environmentId);
        }
        console.error("[PaneLayout] Failed to persist pane layout:", error);
      });
    writeChains.set(environmentId, nextWrite);
    void nextWrite.finally(() => {
      if (writeChains.get(environmentId) === nextWrite) {
        writeChains.delete(environmentId);
      }
    });
    return nextWrite;
  };

  const flushEnvironment = (environmentId: string): Promise<void> | undefined => {
    const pending = pendingWrites.get(environmentId);
    if (!pending) return undefined;
    cancelTimer(environmentId);
    pendingWrites.delete(environmentId);
    return enqueueWrite(environmentId, pending);
  };

  const flushAll = (): Promise<void> => Promise.all(
    [...pendingWrites.keys()].map((environmentId) =>
      flushEnvironment(environmentId) ?? Promise.resolve()
    ),
  ).then(() => undefined);

  const handlePageHide = () => {
    void flushAll();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void flushAll();
    }
  };

  window.addEventListener("pagehide", handlePageHide);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  const unsubscribe = usePaneLayoutStore.subscribe((state, previous) => {
    const environmentIds = new Set([
      ...state.environments.keys(),
      ...previous.environments.keys(),
      ...state.hydration.keys(),
      ...previous.hydration.keys(),
    ]);

    for (const environmentId of environmentIds) {
      const environment = state.environments.get(environmentId);
      const hydration = state.hydration.get(environmentId);
      const previousHydration = previous.hydration.get(environmentId);

      if (!environment || hydration !== "done") {
        cancelTimer(environmentId);
        pendingWrites.delete(environmentId);
        if (!environment) lastEnqueued.delete(environmentId);
        continue;
      }

      const input = createPersistedPaneLayoutInput(environment);
      const serialized = JSON.stringify(input);

      // A completed hydration represents the backend snapshot we just read.
      // Prime the cache without echoing it back to the backend on connect.
      if (previousHydration !== "done") {
        cancelTimer(environmentId);
        pendingWrites.delete(environmentId);
        lastEnqueued.set(environmentId, serialized);
        continue;
      }

      if (environment === previous.environments.get(environmentId)) continue;
      if (lastEnqueued.get(environmentId) === serialized) continue;

      cancelTimer(environmentId);
      lastEnqueued.set(environmentId, serialized);
      pendingWrites.set(environmentId, { input, serialized });
      timers.set(environmentId, setTimeout(() => {
        void flushEnvironment(environmentId);
      }, debounceMs));
    }
  });

  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", handlePageHide);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    // Start all pending writes while the renderer/backend connection is still
    // available. pagehide/visibilitychange normally provide an earlier flush;
    // this is the final safety net for controlled React teardown.
    void flushAll();
  };
}
