import { Clock3, GitMerge, GitPullRequest, Wrench, type LucideIcon } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import {
  FlowGraph,
  FlowStateIcon,
  type FlowGraphEdge,
  type FlowNodeModel,
  type FlowStackStage,
} from "@/components/flow-graph/FlowGraph";
import { summarizeFlowEdges } from "@/components/flow-graph/flow-graph-model";
import {
  multiReviewFlowLayout,
  type MultiReviewFlowEdges,
  type MultiReviewFlowState,
} from "./multi-review-flow";

export type MultiReviewFlowNodeKind = "package" | "reviewer" | "consolidation" | "fix" | "pr";

/** Everything one node shows, plus how it opens and what its context menu holds. */
export interface MultiReviewFlowNodeModel extends FlowNodeModel {
  kind: MultiReviewFlowNodeKind;
}

const IDLE_ICON: Partial<Record<MultiReviewFlowNodeKind, LucideIcon>> = {
  reviewer: Clock3,
  consolidation: GitMerge,
  fix: Wrench,
  pr: GitPullRequest,
};

export function MultiReviewFlowStateIcon({
  kind,
  state,
  stalled,
  className,
}: {
  kind: MultiReviewFlowNodeKind;
  state: MultiReviewFlowState;
  stalled: boolean;
  className?: string;
}) {
  return (
    <FlowStateIcon
      state={state}
      stalled={stalled}
      idleIcon={IDLE_ICON[kind]}
      className={className}
    />
  );
}

export interface MultiReviewFlowGraphProps {
  packageNode: MultiReviewFlowNodeModel;
  reviewerNodes: MultiReviewFlowNodeModel[];
  consolidationNode: MultiReviewFlowNodeModel;
  fixNode: MultiReviewFlowNodeModel;
  prNode: MultiReviewFlowNodeModel;
  edges: MultiReviewFlowEdges;
  reviewLabel: string;
  /** The reviewer progress in full, for the review column's tooltip. */
  reviewTitle?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  /** The inspector panel the nodes control. */
  panelId: string;
  /** Keys the remembered zoom and pan: the workflow id. */
  viewKey: string;
  /** Forces a layout; otherwise the measured width decides. */
  layout?: "graph" | "stacked";
  /**
   * What fullscreen covers: a positioned element, the Multi Review tab. The
   * graph is portaled into it, since an `@container` ancestor would confine a
   * fixed overlay to itself. Without one, fullscreen covers the window.
   */
  fullscreenContainer?: HTMLElement | null;
  /** Hidden tabs must not consume keyboard events from another pane. */
  isActive?: boolean;
}

/**
 * The Multi Review pipeline as a left-to-right graph: package, the reviewer
 * panel stacked in one column, consolidation, Fix, then the pull request. The
 * drawing, zoom, pan and stacking are the shared {@link FlowGraph}'s; this
 * places the five columns and says which edges join them.
 */
