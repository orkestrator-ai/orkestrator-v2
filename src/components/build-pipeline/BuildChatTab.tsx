import { Suspense, lazy, useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw, ArrowDown, Hammer, StopCircle, ArrowUp, PlayCircle } from "lucide-react";
import { useScrollLock } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useConfigStore, useEnvironmentStore } from "@/stores";
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
  type ClaudeAttachment,
} from "@/lib/claude-client";
import type { TaskSnapshotImage } from "@/prompts";
import {
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
  startClaudeServer,
  getClaudeServerStatus,
  getProjectNotes,
} from "@/lib/backend";
import { NativeMessage } from "@/components/chat/NativeMessage";
import type { BuildTabData } from "@/types/paneLayout";
import { extractContextUsage } from "@/lib/context-usage";
import { cn } from "@/lib/utils";
import {
  createPRPrompt,
  createResolveConflictsPrompt,
  createBuildReviewPrompt,
  createBuildPrompt,
  createVerificationPrompt,
  createFixPrompt,
} from "@/prompts";
import { parseVerificationResult } from "@/lib/parse-verification-result";
import { isSetupPending } from "@/lib/setup-commands";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { resolveActiveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import { normalizeClaudeMessage } from "@/lib/chat/native-message-adapters";
import * as backend from "@/lib/backend";

// Reference to kanban store for non-reactive reads
const kanbanStoreRef = useKanbanStore;

const LazyCodexBuildChatTab = lazy(async () => {
  const module = await import("./CodexBuildChatTab");
  return { default: module.CodexBuildChatTab };
});

const LazyOpenCodeBuildChatTab = lazy(async () => {
  const module = await import("./OpenCodeBuildChatTab");
  return { default: module.OpenCodeBuildChatTab };
});

/** Convert task snapshot images to ClaudeAttachment array for sending with prompts.
 * Images are always stored as WebP on disk regardless of the original filename. */
function taskImagesToAttachments(images: TaskSnapshotImage[]): ClaudeAttachment[] | undefined {
  if (images.length === 0) return undefined;
  return images.map((img) => ({
    type: "image" as const,
    path: img.filename,
    dataUrl: `data:image/webp;base64,${img.data}`,
    filename: img.filename,
  }));
}

interface BuildChatTabProps {
  data: BuildTabData;
  isActive: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

const PHASE_LABELS: Record<BuildPhase, string> = {
  "creating-environment": "Creating Environment",
  "starting-environment": "Starting Environment",
  "waiting-for-setup": "Waiting for Setup",
  building: "Building",
  reviewing: "Reviewing",
  addressing: "Addressing Issues",
  verifying: "Verifying",
  fixing: "Fixing Issues",
  "creating-pr": "Creating PR",
  "resolving-conflicts": "Resolving Conflicts",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
};

const PHASE_COLORS: Record<BuildPhase, string> = {
  "creating-environment": "text-blue-400",
  "starting-environment": "text-blue-400",
  "waiting-for-setup": "text-yellow-400",
  building: "text-orange-400",
  reviewing: "text-amber-400",
  addressing: "text-amber-400",
  verifying: "text-purple-400",
  fixing: "text-red-400",
  "creating-pr": "text-cyan-400",
  "resolving-conflicts": "text-yellow-400",
  paused: "text-amber-400",
  complete: "text-green-400",
  failed: "text-red-500",
};

const SESSION_PHASE_LABELS: Record<string, string> = {
  build: "Build Session",
  review: "Review Session",
  verify: "Verification Session",
  fix: "Fix Session",
  pr: "PR Creation Session",
  "resolve-conflicts": "Conflict Resolution Session",
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

function AgentTabLoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-8 w-8 animate-spin" />
      <p className="text-sm">Loading {label} build runner...</p>
    </div>
  );
}

export function BuildChatTab({ data, isActive }: BuildChatTabProps) {
  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(data.pipelineId));
  const { config } = useConfigStore();
  const environmentDefaultAgent = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId)?.defaultAgent
  );

  const agentType = resolveActiveBuildPipelineAgent({
    pipelineAgent: pipeline?.agentType,
    environmentDefaultAgent,
    config,
    projectId: pipeline?.projectId ?? "",
  });

  if (agentType === "codex") {
    return (
      <Suspense fallback={<AgentTabLoadingState label="Codex" />}>
        <LazyCodexBuildChatTab data={data} isActive={isActive} />
      </Suspense>
    );
  }

  if (agentType === "opencode") {
    return (
      <Suspense fallback={<AgentTabLoadingState label="OpenCode" />}>
        <LazyOpenCodeBuildChatTab data={data} isActive={isActive} />
      </Suspense>
    );
  }

  return <ClaudeBuildChatTab data={data} isActive={isActive} />;
}

