import { useEffect, useMemo, useRef, useCallback, useState, type MouseEvent } from "react";
import type { BrowserPreviewOpenLinkEvent } from "@orkestrator/protocol/browser-preview";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  useTerminalContext,
  MAX_TABS,
  type CreatableTabType,
  type TerminalTabType,
  type CreateTabOptions,
  type CreateFileTabOptions,
} from "@/contexts";
import {
  createSessionKey,
  useClaudeOptionsStore,
  usePaneLayoutStore,
  useEnvironmentStore,
  useConfigStore,
  useTerminalSessionStore,
  getAllLeaves,
} from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { showTabLimitReachedToast } from "@/lib/tab-limit-toast";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import {
  buildInitialPromptWithAttachmentReferences,
  saveInitialPromptAttachments,
} from "@/lib/initial-prompt-attachments";
import { agentSettingsTiers } from "@/lib/agent-settings";
import {
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
} from "@orkestrator/protocol/agent-settings";
import { resolveStartupLaunchFromSettings } from "@orkestrator/protocol/startup-launch";
import { reconcilePersistedLayout } from "@/lib/pane-layout-restore";
import {
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  migratePaneLayoutBrowserHistory,
} from "@/lib/pane-layout-persistence";
import {
  applyStoredPaneSelection,
  clearStoredPaneSelection,
  readStoredPaneSelection,
} from "@/lib/pane-selection-storage";
import { listenForTerminalBrowserTabRequests } from "@/lib/terminal-links";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { createOrkestratorScriptPrompt } from "@/prompts";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { hydrateLoopedReviewWorkflowsForEnvironment } from "@/lib/looped-review-persistence";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflowsForEnvironment } from "@/lib/multi-review-persistence";
import { PaneTree } from "@/components/pane-layout";
import { TerminalPortalHost } from "./TerminalPortalHost";
import { TerminalContainerOverlays } from "./TerminalContainerOverlays";
import {
  parseDraggableTabId,
  isGitFileStatus,
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  type TabInfo,
} from "@/types/paneLayout";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { rendererDebugLog } from "@/lib/debug-log";

