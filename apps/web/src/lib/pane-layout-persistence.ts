import {
  isPaneLayoutRevisionConflict,
  isPaneLayoutUnsupportedVersion,
  paneLayoutUnsupportedVersionMessage,
} from "@orkestrator/protocol/pane-layout";
import { toast } from "sonner";
import * as backend from "@/lib/backend";
import { clearStoredPaneSelection } from "@/lib/pane-selection-storage";
import {
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
} from "@/lib/pane-layout-authoritative";
import {
  isPaneNode,
  mergePersistedPaneLayouts,
  type PaneLayoutSelectionIntent,
} from "@/lib/pane-layout-merge";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  PANE_LAYOUT_VERSION,
  type PaneNode,
  type PersistedPaneLayout,
  type PersistedPaneLayoutInput,
  type TabInfo,
} from "@/types/paneLayout";
import {
  boundBrowserHistory,
  sanitizeBrowserHistoryForPersistence,
} from "@/lib/browser-history";

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
  selectionIntent?: PaneLayoutSelectionIntent;
}

export interface PaneLayoutPersistenceOptions {
  save?: SavePaneLayout;
  load?: LoadPaneLayout;
  hydrateDependencies?: typeof hydratePaneLayoutDependencies;
  debounceMs?: number;
  selectionDebounceMs?: number;
  maxConflictRetries?: number;
}

type PaneLayoutWriteSettledHandler = (environmentId: string) => void;

const writeSettledHandlers = new Set<PaneLayoutWriteSettledHandler>();

/**
 * Fires once an environment's write chain has fully drained, whether the last
 * write succeeded or failed.
 *
 * A refresh that `adoptPersistedPaneLayout` declined is only recoverable
 * because the write it deferred to eventually settles. Without this signal a
 * failed write silently strands the remote snapshot that was dropped for it.
 */
export function onPaneLayoutWriteSettled(
  handler: PaneLayoutWriteSettledHandler,
): () => void {
  writeSettledHandlers.add(handler);
  return () => {
    writeSettledHandlers.delete(handler);
  };
}

function sanitizeTab(tab: TabInfo): TabInfo {
  const {
    initialPrompt: _initialPrompt,
    initialCommands: _initialCommands,
    ...rest
  } = tab;

  if (rest.type === "browser" && rest.browserData?.history) {
    return {
      ...rest,
      browserData: {
        ...rest.browserData,
        history: sanitizeBrowserHistoryForPersistence(rest.browserData.history),
      },
    };
  }
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
  if (rest.acpNativeData) {
    const { hostPort: _hostPort, ...data } = rest.acpNativeData;
    return { ...rest, acpNativeData: data };
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

/**
 * Returns the structural portion of a layout. Used to recognize a pure focus
 * change so it can be written immediately instead of waiting behind the normal
 * structural-layout debounce.
 */
function withoutSelection(input: PersistedPaneLayoutInput): PersistedPaneLayoutInput {
  const stripRoot = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      return { ...node, activeTabId: node.tabs[0]?.id ?? null };
    }
    return {
      ...node,
      children: [stripRoot(node.children[0]), stripRoot(node.children[1])],
    };
  };
  const root = stripRoot(input.root);
  const firstLeafId = (node: PaneNode): string =>
    node.kind === "leaf" ? node.id : firstLeafId(node.children[0]);
  return { ...input, activePaneId: firstLeafId(root), root };
}

function selectionIntentBetween(
  previous: PersistedPaneLayoutInput,
  current: PersistedPaneLayoutInput,
): PaneLayoutSelectionIntent | undefined {
  const previousLeaves = new Map<string, string | null>();
  const currentLeaves = new Map<string, string | null>();
  const collect = (node: PaneNode, target: Map<string, string | null>): void => {
    if (node.kind === "leaf") {
      target.set(node.id, node.activeTabId);
      return;
    }
    collect(node.children[0], target);
    collect(node.children[1], target);
  };
  collect(previous.root, previousLeaves);
  collect(current.root, currentLeaves);

  const activeTabIds: Record<string, string | null> = {};
  for (const [paneId, activeTabId] of currentLeaves) {
    if (previousLeaves.get(paneId) !== activeTabId) {
      activeTabIds[paneId] = activeTabId;
    }
  }
  const activePaneChanged = previous.activePaneId !== current.activePaneId;
  if (!activePaneChanged && Object.keys(activeTabIds).length === 0) {
    return undefined;
  }
  return {
    ...(activePaneChanged ? { activePaneId: current.activePaneId } : {}),
    ...(Object.keys(activeTabIds).length > 0 ? { activeTabIds } : {}),
  };
}

