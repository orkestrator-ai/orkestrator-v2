import { useEffect, useRef, useCallback, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTerminal } from "@/hooks/useTerminal";
import { useAgentState } from "@/hooks/useAgentState";
import { useClipboardImagePaste } from "@/hooks/useClipboardImagePaste";
import { escapePathForTerminalInput, handleTerminalPaste } from "@/lib/terminal-paste";
import { useTerminalSessionStore, createSessionKey, useConfigStore, usePaneLayoutStore, useEnvironmentStore } from "@/stores";
import { useSessionStore } from "@/stores/sessionStore";
import { useTerminalPortalStore, createTerminalKey, type PersistentTerminalData } from "@/stores/terminalPortalStore";
import { cn } from "@/lib/utils";
import { setSessionHasLaunchedCommand } from "@/lib/tauri";
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

// Threshold for detecting intermediate/cleared buffer state during React mount cycles.
// If new buffer is less than 50% of stored buffer size, it likely represents a cleared
// or intermediate state that shouldn't overwrite the valid stored content.
const BUFFER_SIZE_THRESHOLD = 0.5;

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
  paneId,
  isSetupTab,
  onReady,
  onSetupComplete,
  onWrite,
}: PersistentTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const writeRef = useRef<(data: string) => Promise<void>>(() => Promise.resolve());
  const [isEnvironmentReady, setIsEnvironmentReady] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const composeBarOpenRef = useRef(false); // Ref for synchronous access in key handler
  const dataBufferRef = useRef<string>("");
  const setupCompleteRef = useRef(false);
  const workspaceReadySignaledRef = useRef(false);
  const hasLaunchedCommandRef = useRef(false);
  const hasInitiatedConnectionRef = useRef(false);
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

  // Get terminal appearance settings from config
  const terminalAppearance = useConfigStore(
    (state) => state.config.global.terminalAppearance
  ) || DEFAULT_TERMINAL_APPEARANCE;
  const terminalBackgroundColor = resolveTerminalBackgroundColor(
    terminalAppearance.backgroundColor,
  );
  const terminalScrollback = useConfigStore(
    (state) => state.config.global.terminalScrollback
  ) ?? DEFAULT_TERMINAL_SCROLLBACK;

  // Create a container-scoped session key
  // For local environments (containerId is null), use environmentId to ensure uniqueness
  const sessionKey = createSessionKey(containerId, tabId, environmentId);

  // Session persistence
  const existingSession = useTerminalSessionStore((state) => state.sessions.get(sessionKey));
  const setSession = useTerminalSessionStore((state) => state.setSession);
  const setSerializedBuffer = useTerminalSessionStore((state) => state.setSerializedBuffer);
  const setHasLaunchedCommandStore = useTerminalSessionStore((state) => state.setHasLaunchedCommand);
  const existingSessionId = existingSession?.sessionId;
  const serializedBuffer = existingSession?.serializedBuffer;
  const existingHasLaunchedCommand = existingSession?.hasLaunchedCommand ?? false;
  const isReconnecting = !!existingSessionId;

  // Track if there was an existing session when component mounted (genuine reconnection)
  // This distinguishes between:
  // 1. App restart/tab switch where we're reconnecting to existing session
  // 2. Newly created environment where session ID gets stored during this mount cycle
  const hadExistingSessionAtMountRef = useRef(!!existingSessionId);

  const [hasReconnected, setHasReconnected] = useState(false);

  // Get terminal store functions
  const { markTerminalOpened, setTerminalContainer, setTerminalPane, recreateTerminal } = useTerminalPortalStore();

  // Subscribe to containerElement and isOpened from store to ensure we have the latest values
  // (props might be stale if store was updated after TerminalPortalHost rendered)
  const terminalKey = createTerminalKey(environmentId, tabId);
  const storedContainerElement = useTerminalPortalStore(
    (state) => state.terminals.get(terminalKey)?.containerElement ?? null
  );
  const terminalIsOpened = useTerminalPortalStore(
    (state) => state.terminals.get(terminalKey)?.isOpened ?? false
  );

  // Check if this is a local environment (uses worktree instead of Docker container)
  const isLocalEnvironment = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.environmentType === "local"
  );

  // Get worktree path for local environments (needed for image paste)
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath ?? null
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
  const handleImageSaved = useCallback(async (filePath: string) => {
    const terminalPath = isLocalEnvironment ? escapePathForTerminalInput(filePath) : filePath;
    await writeRef.current(terminalPath + " ");
    terminal.focus();
  }, [isLocalEnvironment, terminal]);

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
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    [isLocalEnvironment, terminal]
  );

  // Track mount lifecycle - reset restoration flag on mount
  useEffect(() => {
    initialRestorationCompleteRef.current = false;
    // No cleanup needed - flag reset happens on next mount
  }, [tabId, environmentId]);

  // Reset state when containerId changes
  useEffect(() => {
    if (previousContainerIdRef.current !== containerId) {
      setIsEnvironmentReady(false);
      dataBufferRef.current = "";
      workspaceReadySignaledRef.current = false;
      hasLaunchedCommandRef.current = false;
      hasInitiatedConnectionRef.current = false;
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
      terminal.write(data);

      const text = new TextDecoder().decode(data);

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
          const hasLengthFallback = strippedBuffer.length > 500 && strippedBuffer.trimEnd().endsWith("\n");

          if (hasShellPrompt || hasGenericPrompt || hasLengthFallback) {
            console.log("[PersistentTerminal] Local environment ready detected for first tab:", tabId);
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
          const { ready: readyDetected, failed: setupFailed } =
            detectContainerSetupReadiness(dataBufferRef.current);

          if (readyDetected) {
            console.log("[PersistentTerminal] Environment ready detected for tab:", tabId, "isFirstTab:", isFirstTab);
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
    [terminal, isFirstTab, isLocalEnvironment, isEnvironmentReady, tabId, onReady]
  );

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

  const { sessionId, isConnected, isConnecting, connect, resize, write } =
    useTerminal({
      containerId,
      environmentId,
      isLocal: isLocalEnvironment,
      onData: handleData,
      existingSessionId,
      persistSession: true,
      user: terminalUser,
    });

  // Keep connect ref up to date to avoid stale closures in effects
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Persistent session tracking
  const persistentSessionCreatedRef = useRef(false);
  const persistentSessionIdRef = useRef<string | null>(null);
  const creationInProgressRef = useRef(false);
  const hasRestoredFromPersistentRef = useRef(false);

  const {
    createSession: createPersistentSession,
    updateSessionActivity,
    saveSessionBuffer: savePersistentSessionBuffer,
    loadSessionBuffer: loadPersistentSessionBuffer,
    getSessionsByEnvironment,
    updateSessionStatus,
    isLoadingEnvironment,
    loadSessionsForEnvironment,
  } = useSessionStore();
  const setPersistentSessionId = useTerminalSessionStore((state) => state.setPersistentSessionId);
  const isSessionsLoading = isLoadingEnvironment(environmentId);

  // Ensure sessions are loaded for this environment
  useEffect(() => {
    if (environmentId) {
      loadSessionsForEnvironment(environmentId);
    }
  }, [environmentId, loadSessionsForEnvironment]);

  // Load persistent session data BEFORE PTY is created
  useEffect(() => {
    if (!environmentId) return;
    if (existingSession) return;
    if (hasRestoredFromPersistentRef.current) return;
    if (isSessionsLoading) return;

    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      hasRestoredFromPersistentRef.current = true;

      console.debug(
        "[PersistentTerminal] Restoring from persistent session:",
        existingPersistentSession.id,
        "hasLaunchedCommand:",
        existingPersistentSession.hasLaunchedCommand
      );

      setSession(sessionKey, {
        hasLaunchedCommand: existingPersistentSession.hasLaunchedCommand ?? false,
        persistentSessionId: existingPersistentSession.id,
      });

      hasLaunchedCommandRef.current = existingPersistentSession.hasLaunchedCommand ?? false;

      loadPersistentSessionBuffer(existingPersistentSession.id)
        .then((buffer) => {
          if (buffer) {
            console.debug("[PersistentTerminal] Loaded persistent buffer, length:", buffer.length);
            setSerializedBuffer(sessionKey, buffer);
          }
        })
        .catch((err) => {
          console.error("[PersistentTerminal] Failed to load persistent buffer:", err);
        });
    } else {
      hasRestoredFromPersistentRef.current = true;
    }
  }, [
    environmentId,
    tabId,
    sessionKey,
    existingSession,
    isSessionsLoading,
    loadPersistentSessionBuffer,
    getSessionsByEnvironment,
    setSession,
    setSerializedBuffer,
  ]);

  // Store session ID when we get one
  useEffect(() => {
    if (sessionId && !existingSessionId) {
      console.debug("[PersistentTerminal] Storing new session ID for sessionKey:", sessionKey, sessionId);
      const currentSession = useTerminalSessionStore.getState().sessions.get(sessionKey);
      setSession(sessionKey, {
        ...currentSession,
        sessionId,
      });
    }
  }, [sessionId, existingSessionId, sessionKey, setSession]);

  // Create persistent session for sidebar tracking
  useEffect(() => {
    if (isSessionsLoading) return;
    if (!sessionId || !environmentId) return;
    if (persistentSessionCreatedRef.current || creationInProgressRef.current) return;

    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      console.debug("[PersistentTerminal] Found existing persistent session:", existingPersistentSession.id);
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
  }, [sessionId, containerId, environmentId, tabId, tabType, sessionKey, createPersistentSession, getSessionsByEnvironment, setPersistentSessionId, updateSessionStatus, isSessionsLoading]);

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

  // When reconnecting, restore terminal buffer
  useEffect(() => {
    if (isReconnecting && isConnected && !hasReconnected) {
      if (serializedBuffer) {
        // Clear terminal first to prevent duplicate content from preserved xterm instance
        terminal.clear();
        terminal.write(serializedBuffer);
        terminal.scrollToBottom();
        // Force a refresh to ensure the canvas is repainted
        terminal.refresh(0, terminal.rows - 1);

        // Also fit to ensure dimensions are correct
        fitAddon.fit();

        // Schedule additional refreshes to ensure canvas renders after layout
        requestAnimationFrame(() => {
          fitAddon.fit();
          terminal.refresh(0, terminal.rows - 1);
        });

        // Final delayed refresh as fallback for slow layout settling
        setTimeout(() => {
          fitAddon.fit();
          terminal.refresh(0, terminal.rows - 1);
        }, 100);
      }

      // Mark initial restoration as complete - cleanup can now safely serialize
      initialRestorationCompleteRef.current = true;
      setHasReconnected(true);
      hasLaunchedCommandRef.current = existingHasLaunchedCommand;

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
            console.log("[PersistentTerminal] Reconnection buffer contains setup readiness marker for tab:", tabId);
            if (!workspaceReadySignaledRef.current) {
              workspaceReadySignaledRef.current = true;
              onReady?.({ persistSetupComplete: !failed, workspaceReady: true });
            }
          } else {
            console.log("[PersistentTerminal] Reconnected first container tab without setup marker, keeping readiness detection active for tab:", tabId);
          }
        } else {
          setIsEnvironmentReady(true);
          console.log("[PersistentTerminal] Reconnection complete, calling onReady for tab:", tabId);
          onReady?.({ persistSetupComplete: false, workspaceReady: false });
        }
      } else {
        // Leave isEnvironmentReady as false so handleData can detect setup completion
        console.log("[PersistentTerminal] First tab on new environment, waiting for setup detection before calling onReady, tab:", tabId);
      }
    }
  }, [isReconnecting, isConnected, hasReconnected, tabId, environmentId, onReady, serializedBuffer, existingHasLaunchedCommand, terminal, fitAddon, isFirstTab, isLocalEnvironment]);

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
      console.log("[PersistentTerminal] Restored buffer contains setup readiness marker for tab:", tabId);
      onReady?.({ persistSetupComplete: !failed, workspaceReady: true });
    }
  }, [isFirstTab, isLocalEnvironment, isEnvironmentReady, serializedBuffer, tabId, onReady]);

  // Monitor Claude activity state
  useAgentState(containerId, tabId);

  const scheduleFit = useCallback(() => {
    if (!fitAddon || !terminal) return;
    requestAnimationFrame(() => {
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
        document.fonts.ready.then(() => {
          // Force xterm to re-measure character dimensions by re-setting font options
          // This is critical: if fonts weren't fully loaded when terminal.open() was called,
          // xterm measured fallback fonts and cached those cell dimensions.
          // Re-setting fontSize triggers xterm to recalculate character metrics.
          if (terminal.options.fontSize) {
            terminal.options.fontSize = terminal.options.fontSize;
          }
          scheduleFit();
        }).catch(() => {});
      }
      setTimeout(() => {
        // Also force font re-measurement in timeout as a fallback
        if (terminal.options.fontSize) {
          terminal.options.fontSize = terminal.options.fontSize;
        }
        scheduleFit();
      }, 50);

      // Immediately connect after opening terminal to avoid race condition
      // where the state update from markTerminalOpened doesn't trigger
      // the connect effect in time for the first terminal
      if (!hasInitiatedConnectionRef.current) {
        hasInitiatedConnectionRef.current = true;
        // Mark restoration complete since this is a fresh terminal (no buffer to restore)
        if (!isReconnecting) {
          initialRestorationCompleteRef.current = true;
        }
        connectRef.current();
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
        const xtermElementBefore = containerElement.querySelector('.xterm');
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

    // Handle user input - must be set up on every mount because disposable is cleaned up on unmount
    const dataDisposable = terminal.onData((data) => {
      writeRef.current(data);
      updateActivityThrottledRef.current();
    });

    // Intercept clipboard shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      const isMeta = event.metaKey;
      const isCtrl = event.ctrlKey;
      const isAlt = event.altKey;
      const isShift = event.shiftKey;

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
      const isCopyShortcut =
        (isMeta && key === "c") || (isCtrl && isShift && key === "c");
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
        const currentStoreBuffer = useTerminalSessionStore.getState().sessions.get(sessionKey)?.serializedBuffer;
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
          const newBufferIsMeaningful = bufferContent.length >= currentStoreLength * BUFFER_SIZE_THRESHOLD || currentStoreLength === 0;

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

      dataDisposable.dispose();
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
      isActive,
      terminalIsOpened,
      isConnected,
    });
    wasEnvironmentVisibleRef.current = isEnvironmentVisible;

    if (!becameVisible) {
      return;
    }

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
  }, [isEnvironmentVisible, isActive, terminalIsOpened, isConnected, fitAddon, terminal, resize]);

  // Update terminal appearance when settings change
  useEffect(() => {
    if (!terminal || !terminalAppearance) return;

    terminal.options.fontFamily = `"${terminalAppearance.fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`;
    terminal.options.fontSize = terminalAppearance.fontSize;
    terminal.options.theme = {
      ...(terminal.options.theme || {}),
      background: terminalBackgroundColor,
      cursorAccent: terminalBackgroundColor,
    };
    terminal.options.scrollback = terminalScrollback;

    fitAddon.fit();
  }, [terminal, fitAddon, terminalAppearance?.fontFamily, terminalAppearance?.fontSize, terminalBackgroundColor, terminalScrollback]);

  // Handle resize
  useEffect(() => {
    if (!fitAddon || !terminal || !terminalRef.current) return;

    const handleResize = () => {
      fitAddon.fit();
      const { cols, rows } = terminal;
      resize(cols, rows);
    };

    handleResize();

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(terminalRef.current);

    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [terminal, fitAddon, resize]);

  // Connect when terminal is opened to DOM
  // This is a fallback - primary connection happens immediately after terminal.open()
  useEffect(() => {
    if (terminalIsOpened && !isConnected && !isConnecting) {
      connect();
    }
  }, [terminalIsOpened, isConnected, isConnecting, connect, tabId]);

  // Launch command based on tab type once environment is ready
  useEffect(() => {
    if (isEnvironmentReady && isConnected && !hasLaunchedCommandRef.current) {
      hasLaunchedCommandRef.current = true;
      setHasLaunchedCommandStore(sessionKey, true);

      const persistentId = persistentSessionIdRef.current;
      if (persistentId) {
        setSessionHasLaunchedCommand(persistentId, true).catch((err) => {
          console.error("[PersistentTerminal] Failed to persist hasLaunchedCommand:", err);
        });
      }

      setTimeout(() => {
        if (tabType === "claude") {
          // Build the claude command with dangerously-skip-permissions (always enabled)
          let command = "claude --dangerously-skip-permissions";
          if (initialPrompt) {
            const escapedPrompt = initialPrompt
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\$/g, '\\$')
              .replace(/`/g, '\\`');
            command += ` "${escapedPrompt}"`;
          }
          console.debug("[PersistentTerminal] Launching command for tab:", tabId, "command:", command);
          writeRef.current(command + "\n");
        } else if (tabType === "opencode") {
          // Build the opencode command with optional initial prompt
          let command = "opencode";
          if (initialPrompt) {
            // Escape shell-special characters within double quotes: \, ", $, `
            const escapedPrompt = initialPrompt
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\$/g, '\\$')
              .replace(/`/g, '\\`');
            command += ` --prompt "${escapedPrompt}"`;
          }
          console.debug("[PersistentTerminal] Launching command for tab:", tabId, "command:", command);
          writeRef.current(command + "\n");
        } else if (tabType === "codex") {
          // Build the interactive codex command with an optional initial prompt.
          let command = "codex";
          if (initialPrompt) {
            const escapedPrompt = initialPrompt
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\$/g, '\\$')
              .replace(/`/g, '\\`')
              .replace(/\n/g, '\\n');
            command += ` "${escapedPrompt}"`;
          }
          console.debug("[PersistentTerminal] Launching command for tab:", tabId, "command:", command);
          writeRef.current(command + "\n");
        } else if (tabType === "plain" && initialCommands && initialCommands.length > 0) {
          // For plain tabs with initial commands, execute them
          console.debug("[PersistentTerminal] Executing initial commands for tab:", tabId, "commands:", initialCommands);
          // Join all commands with && to run sequentially
          const combinedCommand = initialCommands.join(" && ");
          if (isSetupTab) {
            // Always fire an OSC on completion so the UI unblocks even on
            // failure. Success vs failure is signalled via the OSC payload,
            // and persistence is gated on the success variant only.
            // Note: `A && B || C` would emit both markers if B (printf) ever
            // exits non-zero; the OSC handler's setupCompleteRef guard makes
            // the second a no-op, so this stays correct.
            writeRef.current(
              `(${combinedCommand}) && ${SETUP_DONE_PRINTF_CMD} || ${SETUP_FAILED_PRINTF_CMD}\n`,
            );
          } else {
            writeRef.current(combinedCommand + "\n");
          }
        }
      }, 300);
    }
  }, [isEnvironmentReady, isConnected, tabType, tabId, initialPrompt, initialCommands, isSetupTab, sessionKey, setHasLaunchedCommandStore]);

  // Focus when active
  useEffect(() => {
    if (isActive && isConnected) {
      terminal.focus();
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
      {isSetupTab && isActive && !manuallyCompleted && !setupCompleteRef.current && (
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
              "absolute inset-0",
              !isActive && "opacity-0 pointer-events-none"
            )}
            style={{ backgroundColor: terminalBackgroundColor }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void handleCopySelection()} disabled={!hasSelection}>
            Copy
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>
            Paste
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleSelectAll}>
            Select All
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isActive && (
        <ComposeBar
          sessionKey={sessionKey}
          isOpen={isComposeBarOpen}
          onClose={() => {
            setIsComposeBarOpen(false);
            terminal.focus();
          }}
          onSend={handleComposeSend}
          containerId={containerId}
          worktreePath={worktreePath}
        />
      )}
    </>
  );
}
