import * as backend from "@/lib/backend";
import {
  isPaneNode,
  mergePersistedPaneLayouts,
} from "@/lib/pane-layout-merge";
import { preserveClientPaneSelection } from "@/lib/pane-layout-restore";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  PANE_LAYOUT_VERSION,
  type PaneNode,
  type PersistedPaneLayout,
  type PersistedPaneLayoutInput,
  type TabInfo,
} from "@/types/paneLayout";

type SavePaneLayout = (
  environmentId: string,
  layout: PersistedPaneLayoutInput,
  expectedRevision: number,
) => Promise<PersistedPaneLayout>;
type LoadPaneLayout = (
  environmentId: string,
) => Promise<PersistedPaneLayout | null>;

interface PendingPaneLayoutWrite {
  input: PersistedPaneLayoutInput;
  serialized: string;
  baseInput: PersistedPaneLayoutInput;
}

export interface PaneLayoutPersistenceOptions {
  save?: SavePaneLayout;
  load?: LoadPaneLayout;
  debounceMs?: number;
  maxConflictRetries?: number;
}

function sanitizeTab(tab: TabInfo): TabInfo {
  const {
    initialPrompt: _initialPrompt,
    initialCommands: _initialCommands,
    ...rest
  } = tab;

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
    // Selection belongs to this renderer, not to the shared tab registry.
    // Persist a deterministic placeholder so selecting a tab in one client
    // neither writes the backend nor changes another client's selection.
    return {
      ...node,
      tabs: node.tabs.map(sanitizeTab),
      activeTabId: node.tabs[0]?.id ?? null,
    };
  }
  return {
    ...node,
    children: [sanitizeRoot(node.children[0]), sanitizeRoot(node.children[1])],
  };
}

function firstLeafId(node: PaneNode): string {
  return node.kind === "leaf" ? node.id : firstLeafId(node.children[0]);
}

export function createPersistedPaneLayoutInput(
  state: EnvironmentPaneState,
): PersistedPaneLayoutInput {
  return {
    version: PANE_LAYOUT_VERSION,
    containerId: state.containerId,
    // Like activeTabId, activePaneId is required by the version-1 wire shape
    // but has no cross-client meaning. Keep it canonical on the shared record.
    activePaneId: firstLeafId(state.root),
    root: sanitizeRoot(state.root),
  };
}

type PaneLayoutEnqueue = (
  environmentId: string,
  input: PersistedPaneLayoutInput,
) => Promise<void>;
type PaneLayoutAdopt = (
  environmentId: string,
  state: EnvironmentPaneState,
) => boolean;

interface AuthoritativePaneLayout {
  input: PersistedPaneLayoutInput;
  revision: number;
}

/**
 * Set while `startPaneLayoutPersistence` is active so out-of-band writers can
 * join its per-environment write chain instead of racing it.
 */
let activeEnqueue: PaneLayoutEnqueue | null = null;
let activeAdopt: PaneLayoutAdopt | null = null;

/**
 * Records that a store update came from the backend snapshot. This prevents
 * the persistence subscriber from echoing that same snapshot back as a new
 * revision.
 */
export function adoptPersistedPaneLayout(
  environmentId: string,
  state: EnvironmentPaneState,
): boolean {
  return activeAdopt?.(environmentId, state) ?? true;
}

/**
 * Persist a layout immediately, ordered against the debounced writer.
 *
 * `save_pane_layout` uses compare-and-swap revisions. Callers that must know a
 * layout is durable before doing something else (clearing a launch intent, say)
 * go through here so they join the active per-environment write chain.
 */
export function flushPaneLayoutNow(
  environmentId: string,
  input: PersistedPaneLayoutInput,
  save: SavePaneLayout = backend.savePaneLayout,
  load: LoadPaneLayout = backend.getPaneLayout,
): Promise<void> {
  if (activeEnqueue) return activeEnqueue(environmentId, input);
  // Without the active mirror there is no trustworthy common base for a
  // three-way merge. A missing record is safe to create; an identical record
  // is already durable. Refuse to bless a divergent stale snapshot with a
  // freshly read revision token.
  return load(environmentId).then(async (current) => {
    if (!current) {
      await save(environmentId, input, 0);
      return;
    }
    const currentInput = isPaneNode(current.root)
      ? {
        version: current.version,
        containerId: current.containerId,
        activePaneId: current.activePaneId,
        root: current.root,
      }
      : null;
    if (
      currentInput
      && JSON.stringify(currentInput) === JSON.stringify(input)
    ) {
      return;
    }
    throw new Error(
      "Cannot safely flush pane layout without an authoritative merge base",
    );
  });
}