function mergeSelectionIntents(
  earlier: PaneLayoutSelectionIntent | undefined,
  later: PaneLayoutSelectionIntent | undefined,
): PaneLayoutSelectionIntent | undefined {
  if (!earlier) return later;
  if (!later) return earlier;
  return {
    activePaneId: later.activePaneId ?? earlier.activePaneId,
    activeTabIds: {
      ...(earlier.activeTabIds ?? {}),
      ...(later.activeTabIds ?? {}),
    },
  };
}

type PaneLayoutEnqueue = (
  environmentId: string,
  input: PersistedPaneLayoutInput,
  baseInput?: PersistedPaneLayoutInput,
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
    if (currentInput && currentInput.version > input.version) {
      throw new Error(paneLayoutUnsupportedVersionMessage(currentInput.version));
    }
    // A version upgrade is the one divergent write that is safe without a
    // mounted persistence loop: the caller reconciled this exact older record
    // before producing the upgraded input, and still supplies its CAS token.
    if (currentInput && currentInput.version < input.version) {
      await save(environmentId, input, current.revision);
      return;
    }
    throw new Error(
      "Cannot safely flush pane layout without an authoritative merge base",
    );
  });
}

function sanitizeBrowserHistoryRoot(node: PaneNode): PaneNode {
  if (node.kind === "split") {
    return {
      ...node,
      children: [
        sanitizeBrowserHistoryRoot(node.children[0]),
        sanitizeBrowserHistoryRoot(node.children[1]),
      ],
    };
  }
  return {
    ...node,
    tabs: node.tabs.map((tab) => {
      if (tab.type !== "browser" || !tab.browserData?.history) return tab;
      const sanitized = sanitizeBrowserHistoryForPersistence(tab.browserData.history);
      const bounded = boundBrowserHistory(sanitized, tab.browserData.historyIndex);
      return {
        ...tab,
        browserData: {
          ...tab.browserData,
          history: bounded.history,
          ...(bounded.historyIndex !== undefined
            ? { historyIndex: bounded.historyIndex }
            : { historyIndex: undefined }),
        },
      };
    }),
  };
}

/**
 * Rewrite only privacy-sensitive browser-history fields from a snapshot that
 * was just reconciled. The raw snapshot is the CAS/merge base, so this cannot
 * accidentally bless unrelated renderer state as an edit.
 */
export async function migratePaneLayoutBrowserHistory(
  environmentId: string,
  snapshot: PersistedPaneLayout,
  save: SavePaneLayout = backend.savePaneLayout,
): Promise<boolean> {
  if (!isPaneNode(snapshot.root)) return false;
  const raw: PersistedPaneLayoutInput = {
    version: snapshot.version,
    containerId: snapshot.containerId,
    activePaneId: snapshot.activePaneId,
    root: snapshot.root,
  };
  const desired: PersistedPaneLayoutInput = {
    ...raw,
    root: sanitizeBrowserHistoryRoot(raw.root),
  };
  if (JSON.stringify(raw) === JSON.stringify(desired)) return false;
  if (activeEnqueue) await activeEnqueue(environmentId, desired, raw);
  else await save(environmentId, desired, snapshot.revision);
  return true;
}

