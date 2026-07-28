import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Hammer, Loader2, PlayCircle, RefreshCw, StopCircle } from "lucide-react";
import { useScrollLock } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { normalizeOpenCodeNativeMessage } from "@/lib/chat/native-message-adapters";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import type { BuildPhase, PipelineSession } from "@/stores/buildPipelineStore";
import {
  abortSession,
  buildOpenCodeMessageFromPart,
  carryOverOpenCodeSubagentHydration,
  createClient,
  createSession,
  getSessionMessages,
  getStructuredOutput,
  mergeOpenCodeMessageInfo,
  normalizeOpenCodePart,
  replyToPermission,
  rejectQuestion,
  sendPrompt,
  subscribeToEvents,
  ERROR_MESSAGE_PREFIX,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodeModel,
  type PromptAttachment,
} from "@/lib/opencode-client";
import { resolveGatewayLoopbackBaseUrl } from "@/lib/gateway-url";
import { createUuid } from "@/lib/uuid";
import type { BuildTabData } from "@/types/paneLayout";
import type { TaskSnapshotImage } from "@/prompts";
import {
  createAddressIssuesPrompt,
  createBuildPrompt,
  createBuildReviewPrompt,
  createFixPrompt,
  createPRPrompt,
  createResolveConflictsPrompt,
  createVerificationPrompt,
} from "@/prompts";
import { parseVerificationResult } from "@/lib/parse-verification-result";
import { isSetupPending } from "@/lib/setup-commands";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { extractContextUsage } from "@/lib/context-usage";
import { cn, createSessionKey } from "@/lib/utils";
import { createPipelineResumePrompt, getPipelineResumePhase, isSessionCompatibleWithResumePhase } from "@/lib/build-pipeline-resume";
import * as backend from "@/lib/backend";
import {
  addPipelineKanbanComment,
  updatePipelineKanbanPrMetadata,
} from "@/lib/build-pipeline-source";
import { GitHubCompletionCommentStatus } from "./GitHubCompletionCommentStatus";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import {
  readValidatedBuildReview,
  recoverExistingBuildReview,
  structuredReviewHasFindings,
} from "@/lib/build-pipeline-structured-review";
import { hideRawStructuredReviewMessages } from "@/lib/structured-review-messages";

