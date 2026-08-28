import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { writeText } from "@/lib/native/clipboard";
import { createTerminalTargetIdentity } from "@/hooks/terminal-target-identity";
import { useTerminal } from "@/hooks/useTerminal";
import { useAgentState } from "@/hooks/useAgentState";
import { useClipboardImagePaste } from "@/hooks/useClipboardImagePaste";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { escapePathForTerminalInput, handleTerminalPaste } from "@/lib/terminal-paste";
import {
  useTerminalSessionStore,
  createSessionKey,
  useConfigStore,
  usePaneLayoutStore,
  useEnvironmentStore,
} from "@/stores";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useSessionStore } from "@/stores/sessionStore";
import {
  useTerminalPortalStore,
  createTerminalKey,
  type PersistentTerminalData,
} from "@/stores/terminalPortalStore";
import { cn } from "@/lib/utils";
import { bootstrapTerminalSession } from "@/lib/backend";
import type { TabType } from "@/contexts";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  ROOT_TERMINAL_USER,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";
import {
  stripAnsi,
  tabTypeToSessionType,
  detectContainerSetupReadiness,
  SETUP_DONE_OSC_ID,
  SETUP_DONE_OSC_DATA,
  SETUP_FAILED_OSC_DATA,
  SETUP_DONE_PRINTF_CMD,
  SETUP_FAILED_PRINTF_CMD,
} from "@/lib/terminal-utils";
import {
  forceTerminalVisibilityRedraw,
  shouldTriggerEnvironmentVisibilityRedraw,
} from "./persistent-terminal-redraw";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ComposeBar, type ImageAttachment } from "@/components/terminal/ComposeBar";
import { CheckCircle2 } from "lucide-react";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { buildAgentLaunchCommand } from "@/lib/agent-launch-command";
import { MobileTerminalKeyBar, resolveTerminalKeyData } from "./MobileTerminalKeyBar";

// Threshold for detecting intermediate/cleared buffer state during React mount cycles.
// If new buffer is less than 50% of stored buffer size, it likely represents a cleared
// or intermediate state that shouldn't overwrite the valid stored content.
const BUFFER_SIZE_THRESHOLD = 0.5;
// A persistent buffer normally resolves almost immediately. Keep enough
// replacement-session output to bridge a slow storage read, but never retain an
// unbounded second copy of a noisy terminal while that read is hung.
const MAX_PENDING_DURABLE_REPLAY_BYTES = 1024 * 1024;
const TERMINAL_BOOTSTRAP_DELAY_MS = 300;
const TERMINAL_BOOTSTRAP_MAX_ATTEMPTS = 3;
// A connection can fail while the desktop event stream or backend process is
// recovering. Give the same target a small bounded retry budget, with backoff,
// without returning to the unbounded isConnecting-driven loop this gate
// replaced.
const TERMINAL_CONNECT_MAX_ATTEMPTS = 3;
const TERMINAL_CONNECT_RETRY_BASE_MS = 250;
// Backoff for re-listing an environment's persisted sessions. Retrying rather
// than falling open matters: proceeding without an authoritative snapshot would
// create a duplicate persistent session for a tab that already has one.
const SESSION_SNAPSHOT_RETRY_BASE_MS = 250;
const SESSION_SNAPSHOT_RETRY_MAX_MS = 5000;
const terminalInputDisposables = new WeakMap<object, { dispose: () => void }>();

type ReplayMetadata = {
  preserveExisting: boolean;
  degraded?: "snapshot-error" | "truncated";
  error?: string;
};

type PendingDurableReplay = {
  chunks: Uint8Array[];
  byteLength: number;
  overflowed: boolean;
};