export function startPaneLayoutPersistence(
  options: PaneLayoutPersistenceOptions = {},
): () => void {
  const useBackendIntents = options.save === undefined && options.load === undefined;
  const save = options.save ?? backend.savePaneLayout;
  const load = options.load ?? backend.getPaneLayout;
  const hydrateDependencies =
    options.hydrateDependencies ?? hydratePaneLayoutDependencies;
  // Production mutations are dispatched in the same turn. Tests may still
  // inject a delay to exercise coalescing and conflict ordering explicitly.
  const debounceMs = options.debounceMs ?? 0;
  const selectionDebounceMs =
    options.selectionDebounceMs
    ?? (options.debounceMs === undefined ? 0 : Math.min(debounceMs, 200));
  const maxConflictRetries = options.maxConflictRetries ?? 3;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const selectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEnqueued = new Map<string, string>();
  const writeChains = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, PendingPaneLayoutWrite>();
  // Focus changes can arrive much faster than a backend round trip. Keep only
  // the newest one behind the current write: every later snapshot contains the
  // complete selection state, so intermediate focus writes are obsolete.
  const pendingSelectionWrites = new Map<string, PendingPaneLayoutWrite>();
  const authoritative = new Map<string, AuthoritativePaneLayout>();
  const reportedVersionFailures = new Set<string>();

  const cancelTimer = (environmentId: string) => {
    const timer = timers.get(environmentId);
    if (timer) clearTimeout(timer);
    timers.delete(environmentId);
  };

  const cancelSelectionTimer = (environmentId: string) => {
    const timer = selectionTimers.get(environmentId);
    if (timer) clearTimeout(timer);
    selectionTimers.delete(environmentId);
  };

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

  /**
   * Installs the tree a rebased save produced, so the next local edit is
   * derived from the complete shared layout rather than from a snapshot that
   * predates the merge.
   *
   * A rebase can graft in tabs this client has never seen, so the snapshot goes
   * through the same dependency hydration and reconciliation as a change-feed
   * refresh. Anything that fails here is skipped rather than raised: the save
   * itself already succeeded, and the backend's own announcement drives a full
   * refresh right behind us.
   */
  const installSavedLayout = async (
    environmentId: string,
    saved: PersistedPaneLayout,
    savedInput: PersistedPaneLayoutInput,
    desiredInput: PersistedPaneLayoutInput,
  ): Promise<void> => {
    // If another local mutation happened while this save was in flight, its
    // already-enqueued write will rebase over savedInput using the updated
    // authoritative map. Installing here would generate a redundant third write
    // and could momentarily roll that local edit back.
    const hasNewerLocalEdit = (): boolean => {
      const paneStore = usePaneLayoutStore.getState();
      const current = paneStore.environments.get(environmentId);
      if (!current || paneStore.hydration.get(environmentId) !== "done") {
        return true;
      }
      return JSON.stringify(createPersistedPaneLayoutInput(current))
        !== JSON.stringify(desiredInput);
    };
    if (hasNewerLocalEdit()) return;

    try {
      await hydrateDependencies(savedInput.root);
    } catch (error) {
      console.warn(
        "[PaneLayout] Skipped installing a saved layout whose dependencies "
          + "could not be hydrated:",
        error,
      );
      return;
    }
    // Re-check after the await: hydration yields, so a local edit or a
    // container swap can land in between.
    if (hasNewerLocalEdit()) return;

    const paneStore = usePaneLayoutStore.getState();
    const current = paneStore.environments.get(environmentId);
    if (!current) return;
    const restored = reconcileAuthoritativePaneLayout(
      environmentId,
      { ...saved, ...savedInput },
      current,
    );
    if (!restored) return;

    // Reconciliation canonicalises tab shape and drops any tab whose backing
    // record the backend no longer has, so the installed tree can serialize
    // differently from what was just saved. Re-prime the mirror from the tree
    // actually installed, or the subscriber reads it as a fresh local edit and
    // writes it straight back. This mirrors `adoptPersistedPaneLayout`, which
    // primes from the reconciled snapshot for the same reason.
    const installedInput = createPersistedPaneLayoutInput(restored);
    lastEnqueued.set(environmentId, JSON.stringify(installedInput));
    authoritative.set(environmentId, {
      input: installedInput,
      revision: saved.revision,
    });
    paneStore.applyAuthoritativeLayout(environmentId, restored);
  };

  const persistWithRebase = async (
    environmentId: string,
    desiredInput: PersistedPaneLayoutInput,
    writeBaseInput: PersistedPaneLayoutInput,
    selectionIntent?: PaneLayoutSelectionIntent,
  ): Promise<void> => {
    if (useBackendIntents) {
      const saved = await backend.applyPaneLayoutIntent(
        environmentId,
        writeBaseInput,
        desiredInput,
        selectionIntent,
      );
      const savedInput = persistedInput(saved) ?? desiredInput;
      authoritative.set(environmentId, { input: savedInput, revision: saved.revision });
      lastEnqueued.set(environmentId, JSON.stringify(savedInput));
      await installSavedLayout(environmentId, saved, savedInput, desiredInput);
      clearStoredPaneSelection(environmentId);
      return;
    }
    let desired = desiredInput;
    let base = authoritative.get(environmentId);
    if (!base) {
      const current = await load(environmentId);
      const currentInput = current ? persistedInput(current) : null;
      if (current && currentInput) {
        if (currentInput.version > desiredInput.version) {
          throw new Error(
            paneLayoutUnsupportedVersionMessage(currentInput.version),
          );
        }
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
        { selectionIntent },
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
        await installSavedLayout(environmentId, saved, savedInput, desiredInput);
        clearStoredPaneSelection(environmentId);
        return;
      } catch (error) {
        if (!isPaneLayoutRevisionConflict(error) || attempt >= maxConflictRetries) {
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
        // A renderer that cannot interpret a future schema must not replace it
        // with its own default tree during conflict recovery.
        if (remoteInput.version > desired.version) {
          throw new Error(
            paneLayoutUnsupportedVersionMessage(remoteInput.version),
          );
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
            { selectionIntent },
          );
        }
        base = { input: remoteInput, revision: current.revision };
        authoritative.set(environmentId, base);
      }
    }
  };

  const reportWriteFailure = (environmentId: string, error: unknown): void => {
    console.error("[PaneLayout] Failed to persist pane layout:", error);
    if (
      isPaneLayoutUnsupportedVersion(error)
      && !reportedVersionFailures.has(environmentId)
    ) {
      reportedVersionFailures.add(environmentId);
      toast.error("Pane layout changes are not being saved", {
        description:
          "This client and the Orkestrator backend use different layout versions. Update both before rearranging tabs.",
        duration: 10_000,
      });
    }
  };

  const enqueueWrite = (
    environmentId: string,
    { input, serialized, baseInput, selectionIntent }: PendingPaneLayoutWrite,
  ): Promise<void> => {
    const previousWrite = writeChains.get(environmentId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(() => persistWithRebase(
        environmentId,
        input,
        baseInput,
        selectionIntent,
      ))
      .catch((error) => {
        if (lastEnqueued.get(environmentId) === serialized) {
          lastEnqueued.delete(environmentId);
        }
        throw error;
      });
    writeChains.set(environmentId, nextWrite);
    const settle = () => {
      if (writeChains.get(environmentId) !== nextWrite) return;
      writeChains.delete(environmentId);
      const pendingSelection = pendingSelectionWrites.get(environmentId);
      if (pendingSelection) {
        // A short focus debounce owns this successor. It will enqueue behind
        // the current chain when its timer fires; settling the predecessor must
        // not bypass that bound.
        if (selectionTimers.has(environmentId)) return;
        pendingSelectionWrites.delete(environmentId);
        // The predecessor's completion recorded its older payload. Restore the
        // queued head before starting it so an unrelated Zustand update cannot
        // enqueue the same latest selection a second time.
        lastEnqueued.set(environmentId, pendingSelection.serialized);
        void enqueueWrite(environmentId, pendingSelection)
          .catch((error) => reportWriteFailure(environmentId, error));
        return;
      }
      // Only announce a genuinely idle environment. A queued debounced write
      // would decline the very adoption this signal exists to unblock, and its
      // own settle will follow.
      if (pendingWrites.has(environmentId)) return;
      for (const handler of [...writeSettledHandlers]) {
        try {
          handler(environmentId);
        } catch (error) {
          console.warn(
            "[PaneLayout] A write-settled handler threw:",
            error,
          );
        }
      }
    };
    void nextWrite.then(settle, settle);
    return nextWrite;
  };

  const enqueueLatestSelection = (
    environmentId: string,
    write: PendingPaneLayoutWrite,
  ): void => {
    const pending = pendingSelectionWrites.get(environmentId);
    pendingSelectionWrites.set(environmentId, {
      ...write,
      baseInput: pending?.baseInput ?? write.baseInput,
      selectionIntent: mergeSelectionIntents(
        pending?.selectionIntent,
        write.selectionIntent,
      ),
    });
    cancelSelectionTimer(environmentId);
    if (selectionDebounceMs === 0) {
      void flushSelectionEnvironment(environmentId)?.catch((error) =>
        reportWriteFailure(environmentId, error)
      );
      return;
    }
    selectionTimers.set(environmentId, setTimeout(() => {
      void flushSelectionEnvironment(environmentId)?.catch((error) =>
        reportWriteFailure(environmentId, error)
      );
    }, selectionDebounceMs));
  };

  // Joins the same chain as the debounced writes so ordering holds. Priming
  // `lastEnqueued` also stops the subscriber echoing this exact layout back.
  const enqueueImmediate: PaneLayoutEnqueue = (environmentId, input, explicitBaseInput) => {
    const serialized = JSON.stringify(input);
    const matchingPending = pendingWrites.get(environmentId)?.serialized === serialized
      ? pendingWrites.get(environmentId)
      : undefined;
    if (matchingPending) {
      cancelTimer(environmentId);
      pendingWrites.delete(environmentId);
    }
    // The immediate snapshot contains the latest selection too, so it
    // supersedes a coalesced focus write. Carry that write's original merge
    // base and explicit A -> B -> A intent into this flush.
    const pendingSelection = pendingSelectionWrites.get(environmentId);
    cancelSelectionTimer(environmentId);
    pendingSelectionWrites.delete(environmentId);
    lastEnqueued.set(environmentId, serialized);
    return enqueueWrite(environmentId, {
      input,
      serialized,
      baseInput:
        explicitBaseInput
        ?? matchingPending?.baseInput
        ?? pendingSelection?.baseInput
        ?? authoritative.get(environmentId)?.input
        ?? input,
      selectionIntent: mergeSelectionIntents(
        matchingPending?.selectionIntent,
        pendingSelection?.selectionIntent,
      ),
    });
  };

  const flushEnvironment = (environmentId: string): Promise<void> | undefined => {
    const pending = pendingWrites.get(environmentId);
    if (!pending) return undefined;
    cancelTimer(environmentId);
    pendingWrites.delete(environmentId);
    return enqueueWrite(environmentId, pending);
  };

  const flushSelectionEnvironment = (
    environmentId: string,
  ): Promise<void> | undefined => {
    const pending = pendingSelectionWrites.get(environmentId);
    if (!pending) return undefined;
    cancelSelectionTimer(environmentId);
    pendingSelectionWrites.delete(environmentId);
    return enqueueWrite(environmentId, pending);
  };

  const flushAll = (): Promise<void> => Promise.all(
    [...new Set([
      ...pendingWrites.keys(),
      ...pendingSelectionWrites.keys(),
    ])].map((environmentId) =>
      flushEnvironment(environmentId)
      ?? flushSelectionEnvironment(environmentId)
      ?? Promise.resolve()
    ),
  ).then(() => undefined);

  const handlePageHide = () => {
    void flushAll().catch((error) => reportWriteFailure("pagehide", error));
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void flushAll().catch((error) =>
        reportWriteFailure("visibility", error)
      );
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
      || pendingSelectionWrites.has(environmentId)
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
        cancelSelectionTimer(environmentId);
        pendingWrites.delete(environmentId);
        pendingSelectionWrites.delete(environmentId);
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
        cancelSelectionTimer(environmentId);
        pendingWrites.delete(environmentId);
        pendingSelectionWrites.delete(environmentId);
        lastEnqueued.set(environmentId, serialized);
        authoritative.set(environmentId, {
          input,
          revision: environment.backendRevision ?? 0,
        });
        continue;
      }

      if (environment === previous.environments.get(environmentId)) continue;
      if (lastEnqueued.get(environmentId) === serialized) continue;

      const previousEnvironment = previous.environments.get(environmentId);
      const previousInput = previousEnvironment
        ? createPersistedPaneLayoutInput(previousEnvironment)
        : input;
      const selectionIntent = selectionIntentBetween(previousInput, input);
      const selectionOnly = previousEnvironment
        && JSON.stringify(withoutSelection(input))
          === JSON.stringify(withoutSelection(
            previousInput,
          ));

      if (selectionOnly) {
        const pendingStructural = pendingWrites.get(environmentId);
        cancelTimer(environmentId);
        pendingWrites.delete(environmentId);
        lastEnqueued.set(environmentId, serialized);
        enqueueLatestSelection(environmentId, {
          input,
          serialized,
          // If focus promotes a structural debounce, retain its original
          // durable base so the structural mutation remains a local edit during
          // rebase. Explicit selection intent separately makes A -> B -> A end
          // on the final A even when A equals that durable base.
          baseInput:
            pendingStructural?.baseInput
            ?? authoritative.get(environmentId)?.input
            ?? previousInput,
          selectionIntent: mergeSelectionIntents(
            pendingStructural?.selectionIntent,
            selectionIntent,
          ),
        });
        continue;
      }

      cancelTimer(environmentId);
      cancelSelectionTimer(environmentId);
      // A later structural snapshot includes the current focus too, so it
      // supersedes any older coalesced selection waiting behind an in-flight
      // write.
      const pendingSelection = pendingSelectionWrites.get(environmentId);
      pendingSelectionWrites.delete(environmentId);
      const pendingStructural = pendingWrites.get(environmentId);
      lastEnqueued.set(environmentId, serialized);
      pendingWrites.set(environmentId, {
        input,
        serialized,
        baseInput:
          pendingStructural?.baseInput
          ?? pendingSelection?.baseInput
          ?? authoritative.get(environmentId)?.input
          ?? previousInput,
        selectionIntent: mergeSelectionIntents(
          mergeSelectionIntents(
            pendingStructural?.selectionIntent,
            pendingSelection?.selectionIntent,
          ),
          selectionIntent,
        ),
      });
      if (debounceMs === 0) {
        void flushEnvironment(environmentId)?.catch((error) =>
          reportWriteFailure(environmentId, error)
        );
        continue;
      }
      timers.set(environmentId, setTimeout(() => {
        void flushEnvironment(environmentId)?.catch((error) =>
          reportWriteFailure(environmentId, error)
        );
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
    void flushAll().catch((error) => reportWriteFailure("teardown", error));
  };
}
