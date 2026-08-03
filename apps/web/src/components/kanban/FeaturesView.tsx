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
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
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
  checkHealth,
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
import {
  composeDraftKey,
  discardComposeDraft,
  loadComposeDraft,
  persistComposeDraft,
} from "@/lib/compose-draft-persistence";
import { cn } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";
import { useCodexStore, useConfigStore, useEnvironmentStore, useFeaturePlanStore, useKanbanStore, useProjectStore } from "@/stores";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { Environment, EnvironmentType } from "@/types";
import type {
  ActiveFeatureConversation,
  FeatureConversationIdentity,
  FeaturePlan,
  FeaturePlanMessage,
  FeatureStoryCard,
} from "@/stores/featurePlanStore";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";

type RightPaneTab = "chat" | "stories" | `story:${string}`;

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const RECONCILE_MAX_STATUS_FAILURES = 4;
const RECONCILE_MAX_BACKOFF_MS = 12_000;
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

function createConversationOperationId(): string {
  return createUuid();
}

function conversationIdentity(
  conversation: ActiveFeatureConversation,
): FeatureConversationIdentity {
  return {
    featureId: conversation.featureId,
    operationId: conversation.operationId,
  };
}

function featureChatDraftId(featureId: string): string {
  return `feature:${featureId}`;
}

