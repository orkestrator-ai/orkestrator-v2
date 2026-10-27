import type { ReactNode } from "react";
import {
  CircleDot,
  ClipboardList,
  Clock3,
  FileSearch,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Hammer,
  History,
  PackageCheck,
  Rocket,
  Server,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  FlowGraph,
  type FlowGraphEdge,
  type FlowNodeModel,
  type FlowStackStage,
} from "@/components/flow-graph/FlowGraph";
import { flowNodeHeight, summarizeFlowEdges } from "@/components/flow-graph/flow-graph-model";
import {
  reviewerPendingLabel,
  reviewerStatusLabel,
  reviewerStatusWord,
  validationChips,
} from "@/components/review/multi-review-steps";
import { runtimeParts } from "@/lib/review/runtime-summary";
import { formatObservedAt } from "@/lib/view-freshness";
import { useUIStore } from "@/stores/uiStore";
import { PIPELINE_FLOW_MIN_HEIGHT, pipelineFlowLayout } from "./pipeline-flow-layout";
import type {
  PipelineFlowModel,
  PipelineFlowNode,
  PipelineFlowNodeKind,
  PipelinePullRequest,
} from "./pipeline-flow";
import { PipelinePullRequestChecks } from "./PipelinePullRequestView";

export const PIPELINE_IDLE_ICON: Record<PipelineFlowNodeKind, LucideIcon> = {
  ticket: ClipboardList,
  setup: Server,
  build: Hammer,
  fix: Wrench,
  prepare: PackageCheck,
  reviewer: Clock3,
  review: FileSearch,
  consolidation: GitMerge,
  address: CircleDot,
  verify: ShieldCheck,
  ship: Rocket,
  conflicts: GitBranch,
  pr: GitPullRequest,
  attempt: History,
};

const STATE_LABEL = {
  "not-started": "Not started",
  running: "Running",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
  cancelling: "Stopping",
  cancelled: "Stopped",
} as const;