interface OpenCodeBuildChatTabProps {
  data: BuildTabData;
  isActive: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

const EMPTY_MODELS: OpenCodeModel[] = [];

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
  paused: "text-yellow-400",
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

function getDisplayOpenCodeBuildMessages(
  messages: OpenCodeMessage[],
  phase: string,
) {
  const displayMessages = pinActiveNativeAgentParts(
    messages
      .filter((message, index) => {
        if ((phase === "review" || phase === "pr") && index === 0 && message.role === "user") {
          return false;
        }
        return true;
      })
      .map(normalizeOpenCodeNativeMessage),
  );
  return phase === "review"
    ? hideRawStructuredReviewMessages(displayMessages)
    : displayMessages;
}

function SessionDivider({ session, index }: { session: PipelineSession; index: number }) {
  const label = SESSION_PHASE_LABELS[session.phase] || session.phase;
  const iterationSuffix = session.iteration > 0 ? ` (Iteration ${session.iteration + 1})` : "";

  return (
    <div className="my-2 flex items-center gap-3 px-4 py-3">
      <Separator className="flex-1" />
      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
        {index > 0 ? `${label}${iterationSuffix}` : label}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

function taskImagesToAttachments(images: TaskSnapshotImage[]): PromptAttachment[] | undefined {
  if (images.length === 0) return undefined;
  return images.map((img) => ({
    type: "image" as const,
    path: img.filename,
    dataUrl: `data:image/webp;base64,${img.data}`,
    filename: img.filename,
  }));
}

function buildUserMessage(content: string): OpenCodeMessage {
  return {
    id: createUuid(),
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: new Date().toISOString(),
  };
}

function buildErrorMessage(content: string): OpenCodeMessage {
  return {
    id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: new Date().toISOString(),
  };
}

function extractEventSessionId(event: OpenCodeEvent): string | undefined {
  const props = event?.properties;
  return props?.sessionID
    || props?.sessionId
    || props?.part?.sessionID
    || props?.info?.sessionID
    || props?.info?.id
    || props?.message?.sessionID
    || (event as OpenCodeEvent & { sessionID?: string }).sessionID;
}

async function checkOpenCodeHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${resolveGatewayLoopbackBaseUrl(baseUrl)}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export function OpenCodeBuildChatTab({ data, isActive }: OpenCodeBuildChatTabProps) {
  const { environmentId, pipelineId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isInitializedRef = useRef(false);
  const pipelineAdvancingRef = useRef(false);
  const buildStartTriggeredRef = useRef(false);
  const [advanceTick, setAdvanceTick] = useState(0);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [jumpInText, setJumpInText] = useState("");
  const [isRetryingReview, setIsRetryingReview] = useState(false);
  const jumpInTextareaRef = useRef<HTMLTextAreaElement>(null);

  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(pipelineId));
  const config = useConfigStore((state) => state.config);
  const setPhase = useBuildPipelineStore((state) => state.setPhase);
  const addPipelineSession = useBuildPipelineStore((state) => state.addSession);
  const markSessionIdle = useBuildPipelineStore((state) => state.markSessionIdle);
  const markSessionRunning = useBuildPipelineStore((state) => state.markSessionRunning);
  const setVerificationResult = useBuildPipelineStore((state) => state.setVerificationResult);
  const beginStructuredReview = useBuildPipelineStore((state) => state.beginStructuredReview);
  const setStructuredReview = useBuildPipelineStore((state) => state.setStructuredReview);
  const incrementIteration = useBuildPipelineStore((state) => state.incrementIteration);
  const setPipelineError = useBuildPipelineStore((state) => state.setPipelineError);
  const pausePipeline = useBuildPipelineStore((state) => state.pausePipeline);
  const resumePipeline = useBuildPipelineStore((state) => state.resumePipeline);
  const isPipelinePaused = useCallback(
    () => useBuildPipelineStore.getState().pipelines.get(pipelineId)?.phase === "paused",
    [pipelineId],
  );
  // Narrow store subscriptions: actions are stable references, and the client
  // read is per-environment, so unrelated openCodeStore writes no longer
  // re-render the whole pipeline tab. `sessions` stays a map-level
  // subscription — the transcript view and idle-detection effects below need
  // to react to every pipeline session's messages.
  const setServerStatus = useOpenCodeStore((state) => state.setServerStatus);
  const setClient = useOpenCodeStore((state) => state.setClient);
  const setSession = useOpenCodeStore((state) => state.setSession);
  const addMessage = useOpenCodeStore((state) => state.addMessage);
  const setMessages = useOpenCodeStore((state) => state.setMessages);
  const upsertMessage = useOpenCodeStore((state) => state.upsertMessage);
  const setSessionLoading = useOpenCodeStore((state) => state.setSessionLoading);
  const setEventStream = useOpenCodeStore((state) => state.setEventStream);
  const setContextUsage = useOpenCodeStore((state) => state.setContextUsage);
  const getOrCreateEventSubscription = useOpenCodeStore(
    (state) => state.getOrCreateEventSubscription,
  );
  const hasActiveEventSubscription = useOpenCodeStore(
    (state) => state.hasActiveEventSubscription,
  );
  const sessionsMap = useOpenCodeStore((state) => state.sessions);
  const client = useOpenCodeStore(
    useCallback((state) => state.clients.get(environmentId), [environmentId]),
  );
  const models = useOpenCodeStore(
    useCallback(
      (state) => state.models.get(environmentId) ?? EMPTY_MODELS,
      [environmentId],
    ),
  );
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, models),
    [models],
  );

  const setupScriptsRunning = useEnvironmentStore((state) => state.setupScriptsRunning.has(environmentId));
  const setupCommandsResolved = useEnvironmentStore((state) => state.setupCommandsResolved.has(environmentId));
  const hasPendingSetupCommands = useEnvironmentStore((state) => state.pendingSetupCommands.has(environmentId));
  const workspaceReady = useEnvironmentStore((state) => state.workspaceReadyEnvironments.has(environmentId));

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

  const resolveOpenCodePreferences = useCallback(
    (projectId: string): { model: string | undefined; variant: string | undefined } => {
      const repoConfig = config.repositories[projectId];
      return {
        model: repoConfig?.defaultModel || config.global.opencodeModel,
        variant: repoConfig?.defaultEffort,
      };
    },
    [config.global.opencodeModel, config.repositories],
  );

  const initializeClient = useCallback(async () => {
    const cachedClient = useOpenCodeStore.getState().clients.get(environmentId);
    if (cachedClient) {
      return cachedClient;
    }

    let port: number | null = null;
    if (isLocal) {
      let status = await backend.getLocalOpencodeServerStatus(environmentId);
      if (!status.running) {
        const result = await backend.startLocalOpencodeServer(environmentId);
        status = { running: true, port: result.port, pid: result.pid };
      }
      port = status.port ?? null;
    } else {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      const containerId = environment?.containerId;
      if (!containerId) {
        throw new Error("Container ID is required for containerized OpenCode environments");
      }

      let status = await backend.getOpenCodeServerStatus(containerId);
      if (!status.running) {
        const result = await backend.startOpenCodeServer(containerId);
        status = { running: true, hostPort: result.hostPort };
      }
      port = status.hostPort ?? null;
    }

    if (!port) {
      throw new Error("Failed to resolve OpenCode server port");
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    if (!(await checkOpenCodeHealth(baseUrl))) {
      throw new Error("OpenCode server health check failed");
    }

    setServerStatus(environmentId, { running: true, hostPort: port });
    const nextClient = createClient(baseUrl);
    setClient(environmentId, nextClient);

    return nextClient;
  }, [environmentId, isLocal, setClient, setServerStatus]);

  const startSharedEventSubscription = useCallback(
    async (activeClient: ReturnType<typeof createClient>) => {
      if (hasActiveEventSubscription(environmentId)) return;

      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) return;
      const { abortController } = subscriptionState;

      try {
        const eventStream = await subscribeToEvents(activeClient);
        if (!eventStream) {
          throw new Error("Failed to subscribe to OpenCode events");
        }

        setEventStream(environmentId, eventStream);

        const lastReloadTimeBySession = new Map<string, number>();
        const pendingReloads = new Map<string, number>();
        const reloadGenerations = new Map<string, number>();
        const DEBOUNCE_MS = 200;

        // Final events (`immediate`) fetch the fully hydrated transcript,
        // subagents included — they are the authoritative reconcile point.
        // Streaming-triggered fallback refetches skip the recursive subagent
        // hydration for cost; already-hydrated Agent rows are carried over so
        // they do not blank until the final reconcile.
        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          const reloadKey = `${sessionId}:${sessionKey}`;
          const generation = (reloadGenerations.get(reloadKey) ?? 0) + 1;
          reloadGenerations.set(reloadKey, generation);
          const timeout = pendingReloads.get(reloadKey);
          if (timeout) {
            window.clearTimeout(timeout);
            pendingReloads.delete(reloadKey);
          }

          const includeSubagents = immediate;
          const doFetch = async () => {
            pendingReloads.delete(reloadKey);
            lastReloadTimeBySession.set(sessionId, Date.now());
            const messages = await getSessionMessages(activeClient, sessionId, {
              ...(includeSubagents ? {} : { includeSubagents: false }),
            });
            if (reloadGenerations.get(reloadKey) !== generation) return false;
            const currentSession = useOpenCodeStore.getState().sessions.get(sessionKey);
            if (currentSession?.sessionId !== sessionId) return false;
            setMessages(
              sessionKey,
              includeSubagents || !currentSession
                ? messages
                : carryOverOpenCodeSubagentHydration(
                    currentSession.messages,
                    messages,
                  ),
            );
            return true;
          };

          if (immediate) {
            return doFetch();
          }

          const now = Date.now();
          const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
          if (now - lastTime > DEBOUNCE_MS) {
            void doFetch();
          } else {
            const nextTimeout = window.setTimeout(() => {
              void doFetch();
            }, DEBOUNCE_MS);
            pendingReloads.set(reloadKey, nextTimeout);
          }
          return undefined;
        };

        /**
         * Sessions whose `message.part.updated` frames are currently applying
         * cleanly; while streaming via parts, `message.updated` and
         * `session.updated` frames carry nothing the parts don't, so the full
         * refetch is reserved for failures and final events.
         */
        const partStreamHealthyBySession = new Set<string>();

        const applyPartUpdate = (
          sessionKey: string,
          rawPart: unknown,
          delta?: string,
        ) => {
          const part = normalizeOpenCodePart(rawPart);
          if (!part?.sourceMessageId) {
            partStreamHealthyBySession.delete(sessionKey);
            return null;
          }
          const sessionState = useOpenCodeStore.getState().sessions.get(sessionKey);
          const existingMessage = sessionState?.messages.find(
            (message) => message.id === part.sourceMessageId,
          );
          upsertMessage(
            sessionKey,
            buildOpenCodeMessageFromPart(
              existingMessage,
              part.sourceMessageId,
              part,
              delta,
            ),
          );
          partStreamHealthyBySession.add(sessionKey);
          return part;
        };

        const applyMessageInfoUpdate = (
          sessionKey: string,
          rawInfo: unknown,
        ): boolean => {
          const sessionState = useOpenCodeStore.getState().sessions.get(sessionKey);
          const info = rawInfo as { id?: unknown } | null | undefined;
          const messageId = typeof info?.id === "string" ? info.id : undefined;
          const existingMessage = messageId
            ? sessionState?.messages.find((message) => message.id === messageId)
            : undefined;
          const merged = mergeOpenCodeMessageInfo(existingMessage, rawInfo);
          if (!merged) return false;
          upsertMessage(sessionKey, merged);
          return true;
        };

        for await (const event of eventStream) {
          if (abortController.signal.aborted) {
            for (const timeout of pendingReloads.values()) {
              window.clearTimeout(timeout);
            }
            break;
          }

          const eventType = event?.type;
          const eventSessionId = extractEventSessionId(event);
          const usageFromEvent = extractContextUsage(event);

          if (eventType === "permission.asked" && event.properties?.id) {
            // Build pipelines are intentionally unattended. When OpenCode offers a
            // persistent approval path, prefer it so the run does not stall on
            // repeated prompts for the same tool or pattern.
            await replyToPermission(
              activeClient,
              event.properties.id,
              Array.isArray(event.properties.always) && event.properties.always.length > 0 ? "always" : "once",
            );
          }

          if (eventType === "question.asked" && event.properties?.id) {
            const questionSummary = Array.isArray(event.properties.questions)
              ? event.properties.questions.map((question) => question.header || question.question).filter(Boolean).join(", ")
              : "OpenCode asked a question";
            await rejectQuestion(activeClient, event.properties.id);
            setPipelineError(pipelineId, `Pipeline blocked by OpenCode question: ${questionSummary}`, null);
          }

          if (!eventSessionId) {
            continue;
          }

          const sessions = useOpenCodeStore.getState().sessions;
          for (const [sessionKey, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;

            const props = event?.properties;
            const isFinalEvent =
              eventType === "session.idle"
              || (eventType === "session.status" && props?.status?.type === "idle");

            // Apply streamed parts and message metadata incrementally (same
            // shape as OpenCodeChatTab); a full-transcript refetch is reserved
            // for frames that cannot be applied and for the authoritative
            // final reconcile, instead of running at ~5Hz for every turn.
            if (isFinalEvent) {
              partStreamHealthyBySession.delete(sessionKey);
              try {
                const reconciled = await fetchMessagesDebounced(
                  eventSessionId,
                  sessionKey,
                  true,
                );
                if (reconciled) {
                  setSessionLoading(sessionKey, false);
                }
              } catch (error) {
                setPipelineError(
                  pipelineId,
                  error instanceof Error
                    ? `Failed to reconcile OpenCode transcript: ${error.message}`
                    : "Failed to reconcile OpenCode transcript",
                  null,
                );
              }
            } else if (eventType === "message.part.updated") {
              if (
                !applyPartUpdate(
                  sessionKey,
                  props?.part,
                  typeof props?.delta === "string" ? props.delta : undefined,
                )
              ) {
                fetchMessagesDebounced(eventSessionId, sessionKey, false);
              }
            } else if (eventType === "message.updated") {
              if (!applyMessageInfoUpdate(sessionKey, props?.info)) {
                fetchMessagesDebounced(eventSessionId, sessionKey, false);
              }
            } else if (eventType === "session.updated") {
              if (!partStreamHealthyBySession.has(sessionKey)) {
                fetchMessagesDebounced(eventSessionId, sessionKey, false);
              }
            }

            if (usageFromEvent) {
              setContextUsage(sessionKey, {
                ...usageFromEvent,
                modelId: usageFromEvent.modelId ?? undefined,
              });
            }

            if (eventType === "session.error") {
              const errorText =
                typeof props?.error === "string"
                  ? props.error
                  : "OpenCode session failed";
              addMessage(sessionKey, buildErrorMessage(errorText));
              setSessionLoading(sessionKey, false);
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[OpenCodeBuildChatTab] Event subscription error:", error);
          isInitializedRef.current = false;
          setConnectionState("error");
          setErrorMessage(error instanceof Error ? error.message : "Connection to OpenCode server was lost");
        }
      } finally {
        setEventStream(environmentId, null);
      }
    },
    [addMessage, environmentId, getOrCreateEventSubscription, hasActiveEventSubscription, pipelineId, setContextUsage, setEventStream, setMessages, upsertMessage, setPipelineError, setSessionLoading],
  );

  useEffect(() => {
    if (isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady })) {
      return;
    }

    if (isInitializedRef.current || !pipeline) return;

    let mounted = true;

    void initializeClient()
      .then((activeClient) => {
        if (!mounted) return;
        isInitializedRef.current = true;
        setConnectionState("connected");
        void startSharedEventSubscription(activeClient);
      })
      .catch((error) => {
        if (!mounted) return;
        setConnectionState("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to connect to OpenCode server");
      });

    return () => {
      mounted = false;
    };
  }, [
    hasPendingSetupCommands,
    initializeClient,
    isLocal,
    pipeline,
    setupCommandsResolved,
    setupScriptsRunning,
    startSharedEventSubscription,
    connectAttempt,
    workspaceReady,
  ]);

  const createPipelineSession = useCallback(
    async (
      phase: PipelineSession["phase"],
      iteration: number,
      label: string,
    ): Promise<{ sessionKey: string; sdkSessionId: string } | null> => {
      if (isPipelinePaused()) return null;
      try {
        const activeClient = client ?? await initializeClient();
        if (isPipelinePaused()) return null;

        const newSession = await createSession(activeClient);
        if (isPipelinePaused()) {
          try {
            await abortSession(activeClient, newSession.id);
          } catch {
            // Best effort; the session was never attached to the pipeline.
          }
          return null;
        }

        const tabIdForSession = `build-${phase}-${iteration}-${Date.now()}`;
        const sessionKey = createSessionKey(environmentId, tabIdForSession);

        setSession(sessionKey, {
          sessionId: newSession.id,
          messages: [],
          isLoading: true,
        });

        addPipelineSession(pipelineId, {
          phase,
          iteration,
          sessionKey,
          sdkSessionId: newSession.id,
          status: "running",
          startedAt: new Date().toISOString(),
          label,
        });

        return { sessionKey, sdkSessionId: newSession.id };
      } catch {
        return null;
      }
    },
    [addPipelineSession, client, environmentId, initializeClient, isPipelinePaused, pipelineId, setSession],
  );

  const sendPipelinePrompt = useCallback(
    async (
      sessionKey: string,
      sessionId: string,
      text: string,
      projectId: string,
      attachments?: PromptAttachment[],
      structured?: {
        outputSchema: Record<string, unknown>;
        requestId: string;
      },
    ): Promise<boolean> => {
      if (isPipelinePaused()) return false;
      const activeClient = client ?? await initializeClient();
      if (isPipelinePaused()) return false;
      const { model, variant } = resolveOpenCodePreferences(projectId);

      addMessage(sessionKey, buildUserMessage(text));
      setSessionLoading(sessionKey, true);

      const result = await sendPrompt(activeClient, sessionId, text, {
        model,
        variant,
        mode: "build",
        attachments,
        outputSchema: structured?.outputSchema,
        requestId: structured?.requestId,
      });

      if (!result.success) {
        addMessage(sessionKey, buildErrorMessage(result.error || "Failed to send prompt"));
        setSessionLoading(sessionKey, false);
      }

      return result.success;
    },
    [addMessage, client, initializeClient, isPipelinePaused, resolveOpenCodePreferences, setSessionLoading],
  );

  const startBuildSession = useCallback(
    async (taskDescription: string, projectId: string, attachments?: PromptAttachment[]) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "building");
      if (isPipelinePaused()) return;

      const result = await createPipelineSession("build", 0, "Build Session");
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create build session");
        return;
      }
      if (isPipelinePaused()) return;