interface PersistentTerminalProps {
  /** Pre-created terminal data from portal store */
  terminalData: PersistentTerminalData;
  tabId: string;
  tabType: TabType;
  containerId: string | null;
  environmentId: string;
  /** Whether this environment is currently shown in the app */
  isEnvironmentVisible: boolean;
  isActive: boolean;
  /** Whether this terminal is focused (active tab in the active pane) */
  isFocused?: boolean;
  isFirstTab: boolean;
  initialPrompt?: string;
  initialCommands?: string[];
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  paneId: string;
  isSetupTab?: boolean;
  onReady?: (payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => void;
  onSetupComplete?: (payload: { persistSetupComplete: boolean }) => void;
  onWrite?: (write: (data: string) => Promise<void>) => void;
}

/**
 * PersistentTerminal component - handles PTY connection for a pre-created xterm.js Terminal.
 *
 * This component:
 * - Receives a pre-created Terminal instance (doesn't create its own)
 * - Attaches the terminal to DOM only once
 * - Survives pane moves without destruction
 */
export function PersistentTerminal({
  terminalData,
  tabId,
  tabType,
  containerId,
  environmentId,
  isEnvironmentVisible,
  isActive,
  isFocused = false,
  isFirstTab,
  initialPrompt,
  initialCommands,
  isReviewTab = false,
  initialAgentModel,
  initialReasoningEffort,
  paneId,
  isSetupTab,
  onReady,
  onSetupComplete,
  onWrite,
}: PersistentTerminalProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Mirrored into a ref so the focus effect below can read the current
  // viewport without listing isMobile as a dependency: crossing the
  // breakpoint must not re-fire focus on an already-active terminal.
  const isMobileRef = useRef(isMobile);
  const terminalRef = useRef<HTMLDivElement>(null);
  const writeRef = useRef<(data: string) => Promise<void>>(() => Promise.resolve());
  const [isEnvironmentReady, setIsEnvironmentReady] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const [replayWarning, setReplayWarning] = useState<string | null>(null);
  const [bootstrapWarning, setBootstrapWarning] = useState<string | null>(null);
  const composeBarOpenRef = useRef(false); // Ref for synchronous access in key handler
  const dataBufferRef = useRef<string>("");
  const setupCompleteRef = useRef(false);
  const workspaceReadySignaledRef = useRef(false);
  const bootstrapRequestedForSessionRef = useRef<string | null>(null);
  // A failed attachment leaves the hook disconnected. Remember the exact
  // target and its bounded retry budget so the fallback effect does not turn a
  // settled failure into a tight renderer/backend loop. A new session or target
  // gets a different key and is still allowed an immediate attempt.
  const connectionAttemptTargetRef = useRef<string | null>(null);
  const connectionAttemptCountRef = useRef(0);
  const connectionAttemptInFlightRef = useRef<symbol | null>(null);
  const connectionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connectionAttemptSettledRevision, setConnectionAttemptSettledRevision] = useState(0);
  const hasRenderedOutputRef = useRef(false);
  // Render-visible, not a ref: the redraw effect below is a different effect
  // from the one that moves the DOM node, so a ref mutation would not schedule
  // it. A pane move that changes `paneId` without remounting re-runs only the
  // attachment effect, and the forced redraw would silently never fire.
  const [domReattachCount, setDomReattachCount] = useState(0);
  const handledDomReattachRef = useRef(0);
  const pendingDurableReplayRef = useRef<PendingDurableReplay | null>(null);
  const persistentBufferLoadPendingRef = useRef(false);
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialAgentModel || initialReasoningEffort),
  );
  const initialLaunchModel = initialLaunchOptionsRef.current.model;
  const initialLaunchReasoningEffort = initialLaunchOptionsRef.current.reasoningEffort;
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const previousContainerIdRef = useRef<string>(containerId);
  // Initialize with current paneId so first mount doesn't trigger false paneChanged
  const previousPaneIdRef = useRef<string>(paneId);
  // Track if this is the first mount for this effect
  const isFirstMountRef = useRef<boolean>(true);
  // Store buffer content captured during cleanup for restoration on remount
  const pendingBufferRestoreRef = useRef<string | null>(null);
  // Track if restoration is in progress to prevent duplicate restores
  const restorationInProgressRef = useRef<boolean>(false);
  // Track if initial buffer restoration has completed - prevents cleanup from overwriting buffer during mount cycle
  const initialRestorationCompleteRef = useRef<boolean>(false);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  // Get terminal appearance settings from config
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const terminalBackgroundColor = resolveTerminalBackgroundColor(
    terminalAppearance.backgroundColor,
  );
  const terminalScrollback =
    useConfigStore((state) => state.config.global.terminalScrollback) ??
    DEFAULT_TERMINAL_SCROLLBACK;

  // Create a container-scoped session key
  // For local environments (containerId is null), use environmentId to ensure uniqueness
  const sessionKey = createSessionKey(containerId, tabId, environmentId);
  const agentActivityState = useAgentActivityStore((state) => state.tabStates[tabId] ?? "idle");

  // Session persistence
  const existingSession = useTerminalSessionStore((state) => state.sessions.get(sessionKey));
  const setSession = useTerminalSessionStore((state) => state.setSession);
  const setSerializedBuffer = useTerminalSessionStore((state) => state.setSerializedBuffer);
  const existingSessionId = existingSession?.sessionId;
  const serializedBuffer = existingSession?.serializedBuffer;
  const isReconnecting = !!existingSessionId;
  const isBackendManagedSetupTab =
    !!isSetupTab && (!initialCommands || initialCommands.length === 0);
  // Every terminal view asks for the backend-owned transcript. The serialized
  // frontend buffer is retained as a durable fallback when the backend must
  // create a replacement PTY that has no transcript for the previous process.
  const shouldReplayBackendOutputBuffer = true;

  // Track if there was an existing session when component mounted (genuine reconnection)
  // This distinguishes between:
  // 1. App restart/tab switch where we're reconnecting to existing session
  // 2. Newly created environment where session ID gets stored during this mount cycle
  const hadExistingSessionAtMountRef = useRef(!!existingSessionId);

  const [hasReconnected, setHasReconnected] = useState(false);

  // Get terminal store functions via narrow selectors (stable references) —
  // a selector-less subscription rerendered every terminal on any store write.
  const markTerminalOpened = useTerminalPortalStore((state) => state.markTerminalOpened);
  const setTerminalContainer = useTerminalPortalStore((state) => state.setTerminalContainer);
  const setTerminalPane = useTerminalPortalStore((state) => state.setTerminalPane);
  const recreateTerminal = useTerminalPortalStore((state) => state.recreateTerminal);

  // Subscribe to containerElement and isOpened from store to ensure we have the latest values
  // (props might be stale if store was updated after TerminalPortalHost rendered)
  const terminalKey = createTerminalKey(environmentId, tabId);
  const storedContainerElement = useTerminalPortalStore(
    (state) => state.terminals.get(terminalKey)?.containerElement ?? null,
  );
  const terminalIsOpened = useTerminalPortalStore(
    (state) => state.terminals.get(terminalKey)?.isOpened ?? false,
  );

  // Check if this is a local environment (uses worktree instead of Docker container)
  const isLocalEnvironment = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.environmentType === "local",
  );

  // The authoritative record of whether setup already finished. `setupCompleteRef`
  // is only ever set by a live OSC marker, so it resets to false on every mount —
  // a restored setup tab (whose `isSetupTab` marker is now durable) would
  // otherwise re-offer "Mark setup complete" for setup that finished long ago.
  const setupScriptsComplete = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.setupScriptsComplete ?? false,
  );

  useEffect(() => {
    if (!isSetupTab) return;
    console.info("[setup-terminal] PersistentTerminal setup attach state", {
      environmentId,
      tabId,
      sessionKey,
      existingSessionId: existingSessionId ?? null,
      isBackendManagedSetupTab,
      shouldReplayBackendOutputBuffer,
      attachExistingOnly: isBackendManagedSetupTab,
      isLocalEnvironment,
      containerId,
      initialCommandCount: initialCommands?.length ?? 0,
      serializedBufferChars: serializedBuffer?.length ?? 0,
    });
  }, [
    containerId,
    environmentId,
    existingSessionId,
    initialCommands?.length,
    isBackendManagedSetupTab,
    isLocalEnvironment,
    isSetupTab,
    serializedBuffer?.length,
    sessionKey,
    shouldReplayBackendOutputBuffer,
    tabId,
  ]);

  // Get worktree path for local environments (needed for image paste)
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath ?? null,
  );

  // Extract terminal and addons from terminalData
  const { terminal, fitAddon, serializeAddon } = terminalData;

  // Track selection state for clipboard actions
  useEffect(() => {
    const updateSelection = () => {
      setHasSelection(terminal.hasSelection());
    };
    updateSelection();
    const disposable = terminal.onSelectionChange(updateSelection);
    return () => disposable.dispose();
  }, [terminal]);

  // Clipboard image paste handler
  const handleImageSaved = useCallback(
    async (filePath: string) => {
      const terminalPath = isLocalEnvironment ? escapePathForTerminalInput(filePath) : filePath;
      await writeRef.current(terminalPath + " ");
      terminal.focus();
    },
    [isLocalEnvironment, terminal],
  );

  const handleImageError = useCallback((error: string) => {
    console.error("[PersistentTerminal] Clipboard image error:", error);
  }, []);

  useClipboardImagePaste({
    containerId,
    worktreePath,
    isActive: isFocused && !isComposeBarOpen,
    onImageSaved: handleImageSaved,
    onError: handleImageError,
  });

  const handleCopySelection = useCallback(async () => {
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await writeText(selection);
    } catch (err) {
      console.error("[PersistentTerminal] Failed to copy selection:", err);
    }
  }, [terminal]);

  const handleSelectAll = useCallback(() => {
    terminal.selectAll();
    terminal.focus();
  }, [terminal]);

  const handlePaste = useCallback(async () => {
    await handleTerminalPaste({
      containerId,
      worktreePath,
      writeToTerminal: writeRef.current,
      focusTerminal: () => terminal.focus(),
      componentName: "PersistentTerminal",
    });
  }, [containerId, worktreePath, terminal]);

  // Keep compose bar ref in sync with state for synchronous access in key handler
  useEffect(() => {
    composeBarOpenRef.current = isComposeBarOpen;
  }, [isComposeBarOpen]);

  // Toggle compose bar
  const toggleComposeBar = useCallback(() => {
    setIsComposeBarOpen((prev) => !prev);
  }, []);

  // Handle compose bar send - inject images and text into terminal.
  // Each item is sent one at a time with a delay to allow Claude Code to process each input.
  // Note: Text newlines are converted to spaces since Claude Code's input doesn't support
  // multi-line pasting - each Enter would submit the current line.
  const handleComposeSend = useCallback(
    async (images: ImageAttachment[], text: string) => {
      // Delay between sending images to allow Claude Code time to process each input.
      // Claude Code needs time to parse and acknowledge each file path before receiving the next.
      const CLAUDE_CODE_INPUT_DELAY_MS = 200;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // Send each image one by one with a delay to let Claude Code process each.
      // The img.id contains the saved attachment path (set by ComposeBar.handleSend).
      for (const img of images) {
        const terminalPath = isLocalEnvironment ? escapePathForTerminalInput(img.id) : img.id;
        await writeRef.current(terminalPath);
        await writeRef.current("\r");
        await delay(CLAUDE_CODE_INPUT_DELAY_MS);
      }

      // Then send the text
      if (text) {
        const singleLineText = text.replace(/[\r\n]+/g, " ").trim();
        await writeRef.current(singleLineText);
        await writeRef.current("\r");
      }

      // Keep compose bar open but refocus terminal
      terminal.focus();
    },
    [isLocalEnvironment, terminal],
  );

  const handleAddressAll = useCallback(() => {
    void handleComposeSend([], ADDRESS_ALL_REVIEW_PROMPT);
  }, [handleComposeSend]);

  // Track mount lifecycle - reset restoration flag on mount
  useEffect(() => {
    initialRestorationCompleteRef.current = false;
    return () => {
      // React Strict Mode cancels the first development-only connection before
      // replaying mount effects. Rearm the bounded connection gate for that
      // replay; a genuine remount receives a fresh ref and behaves the same way.
      connectionAttemptTargetRef.current = null;
      connectionAttemptCountRef.current = 0;
      connectionAttemptInFlightRef.current = null;
      if (connectionRetryTimerRef.current !== null) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
    };
  }, [tabId, environmentId]);

  // Reset state when containerId changes
  useEffect(() => {
    if (previousContainerIdRef.current !== containerId) {
      setIsEnvironmentReady(false);
      dataBufferRef.current = "";
      workspaceReadySignaledRef.current = false;
      connectionAttemptTargetRef.current = null;
      connectionAttemptCountRef.current = 0;
      connectionAttemptInFlightRef.current = null;
      if (connectionRetryTimerRef.current !== null) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
      hasRenderedOutputRef.current = false;
      initialRestorationCompleteRef.current = false;
      previousContainerIdRef.current = containerId;
    }
  }, [containerId, tabId]);

  // NOTE: Pane tracking is updated in the main DOM attachment effect
  // We used to have a separate effect here, but it caused timing issues
  // because effects run in order and it would update previousPaneIdRef
  // before the main effect could check for pane changes.

  // Handle terminal data from backend
  const handleData = useCallback(
    (data: Uint8Array) => {
      const pendingReplay = pendingDurableReplayRef.current;
      if (pendingReplay && !pendingReplay.overflowed) {
        if (pendingReplay.byteLength + data.length <= MAX_PENDING_DURABLE_REPLAY_BYTES) {
          pendingReplay.chunks.push(data.slice());
          pendingReplay.byteLength += data.length;
        } else {
          // The terminal already received every byte, so retain its current
          // valid parser state instead of later resetting it from an incomplete
          // pending tail.
          pendingReplay.chunks = [];
          pendingReplay.byteLength = 0;
          pendingReplay.overflowed = true;
          setReplayWarning(
            "Saved terminal history loaded too slowly. Current output was retained.",
          );
        }
      }

      terminal.write(data);
      if (data.length > 0) {
        hasRenderedOutputRef.current = true;
      }

      // Readiness detection is the only decoded-text consumer. Once ready,
      // bytes go straight to xterm without allocating a decoder and a
      // duplicate string for every output chunk.
      const text = isEnvironmentReady ? "" : new TextDecoder().decode(data);

      // For first tab only: detect environment ready state
      if (isFirstTab && !isEnvironmentReady) {
        dataBufferRef.current += text;
        const strippedBuffer = stripAnsi(dataBufferRef.current);

        if (isLocalEnvironment) {
          // Local environments: detect shell prompt readiness (no Docker markers exist)
          const hasShellPrompt = strippedBuffer.includes("➜") || strippedBuffer.includes("❯");
          // Match "$ " or "% " only at line start or after whitespace to avoid false positives on command output
          const hasGenericPrompt = /(?:^|\n)\s*[$%] /m.test(strippedBuffer);
          // Length fallback: only trigger if buffer ends with a newline (prompt line fully rendered)
          const hasLengthFallback =
            strippedBuffer.length > 500 && /(?:\r?\n)$/.test(strippedBuffer);

          if (hasShellPrompt || hasGenericPrompt || hasLengthFallback) {
            console.log(
              "[PersistentTerminal] Local environment ready detected for first tab:",
              tabId,
            );
            setIsEnvironmentReady(true);
            dataBufferRef.current = "";
            onReady?.({ persistSetupComplete: false, workspaceReady: true });
          } else if (dataBufferRef.current.length > 1024) {
            dataBufferRef.current = dataBufferRef.current.slice(-512);
          }
        } else {
          // Container environments: wait for explicit completion markers from workspace-setup.sh
          // IMPORTANT: We must NOT use shell prompt fallbacks because:
          // 1. Shell prompts (➜) appear between setup commands
          // 2. Git clone output contains "workspace", "main", etc.
          // 3. We need to wait for ALL setup scripts in orkestrator-ai.json to complete
          // 4. Reused containers short-circuit setup and emit "Workspace already set up."
          const { ready: readyDetected, failed: setupFailed } = detectContainerSetupReadiness(
            dataBufferRef.current,
          );

          if (readyDetected) {
            console.log(
              "[PersistentTerminal] Environment ready detected for tab:",
              tabId,
              "isFirstTab:",
              isFirstTab,
            );
            setIsEnvironmentReady(true);
            dataBufferRef.current = "";
            if (!workspaceReadySignaledRef.current) {
              workspaceReadySignaledRef.current = true;
              onReady?.({ persistSetupComplete: !setupFailed, workspaceReady: true });
            }
          }

          // Keep buffer from growing indefinitely, but use a larger window to catch markers
          if (dataBufferRef.current.length > 4096) {
            dataBufferRef.current = dataBufferRef.current.slice(-2048);
          }
        }
      }

      // For non-first tabs, consider immediately ready once we see a shell prompt
      if (!isFirstTab && !isEnvironmentReady) {
        dataBufferRef.current += text;
        const strippedBuffer = stripAnsi(dataBufferRef.current);

        const hasZshPrompt = strippedBuffer.includes("➜") || strippedBuffer.includes("❯");
        const hasWorkspace = strippedBuffer.includes("/workspace");

        if (hasZshPrompt || hasWorkspace || strippedBuffer.length > 100) {
          console.debug("[PersistentTerminal] Shell ready for non-first tab:", tabId);
          setIsEnvironmentReady(true);
          dataBufferRef.current = "";
        }

        if (dataBufferRef.current.length > 1024) {
          dataBufferRef.current = dataBufferRef.current.slice(-512);
        }
      }
    },
    [terminal, isFirstTab, isLocalEnvironment, isEnvironmentReady, tabId, onReady],
  );

  const handleReplay = useCallback(
    (data: Uint8Array, metadata: ReplayMetadata) => {
      const { preserveExisting, degraded } = metadata;
      dataBufferRef.current = "";

      if (degraded === "snapshot-error") {
        setReplayWarning(
          "Terminal history could not be synchronized. Existing history and live output were retained.",
        );
      } else if (degraded === "truncated") {
        setReplayWarning("Terminal history was truncated. Earlier output may be unavailable.");
      } else {
        setReplayWarning(null);
      }

      // A truncated snapshot can begin inside an ANSI escape sequence or UTF-8
      // character, so it must never be fed to xterm. A failed snapshot likewise
      // has no authoritative bytes with which to replace the current view. Only
      // a durable SerializeAddon buffer is safe to reset from; otherwise preserve
      // the existing parser state and wait for post-cursor live output.
      if (degraded) {
        pendingDurableReplayRef.current = null;
        if (serializedBuffer && !hasRenderedOutputRef.current) {
          terminal.clear();
          terminal.reset();
          handleData(new TextEncoder().encode(serializedBuffer));
        } else if (persistentBufferLoadPendingRef.current) {
          // Do not retain a truncated snapshot for the later reset. Only bytes
          // received after the snapshot cursor are safe to append to the durable
          // checkpoint when it arrives.
          pendingDurableReplayRef.current = {
            chunks: [],
            byteLength: 0,
            overflowed: false,
          };
        }
        terminal.scrollToBottom();
        return;
      }

      // A snapshot for a reused session is authoritative, including when it is
      // empty. A newly-created replacement session has no backend transcript of
      // the previous PTY, so restore the durable serialized view before showing
      // output produced by the replacement.
      let replayData = data;
      const trackUntilDurableHistoryLoads =
        preserveExisting && !serializedBuffer && persistentBufferLoadPendingRef.current;
      if (preserveExisting && serializedBuffer) {
        pendingDurableReplayRef.current = null;
        const durableData = new TextEncoder().encode(serializedBuffer);
        replayData = new Uint8Array(durableData.length + data.length);
        replayData.set(durableData);
        replayData.set(data, durableData.length);
      } else {
        pendingDurableReplayRef.current = null;
      }

      terminal.clear();
      terminal.reset();
      handleData(replayData);
      if (trackUntilDurableHistoryLoads) {
        // Persistent storage can finish loading after the replacement session
        // attaches. Keep the snapshot and any subsequent live bytes so the
        // durable view can be prepended later without dropping interim output.
        pendingDurableReplayRef.current = {
          chunks: data.length > 0 ? [data.slice()] : [],
          byteLength: data.length,
          overflowed: false,
        };
      }
      terminal.scrollToBottom();
    },
    [handleData, serializedBuffer, terminal],
  );

  useEffect(() => {
    const pendingReplay = pendingDurableReplayRef.current;
    if (!serializedBuffer) return;

    if (!pendingReplay) {
      // A completed setup terminal may have no live backend PTY to attach to.
      // Its durable checkpoint is therefore the only authoritative view. Render
      // it directly instead of waiting for an onReplay callback that cannot
      // arrive from attachExistingOnly without an existing session id.
      if (!isBackendManagedSetupTab || existingSessionId || hasRenderedOutputRef.current) return;
      terminal.clear();
      terminal.reset();
      handleData(new TextEncoder().encode(serializedBuffer));
      terminal.scrollToBottom();
      return;
    }

    pendingDurableReplayRef.current = null;
    if (pendingReplay.overflowed) {
      return;
    }

    const durableData = new TextEncoder().encode(serializedBuffer);
    const replayData = new Uint8Array(durableData.length + pendingReplay.byteLength);
    replayData.set(durableData);
    let offset = durableData.length;
    for (const chunk of pendingReplay.chunks) {
      replayData.set(chunk, offset);
      offset += chunk.length;
    }
    terminal.clear();
    terminal.reset();
    handleData(replayData);
    terminal.scrollToBottom();
  }, [existingSessionId, handleData, isBackendManagedSetupTab, serializedBuffer, terminal]);

  // Register an invisible OSC escape handler for setup completion detection.
  // When the setup command finishes, it emits an OSC sequence that xterm.js
  // intercepts without rendering — no visible marker in the terminal.
  useEffect(() => {
    if (!isSetupTab) return;

    const disposable = terminal.parser.registerOscHandler(SETUP_DONE_OSC_ID, (data) => {
      if (setupCompleteRef.current) return true;
      if (data === SETUP_DONE_OSC_DATA || data === SETUP_FAILED_OSC_DATA) {
        const succeeded = data === SETUP_DONE_OSC_DATA;
        console.log(
          "[PersistentTerminal] Setup scripts completed (OSC) for tab:",
          tabId,
          "succeeded:",
          succeeded,
        );
        setupCompleteRef.current = true;
        onSetupComplete?.({ persistSetupComplete: succeeded });
      }
      return true;
    });

    return () => disposable.dispose();
  }, [terminal, isSetupTab, tabId, onSetupComplete]);

  // Determine user based on tab type - root tabs connect as orkroot
  const terminalUser = tabType === "root" ? ROOT_TERMINAL_USER : undefined;
  const trackEnvironmentActivity =
    tabType === "claude" ||
    tabType === "opencode" ||
    tabType === "codex" ||
    tabType === "pi" ||
    tabType === "cursor" ||
    tabType === "grok";

  const {
    sessionId,
    bootstrapped,
    isConnected,
    isConnecting,
    connect,
    markBootstrapped,
    resize,
    write,
  } = useTerminal({
    containerId,
    environmentId,
    isLocal: isLocalEnvironment,
    onData: handleData,
    onReplay: handleReplay,
    terminalKey: tabId,
    existingSessionId,
    persistSession: true,
    user: terminalUser,
    replayOutputBuffer: shouldReplayBackendOutputBuffer,
    attachExistingOnly: isBackendManagedSetupTab,
    trackEnvironmentActivity,
  });

  // Keep connect ref up to date to avoid stale closures in effects
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const connectionAttemptTarget = JSON.stringify({
    // Built from the same fields useTerminal invalidates a connection on. A
    // field that resets the hook but is missing here would strand a terminal
    // disconnected behind a gate that never reopens, so there is one builder.
    target: createTerminalTargetIdentity({
      containerId,
      environmentId,
      isLocal: isLocalEnvironment,
      terminalKey: tabId,
      user: terminalUser,
      replayOutputBuffer: shouldReplayBackendOutputBuffer,
      attachExistingOnly: isBackendManagedSetupTab,
      trackEnvironmentActivity,
    }),
    // The session this attempt would attach to. The stored id is preferred so
    // that a store rewrite which drops `sessionId` — the persistent-session
    // metadata restore below does exactly that — falls back to the hook's own
    // session instead of reading as a brand new target. A genuinely different
    // session id *is* a new target: the fallback effect only runs while
    // disconnected, so attaching to it is the work that still needs doing.
    sessionId: existingSessionId ?? sessionId ?? null,
  });
  // Read through a ref so this callback keeps a stable identity. The
  // DOM/attachment effect below depends on it, and that effect's cleanup
  // serializes the entire scrollback into the session store — re-running it
  // every time the hook publishes a freshly created session id is work nobody
  // asked for, on the most side-effect-heavy effect in this file.
  const currentConnectionTargetRef = useRef(connectionAttemptTarget);
  useEffect(() => {
    currentConnectionTargetRef.current = connectionAttemptTarget;
    if (connectionAttemptTargetRef.current !== connectionAttemptTarget) {
      connectionAttemptCountRef.current = 0;
      connectionAttemptInFlightRef.current = null;
      if (connectionRetryTimerRef.current !== null) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
    }
  }, [connectionAttemptTarget]);
  const connectToCurrentTarget = useCallback(() => {
    const target = currentConnectionTargetRef.current;
    if (connectionAttemptTargetRef.current !== target) {
      connectionAttemptTargetRef.current = target;
      connectionAttemptCountRef.current = 0;
      connectionAttemptInFlightRef.current = null;
    }
    if (
      connectionAttemptInFlightRef.current ||
      connectionAttemptCountRef.current >= TERMINAL_CONNECT_MAX_ATTEMPTS
    ) {
      return false;
    }

    connectionAttemptCountRef.current += 1;
    const attemptToken = Symbol(target);
    connectionAttemptInFlightRef.current = attemptToken;
    void connectRef
      .current()
      // useTerminal currently reports failures through state and resolves, but
      // keep an unexpected rejection from becoming an unhandled promise while
      // still letting the retry budget observe that the attempt settled.
      .catch(() => undefined)
      .finally(() => {
        if (
          connectionAttemptTargetRef.current !== target ||
          connectionAttemptInFlightRef.current !== attemptToken
        ) {
          return;
        }
        connectionAttemptInFlightRef.current = null;
        setConnectionAttemptSettledRevision((revision) => revision + 1);
      });
    return true;
  }, []);

  // A later loss of a healthy connection is a new recovery episode even when
  // it points at the same backend PTY, so grant it a fresh bounded budget.
  useEffect(() => {
    if (!isConnected) return;
    connectionAttemptTargetRef.current = null;
    connectionAttemptCountRef.current = 0;
    connectionAttemptInFlightRef.current = null;
    if (connectionRetryTimerRef.current !== null) {
      clearTimeout(connectionRetryTimerRef.current);
      connectionRetryTimerRef.current = null;
    }
  }, [isConnected]);

  // Persistent session tracking
  const persistentSessionCreatedRef = useRef(false);
  const persistentSessionIdRef = useRef<string | null>(null);
  const creationInProgressRef = useRef(false);
  const hasRestoredFromPersistentRef = useRef(false);

  // Narrow selectors: actions are stable references; only the loading flag for
  // THIS environment is subscribed to reactively.
  const createPersistentSession = useSessionStore((state) => state.createSession);
  const updateSessionActivity = useSessionStore((state) => state.updateSessionActivity);
  const savePersistentSessionBuffer = useSessionStore((state) => state.saveSessionBuffer);
  const loadPersistentSessionBuffer = useSessionStore((state) => state.loadSessionBuffer);
  const getSessionsByEnvironment = useSessionStore((state) => state.getSessionsByEnvironment);
  const updateSessionStatus = useSessionStore((state) => state.updateSessionStatus);
  const loadSessionsForEnvironment = useSessionStore((state) => state.loadSessionsForEnvironment);
  const setPersistentSessionId = useTerminalSessionStore((state) => state.setPersistentSessionId);
  const sessionSnapshotGeneration = useSessionStore(
    (state) => state.sessionSnapshotGenerations.get(environmentId) ?? 0,
  );
  const sessionSnapshotBaselineRef = useRef({
    environmentId,
    generation: sessionSnapshotGeneration,
  });
  if (sessionSnapshotBaselineRef.current.environmentId !== environmentId) {
    sessionSnapshotBaselineRef.current = {
      environmentId,
      generation: sessionSnapshotGeneration,
    };
  }
  const sessionSnapshotBaseline = sessionSnapshotBaselineRef.current.generation;
  const [, setSessionHydrationCheck] = useState(0);
  const hasFreshSessionSnapshot = sessionSnapshotGeneration > sessionSnapshotBaseline;

  // Ensure sessions are loaded for this environment.
  //
  // This retries until the store publishes a snapshot newer than the one this
  // mount began with. An "ever loaded" marker is not sufficient: a remount must
  // not restore from stale renderer state while its current backend refresh is
  // pending or failed. A concurrent terminal's successful refresh also advances
  // the generation and can safely satisfy this mount.
  useEffect(() => {
    if (!environmentId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const runLoad = () => {
      if (
        (useSessionStore.getState().sessionSnapshotGenerations.get(environmentId) ?? 0) >
        sessionSnapshotBaseline
      ) {
        setSessionHydrationCheck((revision) => revision + 1);
        return;
      }
      void loadSessionsForEnvironment(environmentId)
        .catch((err) => {
          console.error("[PersistentTerminal] Failed to load persistent sessions:", err);
        })
        .then(() => {
          if (cancelled) return;
          // The promise resolving is not proof a fresh snapshot landed: the
          // store contains failures and superseded requests without publishing.
          // Only a newer successful generation is authoritative for this mount.
          if (
            (useSessionStore.getState().sessionSnapshotGenerations.get(environmentId) ?? 0) >
            sessionSnapshotBaseline
          ) {
            setSessionHydrationCheck((revision) => revision + 1);
            return;
          }
          const delay = Math.min(
            SESSION_SNAPSHOT_RETRY_BASE_MS * 2 ** attempt,
            SESSION_SNAPSHOT_RETRY_MAX_MS,
          );
          attempt += 1;
          retryTimer = setTimeout(runLoad, delay);
        });
    };

    runLoad();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [environmentId, loadSessionsForEnvironment, sessionSnapshotBaseline]);

  // Restore only after the store has received an authoritative snapshot. The
  // load effect above updates Zustand synchronously before awaiting the backend,
  // but this effect still observes values from the render that scheduled it.
  // Treating that initial empty map as authoritative permanently skipped the
  // saved buffer on cold mounts.
  useEffect(() => {
    if (!environmentId) return;
    // A PTY created during this mount is published to the terminal store before
    // an async persistent-session snapshot can arrive. Only a session that was
    // already present when this component mounted proves restoration is already
    // represented locally; consulting the live value would suppress the durable
    // buffer load on every cold connection slower than the PTY handshake.
    if (hadExistingSessionAtMountRef.current) return;
    if (hasRestoredFromPersistentRef.current) return;
    if (!hasFreshSessionSnapshot) return;

    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      hasRestoredFromPersistentRef.current = true;

      console.debug(
        "[PersistentTerminal] Restoring from persistent session:",
        existingPersistentSession.id,
      );

      setSession(sessionKey, {
        persistentSessionId: existingPersistentSession.id,
      });

      persistentBufferLoadPendingRef.current = true;
      loadPersistentSessionBuffer(existingPersistentSession.id)
        .then((buffer) => {
          persistentBufferLoadPendingRef.current = false;
          if (buffer) {
            console.debug("[PersistentTerminal] Loaded persistent buffer, length:", buffer.length);
            setSerializedBuffer(sessionKey, buffer);
          } else {
            pendingDurableReplayRef.current = null;
          }
        })
        .catch((err) => {
          persistentBufferLoadPendingRef.current = false;
          pendingDurableReplayRef.current = null;
          setReplayWarning(
            "Saved terminal history could not be loaded. Current output was retained.",
          );
          console.error("[PersistentTerminal] Failed to load persistent buffer:", err);
        });
    } else {
      hasRestoredFromPersistentRef.current = true;
    }
  }, [
    acknowledgeInitialLaunchOptions,
    environmentId,
    tabId,
    sessionKey,
    hasFreshSessionSnapshot,
    loadPersistentSessionBuffer,
    getSessionsByEnvironment,
    setSession,
    setSerializedBuffer,
  ]);

  // Store session ID when we get one
  useEffect(() => {
    if (sessionId && sessionId !== existingSessionId) {
      console.debug(
        "[PersistentTerminal] Storing new session ID for sessionKey:",
        sessionKey,
        sessionId,
      );
      const currentSession = useTerminalSessionStore.getState().sessions.get(sessionKey);
      setSession(sessionKey, {
        ...currentSession,
        sessionId,
      });
    }
  }, [sessionId, existingSessionId, sessionKey, setSession]);

  // Create persistent session for sidebar tracking
  useEffect(() => {
    if (!hasFreshSessionSnapshot) return;
    if (!sessionId || !environmentId) return;
    if (persistentSessionCreatedRef.current || creationInProgressRef.current) return;

    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      console.debug(
        "[PersistentTerminal] Found existing persistent session:",
        existingPersistentSession.id,
      );
      persistentSessionCreatedRef.current = true;
      persistentSessionIdRef.current = existingPersistentSession.id;
      setPersistentSessionId(sessionKey, existingPersistentSession.id);
      if (existingPersistentSession.status === "disconnected") {
        updateSessionStatus(existingPersistentSession.id, "connected").catch((err) => {
          console.error("[PersistentTerminal] Failed to update session status:", err);
        });
      }
    } else {
      creationInProgressRef.current = true;
      const sessionType = tabTypeToSessionType(tabType);
      const persistentContainerId = containerId ?? "";

      console.debug("[PersistentTerminal] Creating persistent session:", {
        sessionId,
        environmentId,
        tabType: sessionType,
        persistentContainerId,
      });
      createPersistentSession(environmentId, persistentContainerId, tabId, sessionType)
        .then((session) => {
          console.debug("[PersistentTerminal] Persistent session created:", session.id);
          persistentSessionIdRef.current = session.id;
          persistentSessionCreatedRef.current = true;
          setPersistentSessionId(sessionKey, session.id);
        })
        .catch((err) => {
          console.error("[PersistentTerminal] Failed to create persistent session:", err);
        })
        .finally(() => {
          creationInProgressRef.current = false;
        });
    }
  }, [
    sessionId,
    containerId,
    environmentId,
    tabId,
    tabType,
    sessionKey,
    createPersistentSession,
    getSessionsByEnvironment,
    setPersistentSessionId,
    updateSessionStatus,
    hasFreshSessionSnapshot,
  ]);

  // Update session activity on user interaction
  const lastActivityUpdateRef = useRef<number>(0);
  const updateActivityThrottledRef = useRef<() => void>(() => {});

  useEffect(() => {
    updateActivityThrottledRef.current = () => {
      const now = Date.now();
      const persistentId = persistentSessionIdRef.current;
      if (persistentId && now - lastActivityUpdateRef.current > 30000) {
        lastActivityUpdateRef.current = now;
        updateSessionActivity(persistentId).catch((err) => {
          console.debug("[PersistentTerminal] Failed to update session activity:", err);
        });
      }
    };
  }, [updateSessionActivity]);

  // When reconnecting, restore metadata after the backend transcript replay.
  useEffect(() => {
    if (isReconnecting && isConnected && !hasReconnected) {
      // Mark initial restoration as complete - cleanup can now safely serialize
      initialRestorationCompleteRef.current = true;
      setHasReconnected(true);

      // Only call onReady from reconnection path if:
      // 1. This is not the first tab, OR
      // 2. This is the first tab but there was already a session at mount time (genuine reconnection)
      //
      // For the first tab on a NEW environment (no session at mount), we let handleData
      // detect when setup scripts have finished before calling onReady.
      // IMPORTANT: Don't set isEnvironmentReady to true in that case either, so handleData can
      // continue to monitor for setup completion.
      if (!isFirstTab || hadExistingSessionAtMountRef.current) {
        if (isFirstTab && !isLocalEnvironment) {
          const { ready, failed } = detectContainerSetupReadiness(serializedBuffer ?? "");
          if (ready) {
            setIsEnvironmentReady(true);
            console.log(
              "[PersistentTerminal] Reconnection buffer contains setup readiness marker for tab:",
              tabId,
            );
            if (!workspaceReadySignaledRef.current) {
              workspaceReadySignaledRef.current = true;
              onReady?.({ persistSetupComplete: !failed, workspaceReady: true });
            }
          } else {
            console.log(
              "[PersistentTerminal] Reconnected first container tab without setup marker, keeping readiness detection active for tab:",
              tabId,
            );
          }
        } else {
          setIsEnvironmentReady(true);
          console.log(
            "[PersistentTerminal] Reconnection complete, calling onReady for tab:",
            tabId,
          );
          onReady?.({ persistSetupComplete: false, workspaceReady: false });
        }
      } else {
        // Leave isEnvironmentReady as false so handleData can detect setup completion
        console.log(
          "[PersistentTerminal] First tab on new environment, waiting for setup detection before calling onReady, tab:",
          tabId,
        );
      }
    }
  }, [
    isReconnecting,
    isConnected,
    hasReconnected,
    tabId,
    environmentId,
    onReady,
    serializedBuffer,
    terminal,
    fitAddon,
    isFirstTab,
    isLocalEnvironment,
  ]);

  // Persistent session buffers can arrive after the PTY reconnection effect has
  // already run. If that restored buffer contains setup completion, rehydrate
  // the workspace-ready gate from it so inactive setup completion is not lost.
  useEffect(() => {
    if (!isFirstTab || isLocalEnvironment || isEnvironmentReady || !serializedBuffer) {
      return;
    }

    const { ready, failed } = detectContainerSetupReadiness(serializedBuffer);
    if (!ready) {
      return;
    }

    setIsEnvironmentReady(true);
    if (!workspaceReadySignaledRef.current) {
      workspaceReadySignaledRef.current = true;
      console.log(
        "[PersistentTerminal] Restored buffer contains setup readiness marker for tab:",
        tabId,
      );
      onReady?.({ persistSetupComplete: !failed, workspaceReady: true });
    }
  }, [isFirstTab, isLocalEnvironment, isEnvironmentReady, serializedBuffer, tabId, onReady]);

  // Monitor Claude activity state
  useAgentState(containerId, tabId);

  const fitAnimationFrameRef = useRef<number | null>(null);
  const scheduleFit = useCallback(() => {
    if (!fitAddon || !terminal) return;
    if (fitAnimationFrameRef.current !== null) {
      cancelAnimationFrame(fitAnimationFrameRef.current);
    }
    fitAnimationFrameRef.current = requestAnimationFrame(() => {
      fitAnimationFrameRef.current = null;
      if (!fitAddon || !terminal) return;
      fitAddon.fit();
      const { cols, rows } = terminal;
      resize(cols, rows);
    });
  }, [fitAddon, terminal, resize]);

  // Keep write ref up to date
  useEffect(() => {
    writeRef.current = write;
  }, [write]);

  useEffect(() => {
    if (isConnected) {
      onWrite?.(writeRef.current);
    }
  }, [isConnected, onWrite]);

  // Attach terminal to DOM and set up input handlers
  // This effect handles two cases:
  // 1. First mount: Create container element, open terminal to it, set up handlers
  // 2. Remount (after portal target changes): Reuse stored container element, set up handlers
  //
  // CRITICAL: xterm.js opens to a specific DOM element and cannot be moved.
  // We store the container element in terminalData and reuse it across remounts.
  // When remounting, we append the existing element to the new wrapper div.
  useEffect(() => {
    if (!terminalRef.current) return;

    // Use the stored container element from the store (most up-to-date)
    // instead of the prop which might be stale
    let containerElement = storedContainerElement;

    // If terminal hasn't been opened yet, create container and open to it
    if (!terminalIsOpened) {
      // Mark first mount complete (no pane change detection on initial open)
      isFirstMountRef.current = false;
      previousPaneIdRef.current = paneId;

      // Create a new container element for the terminal
      containerElement = document.createElement("div");
      containerElement.style.width = "100%";
      containerElement.style.height = "100%";
      containerElement.style.position = "absolute";
      containerElement.style.inset = "0";

      // Append to wrapper and open terminal
      terminalRef.current.appendChild(containerElement);

      terminal.open(containerElement);

      markTerminalOpened(environmentId, tabId);
      setTerminalContainer(environmentId, tabId, containerElement);

      // Initial fit and font loading
      fitAddon.fit();

      scheduleFit();
      if (document?.fonts?.ready) {
        document.fonts.ready
          .then(() => {
            // Force xterm to re-measure character dimensions by re-setting font options
            // This is critical: if fonts weren't fully loaded when terminal.open() was called,
            // xterm measured fallback fonts and cached those cell dimensions.
            // Re-setting fontSize triggers xterm to recalculate character metrics.
            const { fontSize } = terminal.options;
            if (fontSize) terminal.options.fontSize = fontSize;
            scheduleFit();
          })
          .catch(() => {});
      }
      setTimeout(() => {
        // Also force font re-measurement in timeout as a fallback
        const { fontSize } = terminal.options;
        if (fontSize) terminal.options.fontSize = fontSize;
        scheduleFit();
      }, 50);

      // Immediately connect after opening terminal to avoid a race where the
      // portal store update has not yet exposed terminalIsOpened to the
      // fallback effect. The mount-lifecycle cleanup rearms this under Strict
      // Mode after useTerminal cancels the probe connection.
      if (connectionAttemptTargetRef.current !== currentConnectionTargetRef.current) {
        if (!isReconnecting) {
          initialRestorationCompleteRef.current = true;
        }
        connectToCurrentTarget();
      }
    } else if (containerElement) {
      // Terminal already opened - reuse the stored container element
      // Only move if it's not already attached to this wrapper
      const parentNode = containerElement.parentNode;
      const needsDOMMove = parentNode !== terminalRef.current;

      // Check if the terminal LOGICALLY moved to a different pane
      // This is the key distinction: DOM may need to reconnect even if pane didn't change
      // (e.g., when portal targets are recreated during pane structure changes)
      // We only need buffer restoration if the logical pane changed
      // Skip this check on first mount (use isFirstMountRef)
      const paneChanged = !isFirstMountRef.current && previousPaneIdRef.current !== paneId;

      // Update tracking refs AFTER using them for comparison
      previousPaneIdRef.current = paneId;
      isFirstMountRef.current = false;

      if (needsDOMMove) {
        // Check what's inside the container BEFORE moving
        const xtermElementBefore = containerElement.querySelector(".xterm");
        const hasXtermBefore = !!xtermElementBefore;

        // CRITICAL: If xterm's DOM structure is already missing, we need to recreate the terminal
        // This can happen when the container was detached from DOM for too long and xterm disposed itself
        if (!hasXtermBefore) {
          // Recreate the terminal - this will trigger a re-render with new terminalData
          const newTerminalData = recreateTerminal(environmentId, tabId);
          if (newTerminalData) {
            // Terminal was disposed and recreated - return empty cleanup since no handlers
            // were set up. The effect will re-run with the new terminalData from the store.
            return () => {};
          }
        }

        // Append the existing container element to the new wrapper
        // This moves the DOM node (with xterm attached) to the new location
        terminalRef.current.appendChild(containerElement);
        setDomReattachCount((count) => count + 1);
      }

      // CRITICAL: Only do buffer clear/restore if the terminal LOGICALLY moved to a different pane
      // When portal targets are recreated (pane structure changes), ALL terminals get
      // unmount/remount cycles, but terminals staying in the same pane don't need
      // buffer manipulation - their content is preserved in the existing xterm instance
      if (paneChanged) {
        // Terminal moved to a different pane - need to restore buffer
        const pendingBuffer = pendingBufferRestoreRef.current;

        if (pendingBuffer && !restorationInProgressRef.current) {
          // Mark restoration in progress to prevent duplicate restores
          restorationInProgressRef.current = true;
          // Clear the pending buffer so we don't restore again
          pendingBufferRestoreRef.current = null;

          // Restore the buffer that was captured during cleanup
          requestAnimationFrame(() => {
            try {
              fitAddon.fit();
              terminal.clear();
              terminal.write(pendingBuffer);
              terminal.scrollToBottom();
            } catch (err) {
              console.error(`[PersistentTerminal] Error restoring buffer for tab:${tabId}:`, err);
              fitAddon.fit();
              terminal.refresh(0, terminal.rows - 1);
            } finally {
              // Clear the restoration flag after RAF completes
              restorationInProgressRef.current = false;
            }
          });
        } else if (!pendingBuffer) {
          // Terminal moved but no pending buffer - just refresh
          requestAnimationFrame(() => {
            fitAddon.fit();
            terminal.refresh(0, terminal.rows - 1);
          });
        }

        // Fallback refresh after layout settles (only for moved terminals)
        setTimeout(() => {
          fitAddon.fit();
          terminal.refresh(0, terminal.rows - 1);
        }, 100);
      } else {
        // Terminal stayed in same pane - just refresh, no buffer manipulation needed
        // Clear any stale pending buffer
        pendingBufferRestoreRef.current = null;

        // Simple refresh since DOM was reconnected
        if (needsDOMMove) {
          requestAnimationFrame(() => {
            fitAddon.fit();
            terminal.refresh(0, terminal.rows - 1);
          });
        }
      }
    }

    // Always update pane tracking
    setTerminalPane(environmentId, tabId, paneId);

    // Handle user input. The xterm instance persists across portal moves, so
    // defensively remove any older input handler before installing this owner.
    terminalInputDisposables.get(terminal)?.dispose();
    const dataDisposable = terminal.onData((data) => {
      writeRef.current(data);
      updateActivityThrottledRef.current();
    });
    terminalInputDisposables.set(terminal, dataDisposable);

    // Intercept clipboard shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      const isMeta = event.metaKey;
      const isCtrl = event.ctrlKey;
      const isAlt = event.altKey;
      const isShift = event.shiftKey;

      // xterm.js maps Enter and Shift+Enter to the same carriage return. Send
      // LF explicitly so terminal TUIs receive their portable Ctrl+J newline
      // binding without submitting the prompt.
      if (key === "enter" && isShift && !isCtrl && !isMeta && !isAlt) {
        event.preventDefault();
        terminal.input("\n");
        return false;
      }

      // Cmd+W belongs to the application tab manager. If xterm processes it,
      // the window-level close shortcut never sees the focused-terminal event.
      if (isMeta && key === "w" && !isCtrl && !isAlt && !isShift) {
        return false;
      }

      // Let Ctrl+digit keys pass through to global handler for tab switching
      // Return false to prevent xterm from handling, allowing event to bubble up
      if (isCtrl && !isMeta && !isAlt && !isShift && event.code?.startsWith("Digit")) {
        return false;
      }

      // Cmd+I / Ctrl+I: Toggle compose bar
      if ((isMeta || isCtrl) && key === "i" && !isAlt && !isShift) {
        toggleComposeBar();
        return false;
      }

      // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Linux/Windows)
      // Only intercept when there's a selection to preserve Ctrl+C for SIGINT
      const isCopyShortcut = (isMeta && key === "c") || (isCtrl && isShift && key === "c");
      if (isCopyShortcut && terminal.hasSelection() && !isAlt) {
        void handleCopySelection();
        return false;
      }

      // Select All: Cmd+A (Mac only)
      // Avoid overriding Ctrl+A which is "go to beginning of line" in shells
      if (isMeta && key === "a" && !isAlt) {
        handleSelectAll();
        return false;
      }

      // Paste: Cmd+V / Ctrl+V (handles both text and images)
      // Skip when compose bar is open - let it handle the paste
      const isPasteShortcut = (isCtrl || isMeta) && key === "v";
      if (isPasteShortcut && !isAlt) {
        if (composeBarOpenRef.current) {
          // Let the paste event propagate to the compose bar
          return false;
        }
        // Prevent default to stop browser from firing a paste event
        // (which would cause xterm to paste a second time)
        event.preventDefault();
        void handlePaste();
        return false;
      }

      return true;
    });

    return () => {
      const restorationComplete = initialRestorationCompleteRef.current;

      // Serialize buffer BEFORE cleanup while DOM is still connected
      // This captures the full buffer content for restoration if needed after remount
      // The effect will decide whether to use this based on whether pane actually changed
      try {
        const bufferContent = serializeAddon.serialize();
        const currentStoreBuffer = useTerminalSessionStore
          .getState()
          .sessions.get(sessionKey)?.serializedBuffer;
        const currentStoreLength = currentStoreBuffer?.length ?? 0;

        if (bufferContent && bufferContent.length > 0) {
          // Store in ref for within-mount-cycle pane moves
          pendingBufferRestoreRef.current = bufferContent;

          // CRITICAL: Only update the store if initial restoration has completed.
          // This prevents saving stale/cleared buffer content during:
          // 1. React Strict Mode's mount-unmount-remount cycle
          // 2. Effect re-runs before restoration completes
          //
          // When restoration is complete, we know the terminal has the correct content,
          // so it's safe to save. The existing buffer in the store is preserved until then.
          //
          // Also check that new buffer is meaningful (not significantly smaller than stored)
          // which would indicate we captured an intermediate/cleared state.
          const newBufferIsMeaningful =
            bufferContent.length >= currentStoreLength * BUFFER_SIZE_THRESHOLD ||
            currentStoreLength === 0;

          if (restorationComplete && newBufferIsMeaningful) {
            useTerminalSessionStore.getState().setSerializedBuffer(sessionKey, bufferContent);
            const persistentId = persistentSessionIdRef.current;
            if (persistentId) {
              savePersistentSessionBuffer(persistentId, bufferContent).catch((err) => {
                console.error("[PersistentTerminal] Failed to persist session buffer:", err);
              });
            }
          }
        }
      } catch (err) {
        console.error(`[PersistentTerminal] Cleanup - failed to serialize buffer:`, err);
      }

      if (terminalInputDisposables.get(terminal) === dataDisposable) {
        terminalInputDisposables.delete(terminal);
        dataDisposable.dispose();
      }
      // NOTE: Don't remove the container element from DOM here
      // It will be moved when the component remounts with a new portal target
    };
  }, [
    terminal,
    fitAddon,
    serializeAddon,
    terminalIsOpened,
    storedContainerElement,
    tabId,
    paneId,
    containerId,
    environmentId,
    isReconnecting,
    markTerminalOpened,
    setTerminalContainer,
    setTerminalPane,
    recreateTerminal,
    scheduleFit,
    handleCopySelection,
    handlePaste,
    handleSelectAll,
    toggleComposeBar,
    connectToCurrentTarget,
    sessionKey,
    savePersistentSessionBuffer,
  ]);

  // Refresh terminal when it becomes visible (isActive changes to true)
  // This is separate from the main effect to avoid re-running DOM setup on visibility changes
  // Initialize to false so that terminals active on mount get refreshed
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (isActive && !wasActiveRef.current && terminalIsOpened) {
      // Terminal just became visible - refresh to ensure content is drawn
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
      });
    }
    wasActiveRef.current = isActive;
  }, [isActive, terminalIsOpened, tabId, fitAddon, terminal]);

  // Force a real PTY resize when returning to a hidden environment.
  // Claude's TUI can keep a stale canvas until it receives the equivalent of a
  // tiny window resize, so bounce the PTY size once and then restore it.
  const wasEnvironmentVisibleRef = useRef(isEnvironmentVisible);
  useEffect(() => {
    if (!terminal || !fitAddon) return;

    const becameVisible = shouldTriggerEnvironmentVisibilityRedraw({
      isEnvironmentVisible,
      wasEnvironmentVisible: wasEnvironmentVisibleRef.current,
      wasDomReattached: domReattachCount !== handledDomReattachRef.current,
      isActive,
      terminalIsOpened,
      isConnected,
    });
    wasEnvironmentVisibleRef.current = isEnvironmentVisible;

    if (!becameVisible) {
      return;
    }
    handledDomReattachRef.current = domReattachCount;

    let cancelled = false;
    let redrawCleanup: { cancel: () => void } | null = null;

    void forceTerminalVisibilityRedraw({
      terminal,
      fitAddon,
      resize,
      isCancelled: () => cancelled,
    }).then((cleanup) => {
      redrawCleanup = cleanup;
    });

    return () => {
      cancelled = true;
      redrawCleanup?.cancel();
    };
  }, [
    isEnvironmentVisible,
    isActive,
    terminalIsOpened,
    isConnected,
    fitAddon,
    terminal,
    resize,
    domReattachCount,
  ]);

  // Update terminal appearance when settings change
  useEffect(() => {
    if (!terminal || !terminalAppearance) return;

    terminal.options.fontFamily = `"${terminalAppearance.fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`;
    terminal.options.fontSize = terminalAppearance.fontSize;
    terminal.options.theme = {
      ...terminal.options.theme,
      background: terminalBackgroundColor,
      cursorAccent: terminalBackgroundColor,
    };
    terminal.options.scrollback = terminalScrollback;

    fitAddon.fit();
  }, [
    terminal,
    fitAddon,
    terminalAppearance,
    terminalAppearance?.fontFamily,
    terminalAppearance?.fontSize,
    terminalBackgroundColor,
    terminalScrollback,
  ]);

  // Handle resize
  useEffect(() => {
    if (!fitAddon || !terminal || !terminalRef.current) return;

    const handleResize = () => scheduleFit();

    handleResize();

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(terminalRef.current);

    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      if (fitAnimationFrameRef.current !== null) {
        cancelAnimationFrame(fitAnimationFrameRef.current);
        fitAnimationFrameRef.current = null;
      }
    };
  }, [terminal, fitAddon, scheduleFit]);

  // Connect when terminal is opened to DOM
  // This is a fallback - primary connection happens immediately after terminal.open()
  //
  // `connectionAttemptTarget` is a dependency because it is what re-arms this
  // effect. `connectToCurrentTarget` is deliberately identity-stable, so a
  // terminal that is already disconnected when it starts pointing at a
  // different backend PTY — a new container, say — would otherwise never see
  // an attempt: none of the other dependencies change in that case.
  useEffect(() => {
    if (!terminalIsOpened) return;
    if (isConnected || isConnecting) return;
    if (connectionAttemptTargetRef.current !== connectionAttemptTarget) {
      connectToCurrentTarget();
      return;
    }
    if (connectionAttemptInFlightRef.current) return;
    if (connectionAttemptCountRef.current >= TERMINAL_CONNECT_MAX_ATTEMPTS) return;

    // Backend-managed setup tabs are rearmed only when their binding publishes
    // a different session/target. Retrying the same stopped setup id was the
    // original log flood; unlike an ordinary terminal, this view must never
    // create a replacement PTY itself.
    if (isBackendManagedSetupTab) return;
    if (connectionRetryTimerRef.current !== null) return;

    const delay =
      TERMINAL_CONNECT_RETRY_BASE_MS * 2 ** Math.max(0, connectionAttemptCountRef.current - 1);
    connectionRetryTimerRef.current = setTimeout(() => {
      connectionRetryTimerRef.current = null;
      if (currentConnectionTargetRef.current !== connectionAttemptTarget) return;
      connectToCurrentTarget();
    }, delay);

    return () => {
      if (connectionRetryTimerRef.current !== null) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
    };
  }, [
    terminalIsOpened,
    isConnected,
    isConnecting,
    isBackendManagedSetupTab,
    connectionAttemptTarget,
    connectionAttemptSettledRevision,
    connectToCurrentTarget,
    tabId,
  ]);

  /**
   * The launch payload, keyed on its contents rather than its props' identity.
   *
   * `initialCommands` is an array prop and every authoritative pane-layout
   * refresh hands down a fresh clone of it, so an effect that depends on the
   * array re-runs for a tab whose launch command never changed. That re-arms
   * the bootstrap while a request is still in flight; nothing double-launched
   * only because the backend deduplicates, which is not a guard the renderer
   * should be leaning on.
   */
  const initialCommandsKey = initialCommands?.join(" ") ?? null;
  const launchData = useMemo(() => {
    const agentCommand = buildAgentLaunchCommand({
      tabType,
      initialPrompt,
      model: initialLaunchModel,
      reasoningEffort: initialLaunchReasoningEffort,
    });
    if (agentCommand) return `${agentCommand}\n`;
    if (tabType !== "plain" || !initialCommands || initialCommands.length === 0) {
      return null;
    }
    const combinedCommand = initialCommands.join(" && ");
    if (isSetupTab) {
      // Always fire an OSC on completion so the UI unblocks even on failure.
      // Success vs failure is signalled via the OSC payload, and persistence is
      // gated on the success variant only.
      return `(${combinedCommand}) && ${SETUP_DONE_PRINTF_CMD} || ${SETUP_FAILED_PRINTF_CMD}\n`;
    }
    return `${combinedCommand}\n`;
    // `initialCommands` is read through `initialCommandsKey`, which encodes
    // exactly its contents; listing the array itself would reinstate the
    // identity churn this memo exists to absorb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tabType,
    initialPrompt,
    initialLaunchModel,
    initialLaunchReasoningEffort,
    initialCommandsKey,
    isSetupTab,
  ]);

  // Launch command based on tab type once environment is ready.
  // Setup tabs are the exception: their initial command is what produces the
  // container setup readiness marker, so waiting for readiness would deadlock.
  useEffect(() => {
    // A plain setup tab's only launch source is its initial commands, so a
    // non-null payload is the same condition as "it has commands to run".
    const shouldLaunchSetupCommand = isSetupTab && tabType === "plain" && launchData !== null;
    const canLaunch = isConnected && (isEnvironmentReady || shouldLaunchSetupCommand);

    if (!canLaunch || bootstrapped || !sessionId || !launchData) return;
    if (bootstrapRequestedForSessionRef.current === sessionId) return;

    const targetSessionId = sessionId;
    let disposed = false;
    let dispatched = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    console.debug("[PersistentTerminal] Launching command for tab:", tabId);

    setBootstrapWarning(null);
    const scheduleAttempt = (attempt: number): void => {
      // Latch at schedule time, not inside the timer. Anything else leaves a
      // window in which a re-render re-enters this effect and issues a second
      // request for the same session.
      bootstrapRequestedForSessionRef.current = targetSessionId;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (disposed) return;
        dispatched = true;

        void bootstrapTerminalSession(targetSessionId, launchData)
          .then((result) => {
            if (disposed || bootstrapRequestedForSessionRef.current !== targetSessionId) return;
            if (result.bootstrapped) {
              if (!markBootstrapped(targetSessionId)) return;
              setBootstrapWarning(null);
              acknowledgeInitialLaunchOptions();
              return;
            }

            bootstrapRequestedForSessionRef.current = null;
            if (attempt < TERMINAL_BOOTSTRAP_MAX_ATTEMPTS) {
              scheduleAttempt(attempt + 1);
              return;
            }
            setBootstrapWarning(
              "The terminal connected, but its launch command could not start. Reopen the terminal to try again.",
            );
          })
          .catch((error) => {
            if (disposed || bootstrapRequestedForSessionRef.current !== targetSessionId) return;
            bootstrapRequestedForSessionRef.current = null;
            console.error("[PersistentTerminal] Failed to bootstrap terminal:", error);
            if (attempt < TERMINAL_BOOTSTRAP_MAX_ATTEMPTS) {
              scheduleAttempt(attempt + 1);
              return;
            }
            setBootstrapWarning(
              "The terminal connected, but its launch command failed. Reopen the terminal to try again.",
            );
          });
      }, TERMINAL_BOOTSTRAP_DELAY_MS);
    };

    scheduleAttempt(1);
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      // Release the latch only when the attempt genuinely aborted before the
      // request went out. Once it has been dispatched the backend owns the
      // launch, so clearing here would let the next render send it again while
      // the first is still in flight.
      if (!dispatched && bootstrapRequestedForSessionRef.current === targetSessionId) {
        bootstrapRequestedForSessionRef.current = null;
      }
    };
  }, [
    acknowledgeInitialLaunchOptions,
    bootstrapped,
    isEnvironmentReady,
    isConnected,
    sessionId,
    tabType,
    tabId,
    launchData,
    isSetupTab,
    markBootstrapped,
  ]);

  useEffect(() => {
    if (bootstrapped) acknowledgeInitialLaunchOptions();
  }, [acknowledgeInitialLaunchOptions, bootstrapped]);

  useEffect(() => {
    setBootstrapWarning(null);
  }, [sessionId]);

  // Focus when active. Mobile is excluded so activating a tab does not raise
  // the on-screen keyboard; the terminal still fits, and tapping it focuses.
  useEffect(() => {
    if (isActive && isConnected) {
      if (!isMobileRef.current) {
        terminal.focus();
      }
      scheduleFit();
    }
  }, [isActive, isConnected, terminal, scheduleFit]);

  // Get setActivePane to update focus when terminal is clicked
  const setActivePane = usePaneLayoutStore((state) => state.setActivePane);

  const handleTerminalClick = useCallback(() => {
    // Set this pane as active when clicked
    setActivePane(paneId, environmentId);
    if (isActive) {
      terminal.focus();
    }
  }, [environmentId, isActive, terminal, paneId, setActivePane]);

  const handleMobileKeyInput = useCallback(
    (data: string) => {
      void writeRef.current(resolveTerminalKeyData(data, terminal.modes.applicationCursorKeysMode));
      updateActivityThrottledRef.current();
    },
    [terminal],
  );

  const [manuallyCompleted, setManuallyCompleted] = useState(false);
  const handleMarkSetupComplete = useCallback(() => {
    if (!setupCompleteRef.current) {
      console.log("[PersistentTerminal] Manually marking setup complete for tab:", tabId);
      setupCompleteRef.current = true;
      setManuallyCompleted(true);
      onSetupComplete?.({ persistSetupComplete: false });
    }
  }, [tabId, onSetupComplete]);

  return (
    <>
      {(bootstrapWarning || replayWarning) && isActive && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-2 left-2 z-20 max-w-[min(36rem,calc(100%-1rem))] rounded-md border border-amber-500/40 bg-amber-950/90 px-2.5 py-1.5 text-xs text-amber-100 shadow-md backdrop-blur-sm"
        >
          {bootstrapWarning || (
            <button
              type="button"
              className="cursor-pointer text-left"
              onClick={() => setReplayWarning(null)}
            >
              {replayWarning}
            </button>
          )}
        </div>
      )}
      {isSetupTab &&
        isActive &&
        !setupScriptsComplete &&
        !manuallyCompleted &&
        !setupCompleteRef.current && (
          <div className="absolute top-1 right-2 z-10">
            <button
              onClick={handleMarkSetupComplete}
              className="flex items-center gap-1.5 rounded-md bg-zinc-800/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 border border-zinc-700/50 transition-colors shadow-md backdrop-blur-sm"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mark setup complete
            </button>
          </div>
        )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={terminalRef}
            onClick={handleTerminalClick}
            className={cn(
              "absolute inset-x-0 top-0",
              isMobile ? "bottom-[calc(3rem+env(safe-area-inset-bottom))]" : "bottom-0",
              !isActive && "opacity-0 pointer-events-none",
            )}
            style={{ backgroundColor: terminalBackgroundColor }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void handleCopySelection()} disabled={!hasSelection}>
            Copy
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>Paste</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleSelectAll}>Select All</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isMobile && isActive && (
        <MobileTerminalKeyBar onInput={handleMobileKeyInput} disabled={!isConnected} />
      )}
      {isActive && (
        <ComposeBar
          sessionKey={sessionKey}
          environmentId={environmentId}
          isOpen={isComposeBarOpen}
          onClose={() => {
            setIsComposeBarOpen(false);
            terminal.focus();
          }}
          onSend={handleComposeSend}
          containerId={containerId}
          worktreePath={worktreePath}
          showAddressAll={isReviewTab && bootstrapped && agentActivityState !== "working"}
          onAddressAll={handleAddressAll}
          className={isMobile ? "bottom-[calc(3.5rem+env(safe-area-inset-bottom))]" : undefined}
        />
      )}
    </>
  );
}
