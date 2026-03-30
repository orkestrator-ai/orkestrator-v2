import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw, ArrowDown, Hammer, StopCircle } from "lucide-react";
import { useScrollLock } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { BuildPhase, PipelineSession } from "@/stores/buildPipelineStore";
import {
  createClient,
  getModels,
  createSession,
  getSessionMessages,
  sendPrompt,
  abortSession,
  subscribeToEvents,
  checkHealth,
  ERROR_MESSAGE_PREFIX,
  type ClaudeMessage as ClaudeMessageType,
} from "@/lib/claude-client";
import {
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
  getProjectNotes,
} from "@/lib/tauri";
import { ClaudeMessage } from "@/components/claude/ClaudeMessage";
import type { BuildTabData } from "@/types/paneLayout";
import { extractContextUsage } from "@/lib/context-usage";
import { cn } from "@/lib/utils";
import { useKanbanStore } from "@/stores/kanbanStore";

// Reference to kanban store for non-reactive reads
const kanbanStoreRef = useKanbanStore;

interface BuildChatTabProps {
  data: BuildTabData;
  isActive: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

const PHASE_LABELS: Record<BuildPhase, string> = {
  "creating-environment": "Creating Environment",
  "starting-environment": "Starting Environment",
  building: "Building",
  reviewing: "Reviewing",
  addressing: "Addressing Issues",
  verifying: "Verifying",
  fixing: "Fixing Issues",
  complete: "Complete",
  failed: "Failed",
};

const PHASE_COLORS: Record<BuildPhase, string> = {
  "creating-environment": "text-blue-400",
  "starting-environment": "text-blue-400",
  building: "text-orange-400",
  reviewing: "text-amber-400",
  addressing: "text-amber-400",
  verifying: "text-purple-400",
  fixing: "text-red-400",
  complete: "text-green-400",
  failed: "text-red-500",
};

const SESSION_PHASE_LABELS: Record<string, string> = {
  build: "Build Session",
  review: "Review Session",
  verify: "Verification Session",
  fix: "Fix Session",
};

function SessionDivider({ session, index }: { session: PipelineSession; index: number }) {
  const label = SESSION_PHASE_LABELS[session.phase] || session.phase;
  const iterationSuffix = session.iteration > 0 ? ` (Iteration ${session.iteration + 1})` : "";

  return (
    <div className="flex items-center gap-3 px-4 py-3 my-2">
      <Separator className="flex-1" />
      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
        {index > 0 ? `${label}${iterationSuffix}` : `${label}`}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

export function BuildChatTab({ data, isActive }: BuildChatTabProps) {
  const { environmentId, pipelineId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isInitializedRef = useRef(false);
  const pipelineAdvancingRef = useRef(false);

  const pipeline = useBuildPipelineStore((s) => s.pipelines.get(pipelineId));
  const {
    setPhase,
    addSession: addPipelineSession,
    markSessionIdle,
    setVerificationResult,
    incrementIteration,
    setPipelineError,
  } = useBuildPipelineStore();

  const {
    setClient,
    setModels,
    setSession,
    addMessage,
    setMessages,
    setSessionLoading,
    setServerStatus,
    setContextUsage,
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    clients: clientsMap,
    sessions: sessionsMap,
  } = useClaudeStore();

  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);

  // Collect all messages across all pipeline sessions for rendering
  const allSessionMessages = useMemo(() => {
    if (!pipeline) return [];
    return pipeline.sessions.map((pSession) => {
      const sessionState = sessionsMap.get(pSession.sessionKey);
      return {
        pipelineSession: pSession,
        messages: sessionState?.messages ?? [],
        isLoading: sessionState?.isLoading ?? false,
      };
    });
  }, [pipeline, sessionsMap]);

  // Scroll trigger - use total message count across all sessions
  const totalMessageCount = useMemo(
    () => allSessionMessages.reduce((sum, s) => sum + s.messages.length, 0),
    [allSessionMessages]
  );

  const { isAtBottom, scrollToBottom } = useScrollLock(scrollRef, {
    scrollTrigger: totalMessageCount,
    mountTrigger: connectionState,
    isActive,
    persistKey: `build-${pipelineId}`,
  });

  // Initialize bridge server connection
  useEffect(() => {
    if (!isActive || isInitializedRef.current || !pipeline) return;

    let mounted = true;

    async function initialize() {
      try {
        // Check if client already exists (warm path)
        const existingClient = useClaudeStore.getState().clients.get(environmentId);
        if (existingClient) {
          const healthy = await checkHealth(existingClient);
          if (healthy && mounted) {
            isInitializedRef.current = true;
            setConnectionState("connected");
            if (!hasActiveEventSubscription(environmentId)) {
              startSharedEventSubscription(existingClient);
            }
            return;
          }
        }

        // Cold start
        setConnectionState("connecting");
        let hostPort: number | null = null;

        if (isLocal) {
          let localStatus = await getLocalClaudeServerStatus(environmentId);
          if (!localStatus.running) {
            const result = await startLocalClaudeServer(environmentId);
            localStatus = { running: true, port: result.port, pid: result.pid };
          }
          if (!mounted) return;
          hostPort = localStatus.port ?? null;
        } else {
          const env = useClaudeStore.getState().serverStatus.get(environmentId);
          if (env?.hostPort) {
            hostPort = env.hostPort;
          } else {
            throw new Error("Container server not available for build tab");
          }
        }

        if (!hostPort) throw new Error("Failed to get server port");

        setServerStatus(environmentId, { running: true, hostPort });

        const baseUrl = `http://127.0.0.1:${hostPort}`;
        const bridgeClient = createClient(baseUrl);
        setClient(environmentId, bridgeClient);

        const healthy = await checkHealth(bridgeClient);
        if (!healthy) throw new Error("Bridge server health check failed");

        const availableModels = await getModels(bridgeClient);
        if (!mounted) return;
        setModels(availableModels);

        isInitializedRef.current = true;
        setConnectionState("connected");

        startSharedEventSubscription(bridgeClient);
      } catch (error) {
        if (!mounted) return;
        setConnectionState("error");
        setErrorMessage(error instanceof Error ? error.message : "Connection failed");
      }
    }

    initialize();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, isActive, pipeline?.id, isLocal]);

  // SSE subscription - reuses same pattern as ClaudeChatTab
  const startSharedEventSubscription = useCallback(
    async (bridgeClient: ReturnType<typeof createClient>) => {
      if (hasActiveEventSubscription(environmentId)) return;

      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) return;
      const { abortController } = subscriptionState;

      try {
        const eventStream = subscribeToEvents(bridgeClient, abortController.signal);
        setEventStream(environmentId, eventStream);

        const lastReloadTimeBySession = new Map<string, number>();
        const DEBOUNCE_MS = 200;
        const pendingReloads = new Map<string, NodeJS.Timeout>();

        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            lastReloadTimeBySession.set(sessionId, Date.now());
            const messages = await getSessionMessages(bridgeClient, sessionId);
            setMessages(sessionKey, messages);
          };

          if (immediate) {
            doFetch();
          } else {
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              doFetch();
            } else {
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(sessionId, timeout);
            }
          }
        };

        for await (const event of eventStream) {
          if (abortController.signal.aborted) {
            for (const timeout of pendingReloads.values()) clearTimeout(timeout);
            break;
          }

          const eventType = event?.type;
          const eventSessionId = event?.sessionId;
          const usageFromEvent = extractContextUsage(event.data);

          if (!eventSessionId) continue;

          const sessions = useClaudeStore.getState().sessions;

          for (const [sessionTabId, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;

            const isFinalEvent = eventType === "session.idle";

            if (eventType === "message.updated" || eventType === "session.updated" || isFinalEvent) {
              fetchMessagesDebounced(eventSessionId, sessionTabId, isFinalEvent);
            }

            if (usageFromEvent) {
              setContextUsage(sessionTabId, {
                ...usageFromEvent,
                modelId: usageFromEvent.modelId ?? undefined,
              });
            }

            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
            }

            if (eventType === "session.error") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const rawError = (event.data as any)?.error;
              setSessionLoading(sessionTabId, false);
              const errorMsg = typeof rawError === "string" ? rawError : "An unknown error occurred";
              const errMessage: ClaudeMessageType = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant",
                content: errorMsg,
                parts: [{ type: "text", content: errorMsg }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionTabId, errMessage);
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[BuildChatTab] Event subscription error:", error);
        }
      } finally {
        setEventStream(environmentId, null);
      }
    },
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, setSessionLoading, setContextUsage, addMessage]
  );

  // Pipeline advancement logic - watches for session idle transitions
  // Skips when in "addressing" phase (handled by separate effect below)
  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase === "addressing") return; // Handled by separate effect

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    // Session just went idle - advance the pipeline
    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;

      advancePipeline(pipeline, currentSession).finally(() => {
        pipelineAdvancingRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.currentSessionIndex, pipeline?.sessions, pipeline?.phase, sessionsMap, connectionState, client]);

  // Core pipeline advancement logic
  const advancePipeline = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, completedSession: PipelineSession) => {
      if (!client) return;

      try {
        switch (completedSession.phase) {
          case "build":
            // Build complete -> start review session
            await startReviewSession(currentPipeline);
            break;

          case "review":
            // Review complete -> send "address issues" to the same session
            await sendAddressIssuesMessage(currentPipeline, completedSession);
            break;

          case "fix":
            // Fix complete -> start review session (loop)
            await startReviewSession(currentPipeline);
            break;

          case "verify": {
            // Check verification result
            const sessionState = sessionsMap.get(completedSession.sessionKey);
            const result = parseVerificationResult(sessionState?.messages ?? []);

            setVerificationResult(pipelineId, result.verdict, result.feedback);

            if (result.verdict === "pass") {
              setPhase(pipelineId, "complete");
            } else {
              // Check max iterations
              if (currentPipeline.iteration >= currentPipeline.maxIterations) {
                setPipelineError(pipelineId, `Max iterations (${currentPipeline.maxIterations}) reached. Last feedback: ${result.feedback}`);
              } else {
                incrementIteration(pipelineId);
                await startFixSession(currentPipeline, result.feedback);
              }
            }
            break;
          }
        }
      } catch (error) {
        console.error("[BuildChatTab] Pipeline advancement error:", error);
        setPipelineError(pipelineId, error instanceof Error ? error.message : "Pipeline error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, pipelineId, sessionsMap]
  );

  // Send "address issues" as a follow-up in the review session, then start verify
  const sendAddressIssuesMessage = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, reviewSession: PipelineSession) => {
      if (!client) return;

      setPhase(pipelineId, "addressing");

      // Mark the review session as running again
      const updatedSessions = currentPipeline.sessions.map((s) =>
        s.sdkSessionId === reviewSession.sdkSessionId ? { ...s, status: "running" as const } : s
      );
      useBuildPipelineStore.setState((state) => {
        const p = state.pipelines.get(pipelineId);
        if (!p) return state;
        const newMap = new Map(state.pipelines);
        newMap.set(pipelineId, { ...p, sessions: updatedSessions });
        return { pipelines: newMap };
      });

      // Set loading for the session
      setSessionLoading(reviewSession.sessionKey, true);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: "Please address all the above issues, without asking questions. Make sensible assumptions.",
        parts: [{ type: "text", content: "Please address all the above issues, without asking questions. Make sensible assumptions." }],
        timestamp: new Date().toISOString(),
      };
      addMessage(reviewSession.sessionKey, userMessage);

      const success = await sendPrompt(client, reviewSession.sdkSessionId, userMessage.content, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send address issues prompt");
        return;
      }

      // When this session goes idle again, the effect will detect it.
      // We need to update the phase to "addressing" and handle the idle differently.
      // Override the completed session's phase to trigger verify on next idle.
      useBuildPipelineStore.setState((state) => {
        const p = state.pipelines.get(pipelineId);
        if (!p) return state;
        const newMap = new Map(state.pipelines);
        // Change the review session phase to a pseudo-phase so the next idle triggers verify
        const sessions = p.sessions.map((s) =>
          s.sdkSessionId === reviewSession.sdkSessionId
            ? { ...s, status: "running" as const, phase: "review" as const }
            : s
        );
        newMap.set(pipelineId, { ...p, sessions, phase: "addressing" });
        return { pipelines: newMap };
      });
    },
    [client, pipelineId, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Handle idle after "addressing" phase
  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase !== "addressing") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    // The addressing is done - start verification
    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;
      startVerifySession(pipeline).finally(() => {
        pipelineAdvancingRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.phase, pipeline?.currentSessionIndex, pipeline?.sessions, sessionsMap, connectionState, client]);

  // Create a new Claude session and register it in the store
  const createPipelineSession = useCallback(
    async (phase: PipelineSession["phase"], iteration: number, label: string): Promise<{ sessionKey: string; sdkSessionId: string } | null> => {
      if (!client) return null;

      const newSession = await createSession(client);
      if (!newSession) return null;

      const tabIdForSession = `build-${phase}-${iteration}-${Date.now()}`;
      const sessionKey = createClaudeSessionKey(environmentId, tabIdForSession);

      setSession(sessionKey, {
        sessionId: newSession.sessionId,
        messages: [],
        isLoading: false,
      });

      const pSession: PipelineSession = {
        phase,
        iteration,
        sessionKey,
        sdkSessionId: newSession.sessionId,
        status: "running",
        startedAt: new Date().toISOString(),
        label,
      };

      addPipelineSession(pipelineId, pSession);

      return { sessionKey, sdkSessionId: newSession.sessionId };
    },
    [client, environmentId, pipelineId, setSession, addPipelineSession]
  );

  // Start the initial build session
  const startBuildSession = useCallback(
    async (taskDescription: string) => {
      if (!client) return;

      setPhase(pipelineId, "building");

      const result = await createPipelineSession("build", 0, "Build Session");
      if (!result) {
        setPipelineError(pipelineId, "Failed to create build session");
        return;
      }

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: taskDescription,
        parts: [{ type: "text", content: taskDescription }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);
      setSessionLoading(result.sessionKey, true);

      const success = await sendPrompt(client, result.sdkSessionId, taskDescription, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send build prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Start a review session (no ticket context)
  const startReviewSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (!client) return;

      setPhase(pipelineId, "reviewing");

      const iteration = currentPipeline.iteration;
      const result = await createPipelineSession("review", iteration, `Review Session${iteration > 0 ? ` (Iteration ${iteration + 1})` : ""}`);
      if (!result) {
        setPipelineError(pipelineId, "Failed to create review session");
        return;
      }

      const reviewPrompt = "Review the changes made in this codebase. Look for bugs, issues, code quality problems, missing edge cases, and anything that doesn't match best practices. Be thorough.";

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: reviewPrompt,
        parts: [{ type: "text", content: reviewPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);
      setSessionLoading(result.sessionKey, true);

      const success = await sendPrompt(client, result.sdkSessionId, reviewPrompt, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send review prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Start verification session (with ticket context)
  const startVerifySession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (!client) return;

      setPhase(pipelineId, "verifying");

      const iteration = currentPipeline.iteration;
      const result = await createPipelineSession("verify", iteration, `Verification${iteration > 0 ? ` (Iteration ${iteration + 1})` : ""}`);
      if (!result) {
        setPipelineError(pipelineId, "Failed to create verification session");
        return;
      }

      // Fetch ticket context for verification
      const task = getKanbanTaskSnapshot(currentPipeline.taskId);
      let projectNotes = "";
      try {
        const notes = await getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch { /* ignore */ }

      const verifyPrompt = buildVerificationPrompt(task, projectNotes);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: verifyPrompt,
        parts: [{ type: "text", content: verifyPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);
      setSessionLoading(result.sessionKey, true);

      const success = await sendPrompt(client, result.sdkSessionId, verifyPrompt, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send verification prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Start fix session (with ticket context + what to fix)
  const startFixSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, feedback: string) => {
      if (!client) return;

      setPhase(pipelineId, "fixing");

      const iteration = currentPipeline.iteration + 1;
      const result = await createPipelineSession("fix", iteration, `Fix Session (Iteration ${iteration + 1})`);
      if (!result) {
        setPipelineError(pipelineId, "Failed to create fix session");
        return;
      }

      const task = getKanbanTaskSnapshot(currentPipeline.taskId);
      let projectNotes = "";
      try {
        const notes = await getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch { /* ignore */ }

      const fixPrompt = buildFixPrompt(task, projectNotes, feedback);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: fixPrompt,
        parts: [{ type: "text", content: fixPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);
      setSessionLoading(result.sessionKey, true);

      const success = await sendPrompt(client, result.sdkSessionId, fixPrompt, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send fix prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Stop the pipeline
  const handleStop = useCallback(async () => {
    if (!client || !pipeline) return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (currentSession) {
      await abortSession(client, currentSession.sdkSessionId);
      setSessionLoading(currentSession.sessionKey, false);
    }

    setPipelineError(pipelineId, "Pipeline stopped by user");
  }, [client, pipeline, pipelineId, setSessionLoading, setPipelineError]);

  // Retry
  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    isInitializedRef.current = false;
    setClient(environmentId, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [environmentId, setClient, setServerStatus]);

  // Expose startBuildSession to the pipeline orchestration
  // This is called externally via the hook when the pipeline is ready
  useEffect(() => {
    if (connectionState !== "connected" || !client || !pipeline) return;
    if (pipeline.phase !== "starting-environment") return;
    if (pipeline.sessions.length > 0) return;

    // Pipeline is ready and waiting for build to start
    const task = getKanbanTaskSnapshot(pipeline.taskId);
    if (!task) {
      setPipelineError(pipelineId, "Task not found");
      return;
    }

    getProjectNotes(pipeline.projectId).then((notes) => {
      const prompt = buildBuildPrompt(task, notes.content);
      startBuildSession(prompt);
    }).catch(() => {
      const prompt = buildBuildPrompt(task, "");
      startBuildSession(prompt);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, client, pipeline?.phase, pipeline?.sessions.length]);

  if (connectionState === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-sm">Connecting to Claude bridge server...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground p-4">
        <AlertCircle className="w-10 h-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="text-xs mt-1">{errorMessage || "Unable to connect to Claude bridge server"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Retry
        </Button>
      </div>
    );
  }

  const isRunning = pipeline && !["complete", "failed"].includes(pipeline.phase);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Status bar */}
      {pipeline && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Hammer className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium">Build Pipeline</span>
            <span className={cn("text-xs font-medium", PHASE_COLORS[pipeline.phase])}>
              {PHASE_LABELS[pipeline.phase]}
            </span>
            {pipeline.iteration > 0 && (
              <span className="text-xs text-muted-foreground">
                (Iteration {pipeline.iteration + 1}/{pipeline.maxIterations + 1})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isRunning && (
              <Button variant="ghost" size="sm" onClick={handleStop} className="h-6 px-2 gap-1 text-xs">
                <StopCircle className="w-3 h-3" />
                Stop
              </Button>
            )}
            {pipeline.phase === "complete" && (
              <span className="text-xs text-green-400 font-medium">All acceptance criteria satisfied</span>
            )}
            {pipeline.phase === "failed" && (
              <span className="text-xs text-red-400 font-medium truncate max-w-[300px]">{pipeline.error}</span>
            )}
          </div>
        </div>
      )}

      {/* Messages area */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="py-4">
          {allSessionMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Initializing build pipeline...</p>
            </div>
          ) : (
            allSessionMessages.map((sessionData, sessionIndex) => (
              <div key={sessionData.pipelineSession.sessionKey}>
                <SessionDivider session={sessionData.pipelineSession} index={sessionIndex} />
                {sessionData.messages.map((message, messageIndex) => (
                  <ClaudeMessage
                    key={message.id}
                    message={message}
                    previousMessage={messageIndex > 0 ? sessionData.messages[messageIndex - 1] ?? null : null}
                    isStreaming={sessionData.isLoading && messageIndex === sessionData.messages.length - 1}
                  />
                ))}
                {sessionData.isLoading && (
                  <div className="px-4 py-3">
                    <div className="max-w-3xl mx-auto">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-xs">Claude is working...</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Scroll to bottom button */}
      {!isAtBottom && (
        <div className="flex justify-end px-4 py-1">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 shadow-sm transition-colors"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Scroll down</span>
          </button>
        </div>
      )}
    </div>
  );
}

// --- Helper functions (exported for testing) ---

function getKanbanTaskSnapshot(taskId: string) {
  // Read directly from store to avoid stale closures
  const { tasks } = kanbanStoreRef.getState();
  return tasks.find((t) => t.id === taskId) ?? null;
}

export function buildBuildPrompt(task: { title: string; description: string; acceptanceCriteria: string; comments: Array<{ text: string }> } | null, projectNotes: string): string {
  if (!task) return "Build the feature as described.";

  const parts = [
    "You are building a feature. Here is the ticket:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push("\n\nBuild this feature completely. Do not ask any questions - make your best judgment for any ambiguous requirements. Just go ahead and implement everything needed.");

  return parts.join("\n");
}

export function buildVerificationPrompt(task: { title: string; description: string; acceptanceCriteria: string; comments: Array<{ text: string }> } | null, projectNotes: string): string {
  if (!task) return "Do the changes satisfy the acceptance criteria?";

  const parts = [
    "Review the current state of the codebase against the following ticket context:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push("\n\nDo the changes implemented satisfy ALL acceptance criteria according to the context above? Answer with YES or NO on the first line, then explain your reasoning.");

  return parts.join("\n");
}

export function buildFixPrompt(task: { title: string; description: string; acceptanceCriteria: string; comments: Array<{ text: string }> } | null, projectNotes: string, feedback: string): string {
  if (!task) return `Fix the following issues:\n\n${feedback}\n\nDo not ask any questions.`;

  const parts = [
    "The following acceptance criteria have NOT been fully satisfied. Here is the ticket context:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\n**Why the acceptance criteria are not satisfied**:\n${feedback}`);
  parts.push("\n\nPlease fix the issues above to satisfy the acceptance criteria. Do not ask any questions - make sensible assumptions and go ahead.");

  return parts.join("\n");
}

export function parseVerificationResult(messages: ClaudeMessageType[]): { verdict: "pass" | "fail"; feedback: string } {
  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  if (!lastAssistant) return { verdict: "fail", feedback: "No verification response received" };

  const text = lastAssistant.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n")
    .trim();

  const firstLine = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  const verdict = firstLine.startsWith("YES") ? "pass" : "fail";

  return { verdict, feedback: text };
}
