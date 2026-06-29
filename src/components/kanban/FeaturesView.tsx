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
import type { FeaturePlan, FeaturePlanMessage, FeatureStoryCard } from "@/stores/featurePlanStore";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";

type RightPaneTab = "chat" | "stories" | `story:${string}`;

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const RIGHT_PANE_CONTENT_CLASS =
  "h-full min-h-0 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col";
const COMPACT_TAB_LIST_CLASS = "h-8 bg-zinc-900/80";
const COMPACT_TAB_TRIGGER_CLASS = "px-2 text-xs data-[state=active]:!bg-zinc-800";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageContent(message: CodexMessage): string {
  if (message.content?.trim()) return message.content;
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n")
    .trim();
}

function latestAssistantContent(messages: CodexMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = messageContent(message);
    if (content.trim()) return content;
  }
  return null;
}

async function waitForCodexReply(client: CodexClient, sessionId: string): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const status = await getSessionStatus(client, sessionId);
    const messages = await getSessionMessages(client, sessionId);

    if (status?.status === "error") {
      throw new Error(status.error || "Codex planning session failed");
    }

    if (status?.status === "idle") {
      return latestAssistantContent(messages);
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

interface FeaturesViewProps {
  projectId: string;
}

export function FeaturesView({ projectId }: FeaturesViewProps) {
  const features = useFeaturePlanStore((state) => state.features);
  const loadFeatures = useFeaturePlanStore((state) => state.loadFeatures);
  const createFeature = useFeaturePlanStore((state) => state.createFeature);
  const updateFeature = useFeaturePlanStore((state) => state.updateFeature);
  const appendMessage = useFeaturePlanStore((state) => state.appendMessage);
  const appendStoryMessage = useFeaturePlanStore((state) => state.appendStoryMessage);
  const addTask = useKanbanStore((state) => state.addTask);
  const updateTask = useKanbanStore((state) => state.updateTask);
  const { startBuild } = useBuildPipeline();
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightPaneTab>("chat");
  const [openStoryTabs, setOpenStoryTabs] = useState<string[]>([]);
  const [featureDraft, setFeatureDraft] = useState("");
  const [storyDrafts, setStoryDrafts] = useState<Record<string, string>>({});
  const [runningFeatureId, setRunningFeatureId] = useState<string | null>(null);
  const [runningStoryId, setRunningStoryId] = useState<string | null>(null);
  const [buildingFeatureId, setBuildingFeatureId] = useState<string | null>(null);
  const clientsRef = useRef<Map<string, CodexClient>>(new Map());

  useEffect(() => {
    void loadFeatures(projectId);
  }, [loadFeatures, projectId]);

  const projectFeatures = useMemo(
    () => features.filter((feature) => feature.projectId === projectId),
    [features, projectId],
  );

  const selectedFeature = useMemo(
    () => projectFeatures.find((feature) => feature.id === selectedFeatureId) ?? projectFeatures[0] ?? null,
    [projectFeatures, selectedFeatureId],
  );

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

  const selectedStory = useMemo(() => {
    if (!selectedFeature || !rightTab.startsWith("story:")) return null;
    const storyId = rightTab.slice("story:".length);
    return selectedFeature.stories.find((story) => story.id === storyId) ?? null;
  }, [rightTab, selectedFeature]);

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
        workingFeature = await updateFeature(feature.id, { codexEnvironmentId: environment.id }) ?? workingFeature;
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

      workingFeature = await updateFeature(workingFeature.id, { codexSessionId: created.sessionId }) ?? workingFeature;
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
        await updateFeature(feature.id, updates);
      }
    },
    [updateFeature],
  );

  const sendFeatureMessage = useCallback(
    async (text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || runningFeatureId) return;

      setFeatureDraft("");
      setRunningFeatureId(feature.id);
      try {
        const withUserMessage = await appendMessage(feature.id, "user", trimmed);
        const latestFeature = withUserMessage ?? feature;
        const previousSessionId = latestFeature.codexSessionId;
        const { client, sessionId } = await ensureCodexSession(latestFeature);
        const prompt = selectFeaturePlannerPrompt({
          feature: latestFeature,
          userMessage: trimmed,
          previousSessionId,
          sessionId,
        });

        const sent = await sendPrompt(client, sessionId, prompt);
        if (!sent) throw new Error("Failed to send feature planning prompt");

        const assistantContent = await waitForCodexReply(client, sessionId);
        if (!assistantContent) {
          toast.warning("Codex is still working", {
            description: "The feature chat was persisted. Use refresh when you return.",
          });
          return;
        }

        const updated = await appendMessage(feature.id, "assistant", assistantContent);
        await applyFeaturePlannerState(updated ?? latestFeature, assistantContent);
      } catch (error) {
        console.error("[FeaturesView] Failed to send feature message:", error);
        toast.error("Feature planning failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setRunningFeatureId(null);
      }
    },
    [appendMessage, applyFeaturePlannerState, ensureCodexSession, runningFeatureId, selectedFeature],
  );

  const refreshFeatureChat = useCallback(
    async (feature: FeaturePlan) => {
      if (!feature.codexEnvironmentId || !feature.codexSessionId || runningFeatureId) return;
      setRunningFeatureId(feature.id);
      try {
        const { client, sessionId } = await ensureCodexSession(feature);
        const messages = await getSessionMessages(client, sessionId);
        const assistantContent = latestAssistantContent(messages);
        const persistedLastAssistant = [...feature.messages].reverse().find((message) => message.role === "assistant")?.content;
        if (assistantContent && assistantContent !== persistedLastAssistant) {
          const updated = await appendMessage(feature.id, "assistant", assistantContent);
          await applyFeaturePlannerState(updated ?? feature, assistantContent);
        }
      } catch (error) {
        console.error("[FeaturesView] Failed to refresh feature chat:", error);
        toast.error("Failed to refresh feature chat", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setRunningFeatureId(null);
      }
    },
    [appendMessage, applyFeaturePlannerState, ensureCodexSession, runningFeatureId],
  );

  const sendStoryMessage = useCallback(
    async (story: FeatureStoryCard, text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || runningStoryId) return;

      setStoryDrafts((drafts) => ({ ...drafts, [story.id]: "" }));
      setRunningStoryId(story.id);
      try {
        const withUserMessage = await appendStoryMessage(feature.id, story.id, "user", trimmed);
        const latestFeature = withUserMessage ?? feature;
        const latestStory = latestFeature.stories.find((candidate) => candidate.id === story.id) ?? story;
        const { client, sessionId } = await ensureCodexSession(latestFeature);
        const prompt = createStoryRefinementPrompt(latestStory, trimmed);
        const sent = await sendPrompt(client, sessionId, prompt);
        if (!sent) throw new Error("Failed to send story refinement prompt");

        const assistantContent = await waitForCodexReply(client, sessionId);
        if (!assistantContent) {
          toast.warning("Codex is still refining the story", {
            description: "The refinement request was persisted. Use refresh when you return.",
          });
          return;
        }

        const withAssistantMessage = await appendStoryMessage(feature.id, story.id, "assistant", assistantContent);
        const parsed = parseStoryRefinement(assistantContent);
        if (!parsed) return;

        const featureForUpdate = withAssistantMessage ?? latestFeature;
        const stories = featureForUpdate.stories.map((candidate) => {
          if (candidate.id !== story.id) return candidate;
          return {
            ...candidate,
            title: parsed.title?.trim() || candidate.title,
            description: parsed.description?.trim() || candidate.description,
            acceptanceCriteria: parsed.acceptanceCriteria?.length ? parsed.acceptanceCriteria : candidate.acceptanceCriteria,
            updatedAt: new Date().toISOString(),
          };
        });
        await updateFeature(feature.id, { stories });
      } catch (error) {
        console.error("[FeaturesView] Failed to send story message:", error);
        toast.error("Story refinement failed", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setRunningStoryId(null);
      }
    },
    [appendStoryMessage, ensureCodexSession, runningStoryId, selectedFeature, updateFeature],
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

        await updateTask(taskId, { acceptanceCriteria: taskDetails.acceptanceCriteria });
        const task = useKanbanStore.getState().tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("Created build task was not found in the Kanban store");

        await startBuild(task, getPreferredEnvironmentType(projectId), "codex");
        const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(taskId);
        await updateFeature(feature.id, {
          status: "building",
          buildTaskId: taskId,
          buildPipelineId: pipeline?.id,
        });
      } catch (error) {
        console.error("[FeaturesView] Failed to start feature build:", error);
        toast.error("Failed to start feature build", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setBuildingFeatureId(null);
      }
    },
    [addTask, buildingFeatureId, projectId, startBuild, updateFeature, updateTask],
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
                Create a feature to start discovery.
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedFeature ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a feature.
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
                      className={cn(COMPACT_TAB_TRIGGER_CLASS, "group gap-1.5")}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {formatStoryTabTitle(story)}
                      <span
                        role="button"
                        tabIndex={0}
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
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
                setDraft={setFeatureDraft}
                isRunning={runningFeatureId === selectedFeature.id}
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
                  draft={storyDrafts[selectedStory.id] ?? ""}
                  setDraft={(value) => setStoryDrafts((drafts) => ({ ...drafts, [selectedStory.id]: value }))}
                  isRunning={runningStoryId === selectedStory.id}
                  onSend={(text) => void sendStoryMessage(selectedStory, text)}
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

function NativeStyleChatPanel({
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
}: {
  story: FeatureStoryCard;
  draft: string;
  setDraft: (value: string) => void;
  isRunning: boolean;
  onSend: (text: string) => void;
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
        />
      </div>
    </div>
  );
}
