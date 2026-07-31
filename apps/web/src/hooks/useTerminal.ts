// Hook for managing terminal sessions with Electron backend
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  UnlistenFn,
} from "@/lib/native/events";
import { toast } from "sonner";
import * as backend from "@/lib/backend";

/**
 * Wire shape of a `terminal-output-<sessionId>` event.
 *
 * `text` is the current plain UTF-8 form. Base64 and `number[]` forms remain
 * accepted during one rolling-upgrade window, and `desynced` is the gateway
 * telling this client that frames were dropped for it under backpressure and
 * the authoritative buffer must be replayed.
 */
export type TerminalOutputPayload =
  | Uint8Array
  | number[]
  | string
  | {
      bytesBase64?: string;
      text?: string;
      full?: boolean;
      bytes?: number[] | Uint8Array;
      data?: number[];
      desynced?: boolean;
      revision?: number;
      generation?: number;
    };

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
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return decodeBase64Bytes(payload);
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if (!payload || typeof payload !== "object") return new Uint8Array(0);
  if (payload.desynced) return null;
  if (typeof payload.text === "string") return new TextEncoder().encode(payload.text);
  if (typeof payload.bytesBase64 === "string") return decodeBase64Bytes(payload.bytesBase64);
  if (payload.bytes instanceof Uint8Array) return payload.bytes;
  if (Array.isArray(payload.bytes)) return new Uint8Array(payload.bytes);
  if (Array.isArray(payload.data)) return new Uint8Array(payload.data);
  return new Uint8Array(0);
}

