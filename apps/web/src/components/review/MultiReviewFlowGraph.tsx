import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  GitMerge,
  GitPullRequest,
  Loader2,
  Pause,
  Square,
  Wrench,
} from "lucide-react";
import type { ReviewSeverity } from "@orkestrator/protocol/structured-review";
import type { ReviewValidationResult } from "@orkestrator/protocol/review-workflow";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRuntimeParts, type RuntimeParts } from "@/lib/review/runtime-summary";
import { cn } from "@/lib/utils";
import { reviewSeverityStyles } from "./StructuredReviewReportView";
import {
  FLOW_GRAPH_STACK_BELOW,
  MULTI_REVIEW_SEVERITIES,
  flowEdgePath,
  multiReviewFlowLayout,
  cleanReviewPrEdgePath,
  summarizeFlowEdges,
  type FlowRect,
  type MultiReviewFlowEdgeState,
  type MultiReviewFlowEdges,
  type MultiReviewFlowState,
} from "./multi-review-flow";
import { useMultiReviewFlowViewStore } from "@/stores/multiReviewFlowViewStore";
import { useUIStore } from "@/stores/uiStore";
import { FlowHeightDivider, FlowZoomControls, useFlowViewport } from "./MultiReviewFlowViewport";
import {
  FLOW_VIEWPORT_RESIZE_MIN_HEIGHT,
  resizedFlowViewportHeight,
} from "./multi-review-flow-viewport";

export type MultiReviewFlowNodeKind = "package" | "reviewer" | "consolidation" | "fix" | "pr";

/** Everything one node shows, plus how it opens and what its context menu holds. */
export interface MultiReviewFlowNodeModel {
  id: string;
  kind: MultiReviewFlowNodeKind;
  title: string;
  state: MultiReviewFlowState;
  stalled: boolean;
  /** The full status, for the inspector pill and the node's accessible name. */
  statusLabel: string;
  /** `{agent} · {model} · {effort}` for steps, `{model} · {effort}` for reviewers. */
  detail: string;
  runtime: RuntimeParts | null;
  runtimeLabel: string;
  /** Shown where the runtime would be, for a node that has not run. */
  pendingLabel?: string;
  /** Short state word on the second row of a node that is neither queued nor clean. */
  statusWord?: { text: string; tone: "muted" | "running" | "warning" | "destructive" };
  severity?: Record<ReviewSeverity, number>;
  /** Finding totals in words, so the chips are not the only place they exist. */
  findingsLabel?: string;
  validation?: { id: string; label: string; status: ReviewValidationResult["status"] }[];
  /**
   * Why a failed node failed. The node shows it on one line in place of the
   * model, and its tooltip and accessible description carry the whole text.
   */
  error?: string;
  canOpen: boolean;
  onOpen: () => void;
  contextMenu: ReactNode;
}

const NODE_STATE_CLASS: Record<MultiReviewFlowState, string> = {
  "not-started": "border-dashed border-border bg-sidebar text-muted-foreground",
  running:
    "border-cyan-400 bg-flow-node ring-4 ring-cyan-400/10 shadow-[0_8px_30px_rgb(0_0_0/0.65)]",
  paused: "border-amber-400/60 bg-flow-node",
  complete: "border-success/55 bg-flow-node",
  failed: "border-failure/70 bg-flow-node",
  cancelling: "border-border bg-sidebar text-muted-foreground",
  cancelled: "border-border bg-sidebar text-muted-foreground",
};