function storyChatDraftId(featureId: string, storyId: string): string {
  return `feature:${featureId}:story:${storyId}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReconcilePoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
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

interface FeatureAssistantReply {
  id: string;
  content: string;
  modelId?: string;
}

function latestAssistantMessage(
  messages: CodexMessage[],
  options: {
    excludeIds?: ReadonlySet<string>;
    accept?: (content: string) => boolean;
    createdAtOrAfter?: string;
  } = {},
): FeatureAssistantReply | null {
  const minimumCreatedAt = options.createdAtOrAfter
    ? Date.parse(options.createdAtOrAfter)
    : Number.NEGATIVE_INFINITY;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (options.excludeIds?.has(message.id)) continue;
    const createdAt = Date.parse(message.createdAt);
    if (options.createdAtOrAfter && (
      Number.isNaN(createdAt)
      || (!Number.isNaN(minimumCreatedAt) && createdAt < minimumCreatedAt)
    )) continue;
    const content = messageContent(message);
    if (content.trim() && (!options.accept || options.accept(content))) {
      return {
        id: message.id,
        content,
        ...(message.modelId ? { modelId: message.modelId } : {}),
      };
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
): Promise<FeatureAssistantReply | null> {
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
      return reply;
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
    modelId: message.modelId,
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

type PendingFeatureConversation = Omit<
  ActiveFeatureConversation,
  "operationId" | "error" | "responseContent"
>;

interface LocalConversationTarget {
  messages: FeaturePlanMessage[];
  userMessageIndex: number;
  story?: FeatureStoryCard;
}

function latestUnansweredConversation(feature: FeaturePlan): PendingFeatureConversation | null {
  const candidates: PendingFeatureConversation[] = [];
  const featureMessage = feature.messages.at(-1);
  if (
    featureMessage?.role === "user"
    && !Number.isNaN(Date.parse(featureMessage.createdAt))
  ) {
    candidates.push({
      featureId: feature.id,
      userMessageId: featureMessage.id,
      startedAt: featureMessage.createdAt,
      phase: "running",
    });
  }

  for (const story of feature.stories) {
    const storyMessage = story.messages.at(-1);
    if (
      storyMessage?.role !== "user"
      || Number.isNaN(Date.parse(storyMessage.createdAt))
    ) continue;
    candidates.push({
      featureId: feature.id,
      storyId: story.id,
      userMessageId: storyMessage.id,
      startedAt: storyMessage.createdAt,
      phase: "running",
    });
  }

  return candidates.sort((a, b) => {
    const aTime = Date.parse(a.startedAt);
    const bTime = Date.parse(b.startedAt);
    return bTime - aTime;
  })[0] ?? null;
}

type RecoverablePersistedConversation = Omit<
  ActiveFeatureConversation,
  "operationId" | "error"
>;

function latestUnappliedPersistedConversation(
  feature: FeaturePlan,
): RecoverablePersistedConversation | null {
  const candidates: RecoverablePersistedConversation[] = [];
  const featureAssistantIndex = feature.messages.findLastIndex((message) => (
    message.role === "assistant"
    && message.stateApplication === "pending"
    && parseFeaturePlannerState(message.content) !== null
  ));
  if (featureAssistantIndex >= 0) {
    const featureAssistant = feature.messages[featureAssistantIndex]!;
    const userMessage = feature.messages
      .slice(0, featureAssistantIndex)
      .findLast((message) => message.role === "user");
    if (userMessage && !Number.isNaN(Date.parse(userMessage.createdAt))) {
      candidates.push({
        featureId: feature.id,
        userMessageId: userMessage.id,
        startedAt: userMessage.createdAt,
        phase: "running",
        responseContent: featureAssistant.content,
        ...(featureAssistant.modelId ? { responseModelId: featureAssistant.modelId } : {}),
      });
    }
  }

  for (const story of feature.stories) {
    const storyAssistantIndex = story.messages.findLastIndex((message) => {
      if (message.role !== "assistant" || message.stateApplication !== "pending") {
        return false;
      }
      const parsed = parseStoryRefinement(message.content);
      return parsed !== null && (!parsed.storyId || parsed.storyId === story.id);
    });
    if (storyAssistantIndex < 0) continue;
    const storyAssistant = story.messages[storyAssistantIndex]!;
    const userMessage = story.messages
      .slice(0, storyAssistantIndex)
      .findLast((message) => message.role === "user");
    if (!userMessage || Number.isNaN(Date.parse(userMessage.createdAt))) continue;
    candidates.push({
      featureId: feature.id,
      storyId: story.id,
      userMessageId: userMessage.id,
      startedAt: userMessage.createdAt,
      phase: "running",
      responseContent: storyAssistant.content,
      ...(storyAssistant.modelId ? { responseModelId: storyAssistant.modelId } : {}),
    });
  }

  return candidates.sort(
    (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
  )[0] ?? null;
}

function findLocalConversationTarget(
  feature: FeaturePlan,
  conversation: ActiveFeatureConversation,
): LocalConversationTarget | null {
  const story = conversation.storyId
    ? feature.stories.find((candidate) => candidate.id === conversation.storyId)
    : undefined;
  if (conversation.storyId && !story) return null;
  const messages = story?.messages ?? feature.messages;
  const userMessageIndex = messages.findLastIndex((message) => (
    message.role === "user"
    && (
      conversation.userMessageId
        ? message.id === conversation.userMessageId
        : message.createdAt === conversation.startedAt
    )
  ));
  if (userMessageIndex < 0) return null;
  return { messages, userMessageIndex, story };
}

function persistedResponseAfterTarget(
  target: LocalConversationTarget,
  responseContent: string,
): FeaturePlanMessage | undefined {
  return target.messages
    .slice(target.userMessageIndex + 1)
    .find((message) => (
      message.role === "assistant"
      && message.content === responseContent
    ));
}

function latestPersistedResponseAfterTarget(
  target: LocalConversationTarget,
  conversation: ActiveFeatureConversation,
): FeatureAssistantReply | undefined {
  for (let index = target.messages.length - 1; index > target.userMessageIndex; index -= 1) {
    const message = target.messages[index];
    if (message?.role !== "assistant") continue;
    if (conversation.storyId) {
      const parsed = parseStoryRefinement(message.content);
      if (parsed && (!parsed.storyId || parsed.storyId === conversation.storyId)) {
        return {
          id: message.id,
          content: message.content,
          ...(message.modelId ? { modelId: message.modelId } : {}),
        };
      }
    } else if (parseFeaturePlannerState(message.content)) {
      return {
        id: message.id,
        content: message.content,
        ...(message.modelId ? { modelId: message.modelId } : {}),
      };
    }
  }
  return undefined;
}

function hasAssistantAfterTarget(target: LocalConversationTarget): boolean {
  return target.messages
    .slice(target.userMessageIndex + 1)
    .some((message) => message.role === "assistant");
}

function resolveStateApplications(
  feature: FeaturePlan,
  targetMessageId: string,
  targetState: "applied" | "superseded",
  stories: FeatureStoryCard[] = feature.stories,
): {
  messages: FeaturePlanMessage[];
  stories: FeatureStoryCard[];
  messagesChanged: boolean;
  storiesChanged: boolean;
} {
  let messagesChanged = false;
  const resolveMessages = (messages: FeaturePlanMessage[]) => messages.map((message) => {
    const stateApplication = message.id === targetMessageId
      ? targetState
      : message.stateApplication === "pending"
        ? "superseded"
        : message.stateApplication;
    if (stateApplication === message.stateApplication) return message;
    messagesChanged = true;
    return { ...message, stateApplication };
  });

  const messages = resolveMessages(feature.messages);
  const featureMessagesChanged = messagesChanged;
  let storiesChanged = false;
  const resolvedStories = stories.map((story) => {
    messagesChanged = false;
    const resolvedMessages = resolveMessages(story.messages);
    if (!messagesChanged) return story;
    storiesChanged = true;
    return { ...story, messages: resolvedMessages };
  });

  return {
    messages,
    stories: resolvedStories,
    messagesChanged: featureMessagesChanged,
    storiesChanged,
  };
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
  const claimFeatureBuild = useFeaturePlanStore((state) => state.claimFeatureBuild);
  const appendMessage = useFeaturePlanStore((state) => state.appendMessage);
  const appendStoryMessage = useFeaturePlanStore((state) => state.appendStoryMessage);
  const chatDrafts = useFeaturePlanStore((state) => state.chatDrafts);
  const setChatDraft = useFeaturePlanStore((state) => state.setChatDraft);
  const currentProjectId = useFeaturePlanStore((state) => state.currentProjectId);
  const activeConversations = useFeaturePlanStore((state) => state.activeConversations);
  const startConversation = useFeaturePlanStore((state) => state.startConversation);
  const updateConversation = useFeaturePlanStore((state) => state.updateConversation);
  const markConversationRunning = useFeaturePlanStore(
    (state) => state.markConversationRunning,
  );
  const resumeConversation = useFeaturePlanStore((state) => state.resumeConversation);
  const claimConversationPersistence = useFeaturePlanStore(
    (state) => state.claimConversationPersistence,
  );
  const settleConversation = useFeaturePlanStore((state) => state.settleConversation);
  const addTask = useKanbanStore((state) => state.addTask);
  const deleteTask = useKanbanStore((state) => state.deleteTask);
  const { startBuild } = useBuildPipeline();
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightPaneTab>("chat");
  const [openStoryTabs, setOpenStoryTabs] = useState<string[]>([]);
  const [buildingFeatureId, setBuildingFeatureId] = useState<string | null>(null);
  const clientsRef = useRef<Map<string, CodexClient>>(new Map());
  const reconciledProjectRef = useRef<string | null>(null);
  const reconciliationControllersRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    let disposed = false;
    let hydrated = false;
    let draftReadSucceeded = false;
    let draftsChanged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draftKey = composeDraftKey("feature-chat", projectId, "all");
    const featureLoadPromise = loadFeatures(projectId);

    const projectDrafts = () => {
      const state = useFeaturePlanStore.getState();
      const featureIds = new Set(
        state.features
          .filter((feature) => feature.projectId === projectId)
          .map((feature) => feature.id),
      );
      return Object.fromEntries(
        Array.from(state.chatDrafts.entries()).filter(([key]) => {
          const featureId = key.split(":")[1];
          return featureId !== undefined && featureIds.has(featureId);
        }),
      );
    };

    const persistCurrentDrafts = () => {
      const drafts = projectDrafts();
      const operation = Object.keys(drafts).length === 0
        ? discardComposeDraft(draftKey)
        : persistComposeDraft(
            draftKey,
            "project",
            projectId,
            drafts,
          );
      draftsChanged = false;
      void operation.catch((error) => {
        console.warn("[FeaturesView] Failed to persist chat drafts:", error);
      });
    };

    const schedule = () => {
      if (!hydrated || disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        persistCurrentDrafts();
      }, 400);
    };

    const unsubscribe = useFeaturePlanStore.subscribe((state, previous) => {
      if (state.chatDrafts !== previous.chatDrafts) {
        draftsChanged = true;
      }
      if (state.chatDrafts !== previous.chatDrafts || state.features !== previous.features) {
        schedule();
      }
    });

    void loadComposeDraft<Record<string, string>>(draftKey)
      .then(async (persisted) => {
        draftReadSucceeded = true;
        const featureLoadSucceeded = await featureLoadPromise;
        if (
          disposed
          || !featureLoadSucceeded
          || draftsChanged
          || !persisted
          || typeof persisted.value !== "object"
          || !persisted.value
        ) {
          return;
        }
        for (const [key, value] of Object.entries(persisted.value)) {
          if (typeof value === "string" && !useFeaturePlanStore.getState().chatDrafts.has(key)) {
            useFeaturePlanStore.getState().setChatDraft(key, value);
          }
        }
      })
      .catch((error) => {
        console.warn("[FeaturesView] Failed to restore chat drafts:", error);
      })
      .finally(async () => {
        const featureLoadSucceeded = await featureLoadPromise;
        if (disposed || !featureLoadSucceeded) return;
        if (draftReadSucceeded || draftsChanged) {
          hydrated = true;
          schedule();
        }
      });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (draftsChanged) persistCurrentDrafts();
    };
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
  const projectActiveConversations = useMemo(
    () => projectFeatures
      .map((feature) => activeConversations.get(feature.id))
      .filter((conversation): conversation is ActiveFeatureConversation => conversation !== undefined),
    [activeConversations, projectFeatures],
  );
  const hasBlockingConversation = projectActiveConversations.length > 0;
  const hasRunningConversation = projectActiveConversations.some(
    (conversation) => conversation.phase !== "unavailable",
  );
  const unavailableConversation = projectActiveConversations.find(
    (conversation) => conversation.phase === "unavailable",
  ) ?? null;
  const unavailableFeature = unavailableConversation
    ? projectFeatures.find((feature) => feature.id === unavailableConversation.featureId)
    : undefined;
  const unavailableStory = unavailableConversation?.storyId
    ? unavailableFeature?.stories.find((story) => story.id === unavailableConversation.storyId)
    : undefined;
  const recoveryMessage = unavailableConversation
    ? `${unavailableStory?.title || unavailableFeature?.title || "Feature conversation"}: ${
      unavailableConversation.error || "Codex recovery requires attention."
    }`
    : undefined;
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
      if (client && !await checkHealth(client)) {
        clientsRef.current.delete(environment.id);
        client = undefined;
      }
      if (!client) {
        let port: number | null = null;
        let authToken: string | undefined;
        if (environment.environmentType === "local") {
          const status = await backend.getLocalCodexServerStatus(environment.id);
          if (!status.running) return null;
          port = status.port ?? null;
          authToken = status.authToken;
        } else {
          if (!environment.containerId) return null;
          const status = await backend.getCodexServerStatus(environment.containerId);
          if (!status.running) return null;
          port = status.hostPort ?? null;
          authToken = status.authToken;
        }

        if (!port || !authToken) return null;
        client = createClient(`http://127.0.0.1:${port}`, authToken);
        clientsRef.current.set(environment.id, client);
      }

      return { client, sessionId: feature.codexSessionId };
    },
    [],
  );

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
      if (client && !await checkHealth(client)) {
        clientsRef.current.delete(environment.id);
        client = undefined;
      }
      if (!client) {
        let port: number | null = null;
        let authToken: string | undefined;
        if (environment.environmentType === "local") {
          let status = await backend.getLocalCodexServerStatus(environment.id);
          if (!status.running || !status.authToken) {
            const result = await backend.startLocalCodexServer(environment.id);
            status = {
              running: true,
              port: result.port,
              pid: result.pid,
              authToken: result.authToken,
            };
          }
          port = status.port ?? null;
          authToken = status.authToken;
        } else {
          if (!environment.containerId) {
            throw new Error("Container ID is required for feature planning in a container");
          }
          let status = await backend.getCodexServerStatus(environment.containerId);
          if (!status.running || !status.authToken) {
            const result = await backend.startCodexServer(environment.containerId);
            status = {
              running: true,
              hostPort: result.hostPort,
              authToken: result.authToken,
            };
          }
          port = status.hostPort ?? null;
          authToken = status.authToken;
        }

        if (!port || !authToken) throw new Error("Failed to resolve authenticated Codex bridge");
        client = createClient(`http://127.0.0.1:${port}`, authToken);
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
    async (
      feature: FeaturePlan,
      assistantContent: string,
      responseMessageId?: string,
    ) => {
      const parsed = parseFeaturePlannerState(assistantContent);
      const updates: Parameters<typeof updateFeature>[1] = {};
      const preserveLaterBuildState = feature.status === "building" || feature.status === "built";
      let nextStories = feature.stories;

      if (parsed && !preserveLaterBuildState) {
        if (parsed.title?.trim()) updates.title = parsed.title.trim();
        if (parsed.summary !== undefined) updates.summary = parsed.summary;
        if (parsed.phase === "collecting") updates.status = "collecting";
        if (parsed.phase === "confirming") updates.status = "confirming";
        if (parsed.phase === "stories") {
          updates.status = "stories";
          nextStories = createStoryCardsFromParsedState(parsed, feature.stories);
          updates.stories = nextStories;
          setRightTab("stories");
        }
      }

      if (responseMessageId) {
        const resolved = resolveStateApplications(
          feature,
          responseMessageId,
          preserveLaterBuildState ? "superseded" : "applied",
          nextStories,
        );
        if (resolved.messagesChanged) updates.messages = resolved.messages;
        if (resolved.storiesChanged || nextStories !== feature.stories) {
          updates.stories = resolved.stories;
        }
      }

      if (Object.keys(updates).length > 0) {
        const updated = await updateFeature(feature.id, updates);
        if (!updated) throw new Error("Failed to persist the feature planning state");
      }
    },
    [updateFeature],
  );

  const persistFeatureConversationResponse = useCallback(
    async (
      feature: FeaturePlan,
      conversation: ActiveFeatureConversation,
      assistantContent: string,
      modelId?: string,
    ) => {
      const currentFeature = useFeaturePlanStore.getState().features.find(
        (candidate) => candidate.id === feature.id,
      ) ?? feature;
      const target = findLocalConversationTarget(currentFeature, conversation);
      if (!target) throw new Error("The feature planning request is no longer available.");

      let updatedFeature = currentFeature;
      let responseMessage = persistedResponseAfterTarget(target, assistantContent);
      if (!responseMessage) {
        const updated = modelId
          ? await appendMessage(
              currentFeature.id,
              "assistant",
              assistantContent,
              "pending",
              modelId,
            )
          : await appendMessage(
              currentFeature.id,
              "assistant",
              assistantContent,
              "pending",
            );
        if (!updated) throw new Error("Failed to persist the feature planning response");
        updatedFeature = updated;
        responseMessage = updated.messages.at(-1);
      }
      if (!responseMessage) {
        throw new Error("Failed to identify the persisted feature planning response");
      }
      await applyFeaturePlannerState(
        updatedFeature,
        assistantContent,
        responseMessage.id,
      );
    },
    [appendMessage, applyFeaturePlannerState],
  );

  const sendFeatureMessage = useCallback(
    async (text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasBlockingConversation) return;

      let conversationStartedAt = new Date().toISOString();
      let conversation: ActiveFeatureConversation = {
        operationId: createConversationOperationId(),
        featureId: feature.id,
        startedAt: conversationStartedAt,
        phase: "dispatching",
      };
      if (!startConversation(conversation)) return;
      setChatDraft(featureChatDraftId(feature.id), "");
      let userMessagePersisted = false;
      let preserveConversation = false;
      try {
        const withUserMessage = await appendMessage(feature.id, "user", trimmed);
        if (!withUserMessage) throw new Error("Failed to persist the feature message");
        userMessagePersisted = true;
        const persistedUserMessage = withUserMessage.messages.at(-1);
        conversationStartedAt = persistedUserMessage?.createdAt ?? conversationStartedAt;
        if (!updateConversation(conversationIdentity(conversation), {
          userMessageId: persistedUserMessage?.id,
          startedAt: conversationStartedAt,
        })) return;
        conversation = {
          ...conversation,
          userMessageId: persistedUserMessage?.id,
          startedAt: conversationStartedAt,
        };
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
        if (!markConversationRunning(conversationIdentity(conversation))) {
          preserveConversation = true;
          return;
        }

        const assistantReply = await waitForCodexReply(
          client,
          sessionId,
          assistantMessageIds(baselineMessages),
        );
        if (!assistantReply) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: "Codex is still working. Check again to resume monitoring or stop waiting.",
          });
          toast.warning("Codex is still working", {
            description: "The feature chat was persisted. Use Check again when you return.",
          });
          return;
        }

        if (!claimConversationPersistence(
          conversationIdentity(conversation),
          assistantReply.content,
          assistantReply.modelId,
        )) {
          preserveConversation = true;
          return;
        }
        await persistFeatureConversationResponse(
          latestFeature,
          conversation,
          assistantReply.content,
          assistantReply.modelId,
        );
      } catch (error) {
        if (!userMessagePersisted) setChatDraft(featureChatDraftId(feature.id), text);
        const activeConversation = useFeaturePlanStore.getState()
          .activeConversations.get(feature.id);
        if (
          activeConversation?.operationId === conversation.operationId
          && activeConversation.phase === "persisting"
        ) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: error instanceof Error
              ? error.message
              : "Failed to persist the Codex response.",
          });
        }
        console.error("[FeaturesView] Failed to send feature message:", error);
        toast.error("Feature planning failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (!preserveConversation) {
          settleConversation(conversationIdentity(conversation));
        }
      }
    },
    [
      appendMessage,
      claimConversationPersistence,
      ensureCodexSession,
      hasBlockingConversation,
      markConversationRunning,
      persistFeatureConversationResponse,
      selectedFeature,
      setChatDraft,
      settleConversation,
      startConversation,
      updateConversation,
    ],
  );

  const refreshFeatureChat = useCallback(
    async (feature: FeaturePlan) => {
      if (
        !feature.codexEnvironmentId
        || !feature.codexSessionId
        || hasBlockingConversation
      ) return;
      const pendingConversation = latestUnansweredConversation(feature);
      const pendingFeatureConversation = pendingConversation?.storyId
        ? null
        : pendingConversation;
      const conversation: ActiveFeatureConversation = {
        operationId: createConversationOperationId(),
        ...(pendingFeatureConversation ?? {
          featureId: feature.id,
          startedAt: new Date().toISOString(),
          phase: "running" as const,
        }),
      };
      if (!startConversation(conversation)) return;
      let preserveConversation = false;
      try {
        const { client, sessionId } = await ensureCodexSession(feature);
        const messages = await getSessionMessages(client, sessionId);
        const assistantReply = latestAssistantMessage(messages, {
          createdAtOrAfter: pendingFeatureConversation?.startedAt,
          accept: (content) => parseFeaturePlannerState(content) !== null,
        });
        if (assistantReply && pendingFeatureConversation) {
          if (!claimConversationPersistence(
            conversationIdentity(conversation),
            assistantReply.content,
            assistantReply.modelId,
          )) {
            preserveConversation = true;
            return;
          }
          await persistFeatureConversationResponse(
            feature,
            conversation,
            assistantReply.content,
            assistantReply.modelId,
          );
        } else if (assistantReply) {
          const persistedAssistantContents = new Set(
            feature.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.content),
          );
          if (
            !persistedAssistantContents.has(assistantReply.content)
            && updateConversation(conversationIdentity(conversation), {})
          ) {
            const updated = assistantReply.modelId
              ? await appendMessage(
                  feature.id,
                  "assistant",
                  assistantReply.content,
                  "pending",
                  assistantReply.modelId,
                )
              : await appendMessage(
                  feature.id,
                  "assistant",
                  assistantReply.content,
                  "pending",
                );
            if (!updated) throw new Error("Failed to persist the refreshed feature response");
            if (!updateConversation(conversationIdentity(conversation), {})) return;
            const responseMessage = updated.messages.at(-1);
            if (!responseMessage) {
              throw new Error("Failed to identify the refreshed feature response");
            }
            await applyFeaturePlannerState(
              updated,
              assistantReply.content,
              responseMessage.id,
            );
          }
        }
      } catch (error) {
        const activeConversation = useFeaturePlanStore.getState()
          .activeConversations.get(feature.id);
        if (
          activeConversation?.operationId === conversation.operationId
          && activeConversation.phase === "persisting"
        ) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: error instanceof Error
              ? error.message
              : "Failed to persist the refreshed Codex response.",
          });
        }
        console.error("[FeaturesView] Failed to refresh feature chat:", error);
        toast.error("Failed to refresh feature chat", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (!preserveConversation) {
          settleConversation(conversationIdentity(conversation));
        }
      }
    },
    [
      appendMessage,
      applyFeaturePlannerState,
      claimConversationPersistence,
      ensureCodexSession,
      hasBlockingConversation,
      persistFeatureConversationResponse,
      settleConversation,
      startConversation,
      updateConversation,
    ],
  );

  const applyStoryRefinement = useCallback(
    async (
      feature: FeaturePlan,
      story: FeatureStoryCard,
      assistantContent: string,
      responseMessageId?: string,
    ) => {
      const parsed = parseStoryRefinement(assistantContent);
      if (parsed?.storyId && parsed.storyId !== story.id) {
        throw new Error("Story refinement response targeted a different story");
      }

      let stories = feature.stories;
      if (parsed) {
        stories = stories.map((candidate) => {
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
      }
      const resolved = responseMessageId
        ? resolveStateApplications(feature, responseMessageId, "applied", stories)
        : null;
      const updates: Parameters<typeof updateFeature>[1] = {
        stories: resolved?.stories ?? stories,
        ...(resolved?.messagesChanged ? { messages: resolved.messages } : {}),
      };
      const updated = await updateFeature(feature.id, updates);
      if (!updated) throw new Error("Failed to persist the refined story");
    },
    [updateFeature],
  );

  const persistStoryConversationResponse = useCallback(
    async (
      feature: FeaturePlan,
      conversation: ActiveFeatureConversation,
      assistantContent: string,
      modelId?: string,
    ) => {
      const currentFeature = useFeaturePlanStore.getState().features.find(
        (candidate) => candidate.id === feature.id,
      ) ?? feature;
      const target = findLocalConversationTarget(currentFeature, conversation);
      if (!target?.story) throw new Error("The story refinement request is no longer available.");

      let updatedFeature = currentFeature;
      let updatedStory = target.story;
      let responseMessage = persistedResponseAfterTarget(target, assistantContent);
      if (!responseMessage) {
        const updated = modelId
          ? await appendStoryMessage(
              currentFeature.id,
              target.story.id,
              "assistant",
              assistantContent,
              "pending",
              modelId,
            )
          : await appendStoryMessage(
              currentFeature.id,
              target.story.id,
              "assistant",
              assistantContent,
              "pending",
            );
        if (!updated) throw new Error("Failed to persist the story refinement response");
        updatedFeature = updated;
        updatedStory = updated.stories.find(
          (candidate) => candidate.id === target.story?.id,
        ) ?? target.story;
        responseMessage = updatedStory.messages.at(-1);
      }
      if (!responseMessage) {
        throw new Error("Failed to identify the persisted story refinement response");
      }
      await applyStoryRefinement(
        updatedFeature,
        updatedStory,
        assistantContent,
        responseMessage.id,
      );
    },
    [appendStoryMessage, applyStoryRefinement],
  );

  const hydrateRestoredConversation = useCallback(
    async (
      feature: FeaturePlan,
      conversation: ActiveFeatureConversation,
      client: CodexClient | null,
      sessionId: string | null,
    ): Promise<"hydrated" | "missing" | "claimed-elsewhere"> => {
      const currentConversation = useFeaturePlanStore.getState()
        .activeConversations.get(conversation.featureId);
      if (currentConversation?.operationId !== conversation.operationId) {
        return "claimed-elsewhere";
      }

      const localTarget = findLocalConversationTarget(feature, conversation);
      let assistantReply: FeatureAssistantReply | undefined = currentConversation.responseContent
        ? {
            id: "active-conversation-response",
            content: currentConversation.responseContent,
            ...(currentConversation.responseModelId
              ? { modelId: currentConversation.responseModelId }
              : {}),
          }
        : (localTarget
            ? latestPersistedResponseAfterTarget(localTarget, conversation)
            : undefined);
      if (!assistantReply) {
        if (!client || !sessionId) return "missing";
        const messages = await getSessionMessages(client, sessionId, { throwOnError: true });
        if (conversation.storyId) {
          const story = feature.stories.find(
            (candidate) => candidate.id === conversation.storyId,
          );
          if (!story) throw new Error("The story being refined no longer exists.");
          assistantReply = latestAssistantMessage(messages, {
            createdAtOrAfter: conversation.startedAt,
            accept: (content) => {
              const parsed = parseStoryRefinement(content);
              return parsed !== null && (!parsed.storyId || parsed.storyId === story.id);
            },
          }) ?? undefined;
        } else {
          assistantReply = latestAssistantMessage(messages, {
            createdAtOrAfter: conversation.startedAt,
            accept: (content) => parseFeaturePlannerState(content) !== null,
          }) ?? undefined;
        }
      }
      if (!assistantReply) return "missing";
      if (!claimConversationPersistence(
        conversationIdentity(conversation),
        assistantReply.content,
        assistantReply.modelId,
      )) {
        return "claimed-elsewhere";
      }

      if (conversation.storyId) {
        await persistStoryConversationResponse(
          feature,
          conversation,
          assistantReply.content,
          assistantReply.modelId,
        );
      } else {
        await persistFeatureConversationResponse(
          feature,
          conversation,
          assistantReply.content,
          assistantReply.modelId,
        );
      }
      return "hydrated";
    },
    [
      claimConversationPersistence,
      persistFeatureConversationResponse,
      persistStoryConversationResponse,
    ],
  );

  const runRestoredConversationMonitor = useCallback(
    async (
      conversation: ActiveFeatureConversation,
      deferHydrationToLiveWorker: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const identity = conversationIdentity(conversation);
      let consecutiveFailures = 0;
      let idleWithoutReplySince: number | null = null;
      let missingTargetSince: number | null = null;

      while (!signal.aborted) {
        const currentConversation = useFeaturePlanStore.getState()
          .activeConversations.get(conversation.featureId);
        if (currentConversation?.operationId !== conversation.operationId) return;
        if (currentConversation.phase === "unavailable") return;
        if (currentConversation.phase === "persisting") {
          await waitForReconcilePoll(POLL_INTERVAL_MS, signal);
          continue;
        }

        const feature = useFeaturePlanStore.getState().features.find(
          (candidate) => candidate.id === conversation.featureId,
        );
        if (!feature) {
          settleConversation(identity);
          return;
        }
        const target = findLocalConversationTarget(feature, currentConversation);
        if (!target) {
          if (deferHydrationToLiveWorker) {
            missingTargetSince ??= Date.now();
            if (Date.now() - missingTargetSince < IDLE_WITHOUT_REPLY_TIMEOUT_MS) {
              await waitForReconcilePoll(POLL_INTERVAL_MS, signal);
              continue;
            }
            updateConversation(identity, {
              phase: "unavailable",
              error: "The persisted user message is not available yet. Check again or stop waiting.",
            });
          } else {
            settleConversation(identity);
          }
          return;
        }
        missingTargetSince = null;

        const localResponse = currentConversation.responseContent
          ?? latestPersistedResponseAfterTarget(target, currentConversation);
        if (localResponse) {
          if (!markConversationRunning(identity)) return;
          try {
            const hydrated = await hydrateRestoredConversation(
              feature,
              currentConversation,
              null,
              null,
            );
            if (hydrated === "hydrated") settleConversation(identity);
          } catch (error) {
            const activeConversation = useFeaturePlanStore.getState()
              .activeConversations.get(conversation.featureId);
            if (activeConversation?.operationId !== conversation.operationId) return;
            console.error("[FeaturesView] Failed to restore Codex conversation:", error);
            updateConversation(identity, {
              phase: "unavailable",
              error: error instanceof Error
                ? error.message
                : "Failed to restore the Codex response.",
            });
          }
          return;
        }
        if (hasAssistantAfterTarget(target)) {
          settleConversation(identity);
          return;
        }

        let existingSession: { client: CodexClient; sessionId: string } | null = null;
        let status = null;
        try {
          existingSession = await getExistingCodexSession(feature);
          if (!existingSession) {
            throw new Error("The existing Codex session is not currently reachable.");
          }
          if (signal.aborted) return;
          status = await getSessionStatus(
            existingSession.client,
            existingSession.sessionId,
            { throwOnError: true },
          );
          if (!status) throw new Error("Codex returned no session status.");
          consecutiveFailures = 0;
        } catch (error) {
          const activeConversation = useFeaturePlanStore.getState()
            .activeConversations.get(conversation.featureId);
          if (
            signal.aborted
            || activeConversation?.operationId !== conversation.operationId
            || activeConversation.phase === "persisting"
          ) return;
          if (feature.codexEnvironmentId) {
            clientsRef.current.delete(feature.codexEnvironmentId);
          }
          consecutiveFailures += 1;
          if (consecutiveFailures >= RECONCILE_MAX_STATUS_FAILURES) {
            updateConversation(identity, {
              phase: "unavailable",
              error: "Codex status is unavailable. Check again or stop waiting before sending another prompt.",
            });
            return;
          }
          const retryDelay = Math.min(
            POLL_INTERVAL_MS * (2 ** (consecutiveFailures - 1)),
            RECONCILE_MAX_BACKOFF_MS,
          );
          await waitForReconcilePoll(retryDelay, signal);
          continue;
        }
        if (signal.aborted) return;
        const activeConversation = useFeaturePlanStore.getState()
          .activeConversations.get(conversation.featureId);
        if (activeConversation?.operationId !== conversation.operationId) return;
        if (activeConversation.phase === "unavailable") return;
        if (activeConversation.phase === "persisting") {
          await waitForReconcilePoll(POLL_INTERVAL_MS, signal);
          continue;
        }
        const latestFeature = useFeaturePlanStore.getState().features.find(
          (candidate) => candidate.id === conversation.featureId,
        );
        if (!latestFeature) {
          settleConversation(identity);
          return;
        }
        const latestTarget = findLocalConversationTarget(
          latestFeature,
          activeConversation,
        );
        if (!latestTarget) {
          settleConversation(identity);
          return;
        }
        if (
          !activeConversation.responseContent
          && !latestPersistedResponseAfterTarget(latestTarget, activeConversation)
          && hasAssistantAfterTarget(latestTarget)
        ) {
          settleConversation(identity);
          return;
        }

        if (status.status === "running") {
          idleWithoutReplySince = null;
          markConversationRunning(identity);
          await waitForReconcilePoll(POLL_INTERVAL_MS, signal);
          continue;
        }

        if (status.status === "error") {
          updateConversation(identity, {
            phase: "unavailable",
            error: status.error?.trim()
              || "The Codex session ended with an error. Check again or stop waiting.",
          });
          return;
        }

        if (deferHydrationToLiveWorker) {
          idleWithoutReplySince ??= Date.now();
          if (Date.now() - idleWithoutReplySince < IDLE_WITHOUT_REPLY_TIMEOUT_MS) {
            await waitForReconcilePoll(POLL_INTERVAL_MS, signal);
            continue;
          }
        }

        if (!markConversationRunning(identity)) return;
        const conversationForHydration = useFeaturePlanStore.getState()
          .activeConversations.get(conversation.featureId);
        if (conversationForHydration?.operationId !== conversation.operationId) return;
        try {
          const hydrated = await hydrateRestoredConversation(
            latestFeature,
            conversationForHydration,
            existingSession.client,
            existingSession.sessionId,
          );
          if (hydrated === "hydrated") {
            settleConversation(identity);
          } else if (hydrated === "missing") {
            updateConversation(identity, {
              phase: "unavailable",
              error: "Codex is idle, but no matching response was found. Check again or stop waiting.",
            });
          }
        } catch (error) {
          const latestConversation = useFeaturePlanStore.getState()
            .activeConversations.get(conversation.featureId);
          if (latestConversation?.operationId !== conversation.operationId) return;
          if (signal.aborted && latestConversation.phase !== "persisting") return;
          console.error("[FeaturesView] Failed to restore Codex conversation:", error);
          updateConversation(identity, {
            phase: "unavailable",
            error: error instanceof Error
              ? error.message
              : "Failed to restore the Codex response.",
          });
        }
        return;
      }
    },
    [
      getExistingCodexSession,
      hydrateRestoredConversation,
      markConversationRunning,
      settleConversation,
      updateConversation,
    ],
  );

  const startReconciliationMonitor = useCallback(
    (
      conversation: ActiveFeatureConversation,
      deferHydrationToLiveWorker: boolean,
    ) => {
      if (reconciliationControllersRef.current.has(conversation.operationId)) return;
      const controller = new AbortController();
      reconciliationControllersRef.current.set(conversation.operationId, controller);
      void runRestoredConversationMonitor(
        conversation,
        deferHydrationToLiveWorker,
        controller.signal,
      ).finally(() => {
        if (reconciliationControllersRef.current.get(conversation.operationId) === controller) {
          reconciliationControllersRef.current.delete(conversation.operationId);
        }
      });
    },
    [runRestoredConversationMonitor],
  );

  useEffect(() => {
    if (isLoading || currentProjectId !== projectId) return;
    if (reconciledProjectRef.current === projectId) return;

    let cancelled = false;
    const startTimer = setTimeout(() => {
      if (cancelled) return;
      const state = useFeaturePlanStore.getState();
      if (state.isLoading || state.currentProjectId !== projectId) return;
      if (reconciledProjectRef.current === projectId) return;
      reconciledProjectRef.current = projectId;

      for (const feature of state.features) {
        if (feature.projectId !== projectId) continue;
        const pendingConversation = latestUnansweredConversation(feature);
        const persistedRecovery = pendingConversation
          ? null
          : latestUnappliedPersistedConversation(feature);
        const desiredConversation = pendingConversation ?? persistedRecovery;
        let cachedConversation = state.activeConversations.get(feature.id);
        if (
          cachedConversation
          && desiredConversation
          && (
            cachedConversation.storyId !== desiredConversation.storyId
            || (
              cachedConversation.userMessageId
                ? cachedConversation.userMessageId !== desiredConversation.userMessageId
                : cachedConversation.startedAt !== desiredConversation.startedAt
            )
          )
        ) {
          reconciliationControllersRef.current
            .get(cachedConversation.operationId)
            ?.abort();
          settleConversation(conversationIdentity(cachedConversation));
          cachedConversation = undefined;
        }
        if (!cachedConversation && !desiredConversation) continue;

        const conversation = cachedConversation ?? {
          ...desiredConversation!,
          operationId: createConversationOperationId(),
        };
        if (!cachedConversation && !startConversation(conversation)) continue;
        if (conversation.phase === "unavailable") continue;
        if (
          !conversation.responseContent
          && (!feature.codexEnvironmentId || !feature.codexSessionId)
        ) {
          updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: "The persisted request has no Codex session to resume. Stop waiting before sending it again.",
          });
          continue;
        }
        startReconciliationMonitor(conversation, cachedConversation !== undefined);
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      for (const controller of reconciliationControllersRef.current.values()) {
        controller.abort();
      }
      reconciliationControllersRef.current.clear();
    };
  }, [
    currentProjectId,
    isLoading,
    projectId,
    settleConversation,
    startConversation,
    startReconciliationMonitor,
    updateConversation,
  ]);

  const retryUnavailableConversation = useCallback(
    (conversation: ActiveFeatureConversation) => {
      if (
        conversation.phase !== "unavailable"
        || !resumeConversation(conversationIdentity(conversation))
      ) return;
      reconciliationControllersRef.current.get(conversation.operationId)?.abort();
      reconciliationControllersRef.current.delete(conversation.operationId);
      startReconciliationMonitor(
        { ...conversation, phase: "running", error: undefined },
        false,
      );
    },
    [resumeConversation, startReconciliationMonitor],
  );

  const stopWaitingForConversation = useCallback(
    (conversation: ActiveFeatureConversation) => {
      reconciliationControllersRef.current.get(conversation.operationId)?.abort();
      settleConversation(conversationIdentity(conversation));
    },
    [settleConversation],
  );

  const sendStoryMessage = useCallback(
    async (story: FeatureStoryCard, text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasBlockingConversation) return;

      let conversationStartedAt = new Date().toISOString();
      let conversation: ActiveFeatureConversation = {
        operationId: createConversationOperationId(),
        featureId: feature.id,
        storyId: story.id,
        startedAt: conversationStartedAt,
        phase: "dispatching",
      };
      if (!startConversation(conversation)) return;
      setChatDraft(storyChatDraftId(feature.id, story.id), "");
      let userMessagePersisted = false;
      let preserveConversation = false;
      try {
        const withUserMessage = await appendStoryMessage(feature.id, story.id, "user", trimmed);
        if (!withUserMessage) throw new Error("Failed to persist the story message");
        userMessagePersisted = true;
        const persistedStory = withUserMessage.stories.find((candidate) => candidate.id === story.id);
        const persistedUserMessage = persistedStory?.messages.at(-1);
        conversationStartedAt = persistedUserMessage?.createdAt ?? conversationStartedAt;
        if (!updateConversation(conversationIdentity(conversation), {
          userMessageId: persistedUserMessage?.id,
          startedAt: conversationStartedAt,
        })) return;
        conversation = {
          ...conversation,
          userMessageId: persistedUserMessage?.id,
          startedAt: conversationStartedAt,
        };
        const latestFeature = withUserMessage;
        const latestStory = latestFeature.stories.find((candidate) => candidate.id === story.id) ?? story;
        const { client, sessionId } = await ensureCodexSession(latestFeature);
        const baselineMessages = await getSessionMessages(client, sessionId);
        const prompt = createStoryRefinementPrompt(latestStory, trimmed);
        const sent = await sendPrompt(client, sessionId, prompt);
        if (!wasCodexPromptAccepted(sent)) {
          throw new Error("Failed to send story refinement prompt");
        }
        if (!markConversationRunning(conversationIdentity(conversation))) {
          preserveConversation = true;
          return;
        }

        const assistantReply = await waitForCodexReply(
          client,
          sessionId,
          assistantMessageIds(baselineMessages),
        );
        if (!assistantReply) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: "Codex is still refining this story. Check again to resume monitoring or stop waiting.",
          });
          toast.warning("Codex is still refining the story", {
            description: "The refinement request was persisted. Use Check again when you return.",
          });
          return;
        }

        if (!claimConversationPersistence(
          conversationIdentity(conversation),
          assistantReply.content,
          assistantReply.modelId,
        )) {
          preserveConversation = true;
          return;
        }
        await persistStoryConversationResponse(
          latestFeature,
          conversation,
          assistantReply.content,
          assistantReply.modelId,
        );
      } catch (error) {
        if (!userMessagePersisted) {
          setChatDraft(storyChatDraftId(feature.id, story.id), text);
        }
        const activeConversation = useFeaturePlanStore.getState()
          .activeConversations.get(feature.id);
        if (
          activeConversation?.operationId === conversation.operationId
          && activeConversation.phase === "persisting"
        ) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: error instanceof Error
              ? error.message
              : "Failed to persist the Codex response.",
          });
        }
        console.error("[FeaturesView] Failed to send story message:", error);
        toast.error("Story refinement failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (!preserveConversation) {
          settleConversation(conversationIdentity(conversation));
        }
      }
    },
    [
      appendStoryMessage,
      claimConversationPersistence,
      ensureCodexSession,
      hasBlockingConversation,
      markConversationRunning,
      persistStoryConversationResponse,
      selectedFeature,
      setChatDraft,
      settleConversation,
      startConversation,
      updateConversation,
    ],
  );

  const refreshStoryChat = useCallback(
    async (feature: FeaturePlan, story: FeatureStoryCard) => {
      if (
        !feature.codexEnvironmentId
        || !feature.codexSessionId
        || hasBlockingConversation
      ) return;
      const latestStoryMessage = story.messages.at(-1);
      const pendingStoryConversation = (
        latestStoryMessage?.role === "user"
        && !Number.isNaN(Date.parse(latestStoryMessage.createdAt))
      )
        ? {
            featureId: feature.id,
            storyId: story.id,
            userMessageId: latestStoryMessage.id,
            startedAt: latestStoryMessage.createdAt,
            phase: "running" as const,
          }
        : null;
      const conversation: ActiveFeatureConversation = {
        operationId: createConversationOperationId(),
        ...(pendingStoryConversation ?? {
          featureId: feature.id,
          storyId: story.id,
          startedAt: new Date().toISOString(),
          phase: "running" as const,
        }),
      };
      if (!startConversation(conversation)) return;
      let preserveConversation = false;
      try {
        const { client, sessionId } = await ensureCodexSession(feature);
        const messages = await getSessionMessages(client, sessionId);
        const assistantReply = latestAssistantMessage(messages, {
          createdAtOrAfter: pendingStoryConversation?.startedAt,
          accept: (content) => {
            const parsed = parseStoryRefinement(content);
            return parsed !== null && (!parsed.storyId || parsed.storyId === story.id);
          },
        });
        if (assistantReply && pendingStoryConversation) {
          if (!claimConversationPersistence(
            conversationIdentity(conversation),
            assistantReply.content,
            assistantReply.modelId,
          )) {
            preserveConversation = true;
            return;
          }
          await persistStoryConversationResponse(
            feature,
            conversation,
            assistantReply.content,
            assistantReply.modelId,
          );
        } else if (assistantReply) {
          const persistedAssistantContents = new Set(
            story.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.content),
          );
          if (
            !persistedAssistantContents.has(assistantReply.content)
            && updateConversation(conversationIdentity(conversation), {})
          ) {
            const updated = assistantReply.modelId
              ? await appendStoryMessage(
                  feature.id,
                  story.id,
                  "assistant",
                  assistantReply.content,
                  "pending",
                  assistantReply.modelId,
                )
              : await appendStoryMessage(
                  feature.id,
                  story.id,
                  "assistant",
                  assistantReply.content,
                  "pending",
                );
            if (!updated) throw new Error("Failed to persist the refreshed story response");
            if (!updateConversation(conversationIdentity(conversation), {})) return;
            const updatedStory = updated.stories.find(
              (candidate) => candidate.id === story.id,
            ) ?? story;
            const responseMessage = updatedStory.messages.at(-1);
            if (!responseMessage) {
              throw new Error("Failed to identify the refreshed story response");
            }
            await applyStoryRefinement(
              updated,
              updatedStory,
              assistantReply.content,
              responseMessage.id,
            );
          }
        }
      } catch (error) {
        const activeConversation = useFeaturePlanStore.getState()
          .activeConversations.get(feature.id);
        if (
          activeConversation?.operationId === conversation.operationId
          && activeConversation.phase === "persisting"
        ) {
          preserveConversation = updateConversation(conversationIdentity(conversation), {
            phase: "unavailable",
            error: error instanceof Error
              ? error.message
              : "Failed to persist the refreshed Codex response.",
          });
        }
        console.error("[FeaturesView] Failed to refresh story chat:", error);
        toast.error("Failed to refresh story chat", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (!preserveConversation) {
          settleConversation(conversationIdentity(conversation));
        }
      }
    },
    [
      appendStoryMessage,
      applyStoryRefinement,
      claimConversationPersistence,
      ensureCodexSession,
      hasBlockingConversation,
      persistStoryConversationResponse,
      settleConversation,
      startConversation,
      updateConversation,
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
      if (
        buildingFeatureId
        || hasBlockingConversation
        || feature.status === "building"
        || !!feature.buildTaskId
        || !!feature.buildPipelineId
        || feature.stories.length === 0
      ) return;
      setBuildingFeatureId(feature.id);
      let ownsBuildReservation = false;
      let unreservedTaskId: string | null = null;
      try {
        const taskDetails = formatFeatureStoriesForBuild(feature);
        const taskId = await addTask(projectId, taskDetails.title, taskDetails.description);
        if (!taskId) throw new Error("Failed to create Kanban task for feature build");
        unreservedTaskId = taskId;

        const task = useKanbanStore.getState().tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("Created build task was not found in the Kanban store");

        // Persist the feature→task half of the launch before navigation can
        // unmount this view. A restarted client now sees an in-progress feature
        // instead of offering a duplicate build while the pipeline is being
        // created.
        const reservation = await claimFeatureBuild(feature.id, taskId);
        if (!reservation) {
          await deleteTask(taskId);
          unreservedTaskId = null;
          throw new Error("Failed to reserve the feature build");
        }
        if (!reservation.claimed) {
          await deleteTask(taskId);
          unreservedTaskId = null;
          toast.error("This feature already has an active build");
          return;
        }
        ownsBuildReservation = true;
        unreservedTaskId = null;

        await startBuild(task, getPreferredEnvironmentType(projectId), "codex", {
          existingEnvironmentId: feature.codexEnvironmentId,
          featurePlanId: feature.id,
        });
        const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(taskId);
        if (!pipeline || pipeline.phase === "failed") {
          // startBuild surfaces its own error toast and clears or fails the
          // pipeline when it cannot start. Undo the durable reservation so the
          // feature does not remain stuck in "building" with no live pipeline.
          await updateFeature(feature.id, {
            status: feature.status,
            buildTaskId: feature.buildTaskId,
            buildPipelineId: feature.buildPipelineId,
          }).catch(() => undefined);
          ownsBuildReservation = false;
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
        if (unreservedTaskId) {
          await deleteTask(unreservedTaskId);
        }
        if (ownsBuildReservation) {
          await updateFeature(feature.id, {
            status: feature.status,
            buildTaskId: feature.buildTaskId,
            buildPipelineId: feature.buildPipelineId,
          }).catch(() => undefined);
        }
        toast.error("Failed to start feature build", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setBuildingFeatureId(null);
      }
    },
    [
      addTask,
      buildingFeatureId,
      claimFeatureBuild,
      deleteTask,
      hasBlockingConversation,
      projectId,
      startBuild,
      updateFeature,
    ],
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
                  disabled={
                    buildingFeatureId === selectedFeature.id
                    || hasBlockingConversation
                    || selectedFeature.status === "building"
                    || !!selectedFeature.buildTaskId
                    || !!selectedFeature.buildPipelineId
                  }
                  onClick={() => void handleBuildFeature(selectedFeature)}
                >
                  {buildingFeatureId === selectedFeature.id
                    || selectedFeature.status === "building"
                    || !!selectedFeature.buildTaskId
                    || !!selectedFeature.buildPipelineId ? (
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
                isBlocked={hasBlockingConversation}
                recoveryMessage={recoveryMessage}
                onRetryRecovery={unavailableConversation
                  ? () => retryUnavailableConversation(unavailableConversation)
                  : undefined}
                onStopWaiting={unavailableConversation
                  ? () => stopWaitingForConversation(unavailableConversation)
                  : undefined}
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
                  isBlocked={hasBlockingConversation}
                  recoveryMessage={recoveryMessage}
                  onRetryRecovery={unavailableConversation
                    ? () => retryUnavailableConversation(unavailableConversation)
                    : undefined}
                  onStopWaiting={unavailableConversation
                    ? () => stopWaitingForConversation(unavailableConversation)
                    : undefined}
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
  isBlocked,
  recoveryMessage,
  onRetryRecovery,
  onStopWaiting,
  onSend,
  onRefresh,
}: {
  feature: FeaturePlan;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  isBlocked: boolean;
  recoveryMessage?: string;
  onRetryRecovery?: () => void;
  onStopWaiting?: () => void;
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
      isBlocked={isBlocked}
      recoveryMessage={recoveryMessage}
      onRetryRecovery={onRetryRecovery}
      onStopWaiting={onStopWaiting}
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
  isBlocked = isRunning,
  recoveryMessage,
  onRetryRecovery,
  onStopWaiting,
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
  isBlocked?: boolean;
  recoveryMessage?: string;
  onRetryRecovery?: () => void;
  onStopWaiting?: () => void;
  loadingText: string;
  placeholder: string;
  onSend: (text: string) => void;
  onRefresh?: () => void;
}) {
  const models = useCodexStore((state) => state.models);
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, models),
    [models],
  );
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
    if (!trimmed || isBlocked) return;
    onSend(draft);
  }, [draft, isBlocked, onSend]);

  return (
    <div className="@container relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <VirtualizedMessageList
          messages={nativeMessages}
          computeItemKey={(_index, message) => message.id}
          resolvePreviousMessage={findPreviousNativeMessage}
          renderMessage={(_index, message, previousMessage) => (
            <NativeMessage
              message={message}
              previousMessage={previousMessage}
              assistantLabel="Codex"
              agentExpansionScope={persistKey}
              resolveModelLabel={resolveModelLabel}
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
              {recoveryMessage && (
                <div className="px-2 @sm:px-4 py-3">
                  <div
                    role="alert"
                    className="mx-auto max-w-3xl rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
                  >
                    <p>{recoveryMessage}</p>
                    <div className="mt-2 flex gap-2">
                      {onRetryRecovery && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={onRetryRecovery}
                        >
                          Check again
                        </Button>
                      )}
                      {onStopWaiting && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={onStopWaiting}
                        >
                          Stop waiting
                        </Button>
                      )}
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
                disabled={isBlocked}
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
              disabled={!draft.trim() || isBlocked}
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
  isBlocked,
  recoveryMessage,
  onRetryRecovery,
  onStopWaiting,
  onSend,
  onRefresh,
}: {
  story: FeatureStoryCard;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  isBlocked: boolean;
  recoveryMessage?: string;
  onRetryRecovery?: () => void;
  onStopWaiting?: () => void;
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
          isBlocked={isBlocked}
          recoveryMessage={recoveryMessage}
          onRetryRecovery={onRetryRecovery}
          onStopWaiting={onStopWaiting}
          loadingText="Codex is refining..."
          placeholder="Refine the story, description, or acceptance criteria..."
          onSend={onSend}
          onRefresh={onRefresh}
        />
      </div>
    </div>
  );
}
