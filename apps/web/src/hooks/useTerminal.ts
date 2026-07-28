// Hook for managing terminal sessions with Electron backend
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@/lib/native/events";
import { toast } from "sonner";
import * as backend from "@/lib/backend";

/**
 * Wire shape of a `terminal-output-<sessionId>` event.
 *
 * `bytesBase64` is what the backend emits today. The legacy `number[]` forms
 * remain accepted during rolling upgrades, and `desynced` is the gateway
 * telling this client that frames were dropped for it under backpressure and
 * the authoritative buffer must be replayed.
 */
export type TerminalOutputPayload =
  | number[]
  | string
  | {
      bytesBase64?: string;
      bytes?: number[];
      desynced?: boolean;
      sequence?: number;
    };

/** Clears the screen and the scrollback before an authoritative replay. */
const TERMINAL_RESET_SEQUENCE = "\u001b[H\u001b[2J\u001b[3J";

// Hoisted: a terminal produces one of these per output frame, and constructing
// a fresh encoder per chunk is pure allocation churn on the hottest UI path.
const textEncoder = new TextEncoder();

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Returns the frame's bytes, or `null` when it is a desync notice. */
export function decodeTerminalOutputPayload(payload: TerminalOutputPayload): Uint8Array | null {
  if (typeof payload === "string") return decodeBase64Bytes(payload);
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if (!payload || typeof payload !== "object") return new Uint8Array(0);
  if (typeof payload.bytesBase64 === "string") return decodeBase64Bytes(payload.bytesBase64);
  if (Array.isArray(payload.bytes)) return new Uint8Array(payload.bytes);
  if (payload.desynced) return null;
  return new Uint8Array(0);
}

function terminalOutputSequence(payload: TerminalOutputPayload): number | null {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Number.isSafeInteger(payload.sequence)
    || (payload.sequence ?? 0) < 0
  ) {
    return null;
  }
  return payload.sequence ?? null;
}

interface UseTerminalOptions {
  containerId: string | null;
  /** Environment ID - required for local environments */
  environmentId?: string;
  /** Whether this is a local (worktree) environment */
  isLocal?: boolean;
  cols?: number;
  rows?: number;
  onData?: (data: Uint8Array) => void;
  /** Existing session ID to reconnect to (for tab moves between panes) */
  existingSessionId?: string | null;
  /** If true, don't close the session on unmount (session persists for tab moves) */
  persistSession?: boolean;
  /** User to run the terminal session as (e.g., "orkroot" for root access) */
  user?: string;
  /** Replay the backend's bounded output buffer when attaching to an existing PTY */
  replayOutputBuffer?: boolean;
  /** Attach only to an existing backend-owned PTY; never create a replacement session. */
  attachExistingOnly?: boolean;
  /** Persist prompt and settled-output activity for this environment-owned agent PTY. */
  trackEnvironmentActivity?: boolean;
}

interface UseTerminalReturn {
  sessionId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  write: (data: string) => Promise<void>;
}

