import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Hammer, Loader2, PlayCircle, RefreshCw, StopCircle } from "lucide-react";
import { useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { normalizeCodexNativeMessage } from "@/lib/chat/native-message-adapters";
import { createUuid } from "@/lib/uuid";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore, useCodexStore, useEnvironmentStore } from "@/stores";
import type { BuildPhase, PipelineSession } from "@/stores/buildPipelineStore";
import {
  abortSession,
  checkHealth,
  createClient,
  createSession,
  getSessionMessages,
  getSessionStatus,
  sendPrompt,
  type CodexClient,
  type CodexMessage,
  type CodexPromptAttachment,
  type CodexReasoningEffort,
} from "@/lib/codex-client";
import { createCodexSessionKey } from "@/stores/codexStore";
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
import { cn } from "@/lib/utils";
import { createPipelineResumePrompt, getPipelineResumePhase, isSessionCompatibleWithResumePhase } from "@/lib/build-pipeline-resume";
import * as backend from "@/lib/backend";
import {
  addPipelineKanbanComment,
  updatePipelineKanbanPrMetadata,
} from "@/lib/build-pipeline-source";

interface CodexBuildChatTabProps {
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

function taskImagesToAttachments(images: TaskSnapshotImage[]): CodexPromptAttachment[] | undefined {
  if (images.length === 0) return undefined;
  return images.map((img) => ({
    type: "image" as const,
    path: img.filename,
    dataUrl: `data:image/webp;base64,${img.data}`,
    filename: img.filename,
  }));
}

function buildUserMessage(content: string): CodexMessage {
  return {
    id: createUuid(),
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: new Date().toISOString(),
  };
}

function buildErrorMessage(content: string): CodexMessage {
  return {
    id: `error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: new Date().toISOString(),
  };
}

function codexMessagesEqual(a: CodexMessage[], b: CodexMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  return a.every((message, index) => {
    const other = b[index];
    if (!other) return false;

    return (
      message.id === other.id
      && message.role === other.role
      && message.content === other.content
      && JSON.stringify(message.parts) === JSON.stringify(other.parts)
    );
  });
}

function appendCodexMessage(sessionKey: string, message: CodexMessage) {
  useCodexStore.setState((state) => {
    const session = state.sessions.get(sessionKey);
    if (!session) return state;
    const next = new Map(state.sessions);
    next.set(sessionKey, {
      ...session,
      messages: [...session.messages, message],
    });
    return { sessions: next };
  });
}

function isCodexBuildDebugEnabled() {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem("ORK_CODEX_DEBUG") === "1";
  } catch {
    return false;
  }
}

// Accepts a thunk so the (potentially expensive) details payload is only built
// when debug logging is enabled — avoids running summarize* over message parts
// on every render of every row when ORK_CODEX_DEBUG is unset.
function debugCodexBuild(event: string, getDetails: () => Record<string, unknown>) {
  if (!isCodexBuildDebugEnabled()) return;
  console.info(`[CodexBuildChatTab][debug] ${event}`, getDetails());
}

function summarizeCodexMessage(message: CodexMessage | undefined) {
  if (!message) return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];

  return {
    id: message.id,
    role: message.role,
    contentLength: message.content?.length ?? 0,
    contentPreview: message.content?.slice(0, 160),
    partCount: parts.length,
    partTypes: parts.map((part) => part?.type ?? typeof part).slice(0, 12),
  };
}

function summarizeNativeMessage(message: ReturnType<typeof normalizeCodexNativeMessage>) {
  const parts = Array.isArray(message.parts) ? message.parts : [];

  return {
    id: message.id,
    role: message.role,
    contentLength: message.content?.length ?? 0,
    contentPreview: message.content?.slice(0, 160),
    partCount: parts.length,
    partTypes: parts.map((part) => part?.type ?? typeof part).slice(0, 12),
  };
}

function LoggedNativeMessage({
  message,
  previousMessage,
  sessionKey,
  sessionPhase,
  messageIndex,
}: {
  message: CodexMessage;
  previousMessage: CodexMessage | null;
  sessionKey: string;
  sessionPhase: string;
  messageIndex: number;
}) {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const normalizedMessage = useMemo(
    () => normalizeCodexNativeMessage(message),
    [message],
  );
  const normalizedPreviousMessage = useMemo(
    () => previousMessage ? normalizeCodexNativeMessage(previousMessage) : null,
    [previousMessage],
  );

  debugCodexBuild("NativeMessage render", () => ({
    sessionKey,
    sessionPhase,
    messageIndex,
    renderCount: renderCountRef.current,
    raw: summarizeCodexMessage(message),
    normalized: summarizeNativeMessage(normalizedMessage),
    previous: summarizeCodexMessage(previousMessage ?? undefined),
  }));

  useEffect(() => {
    debugCodexBuild("NativeMessage committed", () => ({
      sessionKey,
      sessionPhase,
      messageIndex,
      messageId: message.id,
      normalized: summarizeNativeMessage(normalizedMessage),
    }));

    return () => {
      debugCodexBuild("NativeMessage unmounted", () => ({
        sessionKey,
        sessionPhase,
        messageIndex,
        messageId: message.id,
      }));
    };
  }, [message.id, messageIndex, normalizedMessage, sessionKey, sessionPhase]);

  return (
    <NativeMessage
      message={normalizedMessage}
      previousMessage={normalizedPreviousMessage}
      assistantLabel="Codex"
    />
  );
}

/**
 * A single row in the virtualized build transcript. Sessions are flattened into
 * a divider row followed by their message rows (and an optional loading row) so
 * the whole pipeline renders through one Virtuoso list, matching the native tab.
 */
type BuildRow =
  | { kind: "divider"; key: string; session: PipelineSession; sessionIndex: number }
  | {
      kind: "message";
      key: string;
      message: CodexMessage;
      previousMessage: CodexMessage | null;
      sessionKey: string;
      sessionPhase: string;
      messageIndex: number;
    }
  | { kind: "loading"; key: string };

export function CodexBuildChatTab({ data, isActive }: CodexBuildChatTabProps) {
  const { environmentId, pipelineId, isLocal } = data;
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isInitializedRef = useRef(false);
  const pipelineAdvancingRef = useRef(false);
  const buildStartTriggeredRef = useRef(false);
  const [advanceTick, setAdvanceTick] = useState(0);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const pollingSessionIdRef = useRef<string | null>(null);
  const pendingPromptDispatchesRef = useRef<Set<string>>(new Set());
  const [jumpInText, setJumpInText] = useState("");
  const jumpInTextareaRef = useRef<HTMLTextAreaElement>(null);

  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(pipelineId));
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
    resumePipeline,
  } = useBuildPipelineStore();
  const isPipelinePaused = useCallback(
    () => useBuildPipelineStore.getState().pipelines.get(pipelineId)?.phase === "paused",
    [pipelineId],
  );
  const {
    setServerStatus,
    setClient,
    setSession,
    setMessages,
    setSessionLoading,
    setSessionError,
    setSessionTitle,
    clients: clientsMap,
    sessions: sessionsMap,
  } = useCodexStore();
  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);

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

  useEffect(() => {
    if (!pipeline) return;

    debugCodexBuild("message snapshot committed", () => ({
      pipelineId,
      environmentId,
      phase: pipeline.phase,
      currentSessionIndex: pipeline.currentSessionIndex,
      sessions: allSessionMessages.map((sessionData, index) => ({
        index,
        sessionKey: sessionData.pipelineSession.sessionKey,
        sdkSessionId: sessionData.pipelineSession.sdkSessionId,
        phase: sessionData.pipelineSession.phase,
        status: sessionData.pipelineSession.status,
        isLoading: sessionData.isLoading,
        messageCount: sessionData.messages.length,
        lastMessage: summarizeCodexMessage(sessionData.messages[sessionData.messages.length - 1]),
      })),
    }));
  }, [allSessionMessages, environmentId, pipeline, pipelineId]);

  const currentPipelineSession = pipeline?.sessions[pipeline.currentSessionIndex];
  const currentSessionKey = currentPipelineSession?.sessionKey;
  const currentSdkSessionId = currentPipelineSession?.sdkSessionId;
  const currentSessionIsLoading = useCodexStore((state) =>
    currentSessionKey ? state.sessions.get(currentSessionKey)?.isLoading : undefined
  );

  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive,
    persistKey: `build-${pipelineId}`,
    environmentId,
    stickToBottomOnActivation: true,
  });

  // Flatten sessions into a single ordered list of rows (divider → messages →
  // optional loading) so the entire pipeline transcript renders through one
  // Virtuoso list, exactly like the native Codex tab. previousMessage is
  // precomputed per session so continuation/lead-in spacing never bridges a
  // divider into the prior session.
  const messageRows = useMemo<BuildRow[]>(() => {
    const rows: BuildRow[] = [];
    allSessionMessages.forEach((sessionData, sessionIndex) => {
      const { pipelineSession } = sessionData;
      rows.push({
        kind: "divider",
        key: `divider-${pipelineSession.sessionKey}`,
        session: pipelineSession,
        sessionIndex,
      });

      const phase = pipelineSession.phase;
      const filtered = sessionData.messages.filter((message, index) => {
        if ((phase === "review" || phase === "pr") && index === 0 && message.role === "user") {
          return false;
        }
        return true;
      });

      const displayMessages = filtered.map(normalizeCodexNativeMessage);

      displayMessages.forEach((message, index) => {
        rows.push({
          kind: "message",
          key: `${pipelineSession.sessionKey}-${message.id}`,
          message,
          previousMessage: index > 0 ? displayMessages[index - 1]! : null,
          sessionKey: pipelineSession.sessionKey,
          sessionPhase: pipelineSession.phase,
          messageIndex: index,
        });
      });

      if (sessionData.isLoading) {
        rows.push({ kind: "loading", key: `loading-${pipelineSession.sessionKey}` });
      }
    });
    return rows;
  }, [allSessionMessages]);

  const renderBuildRow = useCallback((row: BuildRow): ReactNode => {
    if (row.kind === "divider") {
      return <SessionDivider session={row.session} index={row.sessionIndex} />;
    }
    if (row.kind === "loading") {
      return (
        <div className="px-2 @sm:px-4 py-3">
          <div className="mx-auto max-w-3xl min-w-0">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Codex is working...</span>
            </div>
          </div>
        </div>
      );
    }
    return (
      <LoggedNativeMessage
        message={row.message}
        previousMessage={row.previousMessage}
        sessionKey={row.sessionKey}
        sessionPhase={row.sessionPhase}
        messageIndex={row.messageIndex}
      />
    );
  }, []);

  const resolveCodexPreferences = useCallback(
    (projectId: string): { model: string; effort: CodexReasoningEffort } => {
      const repoConfig = config.repositories[projectId];
      return {
        model: repoConfig?.defaultModel || config.global.codexModel,
        effort: (repoConfig?.defaultEffort || config.global.codexReasoningEffort || "medium") as CodexReasoningEffort,
      };
    },
    [config.global.codexModel, config.global.codexReasoningEffort, config.repositories],
  );

  const initializeClient = useCallback(async (): Promise<CodexClient> => {
    const cachedClient = useCodexStore.getState().clients.get(environmentId);
    if (cachedClient && await checkHealth(cachedClient)) {
      return cachedClient;
    }

    let port: number | null = null;
    if (isLocal) {
      let status = await backend.getLocalCodexServerStatus(environmentId);
      if (!status.running) {
        const result = await backend.startLocalCodexServer(environmentId);
        status = { running: true, port: result.port, pid: result.pid };
      }
      port = status.port ?? null;
    } else {
      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      const containerId = environment?.containerId;
      if (!containerId) {
        throw new Error("Container ID is required for containerized Codex environments");
      }

      let status = await backend.getCodexServerStatus(containerId);
      if (!status.running) {
        const result = await backend.startCodexServer(containerId);
        status = { running: true, hostPort: result.hostPort };
      }
      port = status.hostPort ?? null;
    }

    if (!port) {
      throw new Error("Failed to resolve Codex bridge port");
    }

    setServerStatus(environmentId, { running: true, hostPort: port });
    const nextClient = createClient(`http://127.0.0.1:${port}`);
    setClient(environmentId, nextClient);

    if (!(await checkHealth(nextClient))) {
      throw new Error("Codex bridge health check failed");
    }

    return nextClient;
  }, [environmentId, isLocal, setClient, setServerStatus]);