const ICON_CLASS = "size-3.5 shrink-0";

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
  const iconClass = cn(ICON_CLASS, className);
  if (stalled && state === "running") {
    return <AlertTriangle className={cn(iconClass, "text-amber-500")} />;
  }
  switch (state) {
    case "running":
      return <Loader2 className={cn(iconClass, "animate-spin text-cyan-300")} />;
    case "paused":
      return <Pause className={cn(iconClass, "text-amber-400")} />;
    case "failed":
      return <AlertCircle className={cn(iconClass, "text-failure")} />;
    case "cancelling":
    case "cancelled":
      return <Square className={cn(iconClass, "text-muted-foreground")} />;
    case "complete":
      return <CheckCircle2 className={cn(iconClass, "text-success")} />;
    default: {
      const Idle =
        kind === "reviewer"
          ? Clock3
          : kind === "consolidation"
            ? GitMerge
            : kind === "fix"
              ? Wrench
              : kind === "pr"
                ? GitPullRequest
                : Circle;
      return <Idle className={cn(iconClass, "text-muted-foreground/70")} />;
    }
  }
}

/**
 * `{elapsed} · {tokens}`. The word "tokens" is screen-reader text only: the node
 * has room for the count beside the clock, and the inspector spells it out.
 */
export function FlowRuntime({
  runtime,
  label,
  className,
}: {
  runtime: RuntimeParts;
  label?: string;
  className?: string;
}) {
  const tokens = runtime.tokens ? (
    <>
      {runtime.tokens}
      <span className="sr-only"> tokens</span>
    </>
  ) : runtime.tokensPending ? (
    "Tokens pending"
  ) : null;
  return (
    <span
      aria-label={label}
      className={cn(
        "shrink-0 font-mono text-[11px] font-normal tabular-nums",
        runtime.live ? "text-cyan-300" : "text-muted-foreground",
        className,
      )}
    >
      {runtime.elapsed}
      {runtime.elapsed && tokens ? <span className="text-flow-edge"> · </span> : null}
      {tokens}
    </span>
  );
}

const STATUS_WORD_TONE = {
  muted: "text-muted-foreground",
  running: "text-cyan-300/80",
  warning: "text-amber-500",
  destructive: "text-failure",
} as const;

export function SeverityChips({
  counts,
  className,
}: {
  counts: Record<ReviewSeverity, number>;
  className?: string;
}) {
  const present = MULTI_REVIEW_SEVERITIES.filter((severity) => counts[severity] > 0);
  if (present.length === 0) {
    return <span className={cn("text-[11px] text-muted-foreground", className)}>no issues</span>;
  }
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {present.map((severity) => (
        <span
          key={severity}
          title={`${counts[severity]} ${severity} ${counts[severity] === 1 ? "issue" : "issues"}`}
          data-severity={severity}
          className={cn(
            "min-w-[18px] rounded-[5px] border px-1 text-center font-mono text-[10.5px] leading-4 tabular-nums",
            reviewSeverityStyles[severity],
          )}
        >
          {counts[severity]}
        </span>
      ))}
    </span>
  );
}

const VALIDATION_CHIP_CLASS: Record<ReviewValidationResult["status"], string> = {
  passed: "bg-success/10 text-green-300",
  skipped: "bg-elevated text-muted-foreground",
  failed: "bg-failure/12 text-failure",
  incomplete: "bg-failure/12 text-failure",
  running: "bg-cyan-400/10 text-cyan-300",
  queued: "border border-dashed border-border text-muted-foreground",
  pending: "border border-dashed border-border text-muted-foreground",
};

const MAX_VALIDATION_CHIPS = 4;

