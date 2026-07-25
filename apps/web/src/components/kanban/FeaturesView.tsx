import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  Layers3,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useVirtuosoScrollState } from "@/hooks";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useEnvironments } from "@/hooks/useEnvironments";
import {
  classifyCodexPromptOutcome,
  createClient,
  createSession,
  getSessionMessages,
  getSessionStatus,
  sendPrompt,
  type CodexClient,
  type CodexMessage,
  type CodexReasoningEffort,
} from "@/lib/codex-client";
import {
  createStoryCardsFromParsedState,
  createStoryRefinementPrompt,
  formatFeatureStoriesForBuild,
  parseFeaturePlannerState,
  parseStoryRefinement,
  selectFeaturePlannerPrompt,
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
} from "@/lib/feature-planner";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useConfigStore, useEnvironmentStore, useFeaturePlanStore, useKanbanStore, useProjectStore } from "@/stores";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { Environment, EnvironmentType } from "@/types";
import type {
  ActiveFeatureConversation,
  FeaturePlan,
  FeaturePlanMessage,
  FeatureStoryCard,
} from "@/stores/featurePlanStore";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";

type RightPaneTab = "chat" | "stories" | `story:${string}`;

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How long an idle session with no new reply is tolerated before giving up.
 *
 * Only has to cover the gap between the bridge accepting a prompt and reporting
 * the turn as running, which is sub-second; the rest is margin.
 */
const IDLE_WITHOUT_REPLY_TIMEOUT_MS = 8_000;
const RIGHT_PANE_CONTENT_CLASS =
  "h-full min-h-0 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col";
const COMPACT_TAB_LIST_CLASS = "h-8 bg-zinc-900/80";
const COMPACT_TAB_TRIGGER_CLASS = "px-2 text-xs data-[state=active]:!bg-zinc-800";

function featureChatDraftId(featureId: string): string {
  return `feature:${featureId}`;
}

