import { linkBrowserTarget, serviceLinkTarget } from "@/lib/preview-service-entry";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
  type MouseEvent,
} from "react";
import type { BrowserPreviewOpenLinkEvent } from "@orkestrator/protocol/browser-preview";
import { isMultiReviewTerminalPhase } from "@orkestrator/protocol/multi-review";
import {
  gitHubPullRequestKey,
  isGitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
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
  type CreateTabOptions,
  type CreateFileTabOptions,
} from "@/contexts";
import {
  createSessionKey,
  environmentStore,
  useClaudeOptionsStore,
  paneLayoutStore,
  usePaneLayoutStore,
  useEnvironmentStore,
  useConfigStore,
  terminalSessionStore,
  useFilesPanelStore,
  getAllLeaves,
} from "@/stores";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { showTabLimitReachedToast } from "@/lib/tab-limit-toast";
import { isDesignFilePath, openDesignFile } from "@/components/design/design-open-file";
import { designApiFor } from "@/lib/design-client";
import { openDesignCanvasTab } from "@/components/design/design-open-tab";
import { openGraphDesignerTab } from "@/components/graph-designer/graph-designer-open-tab";
import { openGraphRunTab } from "@/components/graph-run/graph-run-open-tab";
import { openAutoPipelineTab } from "@/components/review/auto-pipeline-open-tab";
import { openKeyInformationTab } from "@/components/build-pipeline/key-information-open-tab";
import {
  onGraphRunViewRequested,
  takePendingGraphRunView,
  type GraphRunViewRequest,
} from "@/lib/graph-run-navigation";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import { backendForScope } from "@/lib/backend/scope-backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import { agentSettingsTiers } from "@/lib/agent-settings";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { reconcilePersistedLayout } from "@/lib/pane-layout-restore";
import { hydratePaneLayoutDependencies } from "@/lib/pane-layout-authoritative";
import {
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  migratePaneLayoutBrowserHistory,
} from "@/lib/pane-layout-persistence";
import {
  applyStoredPaneSelection,
  clearStoredPaneSelection,
  consumeWindowStartupAgentActivation,
  hasWindowStartupAgentActivation,
  readStoredPaneSelection,
} from "@/lib/pane-selection-storage";
import { listenForTerminalBrowserTabRequests } from "@/lib/terminal-links";
import { listen } from "@/lib/native/events";
import { onReconnectInScope } from "@/lib/node-scope-slots";
import { createOrkestratorScriptPrompt } from "@/prompts";
import { isEnvironmentSetupSettled } from "@orkestrator/protocol/environment-readiness";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflowsForEnvironment } from "@/lib/multi-review-persistence";
import { PaneTree } from "@/components/pane-layout";
import {
  EnvironmentTabsShimmer,
  useEnvironmentTabLaunches,
} from "@/components/pane-layout/TabLaunchShimmer";
import { cancelTabLaunchFocus } from "@/lib/tab-launch";
import { LazyTerminalPortalHost } from "./LazyTerminalPortalHost";
import { TerminalContainerOverlays } from "./TerminalContainerOverlays";
import {
  parseDraggableTabId,
  isGitFileStatus,
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  type TabInfo,
} from "@/types/paneLayout";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { resolveWorkspaceRelativeFilePath } from "@/lib/workspace-file-path";
import {
  fileTabChangeDiffTarget,
  legacyLiveDiffTarget,
  sameChangeDiffTarget,
} from "./change-diff-target";

