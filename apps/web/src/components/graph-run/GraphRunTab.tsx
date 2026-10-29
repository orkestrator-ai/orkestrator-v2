import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  ExternalLink,
  FlaskConical,
  History,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Square,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { FlowNodeModel } from "@/components/flow-graph/FlowGraph";
import { FlowInspectorHeader, FlowInspectorPanel } from "@/components/flow-graph/FlowInspector";
import { defaultFlowSelection } from "@/components/flow-graph/flow-graph-model";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { modelsForAgent } from "@/lib/agent-launch";
import {
  answerGraphRunHumanNode,
  answerGraphRunQuestion,
  cancelGraphRun,
  graphRunRewindBackend,
  pauseGraphRun,
  resumeGraphRun,
  retryGraphActivation,
  skipGraphActivation,
  type GraphRunRewindBackend,
} from "@/lib/backend/graph-runs";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { formatTokenCount } from "@/lib/context-usage";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { flowAttemptKey, useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { EMPTY_GRAPH_RUN, useGraphRunStore } from "@/stores/graphRunStore";
import type { GraphRunTabData } from "@/types/paneLayout";
import { useGraphRunCodeRewind } from "./GraphRunCodeRewindDialog";
import { GraphRunFlowGraph, graphRunNodeView } from "./GraphRunFlowGraph";
import { GraphRunInspector } from "./GraphRunInspector";
import type { GraphQuestionAnswer } from "./GraphQuestionAnswerForm";
import type { GraphHumanNodeAnswer } from "./GraphHumanNodePanel";
import {
  graphRunNodeActions,
  graphRunSessionTabOptions,
  type GraphRunActionKey,
  type GraphRunActionSpec,
} from "./graph-run-actions";
import { graphRunFlowModel, type GraphRunFlowNode } from "./graph-run-flow";

/**
 * A graph run tab ("Graph run" or the run's name; plan P2.11, D16, D17): the
 * run as a flow graph on the shared renderer with an inspector below it.
 *
 * The view reads only snapshots (invariant 1): the run is re-read when the
 * tab mounts, when a `graph-run` change names it, on resource resyncs and on
 * view safety checks, and a snapshot is applied only when it is newer than
 * the one held, so a missed event is recovered by the next read. Unmounting,
 * switching environments or closing the tab never touches the run; every
 * control is an explicit backend command whose answer is the new snapshot.
 * Mock runs (item 213) say so in the header.
 */

const NO_CLOCK_SUBSCRIPTION = () => {};

/** The wall clock behind live durations: re-read once a second while subscribed. */
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

const RUN_STATUS_LABEL: Record<GraphRun["status"], string> = {
  provisioning: "Preparing the environment",
  running: "Running",
  waiting: "Waiting for you",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
  cancelling: "Stopping",
  cancelled: "Cancelled",
};

const RUN_STATUS_CLASS: Record<GraphRun["status"], string> = {
  provisioning: "border-cyan-400/25 text-cyan-300",
  running: "border-cyan-400/25 bg-cyan-400/8 text-cyan-300",
  waiting: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  paused: "border-amber-400/30 text-amber-300",
  complete: "border-success/30 bg-success/8 text-green-300",
  failed: "border-failure/30 bg-failure/8 text-failure",
  cancelling: "border-border text-muted-foreground",
  cancelled: "border-border text-muted-foreground",
};

const ACTION_ICON: Record<GraphRunActionKey, LucideIcon> = {
  "expand-attempt": ChevronsUpDown,
  "collapse-attempt": ChevronsDownUp,
  "open-session": ExternalLink,
  retry: RefreshCw,
  restart: RotateCcw,
  "rewind-code": History,
  skip: SkipForward,
  pause: Pause,
  resume: Play,
  cancel: Square,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface GraphRunTabProps {
  environmentId: string;
  data: GraphRunTabData;
  isActive: boolean;
  /** Restart and code rewind (item 210); tests pass their own. */
  rewindBackend?: GraphRunRewindBackend;
  /** Forces a layout; otherwise the measured width decides. */
  layout?: "graph" | "stacked";
}

export function GraphRunTab({
  environmentId,
  data,
  isActive,
  rewindBackend = graphRunRewindBackend,
  layout,
}: GraphRunTabProps) {
  const runId = data.runId;
  const entry = useGraphRunStore((state) => state.runs.get(runId)) ?? EMPTY_GRAPH_RUN;
  const loadRun = useGraphRunStore((state) => state.loadRun);

  // The run record is the authority: read it on mount and whenever the
  // backend says it changed, the event stream reconnects, or a safety check
  // runs. Nothing here runs on unmount except unsubscribing.
  useEffect(() => {
    void loadRun(runId);
    const reload = () => void loadRun(runId);
    const offChange = onResourceChanged("graph-run", (change) => {
      if (change.id === runId) reload();
    });
    const offResync = onResourceResync(reload);
    const offSafety = onViewSafetyCheck(reload);
    return () => {
      offChange();
      offResync();
      offSafety();
    };
  }, [loadRun, runId]);
  // Returning to the tab re-reads the run: events may have been missed meanwhile.
  useEffect(() => {
    if (isActive) void loadRun(runId);
  }, [isActive, loadRun, runId]);

  const run = entry.run;
  return (
    <div
      data-graph-run={runId}
      className={cn(
        "@container absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      {run ? (
        <GraphRunView
          run={run}
          environmentId={environmentId}
          isActive={isActive}
          rewindBackend={rewindBackend}
          layout={layout}
          refreshError={entry.error}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          {entry.status === "missing" ? (
            <p data-testid="graph-run-missing">
              This graph run no longer exists. It was deleted with its environment.
            </p>
          ) : entry.status === "error" ? (
            <>
              <p role="alert" className="text-failure">
                Could not load the graph run: {entry.error}
              </p>
              <Button size="sm" variant="outline" onClick={() => void loadRun(runId)}>
                Try again
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the graph run…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GraphRunView({
  run,
  environmentId,
  isActive,
  rewindBackend,
  layout,
  refreshError,
}: {
  run: GraphRun;
  environmentId: string;
  isActive: boolean;
  rewindBackend: GraphRunRewindBackend;
  layout?: "graph" | "stacked";
  refreshError: string | null;
}) {
  const panelId = `${useId()}inspector`;
  const graphId = `${panelId}-graph`;
  const [tabRoot, setTabRoot] = useState<HTMLDivElement | null>(null);
  const createTab = useOptionalTerminalContext()?.createTab;
  const containerId =
    useEnvironmentStore((state) => state.getEnvironmentById(environmentId)?.containerId) ??
    undefined;
  const applyRun = useGraphRunStore((state) => state.applyRun);
  const modelCatalog = useReviewModelCatalog(run.projectId, true);
  const viewKey = `graph-run:${run.id}`;
  const collapsed = useFlowGraphViewStore((state) => state.collapsed.has(viewKey));
  const setCollapsed = useFlowGraphViewStore((state) => state.setCollapsed);
  const expandedAttemptKeys = useFlowGraphViewStore((state) => state.expandedAttempts);
  const setAttemptExpanded = useFlowGraphViewStore((state) => state.setAttemptExpanded);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const expandedAttempts = useMemo(
    () =>
      new Set(
        run.rewinds
          .map((rewind) => rewind.id)
          .filter((id) => expandedAttemptKeys.has(flowAttemptKey(viewKey, id))),
      ),
    [expandedAttemptKeys, run.rewinds, viewKey],
  );
  const model = useMemo(
    () => graphRunFlowModel(run.plan, run, { expandedAttempts }),
    [run, expandedAttempts],
  );

  const [displayClock] = useState(createDisplayClock);
  const live = model.nodes.some((node) => node.state === "running");
  const subscribeDisplayClock = useCallback(
    (onChange: () => void) =>
      !isActive || !live ? NO_CLOCK_SUBSCRIPTION : displayClock.subscribe(onChange),
    [displayClock, isActive, live],
  );
  const now = useSyncExternalStore(subscribeDisplayClock, displayClock.getSnapshot);

  // What waits for the user comes first; then what runs, else the last reached.
  const columnOf = new Map<string, number>();
  model.columns.forEach((column, index) => {
    for (const id of column.nodeIds) columnOf.set(id, index);
  });
  const waiting = model.nodes.filter((node) => node.waitingForHuman);
  const followed =
    waiting[0]?.id ??
    defaultFlowSelection(
      model.nodes
        .filter((node) => !node.superseded)
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

  const modelLabel = (agent: string, model: string | undefined) =>
    model
      ? isAgentPlatform(agent)
        ? resolveCatalogModelLabel(model, modelsForAgent(modelCatalog, agent))
        : model
      : "Provider default";

  const act = async (label: string, action: () => Promise<GraphRun>): Promise<boolean> => {
    if (pending) return false;
    setPending(label);
    try {
      applyRun(await action());
      return true;
    } catch (error) {
      toast.error(`Could not ${label}`, { description: errorText(error) });
      return false;
    } finally {
      setPending(null);
    }
  };

  const codeRewind = useGraphRunCodeRewind(
    run.id,
    rewindBackend,
    (activationKey, expectedHead) =>
      act("rewind the code", () => rewindBackend.rewindCode(run.id, activationKey, expectedHead)),
    pending !== null,
  );

  const openSession = (node: GraphRunFlowNode) => {
    if (!node.activation || !createTab) return;
    const options = graphRunSessionTabOptions(run, node, node.activation);
    const agent = node.activation.session?.agent;
    if (!options || !agent) return;
    createTab(agent, options);
  };

  const perform = (node: GraphRunFlowNode, key: GraphRunActionKey) => {
    const activation = node.activation;
    switch (key) {
      case "expand-attempt":
      case "collapse-attempt":
        if (node.attemptId) setAttemptExpanded(viewKey, node.attemptId, key === "expand-attempt");
        return;
      case "open-session":
        openSession(node);
        return;
      case "retry":
        if (activation)
          void act("retry the node", () => retryGraphActivation(run.id, activation.key));
        return;
      case "restart":
        if (activation)
          void act("restart the node", () => rewindBackend.restart(run.id, activation.key));
        return;
      case "rewind-code":
        if (activation) codeRewind.open(activation.key, node.title);
        return;
      case "skip":
        if (activation)
          void act("skip the node", () => skipGraphActivation(run.id, activation.key));
        return;
      case "pause":
        void act("pause the run", () => pauseGraphRun(run.id));
        return;
      case "resume":
        void act("resume the run", () => resumeGraphRun(run.id));
        return;
      case "cancel":
        setConfirmCancel(true);
        return;
    }
  };

  const answer = async (activation: NodeActivation, reply: GraphQuestionAnswer) => {
    const question = activation.session?.question;
    if (!question) return;
    await answerGraphRunQuestion({
      runId: run.id,
      activationKey: activation.key,
      questionId: question.id,
      ...reply,
    });
    // The answer's own change event re-reads the run; read now for a prompt face.
    void useGraphRunStore.getState().loadRun(run.id);
  };

  const answerHuman = async (activation: NodeActivation, reply: GraphHumanNodeAnswer) => {
    const wait = activation.human;
    if (!wait) return;
    await answerGraphRunHumanNode({
      runId: run.id,
      activationKey: activation.key,
      waitId: wait.id,
      ...reply,
    });
    void useGraphRunStore.getState().loadRun(run.id);
  };

  const contextMenuFor = (node: GraphRunFlowNode, actions: GraphRunActionSpec[]): ReactNode => {
    const own = actions.filter((action) => !action.runWide);
    const wide = actions.filter((action) => action.runWide);
    const item = (action: GraphRunActionSpec) => {
      const Icon = ACTION_ICON[action.key];
      return (
        <ContextMenuItem
          key={action.key}
          disabled={
            (pending !== null && action.key !== "open-session") || Boolean(action.disabledReason)
          }
          title={action.disabledReason}
          onSelect={() => perform(node, action.key)}
        >
          <Icon />
          {action.label}
        </ContextMenuItem>
      );
    };
    if (actions.length === 0) return <ContextMenuItem disabled>No actions</ContextMenuItem>;
    return (
      <>
        {own.map(item)}
        {own.length > 0 && wide.length > 0 ? <ContextMenuSeparator /> : null}
        {wide.map(item)}
      </>
    );
  };

  const nodeActions = new Map<string, GraphRunActionSpec[]>();
  const views = new Map<string, FlowNodeModel>();
  for (const node of model.nodes) {
    const actions = graphRunNodeActions(run, node).filter(
      (action) => action.key !== "open-session" || Boolean(createTab),
    );
    nodeActions.set(node.id, actions);
    views.set(
      node.id,
      graphRunNodeView({
        node,
        run,
        now,
        modelLabel,
        canOpen: Boolean(createTab && node.activation?.session?.providerSessionId),
        onOpen: () => openSession(node),
        contextMenu: contextMenuFor(node, actions),
      }),
    );
  }

  const liveNodes = model.nodes.filter((node) => node.kind === "position");
  const reached = liveNodes.filter((node) => !node.placeholder && node.state !== "not-started");
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsed = Number.isFinite(startMs)
    ? formatElapsedWithHours(Math.max(0, Math.floor((endMs - startMs) / 1_000)))
    : null;
  const summary = [
    `${reached.length} of ${liveNodes.length} nodes`,
    elapsed,
    run.usage.tokens > 0 ? `${formatTokenCount(run.usage.tokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!selected) return null;
  const selectedView = views.get(selected.id)!;
  const selectedActions = nodeActions.get(selected.id) ?? [];

  return (
    <div ref={setTabRoot} className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <Workflow aria-hidden className="size-4 text-indigo-400" />
        <h2 className="min-w-0 truncate text-sm font-semibold" data-testid="graph-run-title">
          {run.plan.template.name}
        </h2>
        {run.mock ? (
          <span
            data-testid="graph-run-mock"
            title="A mock run: canned outputs, no provider sessions, no side effects"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-violet-400/40 px-1.5 text-[11px] text-violet-300"
          >
            <FlaskConical aria-hidden className="size-3" />
            Mock run
          </span>
        ) : null}
        <span
          data-testid="graph-run-status"
          data-graph-run-status={run.status}
          className={cn(
            "shrink-0 rounded-full border px-2 py-px text-[11px]",
            RUN_STATUS_CLASS[run.status],
          )}
        >
          {RUN_STATUS_LABEL[run.status]}
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {selectedActions
            .filter((action) => action.runWide)
            .map((action) => {
              const Icon = ACTION_ICON[action.key];
              return (
                <Button
                  key={action.key}
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 text-xs"
                  disabled={pending !== null}
                  onClick={() => perform(selected, action.key)}
                >
                  <Icon className="size-3.5" />
                  {action.label}
                </Button>
              );
            })}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
        <div className="@container flex min-h-full flex-col">
          {run.error ? (
            <p
              role="alert"
              data-testid="graph-run-error"
              className="border-b border-failure/30 bg-failure/8 px-4 py-2 text-xs text-failure"
            >
              {run.error}
            </p>
          ) : null}
          {refreshError ? (
            <p className="border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground">
              Showing the last snapshot: {refreshError}
            </p>
          ) : null}
          {waiting.length > 0 ? (
            <button
              type="button"
              data-testid="graph-run-waiting-banner"
              className="flex w-full shrink-0 items-center gap-2 border-b border-amber-500/25 bg-amber-500/8 px-4 py-2 text-left text-xs text-amber-200 transition-colors hover:bg-amber-500/12"
              onClick={() => setPinnedId(waiting[0]!.id)}
            >
              <CircleHelp className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {waiting.length === 1
                  ? `${waiting[0]!.title} is waiting for you.`
                  : `${waiting.length} nodes are waiting for you.`}
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
              Graph
            </Button>
            {collapsed ? (
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {selected.title} · {selectedView.statusLabel}
              </span>
            ) : null}
          </div>
          <div id={graphId} hidden={collapsed} className={cn(collapsed && "hidden")}>
            {collapsed ? null : (
              <GraphRunFlowGraph
                model={model}
                views={views}
                selectedId={selected.id}
                onSelect={setPinnedId}
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
            testId="graph-run-inspector"
            className="flex min-h-[28rem] min-w-0 flex-1 flex-col px-4 pt-4 sm:px-6"
          >
            <FlowInspectorHeader
              node={selectedView}
              testIdPrefix="graph-run"
              actions={selectedActions
                .filter((action) => !action.runWide)
                .map((action) => {
                  const Icon = ACTION_ICON[action.key];
                  return (
                    <Button
                      key={action.key}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      disabled={
                        (pending !== null && action.key !== "open-session") ||
                        Boolean(action.disabledReason)
                      }
                      title={action.disabledReason}
                      onClick={() => perform(selected, action.key)}
                    >
                      <Icon className="size-3.5" />
                      {action.label}
                    </Button>
                  );
                })}
            />
            <GraphRunInspector
              key={selected.id}
              run={run}
              node={selected}
              environmentId={environmentId}
              containerId={containerId}
              isActive={isActive}
              ownsGlobalShortcuts={isActive}
              onAnswer={answer}
              onHumanAnswer={answerHuman}
              onSelectActivation={(attemptId, activationKey) => {
                setAttemptExpanded(viewKey, attemptId, true);
                setPinnedId(activationKey);
              }}
            />
          </FlowInspectorPanel>
        </div>
      </div>
      {codeRewind.dialog}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent data-testid="graph-run-cancel-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>
              Running nodes are stopped and nothing new starts. The run, its artifacts and its
              transcripts stay readable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void act("cancel the run", () => cancelGraphRun(run.id))}
            >
              Cancel run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