  useEffect(() => {
    if (isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady })) {
      return;
    }

    if (isInitializedRef.current || !pipeline) return;

    let mounted = true;

    void initializeClient()
      .then(() => {
        if (!mounted) return;
        isInitializedRef.current = true;
        setConnectionState("connected");
      })
      .catch((error) => {
        if (!mounted) return;
        setConnectionState("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to connect to Codex bridge server");
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
    connectAttempt,
    workspaceReady,
  ]);

  const createPipelineSession = useCallback(
    async (
      phase: PipelineSession["phase"],
      iteration: number,
      label: string,
    ): Promise<{ sessionKey: string; sdkSessionId: string } | null> => {
      try {
        const activeClient = client ?? await initializeClient();
        if (!pipeline || isPipelinePaused()) return null;

        const { model, effort } = resolveCodexPreferences(pipeline.projectId);
        const newSession = await createSession(activeClient, {
          model,
          modelReasoningEffort: effort,
          mode: "build",
        });
        if (isPipelinePaused()) {
          try {
            await abortSession(activeClient, newSession.sessionId);
          } catch {
            // Best effort; the session was never attached to the pipeline.
          }
          return null;
        }

        const tabIdForSession = `build-${phase}-${iteration}-${Date.now()}`;
        const sessionKey = createCodexSessionKey(environmentId, tabIdForSession);
        pendingPromptDispatchesRef.current.add(newSession.sessionId);

        setSession(sessionKey, {
          sessionId: newSession.sessionId,
          messages: [],
          isLoading: true,
          title: newSession.title,
        });

        addPipelineSession(pipelineId, {
          phase,
          iteration,
          sessionKey,
          sdkSessionId: newSession.sessionId,
          status: "running",
          startedAt: new Date().toISOString(),
          label,
        });

        return { sessionKey, sdkSessionId: newSession.sessionId };
      } catch {
        return null;
      }
    },
    [addPipelineSession, client, environmentId, initializeClient, isPipelinePaused, pipeline, pipelineId, resolveCodexPreferences, setSession],
  );

