import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCheck,
  ExternalLink,
  GitPullRequest,
  History,
  PackageCheck,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  isActiveBuildPhase,
  isSupersededPipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { flowAttemptKey, useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { useOptionalTerminalContext, type CreateTabOptions } from "@/contexts/TerminalContext";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { usePullRequest } from "@/hooks/usePullRequest";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { modelsForAgent } from "@/lib/agent-launch";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FlowNodeModel } from "@/components/flow-graph/FlowGraph";
import { FlowInspectorHeader, FlowInspectorPanel } from "@/components/flow-graph/FlowInspector";
import { defaultFlowSelection } from "@/components/flow-graph/flow-graph-model";
import { reviewerStatusNote } from "@/components/review/multi-review-steps";
import { ReviewValidationStatus } from "@/components/review/ReviewValidationStatus";
import { WorkflowResultStatus } from "@/components/review/WorkflowResultStatus";
import {
  pipelineFlowModel,
  pipelinePackageRestartStageId,
  pipelineReviewPassNodes,
  pipelineSkipAction,
  type PipelineFlowModel,
  type PipelineFlowNode,
} from "./pipeline-flow";
import { PipelineFlowGraph, pipelineNodeView } from "./PipelineFlowGraph";
import { PipelinePullRequestView, usePipelinePullRequest } from "./PipelinePullRequestView";
import {
  PipelineSessionTranscript,
  pipelineAcceptsMessages,
  reviewReportSession,
} from "./PipelineSessionTranscript";
import { PipelineTicketView } from "./PipelineTicketView";
import { PipelineAddressReport } from "./PipelineAddressReport";
import { usePipelineCodeRewind } from "./PipelineCodeRewindDialog";
import type { PipelineControls } from "./usePipelineControls";

const NO_CLOCK_SUBSCRIPTION = () => {};

/**
 * The wall clock behind the graph's live durations, as an external store: it
 * is re-read when a subscription starts and on every one-second tick, and
 * holds still in between so the snapshot is stable.
 */
function createDisplayClock() {
  let now = Date.now();
  return {
    getSnapshot: () => now,
    subscribe: (onChange: () => void) => {
      const tick = () => {
        now = Date.now();
        onChange();
      };
      tick();
      const interval = window.setInterval(tick, 1_000);
      return () => window.clearInterval(interval);
    },
  };
}

/** One thing a node lets the user do, in its context menu and its inspector. */
export interface PipelineNodeAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Pipeline-wide controls sit after the node's own actions. */
  pipelineWide?: boolean;
}

/** A tab attached to a pipeline stage's own provider session. */
export function pipelineSessionTabOptions(
  pipeline: Pick<BuildPipeline, "id">,
  node: Pick<PipelineFlowNode, "title" | "session">,
): CreateTabOptions | null {
  const session = node.session;
  if (!session?.sdkSessionId) return null;
  return {
    tabId: `build-pipeline-session:${pipeline.id}:${session.sessionKey}`,
    activateExistingTab: true,
    agentLaunchMode: "native",
    resumeSessionId: session.sdkSessionId,
    displayTitle: `Pipeline · ${node.title}`,
    isReviewTab: session.phase === "review",
    hideStructuredOutput: true,
    initialAgentModel: session.model,
    initialReasoningEffort: session.reasoningEffort,
    initialConversationMode: "build",
    // The pipeline owns this session. Seeding a fresh one in its place would
    // show an empty tab that looks like the pipeline's work.
    requireExistingResumeSession: true,
  };
}

/** A pipeline narrowed to one review pass: its preparation, reviewers and consolidation. */
export function reviewPassModel(model: PipelineFlowModel, passKey: string): PipelineFlowModel {
  const nodes = pipelineReviewPassNodes(model, passKey);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    columns: model.columns
      .map((column) => ({ ...column, nodeIds: column.nodeIds.filter((id) => ids.has(id)) }))
      .filter((column) => column.nodeIds.length > 0),
    edges: model.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}

