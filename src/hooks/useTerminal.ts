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
}: UseTerminalOptions): UseTerminalReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);

  // Keep onData ref up to date
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  // Track previous containerId to detect changes
  const previousContainerIdRef = useRef<string | null>(null);

  // Disconnect when containerId changes (switching environments)
  useEffect(() => {
    // If containerId changed and we have an active session, disconnect
    if (previousContainerIdRef.current !== containerId && sessionId) {
      console.log("[useTerminal] Container changed, disconnecting from previous session");
      // Clean up event listener
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      // Detach terminal (use appropriate method based on isLocal)
      if (isLocalRef.current) {
        backend.closeLocalTerminalSession(sessionId).catch(() => {});
      } else {
        backend.detachTerminal(sessionId).catch(() => {});
      }
      // Clear ref immediately to prevent stale writes
      sessionIdRef.current = null;
      setSessionId(null);
      setIsConnected(false);
      setIsConnecting(false);
      setError(null);
    }
    previousContainerIdRef.current = containerId;
  }, [containerId, sessionId]);

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
      if (unlistenRef.current) {
        console.log("[useTerminal] Unlistening from events");
        unlistenRef.current();
        unlistenRef.current = null;
      }
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
    };
  }, []); // Empty deps - only run on unmount

  const connect = useCallback(async () => {
    console.log("[useTerminal] connect called, containerId:", containerId, "environmentId:", environmentId, "isLocal:", isLocal, "existingSessionId:", existingSessionId);

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

    if (isConnecting || isConnected) {
      console.log("[useTerminal] Already connecting or connected, skipping");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      let targetSessionId: string;
      let shouldStartSession = true;

      // If we have an existing session, try to reconnect to it
      if (existingSessionId) {
        console.log("[useTerminal] Reconnecting to existing session:", existingSessionId);
        const existingStatus = await backend.getTerminalSession(existingSessionId).catch((err) => {
          console.warn("[useTerminal] Failed to check existing terminal session, creating a new one:", err);
          return null;
        });

        if (existingStatus?.running) {
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
        console.log("[useTerminal] Got local sessionId:", targetSessionId);
      } else {
        // Create new container session
        console.log("[useTerminal] Calling createTerminalSession...");
        targetSessionId = await backend.createTerminalSession(containerId!, cols, rows, user);
        console.log("[useTerminal] Got sessionId:", targetSessionId);
      }

      // Update ref immediately so write() can use it right away
      sessionIdRef.current = targetSessionId;
      setSessionId(targetSessionId);

      // Listen for terminal output events
      const eventName = `terminal-output-${targetSessionId}`;
      console.log("[useTerminal] Listening for events on:", eventName);
      const unlisten = await listen<number[]>(eventName, (event) => {
        const data = new Uint8Array(event.payload);
        if (onDataRef.current) {
          onDataRef.current(data);
        }
      });

      unlistenRef.current = unlisten;

      // Only start session if it's new (existing sessions are already running)
      if (shouldStartSession) {
        console.log("[useTerminal] Starting terminal session...", isLocal ? "(local)" : "(container)");
        if (isLocal) {
          await backend.startLocalTerminalSession(targetSessionId);
        } else {
          await backend.startTerminalSession(targetSessionId);
        }
      }

      setIsConnected(true);
      console.log("[useTerminal] Connected successfully");
    } catch (err) {
      console.error("[useTerminal] Connection error:", err);
      const message = err instanceof Error ? err.message : "Failed to connect to terminal";

      // Clean up listener if we set one up
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      // If we were trying to reconnect to an existing session and it failed,
      // the session may have been cleaned up on the backend. Fall back to
      // creating a new session.
      if (existingSessionId) {
        console.log("[useTerminal] Reconnect failed, falling back to new session");
        sessionIdRef.current = null;
        setSessionId(null);
        setError(null);

        // Try to create a fresh session instead
        try {
          let newSessionId: string;
          if (isLocal && environmentId) {
            newSessionId = await backend.createLocalTerminalSession(environmentId, cols, rows);
          } else {
            newSessionId = await backend.createTerminalSession(containerId!, cols, rows, user);
          }
          console.log("[useTerminal] Created fallback session:", newSessionId);

          sessionIdRef.current = newSessionId;
          setSessionId(newSessionId);

          const eventName = `terminal-output-${newSessionId}`;
          const unlisten = await listen<number[]>(eventName, (event) => {
            const data = new Uint8Array(event.payload);
            if (onDataRef.current) {
              onDataRef.current(data);
            }
          });
          unlistenRef.current = unlisten;

          if (isLocal) {
            await backend.startLocalTerminalSession(newSessionId);
          } else {
            await backend.startTerminalSession(newSessionId);
          }
          setIsConnected(true);
          console.log("[useTerminal] Fallback session connected successfully");
          return;
        } catch (fallbackErr) {
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
        setSessionId(null);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [containerId, environmentId, isLocal, cols, rows, isConnecting, isConnected, existingSessionId, user]);

  const disconnect = useCallback(async () => {
    if (!sessionId) return;

    try {
      // Stop listening for events
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

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
      setSessionId(null);
      setIsConnected(false);
    }
  }, [sessionId]);

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