export interface PipelineNodeView {
  node: PipelineFlowNode;
  flow: FlowNodeModel;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The status pill: a reviewer's own words, else the node's state. */
export function pipelineNodeStatusLabel(
  node: PipelineFlowNode,
  pipeline: BuildPipeline,
  pullRequest: PipelinePullRequest | null,
): string {
  if (node.kind === "ticket") return "Started with";
  if (node.kind === "attempt") return "Superseded by a restart";
  if (node.superseded) return `Superseded · ${STATE_LABEL[node.state]}`;
  if (node.kind === "pr") {
    if (!pullRequest || node.state === "not-started") return "Not created yet";
    return pullRequest.state === "merged"
      ? "Merged"
      : pullRequest.state === "closed"
        ? "Closed"
        : "Open";
  }
  if (node.reviewer && node.state !== "complete") {
    return reviewerStatusLabel(node.reviewer, pipeline.reviewFanout?.reviewers ?? []);
  }
  if (node.placeholder) return "Not started yet";
  return STATE_LABEL[node.state];
}

/** `{agent} · {model} · {effort}`, or what describes a node without a session. */
function nodeDetail(
  node: PipelineFlowNode,
  pipeline: BuildPipeline,
  pullRequest: PipelinePullRequest | null,
  modelLabel: (agent: string, model: string | undefined) => string,
): string {
  switch (node.kind) {
    case "ticket":
      return pipeline.taskSnapshot?.title || pipeline.taskTitle;
    case "setup":
      return pipeline.environmentType === "local" ? "Local worktree" : "Container";
    case "pr":
      return pullRequest && node.state !== "not-started"
        ? pullRequest.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")
        : "No pull request yet";
    case "attempt":
      return attemptDetail(node, pipeline);
    default:
      break;
  }
  if (node.kind === "prepare" && !node.agent) {
    const run = pipeline.validationRun;
    return run ? plural(run.plan.commands.length, "check") : "Validation";
  }
  if (!node.agent) return "";
  return [node.agent, modelLabel(node.agent, node.model), node.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
}

/** "6 steps · from round 4", what a previous attempt holds and where it was left. */
function attemptDetail(node: PipelineFlowNode, pipeline: BuildPipeline): string {
  const steps = plural(node.attemptSessionKeys?.length ?? 0, "step");
  const rewind = pipeline.rewinds?.find((entry) => entry.id === node.attemptId);
  return rewind ? `${steps} · left at round ${rewind.fromIteration + 1}` : steps;
}

function issueTotal(counts: PipelineFlowNode["issueCounts"]): number | undefined {
  return counts ? counts.P0 + counts.P1 + counts.P2 : undefined;
}

/** Everything a node shows on its face. */
export function pipelineNodeView({
  node,
  pipeline,
  pullRequest,
  now,
  modelLabel,
  canOpen,
  onOpen,
  contextMenu,
}: {
  node: PipelineFlowNode;
  pipeline: BuildPipeline;
  pullRequest: PipelinePullRequest | null;
  now: number;
  modelLabel: (agent: string, model: string | undefined) => string;
  canOpen: boolean;
  onOpen: () => void;
  contextMenu: ReactNode;
}): FlowNodeModel {
  const running = node.state === "running";
  // The ticket did not run; its clock is when the pipeline picked it up.
  const ticketStarted = node.kind === "ticket" ? formatObservedAt(pipeline.createdAt) : null;
  const runtime =
    node.kind === "ticket" || node.placeholder
      ? null
      : runtimeParts(
          {
            startedAt: node.startedAt,
            completedAt: node.completedAt,
            tokenCount: node.tokenCount,
          },
          running,
          now,
        );
  const issues = issueTotal(node.issueCounts);
  const liveReviewers = pipeline.reviewFanout?.reviewers ?? [];
  const statusWord: FlowNodeModel["statusWord"] = node.superseded
    ? {
        text:
          node.kind === "attempt" ? (node.attemptExpanded ? "shown" : "collapsed") : "superseded",
        tone: "muted",
      }
    : node.reviewer && node.state !== "complete"
      ? reviewerStatusWord(node.reviewer)
      : node.state === "running"
        ? { text: "running", tone: "running" }
        : node.state === "paused"
          ? { text: "paused", tone: "warning" }
          : node.state === "failed"
            ? { text: "failed", tone: "destructive" }
            : node.state === "cancelled"
              ? { text: "stopped", tone: "muted" }
              : undefined;
  return {
    id: node.id,
    kind: node.kind,
    stage: node.passKey ?? node.id,
    title: node.title,
    state: node.state,
    stalled: Boolean(node.reviewer?.stalledSince),
    statusLabel: pipelineNodeStatusLabel(node, pipeline, pullRequest),
    detail: nodeDetail(node, pipeline, pullRequest, modelLabel),
    runtime,
    runtimeLabel: `${node.title} runtime and token usage`,
    startTime: ticketStarted
      ? { dateTime: pipeline.createdAt, text: `Started ${ticketStarted}` }
      : undefined,
    pendingLabel:
      node.state === "not-started" && node.kind !== "pr"
        ? node.reviewer
          ? reviewerPendingLabel(node.reviewer, liveReviewers)
          : node.placeholder
            ? "ahead"
            : "not started"
        : undefined,
    statusWord,
    severity: node.issueCounts,
    findingsLabel: issues === undefined ? undefined : plural(issues, "issue"),
    validation:
      node.hasValidation && pipeline.validationRun
        ? validationChips(pipeline.validationRun)
        : undefined,
    error: node.error,
    idleIcon: PIPELINE_IDLE_ICON[node.kind],
    placeholder: node.placeholder,
    superseded: node.superseded,
    extra:
      node.kind === "pr" && pullRequest && node.state !== "not-started" ? (
        <PipelinePullRequestChecks checks={pullRequest.checks} />
      ) : undefined,
    canOpen,
    onOpen,
    contextMenu,
  };
}

/** "3/4 complete", over the reviewers a review column holds. */
function reviewProgress(nodes: readonly PipelineFlowNode[]): string | null {
  const reviewers = nodes.filter((node) => node.kind === "reviewer");
  if (reviewers.length === 0) return null;
  const completed = reviewers.filter((node) => node.state === "complete").length;
  return `${completed}/${reviewers.length}`;
}

export interface PipelineFlowGraphProps {
  model: PipelineFlowModel;
  views: ReadonlyMap<string, FlowNodeModel>;
  selectedId: string;
  onSelect: (id: string) => void;
  panelId: string;
  viewKey: string;
  layout?: "graph" | "stacked";
  fullscreenContainer?: HTMLElement | null;
  isActive?: boolean;
}

/**
 * The build pipeline on the shared flow graph: Ticket, Setup, every pass of
 * Build, Review, Address, Verify and Fix in the order they ran, then Ship and
 * the pull request.
 */
export function PipelineFlowGraph({
  model,
  views,
  selectedId,
  onSelect,
  panelId,
  viewKey,
  layout,
  fullscreenContainer,
  isActive = true,
}: PipelineFlowGraphProps) {
  const storedHeight = useUIStore((state) => state.pipelineGraphHeight);
  const setStoredHeight = useUIStore((state) => state.setPipelineGraphHeight);
  const nodes = model.nodes.map((node) => views.get(node.id)!);
  const byId = new Map(model.nodes.map((node) => [node.id, node] as const));
  const columnLabel = (column: PipelineFlowModel["columns"][number]) => {
    const progress = reviewProgress(column.nodeIds.map((id) => byId.get(id)!));
    return progress ? `${column.label} · ${progress}` : column.label;
  };
  const edges: FlowGraphEdge[] = model.edges.map((edge) => ({ ...edge }));
  const edgesInto = (columnIndex: number) => {
    const ids = new Set(model.columns[columnIndex]!.nodeIds);
    return model.edges.filter((edge) => ids.has(edge.to)).map((edge) => edge.state);
  };
  // In the stacked column the live line runs beside a previous attempt.
  const bypassOver = (columnIndex: number) => {
    const next = model.columns.findIndex(
      (column, index) => index > columnIndex && !column.superseded,
    );
    if (next < 0) return undefined;
    const ids = new Set(model.columns[next]!.nodeIds);
    const bypass = model.edges.filter((edge) => edge.route === "bypass" && ids.has(edge.to));
    if (bypass.length === 0) return undefined;
    return {
      id: `bypass-${model.columns[columnIndex]!.key}`,
      source: bypass[0]!.from,
      state: summarizeFlowEdges(bypass.map((edge) => edge.state)),
    };
  };
  const stages: FlowStackStage[] = model.columns.map((column, index) => {
    const bypass = column.superseded ? bypassOver(index) : undefined;
    return {
      key: column.key,
      label: columnLabel(column),
      nodes: column.nodeIds.map((id) => views.get(id)!),
      ...(index > 0
        ? { edgeIn: { id: `into-${column.key}`, state: summarizeFlowEdges(edgesInto(index)) } }
        : {}),
      ...(bypass ? { bypass } : {}),
    };
  });
  // Ports where the line fans out to a column of reviewers or back in.
  const ports: { nodeId: string; side: "in" | "out" }[] = [];
  model.columns.forEach((column, index) => {
    const next = model.columns[index + 1];
    const previous = model.columns[index - 1];
    if (next && next.nodeIds.length > 1 && column.nodeIds.length === 1) {
      ports.push({ nodeId: column.nodeIds[0]!, side: "out" });
    }
    if (previous && previous.nodeIds.length > 1 && column.nodeIds.length === 1) {
      ports.push({ nodeId: column.nodeIds[0]!, side: "in" });
    }
  });
  return (
    <FlowGraph
      nodes={nodes}
      layout={(width) =>
        pipelineFlowLayout({
          width,
          columns: model.columns.map((column) => ({
            key: column.key,
            label: columnLabel(column),
            nodes: column.nodeIds.map((id) => ({
              id,
              height: flowNodeHeight(views.get(id)!),
            })),
          })),
        })
      }
      edges={edges}
      ports={ports}
      stages={stages}
      selectedId={selectedId}
      onSelect={onSelect}
      panelId={panelId}
      viewKey={viewKey}
      ariaLabel="Build pipeline"
      testIdPrefix="pipeline"
      storedHeight={storedHeight}
      onStoredHeightChange={setStoredHeight}
      layoutMode={layout}
      fullscreenContainer={fullscreenContainer}
      isActive={isActive}
      minHeight={PIPELINE_FLOW_MIN_HEIGHT}
      fitControl
    />
  );
}