import {
  MAX_SETUP_SESSION_BIND_ATTEMPTS,
  SETUP_SESSION_BIND_RETRY_DELAY_MS,
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
import { commandClient } from "@/lib/node-scope/app-window-scope";

const log = createLogger("terminal");
const setupLog = createLogger("terminal.setup");

export function TerminalContainer({
  environmentId,
  containerId,
  isContainerRunning = false,
  isContainerCreating = false,
  isActive = true,
  className,
  onStartContainer,
  onCreateScript,
  obscured = false,
  onReveal,
}: TerminalContainerProps) {
  // This node's Multi Review workflows and tab launches (plan item 3003).
  const multiReviewScope = useNodeScope();
  const tabLaunchScope = useNodeScope();
  // This node's environments (plan item 3004).
  const environments = useNodeScope().store(environmentStore);
  // This node's build pipelines (plan item 3011).
  const buildPipelines = useNodeScope().store(buildPipelineStore);
  // This node's terminal sessions (plan item 3010).
  const terminalScope = useNodeScope();
  const terminalSessions = terminalScope.store(terminalSessionStore);
  const nativeComposeScope = useNodeScope();
  // This node's pane layouts (plan item 3013).
  const paneLayoutScope = useNodeScope();
  const paneLayouts = paneLayoutScope.store(paneLayoutStore);
  const activeWriteRef = useRef<((data: string) => Promise<void>) | null>(null);
  const obscuredRef = useRef(obscured);
  const onRevealRef = useRef(onReveal);
  // Latest props for handlers that outlive a render, published at commit.
  useLayoutEffect(() => {
    obscuredRef.current = obscured;
    onRevealRef.current = onReveal;
  });

  // Track currently dragged tab ID for cross-pane visual feedback
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);

  // Get Claude options for this environment. Actions are stable references;
  // the options record is selected narrowly so writes for other environments
  // do not rerender this container.
  const clearOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const claudeOptions = useClaudeOptionsStore((state) => state.options[environmentId]);
  const [hasAppliedClaudeOptions, setHasAppliedClaudeOptions] = useState(false);

  // Get config for agent modes - per-environment overrides take precedence over global
  const config = useConfigStore((state) => state.config);
  // Only the fields this container reads: the environment record changes for
  // status, activity, pull request and name updates it does not use, and each of
  // those would otherwise re-render the whole pane tree.
  const {
    environmentExists,
    envAgentSettings,
    envProjectId,
    environmentName,
    isLocalEnvironment,
    lifecycleError,
    lifecycleRemedy,
    pendingAgentLaunch,
    setupPhase,
    setupReady,
    setupScriptsComplete,
    startupAgent,
    startupError,
    startupProviderSessionId,
    startupStatus,
    worktreePath,
  } = useEnvironmentStore(
    useShallow((state) => {
      const env = state.environments.find((e) => e.id === environmentId);
      const startup = env?.startupAgentSession;
      return {
        environmentExists: env !== undefined,
        envAgentSettings: env?.agentSettings,
        envProjectId: env?.projectId,
        environmentName: env?.name,
        isLocalEnvironment: env?.environmentType === "local",
        lifecycleError: env?.lifecycleError?.trim() || null,
        lifecycleRemedy: env?.lifecycleRemedy ?? null,
        // Prompt-bearing launches keep this true until the initial prompt is
        // dispatched. Prompt-less launches consume it in the same setup-complete
        // snapshot, so the one-shot window activation is the remaining owed handoff.
        pendingAgentLaunch: env?.pendingAgentLaunch === true,
        setupPhase: env?.setupPhase ?? "pending",
        setupReady: isEnvironmentSetupSettled(env),
        setupScriptsComplete: env?.setupScriptsComplete === true,
        startupAgent: startup?.agent,
        startupError: startup?.error,
        startupProviderSessionId: startup?.providerSessionId,
        startupStatus: startup?.status,
        worktreePath: env?.worktreePath,
      };
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
  const codex = resolveAgentPlatformSettings(tiers, "codex");
  const codexMode = codex.mode;
  const piMode = resolveAgentPlatformSettings(tiers, "pi").mode;
  const claude = resolveAgentPlatformSettings(tiers, "claude");
  const claudeMode = claude.mode;
  const claudeNativeBackend = claude.claudeNativeBackend;
  const backendSetupRunning = setupPhase === "running";
  const isStartupLaunchPending = pendingAgentLaunch;
  const createScriptPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
  // For local environments, worktreePath must be set before terminal can work
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
    navigateFileTab,
    clearFileTabNavigation,
    retireSetupTabMarker,
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
      navigateFileTab: state.navigateFileTab,
      clearFileTabNavigation: state.clearFileTabNavigation,
      retireSetupTabMarker: state.retireSetupTabMarker,
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

  const previousContainerIdRef = useRef<string | null>(null);
  const previousEnvironmentIdRef = useRef<string | null>(null);
  const paneHydrationRequestsRef = useRef(new Map<string, symbol>());
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
  useLayoutEffect(() => {
    backendSetupRunningRef.current = backendSetupRunning;
  });
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
      !!terminalSessions.getState().sessions.get(setupSessionKeyForTab(tabId))?.sessionId,
    [setupSessionKeyForTab, terminalSessions],
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
      const local = terminalSessions.getState().sessions.get(key);
      if (local?.serializedBuffer) {
        return { buffer: local.serializedBuffer, persistentSessionId: local.persistentSessionId };
      }

      const persistentSessions =
        await backendForScope(terminalScope).getSessionsByEnvironment(environmentId);
      const persistentSession = persistentSessions.find((session) => session.tabId === tabId);
      if (!persistentSession) return null;

      const buffer = await backendForScope(terminalScope).loadSessionBuffer(persistentSession.id);
      if (!buffer) return null;
      return { buffer, persistentSessionId: persistentSession.id };
    },
    [terminalScope, environmentId, setupSessionKeyForTab, terminalSessions],
  );

  /**
   * A setup tab whose PTY is gone is an attach-only view of a saved transcript:
   * it can never create a shell of its own, so it renders like a working
   * terminal and silently drops every keystroke. Once the transcript is safely
   * in the terminal store, drop the setup marker. What is left is an ordinary
   * terminal tab, which does create its own PTY and replays the retained
   * transcript ahead of the new shell's output — so the history survives and
   * the tab becomes usable again.
   */
  const retireDeadSetupTab = useCallback(
    (tabId: string) => {
      const key = setupSessionKeyForTab(tabId);
      const terminalStore = terminalSessions.getState();
      const existing = terminalStore.sessions.get(key);
      if (existing?.sessionId === `${environmentId}:setup`) {
        const { sessionId: _deadSetupSession, ...preserved } = existing;
        terminalStore.setSession(key, preserved);
      }
      if (!retireSetupTabMarker(tabId, environmentId)) return;
      setupLog.info("tab.marker-retired", { environmentId, tabId });
    },
    [environmentId, retireSetupTabMarker, setupSessionKeyForTab, terminalSessions],
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
        setupLog.debug("session.bind-skipped", () => ({ environmentId, tabId, alreadyBound }));
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
        setupLog.debug("session.requested", () => ({
          environmentId,
          tabId,
          sessionKey: setupSessionKeyForTab(tabId),
        }));
        const setupSession =
          await backendForScope(terminalScope).awaitEnvironmentSetupSession(environmentId);
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
            const terminalStore = terminalSessions.getState();
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
            // Keeping the transcript is the right call, but it used to mean
            // keeping a tab that could never attach and never be retired.
            // Demote it instead, so it keeps the history *and* gets a shell.
            if (!startedWhileSetupRunning && !backendSetupRunningRef.current) {
              retireDeadSetupTab(tabId);
            }
          }
          setupLog.info("session.unavailable", {
            environmentId,
            tabId,
            hasReplayableTranscript,
          });
          return false;
        }
        const key = setupSessionKeyForTab(tabId);
        const terminalStore = terminalSessions.getState();
        const existing = terminalStore.sessions.get(key);
        setupLog.info("session.bind-started", {
          environmentId,
          tabId,
          sessionKey: key,
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
        // A completed setup record can outlive its PTY. Preserve whichever
        // authoritative transcript source still exists, then demote the tab so
        // it can create a shell of its own.
        if (!setupSession.running && !setupSession.terminalRunning) {
          let replayableTranscript = await loadReplayableSetupTranscript(tabId);
          if (!replayableTranscript && setupSession.hasOutput === true) {
            const snapshot = await backendForScope(terminalScope).getTerminalOutputSnapshot(
              setupSession.sessionId,
            );
            if (snapshot.output) {
              replayableTranscript = { buffer: snapshot.output, persistentSessionId: undefined };
            }
          }
          if (setupSessionBindLifecycleGenerationRef.current !== lifecycleGeneration) {
            return false;
          }
          // `hasOutput: true` is authoritative evidence that history exists.
          // An empty snapshot is therefore a failed/inconsistent read, not
          // permission to retire the only tab that can still recover it.
          if (setupSession.hasOutput === true && !replayableTranscript) {
            throw new Error("Backend reported setup output but returned an empty snapshot");
          }
          lookupSettled = true;
          setupSessionBindAttemptsRef.current.delete(tabId);
          if (!replayableTranscript) {
            setupSessionUnavailableTabsRef.current.add(tabId);
            return false;
          }
          const current = terminalStore.sessions.get(key);
          terminalStore.setSession(key, {
            ...current,
            persistentSessionId:
              current?.persistentSessionId ?? replayableTranscript.persistentSessionId,
            serializedBuffer: current?.serializedBuffer || replayableTranscript.buffer,
          });
          setupSessionUnavailableTabsRef.current.delete(tabId);
          if (!startedWhileSetupRunning && !backendSetupRunningRef.current) {
            retireDeadSetupTab(tabId);
          }
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
        log.error("setup-session.bind-failed", {
          environmentId,
          tabId,
          error: formatLogError(error),
        });
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
              !terminalSessions.getState().sessions.get(setupSessionKeyForTab(tabId))
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
    [
      terminalScope,
      environmentId,
      hasBoundSetupSession,
      loadReplayableSetupTranscript,
      retireDeadSetupTab,
      setupSessionKeyForTab,
      terminalSessions,
    ],
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

    setupLog.debug("reconcile.started", () => ({
      environmentId,
      tabIds: setupTabsToBind.map((tab) => tab.id).join(","),
      setupPhase,
      tabCount: setupTabs.length,
    }));
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
    // This node's stream coming back (plan item 3010).
    void onReconnectInScope(terminalScope, () => {
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
          setupLog.debug("reconnect-listener.install-failed", () => ({
            error: formatLogError(error),
          }));
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [terminalScope]);

  useEffect(() => {
    if (!currentEnvState || pendingAgentLaunch || backendSetupRunning) {
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
        log.debug("setup-tab.stale-removed", () => ({ environmentId, tabId: staleSetupTab.id }));
        removeTab(leaf.id, staleSetupTab.id, environmentId);
        return;
      }
    }
  }, [
    currentEnvState,
    pendingAgentLaunch,
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
  useEffect(() => {
    if (startupStatus !== "error") {
      reportedStartupErrorRef.current = null;
      return;
    }
    const reason = startupError ?? "The agent could not be started.";
    // Keyed on the message so a repeated retry failure does not re-toast, but a
    // different failure still does.
    if (reportedStartupErrorRef.current === reason) return;
    reportedStartupErrorRef.current = reason;
    toast.error(`${startupAgent} could not start in ${environmentName ?? "this environment"}`, {
      description: reason,
      duration: 10_000,
    });
  }, [environmentName, startupAgent, startupError, startupStatus]);

  // Bind provider identity onto the durable startup tab once the backend has
  // published both. The renderer never creates or dispatches startup work.
  useEffect(() => {
    if (!environmentExists) return;
    if (startupStatus && startupStatus !== "running") return;
    if ((!pendingAgentLaunch && !startupStatus) || !currentEnvState) return;
    if (!isEnvironmentRunning || (!setupReady && !setupScriptsComplete)) return;
    const existingStartupTabId = findStartupAgentTabId(currentEnvState);
    if (!existingStartupTabId) return;
    if (startupProviderSessionId) {
      paneLayouts
        .getState()
        .updateTabNativeSessionId(existingStartupTabId, startupProviderSessionId, environmentId);
    }
    if (claudeOptions?.launchAgent) clearOptions(environmentId);
  }, [
    paneLayouts,
    claudeOptions?.launchAgent,
    currentEnvState,
    environmentExists,
    environmentId,
    isEnvironmentRunning,
    pendingAgentLaunch,
    setupReady,
    setupScriptsComplete,
    startupProviderSessionId,
    startupStatus,
    clearOptions,
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
    // An authoritative event can land after render but before this passive
    // effect. Default seeding must inspect the current store, not that render's
    // empty snapshot, or it can steal focus from a just-published action tab.
    const latestPaneState = paneLayouts.getState().environments.get(environmentId);
    const currentTabs = latestPaneState
      ? getAllLeaves(latestPaneState.root).flatMap((leaf) => leaf.tabs)
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
    if (hydrationStatus === "pending") return;
    if (hydrationStatus === undefined) {
      const request = Symbol();
      paneHydrationRequestsRef.current.set(environmentId, request);
      beginHydration(environmentId);
      // The layout commands go to this node (plan item 3013); on the app's
      // command scope they are the `@/lib/backend` named exports.
      const layoutBackend = backendApiForScope(paneLayoutScope, createFilesSessionsApi, {
        getPaneLayout: backend.getPaneLayout,
        deletePaneLayout: backend.deletePaneLayout,
      });
      void Promise.allSettled([
        layoutBackend.getPaneLayout(environmentId),
        hydrateMultiReviewWorkflowsForEnvironment(environmentId, multiReviewScope),
      ]).then(async ([layoutResult, multiReviewResult]) => {
        // These independent snapshots need not describe the same instant.
        // A launch between the list read and the layout read must not make
        // reconciliation discard its new tab and seed a competing terminal.
        let dependenciesUnknown = false;
        if (layoutResult.status === "fulfilled" && layoutResult.value) {
          try {
            await hydratePaneLayoutDependencies(layoutResult.value.root, paneLayoutScope);
          } catch {
            // A failed read is not evidence of deletion. The tab's own view
            // can retry; retaining it also preserves authoritative focus.
            dependenciesUnknown = true;
          }
        }
        const paneStore = paneLayouts.getState();
        // A stop/replacement can clear hydration and start another request
        // before this read settles. "pending" alone cannot identify it.
        if (paneHydrationRequestsRef.current.get(environmentId) !== request) return;
        paneHydrationRequestsRef.current.delete(environmentId);
        if (paneStore.hydration.get(environmentId) !== "pending") return;

        if (multiReviewResult.status === "rejected") {
          log.warn("multi-reviews.restore-failed", {
            environmentId,
            error: formatLogError(multiReviewResult.reason),
          });
        }
        const latestEnvironment = environments.getState().getEnvironmentById(environmentId);
        const latestContainerId = latestEnvironment
          ? latestEnvironment.environmentType === "local"
            ? null
            : latestEnvironment.containerId
          : isLocalEnvironment
            ? null
            : containerId;

        if (layoutResult.status === "rejected") {
          log.warn("pane-layout.restore-failed", {
            environmentId,
            error: formatLogError(layoutResult.reason),
          });
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
            dependenciesUnknown || buildPipelines.getState().pipelines.has(pipelineId),
          hasMultiReview: (workflowId) =>
            // A failed workflow-list request means existence is unknown,
            // not that every persisted review was deleted. Preserve those
            // tabs so their own read-through view can retry hydration.
            dependenciesUnknown ||
            multiReviewResult.status === "rejected" ||
            multiReviewScope.store(multiReviewStore).getState().workflows.has(workflowId),
        });
        const restored =
          restoredSnapshot && persisted?.version === LEGACY_PANE_LAYOUT_VERSION
            ? applyStoredPaneSelection(
                restoredSnapshot,
                environmentId,
                readStoredPaneSelection(environmentId, paneLayoutScope),
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
          clearStoredPaneSelection(environmentId, paneLayoutScope);
          if (restored) {
            void migratePaneLayoutBrowserHistory(
              environmentId,
              persisted,
              undefined,
              paneLayoutScope,
            ).catch((error) => {
              log.warn("pane-layout.history-migrate-failed", {
                environmentId,
                error: formatLogError(error),
              });
            });
          } else {
            // A stale-generation or malformed current-version snapshot
            // cannot safely be rewritten as renderer state. Remove only
            // the exact revision we inspected; a concurrent newer layout
            // wins the CAS and is preserved for the next reconciliation.
            void layoutBackend
              .deletePaneLayout(environmentId, persisted.revision)
              .catch((error) => {
                log.warn("pane-layout.snapshot-remove-failed", {
                  environmentId,
                  error: formatLogError(error),
                });
              });
          }
        }

        if (restored && persisted && persisted.version < PANE_LAYOUT_VERSION) {
          // V1 contributes renderer-local selection; v2 contributes legacy
          // provider-specific native tab records. Reconciliation has now
          // converted either schema to v3, so persist that exact snapshot
          // through the normal CAS chain before considering it migrated.
          const migrated = paneLayouts.getState().environments.get(environmentId);
          if (migrated) {
            void flushPaneLayoutNow(
              environmentId,
              createPersistedPaneLayoutInput(migrated),
              undefined,
              undefined,
              paneLayoutScope,
            )
              .then(() => {
                if (persisted.version === LEGACY_PANE_LAYOUT_VERSION) {
                  clearStoredPaneSelection(environmentId, paneLayoutScope);
                }
              })
              .catch((error) => {
                log.warn("pane-layout.selection-migrate-failed", {
                  environmentId,
                  error: formatLogError(error),
                });
              });
          }
        }
      });
      return;
    }

    if (seededTabs.length === 0) {
      setupLog.debug("layout.initial-decided", () => ({
        environmentId,
        backendSetupRunning,
        setupPhase,
        isLocalEnvironment,
        hasWorktreePath: Boolean(worktreePath),
        containerId,
      }));

      // Every tab of a starting environment is a backend-owned projection: the
      // setup terminal appears when setup has something to show, and the job
      // tab when setup has finished. An empty renderer waits for that snapshot
      // or event instead of manufacturing a competing tab locally.
      // initialize() still runs: finishHydration without a restored snapshot
      // does not create a pane-store record, and later pane-layout events
      // cannot apply to an environment that was never registered.
      if (backendSetupRunning || pendingAgentLaunch || claudeOptions?.launchAgent === true) {
        if (!paneLayouts.getState().environments.has(environmentId)) {
          initialize(containerId, environmentId);
        }
        // Record consumption with the initialization side effect so the later
        // options cleanup cannot run before the pane has been registered.
        // oxlint-disable-next-line react/set-state-in-effect
        if (claudeOptions?.launchAgent) setHasAppliedClaudeOptions(true);
        return;
      }

      initialize(containerId, environmentId);
      // A restored/shared build-only layout can use a non-default pane id.
      // Seed the ordinary tab into the pane that actually survived hydration;
      // targeting the literal "default" would be a no-op and make this effect
      // initialize forever because build tabs are excluded from `seededTabs`.
      const initialPaneState = paneLayouts.getState().environments.get(environmentId);
      const initialPaneId = initialPaneState?.activePaneId ?? "default";

      // A build tab the backend selected (a pipeline started on an existing
      // environment, whose layout held only that tab) stays selected: the
      // default terminal joins it without taking the user off the pipeline.
      const initialLeaf = initialPaneState
        ? getAllLeaves(initialPaneState.root).find((leaf) => leaf.id === initialPaneId)
        : undefined;
      const buildTabSelected =
        initialLeaf?.tabs.find((tab) => tab.id === initialLeaf.activeTabId)?.type ===
        "claude-build";
      addTab(initialPaneId, { id: "default", type: "plain" }, environmentId, {
        activate: !buildTabSelected,
      });
    }
  }, [
    paneLayouts,
    paneLayoutScope,
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    isLocalEnvironment,
    setupPhase,
    backendSetupRunning,
    claudeOptions,
    tiers,
    initialize,
    addTab,
    environmentId,
    currentEnvState,
    pendingAgentLaunch,
    hydrationStatus,
    beginHydration,
    finishHydration,
    opencodeMode,
    claudeMode,
    claudeNativeBackend,
    codexMode,
    piMode,
    worktreePath,
    multiReviewScope,
    environments,
    buildPipelines,
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
      log.debug("panes.reset", () => ({ environmentId, reason: "container-changed" }));
      paneHydrationRequestsRef.current.delete(environmentId);
      reset(environmentId);
      setHasAppliedClaudeOptions(false);
    }
    previousContainerIdRef.current = containerId;
    previousEnvironmentIdRef.current = environmentId;
  }, [containerId, environmentId, reset]);

  // Reset pane layout when the container stops: its terminal sessions are gone.
  // Agent tabs and their sessions survive in the persisted layout, which the
  // next start re-hydrates (`reset` clears this environment's hydration).
  useEffect(() => {
    if (!isContainerRunning && containerId) {
      log.debug("panes.reset", () => ({ environmentId, reason: "container-stopped" }));
      paneHydrationRequestsRef.current.delete(environmentId);
      reset(environmentId);
    }
  }, [isContainerRunning, environmentId, containerId, reset]);

  // The backend publishes the startup agent while setup still runs, and this
  // renderer keeps the setup terminal selected so the user can watch it. When
  // setup becomes ready, move focus onto that agent — including when the
  // durable-launch effect is still blocked on a `starting` session.
  //
  // Gated on an owed handoff, not on `setupReady` alone. Setup readiness and
  // the setup tab's `isSetupTab` flag both outlive the launch by the life of the
  // environment, so without this gate a reload or a remount would hand focus off
  // again every time the user happened to be sitting on that terminal.
  // Prompt-less launches clear `pendingAgentLaunch` before setup-complete is
  // emitted, so the persisted window activation is the remaining one-shot.
  useEffect(() => {
    const windowHandoffOwed = hasWindowStartupAgentActivation(environmentId, paneLayoutScope);
    if (!setupReady || (!isStartupLaunchPending && !windowHandoffOwed)) {
      if (!setupReady && windowHandoffOwed) {
        // A one-shot armed (or re-armed) while setup is not ready must be
        // allowed to fire when setup becomes ready, including after a previous
        // handoff for this environment.
        handedOffSetupFocusRef.current.delete(environmentId);
      } else if (!isStartupLaunchPending && !windowHandoffOwed) {
        handedOffSetupFocusRef.current.delete(environmentId);
      }
      return;
    }
    if (!currentEnvState) return;
    if (handedOffSetupFocusRef.current.has(environmentId)) return;
    const startupTabId = findStartupAgentTabId(currentEnvState);
    if (!startupTabId) return;
    handoffSetupFocusToStartupAgent(environmentId, currentEnvState, startupTabId, paneLayoutScope);
    handedOffSetupFocusRef.current.add(environmentId);
    consumeWindowStartupAgentActivation(environmentId, paneLayoutScope);
  }, [setupReady, isStartupLaunchPending, currentEnvState, environmentId, paneLayoutScope]);

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
    (
      initialUrl: string | undefined,
      targetPaneId = activePaneId,
      displayTitle?: string,
      requestedTabId?: string,
    ) => {
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) {
        return false;
      }

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        log.debug("tabs.limit-reached", () => ({ environmentId, maxTabs: MAX_TABS }));
        showTabLimitReachedToast(MAX_TABS);
        return false;
      }

      if (!paneLayouts.getState().getPane(targetPaneId, environmentId)) {
        return false;
      }

      const newTabId = requestedTabId || createUniqueTabId("tab");
      const newTab: TabInfo = {
        id: newTabId,
        type: "browser",
        browserData: { url: initialUrl?.trim() ?? "" },
        displayTitle,
      };
      log.debug("tab.created", () => ({ tabId: newTabId, tabType: "browser", environmentId }));
      addTab(targetPaneId, newTab, environmentId);
      return true;
    },
    [
      paneLayouts,
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

        const pane = paneLayouts.getState().findPaneWithTab(request.sourceTabId, environmentId);
        if (!pane) return;

        // Loopback links are interpreted in this environment (a container's
        // localhost:3000 is its own port 3000), not as a backend host port.
        const target = linkBrowserTarget(
          environments.getState().getEnvironmentById(environmentId),
          request.url,
          request.origin ?? "terminal",
          tabLaunchScope,
        );
        if (createBrowserTab(target, pane.id)) {
          paneLayouts.getState().setActivePane(pane.id, environmentId);
        }
      }),
    [createBrowserTab, environmentId, environments, paneLayouts, tabLaunchScope],
  );

  // Handler for creating new terminal tabs
  const handleCreateTab = useCallback(
    (type: CreatableTabType, options?: CreateTabOptions): boolean => {
      // For local environments, we don't need a containerId but do need worktreePath to be set
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return false;

      cancelTabLaunchFocus(environmentId, tabLaunchScope);
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
            tab.multiReviewTabData?.reviewerId === options.multiReviewReviewerId &&
            tab.multiReviewTabData?.pipelinePass === options.multiReviewPipelinePass,
        );
        if (openTab) {
          const pane = paneLayouts.getState().findPaneWithTab(openTab.id, environmentId);
          if (pane) {
            paneLayouts.getState().setActivePane(pane.id, environmentId);
            paneLayouts.getState().setActiveTab(pane.id, openTab.id, environmentId);
          }
          return true;
        }
      }

      if (type === "design-canvas")
        return openDesignCanvasTab({
          scope: paneLayoutScope,
          environmentId,
          canvasId: options?.canvasId,
          placement: options?.designPlacement,
          requestedTabId: options?.tabId,
          allTabs,
          activePaneId,
          maxTabs: MAX_TABS,
          addTab,
          onTabLimit: () => showTabLimitReachedToast(MAX_TABS),
        });

      if (type === "graph-run") {
        if (!options?.graphRun) return false;
        return openGraphRunTab({
          scope: paneLayoutScope,
          environmentId,
          activePaneId,
          allTabs,
          maxTabs: MAX_TABS,
          run: options.graphRun,
          addTab,
          onTabLimit: () => showTabLimitReachedToast(MAX_TABS),
        });
      }

      if (type === "auto-pipeline") {
        if (!options?.autoPipeline) return false;
        return openAutoPipelineTab({
          scope: paneLayoutScope,
          environmentId,
          activePaneId,
          allTabs,
          maxTabs: MAX_TABS,
          target: options.autoPipeline,
          addTab,
          onTabLimit: () => showTabLimitReachedToast(MAX_TABS),
        });
      }

      if (type === "key-information") {
        if (!options?.keyInformation) return false;
        return openKeyInformationTab({
          scope: paneLayoutScope,
          environmentId,
          activePaneId,
          allTabs,
          maxTabs: MAX_TABS,
          target: options.keyInformation,
          addTab,
          onTabLimit: () => showTabLimitReachedToast(MAX_TABS),
        });
      }

      if (type === "graph-designer")
        return openGraphDesignerTab({
          scope: paneLayoutScope,
          environmentId,
          activePaneId,
          allTabs,
          maxTabs: MAX_TABS,
          template: options?.graphTemplate,
          addTab,
          onTabLimit: () => showTabLimitReachedToast(MAX_TABS),
        });

      // A pull request has one tab per environment: opening it again focuses
      // that tab (with the requested view) rather than counting a new one.
      if (type === "pull-request") {
        const request = options?.pullRequest;
        if (!request || !isGitHubPullRequestRef(request.ref)) return false;
        const key = gitHubPullRequestKey(request.ref);
        const openTab = allTabs.find(
          (tab) =>
            tab.type === "pull-request" &&
            tab.pullRequestData &&
            gitHubPullRequestKey(tab.pullRequestData.ref) === key,
        );
        const store = paneLayouts.getState();
        if (openTab) {
          const pane = store.findPaneWithTab(openTab.id, environmentId);
          if (!pane) return false;
          store.updateTabPullRequest(
            openTab.id,
            { view: request.view ?? "summary", reopen: true },
            environmentId,
          );
          store.setActivePane(pane.id, environmentId);
          store.setActiveTab(pane.id, openTab.id, environmentId);
          return true;
        }
        if (allTabs.length >= MAX_TABS) {
          showTabLimitReachedToast(MAX_TABS);
          return false;
        }
        addTab(
          activePaneId,
          {
            id: createUniqueTabId("pull-request"),
            type: "pull-request",
            pullRequestData: {
              ref: {
                owner: request.ref.owner,
                repo: request.ref.repo,
                number: request.ref.number,
              },
              view: request.view ?? "summary",
            },
          },
          environmentId,
        );
        return true;
      }

      // Selected durable workflows use caller-owned ids as idempotent focus
      // intents. Other callers retain collision reporting so they can roll back
      // any state they created specifically for a new tab.
      const requestedTabId = options?.tabId?.trim();
      if (requestedTabId) {
        const openTab = allTabs.find((tab) => tab.id === requestedTabId);
        if (openTab) {
          if (options?.activateExistingTab !== true) {
            log.warn("tab.duplicate-refused", { environmentId, tabId: requestedTabId });
            return false;
          }
          const pane = paneLayouts.getState().findPaneWithTab(openTab.id, environmentId);
          if (!pane) return false;
          paneLayouts.getState().setActivePane(pane.id, environmentId);
          paneLayouts.getState().setActiveTab(pane.id, openTab.id, environmentId);
          return true;
        }
      }

      if (allTabs.length >= MAX_TABS) {
        log.debug("tabs.limit-reached", () => ({ environmentId, maxTabs: MAX_TABS }));
        showTabLimitReachedToast(MAX_TABS);
        return false;
      }

      if (type === "browser") {
        return createBrowserTab(
          options?.initialUrl,
          activePaneId,
          options?.displayTitle,
          requestedTabId,
        );
      }

      if (type === "multi-review") {
        if (!options?.multiReviewId) {
          log.warn("tab.multi-review-refused", { environmentId });
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
            ...(options.multiReviewPipelinePass
              ? { pipelinePass: options.multiReviewPipelinePass }
              : {}),
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
        log.debug("tab.created", () => ({
          tabId: newTabId,
          tabType: "agent-native",
          environmentId,
        }));
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
      // Lock only when the tab is already committed to a provider: an opening
      // prompt, a review session, or a resume. A create-dialog model is a
      // preselect on the unassigned composer, not a lock.
      const prelockNativePlatform = Boolean(
        options?.initialPrompt || options?.isReviewTab || options?.resumeSessionId,
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
          hideStructuredOutput: options?.hideStructuredOutput,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
          initialFastMode: options?.initialFastMode,
        });
        log.debug("tab.created", () => ({
          tabId: newTabId,
          tabType: "opencode-native",
          environmentId,
          isLocal: isLocalEnvironment,
          hasInitialPrompt: !!options?.initialPrompt,
        }));
        seedDeferredNativePlatform(newTab, "opencode", nativeComposeScope);
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
          hideStructuredOutput: options?.hideStructuredOutput,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
          initialFastMode: options?.resumeSessionId
            ? undefined
            : (options?.initialFastMode ?? claude.fastMode),
          sessionId: options?.resumeSessionId,
          requireExistingResumeSession: options?.requireExistingResumeSession,
          deferPlatform: !prelockNativePlatform,
        });
        log.debug("tab.created", () => ({
          tabId: newTabId,
          tabType: newTab.type,
          environmentId,
          isLocal: isLocalEnvironment,
          hasInitialPrompt: !!options?.initialPrompt,
        }));
        seedDeferredNativePlatform(newTab, "claude", nativeComposeScope);
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
          hideStructuredOutput: options?.hideStructuredOutput,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
          initialFastMode: options?.initialFastMode,
        });
        log.debug("tab.created", () => ({
          tabId: newTabId,
          tabType: "codex-native",
          environmentId,
          isLocal: isLocalEnvironment,
          hasInitialPrompt: !!options?.initialPrompt,
        }));
        seedDeferredNativePlatform(newTab, "codex", nativeComposeScope);
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
          hideStructuredOutput: options?.hideStructuredOutput,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          initialConversationMode: options?.initialConversationMode,
          initialFastMode: options?.initialFastMode,
        });
        seedDeferredNativePlatform(newTab, provider, nativeComposeScope);
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
        ...(options?.hideStructuredOutput === undefined
          ? {}
          : { hideStructuredOutput: options.hideStructuredOutput }),
        initialAgentModel: options?.initialAgentModel,
        initialReasoningEffort: options?.initialReasoningEffort,
        initialConversationMode: options?.initialConversationMode,
        // Only the harnesses whose terminal launch command can carry a speed.
        // `buildTerminalAgentLaunchCommand` has nothing to put a Grok choice
        // in, so recording one here would drop it silently and still mark the
        // tab's initial launch options as pending.
        initialFastMode:
          options?.initialFastMode ??
          (type === "claude" ? claude.fastMode : type === "codex" ? codex.fastMode : undefined),
      };

      log.debug("tab.created", () => ({ tabId: newTabId, tabType: type, environmentId }));
      addTab(activePaneId, newTab, environmentId);
      return true;
    },
    [
      paneLayouts,
      paneLayoutScope,
      containerId,
      isEnvironmentRunning,
      activePaneId,
      addTab,
      getAllTabs,
      environmentId,
      opencodeMode,
      claudeMode,
      claudeNativeBackend,
      claude.fastMode,
      codex.fastMode,
      codexMode,
      piMode,
      isLocalEnvironmentReady,
      isLocalEnvironment,
      tabLaunchScope,
      nativeComposeScope,
      createBrowserTab,
    ],
  );

  useEffect(() => {
    if (!isActive) return;

    return commandClient().listenRaw<BrowserPreviewOpenLinkEvent>(
      "browser-preview-open-link",
      ({ tabId, url, service }) => {
        const sourcePane = paneLayouts.getState().findPaneWithTab(tabId, environmentId);
        const sourceTab = sourcePane?.tabs.find((tab) => tab.id === tabId);
        if (!sourcePane || sourceTab?.type !== "browser") return;
        // Same-service links from a service preview keep the service identity.
        if (createBrowserTab(service ? serviceLinkTarget(service) : url, sourcePane.id)) {
          paneLayouts.getState().setActivePane(sourcePane.id, environmentId);
        }
      },
    );
  }, [createBrowserTab, environmentId, isActive, paneLayouts]);

  // Handler for creating file viewer tabs
  const handleCreateFileTab = useCallback(
    (filePath: string, options?: CreateFileTabOptions) => {
      cancelTabLaunchFocus(environmentId, tabLaunchScope);
      const requestedDiff = options?.changeDiff;
      // For container environments, need containerId and running state
      // For local environments, need worktreePath
      const canCreateForContainer = containerId && isContainerRunning;
      const canCreateForLocal = isLocalEnvironment && worktreePath;
      if (!canCreateForContainer && !canCreateForLocal) return;

      const workspaceRoot = isLocalEnvironment ? worktreePath : "/workspace";
      const resolvedFilePath = workspaceRoot
        ? resolveWorkspaceRelativeFilePath(filePath, workspaceRoot)
        : null;
      // A change diff's path is a label (a historical path may no longer
      // exist, or belong to an earlier worktree); keep it when it does not
      // resolve inside this workspace.
      const relativeFilePath = resolvedFilePath ?? (requestedDiff ? filePath : null);
      if (!relativeFilePath) {
        toast.error("Could not open file", {
          description: "The link does not point to a file inside this workspace.",
        });
        return;
      }

      // What the diff view shows. Callers that only ask for `isDiff` get the
      // explicit current-workspace-file target for this environment.
      let changeDiff =
        requestedDiff ??
        (options?.isDiff ? legacyLiveDiffTarget(environmentId, relativeFilePath) : undefined);
      if (changeDiff?.kind === "live" && changeDiff.path !== undefined && workspaceRoot) {
        const livePath = resolveWorkspaceRelativeFilePath(changeDiff.path, workspaceRoot);
        if (livePath) changeDiff = { ...changeDiff, path: livePath };
      }

      // Accepted design paths open in the canvas; other paths use the text editor.
      if (!changeDiff && isDesignFilePath(relativeFilePath)) {
        void openDesignFile(environmentId, relativeFilePath, handleCreateTab, {
          openFile: designApiFor(paneLayoutScope).openFile,
        });
        return;
      }

      const allTabs = getAllTabs(environmentId);
      // A diff tab is reused only for the same target (historical identity, or
      // live resource + file); a plain file tab only for the same path. The same
      // file may therefore be open once as a file and once per diff target.
      const existingTab = allTabs.find((t) => {
        if (t.type !== "file" || !t.fileData) return false;
        const openTarget = fileTabChangeDiffTarget(t.fileData, environmentId);
        if (changeDiff)
          return openTarget !== undefined && sameChangeDiffTarget(openTarget, changeDiff);
        return openTarget === undefined && t.fileData.filePath === relativeFilePath;
      });
      if (existingTab) {
        if (options?.lineNumber) {
          navigateFileTab(existingTab.id, options.lineNumber, options.columnNumber, environmentId);
        } else {
          clearFileTabNavigation(existingTab.id, environmentId);
        }
        // Activate the existing tab instead of creating a duplicate
        const pane = paneLayouts.getState().findPaneWithTab(existingTab.id, environmentId);
        if (pane) {
          paneLayouts.getState().setActiveTab(pane.id, existingTab.id, environmentId);
          log.debug("tab.activated", () => ({ tabId: existingTab.id, paneId: pane.id }));
        }
        return;
      }

      if (allTabs.length >= MAX_TABS) {
        log.debug("tabs.limit-reached", () => ({ environmentId, maxTabs: MAX_TABS }));
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
          filePath: relativeFilePath,
          containerId: isLocalEnvironment ? undefined : (containerId ?? undefined),
          worktreePath: isLocalEnvironment ? worktreePath : undefined,
          isLocalEnvironment,
          isDiff: changeDiff ? true : options?.isDiff,
          gitStatus: validatedGitStatus,
          baseBranch: undefined,
          ...(changeDiff ? { changeDiff } : {}),
          ...(options?.lineNumber
            ? {
                lineNumber: options.lineNumber,
                columnNumber: options.columnNumber,
                navigationRequestId: 1,
              }
            : {}),
        },
      };

      log.debug("tab.created", () => ({
        tabId: newTabId,
        tabType: "file",
        diff: changeDiff?.kind ?? false,
        isLocal: isLocalEnvironment,
        environmentId,
      }));
      addTab(activePaneId, newTab, environmentId);
    },
    [
      paneLayouts,
      containerId,
      isContainerRunning,
      isLocalEnvironment,
      worktreePath,
      activePaneId,
      addTab,
      navigateFileTab,
      clearFileTabNavigation,
      getAllTabs,
      environmentId,
      handleCreateTab,
      tabLaunchScope,
      paneLayoutScope,
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
          paneLayouts.getState().setActiveTab(activePaneId, tab.id, environmentId);
        }
      }
    },
    [activePaneId, environmentId, getActivePane, paneLayouts],
  );

  // Handler for closing the active tab
  const handleCloseActiveTab = useCallback(async () => {
    const activePane = getActivePane(environmentId);
    if (activePane && activePane.activeTabId) {
      const activeTab = activePane.tabs.find((tab) => tab.id === activePane.activeTabId);
      const reviewData = activeTab?.multiReviewTabData;
      if (activeTab?.type === "multi-review" && reviewData && !reviewData.reviewerId) {
        const multiReviews = multiReviewScope.store(multiReviewStore);
        const phase = multiReviews.getState().workflows.get(reviewData.workflowId)?.phase;
        if (phase && isMultiReviewTerminalPhase(phase)) {
          try {
            await backendForScope(multiReviewScope).deleteMultiReviewWorkflow(
              reviewData.workflowId,
            );
            multiReviews.getState().removeWorkflow(reviewData.workflowId);
          } catch (error) {
            toast.error("Could not close Multi Review", {
              description: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
      }
      removeTab(activePane.id, activePane.activeTabId, environmentId);
    }
  }, [environmentId, getActivePane, multiReviewScope, removeTab]);

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
      if (echoesRendererClose || obscuredRef.current) return;
      void handleCloseActiveTab();
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
      if (menuOwnsCloseTabRef.current || obscuredRef.current) return;
      rendererClosedTabPendingEchoRef.current = true;
      void handleCloseActiveTab();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCloseActiveTab, isActive]);

  // Clear launch options after they've been applied to the first tab.
  useEffect(() => {
    if (hasAppliedClaudeOptions && claudeOptions) {
      // The backend owns the startup tab and its prompt. These options only
      // stop this mount adding a competing tab, so they need not outlive a
      // short grace period.
      const timer = setTimeout(() => clearOptions(environmentId), 3000);
      return () => clearTimeout(timer);
    }
  }, [hasAppliedClaudeOptions, claudeOptions, environmentId, clearOptions]);

  // Tabs created or selected through the context come from the toolbar,
  // shortcuts or the files panel; show them even when this container is covered.
  const revealIfObscured = useCallback(() => {
    if (obscuredRef.current) onRevealRef.current?.();
  }, []);
  const createTabFromContext = useCallback(
    (type: CreatableTabType, options?: CreateTabOptions): boolean => {
      const created = handleCreateTab(type, options);
      if (created) {
        cancelTabLaunchFocus(environmentId, tabLaunchScope);
        revealIfObscured();
      }
      return created;
    },
    [environmentId, handleCreateTab, revealIfObscured, tabLaunchScope],
  );
  const selectTabFromContext = useCallback(
    (index: number) => {
      cancelTabLaunchFocus(environmentId, tabLaunchScope);
      handleSelectTab(index);
      const activePane = getActivePane(environmentId);
      if (activePane && index >= 0 && index < activePane.tabs.length) revealIfObscured();
    },
    [environmentId, getActivePane, handleSelectTab, revealIfObscured, tabLaunchScope],
  );
  const createFileTabFromContext = useCallback(
    (filePath: string, options?: CreateFileTabOptions) => {
      handleCreateFileTab(filePath, options);
      revealIfObscured();
    },
    [handleCreateFileTab, revealIfObscured],
  );
  const closeActiveTabFromContext = useCallback(() => {
    if (obscuredRef.current) return;
    return handleCloseActiveTab();
  }, [handleCloseActiveTab]);

  // Register tab functions with context
  useEffect(() => {
    if (!isActive) return;

    if (isEnvironmentRunning && (containerId || isLocalEnvironmentReady)) {
      setCreateTab(createTabFromContext);
      setSelectTab(selectTabFromContext);
      setCloseActiveTab(closeActiveTabFromContext);
      const allTabs = getAllTabs(environmentId);
      setTabCount(allTabs.length);
      setCreateFileTab(createFileTabFromContext);
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
    createTabFromContext,
    createFileTabFromContext,
    selectTabFromContext,
    closeActiveTabFromContext,
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

  // Launched and mock graph runs open here (items 213, 214): the active
  // environment's pane answers requests naming it, and picks up one made
  // while it was not on screen.
  useEffect(() => {
    if (!isActive || !isEnvironmentRunning || !(containerId || isLocalEnvironmentReady)) return;
    const open = (request: GraphRunViewRequest): boolean =>
      request.environmentId === environmentId &&
      handleCreateTab("graph-run", {
        graphRun: { runId: request.runId, ...(request.title ? { title: request.title } : {}) },
      });
    // This node's requests only (plan item 4007).
    const pending = takePendingGraphRunView(environmentId, paneLayoutScope);
    if (pending) open(pending);
    return onGraphRunViewRequested(open, paneLayoutScope);
  }, [
    isActive,
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    environmentId,
    handleCreateTab,
    paneLayoutScope,
  ]);

  // A file opened from the project board's files panel names this
  // environment (the project home) before its panes existed. Open it once
  // this environment is active and able to host file tabs.
  const pendingFileOpen = useFilesPanelStore((state) =>
    state.pendingFileOpens.find((request) => request.environmentId === environmentId),
  );
  const filesPanel = useNodeScope().store(filesPanelStore);
  useEffect(() => {
    if (!pendingFileOpen || pendingFileOpen.environmentId !== environmentId) return;
    if (!isActive || !isEnvironmentRunning || !(containerId || isLocalEnvironmentReady)) return;
    filesPanel.getState().clearPendingFileOpen(pendingFileOpen);
    handleCreateFileTab(pendingFileOpen.filePath, pendingFileOpen.options);
  }, [
    filesPanel,
    pendingFileOpen,
    environmentId,
    isActive,
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    handleCreateFileTab,
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
      log.debug("drag.ended", () => ({
        activeId: active.id,
        overId: over?.id ?? null,
        lastDragOverPaneId,
      }));
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
        log.debug("tab.split-at-edge", () => ({
          edge: action.edge,
          fromPaneId: action.fromPaneId,
        }));
        splitPaneAtEdge(
          action.targetPaneId,
          action.edge,
          action.tabId,
          action.fromPaneId,
          environmentId,
        );
      } else if (action.type === "reorder") {
        log.debug("tab.reordered", () => ({
          fromIndex: action.fromIndex,
          toIndex: action.toIndex,
        }));
        reorderTabs(action.paneId, action.fromIndex, action.toIndex, environmentId);
      } else if (action.type === "move") {
        log.debug("tab.moved", () => ({ toPaneId: action.toPaneId, toIndex: action.toIndex }));
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

  const launchingTabs = useEnvironmentTabLaunches(environmentId);

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
  const environmentCanShowTabs = isEnvironmentRunning && (containerId || isLocalEnvironmentReady);
  const showTerminal =
    environmentCanShowTabs && (thisEnvTabs.length > 0 || launchingTabs.length > 0);
  // Nothing to show yet, and something on the way: outlines rather than a blank pane.
  const showTabsShimmer = environmentCanShowTabs && !showTerminal && setupPhase !== "failed";

  // Debug logging for local environment display issues (only in development)
  if (import.meta.env.DEV) {
    log.debug("display.state", () => ({
      environmentId,
      isLocalEnvironment,
      isLocalEnvironmentReady,
      hasWorktreePath: Boolean(worktreePath),
      isContainerRunning,
      isEnvironmentRunning,
      containerId,
      tabsCount: thisEnvTabs.length,
      showTerminal,
      showNoEnvironmentOverlay,
      showCreatingOverlay,
      showNotRunningOverlay,
    }));
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
              isActive={isActive && !obscured}
              activeDragId={activeDragId}
              dragOverPaneId={dragOverPaneId}
            />
            {/* Terminal portal host - renders all terminals via portals into pane targets */}
            <LazyTerminalPortalHost containerId={containerId} environmentId={environmentId} />
          </div>
        </DndContext>
      )}

      {showTabsShimmer && <EnvironmentTabsShimmer />}

      <TerminalContainerOverlays
        environmentId={environmentId}
        containerId={containerId}
        isLocalEnvironment={isLocalEnvironment}
        isEnvironmentRunning={isEnvironmentRunning}
        showNoEnvironmentOverlay={showNoEnvironmentOverlay}
        showCreatingOverlay={showCreatingOverlay}
        showNotRunningOverlay={showNotRunningOverlay}
        lifecycleError={lifecycleError}
        lifecycleRemedy={lifecycleRemedy}
        projectId={envProjectId ?? null}
        setupPhase={setupPhase}
        createScriptPrompt={createScriptPrompt}
        onStartContainer={onStartContainer}
        onCreateScript={onCreateScript}
        onStartOverlayClick={handleStartOverlayClick}
      />
    </div>
  );
}