function storyChatDraftId(featureId: string, storyId: string): string {
  return `feature:${featureId}:story:${storyId}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wasCodexPromptAccepted(result: unknown): boolean {
  // A lost response does not prove the prompt was rejected, so keep waiting for
  // authoritative state rather than resending. `waitForCodexReply` gives up
  // quickly if the session turns out to be idle with nothing new.
  return classifyCodexPromptOutcome(result) !== "rejected";
}

function messageContent(message: CodexMessage): string {
  if (message.content?.trim()) return message.content;
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n")
    .trim();
}

function latestAssistantMessage(
  messages: CodexMessage[],
  options: {
    excludeIds?: ReadonlySet<string>;
    accept?: (content: string) => boolean;
  } = {},
): { id: string; content: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (options.excludeIds?.has(message.id)) continue;
    const content = messageContent(message);
    if (content.trim() && (!options.accept || options.accept(content))) {
      return { id: message.id, content };
    }
  }
  return null;
}

function assistantMessageIds(messages: CodexMessage[]): Set<string> {
  return new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id));
}

async function waitForCodexReply(
  client: CodexClient,
  sessionId: string,
  baselineAssistantIds: ReadonlySet<string>,
): Promise<string | null> {
  const startedAt = Date.now();
  let idleWithoutReplySince: number | null = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const status = await getSessionStatus(client, sessionId);
    const messages = await getSessionMessages(client, sessionId);

    if (status?.status === "error") {
      throw new Error(status.error || "Codex planning session failed");
    }

    const reply = latestAssistantMessage(messages, { excludeIds: baselineAssistantIds });
    if (status?.status === "idle" && reply) {
      return reply.content;
    }

    /**
     * Give up early on a session that is idle with nothing new.
     *
     * A prompt whose response was lost may never have reached the bridge. Left
     * alone this loop would hold the chat for the full ten-minute timeout and
     * then claim Codex is "still working" about a session that is doing nothing.
     * A short grace period still absorbs the gap between accepting a prompt and
     * the turn being reported as running.
     */
    if (status?.status === "idle" && !reply) {
      idleWithoutReplySince ??= Date.now();
      if (Date.now() - idleWithoutReplySince >= IDLE_WITHOUT_REPLY_TIMEOUT_MS) {
        throw new Error(
          "Codex did not receive the prompt. Please try sending it again.",
        );
      }
    } else {
      idleWithoutReplySince = null;
    }

    await wait(POLL_INTERVAL_MS);
  }

  return null;
}

function FeatureListItem({
  feature,
  isSelected,
  onSelect,
}: {
  feature: FeaturePlan;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const storyCount = feature.stories.length;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-md border px-3 py-2 text-left transition-colors",
        isSelected
          ? "border-primary/40 bg-primary/10"
          : "border-transparent hover:border-border hover:bg-muted/35",
      )}
    >
      <div className="truncate text-sm font-medium text-foreground">{feature.title || "new feature"}</div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="capitalize">{feature.status}</span>
        {storyCount > 0 && <span>{storyCount} stor{storyCount === 1 ? "y" : "ies"}</span>}
      </div>
    </button>
  );
}

function getPreferredEnvironmentType(projectId: string): EnvironmentType {
  const config = useConfigStore.getState().config;
  const project = useProjectStore.getState().getProjectById(projectId);
  return config.repositories[projectId]?.lastEnvironmentType
    ?? (project?.localPath ? "local" : "containerized");
}

function formatStoryTabTitle(story: FeatureStoryCard): string {
  return story.title.length > 24 ? `${story.title.slice(0, 24)}...` : story.title;
}

function toNativeChatMessage(
  message: FeaturePlanMessage,
  stripState: (content: string) => string,
): NativeMessageType | null {
  const content = stripState(message.content);
  if (!content.trim()) return null;

  return {
    id: message.id,
    role: message.role,
    content,
    parts: [{ type: "text", content }],
    createdAt: message.createdAt,
  };
}

function latestUserMessageTime(feature: FeaturePlan): number {
  let latest = Number.NEGATIVE_INFINITY;

  for (const message of feature.messages) {
    if (message.role !== "user") continue;
    const timestamp = Date.parse(message.createdAt);
    if (!Number.isNaN(timestamp)) {
      latest = Math.max(latest, timestamp);
    }
  }

  return latest;
}

function latestUnansweredConversation(feature: FeaturePlan): ActiveFeatureConversation | null {
  const candidates: ActiveFeatureConversation[] = [];
  const featureMessage = feature.messages.at(-1);
  if (featureMessage?.role === "user") {
    candidates.push({
      featureId: feature.id,
      startedAt: featureMessage.createdAt,
      phase: "running",
    });
  }

  for (const story of feature.stories) {
    const storyMessage = story.messages.at(-1);
    if (storyMessage?.role !== "user") continue;
    candidates.push({
      featureId: feature.id,
      storyId: story.id,
      startedAt: storyMessage.createdAt,
      phase: "running",
    });
  }

  return candidates.sort((a, b) => {
    const aTime = Date.parse(a.startedAt);
    const bTime = Date.parse(b.startedAt);
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  })[0] ?? null;
}

interface FeaturesViewProps {
  projectId: string;
}

export function FeaturesView({ projectId }: FeaturesViewProps) {
  const features = useFeaturePlanStore((state) => state.features);
  const isLoading = useFeaturePlanStore((state) => state.isLoading);
  const loadFeatures = useFeaturePlanStore((state) => state.loadFeatures);
  const createFeature = useFeaturePlanStore((state) => state.createFeature);
  const updateFeature = useFeaturePlanStore((state) => state.updateFeature);
  const appendMessage = useFeaturePlanStore((state) => state.appendMessage);
  const appendStoryMessage = useFeaturePlanStore((state) => state.appendStoryMessage);
  const chatDrafts = useFeaturePlanStore((state) => state.chatDrafts);
  const setChatDraft = useFeaturePlanStore((state) => state.setChatDraft);
  const currentProjectId = useFeaturePlanStore((state) => state.currentProjectId);
  const activeConversations = useFeaturePlanStore((state) => state.activeConversations);
  const setConversationActive = useFeaturePlanStore((state) => state.setConversationActive);
  const setConversationSettled = useFeaturePlanStore((state) => state.setConversationSettled);
  const addTask = useKanbanStore((state) => state.addTask);
  const { startBuild } = useBuildPipeline();
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightPaneTab>("chat");
  const [openStoryTabs, setOpenStoryTabs] = useState<string[]>([]);
  const [buildingFeatureId, setBuildingFeatureId] = useState<string | null>(null);
  const clientsRef = useRef<Map<string, CodexClient>>(new Map());
  const reconciledProjectRef = useRef<string | null>(null);

  useEffect(() => {
    void loadFeatures(projectId);
  }, [loadFeatures, projectId]);

  const projectFeatures = useMemo(
    () => features
      .filter((feature) => feature.projectId === projectId)
      .sort((a, b) => {
        const recencyDifference = latestUserMessageTime(b) - latestUserMessageTime(a);
        return Number.isNaN(recencyDifference) || recencyDifference === 0
          ? a.order - b.order
          : recencyDifference;
      }),
    [features, projectId],
  );

  const selectedFeature = useMemo(
    () => projectFeatures.find((feature) => feature.id === selectedFeatureId) ?? projectFeatures[0] ?? null,
    [projectFeatures, selectedFeatureId],
  );
  const hasRunningConversation = useMemo(
    () => projectFeatures.some((feature) => activeConversations.has(feature.id)),
    [activeConversations, projectFeatures],
  );
  const featureDraft = selectedFeature
    ? chatDrafts.get(featureChatDraftId(selectedFeature.id)) ?? ""
    : "";

  useEffect(() => {
    if (!selectedFeature) return;
    if (selectedFeatureId !== selectedFeature.id) {
      setSelectedFeatureId(selectedFeature.id);
    }
  }, [selectedFeature, selectedFeatureId]);

  useEffect(() => {
    setRightTab(selectedFeature?.stories.length ? "stories" : "chat");
    setOpenStoryTabs([]);
  }, [selectedFeature?.id]);

  useEffect(() => {
    if (!selectedFeature) {
      setOpenStoryTabs([]);
      if (rightTab.startsWith("story:")) setRightTab("chat");
      return;
    }

    const storyIds = new Set(selectedFeature.stories.map((story) => story.id));
    setOpenStoryTabs((tabs) => {
      const next = tabs.filter((storyId) => storyIds.has(storyId));
      return next.length === tabs.length ? tabs : next;
    });

    if (rightTab.startsWith("story:") && !storyIds.has(rightTab.slice("story:".length))) {
      setRightTab(selectedFeature.stories.length ? "stories" : "chat");
    } else if (rightTab === "stories" && selectedFeature.stories.length === 0) {
      setRightTab("chat");
    }
  }, [rightTab, selectedFeature]);

  const selectedStory = useMemo(() => {
    if (!selectedFeature || !rightTab.startsWith("story:")) return null;
    const storyId = rightTab.slice("story:".length);
    return selectedFeature.stories.find((story) => story.id === storyId) ?? null;
  }, [rightTab, selectedFeature]);

  const getExistingCodexSession = useCallback(
    async (feature: FeaturePlan): Promise<{ client: CodexClient; sessionId: string } | null> => {
      if (!feature.codexEnvironmentId || !feature.codexSessionId) return null;

      const environment = useEnvironmentStore.getState().getEnvironmentById(feature.codexEnvironmentId)
        ?? await backend.getEnvironment(feature.codexEnvironmentId);
      if (!environment || environment.status !== "running") return null;

      let client = clientsRef.current.get(environment.id);
      if (!client) {
        let port: number | null = null;
        if (environment.environmentType === "local") {
          const status = await backend.getLocalCodexServerStatus(environment.id);
          if (!status.running) return null;
          port = status.port ?? null;
        } else {
          if (!environment.containerId) return null;
          const status = await backend.getCodexServerStatus(environment.containerId);
          if (!status.running) return null;
          port = status.hostPort ?? null;
        }

        if (!port) return null;
        client = createClient(`http://127.0.0.1:${port}`);
        clientsRef.current.set(environment.id, client);
      }

      return { client, sessionId: feature.codexSessionId };
    },
    [],
  );

  useEffect(() => {
    if (isLoading || currentProjectId !== projectId) return;
    if (reconciledProjectRef.current === projectId) return;

    let cancelled = false;
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const waitToPoll = () => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, POLL_INTERVAL_MS);
      timers.set(timer, resolve);
    });

    const startTimer = setTimeout(() => {
      timers.delete(startTimer);
      if (cancelled) return;

      const state = useFeaturePlanStore.getState();
      if (state.isLoading || state.currentProjectId !== projectId) return;
      if (reconciledProjectRef.current === projectId) return;
      reconciledProjectRef.current = projectId;

      const pendingConversations = state.features
        .filter((feature) => (
          feature.projectId === projectId
          && feature.codexEnvironmentId
          && feature.codexSessionId
        ))
        .map(latestUnansweredConversation)
        .filter((conversation): conversation is ActiveFeatureConversation => conversation !== null);

      for (const conversation of pendingConversations) {
        const cachedConversation = state.activeConversations.get(conversation.featureId);
        const wasDispatching = (
          cachedConversation?.storyId === conversation.storyId
          && cachedConversation?.startedAt === conversation.startedAt
          && cachedConversation?.phase === "dispatching"
        );
        setConversationActive(wasDispatching ? cachedConversation : conversation);
        void (async () => {
          let sawRunning = false;
          let idleWithoutReplySince: number | null = null;

          while (!cancelled) {
            const feature = useFeaturePlanStore.getState().features.find(
              (candidate) => candidate.id === conversation.featureId,
            );
            const stillPending = feature ? latestUnansweredConversation(feature) : null;
            if (
              !feature
              || !stillPending
              || stillPending.storyId !== conversation.storyId
              || stillPending.startedAt !== conversation.startedAt
            ) {
              setConversationSettled(conversation.featureId);
              return;
            }

            let status = null;
            try {
              const existingSession = await getExistingCodexSession(feature);
              if (cancelled) return;
              status = existingSession
                ? await getSessionStatus(
                    existingSession.client,
                    existingSession.sessionId,
                    { throwOnError: true },
                  )
                : null;
            } catch {
              if (feature.codexEnvironmentId) {
                clientsRef.current.delete(feature.codexEnvironmentId);
              }
              await waitToPoll();
              continue;
            }
            if (cancelled) return;

            if (status?.status === "running") {
              sawRunning = true;
              idleWithoutReplySince = null;
              setConversationActive({ ...conversation, phase: "running" });
            } else if (status?.status === "error") {
              setConversationSettled(conversation.featureId);
              return;
            } else {
              idleWithoutReplySince ??= Date.now();
              if (
                sawRunning
                || !wasDispatching
                || Date.now() - idleWithoutReplySince >= IDLE_WITHOUT_REPLY_TIMEOUT_MS
              ) {
                setConversationSettled(conversation.featureId);
                return;
              }
            }

            await waitToPoll();
          }
        })();
      }
    }, 0);
    timers.set(startTimer, () => undefined);

    return () => {
      cancelled = true;
      for (const [timer, resolve] of timers) {
        clearTimeout(timer);
        resolve();
      }
      timers.clear();
    };
  }, [
    currentProjectId,
    getExistingCodexSession,
    isLoading,
    projectId,
    setConversationActive,
    setConversationSettled,
  ]);

  const ensureCodexSession = useCallback(
    async (feature: FeaturePlan): Promise<{ client: CodexClient; sessionId: string; feature: FeaturePlan }> => {
      let workingFeature = feature;
      let environment: Environment | null = null;

      if (feature.codexEnvironmentId) {
        environment = useEnvironmentStore.getState().getEnvironmentById(feature.codexEnvironmentId)
          ?? await backend.getEnvironment(feature.codexEnvironmentId);
      }

      if (!environment) {
        const environmentType = getPreferredEnvironmentType(projectId);
        environment = await createEnvironment(
          projectId,
          `feature-plan-${feature.title || "new-feature"}`,
          environmentType === "containerized" ? "restricted" : "full",
          undefined,
          undefined,
          environmentType,
          feature.summary || feature.title,
        );
        environment = await backend.updateEnvironmentAgentSettings(
          environment.id,
          "codex",
          null,
          null,
          null,
          "native",
        );
        useEnvironmentStore.getState().updateEnvironment(environment.id, environment);
        const updated = await updateFeature(feature.id, { codexEnvironmentId: environment.id });
        if (!updated) throw new Error("Failed to persist the feature planning environment");
        workingFeature = updated;
      }

      if (environment.status !== "running") {
        await startEnvironment(environment.id, undefined, { silent: true });
        environment = await backend.getEnvironment(environment.id) ?? environment;
        useEnvironmentStore.getState().updateEnvironment(environment.id, environment);
      }

      let client = clientsRef.current.get(environment.id);
      if (!client) {
        let port: number | null = null;
        if (environment.environmentType === "local") {
          let status = await backend.getLocalCodexServerStatus(environment.id);
          if (!status.running) {
            const result = await backend.startLocalCodexServer(environment.id);
            status = { running: true, port: result.port, pid: result.pid };
          }
          port = status.port ?? null;
        } else {
          if (!environment.containerId) {
            throw new Error("Container ID is required for feature planning in a container");
          }
          let status = await backend.getCodexServerStatus(environment.containerId);
          if (!status.running) {
            const result = await backend.startCodexServer(environment.containerId);
            status = { running: true, hostPort: result.hostPort };
          }
          port = status.hostPort ?? null;
        }

        if (!port) throw new Error("Failed to resolve Codex bridge port");
        client = createClient(`http://127.0.0.1:${port}`);
        clientsRef.current.set(environment.id, client);
      }

      if (workingFeature.codexSessionId) {
        const status = await getSessionStatus(client, workingFeature.codexSessionId);
        if (status) {
          return { client, sessionId: workingFeature.codexSessionId, feature: workingFeature };
        }
      }

      const config = useConfigStore.getState().config;
      const reasoningEffort = (
        config.repositories[projectId]?.defaultEffort
        || config.global.codexReasoningEffort
        || "medium"
      ) as CodexReasoningEffort;
      const created = await createSession(client, {
        title: workingFeature.title || "Feature planning",
        model: config.repositories[projectId]?.defaultModel || config.global.codexModel,
        modelReasoningEffort: reasoningEffort,
        mode: "plan",
        fastMode: config.global.codexNativeFastModeDefault ?? false,
      });

      const updated = await updateFeature(workingFeature.id, { codexSessionId: created.sessionId });
      if (!updated) throw new Error("Failed to persist the feature planning session");
      workingFeature = updated;
      return { client, sessionId: created.sessionId, feature: workingFeature };
    },
    [createEnvironment, projectId, startEnvironment, updateFeature],
  );

  const applyFeaturePlannerState = useCallback(
    async (feature: FeaturePlan, assistantContent: string) => {
      const parsed = parseFeaturePlannerState(assistantContent);
      if (!parsed) return;

      const updates: Parameters<typeof updateFeature>[1] = {};
      if (parsed.title?.trim()) updates.title = parsed.title.trim();
      if (parsed.summary !== undefined) updates.summary = parsed.summary;
      if (parsed.phase === "collecting") updates.status = "collecting";
      if (parsed.phase === "confirming") updates.status = "confirming";
      if (parsed.phase === "stories") {
        updates.status = "stories";
        updates.stories = createStoryCardsFromParsedState(parsed, feature.stories);
        setRightTab("stories");
      }

      if (Object.keys(updates).length > 0) {
        const updated = await updateFeature(feature.id, updates);
        if (!updated) throw new Error("Failed to persist the feature planning state");
      }
    },
    [updateFeature],
  );

  const sendFeatureMessage = useCallback(
    async (text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasRunningConversation) return;

      setChatDraft(featureChatDraftId(feature.id), "");
      let conversationStartedAt = new Date().toISOString();
      setConversationActive({
        featureId: feature.id,
        startedAt: conversationStartedAt,
        phase: "dispatching",
      });
      let userMessagePersisted = false;
      try {
        const withUserMessage = await appendMessage(feature.id, "user", trimmed);
        if (!withUserMessage) throw new Error("Failed to persist the feature message");
        userMessagePersisted = true;
        conversationStartedAt = withUserMessage.messages.at(-1)?.createdAt ?? conversationStartedAt;
        setConversationActive({
          featureId: feature.id,
          startedAt: conversationStartedAt,
          phase: "dispatching",
        });
        const latestFeature = withUserMessage;
        const previousSessionId = latestFeature.codexSessionId;
        const { client, sessionId } = await ensureCodexSession(latestFeature);
        const baselineMessages = await getSessionMessages(client, sessionId);
        const prompt = selectFeaturePlannerPrompt({
          feature: latestFeature,
          userMessage: trimmed,
          previousSessionId,
          sessionId,
        });

        const sent = await sendPrompt(client, sessionId, prompt);
        if (!wasCodexPromptAccepted(sent)) {
          throw new Error("Failed to send feature planning prompt");
        }
        setConversationActive({
          featureId: feature.id,
          startedAt: conversationStartedAt,
          phase: "running",
        });

        const assistantContent = await waitForCodexReply(
          client,
          sessionId,
          assistantMessageIds(baselineMessages),
        );
        if (!assistantContent) {
          toast.warning("Codex is still working", {
            description: "The feature chat was persisted. Use refresh when you return.",
          });
          return;
        }

        const updated = await appendMessage(feature.id, "assistant", assistantContent);
        if (!updated) throw new Error("Failed to persist the feature planning response");
        await applyFeaturePlannerState(updated, assistantContent);
      } catch (error) {
        if (!userMessagePersisted) setChatDraft(featureChatDraftId(feature.id), text);
        console.error("[FeaturesView] Failed to send feature message:", error);
        toast.error("Feature planning failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setConversationSettled(feature.id);
      }
    },
    [
      appendMessage,
      applyFeaturePlannerState,
      ensureCodexSession,
      hasRunningConversation,
      selectedFeature,
      setChatDraft,
      setConversationActive,
      setConversationSettled,
    ],
  );

  const refreshFeatureChat = useCallback(
    async (feature: FeaturePlan) => {
      if (
        !feature.codexEnvironmentId
        || !feature.codexSessionId
        || hasRunningConversation
      ) return;
      setConversationActive({
        featureId: feature.id,
        startedAt: new Date().toISOString(),
        phase: "running",
      });
      try {
        const { client, sessionId } = await ensureCodexSession(feature);
        const messages = await getSessionMessages(client, sessionId);
        const assistantContent = latestAssistantMessage(messages, {
          accept: (content) => parseFeaturePlannerState(content) !== null,
        })?.content;
        const persistedAssistantContents = new Set(
          feature.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.content),
        );
        if (assistantContent && !persistedAssistantContents.has(assistantContent)) {
          const updated = await appendMessage(feature.id, "assistant", assistantContent);
          if (!updated) throw new Error("Failed to persist the refreshed feature response");
          await applyFeaturePlannerState(updated, assistantContent);
        }
      } catch (error) {
        console.error("[FeaturesView] Failed to refresh feature chat:", error);
        toast.error("Failed to refresh feature chat", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setConversationSettled(feature.id);
      }
    },
    [
      appendMessage,
      applyFeaturePlannerState,
      ensureCodexSession,
      hasRunningConversation,
      setConversationActive,
      setConversationSettled,
    ],
  );

  const applyStoryRefinement = useCallback(
    async (feature: FeaturePlan, story: FeatureStoryCard, assistantContent: string) => {
      const parsed = parseStoryRefinement(assistantContent);
      if (!parsed) return;
      if (parsed.storyId && parsed.storyId !== story.id) {
        throw new Error("Story refinement response targeted a different story");
      }

      const stories = feature.stories.map((candidate) => {
        if (candidate.id !== story.id) return candidate;
        return {
          ...candidate,
          title: parsed.title?.trim() || candidate.title,
          description: parsed.description?.trim() || candidate.description,
          acceptanceCriteria: parsed.acceptanceCriteria?.length
            ? parsed.acceptanceCriteria
            : candidate.acceptanceCriteria,
          updatedAt: new Date().toISOString(),
        };
      });
      const updated = await updateFeature(feature.id, { stories });
      if (!updated) throw new Error("Failed to persist the refined story");
    },
    [updateFeature],
  );

  const sendStoryMessage = useCallback(
    async (story: FeatureStoryCard, text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasRunningConversation) return;

      setChatDraft(storyChatDraftId(feature.id, story.id), "");
      let conversationStartedAt = new Date().toISOString();
      setConversationActive({
        featureId: feature.id,
        storyId: story.id,
        startedAt: conversationStartedAt,
        phase: "dispatching",
      });
      let userMessagePersisted = false;
      try {
        const withUserMessage = await appendStoryMessage(feature.id, story.id, "user", trimmed);
        if (!withUserMessage) throw new Error("Failed to persist the story message");
        userMessagePersisted = true;
        const persistedStory = withUserMessage.stories.find((candidate) => candidate.id === story.id);
        conversationStartedAt = persistedStory?.messages.at(-1)?.createdAt ?? conversationStartedAt;
        setConversationActive({
          featureId: feature.id,
          storyId: story.id,
          startedAt: conversationStartedAt,
          phase: "dispatching",
        });
        const latestFeature = withUserMessage;
        const latestStory = latestFeature.stories.find((candidate) => candidate.id === story.id) ?? story;
        const { client, sessionId } = await ensureCodexSession(latestFeature);
        const baselineMessages = await getSessionMessages(client, sessionId);
        const prompt = createStoryRefinementPrompt(latestStory, trimmed);
        const sent = await sendPrompt(client, sessionId, prompt);
        if (!wasCodexPromptAccepted(sent)) {
          throw new Error("Failed to send story refinement prompt");
        }
        setConversationActive({
          featureId: feature.id,
          storyId: story.id,
          startedAt: conversationStartedAt,
          phase: "running",
        });

        const assistantContent = await waitForCodexReply(
          client,
          sessionId,
          assistantMessageIds(baselineMessages),
        );
        if (!assistantContent) {
          toast.warning("Codex is still refining the story", {
            description: "The refinement request was persisted. Use refresh when you return.",
          });
          return;
        }

        const withAssistantMessage = await appendStoryMessage(feature.id, story.id, "assistant", assistantContent);
        if (!withAssistantMessage) throw new Error("Failed to persist the story refinement response");
        const updatedStory = withAssistantMessage.stories.find((candidate) => candidate.id === story.id) ?? latestStory;
        await applyStoryRefinement(withAssistantMessage, updatedStory, assistantContent);
      } catch (error) {
        if (!userMessagePersisted) {
          setChatDraft(storyChatDraftId(feature.id, story.id), text);
        }
        console.error("[FeaturesView] Failed to send story message:", error);
        toast.error("Story refinement failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setConversationSettled(feature.id);
      }
    },
    [
      appendStoryMessage,
      applyStoryRefinement,
      ensureCodexSession,
      hasRunningConversation,
      selectedFeature,
      setChatDraft,
      setConversationActive,
      setConversationSettled,
    ],
  );

  const refreshStoryChat = useCallback(
    async (feature: FeaturePlan, story: FeatureStoryCard) => {
      if (
        !feature.codexEnvironmentId
        || !feature.codexSessionId
        || hasRunningConversation
      ) return;
      setConversationActive({
        featureId: feature.id,
        storyId: story.id,
        startedAt: new Date().toISOString(),
        phase: "running",
      });
      try {
        const { client, sessionId } = await ensureCodexSession(feature);
        const messages = await getSessionMessages(client, sessionId);
        const assistantContent = latestAssistantMessage(messages, {
          accept: (content) => {
            const parsed = parseStoryRefinement(content);
            return parsed !== null && (!parsed.storyId || parsed.storyId === story.id);
          },
        })?.content;
        const persistedAssistantContents = new Set(
          story.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.content),
        );
        if (assistantContent && !persistedAssistantContents.has(assistantContent)) {
          const updated = await appendStoryMessage(feature.id, story.id, "assistant", assistantContent);
          if (!updated) throw new Error("Failed to persist the refreshed story response");
          const updatedStory = updated.stories.find((candidate) => candidate.id === story.id) ?? story;
          await applyStoryRefinement(updated, updatedStory, assistantContent);
        }
      } catch (error) {
        console.error("[FeaturesView] Failed to refresh story chat:", error);
        toast.error("Failed to refresh story chat", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setConversationSettled(feature.id);
      }
    },
    [
      appendStoryMessage,
      applyStoryRefinement,
      ensureCodexSession,
      hasRunningConversation,
      setConversationActive,
      setConversationSettled,
    ],
  );

  const openStory = useCallback((storyId: string) => {
    setOpenStoryTabs((tabs) => (tabs.includes(storyId) ? tabs : [...tabs, storyId]));
    setRightTab(`story:${storyId}`);
  }, []);

  const closeStoryTab = useCallback((storyId: string) => {
    setOpenStoryTabs((tabs) => tabs.filter((id) => id !== storyId));
    if (rightTab === `story:${storyId}`) {
      setRightTab("stories");
    }
  }, [rightTab]);

  const handleCreateFeature = useCallback(async () => {
    const featureId = await createFeature(projectId);
    if (featureId) {
      setSelectedFeatureId(featureId);
      setRightTab("chat");
      setOpenStoryTabs([]);
    }
  }, [createFeature, projectId]);

  const handleBuildFeature = useCallback(
    async (feature: FeaturePlan) => {
      if (buildingFeatureId || feature.stories.length === 0) return;
      setBuildingFeatureId(feature.id);
      try {
        const taskDetails = formatFeatureStoriesForBuild(feature);
        const taskId = await addTask(projectId, taskDetails.title, taskDetails.description);
        if (!taskId) throw new Error("Failed to create Kanban task for feature build");

        const task = useKanbanStore.getState().tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("Created build task was not found in the Kanban store");

        await startBuild(task, getPreferredEnvironmentType(projectId), "codex", {
          existingEnvironmentId: feature.codexEnvironmentId,
        });
        const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(taskId);
        if (!pipeline || pipeline.phase === "failed") {
          // startBuild surfaces its own error toast and clears or fails the
          // pipeline when it cannot start. Leave the feature in its prior state
          // rather than marking it as building.
          return;
        }
        const updated = await updateFeature(feature.id, {
          status: "building",
          buildTaskId: taskId,
          buildPipelineId: pipeline.id,
          ...(pipeline.environmentId ? { codexEnvironmentId: pipeline.environmentId } : {}),
        });
        if (!updated) throw new Error("Failed to persist the feature build state");
      } catch (error) {
        console.error("[FeaturesView] Failed to start feature build:", error);
        toast.error("Failed to start feature build", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setBuildingFeatureId(null);
      }
    },
    [addTask, buildingFeatureId, projectId, startBuild, updateFeature],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-muted/15">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <h3 className="text-sm font-semibold text-foreground">Features</h3>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7"
            onClick={() => void handleCreateFeature()}
            title="New feature"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {projectFeatures.map((feature) => (
              <FeatureListItem
                key={feature.id}
                feature={feature}
                isSelected={feature.id === selectedFeature?.id}
                onSelect={() => {
                  setSelectedFeatureId(feature.id);
                  setRightTab(feature.stories.length ? "stories" : "chat");
                }}
              />
            ))}
            {projectFeatures.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {isLoading ? "Loading features..." : "Create a feature to start discovery."}
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedFeature ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {isLoading ? "Loading features..." : "Select or create a feature."}
          </div>
        ) : (
          <Tabs
            value={rightTab}
            onValueChange={(value) => setRightTab(value as RightPaneTab)}
            className="h-full min-h-0 gap-0"
          >
            <div className="flex h-14 items-center gap-3 border-b border-border px-4">
              <TabsList className={COMPACT_TAB_LIST_CLASS}>
                <TabsTrigger value="chat" className={cn(COMPACT_TAB_TRIGGER_CLASS, "gap-1.5")}>
                  <MessageSquare className="h-3.5 w-3.5" />
                  Chat
                </TabsTrigger>
                <TabsTrigger
                  value="stories"
                  className={cn(COMPACT_TAB_TRIGGER_CLASS, "gap-1.5")}
                  disabled={selectedFeature.stories.length === 0}
                >
                  <Layers3 className="h-3.5 w-3.5" />
                  Stories
                </TabsTrigger>
                {openStoryTabs.map((storyId) => {
                  const story = selectedFeature.stories.find((candidate) => candidate.id === storyId);
                  if (!story) return null;
                  return (
                    <TabsTrigger
                      key={storyId}
                      value={`story:${storyId}`}
                      aria-label={formatStoryTabTitle(story)}
                      className={cn(COMPACT_TAB_TRIGGER_CLASS, "group gap-1.5")}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {formatStoryTabTitle(story)}
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Close ${story.title}`}
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeStoryTab(storyId);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          closeStoryTab(storyId);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {selectedFeature.stories.length > 0 && (
                <Button
                  size="sm"
                  className="ml-auto gap-1.5"
                  disabled={buildingFeatureId === selectedFeature.id}
                  onClick={() => void handleBuildFeature(selectedFeature)}
                >
                  {buildingFeatureId === selectedFeature.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5" />
                  )}
                  Build
                </Button>
              )}
            </div>

            <TabsContent value="chat" className={RIGHT_PANE_CONTENT_CLASS}>
              <FeatureChatPanel
                feature={selectedFeature}
                draft={featureDraft}
                setDraft={(value) => setChatDraft(featureChatDraftId(selectedFeature.id), value)}
                isRunning={hasRunningConversation}
                onSend={sendFeatureMessage}
                onRefresh={() => void refreshFeatureChat(selectedFeature)}
              />
            </TabsContent>

            <TabsContent value="stories" className={RIGHT_PANE_CONTENT_CLASS}>
              <FeatureStoriesPanel
                feature={selectedFeature}
                onOpenStory={openStory}
              />
            </TabsContent>

            {selectedStory && (
              <TabsContent value={`story:${selectedStory.id}`} className={RIGHT_PANE_CONTENT_CLASS}>
                <StoryDetailPanel
                  story={selectedStory}
                  draft={chatDrafts.get(storyChatDraftId(selectedFeature.id, selectedStory.id)) ?? ""}
                  setDraft={(value) => setChatDraft(
                    storyChatDraftId(selectedFeature.id, selectedStory.id),
                    value,
                  )}
                  isRunning={hasRunningConversation}
                  onSend={(text) => void sendStoryMessage(selectedStory, text)}
                  onRefresh={() => void refreshStoryChat(selectedFeature, selectedStory)}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </main>
    </div>
  );
}

function FeatureChatPanel({
  feature,
  draft,
  setDraft,
  isRunning,
  onSend,
  onRefresh,
}: {
  feature: FeaturePlan;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  onSend: (text: string) => void;
  onRefresh: () => void;
}) {
  return (
    <NativeStyleChatPanel
      messages={feature.messages}
      stripState={stripFeaturePlannerStateBlocks}
      persistKey={`feature-chat-${feature.id}`}
      draft={draft}
      setDraft={setDraft}
      isRunning={isRunning}
      loadingText="Codex is working..."
      placeholder="Describe the feature or answer Codex..."
      onSend={onSend}
      onRefresh={onRefresh}
    />
  );
}

export function NativeStyleChatPanel({
  messages,
  stripState,
  persistKey,
  draft,
  setDraft,
  isRunning,
  loadingText,
  placeholder,
  onSend,
  onRefresh,
}: {
  messages: FeaturePlanMessage[];
  stripState: (content: string) => string;
  persistKey: string;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  loadingText: string;
  placeholder: string;
  onSend: (text: string) => void;
  onRefresh?: () => void;
}) {
  const nativeMessages = useMemo(
    () => messages
      .map((message) => toNativeChatMessage(message, stripState))
      .filter((message): message is NativeMessageType => message !== null),
    [messages, stripState],
  );
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive: true,
    persistKey,
    stickToBottomOnActivation: true,
  });

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || isRunning) return;
    onSend(draft);
  }, [draft, isRunning, onSend]);

  return (
    <div className="@container relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <VirtualizedMessageList
          messages={nativeMessages}
          computeItemKey={(_index, message) => message.id}
          renderMessage={(_index, message, previousMessage) => (
            <NativeMessage
              message={message}
              previousMessage={previousMessage}
              assistantLabel="Codex"
            />
          )}
          footer={
            <>
              {isRunning && (
                <div className="px-2 @sm:px-4 py-3">
                  <div className="mx-auto max-w-3xl min-w-0">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-xs">{loadingText}</span>
                    </div>
                  </div>
                </div>
              )}
              <div className="h-32" aria-hidden="true" />
            </>
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />
      </div>

      <NativeComposeDock
        centered={false}
        topAccessory={
          !isAtBottom ? (
            <button
              type="button"
              onClick={scrollToBottom}
              className="flex items-center gap-1.5 self-end rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
              aria-label="Scroll to bottom of conversation"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>Scroll down</span>
            </button>
          ) : null
        }
      >
        <div className="mx-auto mb-4 mt-2 w-[min(calc(100%_-_2rem),56rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            rows={1}
            className="max-h-[160px] min-h-7 resize-none border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
          />
          <div className="flex items-center gap-1 pt-1">
            {onRefresh ? (
              <button
                type="button"
                disabled={isRunning}
                onClick={onRefresh}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title="Refresh Codex status"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            ) : null}
            <div className="flex-1" />
            <Button
              type="button"
              size="icon"
              className="h-8 w-8 rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80"
              disabled={!draft.trim() || isRunning}
              onClick={handleSend}
              title="Send message"
            >
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </NativeComposeDock>
    </div>
  );
}

function FeatureStoriesPanel({
  feature,
  onOpenStory,
}: {
  feature: FeaturePlan;
  onOpenStory: (storyId: string) => void;
}) {
  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-6">
        {feature.stories.map((story) => (
          <button
            key={story.id}
            type="button"
            onClick={() => onOpenStory(story.id)}
            className="rounded-md border border-border bg-card p-4 text-left shadow-sm transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-md"
          >
            <div className="flex items-start gap-2">
              <h4 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{story.title}</h4>
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
            <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
              {story.description}
            </p>
            <div className="mt-3 text-[11px] text-muted-foreground">
              {story.acceptanceCriteria.length} acceptance criteria
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

function StoryDetailPanel({
  story,
  draft,
  setDraft,
  isRunning,
  onSend,
  onRefresh,
}: {
  story: FeatureStoryCard;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  onSend: (text: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(260px,360px)_1fr]">
      <aside className="min-h-0 overflow-y-auto border-r border-border p-5">
        <h3 className="text-base font-semibold text-foreground">{story.title}</h3>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{story.description}</p>
        <Separator className="my-5" />
        <h4 className="text-sm font-medium text-foreground">Acceptance criteria</h4>
        <ul className="mt-3 space-y-2">
          {story.acceptanceCriteria.map((criterion, index) => (
            <li key={`${criterion}-${index}`} className="flex gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{criterion}</span>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Refine story</span>
        </div>
        <NativeStyleChatPanel
          messages={story.messages}
          stripState={stripStoryRefinementStateBlocks}
          persistKey={`feature-story-${story.id}`}
          draft={draft}
          setDraft={setDraft}
          isRunning={isRunning}
          loadingText="Codex is refining..."
          placeholder="Refine the story, description, or acceptance criteria..."
          onSend={onSend}
          onRefresh={onRefresh}
        />
      </div>
    </div>
  );
}