function ValidationChips({
  checks,
}: {
  checks: NonNullable<MultiReviewFlowNodeModel["validation"]>;
}) {
  const shown = checks.slice(0, MAX_VALIDATION_CHIPS);
  const hidden = checks.length - shown.length;
  return (
    <div className="mt-2 flex min-w-0 gap-1 overflow-hidden" aria-label="Validation checks">
      {shown.map((check) => (
        <span
          key={check.id}
          title={`${check.label}: ${check.status}`}
          data-validation-status={check.status}
          className={cn(
            "max-w-32 shrink-0 truncate rounded-[5px] px-1 text-[10.5px] leading-4",
            VALIDATION_CHIP_CLASS[check.status],
          )}
        >
          {check.label}
          {check.status === "skipped" ? " skipped" : ""}
        </span>
      ))}
      {hidden > 0 ? (
        <span className="shrink-0 px-1 text-[10.5px] leading-4 text-muted-foreground">
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

function FlowNode({
  node,
  selected,
  focusable,
  panelId,
  style,
  className,
  registerRef,
  onSelect,
  onKeyDown,
}: {
  node: MultiReviewFlowNodeModel;
  selected: boolean;
  focusable: boolean;
  panelId: string;
  style?: CSSProperties;
  className?: string;
  registerRef: (id: string, element: HTMLButtonElement | null) => void;
  onSelect: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, node: MultiReviewFlowNodeModel) => void;
}) {
  const errorId = useId();
  const failure = node.state === "failed" && node.error?.trim() ? node.error : undefined;
  const openHint = node.canOpen ? "Double-click or press Enter to open the session" : undefined;
  const muted = node.state === "not-started" || node.state === "cancelled";
  const accessibleName = [
    node.title,
    node.statusLabel,
    node.runtime ? formatRuntimeParts(node.runtime) : null,
    node.findingsLabel,
  ]
    .filter(Boolean)
    .join(", ");
  const trigger = (
    <ContextMenuTrigger asChild>
      <button
        ref={(element) => registerRef(node.id, element)}
        type="button"
        role="tab"
        id={flowNodeElementId(panelId, node.id)}
        aria-selected={selected}
        aria-controls={panelId}
        aria-label={accessibleName}
        {...(failure ? { "aria-describedby": errorId } : {})}
        // A failed node's tooltip carries the hint with the error.
        title={failure ? undefined : openHint}
        tabIndex={focusable ? 0 : -1}
        data-flow-node={node.kind}
        data-flow-state={node.state}
        style={style}
        className={cn(
          "flex min-w-0 flex-col justify-center rounded-xl border px-3 py-3 text-left transition-[border-color,box-shadow,outline-color] outline-2 outline-offset-[3px] outline-transparent focus-visible:outline-primary",
          NODE_STATE_CLASS[node.state],
          selected && "outline-primary/60",
          className,
        )}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => {
          if (node.canOpen) node.onOpen();
        }}
        onKeyDown={(event) => onKeyDown(event, node)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <MultiReviewFlowStateIcon kind={node.kind} state={node.state} stalled={node.stalled} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] font-semibold",
              muted ? "text-zinc-400" : "text-foreground",
            )}
          >
            {node.title}
          </span>
          {node.runtime ? (
            <FlowRuntime runtime={node.runtime} label={node.runtimeLabel} />
          ) : node.pendingLabel ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">{node.pendingLabel}</span>
          ) : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2">
          {failure ? (
            <span
              id={errorId}
              data-flow-node-error=""
              className="min-w-0 flex-1 truncate text-xs text-failure"
            >
              {errorExcerpt(failure)}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {node.detail}
            </span>
          )}
          {node.severity ? (
            <SeverityChips counts={node.severity} />
          ) : node.statusWord && !failure ? (
            <span className={cn("shrink-0 text-[11px]", STATUS_WORD_TONE[node.statusWord.tone])}>
              {node.statusWord.text}
            </span>
          ) : null}
        </span>
        {node.validation?.length ? <ValidationChips checks={node.validation} /> : null}
      </button>
    </ContextMenuTrigger>
  );
  return (
    <ContextMenu>
      {failure ? (
        // Radix opens a tooltip on keyboard focus as well as on hover, so the
        // arrow keys that walk the graph show the whole error too.
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            data-testid="multi-review-node-error-tooltip"
            className="max-h-72 max-w-sm overflow-y-auto text-left"
          >
            <p className="break-words whitespace-pre-wrap text-failure">{failure}</p>
            {openHint ? <p className="mt-1.5 text-muted-foreground">{openHint}</p> : null}
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <ContextMenuContent className="w-44">{node.contextMenu}</ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The error on one line. The node truncates it to its width; the whole text
 * stays in the element, which is the node's accessible description.
 */
export function errorExcerpt(error: string): string {
  return error.replace(/\s+/g, " ").trim();
}

export function flowNodeElementId(panelId: string, nodeId: string): string {
  return `${panelId}-node-${nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const EDGE_CLASS: Record<MultiReviewFlowEdgeState, string> = {
  complete: "stroke-success opacity-55",
  active: "stroke-cyan-400",
  ready: "stroke-success opacity-55",
  pending: "stroke-flow-edge",
  failed: "stroke-failure opacity-55",
};

const CONNECTOR_CLASS: Record<MultiReviewFlowEdgeState, string> = {
  complete: "border-success/55",
  active: "border-cyan-400",
  ready: "border-dashed border-success/55",
  pending: "border-dashed border-flow-edge",
  failed: "border-failure/55",
};

const PORT_CLASS: Record<MultiReviewFlowState, string> = {
  "not-started": "fill-flow-edge",
  running: "fill-cyan-400",
  paused: "fill-amber-400",
  complete: "fill-success",
  failed: "fill-failure",
  cancelling: "fill-flow-edge",
  cancelled: "fill-flow-edge",
};

function isDashed(state: MultiReviewFlowEdgeState): boolean {
  return state === "pending" || state === "ready";
}

function FlowEdge({
  id,
  d,
  state,
  source,
}: {
  id: string;
  d: string;
  state: MultiReviewFlowEdgeState;
  source?: string;
}) {
  return (
    <>
      <path
        d={d}
        data-flow-edge={id}
        data-flow-source={source}
        data-edge-state={state}
        className={EDGE_CLASS[state]}
        strokeWidth={2}
        fill="none"
        strokeDasharray={isDashed(state) ? "4 5" : undefined}
      />
      {state === "active" ? (
        <circle r={3} className="fill-cyan-200 motion-reduce:hidden">
          <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
        </circle>
      ) : null}
    </>
  );
}

function Port({
  rect,
  side,
  state,
}: {
  rect: FlowRect;
  side: "in" | "out";
  state: MultiReviewFlowState;
}) {
  return (
    <circle
      cx={side === "out" ? rect.x + rect.width : rect.x}
      cy={rect.y + rect.height / 2}
      r={4}
      className={PORT_CLASS[state]}
    />
  );
}

function ColumnLabel({
  children,
  style,
  title,
}: {
  children: ReactNode;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      style={style}
      title={title}
      className="text-[10.5px] font-medium tracking-[0.14em] whitespace-nowrap text-muted-foreground/70 uppercase"
    >
      {children}
    </span>
  );
}

/** The canvas width, or null until it has been measured (and in DOM tests). */
function useMeasuredWidth(): [(element: HTMLDivElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = element.clientWidth;
      setWidth(next > 0 ? next : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

/** The stacked column's natural height, or null until it has been measured. */
function useMeasuredHeight(): [(element: HTMLDivElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    // `offsetHeight` ignores transforms, so zooming never feeds back into it.
    const measure = () => setHeight(element.offsetHeight > 0 ? element.offsetHeight : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, height];
}

/**
 * Fullscreen lays the graph over its container until the button or Escape
 * leaves it. An Escape that a context menu, tooltip or dialog already handled
 * (Radix marks it handled) only closes that. Moving in or out remounts the
 * graph, so focus that it drops goes back to the fullscreen button.
 */
function useFlowFullscreen(
  wrapperRef: RefObject<HTMLDivElement | null>,
  isActive: boolean,
): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(false);
  const changedRef = useRef(false);
  useLayoutEffect(() => {
    if (!changedRef.current) return;
    changedRef.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    wrapperRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="multi-review-fullscreen"]')
      ?.focus();
  }, [fullscreen, wrapperRef]);
  useEffect(() => {
    if (!fullscreen || !isActive) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !wrapperRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      changedRef.current = true;
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, isActive, wrapperRef]);
  const toggle = useCallback(() => {
    changedRef.current = true;
    setFullscreen((current) => !current);
  }, []);
  return [fullscreen, toggle];
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
 * The pipeline as a left-to-right graph: package, the reviewer panel stacked
 * in one column, consolidation, Fix, then the pull request. Below
 * {@link FLOW_GRAPH_STACK_BELOW} pixels it becomes a single column with
 * straight connectors.
 *
 * Nodes are tabs controlling the inspector: one tab stop for the graph, arrow
 * keys walk the pipeline in order, and Enter opens the node's session. The
 * graph zooms and pans inside its viewport (see `useFlowViewport`), and a node
 * reached from the keyboard is scrolled into view first. When the selection
 * moves to another stage, that stage is centred as far as the canvas scrolls.
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
  const stackedWrapperRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, toggleFullscreen] = useFlowFullscreen(stackedWrapperRef, isActive);
  const overlayClass = fullscreenContainer ? "absolute inset-0 z-30" : "fixed inset-0 z-50";
  const present = (graph: ReactNode) =>
    fullscreen ? createPortal(graph, fullscreenContainer ?? document.body) : graph;
  const [measureRef, measuredWidth] = useMeasuredWidth();
  const [measureViewportRef, viewportWidth] = useMeasuredWidth();
  // In fullscreen the viewport takes the overlay's height rather than its own.
  const [measureViewportHeight, viewportHeight] = useMeasuredHeight();
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const order = [packageNode, ...reviewerNodes, consolidationNode, fixNode, prNode];
  const stacked =
    layout === "stacked" ||
    (layout === undefined && measuredWidth !== null && measuredWidth < FLOW_GRAPH_STACK_BELOW);
  const geometry = multiReviewFlowLayout({
    width: viewportWidth ?? measuredWidth ?? 1440,
    reviewerCount: reviewerNodes.length,
    packageHasChips: Boolean(packageNode.validation?.length),
  });
  // The height dragged with the divider, shared by every Multi Review; while
  // it drags, the height under the pointer.
  const storedHeight = useUIStore((state) => state.multiReviewGraphHeight);
  const setStoredHeight = useUIStore((state) => state.setMultiReviewGraphHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const requestedHeight = dragHeight ?? storedHeight;
  const chosenHeight =
    requestedHeight === null ? null : resizedFlowViewportHeight(requestedHeight, geometry.height);
  const flowViewport = useFlowViewport({
    viewKey,
    measuredWidth: viewportWidth,
    content: { width: geometry.width, height: geometry.height },
    fillHeight: fullscreen ? viewportHeight : chosenHeight,
  });
  const { attachViewport } = flowViewport;
  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      measureViewportRef(element);
      measureViewportHeight(element);
      attachViewport(element);
    },
    [attachViewport, measureViewportHeight, measureViewportRef],
  );
  // The stacked column keeps a view of its own, under its own key, so each
  // layout restores what it was left at.
  const [columnRef, columnHeight] = useMeasuredHeight();
  // This outer element survives layout changes and never reserves a scrollbar
  // gutter. Only the inner viewport measurement determines graph geometry.
  const wrapperRef = useCallback(
    (element: HTMLDivElement | null) => {
      stackedWrapperRef.current = element;
      measureRef(element);
    },
    [measureRef],
  );
  const stackedViewport = useFlowViewport({
    viewKey: `${viewKey}\u0000stacked`,
    measuredWidth,
    content: { width: measuredWidth ?? 0, height: columnHeight ?? 0 },
    layout: "stacked",
  });
  const attachStackedViewport = stackedViewport.attachViewport;
  const stackedViewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      attachStackedViewport(element);
    },
    [attachStackedViewport],
  );
  const registerRef = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  }, []);

  const nodeRect = (id: string): FlowRect | undefined => {
    if (id === packageNode.id) return geometry.package;
    if (id === consolidationNode.id) return geometry.consolidation;
    if (id === fixNode.id) return geometry.fix;
    if (id === prNode.id) return geometry.pr;
    const index = reviewerNodes.findIndex((node) => node.id === id);
    return index >= 0 ? geometry.reviewers[index] : undefined;
  };

  // A new stage is centred once the viewport is measured, and again when the
  // width changes, since that resets the scroll. On the first measurement a
  // remembered view wins, so returning to the review keeps where it was left.
  const selectedStage = order.find((node) => node.id === selectedId)?.kind;
  const centredRef = useRef<{ key: string; stage: string | undefined; width: number } | null>(null);
  const centerRef = useRef(() => {});
  useLayoutEffect(() => {
    centerRef.current = () => {
      const previous = centredRef.current;
      const last = previous?.key === viewKey ? previous : null;
      if (stacked || viewportWidth === null) return;
      centredRef.current = { key: viewKey, stage: selectedStage, width: viewportWidth };
      if (last && last.stage === selectedStage && last.width === viewportWidth) return;
      if (
        !last &&
        useMultiReviewFlowViewStore.getState().views.get(viewKey)?.width === viewportWidth
      )
        return;
      const rect = nodeRect(selectedId);
      if (rect) flowViewport.center(rect, { smooth: last?.width === viewportWidth });
    };
  });
  useEffect(() => {
    centerRef.current();
  }, [selectedStage, viewportWidth, stacked, viewKey]);

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    node: MultiReviewFlowNodeModel,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSelect(node.id);
      if (node.canOpen) node.onOpen();
      return;
    }
    const index = order.findIndex((candidate) => candidate.id === node.id);
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = order.length - 1;
    if (target === null) return;
    event.preventDefault();
    const next = order[Math.max(0, Math.min(order.length - 1, target))]!;
    onSelect(next.id);
    // Scroll the zoomed canvas first, so the browser's own focus scrolling
    // only has the page left to adjust.
    const rect = stacked ? undefined : nodeRect(next.id);
    if (rect) flowViewport.reveal(rect);
    nodeRefs.current.get(next.id)?.focus();
  };

  const renderNode = (
    node: MultiReviewFlowNodeModel,
    style?: CSSProperties,
    className?: string,
  ) => (
    <FlowNode
      key={node.id}
      node={node}
      selected={node.id === selectedId}
      focusable={node.id === selectedId}
      panelId={panelId}
      style={style}
      className={className}
      registerRef={registerRef}
      onSelect={onSelect}
      onKeyDown={handleKeyDown}
    />
  );

  const canvasClass =
    "bg-flow-canvas bg-[radial-gradient(var(--color-divider)_1px,transparent_1px)] bg-size-[20px_20px]";

  if (stacked) {
    // A hop and the next stage's label. The negative margin takes back the
    // column's gaps, so the line runs from one node's edge to the next's and
    // the label sits beside it. `afterBranch` follows the clean-review route
    // around Fix: that route has already brought the line down, so the hop
    // only continues it into the PR node.
    const connector = (
      state: MultiReviewFlowEdgeState,
      id: string,
      label: ReactNode,
      afterBranch = false,
    ) => (
      <div className={cn("relative -my-1.5 flex flex-col pb-1.5", afterBranch ? "pt-1.5" : "pt-8")}>
        <div
          aria-hidden="true"
          data-flow-edge={afterBranch ? undefined : id}
          data-edge-state={afterBranch ? undefined : state}
          className={cn(
            "pointer-events-none absolute inset-y-0 left-1/2 -ml-px w-0 border-l-2",
            CONNECTOR_CLASS[state],
          )}
        />
        {label}
      </div>
    );
    const { zoom, offset, panning, viewportHandlers } = stackedViewport;
    // Until the column is measured it renders unscaled, exactly as at 100%.
    const scaled = zoom !== 1 && measuredWidth !== null && columnHeight !== null;
    return present(
      <div
        ref={wrapperRef}
        data-flow-layout="stacked"
        data-flow-fullscreen={fullscreen ? "" : undefined}
        className={cn(
          fullscreen ? cn(overlayClass, "overflow-y-auto") : "relative border-b border-divider",
          canvasClass,
        )}
      >
        {/* Sticky, so the controls stay in reach while a long column scrolls. */}
        <div className="pointer-events-none sticky top-0 z-10 flex justify-end px-3 pt-3">
          <div className="pointer-events-auto">
            <FlowZoomControls
              placement="inline"
              zoom={zoom}
              onZoomOut={() => stackedViewport.zoomBy(-1)}
              onZoomIn={() => stackedViewport.zoomBy(1)}
              onReset={stackedViewport.resetZoom}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
            />
          </div>
        </div>
        <div
          ref={stackedViewportRef}
          data-flow-viewport=""
          // Sideways only: the page keeps vertical scrolling, and the browser
          // leaves pinch to the viewport.
          className={cn(
            "overflow-x-auto overflow-y-hidden [touch-action:pan-x_pan-y]",
            zoom > 1 && (panning ? "cursor-grabbing select-none" : "cursor-grab"),
          )}
          {...viewportHandlers}
        >
          <div
            style={
              scaled
                ? {
                    position: "relative",
                    overflow: "clip",
                    width: measuredWidth * zoom,
                    height: columnHeight * zoom,
                    marginLeft: offset.x,
                  }
                : undefined
            }
          >
            <div
              ref={columnRef}
              role="tablist"
              aria-label="Multi Review pipeline"
              aria-orientation="vertical"
              className="flex flex-col gap-1.5 px-4 pt-2 pb-4"
              style={
                scaled
                  ? {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: measuredWidth,
                      transform: `scale(${zoom})`,
                      transformOrigin: "0 0",
                    }
                  : undefined
              }
            >
              <ColumnLabel>Prepare</ColumnLabel>
              {renderNode(packageNode, undefined, "w-full")}
              {connector(
                summarizeFlowEdges(edges.intoReviewers),
                "into-reviewers",
                <ColumnLabel title={reviewTitle}>{reviewLabel}</ColumnLabel>,
              )}
              {reviewerNodes.map((node) => renderNode(node, undefined, "w-full"))}
              {connector(
                summarizeFlowEdges(edges.intoConsolidation),
                "into-consolidation",
                <ColumnLabel>Consolidate</ColumnLabel>,
              )}
              {renderNode(consolidationNode, undefined, "w-full")}
              <div className="relative flex flex-col gap-1.5">
                {connector(edges.intoFix, "into-fix", <ColumnLabel>Fix</ColumnLabel>)}
                {renderNode(fixNode, undefined, "w-full")}
                {edges.prSource === "consolidation" ? (
                  <>
                    <div
                      aria-hidden="true"
                      data-flow-edge="into-pr"
                      data-flow-source="consolidation"
                      data-edge-state={edges.intoPr}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 left-1/2 w-[calc(50%+8px)] rounded-r-xl border-y-2 border-r-2",
                        CONNECTOR_CLASS[edges.intoPr],
                      )}
                    />
                    <div aria-hidden="true" className="h-5" />
                  </>
                ) : null}
              </div>
              {connector(
                edges.intoPr,
                "into-pr",
                <ColumnLabel>PR</ColumnLabel>,
                edges.prSource === "consolidation",
              )}
              {renderNode(prNode, undefined, "w-full")}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  const place = (rect: FlowRect): CSSProperties => ({
    position: "absolute",
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  });
  const { zoom, viewport, offset, panning, viewportHandlers } = flowViewport;

  return present(
    <div
      ref={wrapperRef}
      data-flow-layout="graph"
      data-flow-fullscreen={fullscreen ? "" : undefined}
      className={cn(
        fullscreen
          ? cn(overlayClass, "flex flex-col")
          : "relative shrink-0 border-b border-divider",
        canvasClass,
      )}
    >
      <div
        ref={viewportRef}
        data-flow-viewport=""
        // Fullscreen leaves the height to the overlay, and measures it.
        style={fullscreen ? undefined : { height: viewport.height }}
        className={cn(
          fullscreen && "min-h-0 flex-1",
          // A stable gutter keeps the measured width, and so the layout, from
          // changing when zooming adds a scrollbar.
          "overflow-auto overscroll-contain [scrollbar-gutter:stable]",
          panning ? "cursor-grabbing select-none" : "cursor-grab",
        )}
        {...viewportHandlers}
      >
        <div
          className="relative overflow-clip"
          style={{
            width: geometry.width * zoom,
            height: geometry.height * zoom,
            marginLeft: offset.x,
            marginTop: offset.y,
          }}
        >
          <div
            role="tablist"
            aria-label="Multi Review pipeline"
            className="absolute top-0 left-0 cursor-default"
            style={{
              width: geometry.width,
              height: geometry.height,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              width={geometry.width}
              height={geometry.height}
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              fill="none"
            >
              {reviewerNodes.map((node, index) => (
                <Fragment key={node.id}>
                  <FlowEdge
                    id={`into-reviewer-${index}`}
                    d={flowEdgePath(geometry.package, geometry.reviewers[index]!)}
                    state={edges.intoReviewers[index] ?? "pending"}
                  />
                  <FlowEdge
                    id={`into-consolidation-${index}`}
                    d={flowEdgePath(geometry.reviewers[index]!, geometry.consolidation)}
                    state={edges.intoConsolidation[index] ?? "pending"}
                  />
                </Fragment>
              ))}
              <FlowEdge
                id="into-fix"
                d={flowEdgePath(geometry.consolidation, geometry.fix)}
                state={edges.intoFix}
              />
              <FlowEdge
                id="into-pr"
                source={edges.prSource ?? "fix"}
                d={
                  edges.prSource === "consolidation"
                    ? cleanReviewPrEdgePath(geometry.consolidation, geometry.pr)
                    : flowEdgePath(geometry.fix, geometry.pr)
                }
                state={edges.intoPr}
              />
              <Port rect={geometry.package} side="out" state={packageNode.state} />
              <Port rect={geometry.consolidation} side="in" state={consolidationNode.state} />
              <Port rect={geometry.fix} side="in" state={fixNode.state} />
              <Port rect={geometry.pr} side="in" state={prNode.state} />
            </svg>
            <ColumnLabel style={{ position: "absolute", left: geometry.columns.prepare, top: 16 }}>
              Prepare
            </ColumnLabel>
            <ColumnLabel
              title={reviewTitle}
              style={{ position: "absolute", left: geometry.columns.review, top: 16 }}
            >
              {reviewLabel}
            </ColumnLabel>
            <ColumnLabel
              style={{ position: "absolute", left: geometry.columns.consolidate, top: 16 }}
            >
              Consolidate
            </ColumnLabel>
            <ColumnLabel style={{ position: "absolute", left: geometry.columns.fix, top: 16 }}>
              Fix
            </ColumnLabel>
            <ColumnLabel style={{ position: "absolute", left: geometry.columns.pr, top: 16 }}>
              PR
            </ColumnLabel>
            {renderNode(packageNode, place(geometry.package))}
            {reviewerNodes.map((node, index) =>
              renderNode(node, place(geometry.reviewers[index]!)),
            )}
            {renderNode(consolidationNode, place(geometry.consolidation))}
            {renderNode(fixNode, place(geometry.fix))}
            {renderNode(prNode, place(geometry.pr))}
          </div>
        </div>
      </div>
      <FlowZoomControls
        zoom={zoom}
        onZoomOut={() => flowViewport.zoomBy(-1)}
        onZoomIn={() => flowViewport.zoomBy(1)}
        onReset={flowViewport.resetZoom}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
      />
      {fullscreen ? null : (
        <FlowHeightDivider
          height={viewport.height}
          min={FLOW_VIEWPORT_RESIZE_MIN_HEIGHT}
          max={resizedFlowViewportHeight(Number.POSITIVE_INFINITY, geometry.height)}
          onResize={setDragHeight}
          onCommit={(height) => {
            setDragHeight(null);
            setStoredHeight(height);
          }}
        />
      )}
    </div>,
  );
}