      const success = await sendPipelinePrompt(result.sessionKey, result.sdkSessionId, taskDescription, projectId, attachments);
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send build prompt");
      }
    },
    [createPipelineSession, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const startReviewSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "reviewing");
      if (isPipelinePaused()) return;

      const iteration = currentPipeline.iteration;
      const result = await createPipelineSession("review", iteration, `Review Session${iteration > 0 ? ` (Iteration ${iteration + 1})` : ""}`);
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create review session");
        return;
      }
      if (isPipelinePaused()) return;

      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[OpenCodeBuildChatTab] Failed to load project notes for review:", error);
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createBuildReviewPrompt(
        currentPipeline.taskSnapshot,
        projectNotes,
        targetBranch,
        config.global.reviewInstruction,
      );
      const success = await sendPipelinePrompt(
        result.sessionKey,
        result.sdkSessionId,
        prompt,
        currentPipeline.projectId,
        taskImagesToAttachments(currentPipeline.taskSnapshot.images),
        (() => {
          const requestId = createUuid();
          beginStructuredReview(pipelineId, requestId);
          return {
            outputSchema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
            requestId,
          };
        })(),
      );
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send review prompt");
      }
    },
    [beginStructuredReview, config.global.reviewInstruction, config.repositories, createPipelineSession, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const startVerifySession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "verifying");
      if (isPipelinePaused()) return;

      const iteration = currentPipeline.iteration;
      const result = await createPipelineSession("verify", iteration, `Verification${iteration > 0 ? ` (Iteration ${iteration + 1})` : ""}`);
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create verification session");
        return;
      }
      if (isPipelinePaused()) return;

      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[OpenCodeBuildChatTab] Failed to load project notes for verification:", error);
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createVerificationPrompt(currentPipeline.taskSnapshot, projectNotes, targetBranch);
      const success = await sendPipelinePrompt(
        result.sessionKey,
        result.sdkSessionId,
        prompt,
        currentPipeline.projectId,
        taskImagesToAttachments(currentPipeline.taskSnapshot.images),
      );
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send verification prompt");
      }
    },
    [config.repositories, createPipelineSession, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const startFixSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, feedback: string) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "fixing");
      if (isPipelinePaused()) return;

      const iteration = currentPipeline.iteration + 1;
      const result = await createPipelineSession("fix", iteration, `Fix Session (Iteration ${iteration + 1})`);
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create fix session");
        return;
      }
      if (isPipelinePaused()) return;

      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[OpenCodeBuildChatTab] Failed to load project notes for fix:", error);
      }
      if (isPipelinePaused()) return;

      const prompt = createFixPrompt(currentPipeline.taskSnapshot, projectNotes, feedback);
      const success = await sendPipelinePrompt(
        result.sessionKey,
        result.sdkSessionId,
        prompt,
        currentPipeline.projectId,
        taskImagesToAttachments(currentPipeline.taskSnapshot.images),
      );
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send fix prompt");
      }
    },
    [createPipelineSession, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const startPRSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "creating-pr");
      if (isPipelinePaused()) return;

      const { setMonitoringMode, monitoredEnvironments } = usePrMonitorStore.getState();
      if (monitoredEnvironments[environmentId]) {
        setMonitoringMode(environmentId, "create-pending");
      }

      const result = await createPipelineSession("pr", currentPipeline.iteration, "PR Creation Session");
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create PR session");
        return;
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createPRPrompt(targetBranch);
      const success = await sendPipelinePrompt(result.sessionKey, result.sdkSessionId, prompt, currentPipeline.projectId);
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send PR creation prompt");
      }
    },
    [config.repositories, createPipelineSession, environmentId, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const checkPRMergeConflicts = useCallback(async (): Promise<boolean> => {
    const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
    if (!environment) return false;

    if (environment.environmentType === "local") {
      const result = await backend.detectPrLocal(environmentId, environment.branch);
      if (!result) return false;
      useEnvironmentStore.getState().setEnvironmentPR(environmentId, result.url, result.state, result.hasMergeConflicts);
      return result.hasMergeConflicts;
    }

    if (!environment.containerId) return false;
    const result = await backend.detectPr(environment.containerId, environment.branch);
    if (!result) return false;
    useEnvironmentStore.getState().setEnvironmentPR(environmentId, result.url, result.state, result.hasMergeConflicts);
    return result.hasMergeConflicts;
  }, [environmentId]);

  const startResolveConflictsSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "resolving-conflicts");
      if (isPipelinePaused()) return;

      const result = await createPipelineSession("resolve-conflicts", currentPipeline.iteration, "Conflict Resolution Session");
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create conflict resolution session");
        return;
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createResolveConflictsPrompt(targetBranch);
      const success = await sendPipelinePrompt(result.sessionKey, result.sdkSessionId, prompt, currentPipeline.projectId);
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send conflict resolution prompt");
      }
    },
    [config.repositories, createPipelineSession, isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const sendAddressIssuesMessage = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, reviewSession: PipelineSession) => {
      if (isPipelinePaused()) return;
      setPhase(pipelineId, "addressing");
      if (isPipelinePaused()) return;

      const updatedSessions = currentPipeline.sessions.map((session) =>
        session.sdkSessionId === reviewSession.sdkSessionId
          ? { ...session, status: "running" as const }
          : session,
      );
      useBuildPipelineStore.setState((state) => {
        const nextPipeline = state.pipelines.get(pipelineId);
        if (!nextPipeline) return state;
        const next = new Map(state.pipelines);
        next.set(pipelineId, { ...nextPipeline, sessions: updatedSessions, phase: "addressing" });
        return { pipelines: next };
      });

      if (!currentPipeline.structuredReview) {
        throw new Error("Cannot address review findings before structured validation.");
      }
      const prompt = createAddressIssuesPrompt(currentPipeline.structuredReview);
      const success = await sendPipelinePrompt(reviewSession.sessionKey, reviewSession.sdkSessionId, prompt, currentPipeline.projectId);
      if (!success) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to send address issues prompt");
      }
    },
    [isPipelinePaused, pipelineId, sendPipelinePrompt, setPhase, setPipelineError],
  );

  const advancePipeline = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, completedSession: PipelineSession) => {
      if (isPipelinePaused()) return;
      try {
        switch (completedSession.phase) {
          case "build":
            await startReviewSession(currentPipeline);
            break;
          case "review":
            {
              const activeClient = client ?? await initializeClient();
              const persisted = useBuildPipelineStore.getState().pipelines.get(pipelineId);
              const report = await readValidatedBuildReview(() =>
                getStructuredOutput(
                  activeClient,
                  completedSession.sdkSessionId,
                  persisted?.structuredReviewRequestId,
                )
              );
              setStructuredReview(pipelineId, report);
              if (structuredReviewHasFindings(report)) {
                await sendAddressIssuesMessage(
                  { ...currentPipeline, structuredReview: report },
                  completedSession,
                );
              } else {
                await startVerifySession({ ...currentPipeline, structuredReview: report });
              }
            }
            break;
          case "fix":
            await startReviewSession(currentPipeline);
            break;
          case "pr": {
            const env = useEnvironmentStore.getState().getEnvironmentById(environmentId);
            const prUrl = env?.prUrl;
            if (prUrl) {
              addPipelineKanbanComment(currentPipeline, `🔗 PR raised: ${prUrl}`);
              updatePipelineKanbanPrMetadata(currentPipeline, { prUrl, prState: "open" });
            } else {
              addPipelineKanbanComment(currentPipeline, "🔗 PR raised");
            }

            const hasConflicts = await checkPRMergeConflicts();
            if (isPipelinePaused()) return;
            if (hasConflicts) {
              await startResolveConflictsSession(currentPipeline);
            } else {
              setPhase(pipelineId, "complete");
            }
            break;
          }
          case "resolve-conflicts": {
            const stillConflicting = await checkPRMergeConflicts();
            if (isPipelinePaused()) return;
            if (stillConflicting) {
              setPipelineError(pipelineId, "Merge conflicts could not be fully resolved automatically");
            } else {
              setPhase(pipelineId, "complete");
            }
            break;
          }
          case "verify": {
            const activeClient = client ?? await initializeClient();
            const freshMessages = await getSessionMessages(activeClient, completedSession.sdkSessionId);
            if (isPipelinePaused()) return;
            if (freshMessages.length > 0) {
              setMessages(completedSession.sessionKey, freshMessages);
            }

            const verifyMessages: OpenCodeMessage[] = freshMessages.length > 0
              ? freshMessages
              : (useOpenCodeStore.getState().sessions.get(completedSession.sessionKey)?.messages ?? []);
            const result = parseVerificationResult(verifyMessages);

            const formattedContent = result.verdict === "pass"
              ? `### Verification: Passed\n\n${result.feedback}`
              : `### Verification: Failed\n\n${result.feedback}`;
            const lastAssistantIdx = verifyMessages.findLastIndex((message) => message.role === "assistant");
            if (lastAssistantIdx >= 0) {
              const updatedMessages = verifyMessages.map((message: OpenCodeMessage, index: number) => {
                if (index !== lastAssistantIdx) return message;
                let replaced = false;
                const updatedParts = message.parts.reduce<OpenCodeMessage["parts"]>((acc, part) => {
                  if (part.type !== "text") {
                    acc.push(part);
                  } else if (!replaced) {
                    acc.push({ type: "text" as const, content: formattedContent });
                    replaced = true;
                  }
                  return acc;
                }, []);
                return { ...message, content: formattedContent, parts: updatedParts };
              });
              setMessages(completedSession.sessionKey, updatedMessages);
            }

            if (isPipelinePaused()) return;
            setVerificationResult(pipelineId, result.verdict, result.feedback);
            if (result.verdict === "pass") {
              addPipelineKanbanComment(currentPipeline, "✅ Validation complete");
              await startPRSession(currentPipeline);
            } else if (currentPipeline.iteration >= currentPipeline.maxIterations) {
              setPipelineError(pipelineId, `Max iterations (${currentPipeline.maxIterations}) reached. Last feedback: ${result.feedback}`);
            } else {
              incrementIteration(pipelineId);
              await startFixSession(currentPipeline, result.feedback);
            }
            break;
          }
        }
      } catch (error) {
        if (isPipelinePaused()) return;
        console.error("[OpenCodeBuildChatTab] Pipeline advancement error:", error);
        setPipelineError(pipelineId, error instanceof Error ? error.message : "Pipeline error");
      }
    },
    [
      checkPRMergeConflicts,
      client,
      environmentId,
      incrementIteration,
      initializeClient,
      isPipelinePaused,
      pipelineId,
      setMessages,
      setPhase,
      setPipelineError,
      setVerificationResult,
      setStructuredReview,
      sendAddressIssuesMessage,
      startFixSession,
      startPRSession,
      startResolveConflictsSession,
      startReviewSession,
      startVerifySession,
    ],
  );

  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase === "addressing") return;
    if (pipeline.phase === "paused") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    const lastMessage = sessionState.messages.at(-1);
    if (lastMessage?.id.startsWith(ERROR_MESSAGE_PREFIX)) {
      setPipelineError(pipelineId, lastMessage.content || "OpenCode session failed");
      return;
    }

    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;
      advancePipeline(pipeline, currentSession).finally(() => {
        pipelineAdvancingRef.current = false;
        setAdvanceTick((value) => value + 1);
      });
    }
  }, [advancePipeline, advanceTick, client, connectionState, markSessionIdle, pipeline, pipelineId, sessionsMap, setPipelineError]);

  useEffect(() => {
    if (!pipeline || pipeline.phase !== "paused") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession || currentSession.status !== "running") return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    markSessionIdle(pipelineId, currentSession.sdkSessionId);
  }, [markSessionIdle, pipeline, pipelineId, sessionsMap]);

  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase !== "addressing") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;

    const lastMessage = sessionState.messages.at(-1);
    if (lastMessage?.id.startsWith(ERROR_MESSAGE_PREFIX)) {
      setPipelineError(pipelineId, lastMessage.content || "OpenCode session failed");
      return;
    }

    if (currentSession.status === "running") {
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pipelineAdvancingRef.current = true;
      startVerifySession(pipeline).finally(() => {
        pipelineAdvancingRef.current = false;
        setAdvanceTick((value) => value + 1);
      });
    }
  }, [advanceTick, client, connectionState, markSessionIdle, pipeline, pipelineId, sessionsMap, setPipelineError, startVerifySession]);

  useEffect(() => {
    if (connectionState !== "connected" || !client || !pipeline) return;
    if (pipeline.phase !== "starting-environment") return;
    if (pipeline.sessions.length > 0) return;
    setPhase(pipelineId, "waiting-for-setup");
  }, [client, connectionState, pipeline, pipelineId, setPhase]);

  useEffect(() => {
    if (connectionState !== "connected" || !client || !pipeline) return;
    if (pipeline.phase !== "waiting-for-setup") {
      buildStartTriggeredRef.current = false;
      return;
    }
    if (pipeline.sessions.length > 0) return;
    if (buildStartTriggeredRef.current) return;
    if (isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady })) return;

    buildStartTriggeredRef.current = true;

    const task = pipeline.taskSnapshot;
    backend.getProjectNotes(pipeline.projectId)
      .then((notes) => {
        const envStore = useEnvironmentStore.getState();
        if (isSetupPending({
          isLocal: !!isLocal,
          setupCommandsResolved: envStore.setupCommandsResolved.has(environmentId),
          hasPendingSetupCommands: envStore.pendingSetupCommands.has(environmentId),
          setupScriptsRunning: envStore.setupScriptsRunning.has(environmentId),
          workspaceReady: envStore.workspaceReadyEnvironments.has(environmentId),
        })) {
          buildStartTriggeredRef.current = false;
          return;
        }
        void startBuildSession(
          createBuildPrompt(task, notes.content),
          pipeline.projectId,
          taskImagesToAttachments(task.images),
        );
      })
      .catch(() => {
        const envStore = useEnvironmentStore.getState();
        if (isSetupPending({
          isLocal: !!isLocal,
          setupCommandsResolved: envStore.setupCommandsResolved.has(environmentId),
          hasPendingSetupCommands: envStore.pendingSetupCommands.has(environmentId),
          setupScriptsRunning: envStore.setupScriptsRunning.has(environmentId),
          workspaceReady: envStore.workspaceReadyEnvironments.has(environmentId),
        })) {
          buildStartTriggeredRef.current = false;
          return;
        }
        void startBuildSession(
          createBuildPrompt(task, ""),
          pipeline.projectId,
          taskImagesToAttachments(task.images),
        );
      });
  }, [
    client,
    connectionState,
    environmentId,
    hasPendingSetupCommands,
    isLocal,
    pipeline,
    setupCommandsResolved,
    setupScriptsRunning,
    startBuildSession,
    workspaceReady,
  ]);

  const handleStop = useCallback(async () => {
    if (!pipeline) return;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    pausePipeline(pipelineId);
    if (!client || !currentSession) return;

    setSessionLoading(currentSession.sessionKey, false);
    try {
      await abortSession(client, currentSession.sdkSessionId);
    } catch {
      // Best effort only; the pause lock is already active.
    }
  }, [client, pausePipeline, pipeline, pipelineId, setSessionLoading]);

  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    isInitializedRef.current = false;
    setClient(environmentId, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
    setConnectAttempt((attempt) => attempt + 1);
  }, [environmentId, setClient, setServerStatus]);

  const handleJumpInSend = useCallback(async (text: string) => {
    if (!client || !pipeline || pipeline.phase !== "paused" || !text.trim()) return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    markSessionRunning(pipelineId, currentSession.sdkSessionId);
    setSessionLoading(currentSession.sessionKey, true);
    addMessage(currentSession.sessionKey, buildUserMessage(text.trim()));

    const { model, variant } = resolveOpenCodePreferences(pipeline.projectId);
    const result = await sendPrompt(client, currentSession.sdkSessionId, text.trim(), {
      model,
      variant,
      mode: "build",
    });

    if (!result.success) {
      addMessage(currentSession.sessionKey, buildErrorMessage(result.error || "Failed to send message to the agent"));
      setSessionLoading(currentSession.sessionKey, false);
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
    }
  }, [addMessage, client, markSessionIdle, markSessionRunning, pipeline, pipelineId, resolveOpenCodePreferences, setSessionLoading]);

  const handleResume = useCallback(async () => {
    if (!pipeline || pipeline.phase !== "paused") return;
    const resumePhase = getPipelineResumePhase(pipeline);
    if (!resumePhase) return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    const resumedPhase = resumePipeline(pipelineId, resumePhase);
    if (!resumedPhase) return;

    if (resumedPhase === "reviewing") {
      await startReviewSession(pipeline);
      return;
    }

    const prompt = createPipelineResumePrompt(resumedPhase);
    if (!prompt) {
      setAdvanceTick((value) => value + 1);
      return;
    }

    if (!isSessionCompatibleWithResumePhase(currentSession, resumedPhase)) {
      switch (resumedPhase) {
        case "building": {
          const task = pipeline.taskSnapshot;
          try {
            const notes = await backend.getProjectNotes(pipeline.projectId);
            await startBuildSession(createBuildPrompt(task, notes.content), pipeline.projectId, taskImagesToAttachments(task.images));
          } catch {
            await startBuildSession(createBuildPrompt(task, ""), pipeline.projectId, taskImagesToAttachments(task.images));
          }
          break;
        }
        case "addressing":
          await startReviewSession(pipeline);
          break;
        case "verifying":
          await startVerifySession(pipeline);
          break;
        case "fixing":
          await startFixSession(pipeline, pipeline.verificationFeedback ?? "Resume fixing the latest verification failures.");
          break;
        case "creating-pr":
          await startPRSession(pipeline);
          break;
        case "resolving-conflicts":
          await startResolveConflictsSession(pipeline);
          break;
        case "creating-environment":
        case "starting-environment":
        case "waiting-for-setup":
          setAdvanceTick((value) => value + 1);
          break;
      }
      return;
    }

    if (!currentSession) return;

    if (!client) {
      pausePipeline(pipelineId);
      return;
    }

    markSessionRunning(pipelineId, currentSession.sdkSessionId);
    setSessionLoading(currentSession.sessionKey, true);
    addMessage(currentSession.sessionKey, buildUserMessage(prompt));

    const { model, variant } = resolveOpenCodePreferences(pipeline.projectId);
    const result = await sendPrompt(client, currentSession.sdkSessionId, prompt, {
      model,
      variant,
      mode: "build",
    });

    if (!result.success) {
      addMessage(currentSession.sessionKey, buildErrorMessage(result.error || "Failed to resume build pipeline"));
      setSessionLoading(currentSession.sessionKey, false);
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pausePipeline(pipelineId);
    }
  }, [
    addMessage,
    client,
    markSessionIdle,
    markSessionRunning,
    pausePipeline,
    pipeline,
    pipelineId,
    resolveOpenCodePreferences,
    resumePipeline,
    startBuildSession,
    startFixSession,
    startPRSession,
    startResolveConflictsSession,
    startReviewSession,
    startVerifySession,
    setSessionLoading,
  ]);

  const handleRetryReview = useCallback(async () => {
    const currentPipeline =
      useBuildPipelineStore.getState().pipelines.get(pipelineId);
    if (
      !currentPipeline
      || currentPipeline.phase !== "failed"
      || currentPipeline.failureContext?.phase !== "reviewing"
    ) {
      return;
    }

    setIsRetryingReview(true);
    try {
      // Only the read is guarded. Everything after a successful recovery has
      // already moved the phase and may have dispatched a prompt, so treating a
      // failure there as "recovery failed" would start a second review on top.
      const recovered = await recoverExistingBuildReview(
        currentPipeline,
        async (sessionId, requestId) =>
          getStructuredOutput(
            client ?? await initializeClient(),
            sessionId,
            requestId,
          ),
        "[OpenCodeBuildChatTab]",
      );
      if (recovered) {
        setStructuredReview(pipelineId, recovered.report);
        const recoveredPipeline = {
          ...currentPipeline,
          structuredReview: recovered.report,
        };
        if (structuredReviewHasFindings(recovered.report)) {
          await sendAddressIssuesMessage(recoveredPipeline, recovered.session);
        } else {
          await startVerifySession(recoveredPipeline);
        }
        return;
      }
      await startReviewSession(currentPipeline);
    } finally {
      setIsRetryingReview(false);
    }
  }, [
    client,
    initializeClient,
    pipelineId,
    sendAddressIssuesMessage,
    setStructuredReview,
    startReviewSession,
    startVerifySession,
  ]);

  const setupPending = isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady });

  const isRunning = pipeline && !["complete", "failed", "paused"].includes(pipeline.phase);
  const isPaused = pipeline?.phase === "paused";
  const isEventStreamDisconnected =
    connectionState === "connected" &&
    Boolean(isRunning) &&
    !hasActiveEventSubscription(environmentId);

  useEffect(() => {
    if (isPaused) {
      jumpInTextareaRef.current?.focus();
    }
  }, [isPaused]);

  const isJumpInLoading = useMemo(() => {
    if (!pipeline || pipeline.phase !== "paused") return false;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return false;
    return sessionsMap.get(currentSession.sessionKey)?.isLoading ?? false;
  }, [pipeline, sessionsMap]);

  const handleJumpInKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (jumpInText.trim() && !isJumpInLoading) {
        void handleJumpInSend(jumpInText);
        setJumpInText("");
      }
    }
  }, [handleJumpInSend, isJumpInLoading, jumpInText]);

  const handleJumpInStop = useCallback(async () => {
    if (!client || !pipeline) return;
    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    try {
      await abortSession(client, currentSession.sdkSessionId);
      setSessionLoading(currentSession.sessionKey, false);
    } catch {
      // Best effort only.
    }
  }, [client, pipeline, setSessionLoading]);

  // Stop control overlaid on the Connection Failed screen so a user can halt a
  // still-running backend pipeline. Reconnect is intentionally omitted here —
  // the centered "Reconnect now" button already covers it.
  const disconnectedActions = isRunning ? (
    <div className="absolute right-4 top-2 z-10 flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={handleStop} className="h-6 gap-1 px-2 text-xs">
        <StopCircle className="h-3 w-3" />
        Stop
      </Button>
    </div>
  ) : null;

  if (setupPending && pipeline && !["complete", "failed", "paused"].includes(pipeline.phase)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-yellow-400" />
        <p className="text-sm">Waiting for setup scripts to complete...</p>
        <p className="text-xs">Build will start automatically once setup finishes</p>
      </div>
    );
  }

  if (connectionState === "connecting") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Connecting to OpenCode server...</p>
        <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          <span>Reconnect now</span>
        </Button>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-4 p-4 text-muted-foreground">
        {disconnectedActions}
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="mt-1 text-xs">{errorMessage || "Unable to connect to OpenCode server"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          <span>Reconnect now</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="@container flex h-full flex-col overflow-hidden bg-background">
      {pipeline && (
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2">
            <Hammer className="h-4 w-4 text-muted-foreground" />
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
            {isEventStreamDisconnected && (
              <Button variant="outline" size="sm" onClick={handleRetry} className="h-6 gap-1 px-2 text-xs">
                <RefreshCw className="h-3 w-3" />
                Reconnect
              </Button>
            )}
            {isRunning && (
              <Button variant="ghost" size="sm" onClick={handleStop} className="h-6 gap-1 px-2 text-xs">
                <StopCircle className="h-3 w-3" />
                Stop
              </Button>
            )}
            {isPaused && (
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  void handleResume();
                }}
                disabled={isJumpInLoading}
                className="h-6 gap-1.5 px-3 text-xs"
              >
                <PlayCircle className="h-3 w-3" />
                Resume
              </Button>
            )}
            {pipeline.phase === "complete" && (
              <span className="text-xs font-medium text-green-400">All acceptance criteria satisfied</span>
            )}
            {pipeline.phase === "failed" && (
              <>
                <span className="max-w-[300px] truncate text-xs font-medium text-red-400">{pipeline.error}</span>
                {pipeline.failureContext?.phase === "reviewing" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void handleRetryReview();
                    }}
                    disabled={isRetryingReview}
                    className="h-6 gap-1.5 px-2.5 text-xs"
                  >
                    <RefreshCw className={cn("h-3 w-3", isRetryingReview && "animate-spin")} />
                    {isRetryingReview ? "Retrying..." : "Retry Review"}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {pipeline && <GitHubCompletionCommentStatus pipeline={pipeline} />}

      <div ref={scrollRef} data-scroll-viewport="true" className="min-h-0 flex-1 overflow-y-auto">
        <div className="min-w-[320px] py-4">
          {allSessionMessages.length === 0 ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Initializing build pipeline...</p>
            </div>
          ) : (
            allSessionMessages.map((sessionData, sessionIndex) => (
              <div key={sessionData.pipelineSession.sessionKey}>
                <SessionDivider session={sessionData.pipelineSession} index={sessionIndex} />
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-2 py-5 @sm:px-4">
                  {getDisplayOpenCodeBuildMessages(
                    sessionData.messages,
                    sessionData.pipelineSession.phase,
                  ).map((message, index, filteredMessages) => (
                      <NativeMessage
                        key={message.id}
                        message={message}
                        previousMessage={
                          index > 0
                            ? filteredMessages[index - 1]!
                            : null
                        }
                        assistantLabel="OpenCode"
                        resolveModelLabel={resolveModelLabel}
                      />
                    ))}
                  {sessionData.isLoading && (
                    <div className="px-2 py-3 @sm:px-4">
                      <div className="mx-auto max-w-3xl min-w-0">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="text-xs">OpenCode is working...</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {pipeline?.structuredReview && (
            <div className="mx-auto w-full max-w-5xl px-4 py-4">
              <StructuredReviewReportView report={pipeline.structuredReview} />
            </div>
          )}
        </div>
      </div>

      {!isAtBottom && (
        <div className="flex justify-end px-4 py-1">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>Scroll down</span>
          </button>
        </div>
      )}

      {isPaused && (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref={jumpInTextareaRef}
              value={jumpInText}
              onChange={(event) => setJumpInText(event.target.value)}
              onKeyDown={handleJumpInKeyDown}
              placeholder="Send a message to the agent..."
              disabled={isJumpInLoading}
              rows={1}
              className={cn(
                "min-h-[36px] max-h-[120px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isJumpInLoading && "cursor-not-allowed opacity-50",
              )}
              onInput={(event) => {
                const target = event.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
            {isJumpInLoading ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  void handleJumpInStop();
                }}
                className="h-9 w-9 shrink-0"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="default"
                size="icon"
                onClick={() => {
                  if (jumpInText.trim()) {
                    void handleJumpInSend(jumpInText);
                    setJumpInText("");
                  }
                }}
                disabled={!jumpInText.trim()}
                className="h-9 w-9 shrink-0"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
