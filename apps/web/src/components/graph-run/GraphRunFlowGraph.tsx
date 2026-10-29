import { useState, type ReactNode } from "react";
import {
  Bot,
  Boxes,
  CircleHelp,
  GitFork,
  GitMerge,
  History,
  Inbox,
  Server,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphBranchBinding,
  graphNodeBranches,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import type { GraphNodeKind } from "@orkestrator/protocol/graphs/template";
import {
  FlowGraph,
  type FlowGraphEdge,
  type FlowNodeModel,
  type FlowStackStage,
} from "@/components/flow-graph/FlowGraph";
import { flowNodeHeight, summarizeFlowEdges } from "@/components/flow-graph/flow-graph-model";
import { pipelineFlowLayout } from "@/components/build-pipeline/pipeline-flow-layout";
import { runtimeParts } from "@/lib/review/runtime-summary";
import type { GraphRunFlowModel, GraphRunFlowNode } from "./graph-run-flow";

/** The shortest the graph sizes itself to, so the inspector keeps the room. */
const GRAPH_RUN_FLOW_MIN_HEIGHT = 240;

const NODE_KIND_ICON: Record<GraphNodeKind, LucideIcon> = {
  agent: Bot,
  system: Server,
  gate: GitFork,
  merge: GitMerge,
  human: UserRound,
  subgraph: Boxes,
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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The status pill: what the position is doing, in words. */
export function graphRunNodeStatusLabel(node: GraphRunFlowNode, run: GraphRun): string {
  if (node.kind === "inputs") return node.state === "complete" ? "Provided" : "Not provided yet";
  if (node.kind === "attempt") return "Superseded by a restart";
  if (node.superseded) return `Superseded · ${STATE_LABEL[node.state]}`;
  if (node.waitingForHuman) return "Waiting for you";
  if (node.skipped) return "Skipped";
  if (node.placeholder) {
    return run.status === "complete" || run.status === "failed" || run.status === "cancelled"
      ? "Not reached"
      : "Not started yet";
  }
  const state = node.activation?.state;
  if (state === "ready" || state === "waiting") return "Queued";
  if (state === "admitting") return "Starting";
  return STATE_LABEL[node.state];
}

/** Row 2 of a face: `{agent} · {model} · {effort}` for agents, what the node does otherwise. */
export function graphRunNodeDetail(
  node: GraphRunFlowNode,
  run: GraphRun,
  modelLabel: (agent: string, model: string | undefined) => string,
): string {
  if (node.kind === "inputs") return plural(run.plan.inputs.length, "input");
  if (node.kind === "attempt") return plural(node.attemptActivationKeys?.length ?? 0, "activation");
  const planNode = run.plan.nodes.find((candidate) => candidate.id === node.nodeId);
  if (!planNode) return "";
  const attempt = node.attempts.length > 1 ? ` · attempt ${node.activation?.attempt}` : "";
  switch (planNode.kind) {
    case "agent": {
      const session = node.activation?.session;
      const binding = session
        ? { platform: session.agent, model: session.model, reasoningEffort: session.effort }
        : agentBinding(planNode, node.branchKey, run);
      if (!binding) return `Role ${planNode.role}${attempt}`;
      return (
        [binding.platform, modelLabel(binding.platform, binding.model), binding.reasoningEffort]
          .filter(Boolean)
          .join(" · ") + attempt
      );
    }
    case "system":
      return (GRAPH_SYSTEM_ACTION_SPECS[planNode.action]?.label ?? planNode.action) + attempt;
    case "gate":
      return node.outlet
        ? `→ ${node.outlet}`
        : `Gate · ${plural(planNode.outlets.length, "outlet")}`;
    case "merge":
      return `Merge · ${planNode.strategy.kind}`;
    case "human":
      return node.outlet ? `→ ${node.outlet}` : `Human · ${planNode.form.kind}`;
    case "subgraph":
      return "Subgraph";
  }
}

function agentBinding(
  node: Extract<GraphPlanNode, { kind: "agent" }>,
  branchKey: string | undefined,
  run: GraphRun,
) {
  let role = node.role;
  let panelIndex: number | undefined;
  if (branchKey !== undefined) {
    try {
      const branch = graphNodeBranches(node, run.bindings.roles)?.find(
        (candidate) => candidate.key === branchKey,
      );
      if (branch) {
        role = branch.role;
        panelIndex = branch.panelIndex;
      }
    } catch {
      // Branches the runtime cannot build yet (`items`) show the node's role.
    }
  }
  return graphBranchBinding(
    run.bindings.roles,
    role,
    panelIndex !== undefined ? { panelIndex } : undefined,
  );
}

/** Everything a node shows on its face. */
export function graphRunNodeView({
  node,
  run,
  now,
  modelLabel,
  canOpen,
  onOpen,
  contextMenu,
}: {
  node: GraphRunFlowNode;
  run: GraphRun;
  now: number;
  modelLabel: (agent: string, model: string | undefined) => string;
  canOpen: boolean;
  onOpen: () => void;
  contextMenu: ReactNode;
}): FlowNodeModel {
  const activation = node.activation;
  const running = node.state === "running";
  const runtime =
    node.kind === "attempt" || node.kind === "inputs" || !activation
      ? null
      : runtimeParts(
          {
            startedAt: activation.startedAt,
            completedAt: activation.finishedAt,
            tokenCount: activation.session?.tokenCount,
          },
          running,
          now,
        );
  const statusWord: FlowNodeModel["statusWord"] = node.superseded
    ? {
        text:
          node.kind === "attempt" ? (node.attemptExpanded ? "shown" : "collapsed") : "superseded",
        tone: "muted",
      }
    : node.waitingForHuman
      ? { text: "waiting for you", tone: "warning" }
      : node.skipped
        ? { text: "skipped", tone: "muted" }
        : node.state === "running"
          ? { text: "running", tone: "running" }
          : node.state === "paused"
            ? { text: "paused", tone: "warning" }
            : node.state === "failed"
              ? { text: "failed", tone: "destructive" }
              : node.state === "cancelled"
                ? { text: "stopped", tone: "muted" }
                : undefined;
  const idleIcon =
    node.kind === "inputs"
      ? Inbox
      : node.kind === "attempt"
        ? History
        : node.nodeKind
          ? NODE_KIND_ICON[node.nodeKind]
          : undefined;
  return {
    id: node.id,
    kind:
      node.kind === "position" || node.kind === "superseded"
        ? (node.nodeKind ?? "node")
        : node.kind,
    title: node.title,
    state: node.state,
    stalled: Boolean(activation?.session?.stalledSince) && running,
    statusLabel: graphRunNodeStatusLabel(node, run),
    detail: graphRunNodeDetail(node, run, modelLabel),
    runtime,
    runtimeLabel: `${node.title} runtime and token usage`,
    pendingLabel:
      node.state === "not-started" && node.kind === "position"
        ? node.placeholder
          ? run.status === "complete" || run.status === "failed" || run.status === "cancelled"
            ? "not reached"
            : "ahead"
          : "queued"
        : undefined,
    statusWord,
    error: node.error,
    ...(idleIcon ? { idleIcon } : {}),
    placeholder: node.placeholder,
    superseded: node.superseded,
    extra: node.waitingForHuman ? (
      <span
        data-graph-run-waiting=""
        className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-300"
      >
        <CircleHelp className="size-3" aria-hidden />
        {node.activation?.session?.question ? "Question for you" : "Your decision is needed"}
      </span>
    ) : undefined,
    canOpen,
    onOpen,
    contextMenu,
  };
}

/** The run on the shared flow graph, left to right, one column per depth. */
export function GraphRunFlowGraph({
  model,
  views,
  selectedId,
  onSelect,
  panelId,
  viewKey,
  layout,
  fullscreenContainer,
  isActive = true,
}: {
  model: GraphRunFlowModel;
  views: ReadonlyMap<string, FlowNodeModel>;
  selectedId: string;
  onSelect: (id: string) => void;
  panelId: string;
  viewKey: string;
  layout?: "graph" | "stacked";
  fullscreenContainer?: HTMLElement | null;
  isActive?: boolean;
}) {
  const [storedHeight, setStoredHeight] = useState<number | null>(null);
  const nodes = model.nodes.map((node) => views.get(node.id)!);
  const edges: FlowGraphEdge[] = model.edges.map(({ untaken: _untaken, ...edge }) => edge);
  const stages: FlowStackStage[] = model.columns.map((column, index) => {
    const ids = new Set(column.nodeIds);
    const into = model.edges.filter((edge) => ids.has(edge.to)).map((edge) => edge.state);
    return {
      key: column.key,
      label: column.label,
      nodes: column.nodeIds.map((id) => views.get(id)!),
      ...(index > 0
        ? { edgeIn: { id: `into-${column.key}`, state: summarizeFlowEdges(into) } }
        : {}),
    };
  });
  // Port dots where one node fans out to several, or several fan into one.
  const ports: { nodeId: string; side: "in" | "out" }[] = [];
  const outCount = new Map<string, number>();
  const inCount = new Map<string, number>();
  for (const edge of model.edges) {
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1);
  }
  for (const [nodeId, count] of outCount) if (count > 1) ports.push({ nodeId, side: "out" });
  for (const [nodeId, count] of inCount) if (count > 1) ports.push({ nodeId, side: "in" });
  return (
    <FlowGraph
      nodes={nodes}
      layout={(width) =>
        pipelineFlowLayout({
          width,
          columns: model.columns.map((column) => ({
            key: column.key,
            label: column.label,
            nodes: column.nodeIds.map((id) => ({ id, height: flowNodeHeight(views.get(id)!) })),
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
      ariaLabel="Graph run"
      testIdPrefix="graph-run"
      storedHeight={storedHeight}
      onStoredHeightChange={setStoredHeight}
      layoutMode={layout}
      fullscreenContainer={fullscreenContainer}
      isActive={isActive}
      minHeight={GRAPH_RUN_FLOW_MIN_HEIGHT}
      fitControl
    />
  );
}