export function useTerminal({
  containerId,
  environmentId,
  isLocal = false,
  cols = 80,
  rows = 24,
  onData,
  existingSessionId,
  persistSession = false,
  user,
  replayOutputBuffer = false,
  attachExistingOnly = false,
  trackEnvironmentActivity = false,
}: UseTerminalOptions): UseTerminalReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const listenAbortControllerRef = useRef<AbortController | null>(null);
  const onDataRef = useRef(onData);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  const isMountedRef = useRef(false);
  const lastOutputSequenceRef = useRef(0);
  const outputRecoveryRef = useRef<{
    sessionId: string;
    queued: Map<number, Uint8Array>;
    promise: Promise<void>;
  } | null>(null);
  const resetOutputTracking = useCallback(() => {
    lastOutputSequenceRef.current = 0;
    outputRecoveryRef.current = null;
  }, []);

  // Keep onData ref up to date
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const cleanupEventListener = useCallback(() => {
    listenAbortControllerRef.current?.abort();
    listenAbortControllerRef.current = null;
    const unlisten = unlistenRef.current;
    if (unlisten) {
      unlisten();
      unlistenRef.current = null;
    }
  }, []);

  /**
   * Re-render from the backend's authoritative output buffer.
   *
   * The gateway drops terminal frames for a client that has fallen far enough
   * behind to threaten backend memory, and says so on the same event. Appending
   * the buffer alone would duplicate scrollback, so the screen is reset first
   * and the buffer becomes the whole visible history again.
   */
  const resyncFromOutputBuffer = useCallback((targetSessionId: string): Promise<void> => {
    const existing = outputRecoveryRef.current;
    if (existing?.sessionId === targetSessionId) return existing.promise;

    const queued = new Map<number, Uint8Array>();
    const recovery = {
      sessionId: targetSessionId,
      queued,
      promise: Promise.resolve(),
    };
    recovery.promise = (async () => {
      try {
        const snapshot = await backend.getTerminalOutputSnapshot(targetSessionId);
        if (sessionIdRef.current !== targetSessionId || !onDataRef.current) return;

        onDataRef.current(
          textEncoder.encode(`${TERMINAL_RESET_SEQUENCE}${snapshot.text}`),
        );
        lastOutputSequenceRef.current = snapshot.sequence;

        for (const [sequence, bytes] of [...queued].sort(([a], [b]) => a - b)) {
          if (sequence <= lastOutputSequenceRef.current) continue;
          onDataRef.current(bytes);
          lastOutputSequenceRef.current = sequence;
        }
      } catch (err) {
        // A failed recovery must not erase output the user can still see. Live
        // frames received while the snapshot was pending remain usable and are
        // flushed in sequence; the next desync notice can retry the snapshot.
        console.warn("[useTerminal] Failed to resynchronize terminal output buffer:", err);
        if (sessionIdRef.current !== targetSessionId || !onDataRef.current) return;
        for (const [sequence, bytes] of [...queued].sort(([a], [b]) => a - b)) {
          if (sequence <= lastOutputSequenceRef.current) continue;
          onDataRef.current(bytes);
          lastOutputSequenceRef.current = sequence;
        }
      } finally {
        if (outputRecoveryRef.current === recovery) {
          outputRecoveryRef.current = null;
        }
      }
    })();
    outputRecoveryRef.current = recovery;
    return recovery.promise;
  }, []);

  const listenForTerminalOutput = useCallback(
    (targetSessionId: string, signal: AbortSignal): Promise<UnlistenFn> =>
      listen<TerminalOutputPayload>(`terminal-output-${targetSessionId}`, (event) => {
        const data = decodeTerminalOutputPayload(event.payload);
        if (data === null) {
          void resyncFromOutputBuffer(targetSessionId);
          return;
        }
        const sequence = terminalOutputSequence(event.payload);
        if (sequence !== null) {
          if (sequence <= lastOutputSequenceRef.current) return;
          const recovery = outputRecoveryRef.current;
          if (recovery?.sessionId === targetSessionId) {
            recovery.queued.set(sequence, data);
            return;
          }
          if (sequence > lastOutputSequenceRef.current + 1) {
            const recoveryPromise = resyncFromOutputBuffer(targetSessionId);
            outputRecoveryRef.current?.queued.set(sequence, data);
            void recoveryPromise;
            return;
          }
          lastOutputSequenceRef.current = sequence;
        }
        if (data.length > 0) onDataRef.current?.(data);
      }, { signal }),
    [resyncFromOutputBuffer],
  );

  // Track previous containerId to detect changes
  const previousContainerIdRef = useRef<string | null>(null);

  // Disconnect when containerId changes (switching environments)
  useEffect(() => {
    // If containerId changed and we have an active session, disconnect
    if (previousContainerIdRef.current !== containerId && sessionId) {
      console.log("[useTerminal] Container changed, disconnecting from previous session");
      connectGenerationRef.current += 1;
      // Clean up event listener
      cleanupEventListener();
      // Detach terminal (use appropriate method based on isLocal)
      if (isLocalRef.current) {
        backend.closeLocalTerminalSession(sessionId).catch(() => {});
      } else {
        backend.detachTerminal(sessionId).catch(() => {});
      }
      // Clear ref immediately to prevent stale writes
      sessionIdRef.current = null;
      resetOutputTracking();
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setSessionId(null);
      setIsConnected(false);
      setIsConnecting(false);
      setError(null);
    }
    previousContainerIdRef.current = containerId;
  }, [containerId, sessionId, cleanupEventListener, resetOutputTracking]);

  // Track sessionId in a ref for cleanup on unmount
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Track persistSession in a ref for cleanup
  const persistSessionRef = useRef(persistSession);
  useEffect(() => {
    persistSessionRef.current = persistSession;
  }, [persistSession]);

  // Track isLocal in a ref for cleanup
  const isLocalRef = useRef(isLocal);
  useEffect(() => {
    isLocalRef.current = isLocal;
  }, [isLocal]);

  // Clean up on unmount - use ref to get current sessionId
  // If persistSession is true, only clean up the listener (keep session alive)
  useEffect(() => {
    return () => {
      console.log("[useTerminal] Cleanup on unmount, sessionId:", sessionIdRef.current, "persist:", persistSessionRef.current);
      connectGenerationRef.current += 1;
      if (unlistenRef.current) {
        console.log("[useTerminal] Unlistening from events");
      }
      cleanupEventListener();
      // Only detach if we're NOT persisting the session
      if (sessionIdRef.current && !persistSessionRef.current) {
        console.log("[useTerminal] Detaching terminal session:", sessionIdRef.current, "isLocal:", isLocalRef.current);
        if (isLocalRef.current) {
          backend.closeLocalTerminalSession(sessionIdRef.current).catch((err) => {
            console.error("[useTerminal] Error closing local terminal:", err);
          });
        } else {
          backend.detachTerminal(sessionIdRef.current).catch((err) => {
            console.error("[useTerminal] Error detaching terminal:", err);
          });
        }
      }
      isConnectedRef.current = false;
      isConnectingRef.current = false;
    };
  }, [cleanupEventListener]);

  const connect = useCallback(async () => {
    console.log("[useTerminal] connect called, containerId:", containerId, "environmentId:", environmentId, "isLocal:", isLocal, "existingSessionId:", existingSessionId, "attachExistingOnly:", attachExistingOnly);

    if (attachExistingOnly && !existingSessionId) {
      console.info("[setup-terminal] waiting for backend-owned session id before attaching", {
        environmentId: environmentId ?? null,
        containerId,
        isLocal,
      });
      console.log("[useTerminal] Waiting for existing backend terminal session before connecting");
      setError(null);
      return;
    }

    // Validate inputs based on environment type
    if (isLocal) {
      if (!environmentId) {
        setError("No environment ID provided for local environment");
        return;
      }
    } else {
      if (!containerId) {
        setError("No container ID provided");
        return;
      }
    }

    if (isConnectingRef.current || isConnectedRef.current) {
      console.log("[useTerminal] Already connecting or connected, skipping");
      return;
    }

    isConnectingRef.current = true;
    const connectGeneration = connectGenerationRef.current + 1;
    connectGenerationRef.current = connectGeneration;
    const isCurrentConnect = () => connectGenerationRef.current === connectGeneration;
    setIsConnecting(true);
    setError(null);

    let targetSessionId: string | null = null;
    let shouldStartSession = true;
    let existingSessionRunning: boolean | null = null;

    try {

      // If we have an existing session, try to reconnect to it
      if (existingSessionId) {
        console.log("[useTerminal] Reconnecting to existing session:", existingSessionId);
        const existingStatus = await backend.getTerminalSession(existingSessionId).catch((err) => {
          console.warn("[useTerminal] Failed to check existing terminal session, creating a new one:", err);
          return null;
        });
        if (!isCurrentConnect()) return;

        existingSessionRunning = existingStatus?.running ?? false;
        if (attachExistingOnly || existingSessionId.endsWith(":setup")) {
          console.info("[setup-terminal] existing terminal session status", {
            environmentId: environmentId ?? null,
            sessionId: existingSessionId,
            running: existingSessionRunning,
            attachExistingOnly,
            replayOutputBuffer,
          });
        }

        if (existingSessionRunning) {
          targetSessionId = existingSessionId;
          shouldStartSession = false;
        } else if (attachExistingOnly) {
          targetSessionId = existingSessionId;
          shouldStartSession = false;
        } else if (isLocal && environmentId) {
          console.log("[useTerminal] Existing terminal session is stale, creating a new local session");
          targetSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows, trackEnvironmentActivity);
          console.log("[useTerminal] Got replacement local sessionId:", targetSessionId);
        } else {
          console.log("[useTerminal] Existing terminal session is stale, creating a new container session");
          targetSessionId = await backend.createTerminalSession(containerId!, cols, rows, user, trackEnvironmentActivity);
          console.log("[useTerminal] Got replacement sessionId:", targetSessionId);
        }
      } else if (isLocal && environmentId) {
        // Create new local session
        console.log("[useTerminal] Creating local terminal session for environment:", environmentId);
        targetSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows, trackEnvironmentActivity);
        if (!isCurrentConnect()) {
          await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          return;
        }
        console.log("[useTerminal] Got local sessionId:", targetSessionId);
      } else {
        // Create new container session
        console.log("[useTerminal] Calling createTerminalSession...");
        targetSessionId = await backend.createTerminalSession(containerId!, cols, rows, user, trackEnvironmentActivity);
        if (!isCurrentConnect()) {
          await backend.detachTerminal(targetSessionId).catch(() => {});
          return;
        }
        console.log("[useTerminal] Got sessionId:", targetSessionId);
      }

      if (!isCurrentConnect()) {
        if (shouldStartSession) {
          if (isLocal) {
            await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          } else {
            await backend.detachTerminal(targetSessionId).catch(() => {});
          }
        }
        return;
      }

      // Update ref immediately so write() can use it right away
      if (sessionIdRef.current !== targetSessionId) resetOutputTracking();
      sessionIdRef.current = targetSessionId;
      setSessionId(targetSessionId);

      cleanupEventListener();

      // Listen for terminal output events
      const eventName = `terminal-output-${targetSessionId}`;
      console.log("[useTerminal] Listening for events on:", eventName);
      if (attachExistingOnly || targetSessionId.endsWith(":setup")) {
        console.info("[setup-terminal] listening for backend terminal output", {
          environmentId: environmentId ?? null,
          sessionId: targetSessionId,
          eventName,
          shouldStartSession,
          replayOutputBuffer,
          attachExistingOnly,
        });
      }
      const listenAbortController = new AbortController();
      listenAbortControllerRef.current = listenAbortController;
      const unlisten = await listenForTerminalOutput(
        targetSessionId,
        listenAbortController.signal,
      );
      if (!isCurrentConnect()) {
        unlisten();
        if (listenAbortControllerRef.current === listenAbortController) {
          listenAbortControllerRef.current = null;
        }
        if (shouldStartSession) {
          if (isLocal) {
            await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          } else {
            await backend.detachTerminal(targetSessionId).catch(() => {});
          }
        }
        return;
      }

      unlistenRef.current = unlisten;

      // Subscribe before taking the authoritative snapshot. Sequenced live
      // frames that race the read are queued by resyncFromOutputBuffer and
      // replayed only when newer than the snapshot, eliminating both gaps and
      // duplicates during background reattachment.
      if (replayOutputBuffer) {
        await resyncFromOutputBuffer(targetSessionId);
        if (!isCurrentConnect()) {
          cleanupEventListener();
          if (shouldStartSession) {
            if (isLocal) {
              await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
            } else {
              await backend.detachTerminal(targetSessionId).catch(() => {});
            }
          }
          return;
        }
      }

      if (attachExistingOnly && targetSessionId && existingSessionRunning === false) {
        console.info("[setup-terminal] backend-owned session is not running after attach", {
          environmentId: environmentId ?? null,
          sessionId: targetSessionId,
          replayOutputBuffer,
        });
        setError("Backend terminal session is not running");
        return;
      }

      // Only start session if it's new (existing sessions are already running)
      if (shouldStartSession) {
        console.log("[useTerminal] Starting terminal session...", isLocal ? "(local)" : "(container)");
        if (isLocal) {
          await backend.startLocalTerminalSession(targetSessionId);
        } else {
          await backend.startTerminalSession(targetSessionId);
        }
      }
      if (!isCurrentConnect()) {
        cleanupEventListener();
        if (shouldStartSession) {
          if (isLocal) {
            await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          } else {
            await backend.detachTerminal(targetSessionId).catch(() => {});
          }
        }
        return;
      }

      isConnectedRef.current = true;
      setIsConnected(true);
      console.log("[useTerminal] Connected successfully");
    } catch (err) {
      // Clean up listener if we set one up
      cleanupEventListener();

      if (!isCurrentConnect()) {
        if (targetSessionId && shouldStartSession) {
          if (isLocal) {
            await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          } else {
            await backend.detachTerminal(targetSessionId).catch(() => {});
          }
        }
        if (sessionIdRef.current === targetSessionId) {
          sessionIdRef.current = null;
        }
        return;
      }

      console.error("[useTerminal] Connection error:", err);
      const message = err instanceof Error ? err.message : "Failed to connect to terminal";

      if (attachExistingOnly) {
        setError(message);
        sessionIdRef.current = null;
        isConnectedRef.current = false;
        setSessionId(null);
        toast.error("Terminal connection failed", { description: message });
        return;
      }

      // If we were trying to reconnect to an existing session and it failed,
      // the session may have been cleaned up on the backend. Fall back to
      // creating a new session.
      if (existingSessionId && !attachExistingOnly) {
        console.log("[useTerminal] Reconnect failed, falling back to new session");
        sessionIdRef.current = null;
        isConnectedRef.current = false;
        setSessionId(null);
        setError(null);

        // Try to create a fresh session instead
        let newSessionId: string | null = null;
        try {
          if (isLocal && environmentId) {
            newSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows, trackEnvironmentActivity);
            if (!isCurrentConnect()) {
              await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
              return;
            }
          } else {
            newSessionId = await backend.createTerminalSession(containerId!, cols, rows, user, trackEnvironmentActivity);
            if (!isCurrentConnect()) {
              await backend.detachTerminal(newSessionId).catch(() => {});
              return;
            }
          }
          console.log("[useTerminal] Created fallback session:", newSessionId);

          if (sessionIdRef.current !== newSessionId) resetOutputTracking();
          sessionIdRef.current = newSessionId;
          setSessionId(newSessionId);

          cleanupEventListener();

          const listenAbortController = new AbortController();
          listenAbortControllerRef.current = listenAbortController;
          const unlisten = await listenForTerminalOutput(
            newSessionId,
            listenAbortController.signal,
          );
          if (!isCurrentConnect()) {
            unlisten();
            if (listenAbortControllerRef.current === listenAbortController) {
              listenAbortControllerRef.current = null;
            }
            if (isLocal) {
              await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
            } else {
              await backend.detachTerminal(newSessionId).catch(() => {});
            }
            return;
          }
          unlistenRef.current = unlisten;

          if (replayOutputBuffer) {
            await resyncFromOutputBuffer(newSessionId);
            if (!isCurrentConnect()) {
              cleanupEventListener();
              if (isLocal) {
                await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
              } else {
                await backend.detachTerminal(newSessionId).catch(() => {});
              }
              return;
            }
          }

          if (isLocal) {
            await backend.startLocalTerminalSession(newSessionId);
          } else {
            await backend.startTerminalSession(newSessionId);
          }
          if (!isCurrentConnect()) {
            cleanupEventListener();
            if (isLocal) {
              await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
            } else {
              await backend.detachTerminal(newSessionId).catch(() => {});
            }
            return;
          }
          isConnectedRef.current = true;
          setIsConnected(true);
          console.log("[useTerminal] Fallback session connected successfully");
          return;
        } catch (fallbackErr) {
          if (!isCurrentConnect()) {
            cleanupEventListener();
            if (newSessionId) {
              if (isLocal) {
                await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
              } else {
                await backend.detachTerminal(newSessionId).catch(() => {});
              }
            }
            if (sessionIdRef.current === newSessionId) {
              sessionIdRef.current = null;
            }
            return;
          }
          console.error("[useTerminal] Fallback session creation also failed:", fallbackErr);
          const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : "Failed to create terminal session";
          setError(`Reconnect failed and new session creation failed: ${fallbackMessage}`);
          toast.error("Terminal connection failed", { description: fallbackMessage });
          sessionIdRef.current = null;
          setSessionId(null);
        }
      } else {
        // We created a new session but it failed - clean up
        setError(message);
        toast.error("Terminal connection failed", { description: message });
        if (sessionIdRef.current) {
          try {
            if (isLocal) {
              await backend.closeLocalTerminalSession(sessionIdRef.current);
            } else {
              await backend.detachTerminal(sessionIdRef.current);
            }
          } catch (detachErr) {
            console.error("[useTerminal] Error detaching after failure:", detachErr);
          }
          sessionIdRef.current = null;
        }
        isConnectedRef.current = false;
        setSessionId(null);
      }
    } finally {
      isConnectingRef.current = false;
      if (!isCurrentConnect() && (attachExistingOnly || existingSessionId?.endsWith(":setup") || targetSessionId?.endsWith(":setup"))) {
        console.info("[setup-terminal] stale connect cleared connecting state", {
          environmentId: environmentId ?? null,
          existingSessionId: existingSessionId ?? null,
          targetSessionId,
          mounted: isMountedRef.current,
        });
      }
      if (isCurrentConnect() || isMountedRef.current) {
        setIsConnecting(false);
      }
    }
  }, [containerId, environmentId, isLocal, cols, rows, existingSessionId, user, replayOutputBuffer, attachExistingOnly, trackEnvironmentActivity, cleanupEventListener, listenForTerminalOutput, resetOutputTracking, resyncFromOutputBuffer]);

  const disconnect = useCallback(async () => {
    if (!sessionId) return;
    connectGenerationRef.current += 1;

    try {
      // Stop listening for events
      cleanupEventListener();

      // Detach terminal (use appropriate method based on isLocal)
      if (isLocalRef.current) {
        await backend.closeLocalTerminalSession(sessionId);
      } else {
        await backend.detachTerminal(sessionId);
      }
    } catch (err) {
      console.error("Failed to disconnect terminal:", err);
    } finally {
      // Clear ref immediately to prevent stale writes
      sessionIdRef.current = null;
      resetOutputTracking();
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setSessionId(null);
      setIsConnected(false);
    }
  }, [sessionId, cleanupEventListener, resetOutputTracking]);

  const resize = useCallback(
    async (newCols: number, newRows: number) => {
      if (!sessionId) return;

      try {
        if (isLocalRef.current) {
          await backend.resizeLocalTerminal(sessionId, newCols, newRows);
        } else {
          await backend.resizeTerminal(sessionId, newCols, newRows);
        }
      } catch (err) {
        // Session not found errors are expected during cleanup/tab switching
        const errMsg = String(err);
        if (!errMsg.includes("Session not found")) {
          console.error("Failed to resize terminal:", err);
        }
      }
    },
    [sessionId]
  );

  // Use ref-based write function to always have access to current sessionId
  const write = useCallback(
    async (data: string) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) {
        console.log("[useTerminal] write called but no sessionId");
        return;
      }

      try {
        if (isLocalRef.current) {
          await backend.writeLocalTerminal(currentSessionId, data);
        } else {
          await backend.writeTerminal(currentSessionId, data);
        }
      } catch (err) {
        console.error("[useTerminal] Failed to write to terminal:", err);
      }
    },
    [] // No deps - uses refs for sessionId and isLocal
  );

  // Auto-connect when containerId changes
  useEffect(() => {
    if (containerId && !isConnected && !isConnecting) {
      // Don't auto-connect for now - let the component decide
    }
  }, [containerId, isConnected, isConnecting]);

  return {
    sessionId,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    resize,
    write,
  };
}