export function MultiReviewFlowGraph({
  packageNode,
  reviewerNodes,
  consolidationNode,
  fixNode,
  prNode,
  edges,
  reviewLabel,
  reviewTitle,
  selectedId,
  onSelect,
  panelId,
  viewKey,
  layout,
  fullscreenContainer,
  isActive = true,
}: MultiReviewFlowGraphProps) {
  // The height dragged with the divider, shared by every Multi Review.
  const storedHeight = useUIStore((state) => state.multiReviewGraphHeight);
  const setStoredHeight = useUIStore((state) => state.setMultiReviewGraphHeight);
  const nodes = [packageNode, ...reviewerNodes, consolidationNode, fixNode, prNode].map(
    withIdleIcon,
  );
  const [packageView, ...rest] = nodes;
  const reviewerViews = rest.slice(0, reviewerNodes.length);
  const [consolidationView, fixView, prView] = rest.slice(reviewerNodes.length);

  const graphEdges: FlowGraphEdge[] = [];
  reviewerNodes.forEach((node, index) => {
    graphEdges.push(
      {
        id: `into-reviewer-${index}`,
        from: packageNode.id,
        to: node.id,
        state: edges.intoReviewers[index] ?? "pending",
      },
      {
        id: `into-consolidation-${index}`,
        from: node.id,
        to: consolidationNode.id,
        state: edges.intoConsolidation[index] ?? "pending",
      },
    );
  });
  graphEdges.push(
    { id: "into-fix", from: consolidationNode.id, to: fixNode.id, state: edges.intoFix },
    edges.prSource === "consolidation"
      ? {
          id: "into-pr",
          from: consolidationNode.id,
          to: prNode.id,
          state: edges.intoPr,
          source: "consolidation",
          route: "bypass",
        }
      : {
          id: "into-pr",
          from: fixNode.id,
          to: prNode.id,
          state: edges.intoPr,
          source: edges.prSource ?? "fix",
        },
  );

  const stages: FlowStackStage[] = [
    { key: "prepare", label: "Prepare", nodes: [packageView!] },
    {
      key: "review",
      label: reviewLabel,
      title: reviewTitle,
      nodes: reviewerViews,
      edgeIn: { id: "into-reviewers", state: summarizeFlowEdges(edges.intoReviewers) },
    },
    {
      key: "consolidate",
      label: "Consolidate",
      nodes: [consolidationView!],
      edgeIn: { id: "into-consolidation", state: summarizeFlowEdges(edges.intoConsolidation) },
    },
    {
      key: "fix",
      label: "Fix",
      nodes: [fixView!],
      edgeIn: { id: "into-fix", state: edges.intoFix },
      ...(edges.prSource === "consolidation"
        ? { bypass: { id: "into-pr", source: "consolidation", state: edges.intoPr } }
        : {}),
    },
    {
      key: "pr",
      label: "PR",
      nodes: [prView!],
      edgeIn: { id: "into-pr", state: edges.intoPr },
    },
  ];

  return (
    <FlowGraph
      nodes={nodes}
      layout={(width) => {
        const geometry = multiReviewFlowLayout({
          width,
          reviewerCount: reviewerNodes.length,
          packageHasChips: Boolean(packageNode.validation?.length),
        });
        const rects = new Map([
          [packageNode.id, geometry.package],
          ...reviewerNodes.map((node, index) => [node.id, geometry.reviewers[index]!] as const),
          [consolidationNode.id, geometry.consolidation],
          [fixNode.id, geometry.fix],
          [prNode.id, geometry.pr],
        ]);
        return {
          width: geometry.width,
          height: geometry.height,
          rects,
          labels: [
            { key: "prepare", x: geometry.columns.prepare, text: "Prepare" },
            { key: "review", x: geometry.columns.review, text: reviewLabel, title: reviewTitle },
            { key: "consolidate", x: geometry.columns.consolidate, text: "Consolidate" },
            { key: "fix", x: geometry.columns.fix, text: "Fix" },
            { key: "pr", x: geometry.columns.pr, text: "PR" },
          ],
        };
      }}
      edges={graphEdges}
      ports={[
        { nodeId: packageNode.id, side: "out" },
        { nodeId: consolidationNode.id, side: "in" },
        { nodeId: fixNode.id, side: "in" },
        { nodeId: prNode.id, side: "in" },
      ]}
      stages={stages}
      selectedId={selectedId}
      onSelect={onSelect}
      panelId={panelId}
      viewKey={viewKey}
      ariaLabel="Multi Review pipeline"
      testIdPrefix="multi-review"
      storedHeight={storedHeight}
      onStoredHeightChange={setStoredHeight}
      layoutMode={layout}
      fullscreenContainer={fullscreenContainer}
      isActive={isActive}
    />
  );
}

function withIdleIcon(node: MultiReviewFlowNodeModel): MultiReviewFlowNodeModel {
  const idleIcon = IDLE_ICON[node.kind];
  return idleIcon && !node.idleIcon ? { ...node, idleIcon } : node;
}