function ClaudeBuildChatTab({ data, isActive }: BuildChatTabProps) {
  const { environmentId, pipelineId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isInitializedRef = useRef(false);
  const pipelineAdvancingRef = useRef(false);
  const buildStartTriggeredRef = useRef(false);
  const [advanceTick, setAdvanceTick] = useState(0);
  const handledErrorIdsRef = useRef(new Set<string>());
  const [jumpInText, setJumpInText] = useState("");
  const jumpInTextareaRef = useRef<HTMLTextAreaElement>(null);

  const pipeline = useBuildPipelineStore((s) => s.pipelines.get(pipelineId));
  const { config } = useConfigStore();
  const {
    setPhase,
    addSession: addPipelineSession,
    markSessionIdle,
    markSessionRunning,
    setVerificationResult,
    incrementIteration,
    setPipelineError,
    pausePipeline,
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

  // Subscribe to setup script state from environment store
  // Used to gate build start until setup scripts have completed
  const setupScriptsRunning = useEnvironmentStore(
    (state) => state.setupScriptsRunning.has(environmentId)
  );
  const setupCommandsResolved = useEnvironmentStore(
    (state) => state.setupCommandsResolved.has(environmentId)
  );
  const hasPendingSetupCommands = useEnvironmentStore(
    (state) => state.pendingSetupCommands.has(environmentId)
  );
  // For container environments, workspace-setup.sh (which runs setupContainer scripts)
  // must complete before the build starts. workspaceReady is set when the terminal
  // shell prompt appears, which happens after workspace-setup.sh finishes.
  const workspaceReady = useEnvironmentStore(
    (state) => state.workspaceReadyEnvironments.has(environmentId)
  );

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

  const { isAtBottom, scrollToBottom } = useScrollLock(scrollRef, {
    scrollTrigger: allSessionMessages,
    mountTrigger: connectionState,
    isActive,
    persistKey: `build-${pipelineId}`,
  });

  // Auto-move kanban card and add automated comments when pipeline phase changes
  const prevPhaseRef = useRef<BuildPhase | null>(null);
  useEffect(() => {
    if (!pipeline) return;
    const { phase } = pipeline;
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    // Skip on first render or if phase hasn't changed
    if (prevPhase === null || prevPhase === phase) return;

    const { moveTask, addComment } = kanbanStoreRef.getState();

    if (phase === "building") {
      // Card sent to build → move to in-progress + comment
      void moveTask(pipeline.taskId, "in-progress");
      void addComment(pipeline.taskId, "🔨 Build started");
    } else if (phase === "complete") {
      // Build pipeline finished → move to review
      void moveTask(pipeline.taskId, "review");
    } else if (phase === "failed") {
      // Build failed → move back to backlog for retry
      void moveTask(pipeline.taskId, "backlog");
    }
  }, [pipeline?.phase, pipeline?.taskId]);

  // Initialize bridge server connection.
  // Gate on setup completion: container environments must wait for workspaceReady,
  // local environments must wait for setup scripts to finish.
  useEffect(() => {
    // Block initialization until setup scripts finish (local and container environments)
    if (isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady })) {
      return;
    }

    if (isInitializedRef.current || !pipeline) return;

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
          // Containerized environment - start the bridge server (same as ClaudeChatTab)
          const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
          const containerId = environment?.containerId;
          if (!containerId) {
            throw new Error("Container ID is required for containerized environments");
          }

          let status = await getClaudeServerStatus(containerId);
          if (!status.running) {
            const result = await startClaudeServer(containerId);
            status = { running: true, hostPort: result.hostPort };
          }
          if (!mounted) return;

          if (!status.hostPort) {
            throw new Error("Server started but no port available");
          }

          hostPort = status.hostPort;
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
  }, [environmentId, pipeline?.id, isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady]);

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

  // Check if a session ended with an error, avoiding re-handling of already-processed errors
  const checkSessionError = useCallback(
    (sessionState: { messages: ClaudeMessageType[] }, fallbackMessage: string): boolean => {
      const lastMessage = sessionState.messages.at(-1);
      if (
        lastMessage?.id.startsWith(ERROR_MESSAGE_PREFIX) &&
        !handledErrorIdsRef.current.has(lastMessage.id)
      ) {
        handledErrorIdsRef.current.add(lastMessage.id);
        const errorContent = lastMessage.content || fallbackMessage;
        setPipelineError(pipelineId, errorContent);
        return true;
      }
      return false;
    },
    [pipelineId, setPipelineError]
  );

  // Pipeline advancement logic - watches for session idle transitions
  // Skips when in "addressing" phase (handled by separate effect below)
  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase === "addressing") return; // Handled by separate effect
    if (pipeline.phase === "paused") return; // User has paused - don't auto-advance

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    if (checkSessionError(sessionState, "Session encountered an error")) return;

    // Session just went idle - advance the pipeline
    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;

      advancePipeline(pipeline, currentSession).finally(() => {
        pipelineAdvancingRef.current = false;
        // Force effect re-evaluation in case session.idle arrived while advancing
        setAdvanceTick((t) => t + 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.currentSessionIndex, pipeline?.sessions, pipeline?.phase, sessionsMap, connectionState, client, advanceTick, checkSessionError]);

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

          case "pr":
            // PR creation complete -> add comment and store PR on ticket, then check conflicts
            {
              // Get the PR URL from environment store (set by PR monitor after detection)
              const env = useEnvironmentStore.getState().getEnvironmentById(environmentId);
              const prUrl = env?.prUrl;
              if (prUrl) {
                void kanbanStoreRef.getState().addComment(
                  currentPipeline.taskId,
                  `🔗 PR raised: ${prUrl}`
                );
                // Store PR metadata on the ticket
                void kanbanStoreRef.getState().updateTask(currentPipeline.taskId, {
                  prUrl,
                  prState: "open",
                });
              } else {
                void kanbanStoreRef.getState().addComment(currentPipeline.taskId, "🔗 PR raised");
              }
              const hasConflicts = await checkPRMergeConflicts();
              if (hasConflicts) {
                await startResolveConflictsSession(currentPipeline);
              } else {
                setPhase(pipelineId, "complete");
              }
            }
            break;

          case "resolve-conflicts":
            // Conflict resolution complete -> verify conflicts are actually resolved
            {
              const stillConflicting = await checkPRMergeConflicts();
              if (stillConflicting) {
                setPipelineError(pipelineId, "Merge conflicts could not be fully resolved automatically");
              } else {
                setPhase(pipelineId, "complete");
              }
            }
            break;

          case "verify": {
            // Fetch fresh messages from the bridge to ensure we have the complete response
            // (the debounced SSE message fetch may not have completed yet)
            const freshMessages = await getSessionMessages(client, completedSession.sdkSessionId);
            if (freshMessages.length > 0) {
              setMessages(completedSession.sessionKey, freshMessages);
            }
            const verifyMessages = freshMessages.length > 0
              ? freshMessages
              : (useClaudeStore.getState().sessions.get(completedSession.sessionKey)?.messages ?? []);
            const result = parseVerificationResult(verifyMessages);

            // Replace raw JSON in the last assistant message with formatted content
            const formattedContent = result.verdict === "pass"
              ? `### Verification: Passed\n\n${result.feedback}`
              : `### Verification: Failed\n\n${result.feedback}`;
            const lastAssistantIdx = verifyMessages.findLastIndex((m) => m.role === "assistant");
            if (lastAssistantIdx >= 0) {
              const updatedMessages = verifyMessages.map((m, i) => {
                if (i !== lastAssistantIdx) return m;
                // Replace text parts with formatted content while preserving part order
                let replaced = false;
                const updatedParts = m.parts.reduce<typeof m.parts>((acc, p) => {
                  if (p.type !== "text") {
                    acc.push(p);
                  } else if (!replaced) {
                    acc.push({ type: "text" as const, content: formattedContent });
                    replaced = true;
                  }
                  // Drop subsequent text parts (merged into the first)
                  return acc;
                }, []);
                return {
                  ...m,
                  content: formattedContent,
                  parts: updatedParts,
                };
              });
              setMessages(completedSession.sessionKey, updatedMessages);
            }

            setVerificationResult(pipelineId, result.verdict, result.feedback);

            if (result.verdict === "pass") {
              void kanbanStoreRef.getState().addComment(currentPipeline.taskId, "✅ Validation complete");
              await startPRSession(currentPipeline);
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
    [client, pipelineId]
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
        content: "Please address all the above issues and test coverage gaps, without asking questions. Make sensible assumptions. Run typechecking and build validation to ensure the changes are valid as appropriate for the project.",
        parts: [{ type: "text", content: "Please address all the above issues and test coverage gaps, without asking questions. Make sensible assumptions. Run typechecking and build validation to ensure the changes are valid as appropriate for the project." }],
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

  // Handle session idle during paused state - mark idle but don't advance
  useEffect(() => {
    if (!pipeline || pipeline.phase !== "paused") return;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession || currentSession.status !== "running") return;
    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;
    markSessionIdle(pipelineId, currentSession.sdkSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.phase, pipeline?.currentSessionIndex, pipeline?.sessions, sessionsMap]);

  // Handle idle after "addressing" phase
  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase !== "addressing") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    if (checkSessionError(sessionState, "Session encountered an error during addressing")) return;

    // The addressing is done - start verification
    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;
      startVerifySession(pipeline).finally(() => {
        pipelineAdvancingRef.current = false;
        // Force effect re-evaluation in case session.idle arrived while advancing
        setAdvanceTick((t) => t + 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.phase, pipeline?.currentSessionIndex, pipeline?.sessions, sessionsMap, connectionState, client, advanceTick, checkSessionError]);

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
        isLoading: true,
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
    async (taskDescription: string, attachments?: ClaudeAttachment[]) => {
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

      const success = await sendPrompt(client, result.sdkSessionId, taskDescription, {
        permissionMode: "bypassPermissions",
        attachments,
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send build prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Start a review session (with ticket context and comprehensive review)
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

      // Use task snapshot stored on pipeline (kanban store may have been reloaded for a different project)
      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (e) { console.debug("Failed to load project notes for review:", e); }

      const repoConfig = config.repositories[currentPipeline.projectId];
      const targetBranch = repoConfig?.prBaseBranch || "main";
      const reviewPrompt = createBuildReviewPrompt(task, projectNotes, targetBranch);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: reviewPrompt,
        parts: [{ type: "text", content: reviewPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);

      const success = await sendPrompt(client, result.sdkSessionId, reviewPrompt, {
        permissionMode: "bypassPermissions",
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send review prompt");
      }
    },
    [client, pipelineId, config.repositories, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
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

      // Use task snapshot stored on pipeline (kanban store may have been reloaded for a different project)
      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (e) { console.debug("Failed to load project notes for verification:", e); }

      const repoConfig = config.repositories[currentPipeline.projectId];
      const targetBranch = repoConfig?.prBaseBranch || "main";
      const verifyPrompt = createVerificationPrompt(task, projectNotes, targetBranch);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: verifyPrompt,
        parts: [{ type: "text", content: verifyPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);

      const success = await sendPrompt(client, result.sdkSessionId, verifyPrompt, {
        permissionMode: "bypassPermissions",
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send verification prompt");
      }
    },
    [client, pipelineId, config.repositories, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
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

      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (e) { console.debug("Failed to load project notes for fix:", e); }

      const fixPrompt = createFixPrompt(task, projectNotes, feedback);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: fixPrompt,
        parts: [{ type: "text", content: fixPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);

      const success = await sendPrompt(client, result.sdkSessionId, fixPrompt, {
        permissionMode: "bypassPermissions",
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send fix prompt");
      }
    },
    [client, pipelineId, createPipelineSession, addMessage, setSessionLoading, setPhase, setPipelineError]
  );

  // Start PR creation session (auto-launched after verification passes)
  const startPRSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (!client) return;

      setPhase(pipelineId, "creating-pr");

      // Activate PR monitoring for faster detection
      const { setMonitoringMode, monitoredEnvironments } = usePrMonitorStore.getState();
      if (monitoredEnvironments[environmentId]) {
        setMonitoringMode(environmentId, "create-pending");
      }

      const result = await createPipelineSession("pr", currentPipeline.iteration, "PR Creation Session");
      if (!result) {
        setPipelineError(pipelineId, "Failed to create PR session");
        return;
      }

      const repoConfig = config.repositories[currentPipeline.projectId];
      const targetBranch = repoConfig?.prBaseBranch || "main";
      const prPrompt = createPRPrompt(targetBranch);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: prPrompt,
        parts: [{ type: "text", content: prPrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);

      const success = await sendPrompt(client, result.sdkSessionId, prPrompt, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send PR creation prompt");
      }
    },
    [client, pipelineId, environmentId, config.repositories, createPipelineSession, addMessage, setPhase, setPipelineError]
  );

  // Check if the PR has merge conflicts after creation
  const checkPRMergeConflicts = useCallback(
    async (): Promise<boolean> => {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (!environment) return false;

      const isLocal = environment.environmentType === "local";
      const containerId = environment.containerId ?? null;

      if (!isLocal && !containerId) {
        console.warn("[BuildChatTab] Container environment missing containerId, cannot check PR conflicts");
        return false;
      }

      const result = isLocal
        ? await backend.detectPrLocal(environmentId, environment.branch)
        : await backend.detectPr(containerId!, environment.branch);

      if (result) {
        // Update environment store with latest PR state
        useEnvironmentStore.getState().setEnvironmentPR(
          environmentId,
          result.url,
          result.state,
          result.hasMergeConflicts
        );
        return result.hasMergeConflicts;
      }

      return false;
    },
    [environmentId]
  );

  // Start merge conflict resolution session (auto-launched after PR creation detects conflicts)
  const startResolveConflictsSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (!client) return;

      setPhase(pipelineId, "resolving-conflicts");

      const result = await createPipelineSession("resolve-conflicts", currentPipeline.iteration, "Conflict Resolution Session");
      if (!result) {
        setPipelineError(pipelineId, "Failed to create conflict resolution session");
        return;
      }

      const repoConfig = config.repositories[currentPipeline.projectId];
      const targetBranch = repoConfig?.prBaseBranch || "main";
      const resolvePrompt = createResolveConflictsPrompt(targetBranch);

      const userMessage: ClaudeMessageType = {
        id: crypto.randomUUID(),
        role: "user",
        content: resolvePrompt,
        parts: [{ type: "text", content: resolvePrompt }],
        timestamp: new Date().toISOString(),
      };

      addMessage(result.sessionKey, userMessage);

      const success = await sendPrompt(client, result.sdkSessionId, resolvePrompt, {
        permissionMode: "bypassPermissions",
      });

      if (!success) {
        setPipelineError(pipelineId, "Failed to send conflict resolution prompt");
      }
    },
    [client, pipelineId, config.repositories, createPipelineSession, addMessage, setPhase, setPipelineError]
  );

  // Stop the pipeline - abort running sessions and pause for user intervention
  const handleStop = useCallback(async () => {
    if (!client || !pipeline) return;

    const abortPromises = pipeline.sessions.map(async (session) => {
      try {
        await abortSession(client, session.sdkSessionId);
        setSessionLoading(session.sessionKey, false);
      } catch {
        // Best effort - continue aborting remaining sessions
      }
    });
    await Promise.all(abortPromises);

    pausePipeline(pipelineId);
  }, [client, pipeline, pipelineId, setSessionLoading, pausePipeline]);

  // Retry
  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    isInitializedRef.current = false;
    setClient(environmentId, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [environmentId, setClient, setServerStatus]);

  // Send a user message to the current session while pipeline is paused
  const handleJumpInSend = useCallback(async (text: string) => {
    if (!client || !pipeline || pipeline.phase !== "paused" || !text.trim()) return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    // Mark session as running and set loading
    markSessionRunning(pipelineId, currentSession.sdkSessionId);
    setSessionLoading(currentSession.sessionKey, true);

    const userMessage: ClaudeMessageType = {
      id: crypto.randomUUID(),
      role: "user",
      content: text.trim(),
      parts: [{ type: "text", content: text.trim() }],
      timestamp: new Date().toISOString(),
    };
    addMessage(currentSession.sessionKey, userMessage);

    const success = await sendPrompt(client, currentSession.sdkSessionId, text.trim(), {
      permissionMode: "bypassPermissions",
    });

    if (!success) {
      setSessionLoading(currentSession.sessionKey, false);
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      const errMessage: ClaudeMessageType = {
        id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: "assistant",
        content: "Failed to send message to the agent",
        parts: [{ type: "text", content: "Failed to send message to the agent" }],
        timestamp: new Date().toISOString(),
      };
      addMessage(currentSession.sessionKey, errMessage);
    }
  }, [client, pipeline, pipelineId, markSessionRunning, markSessionIdle, setSessionLoading, addMessage]);

  // Resume pipeline from paused state by starting a review session
  const handleReviewAndContinue = useCallback(async () => {
    if (!pipeline || pipeline.phase !== "paused") return;
    await startReviewSession(pipeline);
  }, [pipeline, startReviewSession]);

  // When the bridge server is connected and environment is starting, transition to
  // waiting-for-setup. Both local and container environments must complete their setup
  // scripts (setupLocal / setupContainer in orkestrator-ai.json) before the build starts.
  useEffect(() => {
    if (connectionState !== "connected" || !client || !pipeline) return;
    if (pipeline.phase !== "starting-environment") return;
    if (pipeline.sessions.length > 0) return;

    setPhase(pipelineId, "waiting-for-setup");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, client, pipeline?.phase, pipeline?.sessions.length]);

  // Once in waiting-for-setup, start the build only after setup scripts have finished.
  //
  // Local environments: setupLocal commands are run in a frontend terminal tab.
  // We check three conditions to handle the race between setup command resolution and execution:
  //   1. setupCommandsResolved: we know what commands exist (if any)
  //   2. hasPendingSetupCommands: TerminalContainer hasn't consumed them yet
  //   3. setupScriptsRunning: setup tab is still executing commands
  //
  // Container environments: setupContainer commands are run inside the container by
  // workspace-setup.sh. The workspaceReady flag is set when the terminal shell prompt
  // appears, which happens only after workspace-setup.sh (including setupContainer) finishes.
  //
  // Guard: buildStartTriggeredRef prevents double-invocation from the fire-and-forget
  // getProjectNotes async chain. Without this, rapid re-fires of this effect could start
  // multiple build sessions.
  useEffect(() => {
    if (connectionState !== "connected" || !client || !pipeline) return;
    if (pipeline.phase !== "waiting-for-setup") {
      // Reset guard when phase transitions away, so a future re-entry works
      buildStartTriggeredRef.current = false;
      return;
    }
    if (pipeline.sessions.length > 0) return;
    if (buildStartTriggeredRef.current) return;

    if (isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady })) return;

    // Mark as triggered to prevent double-invocation from effect re-fires
    buildStartTriggeredRef.current = true;

    // Setup is complete (or there were no setup commands) — start the build
    const task = pipeline.taskSnapshot;

    getProjectNotes(pipeline.projectId).then((notes) => {
      // Re-verify setup state from current store before starting the build.
      // The reactive subscriptions may have been stale when the effect fired.
      const envStore = useEnvironmentStore.getState();
      const isLocalEnv = !!isLocal;
      if (isSetupPending({
        isLocal: isLocalEnv,
        setupCommandsResolved: envStore.setupCommandsResolved.has(environmentId),
        hasPendingSetupCommands: envStore.pendingSetupCommands.has(environmentId),
        setupScriptsRunning: envStore.setupScriptsRunning.has(environmentId),
        workspaceReady: envStore.workspaceReadyEnvironments.has(environmentId),
      })) {
        // Setup is not actually complete — reset guard and wait for next trigger
        buildStartTriggeredRef.current = false;
        return;
      }
      const prompt = createBuildPrompt(task, notes.content);
      startBuildSession(prompt, taskImagesToAttachments(task.images));
    }).catch(() => {
      // Re-verify setup state even on failure — same guard as the .then() path
      const envStore = useEnvironmentStore.getState();
      const isLocalEnv = !!isLocal;
      if (isSetupPending({
        isLocal: isLocalEnv,
        setupCommandsResolved: envStore.setupCommandsResolved.has(environmentId),
        hasPendingSetupCommands: envStore.pendingSetupCommands.has(environmentId),
        setupScriptsRunning: envStore.setupScriptsRunning.has(environmentId),
        workspaceReady: envStore.workspaceReadyEnvironments.has(environmentId),
      })) {
        buildStartTriggeredRef.current = false;
        return;
      }
      const prompt = createBuildPrompt(task, "");
      startBuildSession(prompt, taskImagesToAttachments(task.images));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, client, pipeline?.phase, pipeline?.sessions.length, isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady]);

  const setupPending = isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady });

  const isRunning = pipeline && !["complete", "failed", "paused"].includes(pipeline.phase);
  const isPaused = pipeline?.phase === "paused";

  // Auto-focus the jump-in textarea when entering paused state
  useEffect(() => {
    if (isPaused) {
      jumpInTextareaRef.current?.focus();
    }
  }, [isPaused]);

  // Check if the agent is processing a user's jump-in message
  const isJumpInLoading = useMemo(() => {
    if (!pipeline || pipeline.phase !== "paused") return false;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return false;
    const sessionState = sessionsMap.get(currentSession.sessionKey);
    return sessionState?.isLoading ?? false;
  }, [pipeline, sessionsMap]);

  const handleJumpInKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (jumpInText.trim() && !isJumpInLoading) {
        handleJumpInSend(jumpInText);
        setJumpInText("");
      }
    }
  }, [jumpInText, isJumpInLoading, handleJumpInSend]);

  // Abort a running jump-in message
  const handleJumpInStop = useCallback(async () => {
    if (!client || !pipeline) return;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;
    try {
      await abortSession(client, currentSession.sdkSessionId);
      setSessionLoading(currentSession.sessionKey, false);
    } catch {
      // Best effort
    }
  }, [client, pipeline, setSessionLoading]);

  // Show setup waiting UI when setup is pending (before connection is even attempted).
  // Covers all active phases defensively — if setup is somehow pending during "building"
  // or later phases, we still block until setup completes.
  if (setupPending && pipeline && !["complete", "failed", "paused"].includes(pipeline.phase)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
        <p className="text-sm">Waiting for setup scripts to complete...</p>
        <p className="text-xs">Build will start automatically once setup finishes</p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 text-xs text-muted-foreground"
          onClick={() => {
            const env = useEnvironmentStore.getState().getEnvironmentById(environmentId);
            const isLocalEnv = env?.environmentType === "local";
            if (isLocalEnv) {
              useEnvironmentStore.getState().setSetupScriptsRunning(environmentId, false);
              useEnvironmentStore.getState().setSetupCommandsResolved(environmentId, true);
              useEnvironmentStore.getState().consumePendingSetupCommands(environmentId);
            } else {
              useEnvironmentStore.getState().setWorkspaceReady(environmentId, true);
            }
          }}
        >
          Skip waiting
        </Button>
      </div>
    );
  }

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

  return (
    <div className="@container flex flex-col h-full bg-background overflow-hidden">
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
            {isPaused && (
              <Button
                variant="default"
                size="sm"
                onClick={handleReviewAndContinue}
                disabled={isJumpInLoading}
                className="h-6 px-3 gap-1.5 text-xs"
              >
                <PlayCircle className="w-3 h-3" />
                Review and continue
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
      <div ref={scrollRef} data-scroll-viewport="true" className="min-h-0 flex-1 overflow-y-auto">
        <div className="py-4 min-w-[320px]">
          {allSessionMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">Initializing build pipeline...</p>
            </div>
          ) : (
            allSessionMessages.map((sessionData, sessionIndex) => (
              <div key={sessionData.pipelineSession.sessionKey}>
                <SessionDivider session={sessionData.pipelineSession} index={sessionIndex} />
                {sessionData.messages
                  .filter((message, messageIndex) => {
                    // Hide the initial prompt (first user message) for review and PR sessions
                    const phase = sessionData.pipelineSession.phase;
                    if ((phase === "review" || phase === "pr") && messageIndex === 0 && message.role === "user") {
                      return false;
                    }
                    return true;
                  })
                  .map((message, filteredIndex, filteredMessages) => (
                    <NativeMessage
                      key={message.id}
                      message={normalizeClaudeMessage(message)}
                      previousMessage={
                        filteredIndex > 0
                          ? normalizeClaudeMessage(filteredMessages[filteredIndex - 1]!)
                          : null
                      }
                      assistantLabel="Claude"
                    />
                  ))}
                {sessionData.isLoading && (
                  <div className="px-2 @sm:px-4 py-3">
                    <div className="max-w-3xl mx-auto min-w-0">
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
      </div>

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

      {/* Jump-in compose bar when pipeline is paused */}
      {isPaused && (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              ref={jumpInTextareaRef}
              value={jumpInText}
              onChange={(e) => setJumpInText(e.target.value)}
              onKeyDown={handleJumpInKeyDown}
              placeholder="Send a message to the agent..."
              disabled={isJumpInLoading}
              rows={1}
              className={cn(
                "flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "min-h-[36px] max-h-[120px]",
                isJumpInLoading && "opacity-50 cursor-not-allowed"
              )}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
            {isJumpInLoading ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleJumpInStop}
                className="h-9 w-9 shrink-0"
              >
                <StopCircle className="w-4 h-4" />
              </Button>
            ) : (
              <Button
                variant="default"
                size="icon"
                onClick={() => {
                  if (jumpInText.trim()) {
                    handleJumpInSend(jumpInText);
                    setJumpInText("");
                  }
                }}
                disabled={!jumpInText.trim()}
                className="h-9 w-9 shrink-0"
              >
                <ArrowUp className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
