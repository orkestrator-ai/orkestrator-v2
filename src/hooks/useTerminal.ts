// Hook for managing terminal sessions with Electron backend
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@/lib/native/events";
import { toast } from "sonner";
import * as backend from "@/lib/backend";

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
}: UseTerminalOptions): UseTerminalReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  const isMountedRef = useRef(false);

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
    const unlisten = unlistenRef.current;
    if (unlisten) {
      unlisten();
      unlistenRef.current = null;
    }
  }, []);

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
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setSessionId(null);
      setIsConnected(false);
      setIsConnecting(false);
      setError(null);
    }
    previousContainerIdRef.current = containerId;
  }, [containerId, sessionId, cleanupEventListener]);

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
          targetSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows);
          console.log("[useTerminal] Got replacement local sessionId:", targetSessionId);
        } else {
          console.log("[useTerminal] Existing terminal session is stale, creating a new container session");
          targetSessionId = await backend.createTerminalSession(containerId!, cols, rows, user);
          console.log("[useTerminal] Got replacement sessionId:", targetSessionId);
        }
      } else if (isLocal && environmentId) {
        // Create new local session
        console.log("[useTerminal] Creating local terminal session for environment:", environmentId);
        targetSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows);
        if (!isCurrentConnect()) {
          await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
          return;
        }
        console.log("[useTerminal] Got local sessionId:", targetSessionId);
      } else {
        // Create new container session
        console.log("[useTerminal] Calling createTerminalSession...");
        targetSessionId = await backend.createTerminalSession(containerId!, cols, rows, user);
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
      // Replay the backend's bounded output buffer BEFORE attaching the live
      // listener. The backend appends to its buffer before emitting live, so
      // attaching first would deliver already-buffered bytes twice (once live,
      // once via replay) and out of order. Output produced in the small window
      // between the snapshot and listener registration is rare for setup
      // sessions and self-corrects as the stream continues.
      if (replayOutputBuffer) {
        const bufferedOutput = await backend.getTerminalOutputBuffer(targetSessionId).catch((err) => {
          console.warn("[useTerminal] Failed to replay terminal output buffer:", err);
          return "";
        });
        if (attachExistingOnly || targetSessionId.endsWith(":setup")) {
          console.info("[setup-terminal] replay buffer fetched", {
            environmentId: environmentId ?? null,
            sessionId: targetSessionId,
            bufferChars: bufferedOutput.length,
          });
        }
        if (!isCurrentConnect()) {
          // No live listener registered yet; only tear down a session we created.
          if (shouldStartSession) {
            if (isLocal) {
              await backend.closeLocalTerminalSession(targetSessionId).catch(() => {});
            } else {
              await backend.detachTerminal(targetSessionId).catch(() => {});
            }
          }
          return;
        }
        if (bufferedOutput && onDataRef.current) {
          onDataRef.current(new TextEncoder().encode(bufferedOutput));
        }
      }

      const unlisten = await listen<number[]>(eventName, (event) => {
        const data = new Uint8Array(event.payload);
        if (onDataRef.current) {
          onDataRef.current(data);
        }
      });
      if (!isCurrentConnect()) {
        unlisten();
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
            newSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows);
            if (!isCurrentConnect()) {
              await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
              return;
            }
          } else {
            newSessionId = await backend.createTerminalSession(containerId!, cols, rows, user);
            if (!isCurrentConnect()) {
              await backend.detachTerminal(newSessionId).catch(() => {});
              return;
            }
          }
          console.log("[useTerminal] Created fallback session:", newSessionId);

          sessionIdRef.current = newSessionId;
          setSessionId(newSessionId);

          cleanupEventListener();

          const eventName = `terminal-output-${newSessionId}`;

          // Replay any buffered output before attaching the live listener so
          // already-buffered bytes are not delivered twice (see the primary
          // attach path above for the rationale).
          if (replayOutputBuffer) {
            const bufferedOutput = await backend.getTerminalOutputBuffer(newSessionId).catch((err) => {
              console.warn("[useTerminal] Failed to replay fallback terminal output buffer:", err);
              return "";
            });
            if (!isCurrentConnect()) {
              if (isLocal) {
                await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
              } else {
                await backend.detachTerminal(newSessionId).catch(() => {});
              }
              return;
            }
            if (bufferedOutput && onDataRef.current) {
              onDataRef.current(new TextEncoder().encode(bufferedOutput));
            }
          }

          const unlisten = await listen<number[]>(eventName, (event) => {
            const data = new Uint8Array(event.payload);
            if (onDataRef.current) {
              onDataRef.current(data);
            }
          });
          if (!isCurrentConnect()) {
            unlisten();
            if (isLocal) {
              await backend.closeLocalTerminalSession(newSessionId).catch(() => {});
            } else {
              await backend.detachTerminal(newSessionId).catch(() => {});
            }
            return;
          }
          unlistenRef.current = unlisten;

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
  }, [containerId, environmentId, isLocal, cols, rows, existingSessionId, user, replayOutputBuffer, attachExistingOnly, cleanupEventListener]);

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
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setSessionId(null);
      setIsConnected(false);
    }
  }, [sessionId, cleanupEventListener]);

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