export interface PipelineFlowViewProps {
  pipeline: BuildPipeline;
  environmentId: string;
  isActive: boolean;
  ownsGlobalShortcuts: boolean;
  controls: PipelineControls;
  /** The node the user picked; null follows the pipeline. */
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  /** Shows one review pass only (a review opened on its own). */
  passKey?: string;
  /** Forces a layout; otherwise the measured width decides. */
  layout?: "graph" | "stacked";
  /** Rendered above the graph, e.g. the tab's banners. */
  notices?: ReactNode;
  /** The error already rendered in this view's notices, to avoid repeating it. */
  visibleError?: string;
}

/**
 * The pipeline as a left-to-right flow graph with an inspector below it.
 *
 * The graph is a projection of the pipeline record; selection, zoom, pan and
 * whether the graph is collapsed are view state and never reach the record.
 * A node opens in the inspector on a click, and its session opens in a tab of
 * its own on a double click.
 */
export function PipelineFlowView({
  pipeline,
  environmentId,
  isActive,
  ownsGlobalShortcuts,
  controls,
  pinnedId,
  onPin,
  passKey,
  layout,
  notices,
  visibleError,
}: PipelineFlowViewProps) {
  const panelId = `${useId()}inspector`;
  const graphId = `${panelId}-graph`;
  const [tabRoot, setTabRoot] = useState<HTMLDivElement | null>(null);
  const createTab = useOptionalTerminalContext()?.createTab;
  const containerId =
    useEnvironmentStore((state) => state.getEnvironmentById(environmentId)?.containerId) ??
    undefined;
  const setViewedSessionId = useBuildPipelineStore((state) => state.setViewedSessionId);
  const modelCatalog = useReviewModelCatalog(pipeline.projectId, true);
  const pullRequest = usePipelinePullRequest(environmentId);
  const { viewPR } = usePullRequest({ environmentId });
  const viewKey = passKey ? `${pipeline.id}\u0000${passKey}` : pipeline.id;
  const collapsed = useFlowGraphViewStore((state) => state.collapsed.has(viewKey));
  const setCollapsed = useFlowGraphViewStore((state) => state.setCollapsed);
  const expandedAttemptKeys = useFlowGraphViewStore((state) => state.expandedAttempts);
  const setAttemptExpanded = useFlowGraphViewStore((state) => state.setAttemptExpanded);
  const [inspectorTab, setInspectorTab] = useState<Record<string, string>>({});

  // Previous attempts the reader expanded; the rest stay one node each.
  const expandedAttempts = useMemo(
    () =>
      new Set(
        [
          ...pipeline.sessions.flatMap((session) =>
            session.supersededBy ? [session.supersededBy] : [],
          ),
          ...(pipeline.rewinds ?? []).map((rewind) => rewind.id),
        ].filter((id) => expandedAttemptKeys.has(flowAttemptKey(pipeline.id, id))),
      ),
    [expandedAttemptKeys, pipeline.id, pipeline.sessions, pipeline.rewinds],
  );
  const fullModel = useMemo(
    () => pipelineFlowModel(pipeline, pullRequest, { expandedAttempts }),
    [pipeline, pullRequest, expandedAttempts],
  );
  const model = useMemo(
    () => (passKey ? reviewPassModel(fullModel, passKey) : fullModel),
    [fullModel, passKey],
  );

  const [displayClock] = useState(createDisplayClock);
  const live = model.nodes.some((node) => node.state === "running");
  const subscribeDisplayClock = useCallback(
    (onChange: () => void) =>
      !isActive || !live ? NO_CLOCK_SUBSCRIPTION : displayClock.subscribe(onChange),
    [displayClock, isActive, live],
  );
  const now = useSyncExternalStore(subscribeDisplayClock, displayClock.getSnapshot);

  // The running step, else the last step reached; a node the user picked
  // wins while it exists.
  const columnOf = new Map<string, number>();
  model.columns.forEach((column, index) => {
    for (const id of column.nodeIds) columnOf.set(id, index);
  });
  const pendingRetry =
    pipeline.phase === "reviewing" && !model.nodes.some((node) => node.state === "running")
      ? model.nodes.find((node) => node.reviewer?.status === "pending" && node.earlierAttempts)
      : undefined;
  const followed =
    pendingRetry?.id ??
    defaultFlowSelection(
      model.nodes
        .filter((node) => !node.session?.superseded && !node.superseded)
        .map((node) => ({
          id: node.id,
          state: node.placeholder ? "not-started" : node.state,
          stage: columnOf.get(node.id) ?? 0,
          activityAt: node.activityAt,
        })),
    ) ??
    model.nodes[0]?.id;
  const selected =
    model.nodes.find((node) => node.id === pinnedId) ??
    model.nodes.find((node) => node.id === followed) ??
    model.nodes[0];
  const selectedSessionId = selected?.session?.sdkSessionId ?? null;
  // The shell's info pane reads which stage session is on screen.
  useEffect(() => {
    if (isActive && ownsGlobalShortcuts) setViewedSessionId(pipeline.id, selectedSessionId);
  }, [isActive, ownsGlobalShortcuts, pipeline.id, selectedSessionId, setViewedSessionId]);

  const modelLabel = (agent: string, model: string | undefined) =>
    model
      ? isAgentPlatform(agent)
        ? resolveCatalogModelLabel(model, modelsForAgent(modelCatalog, agent))
        : model
      : "Provider default";

  const active = isActiveBuildPhase(pipeline.phase);
  const paused = pipeline.phase === "paused";
  // A superseded session is history even while the index still names it.
  const indexedSession = pipeline.sessions[pipeline.currentSessionIndex];
  const currentSession = isSupersededPipelineSession(indexedSession) ? undefined : indexedSession;
  const interactionFailure =
    pipeline.phase === "failed" && pipeline.failureContext?.kind === "interactive-request";
  const canRetryStage =
    pipeline.phase === "failed" && Boolean(pipeline.failureContext) && !interactionFailure;
  const retryReviewPhase = paused
    ? pipeline.pausedFromPhase
    : pipeline.phase === "failed"
      ? pipeline.failureContext?.phase
      : pipeline.phase;
  const canRetryReviewer =
    retryReviewPhase === "reviewing" &&
    !interactionFailure &&
    Boolean(pipeline.reviewFanout) &&
    !pipeline.reviewFanout?.report;
  const shipped = pipeline.sessions.some((session) => session.phase === "pr");

  const openSession = (node: PipelineFlowNode) => {
    const options = pipelineSessionTabOptions(pipeline, node);
    if (!options || !createTab || !node.session) return;
    createTab(node.session.agent ?? pipeline.agentType, options);
  };
  const openReview = (key: string) => {
    if (!createTab) return;
    createTab("multi-review", {
      multiReviewId: pipeline.id,
      multiReviewPipelinePass: key,
      displayTitle: `Review · ${pipeline.taskTitle}`,
    });
  };

  const codeRewind = usePipelineCodeRewind(pipeline.id, controls.rewindCode, controls.pending);

  const toggleAttempt = (attemptId: string, expanded: boolean) =>
    setAttemptExpanded(pipeline.id, attemptId, expanded);
  /** Selects a step of a previous attempt, expanding the attempt to show it. */
  const showAttemptStep = (attemptId: string, sessionKey: string) => {
    toggleAttempt(attemptId, true);
    onPin(sessionKey);
  };

  const actionsFor = (node: PipelineFlowNode): PipelineNodeAction[] => {
    const actions: PipelineNodeAction[] = [];
    const disabled = controls.pending;
    if (node.kind === "attempt" && node.attemptId) {
      const attemptId = node.attemptId;
      actions.push(
        node.attemptExpanded
          ? {
              key: "collapse-attempt",
              label: "Hide steps",
              icon: ChevronsDownUp,
              onSelect: () => toggleAttempt(attemptId, false),
            }
          : {
              key: "expand-attempt",
              label: "Show steps",
              icon: ChevronsUpDown,
              onSelect: () => toggleAttempt(attemptId, true),
            },
      );
    }
    if (node.session && createTab) {
      actions.push({
        key: "open",
        label: node.kind === "fix" ? "Open Fix session" : "Open session",
        icon: ExternalLink,
        onSelect: () => openSession(node),
      });
    }
    if (node.passKey && !passKey && createTab && !node.placeholder) {
      actions.push({
        key: "open-review",
        label: "Open review as Multi Review",
        icon: ClipboardCheck,
        onSelect: () => openReview(node.passKey!),
      });
    }
    if (node.superseded) {
      // History: readable, never retried or restarted from.
    } else if (canRetryReviewer && node.reviewer?.status === "failed" && node.state === "failed") {
      actions.push({
        key: "retry-reviewer",
        label: "Retry reviewer",
        icon: RefreshCw,
        disabled,
        onSelect: () => controls.retryReviewer(node.reviewer!.id),
      });
    } else if (
      canRetryStage &&
      !node.validationRun &&
      node.state === "failed" &&
      !node.reviewer &&
      (!node.session || node.session === currentSession || node.kind === "consolidation")
    ) {
      actions.push({
        key: "retry-stage",
        label: "Retry failed step",
        icon: RefreshCw,
        disabled,
        onSelect: () => controls.retryStage(),
      });
    }
    if (node.session && !node.placeholder && !node.superseded) {
      actions.push({
        key: "restart",
        label: "Restart from here",
        icon: RotateCcw,
        disabled,
        onSelect: () => controls.restartStage(node.session!.sdkSessionId),
      });
    } else if (
      node.hasValidation &&
      !node.session &&
      !node.superseded &&
      pipeline.validationRun &&
      node.id === `validation:${pipeline.validationRun.id}`
    ) {
      actions.push({
        key: "restart",
        label: "Restart validation",
        icon: RotateCcw,
        disabled,
        onSelect: () => controls.restartStage(node.id),
      });
    }
    const packageRestart = pipelinePackageRestartStageId(pipeline, node);
    if (packageRestart) {
      actions.push({
        key: "restart-package",
        label: "Prepare package again",
        icon: PackageCheck,
        disabled,
        onSelect: () => controls.restartStage(packageRestart),
      });
    }
    if (node.session?.headAtStart && !node.placeholder && !node.superseded) {
      const stageId = node.session.sessionKey;
      actions.push({
        key: "rewind-code",
        label: "Rewind code to here…",
        icon: History,
        disabled,
        onSelect: () => codeRewind.open(stageId, node.title),
      });
    }
    const skip = pipelineSkipAction(pipeline, node);
    if (skip) {
      actions.push({
        key: "skip",
        label: skip.label,
        icon: SkipForward,
        disabled,
        onSelect: () => controls.skipStage(skip.stageId),
      });
    }
    if (node.kind === "pr" && pullRequest && shipped) {
      actions.push({
        key: "view-pr",
        label: "View PR",
        icon: GitPullRequest,
        onSelect: () => void viewPR(),
      });
    }
    if (active) {
      actions.push({
        key: "pause",
        label: "Pause pipeline",
        icon: Pause,
        disabled,
        pipelineWide: true,
        onSelect: controls.pause,
      });
    }
    if (paused) {
      actions.push({
        key: "resume",
        label: "Resume pipeline",
        icon: Play,
        disabled,
        pipelineWide: true,
        onSelect: controls.resume,
      });
    }
    if (active || paused) {
      actions.push({
        key: "cancel",
        label: "Cancel pipeline",
        icon: Square,
        disabled,
        pipelineWide: true,
        onSelect: controls.cancel,
      });
    }
    return actions;
  };

  const contextMenuFor = (actions: PipelineNodeAction[]) => {
    const own = actions.filter((action) => !action.pipelineWide);
    const wide = actions.filter((action) => action.pipelineWide);
    const item = (action: PipelineNodeAction) => (
      <ContextMenuItem key={action.key} disabled={action.disabled} onSelect={action.onSelect}>
        <action.icon />
        {action.label}
      </ContextMenuItem>
    );
    if (own.length === 0 && wide.length === 0) {
      return <ContextMenuItem disabled>No actions</ContextMenuItem>;
    }
    return (
      <>
        {own.map(item)}
        {own.length > 0 && wide.length > 0 ? <ContextMenuSeparator /> : null}
        {wide.map(item)}
      </>
    );
  };

  const nodeActions = new Map<string, PipelineNodeAction[]>();
  const views = new Map<string, FlowNodeModel>();
  for (const node of model.nodes) {
    const actions = actionsFor(node);
    nodeActions.set(node.id, actions);
    const canOpen =
      Boolean(node.session && createTab) || (node.kind === "pr" && Boolean(pullRequest && shipped));
    const view = pipelineNodeView({
      node,
      pipeline,
      pullRequest,
      now,
      modelLabel,
      canOpen,
      onOpen: () => (node.kind === "pr" ? void viewPR() : openSession(node)),
      contextMenu: contextMenuFor(actions),
    });
    if (
      active &&
      pipeline.stallWarning &&
      node.session?.sdkSessionId === pipeline.stallWarning.sessionId
    ) {
      view.stalled = true;
    }
    views.set(node.id, view);
  }

  const reportOwner = reviewReportSession(pipeline);
  const reportHint =
    !passKey &&
    pipeline.structuredReview &&
    reportOwner &&
    selected?.session?.sessionKey !== reportOwner.sessionKey &&
    model.nodes.some((node) => node.id === reportOwner.sessionKey)
      ? {
          id: reportOwner.sessionKey,
          title: model.nodes.find((node) => node.id === reportOwner.sessionKey)!.title,
          issues: pipeline.structuredReview.issues.length,
        }
      : null;

  // The live run's steps; a previous attempt is history.
  const liveNodes = model.nodes.filter((node) => !node.superseded);
  const reached = liveNodes.filter((node) => !node.placeholder && node.state !== "not-started");
  const summary = `${reached.length} of ${liveNodes.length} steps`;
  const startMs = Date.parse(pipeline.createdAt);
  const endMs = Math.max(
    ...model.nodes.flatMap((node) =>
      node.completedAt && Number.isFinite(Date.parse(node.completedAt))
        ? [Date.parse(node.completedAt)]
        : [],
    ),
  );
  const elapsed = Number.isFinite(startMs)
    ? formatElapsedWithHours(
        Math.max(
          0,
          Math.floor(((active ? now : Number.isFinite(endMs) ? endMs : now) - startMs) / 1_000),
        ),
      )
    : null;

  if (!selected) return null;
  const selectedView = views.get(selected.id)!;
  const selectedActions = nodeActions.get(selected.id) ?? [];
  // The Tests view's own "Stop tests and continue" is the same skip.
  const skipValidation = selectedActions.find(
    (action) => action.key === "skip" && selected.hasValidation,
  );
  const validationStop = skipValidation
    ? {
        onStop: skipValidation.onSelect,
        stopping:
          controls.pending || pipeline.skippedValidationRunId === pipeline.validationRun?.id,
      }
    : {};
  const composer =
    selected.session !== undefined &&
    selected.session === currentSession &&
    pipelineAcceptsMessages(pipeline);
  const showTranscript = selected.session !== undefined && !selected.placeholder;

  return (
    <div ref={setTabRoot} className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-testid="pipeline-flow-scroll"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="@container flex min-h-full flex-col">
          {notices}
          {reportHint ? (
            <button
              type="button"
              className="flex w-full shrink-0 items-center gap-2 border-b border-cyan-500/20 bg-cyan-500/5 px-4 py-2 text-left text-xs text-cyan-200/90 transition-colors hover:bg-cyan-500/10"
              onClick={() => onPin(reportHint.id)}
            >
              <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                The review reported {reportHint.issues} issue{reportHint.issues === 1 ? "" : "s"} —
                open {reportHint.title} to read the report.
              </span>
            </button>
          ) : null}
          <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              aria-expanded={!collapsed}
              aria-controls={graphId}
              onClick={() => setCollapsed(viewKey, !collapsed)}
            >
              {collapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
              {passKey ? "Review" : "Pipeline"}
            </Button>
            <span className="truncate text-[11px] text-muted-foreground">
              {summary}
              {elapsed ? ` · ${elapsed}` : ""}
            </span>
            {collapsed ? (
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {selected.title} · {selectedView.statusLabel}
              </span>
            ) : null}
          </div>
          <div id={graphId} hidden={collapsed} className={cn(collapsed && "hidden")}>
            {collapsed ? null : (
              <PipelineFlowGraph
                model={model}
                views={views}
                selectedId={selected.id}
                onSelect={(id) => onPin(id)}
                panelId={panelId}
                viewKey={viewKey}
                layout={layout}
                fullscreenContainer={tabRoot}
                isActive={isActive}
              />
            )}
          </div>
          <FlowInspectorPanel
            panelId={panelId}
            selectedId={selected.id}
            ariaLabel={collapsed ? selected.title : undefined}
            testId="pipeline-inspector"
            className="flex min-h-[28rem] min-w-0 flex-1 flex-col px-4 pt-4 sm:px-6"
          >
            <FlowInspectorHeader
              node={selectedView}
              testIdPrefix="pipeline"
              actions={selectedActions.map((action) => (
                <Button
                  key={action.key}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  disabled={action.disabled}
                  onClick={action.onSelect}
                >
                  <action.icon className="size-3.5" />
                  {action.label}
                </Button>
              ))}
            />
            <InspectorNotes node={selected} pipeline={pipeline} visibleError={visibleError} />
            {!showTranscript ? (
              <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                <InspectorBody
                  node={selected}
                  pipeline={pipeline}
                  environmentId={environmentId}
                  now={now}
                  pullRequest={pullRequest}
                  shipped={shipped}
                  validationStop={validationStop}
                  onShowAttemptStep={showAttemptStep}
                />
              </div>
            ) : selected.hasValidation && (selected.validationRun ?? pipeline.validationRun) ? (
              <Tabs
                value={inspectorTab[selected.id] ?? "transcript"}
                onValueChange={(value) =>
                  setInspectorTab((previous) => ({ ...previous, [selected.id]: value }))
                }
                className="mb-1 shrink-0"
              >
                <TabsList aria-label="Inspector views" className="h-7 rounded-md p-0.5">
                  <TabsTrigger className="h-6 px-2 text-xs" value="transcript">
                    Transcript
                  </TabsTrigger>
                  <TabsTrigger className="h-6 px-2 text-xs" value="tests">
                    Tests
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="tests" className="max-h-[60vh] overflow-y-auto">
                  <ReviewValidationStatus
                    environmentId={environmentId}
                    run={selected.validationRun ?? pipeline.validationRun!}
                    now={now}
                    {...validationStop}
                  />
                </TabsContent>
              </Tabs>
            ) : null}
            {/* Kept mounted behind the other views, so returning to a stage
                keeps the reader's place in its transcript. */}
            <PipelineSessionTranscript
              pipeline={pipeline}
              session={showTranscript ? selected.session : undefined}
              visible={
                showTranscript && !(selected.hasValidation && inspectorTab[selected.id] === "tests")
              }
              isActive={isActive}
              ownsGlobalShortcuts={ownsGlobalShortcuts}
              environmentId={environmentId}
              containerId={containerId}
              composer={composer}
            />
          </FlowInspectorPanel>
        </div>
      </div>
      {codeRewind.dialog}
    </div>
  );
}

/** What the record says about a stage beyond its status: substitutions, declines, retries. */
function InspectorNotes({
  node,
  pipeline,
  visibleError,
}: {
  node: PipelineFlowNode;
  pipeline: BuildPipeline;
  visibleError?: string;
}) {
  const session = node.session;
  const notes: ReactNode[] = [];
  if (session?.supersededBy) {
    notes.push(
      <p key="superseded">
        Superseded by a restart
        {session.supersededAt ? ` on ${new Date(session.supersededAt).toLocaleString()}` : ""}. Kept
        so its transcript stays readable; its result no longer counts.
      </p>,
    );
  }
  if (session?.modelSubstitution?.message) {
    notes.push(
      <p key="substitution" className="text-amber-300/90">
        {session.modelSubstitution.message}
      </p>,
    );
  }
  const declines = session?.autoDeclineCount ?? 0;
  if (declines > 0) {
    notes.push(
      <p key="declines">
        {declines} input request{declines === 1 ? "" : "s"} auto-declined
      </p>,
    );
  }
  if (node.earlierAttempts) {
    notes.push(
      <p key="attempts">
        {node.earlierAttempts} earlier attempt{node.earlierAttempts === 1 ? "" : "s"} in this pass
      </p>,
    );
  }
  if (node.state === "failed" && node.error && node.error !== visibleError) {
    notes.push(
      <p key="error" className="break-words whitespace-pre-wrap text-failure">
        {node.error}
      </p>,
    );
  }
  if (session?.resultSubmission) {
    notes.push(
      <WorkflowResultStatus
        key="result"
        state={session.resultSubmission}
        kind={
          session.phase === "review"
            ? "review-report"
            : session.phase === "verify"
              ? "verification-result"
              : session.phase === "address"
                ? "fix-result"
                : "review-preparation"
        }
      />,
    );
  }
  if (session?.phase === "address" && session.fixResult) {
    notes.push(<PipelineAddressReport key="address-report" result={session.fixResult} />);
  }
  if (
    node.kind === "verify" &&
    session &&
    pipeline.verificationFeedback &&
    node.state === "complete"
  ) {
    // The last verdict's feedback belongs to the newest live verification.
    const newest = [...pipeline.sessions]
      .reverse()
      .find((entry) => entry.phase === "verify" && !isSupersededPipelineSession(entry));
    if (newest === session) {
      notes.push(
        <p key="verdict">
          Verdict: {pipeline.verificationResult === "pass" ? "passed" : "failed"}
        </p>,
      );
    }
  }
  if (notes.length === 0) return null;
  return <div className="mb-3 flex flex-col gap-1 text-xs text-muted-foreground">{notes}</div>;
}

/** The inspector of a node with no transcript to show. */
function InspectorBody({
  node,
  pipeline,
  environmentId,
  now,
  pullRequest,
  shipped,
  validationStop,
  onShowAttemptStep,
}: {
  node: PipelineFlowNode;
  pipeline: BuildPipeline;
  environmentId: string;
  now: number;
  pullRequest: ReturnType<typeof usePipelinePullRequest>;
  shipped: boolean;
  validationStop: { onStop?: () => void; stopping?: boolean };
  onShowAttemptStep: (attemptId: string, sessionKey: string) => void;
}) {
  if (node.kind === "ticket") return <PipelineTicketView pipeline={pipeline} />;
  if (node.kind === "attempt") {
    return <PreviousAttempt node={node} pipeline={pipeline} onShowStep={onShowAttemptStep} />;
  }
  if (node.kind === "pr") {
    return (
      <PipelinePullRequestView
        environmentId={environmentId}
        pullRequest={pullRequest}
        shipped={shipped}
      />
    );
  }
  if (node.hasValidation && (node.validationRun ?? pipeline.validationRun)) {
    return (
      <ReviewValidationStatus
        environmentId={environmentId}
        run={node.validationRun ?? pipeline.validationRun!}
        stopCommand={node.superseded ? null : undefined}
        now={now}
        {...validationStop}
      />
    );
  }
  if (node.kind === "setup") {
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Environment</dt>
        <dd>{pipeline.environmentType === "local" ? "Local worktree" : "Container"}</dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>{new Date(pipeline.createdAt).toLocaleString()}</dd>
      </dl>
    );
  }
  if (node.reviewer) {
    const note = reviewerStatusNote(node.reviewer);
    return (
      <p
        className={cn(
          "text-sm",
          note?.tone === "destructive" ? "text-failure" : "text-muted-foreground",
        )}
      >
        {note?.text ??
          (node.reviewer.status === "pending"
            ? "This reviewer is waiting for an admission slot; its transcript appears once it starts."
            : "This reviewer has no session yet.")}
      </p>
    );
  }
  if (node.placeholder) {
    return (
      <p className="text-sm text-muted-foreground">
        This step has not started. The pipeline runs it once the steps before it finish.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {node.state === "failed"
        ? "This step failed before its session started."
        : node.state === "paused"
          ? "The pipeline paused here, before this step's session started."
          : "This step has no session."}
    </p>
  );
}

const RESTART_STEP_LABEL: Record<string, string> = {
  build: "Build",
  fix: "Fix",
  review: "Review",
  address: "Address",
  verify: "Verify",
  pr: "Ship",
  "resolve-conflicts": "Resolve conflicts",
};

/** What a previous attempt was and the steps it holds, each one a click away. */
function PreviousAttempt({
  node,
  pipeline,
  onShowStep,
}: {
  node: PipelineFlowNode;
  pipeline: BuildPipeline;
  onShowStep: (attemptId: string, sessionKey: string) => void;
}) {
  const rewind = pipeline.rewinds?.find((entry) => entry.id === node.attemptId);
  const keys = new Set(node.attemptSessionKeys ?? []);
  const sessions = pipeline.sessions.filter((session) => keys.has(session.sessionKey));
  const step = rewind
    ? rewind.step.kind === "session"
      ? RESTART_STEP_LABEL[rewind.step.phase]
      : rewind.step.kind === "validation"
        ? "Validation"
        : "Package preparation"
    : undefined;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {rewind && step
          ? `On ${new Date(rewind.at).toLocaleString()} a restart rewound the pipeline from round ${rewind.fromIteration + 1} to ${step} of round ${rewind.iteration + 1}. `
          : "A restart rewound the pipeline to an earlier step. "}
        These steps ran before it. They are kept so their transcripts stay readable, but their
        results no longer count;{" "}
        {rewind?.code
          ? `the code was reset from ${rewind.code.from.slice(0, 7)} to ${rewind.code.to.slice(0, 7)}, dropping ${rewind.code.droppedCommits} commit${rewind.code.droppedCommits === 1 ? "" : "s"}.`
          : "the code they committed is still on the branch."}
      </p>
      {rewind?.code ? (
        <p className="text-xs text-muted-foreground">
          The dropped commits stay reachable at{" "}
          <code className="break-all font-mono">{rewind.code.backupRef}</code>.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {node.validationRun && (
          <li>
            <button
              type="button"
              className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => onShowStep(node.attemptId!, `validation:${node.validationRun!.id}`)}
            >
              Validation
            </button>
          </li>
        )}
        {sessions.map((session) => (
          <li key={session.sessionKey}>
            <button
              type="button"
              className="w-full truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => onShowStep(node.attemptId!, session.sessionKey)}
            >
              {session.label} · round {session.iteration + 1}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
