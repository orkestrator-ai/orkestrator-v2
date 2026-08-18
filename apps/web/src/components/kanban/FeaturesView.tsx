import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  formatFeatureStoriesForBuild,
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
} from "@/lib/feature-planner";
import {
  composeDraftKey,
  discardComposeDraft,
  loadComposeDraft,
  persistComposeDraft,
} from "@/lib/compose-draft-persistence";
import { cn } from "@/lib/utils";
import {
  useCodexStore,
  useConfigStore,
  useFeaturePlanStore,
  useKanbanStore,
  useProjectStore,
} from "@/stores";
import { isActiveFeaturePlanningPhase } from "@/stores/featurePlanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { EnvironmentType } from "@/types";
import type {
  FeaturePlan,
  FeaturePlanMessage,
  FeaturePlanningRecord,
  FeatureStoryCard,
} from "@/stores/featurePlanStore";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";

type RightPaneTab = "chat" | "stories" | `story:${string}`;

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
      <div className="truncate text-sm font-medium text-foreground">
        {feature.title || "new feature"}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="capitalize">{feature.status}</span>
        {storyCount > 0 && (
          <span>
            {storyCount} stor{storyCount === 1 ? "y" : "ies"}
          </span>
        )}
      </div>
    </button>
  );
}

function getPreferredEnvironmentType(projectId: string): EnvironmentType {
  const config = useConfigStore.getState().config;
  const project = useProjectStore.getState().getProjectById(projectId);
  return (
    config.repositories[projectId]?.lastEnvironmentType ??
    (project?.localPath ? "local" : "containerized")
  );
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
  const chatDrafts = useFeaturePlanStore((state) => state.chatDrafts);
  const setChatDraft = useFeaturePlanStore((state) => state.setChatDraft);
  const startPlanning = useFeaturePlanStore((state) => state.startPlanning);
  const retryPlanning = useFeaturePlanStore((state) => state.retryPlanning);
  const cancelPlanning = useFeaturePlanStore((state) => state.cancelPlanning);
  const addTask = useKanbanStore((state) => state.addTask);
  const deleteTask = useKanbanStore((state) => state.deleteTask);
  const { startBuild } = useBuildPipeline();
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightPaneTab>("chat");
  const [openStoryTabs, setOpenStoryTabs] = useState<string[]>([]);
  const [buildingFeatureId, setBuildingFeatureId] = useState<string | null>(null);

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
      const operation =
        Object.keys(drafts).length === 0
          ? discardComposeDraft(draftKey)
          : persistComposeDraft(draftKey, "project", projectId, drafts);
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
          disposed ||
          !featureLoadSucceeded ||
          draftsChanged ||
          !persisted ||
          typeof persisted.value !== "object" ||
          !persisted.value
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
    () =>
      features
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
    () =>
      projectFeatures.find((feature) => feature.id === selectedFeatureId) ??
      projectFeatures[0] ??
      null,
    [projectFeatures, selectedFeatureId],
  );
  /**
   * The backend-owned planning exchanges for this project.
   *
   * Derived from the plans themselves — the record lives on the plan, so a
   * refetch triggered by any backend write is the whole rehydration path. There
   * is nothing here for an unmount to abandon.
   */
  const projectPlanning = useMemo(
    () =>
      projectFeatures
        .map((feature) => feature.planning)
        .filter((record): record is FeaturePlanningRecord => record !== undefined),
    [projectFeatures],
  );
  const runningPlanning =
    projectPlanning.find((record) => isActiveFeaturePlanningPhase(record.phase)) ?? null;
  const failedPlanning = projectPlanning.find((record) => record.phase === "failed") ?? null;
  // One planning turn at a time per project: they all share the plan's Codex
  // session, and a second turn would interleave with the first.
  const hasBlockingConversation = runningPlanning !== null || failedPlanning !== null;
  const hasRunningConversation = runningPlanning !== null;
  const failedFeature = failedPlanning
    ? projectFeatures.find((feature) => feature.id === failedPlanning.featureId)
    : undefined;
  const failedStory = failedPlanning?.storyId
    ? failedFeature?.stories.find((story) => story.id === failedPlanning.storyId)
    : undefined;
  const recoveryMessage = failedPlanning
    ? `${failedStory?.title || failedFeature?.title || "Feature conversation"}: ${
        failedPlanning.failure?.message || "Codex planning needs attention."
      }`
    : undefined;
  const featureDraft = selectedFeature
    ? (chatDrafts.get(featureChatDraftId(selectedFeature.id)) ?? "")
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

  /**
   * Hand a message to the backend planning supervisor.
   *
   * The renderer's whole job is now: clear the draft, ask, and let the record
   * come back through the plan snapshot. It creates no session, sends no
   * prompt, and waits for no reply — all of which used to die with this
   * component the moment the user clicked into an environment.
   */
  const sendFeatureMessage = useCallback(
    async (text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasBlockingConversation) return;
      const draftId = featureChatDraftId(feature.id);
      setChatDraft(draftId, "");
      const started = await startPlanning(feature.id, "feature", trimmed);
      if (started) return;
      setChatDraft(draftId, text);
      toast.error("Feature planning failed to start", {
        description: "The backend refused the planning request.",
      });
    },
    [hasBlockingConversation, selectedFeature, setChatDraft, startPlanning],
  );

  const sendStoryMessage = useCallback(
    async (story: FeatureStoryCard, text: string) => {
      const feature = selectedFeature;
      const trimmed = text.trim();
      if (!feature || !trimmed || hasBlockingConversation) return;
      const draftId = storyChatDraftId(feature.id, story.id);
      setChatDraft(draftId, "");
      const started = await startPlanning(feature.id, "story", trimmed, story.id);
      if (started) return;
      setChatDraft(draftId, text);
      toast.error("Story refinement failed to start", {
        description: "The backend refused the planning request.",
      });
    },
    [hasBlockingConversation, selectedFeature, setChatDraft, startPlanning],
  );

  /**
   * Re-read the authoritative snapshot.
   *
   * There is nothing to reconcile client-side any more, so "refresh" is a
   * refetch. The backend is already advancing whatever is in flight.
   */
  const refreshFeatures = useCallback(async () => {
    const refreshed = await loadFeatures(projectId);
    if (!refreshed) {
      toast.error("Failed to refresh feature planning", {
        description: "The latest backend state could not be loaded.",
      });
    }
  }, [loadFeatures, projectId]);

  const retryFailedPlanning = useCallback(
    async (record: FeaturePlanningRecord) => {
      const retried = await retryPlanning(record.featureId);
      if (!retried) {
        toast.error("Feature planning retry failed", {
          description: "The backend refused the retry request.",
        });
      }
    },
    [retryPlanning],
  );

  const abandonFailedPlanning = useCallback(
    async (record: FeaturePlanningRecord) => {
      const cancelled = await cancelPlanning(record.featureId);
      if (!cancelled) {
        toast.error("Failed to stop feature planning", {
          description: "The backend did not cancel the planning request.",
        });
      }
    },
    [cancelPlanning],
  );

  const openStory = useCallback((storyId: string) => {
    setOpenStoryTabs((tabs) => (tabs.includes(storyId) ? tabs : [...tabs, storyId]));
    setRightTab(`story:${storyId}`);
  }, []);

  const closeStoryTab = useCallback(
    (storyId: string) => {
      setOpenStoryTabs((tabs) => tabs.filter((id) => id !== storyId));
      if (rightTab === `story:${storyId}`) {
        setRightTab("stories");
      }
    },
    [rightTab],
  );

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
        buildingFeatureId ||
        hasBlockingConversation ||
        feature.status === "building" ||
        !!feature.buildTaskId ||
        !!feature.buildPipelineId ||
        feature.stories.length === 0
      )
        return;
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
                  const story = selectedFeature.stories.find(
                    (candidate) => candidate.id === storyId,
                  );
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
                    buildingFeatureId === selectedFeature.id ||
                    hasBlockingConversation ||
                    selectedFeature.status === "building" ||
                    !!selectedFeature.buildTaskId ||
                    !!selectedFeature.buildPipelineId
                  }
                  onClick={() => void handleBuildFeature(selectedFeature)}
                >
                  {buildingFeatureId === selectedFeature.id ||
                  selectedFeature.status === "building" ||
                  !!selectedFeature.buildTaskId ||
                  !!selectedFeature.buildPipelineId ? (
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
                onRetryRecovery={
                  failedPlanning ? () => retryFailedPlanning(failedPlanning) : undefined
                }
                onStopWaiting={
                  failedPlanning ? () => abandonFailedPlanning(failedPlanning) : undefined
                }
                onSend={sendFeatureMessage}
                onRefresh={refreshFeatures}
              />
            </TabsContent>

            <TabsContent value="stories" className={RIGHT_PANE_CONTENT_CLASS}>
              <FeatureStoriesPanel feature={selectedFeature} onOpenStory={openStory} />
            </TabsContent>

            {selectedStory && (
              <TabsContent value={`story:${selectedStory.id}`} className={RIGHT_PANE_CONTENT_CLASS}>
                <StoryDetailPanel
                  story={selectedStory}
                  draft={
                    chatDrafts.get(storyChatDraftId(selectedFeature.id, selectedStory.id)) ?? ""
                  }
                  setDraft={(value) =>
                    setChatDraft(storyChatDraftId(selectedFeature.id, selectedStory.id), value)
                  }
                  isRunning={hasRunningConversation}
                  isBlocked={hasBlockingConversation}
                  recoveryMessage={recoveryMessage}
                  onRetryRecovery={
                    failedPlanning ? () => retryFailedPlanning(failedPlanning) : undefined
                  }
                  onStopWaiting={
                    failedPlanning ? () => abandonFailedPlanning(failedPlanning) : undefined
                  }
                  onSend={(text) => void sendStoryMessage(selectedStory, text)}
                  onRefresh={refreshFeatures}
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
    () =>
      messages
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
                        <Button type="button" size="sm" variant="ghost" onClick={onStopWaiting}>
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
              {isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
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
              <h4 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                {story.title}
              </h4>
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