import {
  MAX_SETUP_SESSION_BIND_ATTEMPTS,
  SETUP_SESSION_BIND_RETRY_DELAY_MS,
  STARTUP_AGENT_TAB_ID,
  TerminalContainerProps,
  createAgentNativeTab,
  createClaudeNativeLikeTab,
  createUniqueTabId,
  customCollisionDetection,
  findStartupAgentTabId,
  getTerminalTabDragEndAction,
  handoffSetupFocusToStartupAgent,
  seedDeferredNativePlatform,
} from "./TerminalContainer.helpers";
export function TerminalContainer({
  environmentId,
  containerId,
  isContainerRunning = false,
  isContainerCreating = false,
  isActive = true,
  className,
  onStartContainer,
  onCreateScript,
}: TerminalContainerProps) {
  const activeWriteRef = useRef<((data: string) => Promise<void>) | null>(null);

  // Track currently dragged tab ID for cross-pane visual feedback
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);

  // Get Claude options for this environment. Actions are stable references;
  // the options record is selected narrowly so writes for other environments
  // do not rerender this container.
  const clearOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const setOptions = useClaudeOptionsStore((state) => state.setOptions);
  const setPendingNativeLaunch = useClaudeOptionsStore((state) => state.setPendingNativeLaunch);
  const clearPendingNativeLaunch = useClaudeOptionsStore((state) => state.clearPendingNativeLaunch);
  const claudeOptions = useClaudeOptionsStore((state) => state.options[environmentId]);
  const pendingNativeLaunch = useClaudeOptionsStore(
    (state) => state.pendingNativeLaunches[environmentId],
  );
  const [hasAppliedClaudeOptions, setHasAppliedClaudeOptions] = useState(false);

  // Get config for agent modes - per-environment overrides take precedence over global
  const config = useConfigStore((state) => state.config);
  const { envAgentSettings, envProjectId } = useEnvironmentStore(
    useShallow((state) => {
      const env = state.environments.find((e) => e.id === environmentId);
      return { envAgentSettings: env?.agentSettings, envProjectId: env?.projectId };
    }),
  );
  // One assembly of the three tiers, then every question is asked of the shared
  // resolver. The renderer used to keep its own copy of the tiering rule in
  // `claude-mode-resolver.ts`, which defaulted Codex to native while the shared
  // resolver defaulted it to terminal — exactly the kind of drift that costs a
  // launch its attachments.
  // Memoized because the launch-reconciliation effect below depends on it. The
  // assembly is a fresh object literal every call, so an unmemoized value would
  // re-run that effect on every render of this container rather than only when
  // agent settings actually change.
  const tiers = useMemo(
    () => agentSettingsTiers(config, envProjectId, { agentSettings: envAgentSettings }),
    [config, envProjectId, envAgentSettings],
  );
  const opencodeMode = resolveAgentPlatformSettings(tiers, "opencode").mode;
  const codexMode = resolveAgentPlatformSettings(tiers, "codex").mode;
  const piMode = resolveAgentPlatformSettings(tiers, "pi").mode;
  const claude = resolveAgentPlatformSettings(tiers, "claude");
  const claudeMode = claude.mode;
  const claudeNativeBackend = claude.claudeNativeBackend;
  /*
   * Whether the backend's native agent service will dispatch this environment's
   * pending launch itself — which is also whether it owns the initial prompt's
   * image attachments. It must be answered exactly as
   * `reconcileInitialLaunchOnce` answers it: when the two disagree, either both
   * sides consume the attachments or neither delivers them.
   */
  const startupLaunchDispatchedByBackend =
    resolveStartupLaunchFromSettings(tiers).dispatchedByBackend;

  // Check if this is a local environment (no container)
  const environment = useEnvironmentStore((state) =>
    state.environments.find((env) => env.id === environmentId),
  );
  const isLocalEnvironment = environment?.environmentType === "local";
  const setupPhase = environment?.setupPhase ?? "pending";
  const backendSetupRunning = setupPhase === "running";
  const setupReady = setupPhase === "ready";
  // The backend clears this once the startup launch has converged, so it is the
  // window in which a setup-to-agent focus handoff is still owed.
  const isStartupLaunchPending = environment?.pendingAgentLaunch === true;
  const createScriptPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
  // For local environments, worktreePath must be set before terminal can work
  const worktreePath = environment?.worktreePath;
  // Local environment is ready when it has a worktree path (created during start_environment)
  const isLocalEnvironmentReady = isLocalEnvironment && !!worktreePath;
  const isEnvironmentRunning = isContainerRunning || isLocalEnvironmentReady;

  // Pane layout store - use selectors for reactive state
  const hydrationStatus = usePaneLayoutStore((state) => state.hydration.get(environmentId));

  // Get derived state for THIS environment (not the globally active one).
  // Selected narrowly (the per-environment record has a stable reference) so
  // layout changes in OTHER environments do not rerender this container.
  const currentEnvState = usePaneLayoutStore((state) => state.environments.get(environmentId));
  const root = currentEnvState?.root ?? {
    kind: "leaf" as const,
    id: "default",
    tabs: [],
    activeTabId: null,
  };
  const activePaneId = currentEnvState?.activePaneId ?? "default";

  // Pane layout actions (stable references, shallow-compared bundle)
  const {
    setActiveEnvironment,
    initialize,
    reset,
    beginHydration,
    finishHydration,
    addTab,
    removeTab,
    reorderTabs,
    moveTab,
    splitPaneAtEdge,
    getActivePane,
    getAllTabs,
    getOpenFilePaths,
    getPane,
  } = usePaneLayoutStore(
    useShallow((state) => ({
      setActiveEnvironment: state.setActiveEnvironment,
      initialize: state.initialize,
      reset: state.reset,
      beginHydration: state.beginHydration,
      finishHydration: state.finishHydration,
      addTab: state.addTab,
      removeTab: state.removeTab,
      reorderTabs: state.reorderTabs,
      moveTab: state.moveTab,
      splitPaneAtEdge: state.splitPaneAtEdge,
      getActivePane: state.getActivePane,
      getAllTabs: state.getAllTabs,
      getOpenFilePaths: state.getOpenFilePaths,
      getPane: state.getPane,
    })),
  );

  const {
    setTerminalWrite,
    setCreateTab,
    setSelectTab,
    setCloseActiveTab,
    setTabCount,
    setCreateFileTab,
    setOpenFilePaths,
  } = useTerminalContext();

  // Track the initial prompt to pass to the first tab
  const initialPromptRef = useRef<string | undefined>(undefined);
  const previousContainerIdRef = useRef<string | null>(null);
  const previousEnvironmentIdRef = useRef<string | null>(null);
  const isSavingInitialPromptAttachmentsRef = useRef(false);
  const setupSessionBindInFlightRef = useRef(new Map<string, symbol>());
  const setupSessionBindSettledTabsRef = useRef(new Set<string>());
  const setupSessionPostSetupCheckedTabsRef = useRef(new Set<string>());
  const setupSessionUnavailableTabsRef = useRef(new Set<string>());
  // A bind requested while another is already in flight for the same tab cannot
  // be answered by that lookup: the in-flight one may have read the backend
  // before setup finished. Record the ask so the settling bind re-dispatches
  // instead of the request being dropped and the tab never re-checked.
  const setupSessionRecheckPendingTabsRef = useRef(new Set<string>());
  const setupSessionBindAttemptsRef = useRef(new Map<string, number>());
  const setupSessionBindRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setupSessionBindLifecycleGenerationRef = useRef(0);
  const setupSessionReconnectGenerationRef = useRef(0);
  // Read by the async bind rather than closing over `backendSetupRunning`: a
  // lookup dispatched while setup was running must not settle against the value
  // it captured, or a turn that finished mid-flight is recorded as if it had
  // been checked after setup completed.
  const backendSetupRunningRef = useRef(backendSetupRunning);
  backendSetupRunningRef.current = backendSetupRunning;
  const durableLaunchClearInFlightRef = useRef(false);
  // Keyed by environment, not a single "last handed off" id: this component is
  // reused across environment selections (see the container-change effect
  // below), so a scalar would be re-armed by every switch away and back.
  const handedOffSetupFocusRef = useRef<Set<string>>(new Set());
  // Command+W arrives either from the Electron menu accelerator or, in a
  // browser-served client, from the renderer fallback. These two refs keep
  // exactly one of them closing a tab per keypress.
  const menuOwnsCloseTabRef = useRef(false);
  const rendererClosedTabPendingEchoRef = useRef(false);
  const [setupSessionBindNonce, setSetupSessionBindNonce] = useState(0);
  const [setupSessionBindRetryNonce, setSetupSessionBindRetryNonce] = useState(0);
  const [setupSessionReconnectNonce, setSetupSessionReconnectNonce] = useState(0);

  const setupSessionKeyForTab = useCallback(
    (tabId: string) => createSessionKey(containerId ?? null, tabId, environmentId),
    [containerId, environmentId],
  );

  const hasBoundSetupSession = useCallback(
    (tabId: string) =>
      !!useTerminalSessionStore.getState().sessions.get(setupSessionKeyForTab(tabId))?.sessionId,
    [setupSessionKeyForTab],
  );

  /**
   * Resolve setup history that has not reached the renderer-local terminal
   * store yet. PersistentTerminal performs the same hydration for display, but
   * its session snapshot and buffer reads are asynchronous. Cleanup must not
   * race those reads and interpret a cold store as an authoritative empty one.
   */
  const loadReplayableSetupTranscript = useCallback(
    async (tabId: string) => {
      const key = setupSessionKeyForTab(tabId);
      const local = useTerminalSessionStore.getState().sessions.get(key);
      if (local?.serializedBuffer) {
        return { buffer: local.serializedBuffer, persistentSessionId: local.persistentSessionId };
      }

      const persistentSessions = await backend.getSessionsByEnvironment(environmentId);
      const persistentSession = persistentSessions.find((session) => session.tabId === tabId);
      if (!persistentSession) return null;

      const buffer = await backend.loadSessionBuffer(persistentSession.id);
      if (!buffer) return null;
      return { buffer, persistentSessionId: persistentSession.id };
    },
    [environmentId, setupSessionKeyForTab],
  );

  const bindBackendSetupSession = useCallback(
    async (tabId = "default") => {
      // Tracked per tab, not globally: a global latch made a second unbound
      // setup tab return early without ever settling, and a tab that never
      // settles is skipped by stale-tab cleanup forever — a pane that can
      // neither connect nor be retired.
      if (setupSessionBindInFlightRef.current.has(tabId)) {
        const alreadyBound = hasBoundSetupSession(tabId);
        // The in-flight lookup may have read the backend before setup finished,
        // so it cannot answer this request. Park it: the settling bind
        // re-dispatches rather than letting the ask disappear, which is what
        // left a completed tab bound to a session nothing ever re-checked.
        setupSessionRecheckPendingTabsRef.current.add(tabId);
        console.info("[setup-terminal] setup session bind skipped: already in flight", {
          environmentId,
          tabId,
          alreadyBound,
        });
        return alreadyBound;
      }
      const requestToken = Symbol(tabId);
      const startedWhileSetupRunning = backendSetupRunningRef.current;
      let lookupFailed = false;
      let setupSessionLookupSucceeded = false;
      const lifecycleGeneration = setupSessionBindLifecycleGenerationRef.current;
      const reconnectGeneration = setupSessionReconnectGenerationRef.current;
      const existingTimer = setupSessionBindRetryTimersRef.current.get(tabId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        setupSessionBindRetryTimersRef.current.delete(tabId);
      }
      setupSessionBindInFlightRef.current.set(tabId, requestToken);
      setupSessionBindSettledTabsRef.current.delete(tabId);
      let lookupSettled = false;
      try {
        console.info("[setup-terminal] requesting backend setup session", {
          environmentId,
          tabId,
          key: setupSessionKeyForTab(tabId),
        });
        const setupSession = await backend.awaitEnvironmentSetupSession(environmentId);
        if (setupSessionBindLifecycleGenerationRef.current !== lifecycleGeneration) {
          return false;
        }
        setupSessionLookupSucceeded = true;
        if (!setupSession?.sessionId) {
          // Retiring an already-bound tab here is new, so it has to respect the
          // same rule as the completed-but-empty case below: a locally replayable
          // transcript still outranks the backend having forgotten the session.
          // Without either transcript source, mark it explicitly unavailable so
          // stale-tab cleanup can retire it.
          const replayableTranscript = await loadReplayableSetupTranscript(tabId);
          if (setupSessionBindLifecycleGenerationRef.current !== lifecycleGeneration) {
            return false;
          }
          lookupSettled = true;
          setupSessionBindAttemptsRef.current.delete(tabId);
          const hasReplayableTranscript = replayableTranscript !== null;
          if (replayableTranscript) {
            const key = setupSessionKeyForTab(tabId);
            const terminalStore = useTerminalSessionStore.getState();
            const existing = terminalStore.sessions.get(key);
            terminalStore.setSession(key, {
              ...existing,
              persistentSessionId:
                existing?.persistentSessionId ?? replayableTranscript.persistentSessionId,
              serializedBuffer: existing?.serializedBuffer || replayableTranscript.buffer,
            });
          }
          if (!hasReplayableTranscript) {
            setupSessionUnavailableTabsRef.current.add(tabId);
          } else {
            setupSessionUnavailableTabsRef.current.delete(tabId);
          }
          console.info("[setup-terminal] no backend setup session available", {
            environmentId,
            tabId,
            hasReplayableTranscript,
          });
          return false;
        }
        const key = setupSessionKeyForTab(tabId);
        const terminalStore = useTerminalSessionStore.getState();
        const existing = terminalStore.sessions.get(key);
        console.info("[setup-terminal] binding backend setup session", {
          environmentId,
          tabId,
          key,
          previousSessionId: existing?.sessionId ?? null,
          nextSessionId: setupSession.sessionId,
          setupSessionRunning: setupSession.running,
          terminalRunning: setupSession.terminalRunning ?? null,
          hasOutput: setupSession.hasOutput ?? null,
          success: setupSession.success ?? null,
        });
        // The setup PTY uses one deterministic backend identity. Treat a
        // different id as unavailable rather than binding this tab to an
        // unrelated terminal returned by a malformed or stale snapshot.
        if (setupSession.sessionId !== `${environmentId}:setup`) {
          lookupSettled = true;
          setupSessionBindAttemptsRef.current.delete(tabId);
          setupSessionUnavailableTabsRef.current.add(tabId);
          return false;
        }
        // A completed setup record can outlive both its PTY and its bounded
        // transcript. It is useful while either still exists, but otherwise it
        // is only a dead attach-only target: xterm opens, no shell can receive
        // input, and there are no bytes to replay. Older backends do not report
        // `hasOutput`, so retain their session conservatively during rolling
        // upgrades rather than discarding setup history we cannot prove empty.
        // The durable renderer transcript is the other half of that proof: the
        // backend drops a retained setup buffer minutes after the PTY exits,
        // including before a cold renderer has loaded its saved history.
        if (
          !setupSession.running &&
          !setupSession.terminalRunning &&
          setupSession.hasOutput === false
        ) {
          const replayableTranscript = await loadReplayableSetupTranscript(tabId);
          if (setupSessionBindLifecycleGenerationRef.current !== lifecycleGeneration) {
            return false;
          }
          lookupSettled = true;
          setupSessionBindAttemptsRef.current.delete(tabId);
          if (!replayableTranscript) {
            setupSessionUnavailableTabsRef.current.add(tabId);
            return false;
          }
          const terminalStore = useTerminalSessionStore.getState();
          const current = terminalStore.sessions.get(key);
          terminalStore.setSession(key, {
            ...current,
            persistentSessionId:
              current?.persistentSessionId ?? replayableTranscript.persistentSessionId,
            serializedBuffer: current?.serializedBuffer || replayableTranscript.buffer,
          });
          setupSessionUnavailableTabsRef.current.delete(tabId);
          return false;
        }
        lookupSettled = true;
        setupSessionBindAttemptsRef.current.delete(tabId);
        setupSessionUnavailableTabsRef.current.delete(tabId);
        terminalStore.setSession(key, {
          ...existing,
          sessionId: setupSession.sessionId,
        });
        return true;
      } catch (error) {
        if (setupSessionBindLifecycleGenerationRef.current !== lifecycleGeneration) {
          return false;
        }
        console.error("[TerminalContainer] Failed to bind backend setup session:", error);
        lookupFailed = true;
        // A failed probe is not evidence that either transcript source is gone.
        // Retry without requiring a reconnect or remount, while retaining the
        // existing finite budget for a setup-session lookup that never answers.
        const attempts = (setupSessionBindAttemptsRef.current.get(tabId) ?? 0) + 1;
        setupSessionBindAttemptsRef.current.set(tabId, attempts);
        if (attempts < MAX_SETUP_SESSION_BIND_ATTEMPTS) {
          const timer = setTimeout(
            () => {
              setupSessionBindRetryTimersRef.current.delete(tabId);
              if (setupSessionBindLifecycleGenerationRef.current === lifecycleGeneration) {
                setSetupSessionBindRetryNonce((value) => value + 1);
              }
            },
            setupSessionReconnectGenerationRef.current !== reconnectGeneration
              ? 0
              : SETUP_SESSION_BIND_RETRY_DELAY_MS * attempts,
          );
          setupSessionBindRetryTimersRef.current.set(tabId, timer);
        } else {
          setupSessionBindAttemptsRef.current.delete(tabId);
          if (!setupSessionLookupSucceeded) {
            lookupSettled = true;
            if (
              !useTerminalSessionStore.getState().sessions.get(setupSessionKeyForTab(tabId))
                ?.serializedBuffer
            ) {
              setupSessionUnavailableTabsRef.current.add(tabId);
            }
          }
        }
        return false;
      } finally {
        if (setupSessionBindInFlightRef.current.get(tabId) === requestToken) {
          setupSessionBindInFlightRef.current.delete(tabId);
        }
        const recheckPending = setupSessionRecheckPendingTabsRef.current.delete(tabId);
        if (
          lookupSettled &&
          setupSessionBindLifecycleGenerationRef.current === lifecycleGeneration
        ) {
          setupSessionBindSettledTabsRef.current.add(tabId);
          // Only a lookup that both started and settled after setup finished
          // counts as the post-setup check. One dispatched mid-run read a
          // backend that had not reached its final state, so recording it would
          // suppress the very re-check this flag exists to schedule.
          if (!startedWhileSetupRunning && !backendSetupRunningRef.current && !recheckPending) {
            setupSessionPostSetupCheckedTabsRef.current.add(tabId);
          }
          // The terminal store update itself rerenders PersistentTerminal. This
          // local nonce lets stale-tab cleanup distinguish a completed lookup
          // (including "no session") from the initial empty renderer store.
          setSetupSessionBindNonce((value) => value + 1);
        }
        // Re-dispatch the request the in-flight guard turned away. Skipped when
        // the lookup failed: the bounded retry above already owns re-arming, and
        // re-arming here too would hand a permanently failing backend a fresh
        // attempt budget on every round.
        if (
          recheckPending &&
          !lookupFailed &&
          setupSessionBindLifecycleGenerationRef.current === lifecycleGeneration
        ) {
          setSetupSessionBindRetryNonce((value) => value + 1);
        }
      }
    },
    [environmentId, hasBoundSetupSession, loadReplayableSetupTranscript, setupSessionKeyForTab],
  );

  useEffect(
    () => () => {
      setupSessionBindLifecycleGenerationRef.current += 1;
      for (const timer of setupSessionBindRetryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      setupSessionBindRetryTimersRef.current.clear();
      setupSessionBindAttemptsRef.current.clear();
      setupSessionBindInFlightRef.current.clear();
      setupSessionBindSettledTabsRef.current.clear();
      setupSessionPostSetupCheckedTabsRef.current.clear();
      setupSessionUnavailableTabsRef.current.clear();
      setupSessionRecheckPendingTabsRef.current.clear();
    },
    [environmentId],
  );

  useEffect(() => {
    if (!currentEnvState) return;

    const setupTabs = getAllLeaves(currentEnvState.root)
      .flatMap((leaf) => leaf.tabs)
      .filter(
        (tab) => tab.isSetupTab && (!tab.initialCommands || tab.initialCommands.length === 0),
      );

    // Every unbound setup tab, not just the first. Binding one at a time relied
    // on this effect re-running to reach the next, and a tab it never reaches is
    // never settled either — which stale-tab cleanup treats as "still looking"
    // and skips indefinitely.
    if (backendSetupRunning) {
      for (const tab of setupTabs) {
        setupSessionPostSetupCheckedTabsRef.current.delete(tab.id);
      }
    }
    const setupTabsToBind = setupTabs.filter(
      (tab) =>
        !hasBoundSetupSession(tab.id) ||
        (!backendSetupRunning && !setupSessionPostSetupCheckedTabsRef.current.has(tab.id)),
    );
    if (setupTabsToBind.length === 0) return;

    console.info("[setup-terminal] reconciling backend-managed setup tabs", {
      environmentId,
      tabIds: setupTabsToBind.map((tab) => tab.id),
      setupPhase,
      tabCount: setupTabs.length,
    });
    for (const tab of setupTabsToBind) void bindBackendSetupSession(tab.id);
  }, [
    bindBackendSetupSession,
    backendSetupRunning,
    currentEnvState,
    environmentId,
    hasBoundSetupSession,
    setupPhase,
    setupSessionBindRetryNonce,
    setupSessionReconnectNonce,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      if (disposed) return;
      setupSessionReconnectGenerationRef.current += 1;
      setSetupSessionReconnectNonce((value) => value + 1);
    })
      .then((release) => {
        if (disposed) release();
        else unlisten = release;
      })
      .catch((error) => {
        if (!disposed) {
          rendererDebugLog("[setup-terminal] failed to install reconnect listener", error);
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!currentEnvState || environment?.pendingAgentLaunch || backendSetupRunning) {
      return;
    }
    // `setupScriptsComplete` is deliberately not required here. Once a lookup
    // has settled and setup is not running, a backend-managed setup tab with no
    // `<environmentId>:setup` session to adopt is dead either way: it cannot
    // create its own PTY (`attachExistingOnly`) and `useTerminal` returns
    // silently rather than surfacing an error, so the pane just stays blank.
    // Removing it lets the initial-layout effect seed a working tab, which is
    // the same self-healing path the completed-setup case already relies on.
    //
    // The rebind effect above starts its backend lookup synchronously, but the
    // result is asynchronous. On a fresh renderer the terminal store is empty,
    // so treating that temporary absence as stale would remove the restored
    // setup tab and seed an ordinary PTY before iOS/web can adopt `:setup`.
    if (setupSessionBindInFlightRef.current.size > 0) return;

    const leaves = getAllLeaves(currentEnvState.root);
    for (const leaf of leaves) {
      const staleSetupTab = leaf.tabs.find((tab) => {
        if (!tab.isSetupTab || (tab.initialCommands && tab.initialCommands.length > 0)) {
          return false;
        }
        if (!setupSessionBindSettledTabsRef.current.has(tab.id)) return false;
        return setupSessionUnavailableTabsRef.current.has(tab.id);
      });

      if (staleSetupTab) {
        rendererDebugLog(
          "[TerminalContainer] Removing stale setup placeholder tab:",
          staleSetupTab.id,
        );
        removeTab(leaf.id, staleSetupTab.id, environmentId);
        return;
      }
    }
  }, [
    currentEnvState,
    environment?.pendingAgentLaunch,
    environmentId,
    removeTab,
    setupSessionBindNonce,
    backendSetupRunning,
  ]);

  // Set active environment when this container becomes active
  useEffect(() => {
    if (isActive) {
      setActiveEnvironment(environmentId);
    }
  }, [isActive, environmentId, setActiveEnvironment]);

  // Report a failed startup launch. The backend records it durably and keeps
  // retrying, but nothing else renders it: without this the user gets a plain
  // terminal, no agent tab, and an initial prompt that never arrives.
  const reportedStartupErrorRef = useRef<string | null>(null);
  // The three startupAgentSession fields this reads are listed individually, so
  // the object itself would only add re-runs when it is replaced unchanged.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const startupSession = environment?.startupAgentSession;
    if (startupSession?.status !== "error") {
      reportedStartupErrorRef.current = null;
      return;
    }
    const reason = startupSession.error ?? "The agent could not be started.";
    // Keyed on the message so a repeated retry failure does not re-toast, but a
    // different failure still does.
    if (reportedStartupErrorRef.current === reason) return;
    reportedStartupErrorRef.current = reason;
    toast.error(
      `${startupSession.agent} could not start in ${environment?.name ?? "this environment"}`,
      {
        description: reason,
        duration: 10_000,
      },
    );
  }, [
    environment?.name,
    environment?.startupAgentSession?.agent,
    environment?.startupAgentSession?.error,
    environment?.startupAgentSession?.status,
  ]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Represent backend-owned launch state after a mobile page reload. Native
  // launches are projected durably by the backend; this effect binds their
  // provider identity (and provides a short-lived optimistic representation)
  // while still materializing the remaining PTY/tmux launches.
  useEffect(() => {
    if (!environment) return;
    const startupSession = environment.startupAgentSession;
    // A starting or failed launch is still owned by the backend. In particular,
    // pendingAgentLaunch is the backend's retry intent after an error, so a
    // renderer must not project an ordinary text-only launch and clear it.
    if (startupSession && startupSession.status !== "running") return;
    if (startupLaunchDispatchedByBackend && (environment.pendingAgentLaunch || startupSession)) {
      if (
        !currentEnvState ||
        !isEnvironmentRunning ||
        (!setupReady && environment.setupScriptsComplete !== true)
      )
        return;
      const existingStartupTabId = findStartupAgentTabId(currentEnvState);
      if (existingStartupTabId) {
        if (startupSession?.providerSessionId) {
          usePaneLayoutStore
            .getState()
            .updateTabNativeSessionId(
              existingStartupTabId,
              startupSession.providerSessionId,
              environmentId,
            );
          if (pendingNativeLaunch) clearPendingNativeLaunch(environmentId);
          if (claudeOptions?.launchAgent) clearOptions(environmentId);
        }
        return;
      }
      if (pendingNativeLaunch) return;
      // Only an unconsumed backend intent may be projected optimistically. Once
      // the backend has consumed it the durable pane is authoritative, so a
      // missing startup tab means the user closed it — re-creating it here
      // would resurrect it on every render and permanently defeat the close.
      if (!environment.pendingAgentLaunch) return;
      const agentType = startupSession?.agent ?? resolveDefaultAgent(tiers);
      setPendingNativeLaunch(environmentId, {
        containerId: isLocalEnvironment ? null : containerId,
        environmentId,
        targetPaneId: currentEnvState.activePaneId,
        agentType,
        launchMode: "native",
        providerSessionId: startupSession?.providerSessionId,
        model: startupSession?.model ?? environment.initialAgentModel,
        reasoningEffort: startupSession?.reasoningEffort ?? environment.initialReasoningEffort,
      });
      return;
    }
    if (!environment.pendingAgentLaunch || !currentEnvState) {
      return;
    }

    const existingStartupTabId = findStartupAgentTabId(currentEnvState);
    if (existingStartupTabId) {
      if (durableLaunchClearInFlightRef.current) return;
      durableLaunchClearInFlightRef.current = true;
      const durablePaneState =
        usePaneLayoutStore.getState().environments.get(environmentId) ?? currentEnvState;
      // Persist the tab before clearing the launch intent. If the page is
      // evicted between these operations, the still-pending flag retries; if
      // clearing succeeds, rehydration is guaranteed to find the agent tab.
      // The write goes through the persistence loop's per-environment chain so
      // it uses the latest revision and cannot conflict with an older debounced
      // write after the launch flag has already been cleared.
      //
      // This flush is also what makes it safe to drop the backend's one-shot
      // `initialAgentModel`/`initialReasoningEffort` here even though the agent
      // surface may still be resolving a live model catalog: the flushed layout
      // carries those options on the tab, and `pane-layout-restore` reads them
      // back, so the tab is the durable carrier from this point on. Blocking the
      // clear until a consumer acknowledged instead would strand
      // `pendingAgentLaunch` forever whenever a surface reaches a steady state
      // without applying them (background mount, empty catalog, init error),
      // which keeps the environment hidden-mounted and polled for the life of
      // the app.
      void flushPaneLayoutNow(environmentId, createPersistedPaneLayoutInput(durablePaneState))
        .then(() => backend.setEnvironmentPendingAgentLaunch(environmentId, false))
        .then((updatedEnvironment) => {
          useEnvironmentStore.getState().updateEnvironment(environmentId, updatedEnvironment);
        })
        .catch((error) => {
          console.warn(
            `[TerminalContainer] Failed to clear durable agent launch for ${environmentId}:`,
            error,
          );
        })
        .finally(() => {
          durableLaunchClearInFlightRef.current = false;
        });
      return;
    }

    // The uninterrupted create flow still owns this launch while its transient
    // options exist. In particular, it may be staging initial-prompt images and
    // rewriting the prompt with their workspace paths. Reconstructing the
    // backend intent at the same time queues the older text-only prompt; once
    // staging finishes, both paths create an agent tab. A renderer reload has no
    // transient options, so durable recovery continues through the branch below.
    if (claudeOptions?.launchAgent) return;
    if (!isEnvironmentRunning || pendingNativeLaunch) return;

    const agentType = resolveDefaultAgent(tiers);
    const launchMode =
      (agentType === "claude" && claudeMode === "native") ||
      (agentType === "codex" && codexMode === "native") ||
      (agentType === "opencode" && opencodeMode === "native") ||
      (agentType === "pi" && piMode === "native")
        ? "native"
        : "terminal";

    setPendingNativeLaunch(environmentId, {
      containerId: isLocalEnvironment ? null : containerId,
      environmentId,
      initialPrompt: environment.initialPrompt?.trim() || undefined,
      targetPaneId: currentEnvState.activePaneId,
      agentType,
      launchMode,
      claudeNativeBackend:
        agentType === "claude" && launchMode === "native" ? claudeNativeBackend : undefined,
      model: environment.initialAgentModel,
      reasoningEffort: environment.initialReasoningEffort,
    });
  }, [
    claudeMode,
    claudeNativeBackend,
    claudeOptions?.launchAgent,
    codexMode,
    tiers,
    containerId,
    currentEnvState,
    clearPendingNativeLaunch,
    environment,
    environmentId,
    isEnvironmentRunning,
    isLocalEnvironment,
    opencodeMode,
    piMode,
    pendingNativeLaunch,
    setupReady,
    startupLaunchDispatchedByBackend,
    clearOptions,
    setPendingNativeLaunch,
  ]);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Initialize pane layout from the backend-owned setup phase.
  useEffect(() => {
    if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return;
    if (setupPhase === "pending") return;

    // Check if we need to initialize (no tabs yet for THIS environment)
    const currentTabs = currentEnvState
      ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs)
      : [];
    // A build tab is inserted by the pipeline supervisor as soon as the backend
    // returns, which is before this environment is running and therefore always
    // before this effect can run. It is not part of the layout seeded here, so
    // counting it would suppress the initial layout entirely: no setup tab, no
    // default terminal, and initialize() — which records the containerId the
    // terminal session keys derive from — would never run.
    const seededTabs = currentTabs.filter((tab) => tab.type !== "claude-build");
    // Hydration is authoritative even when another surface inserted a tab
    // before this container mounted (notably a backend-created build tab).
    // finishHydration reconciles tabs added during the request with the
    // restored snapshot, so start the restore before using tab count to decide
    // whether a default terminal needs to be seeded.
    if (!backendSetupRunning) {
      if (hydrationStatus === "pending") return;
      if (hydrationStatus === undefined) {
        beginHydration(environmentId);
        void Promise.allSettled([
          backend.getPaneLayout(environmentId),
          hydrateLoopedReviewWorkflowsForEnvironment(environmentId),
          hydrateMultiReviewWorkflowsForEnvironment(environmentId),
        ]).then(([layoutResult, workflowResult, multiReviewResult]) => {
          const paneStore = usePaneLayoutStore.getState();
          if (paneStore.hydration.get(environmentId) !== "pending") return;

          if (workflowResult.status === "rejected") {
            console.warn(
              "[TerminalContainer] Failed to restore looped reviews:",
              workflowResult.reason,
            );
          }
          if (multiReviewResult.status === "rejected") {
            console.warn(
              "[TerminalContainer] Failed to restore multi reviews:",
              multiReviewResult.reason,
            );
          }
          const latestEnvironment = useEnvironmentStore
            .getState()
            .getEnvironmentById(environmentId);
          const latestContainerId = latestEnvironment
            ? latestEnvironment.environmentType === "local"
              ? null
              : latestEnvironment.containerId
            : isLocalEnvironment
              ? null
              : containerId;

          if (layoutResult.status === "rejected") {
            console.warn("[TerminalContainer] Failed to restore pane layout:", layoutResult.reason);
            // Register the environment so a later pane-layout announcement
            // can apply. finishHydration without a snapshot does not.
            // Skip when a local record already exists: rewriting it would
            // retrigger setup-session binding for a tab this renderer seeded.
            if (!paneStore.environments.has(environmentId)) {
              paneStore.initialize(latestContainerId, environmentId);
            }
            paneStore.finishHydration(environmentId);
            return;
          }

          if (!latestEnvironment) {
            paneStore.finishHydration(environmentId);
            return;
          }

          const persisted = layoutResult.value;
          const restoredSnapshot = reconcilePersistedLayout(persisted, {
            environmentId,
            containerId: latestContainerId,
            isLocal: latestEnvironment.environmentType === "local",
            worktreePath: latestEnvironment.worktreePath,
            hasBuildPipeline: (pipelineId) =>
              useBuildPipelineStore.getState().pipelines.has(pipelineId),
            hasLoopedReview: (workflowId) =>
              // A failed workflow-list request means existence is unknown,
              // not that every persisted review was deleted. Preserve those
              // tabs so their own read-through view can retry hydration.
              workflowResult.status === "rejected" ||
              useLoopedReviewStore.getState().workflows.has(workflowId),
            hasMultiReview: (workflowId) =>
              multiReviewResult.status === "rejected" ||
              useMultiReviewStore.getState().workflows.has(workflowId),
          });
          const restored =
            restoredSnapshot && persisted?.version === LEGACY_PANE_LAYOUT_VERSION
              ? applyStoredPaneSelection(
                  restoredSnapshot,
                  environmentId,
                  readStoredPaneSelection(environmentId),
                )
              : restoredSnapshot;
          if (!restored && !paneStore.environments.has(environmentId)) {
            // Same empty-hydration contract as a rejected fetch: the
            // pane-store record must exist before hydration is marked done,
            // or deferred pane-layout refreshes no-op.
            paneStore.initialize(latestContainerId, environmentId);
          }
          paneStore.finishHydration(environmentId, restored ?? undefined);

          // A successful migration may have been performed by this renderer
          // on an earlier launch or by another client. Once v2 is observed,
          // the renderer-local v1 selection can no longer be useful.
          if (persisted?.version === PANE_LAYOUT_VERSION) {
            clearStoredPaneSelection(environmentId);
            if (restored) {
              void migratePaneLayoutBrowserHistory(environmentId, persisted).catch((error) => {
                console.warn(
                  "[TerminalContainer] Failed to migrate browser history privacy fields:",
                  error,
                );
              });
            } else {
              // A stale-generation or malformed current-version snapshot
              // cannot safely be rewritten as renderer state. Remove only
              // the exact revision we inspected; a concurrent newer layout
              // wins the CAS and is preserved for the next reconciliation.
              void backend.deletePaneLayout(environmentId, persisted.revision).catch((error) => {
                console.warn(
                  "[TerminalContainer] Failed to remove an unusable pane layout snapshot:",
                  error,
                );
              });
            }
          }

          if (restored && persisted && persisted.version < PANE_LAYOUT_VERSION) {
            // V1 contributes renderer-local selection; v2 contributes legacy
            // provider-specific native tab records. Reconciliation has now
            // converted either schema to v3, so persist that exact snapshot
            // through the normal CAS chain before considering it migrated.
            const migrated = usePaneLayoutStore.getState().environments.get(environmentId);
            if (migrated) {
              void flushPaneLayoutNow(environmentId, createPersistedPaneLayoutInput(migrated))
                .then(() => {
                  if (persisted.version === LEGACY_PANE_LAYOUT_VERSION) {
                    clearStoredPaneSelection(environmentId);
                  }
                })
                .catch((error) => {
                  console.warn(
                    "[TerminalContainer] Failed to migrate legacy pane selection:",
                    error,
                  );
                });
            }
          }
        });
        return;
      }
    }

    if (seededTabs.length === 0) {
      console.info("[setup-terminal] initial terminal layout decision", {
        environmentId,
        backendSetupRunning,
        setupPhase,
        hasDefaultSetupSession: hasBoundSetupSession("default"),
        isLocalEnvironment,
        worktreePath: worktreePath ?? null,
        containerId,
      });
      if (backendSetupRunning && !hasBoundSetupSession("default")) {
        console.info("[setup-terminal] waiting for setup session before adding setup tab", {
          environmentId,
          tabId: "default",
        });
        void bindBackendSetupSession("default");
        return;
      }

      if (backendSetupRunning) {
        // Setup owns the temporary layout. Mark hydration complete without
        // restoring an older layout so the setup/default layout can persist.
        if (hydrationStatus !== "done") finishHydration(environmentId);
      }

      // A native startup surface is a backend-owned pane projection. Once
      // setup has finished, an empty renderer waits for that authoritative
      // snapshot/event instead of manufacturing a competing tab locally.
      // initialize() still runs: finishHydration without a restored snapshot
      // does not create a pane-store record, and later pane-layout events
      // cannot apply to an environment that was never registered.
      if (
        !backendSetupRunning &&
        environment?.pendingAgentLaunch === true &&
        startupLaunchDispatchedByBackend
      ) {
        if (!usePaneLayoutStore.getState().environments.has(environmentId)) {
          initialize(containerId, environmentId);
        }
        return;
      }

      const pendingAttachments = claudeOptions?.initialPromptAttachments ?? [];
      /*
       * A native launch is dispatched by the backend, which stages these images
       * itself and hands the bridge real attachments — so the transcript shows a
       * thumbnail. Rewriting the prompt into a plain list of paths here would
       * destroy that: it also clears the stored attachments, so whichever of the
       * two paths happened to run first decided whether the user ever saw their
       * image. Terminal and Claude-tmux launches keep the rewrite, because a
       * prompt typed into a PTY has no way to carry an attachment.
       */
      const backendStagesAttachments =
        environment?.pendingAgentLaunch === true && startupLaunchDispatchedByBackend;
      if (
        claudeOptions?.launchAgent &&
        pendingAttachments.length > 0 &&
        !backendStagesAttachments
      ) {
        if (!isSavingInitialPromptAttachmentsRef.current) {
          isSavingInitialPromptAttachmentsRef.current = true;
          void (async () => {
            try {
              const savedAttachments = await saveInitialPromptAttachments({
                attachments: pendingAttachments,
                environmentId,
              });
              const currentOptions = useClaudeOptionsStore.getState().getOptions(environmentId);
              if (!currentOptions) return;

              const promptWithReferences = buildInitialPromptWithAttachmentReferences(
                currentOptions.initialPrompt,
                savedAttachments,
              );
              setOptions(environmentId, {
                ...currentOptions,
                initialPrompt: promptWithReferences,
                initialPromptAttachments: [],
              });

              // The attachments now live in the workspace, but the references to
              // them only existed in this renderer's options store. Persist the
              // rewritten prompt so a launch recovered after page eviction reads
              // a prompt whose references still resolve, instead of the raw text
              // the user typed. (Eviction *before* this point still loses the
              // attachments themselves — they are never persisted.)
              if (
                promptWithReferences !== currentOptions.initialPrompt ||
                pendingAttachments.length > 0
              ) {
                try {
                  const updatedEnvironment = await backend.setEnvironmentInitialPrompt(
                    environmentId,
                    promptWithReferences,
                    [],
                  );
                  useEnvironmentStore
                    .getState()
                    .updateEnvironment(environmentId, updatedEnvironment);
                } catch (error) {
                  console.warn(
                    "[TerminalContainer] Failed to persist initial prompt attachment references:",
                    error,
                  );
                }
              }
            } catch (error) {
              console.error(
                "[TerminalContainer] Failed to save initial prompt attachments:",
                error,
              );
              // Keep both renderer and backend copies so a later retry can
              // recover the images rather than silently launching without
              // them.
            } finally {
              isSavingInitialPromptAttachmentsRef.current = false;
            }
          })();
        }
        return;
      }

      initialize(containerId, environmentId);
      // A restored/shared build-only layout can use a non-default pane id.
      // Seed the ordinary/setup tab into the pane that actually survived
      // hydration; targeting the literal "default" would be a no-op and make
      // this effect initialize forever because build tabs are excluded from
      // `seededTabs` above.
      const initialPaneId =
        usePaneLayoutStore.getState().environments.get(environmentId)?.activePaneId ?? "default";

      // Determine initial tab type based on agent options
      let initialTabType: TerminalTabType = "plain";
      let pendingInitialPrompt: string | undefined;
      let initialAgentModel: string | undefined;
      let initialReasoningEffort: string | undefined;
      const launchAgent = claudeOptions?.launchAgent ?? false;
      if (launchAgent) {
        initialTabType = claudeOptions!.agentType;
        initialAgentModel = claudeOptions!.model;
        initialReasoningEffort = claudeOptions!.reasoningEffort;
        setHasAppliedClaudeOptions(true);
        if (claudeOptions!.initialPrompt?.trim()) {
          pendingInitialPrompt = claudeOptions!.initialPrompt.trim();
          initialPromptRef.current = pendingInitialPrompt;
        }
      }
      const initialTabId =
        launchAgent && initialTabType !== "plain" ? STARTUP_AGENT_TAB_ID : "default";

      // Check if we should use native mode instead of terminal
      const useNativeOpenCode = initialTabType === "opencode" && opencodeMode === "native";
      const useNativeClaude = initialTabType === "claude" && claudeMode === "native";
      const useNativeCodex = initialTabType === "codex" && codexMode === "native";
      const useNativeAcp =
        initialTabType === "cursor" ||
        initialTabType === "grok" ||
        (initialTabType === "pi" && piMode === "native");

      if (backendSetupRunning) {
        console.info("[setup-terminal] adding backend-managed setup tab", {
          environmentId,
          tabId: "default",
          hasDefaultSetupSession: hasBoundSetupSession("default"),
        });
        if (launchAgent && initialTabType !== "plain" && !startupLaunchDispatchedByBackend) {
          setPendingNativeLaunch(environmentId, {
            containerId: isLocalEnvironment ? null : containerId,
            environmentId,
            initialPrompt: pendingInitialPrompt,
            targetPaneId: initialPaneId,
            agentType: initialTabType,
            launchMode:
              useNativeOpenCode || useNativeClaude || useNativeCodex || useNativeAcp
                ? "native"
                : "terminal",
            claudeNativeBackend: useNativeClaude ? claudeNativeBackend : undefined,
            model: initialAgentModel,
            reasoningEffort: initialReasoningEffort,
          });
        }

        const setupTab: TabInfo = {
          id: "default",
          type: "plain",
          isSetupTab: true,
        };
        addTab(initialPaneId, setupTab, environmentId);
        return;
      }

      rendererDebugLog("[TerminalContainer] Initial tab decision:", {
        agentType: claudeOptions?.agentType,
        launchAgent,
        opencodeMode,
        claudeMode,
        codexMode,
        useNativeOpenCode,
        useNativeClaude,
        useNativeCodex,
        useNativeAcp,
        isLocalEnvironment,
        setupPhase,
      });
      if (useNativeClaude) {
        addTab(
          initialPaneId,
          createClaudeNativeLikeTab({
            id: initialTabId,
            nativeBackend: claudeNativeBackend,
            containerId: isLocalEnvironment ? undefined : (containerId ?? undefined),
            environmentId,
            isLocal: isLocalEnvironment,
            initialPrompt: pendingInitialPrompt,
            initialAgentModel,
            initialReasoningEffort,
          }),
          environmentId,
        );
      } else if (useNativeCodex || useNativeOpenCode || useNativeAcp) {
        const platform = initialTabType as AgentPlatform;
        addTab(
          initialPaneId,
          createAgentNativeTab({
            id: initialTabId,
            platform,
            containerId: containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
            initialPrompt: pendingInitialPrompt,
            initialAgentModel,
            initialReasoningEffort,
          }),
          environmentId,
        );
      } else {
        addTab(
          initialPaneId,
          {
            id: initialTabId,
            type: initialTabType,
            initialPrompt: pendingInitialPrompt,
            initialAgentModel,
            initialReasoningEffort,
          },
          environmentId,
        );
      }
    }
  }, [
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    isLocalEnvironment,
    setupPhase,
    backendSetupRunning,
    claudeOptions,
    initialize,
    addTab,
    environmentId,
    currentEnvState,
    environment?.pendingAgentLaunch,
    startupLaunchDispatchedByBackend,
    hydrationStatus,
    beginHydration,
    finishHydration,
    opencodeMode,
    claudeMode,
    claudeNativeBackend,
    codexMode,
    piMode,
    setPendingNativeLaunch,
    setOptions,
    worktreePath,
    hasBoundSetupSession,
    bindBackendSetupSession,
    setupSessionBindNonce,
  ]);

  // Reset pane layout when container changes within the same environment
  // (e.g., container was stopped and restarted with a new ID).
  //
  // The environment is part of the comparison, not just the container. This
  // component is rendered without a `key` (App.tsx), so selecting a different
  // environment reuses the same instance and changes `environmentId` and
  // `containerId` in the same commit. Comparing containers alone read that as a
  // restart and reset the environment the user had just selected — destroying
  // the panes, terminals and pending launch of an environment that was working
  // in the background. A cross-environment change is never a restart.
  useEffect(() => {
    const isSameEnvironment = previousEnvironmentIdRef.current === environmentId;
    if (
      isSameEnvironment &&
      previousContainerIdRef.current !== null &&
      previousContainerIdRef.current !== containerId
    ) {
      rendererDebugLog(
        "[TerminalContainer] Container changed for environment:",
        environmentId,
        "resetting panes",
      );
      reset(environmentId);
      setHasAppliedClaudeOptions(false);
      clearPendingNativeLaunch(environmentId);
    }
    previousContainerIdRef.current = containerId;
    previousEnvironmentIdRef.current = environmentId;
  }, [containerId, environmentId, reset, clearPendingNativeLaunch]);

  // Reset pane layout when the container stops.
  // This clears all terminals and tabs since their backend sessions are destroyed
  useEffect(() => {
    if (!isContainerRunning && containerId) {
      rendererDebugLog(
        "[TerminalContainer] Container stopped, resetting panes for environment:",
        environmentId,
      );
      reset(environmentId);
      // Clear pending native OpenCode launch on container stop
      clearPendingNativeLaunch(environmentId);
    }
  }, [isContainerRunning, environmentId, containerId, reset, clearPendingNativeLaunch]);

  // The backend publishes the startup agent while setup still runs, and this
  // renderer keeps the setup terminal selected so the user can watch it. When
  // setup becomes ready, move focus onto that agent — including when the
  // durable-launch effect is still blocked on a `starting` session.
  //
  // Gated on the launch intent, not on `setupReady` alone. Setup readiness and
  // the setup tab's `isSetupTab` flag both outlive the launch by the life of the
  // environment, so without this gate a reload or a remount would hand focus off
  // again every time the user happened to be sitting on that terminal.
  useEffect(() => {
    if (!setupReady || !isStartupLaunchPending) {
      handedOffSetupFocusRef.current.delete(environmentId);
      return;
    }
    if (!currentEnvState) return;
    if (handedOffSetupFocusRef.current.has(environmentId)) return;
    const startupTabId = findStartupAgentTabId(currentEnvState);
    if (!startupTabId) return;
    handoffSetupFocusToStartupAgent(environmentId, currentEnvState, startupTabId);
    handedOffSetupFocusRef.current.add(environmentId);
  }, [setupReady, isStartupLaunchPending, currentEnvState, environmentId]);

  // Launch native tab after workspace setup completes
  useEffect(() => {
    const canLaunchPendingNative =
      setupReady && pendingNativeLaunch && (containerId || isLocalEnvironmentReady);
    rendererDebugLog(
      "[TerminalContainer] Native tab effect check - setupPhase:",
      setupPhase,
      "hasPending:",
      !!pendingNativeLaunch,
      "containerId:",
      !!containerId,
      "isLocalEnvironmentReady:",
      isLocalEnvironmentReady,
    );

    // Simple logic: when workspace is ready and we have a pending launch, create the tab
    // For local environments, containerId is null so we check isLocalEnvironmentReady (worktreePath exists)
    if (canLaunchPendingNative) {
      const pending = pendingNativeLaunch;

      // Only launch if this is for the current container/environment
      // For local envs, both containerId values are null, so we also check environmentId
      const containerMatch = isLocalEnvironment
        ? pending.containerId === null && pending.environmentId === environmentId
        : pending.containerId === containerId && pending.environmentId === environmentId;

      if (containerMatch) {
        const isClaudeNative = pending.agentType === "claude";
        const isCodexNative = pending.agentType === "codex";
        const launchMode = pending.launchMode ?? "native";
        rendererDebugLog(
          "[TerminalContainer] Workspace ready, launching",
          launchMode,
          isClaudeNative ? "Claude" : isCodexNative ? "Codex" : "OpenCode",
          "tab for environment:",
          environmentId,
        );

        const newTabId = STARTUP_AGENT_TAB_ID;
        const paneStore = usePaneLayoutStore.getState();
        const livePaneState = paneStore.environments.get(environmentId);
        const targetPaneId = paneStore.getPane(pending.targetPaneId, environmentId)
          ? pending.targetPaneId
          : livePaneState && paneStore.getPane(livePaneState.activePaneId, environmentId)
            ? livePaneState.activePaneId
            : livePaneState
              ? getAllLeaves(livePaneState.root)[0]?.id
              : undefined;
        if (!targetPaneId) {
          console.warn(
            "[TerminalContainer] Deferred native launch because no pane is available:",
            environmentId,
          );
          return;
        }
        if (launchMode === "terminal") {
          const newTab: TabInfo = {
            id: newTabId,
            type: pending.agentType,
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          };
          addTab(targetPaneId, newTab, environmentId);
        } else if (isClaudeNative) {
          const backend = pending.claudeNativeBackend ?? claudeNativeBackend;
          const newTab = createClaudeNativeLikeTab({
            id: newTabId,
            nativeBackend: backend,
            containerId: pending.containerId ?? undefined,
            environmentId: pending.environmentId,
            isLocal: isLocalEnvironment,
            sessionId: pending.providerSessionId,
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          });
          addTab(targetPaneId, newTab, environmentId);
        } else {
          const newTab = createAgentNativeTab({
            id: newTabId,
            platform: pending.agentType,
            containerId: pending.containerId ?? undefined,
            environmentId: pending.environmentId,
            isLocal: isLocalEnvironment,
            sessionId: pending.providerSessionId,
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          });
          addTab(targetPaneId, newTab, environmentId);
        }

        // Clear the pending launch
        clearPendingNativeLaunch(environmentId);
        clearOptions(environmentId);
      }
    }
  }, [
    setupReady,
    setupPhase,
    pendingNativeLaunch,
    containerId,
    environmentId,
    isLocalEnvironment,
    isLocalEnvironmentReady,
    addTab,
    clearPendingNativeLaunch,
    clearOptions,
    claudeNativeBackend,
  ]);

  // Register terminal write function with context
  useEffect(() => {
    if (!isActive) return;

    if (activeWriteRef.current) {
      setTerminalWrite(activeWriteRef.current);
    } else {
      setTerminalWrite(null);
    }

    return () => {
      setTerminalWrite(null);
    };
  }, [isActive, setTerminalWrite, activePaneId]);

  const createBrowserTab = useCallback(
    (initialUrl: string | undefined, targetPaneId = activePaneId, displayTitle?: string) => {
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) {
        return false;
      }

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        rendererDebugLog("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        showTabLimitReachedToast(MAX_TABS);
        return false;
      }

      if (!usePaneLayoutStore.getState().getPane(targetPaneId, environmentId)) {
        return false;
      }

      const newTabId = createUniqueTabId("tab");
      const newTab: TabInfo = {
        id: newTabId,
        type: "browser",
        browserData: { url: initialUrl?.trim() ?? "" },
        displayTitle,
      };
      rendererDebugLog(
        "[TerminalContainer] Creating browser tab:",
        newTabId,
        "for environment:",
        environmentId,
      );
      addTab(targetPaneId, newTab, environmentId);
      return true;
    },
    [
      activePaneId,
      addTab,
      containerId,
      environmentId,
      getAllTabs,
      isEnvironmentRunning,
      isLocalEnvironmentReady,
    ],
  );

  useEffect(
    () =>
      listenForTerminalBrowserTabRequests((request) => {
        if (request.environmentId !== environmentId) return;

        const pane = usePaneLayoutStore
          .getState()
          .findPaneWithTab(request.sourceTabId, environmentId);
        if (!pane) return;

        if (createBrowserTab(request.url, pane.id)) {
          usePaneLayoutStore.getState().setActivePane(pane.id, environmentId);
        }
      }),
    [createBrowserTab, environmentId],
  );

  // Handler for creating new terminal tabs
  const handleCreateTab = useCallback(
    (type: CreatableTabType, options?: CreateTabOptions): boolean => {
      // For local environments, we don't need a containerId but do need worktreePath to be set
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return false;

      const allTabs = getAllTabs(environmentId);
      // A Multi Review workflow outlives the tab that launched it, so reopening
      // one is a normal request rather than a duplicate: the launcher reattaches
      // to an already-active workflow whose tab was closed. Activating the open
      // view keeps that idempotent, and it is resolved before the tab limit
      // because showing a tab that already exists adds nothing to count.
      if (type === "multi-review" && options?.multiReviewId) {
        const openTab = allTabs.find(
          (tab) =>
            tab.type === "multi-review" &&
            tab.multiReviewTabData?.workflowId === options.multiReviewId &&
            tab.multiReviewTabData?.reviewerId === options.multiReviewReviewerId,
        );
        if (openTab) {
          const pane = usePaneLayoutStore.getState().findPaneWithTab(openTab.id, environmentId);
          if (pane) {
            usePaneLayoutStore.getState().setActivePane(pane.id, environmentId);
            usePaneLayoutStore.getState().setActiveTab(pane.id, openTab.id, environmentId);
          }
          return true;
        }
      }

      // Selected durable workflows use caller-owned ids as idempotent focus
      // intents. Other callers retain collision reporting so they can roll back
      // any state they created specifically for a new tab.
      const requestedTabId = options?.tabId?.trim();
      if (requestedTabId) {
        const openTab = allTabs.find((tab) => tab.id === requestedTabId);
        if (openTab) {
          if (options?.activateExistingTab !== true) {
            console.warn("[TerminalContainer] Refusing duplicate tab ID:", requestedTabId);
            return false;
          }
          const pane = usePaneLayoutStore.getState().findPaneWithTab(openTab.id, environmentId);
          if (!pane) return false;
          usePaneLayoutStore.getState().setActivePane(pane.id, environmentId);
          usePaneLayoutStore.getState().setActiveTab(pane.id, openTab.id, environmentId);
          return true;
        }
      }

      if (allTabs.length >= MAX_TABS) {
        rendererDebugLog("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        showTabLimitReachedToast(MAX_TABS);
        return false;
      }

      if (type === "browser") {
        return createBrowserTab(options?.initialUrl, activePaneId, options?.displayTitle);
      }

      if (type === "looped-review") {
        if (!options?.loopedReviewId) {
          console.warn("[TerminalContainer] Refusing looped-review tab without workflow ID");
          return false;
        }
        const newTab: TabInfo = {
          id: createUniqueTabId("looped-review"),
          type: "looped-review",
          displayTitle: options.displayTitle ?? "Looped Review",
          loopedReviewTabData: {
            environmentId,
            workflowId: options.loopedReviewId,
            isLocal: isLocalEnvironment,
          },
        };
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      if (type === "multi-review") {
        if (!options?.multiReviewId) {
          console.warn("[TerminalContainer] Refusing multi-review tab without workflow ID");
          return false;
        }
        const newTab: TabInfo = {
          id: createUniqueTabId("multi-review"),
          type: "multi-review",
          displayTitle: options.displayTitle ?? "Multi Review",
          multiReviewTabData: {
            environmentId,
            workflowId: options.multiReviewId,
            ...(options.multiReviewReviewerId ? { reviewerId: options.multiReviewReviewerId } : {}),
            isLocal: isLocalEnvironment,
          },
        };
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      const newTabId = requestedTabId || createUniqueTabId("tab");

      if (type === "agent-native") {
        const newTab = createAgentNativeTab({
          id: newTabId,
          platform: undefined,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          displayTitle: options?.displayTitle,
        });
        rendererDebugLog(
          "[TerminalContainer] Creating unassigned agent-native tab:",
          newTabId,
          "for environment:",
          environmentId,
        );
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      const launchModeOverride = options?.agentLaunchMode;
      const shouldUseOpenCodeNative =
        type === "opencode" &&
        (launchModeOverride === "native" || (!launchModeOverride && opencodeMode === "native"));
      const shouldUseClaudeNative =
        type === "claude" &&
        (launchModeOverride === "native" ||
          launchModeOverride === "tmux" ||
          (!launchModeOverride && claudeMode === "native"));
      const shouldUseCodexNative =
        type === "codex" &&
        (launchModeOverride === "native" || (!launchModeOverride && codexMode === "native"));
      const shouldUseAcpNative =
        type === "cursor" ||
        (type === "grok" && launchModeOverride !== "cli") ||
        (type === "pi" &&
          (launchModeOverride === "native" || (!launchModeOverride && piMode === "native")));
      const prelockNativePlatform = Boolean(
        options?.initialPrompt ||
        options?.isReviewTab ||
        options?.resumeSessionId ||
        options?.initialAgentModel ||
        options?.initialReasoningEffort ||
        options?.initialConversationMode,
      );

      // Check if we should create an opencode-native tab instead
      if (shouldUseOpenCodeNative) {
        const newTab = createAgentNativeTab({
          id: newTabId,
          platform: prelockNativePlatform ? "opencode" : undefined,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          sessionId: options?.resumeSessionId,
          requireExistingResumeSession: options?.requireExistingResumeSession,
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
        });
        rendererDebugLog(
          "[TerminalContainer] Creating opencode-native tab:",
          newTabId,
          "for environment:",
          environmentId,
          "isLocal:",
          isLocalEnvironment,
          "initialPrompt:",
          !!options?.initialPrompt,
        );
        seedDeferredNativePlatform(newTab, "opencode");
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      // Native Claude mode → pick the backend (SDK or tmux) by 3-tier resolution.
      if (shouldUseClaudeNative) {
        const backend =
          launchModeOverride === "native"
            ? "sdk"
            : launchModeOverride === "tmux"
              ? "tmux"
              : claudeNativeBackend;

        const newTab = createClaudeNativeLikeTab({
          id: newTabId,
          nativeBackend: backend,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
          sessionId: options?.resumeSessionId,
          requireExistingResumeSession: options?.requireExistingResumeSession,
          deferPlatform: !prelockNativePlatform,
        });
        rendererDebugLog(
          "[TerminalContainer] Creating",
          newTab.type,
          "tab:",
          newTabId,
          "for environment:",
          environmentId,
          "isLocal:",
          isLocalEnvironment,
          "initialPrompt:",
          !!options?.initialPrompt,
        );
        seedDeferredNativePlatform(newTab, "claude");
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      if (shouldUseCodexNative) {
        const newTab = createAgentNativeTab({
          id: newTabId,
          platform: prelockNativePlatform ? "codex" : undefined,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          sessionId: options?.resumeSessionId,
          requireExistingResumeSession: options?.requireExistingResumeSession,
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
        });
        rendererDebugLog(
          "[TerminalContainer] Creating codex-native tab:",
          newTabId,
          "for environment:",
          environmentId,
          "isLocal:",
          isLocalEnvironment,
          "initialPrompt:",
          !!options?.initialPrompt,
        );
        seedDeferredNativePlatform(newTab, "codex");
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      if (shouldUseAcpNative) {
        const provider = type as "cursor" | "grok" | "pi";
        const newTab = createAgentNativeTab({
          id: newTabId,
          platform: prelockNativePlatform ? provider : undefined,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          sessionId: options?.resumeSessionId,
          requireExistingResumeSession: options?.requireExistingResumeSession,
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
        });
        seedDeferredNativePlatform(newTab, provider);
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      const newTab: TabInfo = {
        id: newTabId,
        type,
        initialPrompt: options?.initialPrompt,
        initialCommands: options?.initialCommands,
        displayTitle: options?.displayTitle,
        isReviewTab: options?.isReviewTab,
        initialAgentModel: options?.initialAgentModel,
        initialReasoningEffort: options?.initialReasoningEffort,
        initialConversationMode: options?.initialConversationMode,
      };

      rendererDebugLog(
        "[TerminalContainer] Creating new tab:",
        newTabId,
        "type:",
        type,
        "for environment:",
        environmentId,
      );
      addTab(activePaneId, newTab, environmentId);
      return true;
    },
    [
      containerId,
      isEnvironmentRunning,
      activePaneId,
      addTab,
      getAllTabs,
      environmentId,
      opencodeMode,
      claudeMode,
      claudeNativeBackend,
      codexMode,
      piMode,
      isLocalEnvironmentReady,
      isLocalEnvironment,
      createBrowserTab,
    ],
  );

  useEffect(() => {
    if (!isActive || !window.orkestrator) return;

    return window.orkestrator.listen<BrowserPreviewOpenLinkEvent>(
      "browser-preview-open-link",
      ({ tabId, url }) => {
        const sourcePane = usePaneLayoutStore.getState().findPaneWithTab(tabId, environmentId);
        const sourceTab = sourcePane?.tabs.find((tab) => tab.id === tabId);
        if (!sourcePane || sourceTab?.type !== "browser") return;
        if (createBrowserTab(url, sourcePane.id)) {
          usePaneLayoutStore.getState().setActivePane(sourcePane.id, environmentId);
        }
      },
    );
  }, [createBrowserTab, environmentId, isActive]);

  // Handler for creating file viewer tabs
  const handleCreateFileTab = useCallback(
    (filePath: string, options?: CreateFileTabOptions) => {
      // For container environments, need containerId and running state
      // For local environments, need worktreePath
      const canCreateForContainer = containerId && isContainerRunning;
      const canCreateForLocal = isLocalEnvironment && worktreePath;
      if (!canCreateForContainer && !canCreateForLocal) return;

      const allTabs = getAllTabs(environmentId);
      // Check if file is already open - need to match both path AND diff mode
      // Note: This intentionally allows the same file to be open twice if one is in
      // diff mode and one is in regular file mode, as they serve different purposes
      const existingTab = allTabs.find(
        (t) =>
          t.type === "file" &&
          t.fileData?.filePath === filePath &&
          t.fileData?.isDiff === (options?.isDiff ?? false),
      );
      if (existingTab) {
        // Activate the existing tab instead of creating a duplicate
        const pane = usePaneLayoutStore.getState().findPaneWithTab(existingTab.id, environmentId);
        if (pane) {
          usePaneLayoutStore.getState().setActiveTab(pane.id, existingTab.id, environmentId);
          rendererDebugLog(
            "[TerminalContainer] Activated existing tab:",
            existingTab.id,
            "in pane:",
            pane.id,
          );
        }
        return;
      }

      if (allTabs.length >= MAX_TABS) {
        rendererDebugLog("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        showTabLimitReachedToast(MAX_TABS);
        return;
      }

      const newTabId = createUniqueTabId("file");
      // Validate gitStatus using type guard instead of unsafe cast
      const validatedGitStatus = isGitFileStatus(options?.gitStatus)
        ? options.gitStatus
        : undefined;
      const newTab: TabInfo = {
        id: newTabId,
        type: "file",
        fileData: {
          filePath,
          containerId: isLocalEnvironment ? undefined : (containerId ?? undefined),
          worktreePath: isLocalEnvironment ? worktreePath : undefined,
          isLocalEnvironment,
          isDiff: options?.isDiff,
          gitStatus: validatedGitStatus,
          baseBranch: undefined,
        },
      };

      rendererDebugLog(
        "[TerminalContainer] Creating file tab:",
        newTabId,
        "path:",
        filePath,
        "isDiff:",
        options?.isDiff,
        "isLocal:",
        isLocalEnvironment,
        "for environment:",
        environmentId,
      );
      addTab(activePaneId, newTab, environmentId);
    },
    [
      containerId,
      isContainerRunning,
      isLocalEnvironment,
      worktreePath,
      activePaneId,
      addTab,
      getAllTabs,
      environmentId,
    ],
  );

  // Handler for selecting a tab by index (for Ctrl+1, Ctrl+2, etc.)
  // This now only affects the active pane
  const handleSelectTab = useCallback(
    (index: number) => {
      const activePane = getActivePane(environmentId);
      if (activePane && index >= 0 && index < activePane.tabs.length) {
        const tab = activePane.tabs[index];
        if (tab) {
          usePaneLayoutStore.getState().setActiveTab(activePaneId, tab.id, environmentId);
        }
      }
    },
    [activePaneId, environmentId, getActivePane],
  );

  // Handler for closing the active tab
  const handleCloseActiveTab = useCallback(() => {
    const activePane = getActivePane(environmentId);
    if (activePane && activePane.activeTabId) {
      removeTab(activePane.id, activePane.activeTabId, environmentId);
    }
  }, [environmentId, getActivePane, removeTab]);

  // Electron owns Command+W as a native menu accelerator. Route its event to
  // the currently active environment and resolve the pane from live store
  // state so a stale render cannot close the wrong pane (or no pane at all).
  useEffect(() => {
    if (!isActive) return;
    const unlisten = listen<void>("menu-close-tab", () => {
      // The first menu event proves an Electron menu is delivering Command+W,
      // so the renderer fallback below stands down from here on. Consume one
      // pending fallback close first: the fallback only runs before this latch
      // engages, so at most one menu event can be an echo of the same physical
      // keypress, and acting on it would close a second, unrelated tab.
      const echoesRendererClose = rendererClosedTabPendingEchoRef.current;
      rendererClosedTabPendingEchoRef.current = false;
      menuOwnsCloseTabRef.current = true;
      if (echoesRendererClose) return;
      handleCloseActiveTab();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [handleCloseActiveTab, isActive]);

  // Browser-served clients (`apps/web-public`) have no Electron menu, so
  // nothing would close the tab and the browser would close its own tab
  // instead. Handle Command+W here and always preventDefault. The listener
  // latches off as soon as a `menu-close-tab` event proves a native menu owns
  // the shortcut, so the desktop app can never close two tabs for one press.
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "w" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      // Prevent the browser's own close-tab default even once the native menu
      // has taken ownership; losing the whole window is worse than a no-op.
      event.preventDefault();
      if (menuOwnsCloseTabRef.current) return;
      rendererClosedTabPendingEchoRef.current = true;
      handleCloseActiveTab();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCloseActiveTab, isActive]);

  // Clear launch options after they've been applied to the first tab.
  useEffect(() => {
    if (hasAppliedClaudeOptions && claudeOptions) {
      // Give pending native launches time to be converted into tabs. Once the
      // tab exists, its initialPrompt lives in pane state until dispatched.
      const timer = setTimeout(() => {
        const pending = useClaudeOptionsStore.getState().getPendingNativeLaunch(environmentId);
        if (!pending) {
          clearOptions(environmentId);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [hasAppliedClaudeOptions, claudeOptions, environmentId, clearOptions]);

  // Register tab functions with context
  useEffect(() => {
    if (!isActive) return;

    if (isEnvironmentRunning && (containerId || isLocalEnvironmentReady)) {
      setCreateTab(handleCreateTab);
      setSelectTab(handleSelectTab);
      setCloseActiveTab(handleCloseActiveTab);
      const allTabs = getAllTabs(environmentId);
      setTabCount(allTabs.length);
      setCreateFileTab(handleCreateFileTab);
      setOpenFilePaths(getOpenFilePaths(environmentId));
    } else {
      setCreateTab(null);
      setSelectTab(null);
      setCloseActiveTab(null);
      setTabCount(0);
      setCreateFileTab(null);
      setOpenFilePaths([]);
    }

    return () => {
      setCreateTab(null);
      setSelectTab(null);
      setCloseActiveTab(null);
      setTabCount(0);
      setCreateFileTab(null);
      setOpenFilePaths([]);
    };
  }, [
    isActive,
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    handleCreateTab,
    handleCreateFileTab,
    handleSelectTab,
    handleCloseActiveTab,
    getAllTabs,
    getOpenFilePaths,
    setCreateTab,
    setSelectTab,
    setCloseActiveTab,
    setTabCount,
    setCreateFileTab,
    setOpenFilePaths,
    environmentId,
  ]);

  // The registration effect above owns the callable surface and its teardown,
  // while this keeps the count reactive as pane state changes. The create
  // callback reads the store imperatively and therefore has stable identity;
  // without this separate subscription, the context retained the count from
  // mount even as tabs were added or removed.
  const registeredTabCount = currentEnvState
    ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs).length
    : 0;
  useEffect(() => {
    if (!isActive || !isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return;
    setTabCount(registeredTabCount);
  }, [
    containerId,
    isActive,
    isEnvironmentRunning,
    isLocalEnvironmentReady,
    registeredTabCount,
    setTabCount,
  ]);

  // Handle drag start - track which tab is being dragged
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  // Handle drag over - track which pane is being hovered
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setDragOverPaneId(null);
      return;
    }

    const overId = over.id as string;

    // Check if hovering over a tabbar
    if (overId.startsWith("tabbar:")) {
      const targetPaneId = overId.replace("tabbar:", "");
      setDragOverPaneId(targetPaneId);
      return;
    }

    // Check if hovering over a tab
    const overTab = parseDraggableTabId(overId);
    if (overTab) {
      setDragOverPaneId(overTab.paneId);
      return;
    }

    setDragOverPaneId(null);
  }, []);

  // Handle drag end for tab reordering and moving
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // Capture drag state before clearing (needed for self-collision handling)
      const lastDragOverPaneId = dragOverPaneId;

      // Clear drag state
      setActiveDragId(null);
      setDragOverPaneId(null);

      const { active, over } = event;
      rendererDebugLog(
        "[TerminalContainer] DragEnd - active:",
        active.id,
        "over:",
        over?.id ?? "null",
        "lastDragOverPaneId:",
        lastDragOverPaneId,
      );
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const action = getTerminalTabDragEndAction({
        activeId,
        overId,
        lastDragOverPaneId,
        getPane,
      });

      if (action.type === "split") {
        rendererDebugLog(
          "[TerminalContainer] Split at edge:",
          action.edge,
          "from pane:",
          action.fromPaneId,
        );
        splitPaneAtEdge(
          action.targetPaneId,
          action.edge,
          action.tabId,
          action.fromPaneId,
          environmentId,
        );
      } else if (action.type === "reorder") {
        rendererDebugLog(
          "[TerminalContainer] Reordering tabs:",
          action.fromIndex,
          "->",
          action.toIndex,
        );
        reorderTabs(action.paneId, action.fromIndex, action.toIndex, environmentId);
      } else if (action.type === "move") {
        rendererDebugLog(
          "[TerminalContainer] Moving tab to pane:",
          action.toPaneId,
          "index:",
          action.toIndex,
        );
        moveTab(action.fromPaneId, action.toPaneId, action.tabId, action.toIndex, environmentId);
      }
    },
    [dragOverPaneId, environmentId, getPane, moveTab, reorderTabs, splitPaneAtEdge],
  );

  const handleStartOverlayClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Allow context-menu gestures (for example Ctrl+Click on macOS)
      // without triggering a normal start action.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }

      onStartContainer?.();
    },
    [onStartContainer],
  );

  // Determine what overlay to show (if any)
  // For local environments, we don't have a containerId but can still show terminal
  const showNoEnvironmentOverlay = !containerId && !isLocalEnvironment;
  const showCreatingOverlay = Boolean(isContainerCreating && (containerId || isLocalEnvironment));
  const showNotRunningOverlay = Boolean(
    !isEnvironmentRunning && !isContainerCreating && (containerId || isLocalEnvironment),
  );
  // Use THIS environment's tabs, not the global active environment's tabs
  const thisEnvTabs = currentEnvState
    ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs)
    : [];
  // Local environments can show terminal without containerId, but need worktreePath
  const showTerminal =
    isEnvironmentRunning && (containerId || isLocalEnvironmentReady) && thisEnvTabs.length > 0;

  // Debug logging for local environment display issues (only in development)
  if (import.meta.env.DEV) {
    rendererDebugLog("[TerminalContainer] Display state:", {
      environmentId,
      isLocalEnvironment,
      isLocalEnvironmentReady,
      worktreePath,
      isContainerRunning,
      isEnvironmentRunning,
      containerId,
      tabsCount: thisEnvTabs.length,
      showTerminal,
      showNoEnvironmentOverlay,
      showCreatingOverlay,
      showNotRunningOverlay,
    });
  }

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col bg-background", className)}>
      {/* Main content with DnD context */}
      {showTerminal && (
        <DndContext
          sensors={sensors}
          collisionDetection={customCollisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
            <PaneTree
              node={root}
              containerId={containerId}
              environmentId={environmentId}
              isActive={isActive}
              activeDragId={activeDragId}
              dragOverPaneId={dragOverPaneId}
            />
            {/* Terminal portal host - renders all terminals via portals into pane targets */}
            <TerminalPortalHost containerId={containerId} environmentId={environmentId} />
          </div>
        </DndContext>
      )}

      <TerminalContainerOverlays
        environmentId={environmentId}
        containerId={containerId}
        isLocalEnvironment={isLocalEnvironment}
        isEnvironmentRunning={isEnvironmentRunning}
        showNoEnvironmentOverlay={showNoEnvironmentOverlay}
        showCreatingOverlay={showCreatingOverlay}
        showNotRunningOverlay={showNotRunningOverlay}
        setupPhase={setupPhase}
        createScriptPrompt={createScriptPrompt}
        onStartContainer={onStartContainer}
        onCreateScript={onCreateScript}
        onStartOverlayClick={handleStartOverlayClick}
      />
    </div>
  );
}
