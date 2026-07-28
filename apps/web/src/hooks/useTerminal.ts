// Hook for managing terminal sessions with Electron backend
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  UnlistenFn,
} from "@/lib/native/events";
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
  /** Reconcile the client view with an authoritative backend buffer snapshot. */
  onReplay?: (
    data: Uint8Array,
    metadata: { preserveExisting: boolean },
  ) => void;
  /** Stable tab identity used by the backend to make session creation idempotent. */
  terminalKey?: string;
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
  onReplay,
  terminalKey,
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
  const onDataRef = useRef(onData);
  const onReplayRef = useRef(onReplay);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  const isMountedRef = useRef(false);

  // Keep onData ref up to date
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onReplayRef.current = onReplay;
  }, [onReplay]);

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
      // A renderer-side environment refresh can temporarily change this prop.
      // Persistent sessions are backend-owned, so changing views only removes
      // this listener; explicit tab close is responsible for terminating the PTY.
      if (!persistSession) {
        if (isLocalRef.current) {
          backend.closeLocalTerminalSession(sessionId).catch(() => {});
        } else {
          backend.detachTerminal(sessionId).catch(() => {});
        }
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
  }, [containerId, sessionId, persistSession, cleanupEventListener]);

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
      setError(null);
      return;
    }
    if (isLocal ? !environmentId : !containerId) {
      setError(isLocal
        ? "No environment ID provided for local environment"
        : "No container ID provided");
      return;
    }
    if (isConnectingRef.current || isConnectedRef.current) return;

    isConnectingRef.current = true;
    const connectGeneration = connectGenerationRef.current + 1;
    connectGenerationRef.current = connectGeneration;
    const isCurrentConnect = () =>
      connectGenerationRef.current === connectGeneration;
    setIsConnecting(true);
    setError(null);

    let targetSessionId: string | null = null;
    let targetCreated = false;
    let targetShouldStart = false;
    let existingSessionRunning: boolean | null = null;

    const destroyIfCreated = async (
      id: string | null,
      created: boolean,
    ): Promise<void> => {
      if (!id || !created) return;
      if (isLocal) {
        await backend.closeLocalTerminalSession(id).catch(() => {});
      } else {
        await backend.detachTerminal(id).catch(() => {});
      }
    };

    const createSession = async (): Promise<backend.TerminalSessionCreateResult> => {
      if (isLocal) {
        return backend.createLocalTerminalSession(
          environmentId!,
          cols,
          rows,
          trackEnvironmentActivity,
          terminalKey,
        );
      }
      return backend.createTerminalSession(
        containerId!,
        cols,
        rows,
        user,
        trackEnvironmentActivity,
        environmentId,
        terminalKey,
      );
    };

    const attachOutput = async (
      id: string,
      preserveExisting: boolean,
    ): Promise<void> => {
      type TerminalOutputEventPayload = number[] | backend.TerminalOutputEvent;
      type PendingOutput = {
        data: Uint8Array;
        revision: number | null;
        generation: number | null;
      };

      const eventName = `terminal-output-${id}`;
      const pendingLiveOutput: PendingOutput[] = [];
      let disposed = false;
      // Buffer immediately; output can arrive after the output listener is
      // registered but before the lifecycle listener and first snapshot exist.
      let snapshotPending = replayOutputBuffer;
      let activeGeneration: number | null = null;
      let lastAppliedRevision = 0;
      let reconciliationQueued = false;
      let reconciliationPromise: Promise<void> | null = null;
      let snapshotErrorActive = false;

      const deliverWithoutSnapshot = (pending: PendingOutput): void => {
        // Legacy payloads have no cursor and therefore cannot be deduplicated.
        if (pending.revision === null || pending.generation === null) {
          onDataRef.current?.(pending.data);
          return;
        }

        if (activeGeneration !== pending.generation) {
          activeGeneration = pending.generation;
          lastAppliedRevision = 0;
        }
        if (pending.revision <= lastAppliedRevision) return;
        onDataRef.current?.(pending.data);
        lastAppliedRevision = pending.revision;
      };

      const reconcileOnce = async (): Promise<void> => {
        snapshotPending = true;
        try {
          const snapshot = await backend.getTerminalOutputSnapshot(id);
          if (disposed || !isCurrentConnect()) return;

          onReplayRef.current?.(
            new TextEncoder().encode(snapshot.output),
            { preserveExisting },
          );
          activeGeneration = snapshot.generation;
          lastAppliedRevision = snapshot.revision;
          if (snapshotErrorActive) {
            snapshotErrorActive = false;
            setError(null);
          }

          const buffered = pendingLiveOutput.splice(0);
          snapshotPending = false;
          for (const pending of buffered) {
            if (pending.revision === null || pending.generation === null) {
              onDataRef.current?.(pending.data);
              continue;
            }
            if (pending.generation !== activeGeneration) {
              pendingLiveOutput.push(pending);
              reconciliationQueued = true;
              continue;
            }
            if (pending.revision <= lastAppliedRevision) continue;
            if (pending.revision !== lastAppliedRevision + 1) {
              pendingLiveOutput.push(pending);
              reconciliationQueued = true;
              continue;
            }
            onDataRef.current?.(pending.data);
            lastAppliedRevision = pending.revision;
          }
        } catch (snapshotError) {
          if (disposed || !isCurrentConnect()) return;
          console.warn("[useTerminal] Failed to reconcile terminal output snapshot:", snapshotError);
          snapshotErrorActive = true;
          const message = snapshotError instanceof Error
            ? snapshotError.message
            : "Unknown snapshot error";
          setError(`Failed to synchronize terminal output: ${message}`);

          // Keep the existing view. Live output should continue even though
          // history cannot be made authoritative until a later reconnect.
          snapshotPending = false;
          const buffered = pendingLiveOutput.splice(0);
          for (const pending of buffered) deliverWithoutSnapshot(pending);
        } finally {
          snapshotPending = false;
        }
      };

      const reconcileSnapshot = (): Promise<void> => {
        if (disposed || !isCurrentConnect() || !replayOutputBuffer) {
          return Promise.resolve();
        }
        if (reconciliationPromise) {
          reconciliationQueued = true;
          return reconciliationPromise;
        }

        // Deferring the runner one microtask ensures the promise is assigned
        // before a synchronously resolved snapshot can trigger more events.
        reconciliationPromise = Promise.resolve().then(async () => {
          let attempts = 0;
          do {
            reconciliationQueued = false;
            await reconcileOnce();
            attempts += 1;
          } while (
            reconciliationQueued &&
            // One coalesced follow-up closes the normal event/snapshot race.
            // If an inconsistent backend keeps returning an older generation,
            // wait for the next live/reconnect trigger instead of tight-looping.
            attempts < 2 &&
            !disposed &&
            isCurrentConnect()
          );
        }).finally(() => {
          reconciliationPromise = null;
        });
        return reconciliationPromise;
      };

      const outputUnlisten = await listen<TerminalOutputEventPayload>(
        eventName,
        (event) => {
          const payload = event.payload;
          const pending: PendingOutput = Array.isArray(payload)
            ? {
                data: new Uint8Array(payload),
                revision: null,
                generation: null,
              }
            : {
                data: new Uint8Array(payload.data),
                revision: payload.revision,
                generation: payload.generation,
              };

          if (snapshotPending) {
            pendingLiveOutput.push(pending);
            return;
          }
          if (pending.revision === null || pending.generation === null) {
            onDataRef.current?.(pending.data);
            return;
          }
          if (activeGeneration === null) {
            activeGeneration = pending.generation;
            lastAppliedRevision = pending.revision;
            onDataRef.current?.(pending.data);
            return;
          }
          if (
            pending.generation !== activeGeneration ||
            pending.revision > lastAppliedRevision + 1
          ) {
            pendingLiveOutput.push(pending);
            void reconcileSnapshot();
            return;
          }
          if (pending.revision <= lastAppliedRevision) return;
          onDataRef.current?.(pending.data);
          lastAppliedRevision = pending.revision;
        },
      );

      if (!isCurrentConnect()) {
        outputUnlisten();
        return;
      }

      let reconnectUnlisten: UnlistenFn | null = null;
      try {
        if (replayOutputBuffer) {
          reconnectUnlisten = await listen(
            NATIVE_EVENT_STREAM_CONNECTED_EVENT,
            () => {
              void reconcileSnapshot();
            },
          );
        }
      } catch (listenerError) {
        outputUnlisten();
        throw listenerError;
      }

      if (!isCurrentConnect()) {
        outputUnlisten();
        reconnectUnlisten?.();
        return;
      }

      unlistenRef.current = () => {
        disposed = true;
        outputUnlisten();
        reconnectUnlisten?.();
      };

      if (replayOutputBuffer) await reconcileSnapshot();
    };

    const finishAttachment = async (
      id: string,
      created: boolean,
      shouldStart: boolean,
    ): Promise<void> => {
      sessionIdRef.current = id;
      setSessionId(id);
      cleanupEventListener();
      await attachOutput(id, created);
      if (!isCurrentConnect()) {
        cleanupEventListener();
        await destroyIfCreated(id, created);
        return;
      }
      if (shouldStart) {
        if (isLocal) {
          await backend.startLocalTerminalSession(id);
        } else {
          await backend.startTerminalSession(id);
        }
      }
    };

    try {
      if (existingSessionId) {
        const existingStatus = await backend
          .getTerminalSession(existingSessionId)
          .catch(() => null);
        if (!isCurrentConnect()) return;
        existingSessionRunning = existingStatus?.running ?? false;
        if (existingSessionRunning || attachExistingOnly) {
          targetSessionId = existingSessionId;
        } else {
          const created = await createSession();
          targetSessionId = created.sessionId;
          targetCreated = created.created;
          targetShouldStart = true;
        }
      } else {
        const created = await createSession();
        targetSessionId = created.sessionId;
        targetCreated = created.created;
        targetShouldStart = true;
      }

      if (!isCurrentConnect()) {
        await destroyIfCreated(targetSessionId, targetCreated);
        return;
      }

      await finishAttachment(
        targetSessionId,
        targetCreated,
        targetShouldStart,
      );
      if (!isCurrentConnect()) return;

      if (attachExistingOnly && existingSessionRunning === false) {
        setError("Backend terminal session is not running");
        return;
      }

      isConnectedRef.current = true;
      setIsConnected(true);
    } catch (err) {
      cleanupEventListener();
      if (!isCurrentConnect()) {
        await destroyIfCreated(targetSessionId, targetCreated);
        if (sessionIdRef.current === targetSessionId) {
          sessionIdRef.current = null;
        }
        return;
      }

      const message = err instanceof Error
        ? err.message
        : "Failed to connect to terminal";
      if (attachExistingOnly) {
        setError(message);
        sessionIdRef.current = null;
        isConnectedRef.current = false;
        setSessionId(null);
        toast.error("Terminal connection failed", { description: message });
        return;
      }

      if (existingSessionId) {
        // A failed attach may mean the supplied session disappeared. Use the
        // same attachment/reconciliation path for the replacement.
        await destroyIfCreated(targetSessionId, targetCreated);
        sessionIdRef.current = null;
        setSessionId(null);
        targetSessionId = null;
        targetCreated = false;
        targetShouldStart = false;

        try {
          const replacement = await createSession();
          targetSessionId = replacement.sessionId;
          targetCreated = replacement.created;
          targetShouldStart = true;
          if (!isCurrentConnect()) {
            await destroyIfCreated(targetSessionId, targetCreated);
            return;
          }
          await finishAttachment(
            targetSessionId,
            targetCreated,
            targetShouldStart,
          );
          if (!isCurrentConnect()) return;
          isConnectedRef.current = true;
          setIsConnected(true);
          return;
        } catch (fallbackErr) {
          cleanupEventListener();
          await destroyIfCreated(targetSessionId, targetCreated);
          if (!isCurrentConnect()) return;
          const fallbackMessage = fallbackErr instanceof Error
            ? fallbackErr.message
            : "Failed to create terminal session";
          setError(`Reconnect failed and new session creation failed: ${fallbackMessage}`);
          toast.error("Terminal connection failed", {
            description: fallbackMessage,
          });
          sessionIdRef.current = null;
          setSessionId(null);
        }
      } else {
        await destroyIfCreated(targetSessionId, targetCreated);
        setError(message);
        toast.error("Terminal connection failed", { description: message });
        sessionIdRef.current = null;
        isConnectedRef.current = false;
        setSessionId(null);
      }
    } finally {
      // A superseded connect must not clear the in-flight state of the newer
      // generation that replaced it.
      if (isCurrentConnect()) {
        isConnectingRef.current = false;
        if (isMountedRef.current) setIsConnecting(false);
      }
    }
  }, [containerId, environmentId, isLocal, cols, rows, existingSessionId, user, replayOutputBuffer, attachExistingOnly, trackEnvironmentActivity, terminalKey, cleanupEventListener]);

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