  const sendPromptWithDispatchGuard = useCallback(
    async (
      activeClient: CodexClient,
      sdkSessionId: string,
      prompt: string,
      options?: { attachments?: CodexPromptAttachment[] },
    ) => {
      pendingPromptDispatchesRef.current.add(sdkSessionId);
      try {
        return await sendPrompt(activeClient, sdkSessionId, prompt, options);
      } finally {
        pendingPromptDispatchesRef.current.delete(sdkSessionId);
      }
    },
    [],
  );

  const startBuildSession = useCallback(
    async (taskDescription: string, attachments?: CodexPromptAttachment[]) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
      if (isPipelinePaused()) return;

      setPhase(pipelineId, "building");
      if (isPipelinePaused()) return;

      const result = await createPipelineSession("build", 0, "Build Session");
      if (!result) {
        if (!isPipelinePaused()) setPipelineError(pipelineId, "Failed to create build session");
        return;
      }
      if (isPipelinePaused()) return;

      appendCodexMessage(result.sessionKey, buildUserMessage(taskDescription));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, taskDescription, {
        attachments,
      });

      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send build prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, createPipelineSession, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
  );

  const startReviewSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
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

      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[CodexBuildChatTab] Failed to load project notes for review:", error);
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createBuildReviewPrompt(task, projectNotes, targetBranch);
      appendCodexMessage(result.sessionKey, buildUserMessage(prompt));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, prompt, {
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send review prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, config.repositories, createPipelineSession, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
  );

  const startVerifySession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
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

      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[CodexBuildChatTab] Failed to load project notes for verification:", error);
      }
      if (isPipelinePaused()) return;

      const targetBranch = config.repositories[currentPipeline.projectId]?.prBaseBranch || "main";
      const prompt = createVerificationPrompt(task, projectNotes, targetBranch);
      appendCodexMessage(result.sessionKey, buildUserMessage(prompt));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, prompt, {
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send verification prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, config.repositories, createPipelineSession, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
  );

  const startFixSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, feedback: string) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
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

      const task = currentPipeline.taskSnapshot;
      let projectNotes = "";
      try {
        const notes = await backend.getProjectNotes(currentPipeline.projectId);
        projectNotes = notes.content;
      } catch (error) {
        console.debug("[CodexBuildChatTab] Failed to load project notes for fix:", error);
      }
      if (isPipelinePaused()) return;

      const prompt = createFixPrompt(task, projectNotes, feedback);
      appendCodexMessage(result.sessionKey, buildUserMessage(prompt));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, prompt, {
        attachments: taskImagesToAttachments(task.images),
      });

      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send fix prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, createPipelineSession, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
  );

  const startPRSession = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
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
      appendCodexMessage(result.sessionKey, buildUserMessage(prompt));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, prompt);
      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send PR creation prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, config.repositories, createPipelineSession, environmentId, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
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
      const activeClient = client ?? await initializeClient();
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
      appendCodexMessage(result.sessionKey, buildUserMessage(prompt));

      const success = await sendPromptWithDispatchGuard(activeClient, result.sdkSessionId, prompt);
      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send conflict resolution prompt";
        appendCodexMessage(result.sessionKey, buildErrorMessage(message));
        setSessionLoading(result.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, config.repositories, createPipelineSession, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
  );

  const sendAddressIssuesMessage = useCallback(
    async (currentPipeline: NonNullable<typeof pipeline>, reviewSession: PipelineSession) => {
      if (isPipelinePaused()) return;
      const activeClient = client ?? await initializeClient();
      if (isPipelinePaused()) return;
      pendingPromptDispatchesRef.current.add(reviewSession.sdkSessionId);

      setPhase(pipelineId, "addressing");
      if (isPipelinePaused()) {
        pendingPromptDispatchesRef.current.delete(reviewSession.sdkSessionId);
        return;
      }

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

      const prompt = createAddressIssuesPrompt();
      appendCodexMessage(reviewSession.sessionKey, buildUserMessage(prompt));
      setSessionLoading(reviewSession.sessionKey, true);

      const success = await sendPromptWithDispatchGuard(activeClient, reviewSession.sdkSessionId, prompt);
      if (!success) {
        if (isPipelinePaused()) return;
        const message = "Failed to send address issues prompt";
        appendCodexMessage(reviewSession.sessionKey, buildErrorMessage(message));
        setSessionLoading(reviewSession.sessionKey, false);
        setPipelineError(pipelineId, message);
      }
    },
    [client, initializeClient, isPipelinePaused, pipelineId, sendPromptWithDispatchGuard, setPhase, setPipelineError, setSessionLoading],
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
            await sendAddressIssuesMessage(currentPipeline, completedSession);
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
            const freshMessages = await getSessionMessages(client ?? await initializeClient(), completedSession.sdkSessionId);
            if (isPipelinePaused()) return;
            if (freshMessages.length > 0) {
              setMessages(completedSession.sessionKey, freshMessages);
            }

            const verifyMessages = freshMessages.length > 0
              ? freshMessages
              : (useCodexStore.getState().sessions.get(completedSession.sessionKey)?.messages ?? []);
            const result = parseVerificationResult(verifyMessages);

            const formattedContent = result.verdict === "pass"
              ? `### Verification: Passed\n\n${result.feedback}`
              : `### Verification: Failed\n\n${result.feedback}`;
            const lastAssistantIdx = verifyMessages.findLastIndex((message) => message.role === "assistant");
            if (lastAssistantIdx >= 0) {
              const updatedMessages = verifyMessages.map((message, index) => {
                if (index !== lastAssistantIdx) return message;
                let replaced = false;
                const updatedParts = message.parts.reduce<typeof message.parts>((acc, part) => {
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
        console.error("[CodexBuildChatTab] Pipeline advancement error:", error);
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
      sendAddressIssuesMessage,
      startFixSession,
      startPRSession,
      startResolveConflictsSession,
      startReviewSession,
    ],
  );

  useEffect(() => {
    if (!client || connectionState !== "connected") return;
    if (!currentSessionKey || !currentSdkSessionId || !currentSessionIsLoading) return;
    if (pollingSessionIdRef.current === currentSdkSessionId) return;

    pollingSessionIdRef.current = currentSdkSessionId;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;

      let status: Awaited<ReturnType<typeof getSessionStatus>>;
      let messages: CodexMessage[];
      try {
        status = await getSessionStatus(client, currentSdkSessionId);
        messages = await getSessionMessages(client, currentSdkSessionId);
      } catch (error) {
        if (cancelled) return;
        console.error("[CodexBuildChatTab] Polling disconnected:", error);
        isInitializedRef.current = false;
        setConnectionState("error");
        setErrorMessage(error instanceof Error ? error.message : "Connection to Codex bridge server was lost");
        return;
      }

      if (cancelled) return;

      debugCodexBuild("poll result", () => ({
        pipelineId,
        currentSessionKey,
        currentSdkSessionId,
        status: status?.status,
        statusTitle: status?.title,
        statusError: status?.error,
        incomingMessageCount: messages.length,
        incomingLastMessage: summarizeCodexMessage(messages[messages.length - 1]),
      }));

      const storedSession = useCodexStore.getState().sessions.get(currentSessionKey);

      if (messages.length > 0) {
        const existingMessages = storedSession?.messages ?? [];
        if (!codexMessagesEqual(existingMessages, messages)) {
          debugCodexBuild("set messages", () => ({
            pipelineId,
            currentSessionKey,
            previousCount: existingMessages.length,
            nextCount: messages.length,
            previousLastMessage: summarizeCodexMessage(existingMessages[existingMessages.length - 1]),
            nextLastMessage: summarizeCodexMessage(messages[messages.length - 1]),
          }));
          setMessages(currentSessionKey, messages);
        }
      }

      if (!status) {
        return;
      }

      const latestSession = useCodexStore.getState().sessions.get(currentSessionKey);

      if (status.title && latestSession?.title !== status.title) {
        setSessionTitle(currentSessionKey, status.title);
      }

      if (status.status === "running") {
        if (latestSession?.isLoading !== true) {
          debugCodexBuild("set loading true from poll", () => ({
            pipelineId,
            currentSessionKey,
            currentSdkSessionId,
          }));
          setSessionLoading(currentSessionKey, true);
        }
        return;
      }

      if (pendingPromptDispatchesRef.current.has(currentSdkSessionId)) {
        return;
      }

      if (status.status === "error") {
        const message = status.error?.trim() || "Codex session failed";
        if (latestSession?.error !== message) {
          appendCodexMessage(currentSessionKey, buildErrorMessage(message));
          setSessionError(currentSessionKey, message);
        }
        if (latestSession?.isLoading !== false) {
          setSessionLoading(currentSessionKey, false);
        }
        return;
      }

      if (latestSession?.error !== undefined) {
        setSessionError(currentSessionKey, undefined);
      }
      if (latestSession?.isLoading !== false) {
        debugCodexBuild("set loading false from poll", () => ({
          pipelineId,
          currentSessionKey,
          currentSdkSessionId,
          status: status.status,
        }));
        setSessionLoading(currentSessionKey, false);
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      pollingSessionIdRef.current = null;
      window.clearInterval(intervalId);
    };
  }, [
    client,
    connectionState,
    currentSdkSessionId,
    currentSessionIsLoading,
    currentSessionKey,
    setMessages,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
  ]);

  useEffect(() => {
    if (!pipeline || !client || connectionState !== "connected" || pipelineAdvancingRef.current) return;
    if (pipeline.phase === "addressing") return;
    if (pipeline.phase === "paused") return;
    if (pipeline.phase === "failed") return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    if (!currentSession) return;

    const sessionState = sessionsMap.get(currentSession.sessionKey);
    if (!sessionState || sessionState.isLoading) return;
    if (pendingPromptDispatchesRef.current.has(currentSession.sdkSessionId)) return;

    if (sessionState.error) {
      setPipelineError(pipelineId, sessionState.error);
      return;
    }

    if (currentSession.status === "running") {
      pipelineAdvancingRef.current = true;
      void (async () => {
        const status = await getSessionStatus(client, currentSession.sdkSessionId);
        if (status?.status === "running") {
          setSessionLoading(currentSession.sessionKey, true);
          return;
        }

        if (status?.status === "error") {
          const message = status.error?.trim() || "Codex session failed";
          appendCodexMessage(currentSession.sessionKey, buildErrorMessage(message));
          setSessionError(currentSession.sessionKey, message);
          setSessionLoading(currentSession.sessionKey, false);
          setPipelineError(pipelineId, message);
          return;
        }

        markSessionIdle(pipelineId, currentSession.sdkSessionId);
        await advancePipeline(pipeline, currentSession);
      })().finally(() => {
        pipelineAdvancingRef.current = false;
        setAdvanceTick((value) => value + 1);
      });
    }
  }, [
    advancePipeline,
    advanceTick,
    client,
    connectionState,
    markSessionIdle,
    pipeline,
    pipelineId,
    sessionsMap,
    setPipelineError,
    setSessionError,
    setSessionLoading,
  ]);

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
    if (pendingPromptDispatchesRef.current.has(currentSession.sdkSessionId)) return;

    if (sessionState.error) {
      setPipelineError(pipelineId, sessionState.error);
      return;
    }

    if (currentSession.status === "running") {
      pipelineAdvancingRef.current = true;
      void (async () => {
        const status = await getSessionStatus(client, currentSession.sdkSessionId);
        if (status?.status === "running") {
          setSessionLoading(currentSession.sessionKey, true);
          return;
        }

        if (status?.status === "error") {
          const message = status.error?.trim() || "Codex session failed";
          appendCodexMessage(currentSession.sessionKey, buildErrorMessage(message));
          setSessionError(currentSession.sessionKey, message);
          setSessionLoading(currentSession.sessionKey, false);
          setPipelineError(pipelineId, message);
          return;
        }

        markSessionIdle(pipelineId, currentSession.sdkSessionId);
        await startVerifySession(pipeline);
      })().finally(() => {
        pipelineAdvancingRef.current = false;
        setAdvanceTick((value) => value + 1);
      });
    }
  }, [
    advanceTick,
    client,
    connectionState,
    markSessionIdle,
    pipeline,
    pipelineId,
    sessionsMap,
    setPipelineError,
    setSessionError,
    setSessionLoading,
    startVerifySession,
  ]);

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
        void startBuildSession(createBuildPrompt(task, notes.content), taskImagesToAttachments(task.images));
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
        void startBuildSession(createBuildPrompt(task, ""), taskImagesToAttachments(task.images));
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
    appendCodexMessage(currentSession.sessionKey, buildUserMessage(text.trim()));

    const success = await sendPrompt(client, currentSession.sdkSessionId, text.trim());
    if (!success) {
      const message = "Failed to send message to the agent";
      appendCodexMessage(currentSession.sessionKey, buildErrorMessage(message));
      setSessionLoading(currentSession.sessionKey, false);
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
    }
  }, [client, markSessionIdle, markSessionRunning, pipeline, pipelineId, setSessionLoading]);

  const handleResume = useCallback(async () => {
    if (!pipeline || pipeline.phase !== "paused") return;
    const resumePhase = getPipelineResumePhase(pipeline);
    if (!resumePhase) return;

    const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
    const resumedPhase = resumePipeline(pipelineId, resumePhase);
    if (!resumedPhase) return;

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
            await startBuildSession(createBuildPrompt(task, notes.content), taskImagesToAttachments(task.images));
          } catch {
            await startBuildSession(createBuildPrompt(task, ""), taskImagesToAttachments(task.images));
          }
          break;
        }
        case "reviewing":
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
    appendCodexMessage(currentSession.sessionKey, buildUserMessage(prompt));

    const success = await sendPromptWithDispatchGuard(client, currentSession.sdkSessionId, prompt);
    if (!success) {
      const message = "Failed to resume build pipeline";
      appendCodexMessage(currentSession.sessionKey, buildErrorMessage(message));
      setSessionLoading(currentSession.sessionKey, false);
      markSessionIdle(pipelineId, currentSession.sdkSessionId);
      pausePipeline(pipelineId);
    }
  }, [
    client,
    markSessionIdle,
    markSessionRunning,
    pausePipeline,
    pipeline,
    pipelineId,
    resumePipeline,
    sendPromptWithDispatchGuard,
    startBuildSession,
    startFixSession,
    startPRSession,
    startResolveConflictsSession,
    startReviewSession,
    startVerifySession,
    setSessionLoading,
  ]);

  const setupPending = isSetupPending({ isLocal: !!isLocal, setupCommandsResolved, hasPendingSetupCommands, setupScriptsRunning, workspaceReady });

  const isRunning = pipeline && !["complete", "failed", "paused"].includes(pipeline.phase);
  const isPaused = pipeline?.phase === "paused";

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
        <p className="text-sm">Connecting to Codex bridge server...</p>
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
          <p className="mt-1 text-xs">{errorMessage || "Unable to connect to Codex bridge server"}</p>
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
              <span className="max-w-[300px] truncate text-xs font-medium text-red-400">{pipeline.error}</span>
            )}
          </div>
        </div>
      )}

      <VirtualizedMessageList
        messages={messageRows}
        computeItemKey={(_index, row) => row.key}
        renderMessage={(_index, row) => renderBuildRow(row)}
        emptyState={
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Initializing build pipeline...</p>
          </div>
        }
        footer={<div className="h-32" aria-hidden="true" />}
        scrollProps={scrollProps}
        virtuosoRef={virtuosoRef}
      />

      {!isAtBottom && (
        <div className="flex justify-end px-4 py-1">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
            aria-label="Scroll to bottom of conversation"
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