export function startPaneLayoutPersistence(
  options: PaneLayoutPersistenceOptions = {},
): () => void {
  const save = options.save ?? backend.savePaneLayout;
  const load = options.load ?? backend.getPaneLayout;
  const debounceMs = options.debounceMs ?? 1_000;
  const maxConflictRetries = options.maxConflictRetries ?? 3;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEnqueued = new Map<string, string>();
  const writeChains = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, PendingPaneLayoutWrite>();
  const authoritative = new Map<string, AuthoritativePaneLayout>();

  const cancelTimer = (environmentId: string) => {
    const timer = timers.get(environmentId);
    if (timer) clearTimeout(timer);
    timers.delete(environmentId);
  };

  const isRevisionConflict = (error: unknown): boolean =>
    error instanceof Error
    // Electron prefixes errors crossing ipcRenderer.invoke with
    // "Error invoking remote method ...", so the stable marker may not start
    // the transported message.
    && error.message.includes("Pane layout revision conflict:");

  const persistedInput = (
    layout: PersistedPaneLayout,
  ): PersistedPaneLayoutInput | null => {
    if (!isPaneNode(layout.root)) return null;
    return {
      version: layout.version,
      containerId: layout.containerId,
      activePaneId: layout.activePaneId,
      root: layout.root,
    };
  };

  const emptyMergeBase = (
    input: PersistedPaneLayoutInput,
  ): PersistedPaneLayoutInput => {
    const emptyRoot = (node: PaneNode): PaneNode => {
      if (node.kind === "leaf") {
        return { ...node, tabs: [], activeTabId: null };
      }
      return {
        ...node,
        children: [
          emptyRoot(node.children[0]),
          emptyRoot(node.children[1]),
        ],
      };
    };
    return {
      ...input,
      root: emptyRoot(input.root),
    };
  };

  const persistWithRebase = async (
    environmentId: string,
    desiredInput: PersistedPaneLayoutInput,
    writeBaseInput: PersistedPaneLayoutInput,
  ): Promise<void> => {
    let desired = desiredInput;
    let base = authoritative.get(environmentId);
    if (!base) {
      const current = await load(environmentId);
      const currentInput = current ? persistedInput(current) : null;
      if (current && currentInput) {
        if (JSON.stringify(currentInput) !== JSON.stringify(desiredInput)) {
          throw new Error(
            "Cannot safely persist pane layout without an authoritative merge base",
          );
        }
        base = { input: currentInput, revision: current.revision };
      } else {
        base = { input: desiredInput, revision: current?.revision ?? 0 };
      }
      authoritative.set(environmentId, base);
    }
    if (
      base.input.version === desired.version
      && base.input.containerId === desired.containerId
      && JSON.stringify(base.input) !== JSON.stringify(writeBaseInput)
    ) {
      desired = mergePersistedPaneLayouts(
        writeBaseInput,
        desired,
        base.input,
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const saved = await save(environmentId, desired, base.revision);
        const savedInput = persistedInput(saved) ?? desired;
        authoritative.set(environmentId, {
          input: savedInput,
          revision: saved.revision,
        });
        lastEnqueued.set(environmentId, JSON.stringify(savedInput));
        const paneStore = usePaneLayoutStore.getState();
        const current = paneStore.environments.get(environmentId);
        if (
          current
          && paneStore.hydration.get(environmentId) === "done"
          && current.containerId === savedInput.containerId
        ) {
          const currentInput = createPersistedPaneLayoutInput(current);
          // If another local mutation happened while this save was in flight,
          // its already-enqueued write will rebase over savedInput using the
          // updated authoritative map. Installing here would generate a
          // redundant third write and could momentarily roll that local edit
          // back. With no newer mutation, install the rebased result now so the
          // next edit is derived from the complete shared tree.
          if (
            JSON.stringify(currentInput) === JSON.stringify(desiredInput)
          ) {
            paneStore.applyAuthoritativeLayout(
              environmentId,
              preserveClientPaneSelection({
                containerId: savedInput.containerId,
                activePaneId: savedInput.activePaneId,
                root: savedInput.root,
                backendRevision: saved.revision,
              }, current),
            );
          }
        }
        return;
      } catch (error) {
        if (!isRevisionConflict(error) || attempt >= maxConflictRetries) {
          throw error;
        }
        const current = await load(environmentId);
        if (!current) {
          base = { input: desired, revision: 0 };
          continue;
        }
        const remoteInput = persistedInput(current);
        if (!remoteInput) {
          // A malformed older record cannot be merged, but its revision is still
          // a valid CAS base. Replace it with the renderer-validated local tree.
          base = { input: desired, revision: current.revision };
          continue;
        }
        // Layouts from another container generation are not a common merge
        // base. Retaining any of their tabs would resurrect stale sessions
        // after a container restart, so replace them at their current revision.
        const sameGeneration =
          remoteInput.version === desired.version
          && remoteInput.containerId === desired.containerId;
        if (sameGeneration) {
          const commonBase =
            base.revision > 0
              && base.input.version === desired.version
              && base.input.containerId === desired.containerId
              ? base.input
              : emptyMergeBase(desired);
          desired = mergePersistedPaneLayouts(
            commonBase,
            desired,
            remoteInput,
          );
        }
        base = { input: remoteInput, revision: current.revision };
        authoritative.set(environmentId, base);
      }
    }
  };

  const reportWriteFailure = (error: unknown): void => {
    console.error("[PaneLayout] Failed to persist pane layout:", error);
  };

  const enqueueWrite = (
    environmentId: string,
    { input, serialized, baseInput }: PendingPaneLayoutWrite,
  ): Promise<void> => {
    const previousWrite = writeChains.get(environmentId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(() => persistWithRebase(environmentId, input, baseInput))
      .catch((error) => {
        if (lastEnqueued.get(environmentId) === serialized) {
          lastEnqueued.delete(environmentId);
        }
        throw error;
      });
    writeChains.set(environmentId, nextWrite);
    void nextWrite.then(() => {
      if (writeChains.get(environmentId) === nextWrite) {
        writeChains.delete(environmentId);
      }
    }, () => {
      if (writeChains.get(environmentId) === nextWrite) {
        writeChains.delete(environmentId);
      }
    });
    return nextWrite;
  };

  // Joins the same chain as the debounced writes so ordering holds. Priming
  // `lastEnqueued` also stops the subscriber echoing this exact layout back.
  const enqueueImmediate: PaneLayoutEnqueue = (environmentId, input) => {
    const serialized = JSON.stringify(input);
    if (pendingWrites.get(environmentId)?.serialized === serialized) {
      cancelTimer(environmentId);
      pendingWrites.delete(environmentId);
    }
    lastEnqueued.set(environmentId, serialized);
    return enqueueWrite(environmentId, {
      input,
      serialized,
      baseInput: authoritative.get(environmentId)?.input ?? input,
    });
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
    void flushAll().catch(reportWriteFailure);
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void flushAll().catch(reportWriteFailure);
    }
  };

  window.addEventListener("pagehide", handlePageHide);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  activeEnqueue = enqueueImmediate;
  const adoptAuthoritative: PaneLayoutAdopt = (environmentId, state) => {
    // An event for an older save can arrive while this renderer already has a
    // newer structural mutation queued or in flight. Do not let that self-echo
    // roll the newer local tab out of the UI; its completed write will announce
    // another authoritative revision.
    if (
      pendingWrites.has(environmentId)
      || writeChains.has(environmentId)
    ) {
      return false;
    }
    const input = createPersistedPaneLayoutInput(state);
    const revision = state.backendRevision ?? 0;
    const known = authoritative.get(environmentId);
    if (known && revision < known.revision) return false;
    if (
      known
      && revision === known.revision
      && JSON.stringify(input) !== JSON.stringify(known.input)
    ) {
      return false;
    }
    const serialized = JSON.stringify(input);
    cancelTimer(environmentId);
    pendingWrites.delete(environmentId);
    lastEnqueued.set(environmentId, serialized);
    authoritative.set(environmentId, { input, revision });
    return true;
  };
  activeAdopt = adoptAuthoritative;

  // Persistence can mount after pane hydration (for example after a renderer
  // remount). Seed the exact snapshot/revision that existing local state was
  // derived from; Zustand subscriptions only observe future transitions.
  const initialState = usePaneLayoutStore.getState();
  for (const [environmentId, environment] of initialState.environments) {
    if (initialState.hydration.get(environmentId) !== "done") continue;
    const input = createPersistedPaneLayoutInput(environment);
    const serialized = JSON.stringify(input);
    authoritative.set(environmentId, {
      input,
      revision: environment.backendRevision ?? 0,
    });
    lastEnqueued.set(environmentId, serialized);
  }

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
        if (!environment) {
          lastEnqueued.delete(environmentId);
          authoritative.delete(environmentId);
        }
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
        authoritative.set(environmentId, {
          input,
          revision: environment.backendRevision ?? 0,
        });
        continue;
      }

      if (environment === previous.environments.get(environmentId)) continue;
      if (lastEnqueued.get(environmentId) === serialized) continue;

      cancelTimer(environmentId);
      lastEnqueued.set(environmentId, serialized);
      pendingWrites.set(environmentId, {
        input,
        serialized,
        baseInput: authoritative.get(environmentId)?.input ?? input,
      });
      timers.set(environmentId, setTimeout(() => {
        void flushEnvironment(environmentId)?.catch(reportWriteFailure);
      }, debounceMs));
    }
  });

  return () => {
    unsubscribe();
    if (activeEnqueue === enqueueImmediate) activeEnqueue = null;
    if (activeAdopt === adoptAuthoritative) activeAdopt = null;
    window.removeEventListener("pagehide", handlePageHide);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    // Start all pending writes while the renderer/backend connection is still
    // available. pagehide/visibilitychange normally provide an earlier flush;
    // this is the final safety net for controlled React teardown.
    void flushAll().catch(reportWriteFailure);
  };
}