function terminalOutputCursor(
  payload: TerminalOutputPayload,
): { revision: number | null; generation: number | null } {
  if (
    !payload
    || typeof payload !== "object"
    || payload instanceof Uint8Array
    || Array.isArray(payload)
  ) {
    return { revision: null, generation: null };
  }
  const revision = Number.isSafeInteger(payload.revision)
    && (payload.revision ?? -1) >= 0
    ? payload.revision!
    : null;
  const generation = Number.isSafeInteger(payload.generation)
    && (payload.generation ?? -1) >= 0
    ? payload.generation!
    : null;
  return { revision, generation };
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
  /** Reconcile the client view with an authoritative backend buffer snapshot. */
  onReplay?: (
    data: Uint8Array,
    metadata: {
      preserveExisting: boolean;
      degraded?: "snapshot-error" | "truncated";
      error?: string;
    },
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

function safelyUnlisten(unlisten: UnlistenFn | null): void {
  if (!unlisten) return;
  try {
    unlisten();
  } catch (error) {
    console.error("[useTerminal] Failed to remove terminal listener:", error);
  }
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
  const listenAbortControllerRef = useRef<AbortController | null>(null);
  const onDataRef = useRef(onData);
  const onReplayRef = useRef(onReplay);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  const isMountedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const activeSessionLocalRef = useRef(isLocal);
  const persistSessionRef = useRef(persistSession);
  const isLocalRef = useRef(isLocal);

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
    listenAbortControllerRef.current?.abort();
    listenAbortControllerRef.current = null;
    const unlisten = unlistenRef.current;
    if (unlisten) {
      unlistenRef.current = null;
      safelyUnlisten(unlisten);
    }
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    persistSessionRef.current = persistSession;
  }, [persistSession]);

  useEffect(() => {
    isLocalRef.current = isLocal;
  }, [isLocal]);

  const terminalTargetIdentity = JSON.stringify({
    kind: isLocal ? "local" : "container",
    containerId,
    environmentId: environmentId ?? null,
    terminalKey: terminalKey ?? null,
    attachExistingOnly,
    replayOutputBuffer,
    trackEnvironmentActivity,
    user: user ?? null,
  });
  const previousTerminalTargetIdentityRef = useRef(terminalTargetIdentity);
  const previousExistingSessionIdRef = useRef(existingSessionId ?? null);

  // Invalidate all pending work when any part of the terminal target changes.
  // The generation changes even before a session ID exists, so awaits in status,
  // create, listener registration, snapshot, and start cannot publish stale state.
  useEffect(() => {
    const nextExistingSessionId = existingSessionId ?? null;
    const targetChanged =
      previousTerminalTargetIdentityRef.current !== terminalTargetIdentity;
    const requestedSessionChanged =
      previousExistingSessionIdRef.current !== nextExistingSessionId;
    if (!targetChanged && !requestedSessionChanged) return;

    previousTerminalTargetIdentityRef.current = terminalTargetIdentity;
    previousExistingSessionIdRef.current = nextExistingSessionId;

    // PersistentTerminal publishes the session returned by this hook into its
    // store, which then feeds back as existingSessionId. That is adoption of the
    // current connection, not a request to replace it.
    if (
      !targetChanged &&
      requestedSessionChanged &&
      nextExistingSessionId === sessionIdRef.current
    ) {
      return;
    }

    connectGenerationRef.current += 1;
    cleanupEventListener();

    const activeSessionId = sessionIdRef.current;
    if (activeSessionId && !persistSessionRef.current) {
      if (activeSessionLocalRef.current) {
        void backend.closeLocalTerminalSession(activeSessionId).catch(() => {});
      } else {
        void backend.detachTerminal(activeSessionId).catch(() => {});
      }
    }

    sessionIdRef.current = null;
    isConnectedRef.current = false;
    isConnectingRef.current = false;
    setSessionId(null);
    setIsConnected(false);
    setIsConnecting(false);
    setError(null);
  }, [terminalTargetIdentity, existingSessionId, cleanupEventListener]);

  // Unmount means "not currently visible", not "stop the terminal". Always
  // release only renderer consumption here; explicit disconnect/tab-close
  // actions own backend process teardown.
  useEffect(() => {
    return () => {
      console.log("[useTerminal] Cleanup on unmount, sessionId:", sessionIdRef.current, "persist:", persistSessionRef.current);
      connectGenerationRef.current += 1;
      if (unlistenRef.current) {
        console.log("[useTerminal] Unlistening from events");
      }
      cleanupEventListener();
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

    // Stable/persistent sessions are backend-owned and may have been adopted by
    // another renderer after create returned. Only ephemeral renderer-owned
    // sessions can be destroyed by stale or failed connection work.
    const releaseCreatedSession = async (
      id: string | null,
      created: boolean,
    ): Promise<void> => {
      const backendOwnsStableSession =
        Boolean(terminalKey) && Boolean(environmentId);
      if (!id || !created || backendOwnsStableSession) return;
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

    type OutputAttachment = {
      dispose: UnlistenFn;
      reconcileInitial: () => Promise<void>;
    };

    const attachOutput = async (
      id: string,
      preserveExisting: boolean,
    ): Promise<OutputAttachment> => {
      type PendingOutput = {
        data: Uint8Array;
        revision: number | null;
        generation: number | null;
      };

      const eventName = `terminal-output-${id}`;
      const listenAbortController = new AbortController();
      listenAbortControllerRef.current = listenAbortController;
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
          const requestedCursor = activeGeneration === null
            ? undefined
            : { revision: lastAppliedRevision, generation: activeGeneration };
          const snapshot = requestedCursor
            ? await backend.getTerminalOutputSnapshot(id, requestedCursor)
            : await backend.getTerminalOutputSnapshot(id);
          if (disposed || !isCurrentConnect()) return;

          if (
            snapshot.mode === "delta"
            && requestedCursor
            && snapshot.generation === requestedCursor.generation
          ) {
            if (snapshot.output) {
              onDataRef.current?.(new TextEncoder().encode(snapshot.output));
            }
          } else {
            onReplayRef.current?.(
              new TextEncoder().encode(snapshot.output),
              {
                // A reconciliation fallback replaces the local view exactly.
                preserveExisting: requestedCursor ? false : preserveExisting,
                degraded: snapshot.truncated ? "truncated" : undefined,
              },
            );
          }
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
          onReplayRef.current?.(
            new Uint8Array(),
            {
              preserveExisting,
              degraded: "snapshot-error",
              error: message,
            },
          );

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

      const outputUnlisten = await listen<TerminalOutputPayload>(
        eventName,
        (event) => {
          const payload = event.payload;
          const data = decodeTerminalOutputPayload(payload);
          if (data === null) {
            void reconcileSnapshot();
            return;
          }
          const cursor = terminalOutputCursor(payload);
          const pending: PendingOutput = {
            data,
            revision: cursor.revision,
            generation: cursor.generation,
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
        { signal: listenAbortController.signal },
      );

      if (!isCurrentConnect()) {
        safelyUnlisten(outputUnlisten);
        return {
          dispose: () => {},
          reconcileInitial: async () => {},
        };
      }

      let reconnectUnlisten: UnlistenFn | null = null;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        listenAbortController.abort();
        if (listenAbortControllerRef.current === listenAbortController) {
          listenAbortControllerRef.current = null;
        }
        safelyUnlisten(outputUnlisten);
        safelyUnlisten(reconnectUnlisten);
      };

      // Publish the generation-local disposer before lifecycle registration.
      // Disconnect/identity changes can now cancel the output listener even if
      // the second listen call is still pending.
      unlistenRef.current = dispose;
      try {
        if (replayOutputBuffer) {
          reconnectUnlisten = await listen(
            NATIVE_EVENT_STREAM_CONNECTED_EVENT,
            () => {
              void reconcileSnapshot();
            },
            { signal: listenAbortController.signal },
          );
          // Disconnect may have disposed the partial attachment while the
          // lifecycle listener registration was still awaiting its disposer.
          if (disposed) {
            safelyUnlisten(reconnectUnlisten);
            reconnectUnlisten = null;
          }
        }
      } catch (listenerError) {
        dispose();
        if (unlistenRef.current === dispose) {
          unlistenRef.current = null;
        }
        throw listenerError;
      }

      if (!isCurrentConnect()) {
        dispose();
        if (unlistenRef.current === dispose) {
          unlistenRef.current = null;
        }
        return {
          dispose: () => {},
          reconcileInitial: async () => {},
        };
      }

      return {
        dispose,
        reconcileInitial: () => replayOutputBuffer
          ? reconcileSnapshot()
          : Promise.resolve(),
      };
    };

    let targetListenerDisposer: UnlistenFn | null = null;
    const releaseTargetListener = (): void => {
      const dispose = targetListenerDisposer;
      if (!dispose) return;
      targetListenerDisposer = null;
      dispose();
      if (unlistenRef.current === dispose) {
        unlistenRef.current = null;
      }
    };

    const finishAttachment = async (
      id: string,
      created: boolean,
      shouldStart: boolean,
    ): Promise<void> => {
      sessionIdRef.current = id;
      activeSessionLocalRef.current = isLocal;
      setSessionId(id);
      cleanupEventListener();
      const attachment = await attachOutput(id, created);
      targetListenerDisposer = attachment.dispose;
      if (!isCurrentConnect()) {
        releaseTargetListener();
        await releaseCreatedSession(id, created);
        return;
      }
      await attachment.reconcileInitial();
      if (!isCurrentConnect()) {
        releaseTargetListener();
        await releaseCreatedSession(id, created);
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
        await releaseCreatedSession(targetSessionId, targetCreated);
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
      releaseTargetListener();
      if (!isCurrentConnect()) {
        await releaseCreatedSession(targetSessionId, targetCreated);
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
        await releaseCreatedSession(targetSessionId, targetCreated);
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
            await releaseCreatedSession(targetSessionId, targetCreated);
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
          releaseTargetListener();
          await releaseCreatedSession(targetSessionId, targetCreated);
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
        await releaseCreatedSession(targetSessionId, targetCreated);
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
    connectGenerationRef.current += 1;
    isConnectingRef.current = false;
    cleanupEventListener();

    const activeSessionId = sessionIdRef.current;
    const activeSessionIsLocal = activeSessionLocalRef.current;
    sessionIdRef.current = null;
    isConnectedRef.current = false;
    setSessionId(null);
    setIsConnected(false);
    setIsConnecting(false);
    setError(null);

    if (!activeSessionId) return;

    try {
      // Detach terminal (use appropriate method based on isLocal)
      if (activeSessionIsLocal) {
        await backend.closeLocalTerminalSession(activeSessionId);
      } else {
        await backend.detachTerminal(activeSessionId);
      }
    } catch (err) {
      console.error("Failed to disconnect terminal:", err);
    } finally {
      // Clear ref immediately to prevent stale writes
      // State was cleared before awaiting the close so stale writes and pending
      // connection phases are cancelled immediately.
    }
  }, [cleanupEventListener]);

  // A failed write can leave the browser gateway's input queue closed until the
  // session restarts, while output keeps streaming so the terminal still looks
  // alive. Reconnecting is the only recovery, so the failure toast offers it.
  const reconnectRef = useRef<() => void>(() => {});
  useEffect(() => {
    reconnectRef.current = () => {
      void (async () => {
        await disconnect();
        await connect();
      })();
    };
  }, [connect, disconnect]);

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
        toast.error("Terminal input failed", {
          id: `terminal-input-${currentSessionId}`,
          description: err instanceof Error ? err.message : String(err),
          action: {
            label: "Reconnect",
            onClick: () => reconnectRef.current(),
          },
        });
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
