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
  Loader2,
  Pause,
  Square,
  type LucideIcon,
} from "lucide-react";
import type { ReviewSeverity } from "@orkestrator/protocol/structured-review";
import type { ReviewValidationResult } from "@orkestrator/protocol/review-workflow";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRuntimeParts, type RuntimeParts } from "@/lib/review/runtime-summary";
import { cn } from "@/lib/utils";
import { reviewSeverityStyles } from "@/components/review/StructuredReviewReportView";
import {
  FLOW_GRAPH_STACK_BELOW,
  bypassEdgePath,
  flowEdgePath,
  flowNodeHasRuntimeRow,
  type FlowEdgeState,
  type FlowGraphGeometry,
  type FlowNodeState,
  type FlowRect,
} from "./flow-graph-model";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { FlowHeightDivider, FlowZoomControls, useFlowViewport } from "./FlowViewport";
import { FLOW_VIEWPORT_RESIZE_MIN_HEIGHT, resizedFlowViewportHeight } from "./flow-viewport";

export const FLOW_SEVERITIES: readonly ReviewSeverity[] = ["P0", "P1", "P2"];

/** Everything one node shows, plus how it opens and what its context menu holds. */
export interface FlowNodeModel {
  id: string;
  /** What the node is (`data-flow-node`), e.g. `reviewer` or `verify`. */
  kind: string;
  /**
   * The pipeline column it sits in. Moving the selection to another stage
   * centres it. Defaults to {@link kind}.
   */
  stage?: string;
  title: string;
  state: FlowNodeState;
  stalled: boolean;
  /** The full status, for the inspector pill and the node's accessible name. */
  statusLabel: string;
  /** `{agent} · {model} · {effort}` for steps, `{model} · {effort}` for reviewers. */
  detail: string;
  runtime: RuntimeParts | null;
  runtimeLabel: string;
  /** An explicitly labelled absolute start time, separate from elapsed runtime. */
  startTime?: { dateTime: string; text: string };
  /** A small badge beside the title of a node that has not run, e.g. "ahead". */
  pendingLabel?: string;
  /**
   * Short state word of a node that is neither queued nor clean: beside the
   * runtime on a running node's third row, else at the end of the second.
   */
  statusWord?: { text: string; tone: "muted" | "running" | "warning" | "destructive" };
  severity?: Record<ReviewSeverity, number>;
  /** Finding totals in words, so the chips are not the only place they exist. */
  findingsLabel?: string;
  validation?: { id: string; label: string; status: ReviewValidationResult["status"] }[];
  /**
   * Why a failed node failed. The node shows it on one line in place of the
   * model (see {@link FlowErrorFace}), and its tooltip and accessible
   * description carry the whole text.
   */
  error?: string;
  /** Shown while the node has not run; a hollow circle by default. */
  idleIcon?: LucideIcon;
  /**
   * A step the workflow will reach but has not started, drawn faded ahead of
   * the work. Steps that only sometimes run are never drawn ahead.
   */
  placeholder?: boolean;
  /**
   * History a restart replaced: still selectable and readable, drawn greyed
   * so the live run stands out.
   */
  superseded?: boolean;
  /** One more row on the node's face, e.g. a pull request's checks. */
  extra?: ReactNode;
  canOpen: boolean;
  onOpen: () => void;
  contextMenu: ReactNode;
}

const NODE_STATE_CLASS: Record<FlowNodeState, string> = {
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

export function FlowStateIcon({
  state,
  stalled,
  idleIcon: Idle = Circle,
  className,
}: {
  state: FlowNodeState;
  stalled: boolean;
  idleIcon?: LucideIcon;
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
    default:
      return <Idle className={cn(iconClass, "text-muted-foreground/70")} />;
  }
}

/**
 * `{elapsed} · {tokens}`. The word "tokens" is screen-reader text only: the node
 * has room for the count beside the clock, and the inspector spells it out.
 * A live turn whose provider has not reported usage yet shows a dash, not a
 * claim that a count is on its way.
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
    <span title="No token usage reported yet">—</span>
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
  const present = FLOW_SEVERITIES.filter((severity) => counts[severity] > 0);
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

function ValidationChips({ checks }: { checks: NonNullable<FlowNodeModel["validation"]> }) {
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
  testIdPrefix,
  errorFace,
}: {
  node: FlowNodeModel;
  selected: boolean;
  focusable: boolean;
  panelId: string;
  style?: CSSProperties;
  className?: string;
  registerRef: (id: string, element: HTMLButtonElement | null) => void;
  onSelect: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, node: FlowNodeModel) => void;
  testIdPrefix: string;
  errorFace: FlowErrorFace;
}) {
  const errorId = useId();
  const failure = node.state === "failed" && node.error?.trim() ? node.error : undefined;
  const openHint = node.canOpen ? "Double-click or press Enter to open the session" : undefined;
  const muted = node.state === "not-started" || node.state === "cancelled";
  const runtimeRow = flowNodeHasRuntimeRow(node);
  // A running node's state word sits with its clock, on the runtime row.
  const runningWord =
    node.state === "running" && !failure && !node.severity ? node.statusWord : undefined;
  const accessibleName = [
    node.title,
    node.statusLabel,
    // Usage not reported yet is left unsaid rather than announced as pending.
    node.runtime ? formatRuntimeParts({ ...node.runtime, tokensPending: false }) : null,
    node.startTime?.text,
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
        data-flow-placeholder={node.placeholder ? "" : undefined}
        data-flow-superseded={node.superseded ? "" : undefined}
        style={style}
        className={cn(
          "flex min-w-0 flex-col justify-center rounded-xl border px-3 py-3 text-left transition-[border-color,box-shadow,outline-color] outline-2 outline-offset-[3px] outline-transparent focus-visible:outline-primary",
          NODE_STATE_CLASS[node.state],
          node.placeholder && "opacity-55",
          node.superseded && "border-dashed opacity-60 grayscale",
          selected && "outline-primary/60",
          className,
        )}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => {
          if (node.canOpen) node.onOpen();
        }}
        onKeyDown={(event) => onKeyDown(event, node)}
      >
        {/* Row 1: the title, whole, and at most a small badge that gives way to it. */}
        <span data-flow-node-row="title" className="flex min-w-0 items-center gap-2">
          <FlowStateIcon state={node.state} stalled={node.stalled} idleIcon={node.idleIcon} />
          <span
            data-flow-node-title=""
            className={cn(
              "max-w-full min-w-0 shrink-0 truncate text-[13px] font-semibold",
              muted ? "text-zinc-400" : "text-foreground",
            )}
          >
            {node.title}
          </span>
          {!node.runtime && node.pendingLabel ? (
            <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
              {node.pendingLabel}
            </span>
          ) : null}
        </span>
        {/* Row 2: `{agent} · {model} · {effort}`; this truncates, never the title. */}
        <span data-flow-node-row="detail" className="mt-0.5 flex min-w-0 items-center gap-2">
          {failure && errorFace === "joined" ? (
            <span
              id={errorId}
              data-flow-node-error=""
              className="min-w-0 flex-1 truncate text-xs text-failure"
            >
              {errorExcerpt(failure)}
            </span>
          ) : failure ? (
            <>
              <span
                aria-hidden
                data-flow-node-error=""
                className="min-w-0 flex-1 truncate text-xs text-failure"
              >
                {errorFirstLine(failure)}
              </span>
              {/* The face drops the lines after the first; the description keeps them. */}
              <span id={errorId} data-flow-node-error-full="" className="sr-only">
                {failure}
              </span>
            </>
          ) : (
            <span
              data-flow-node-detail=""
              title={node.detail || undefined}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {node.detail}
            </span>
          )}
          {node.severity ? (
            <SeverityChips counts={node.severity} />
          ) : node.statusWord && !failure && !runningWord ? (
            <span className={cn("shrink-0 text-[11px]", STATUS_WORD_TONE[node.statusWord.tone])}>
              {node.statusWord.text}
            </span>
          ) : null}
        </span>
        {node.startTime ? (
          <time
            data-flow-node-row="start"
            dateTime={node.startTime.dateTime}
            className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums"
          >
            {node.startTime.text}
          </time>
        ) : null}
        {/* Row 3: the clock and usage, live while running and final after. */}
        {runtimeRow ? (
          <span data-flow-node-row="runtime" className="mt-0.5 flex min-w-0 items-center gap-2">
            {node.runtime ? <FlowRuntime runtime={node.runtime} label={node.runtimeLabel} /> : null}
            {runningWord ? (
              <span
                className={cn(
                  "ml-auto min-w-0 truncate text-[11px]",
                  STATUS_WORD_TONE[runningWord.tone],
                )}
              >
                {runningWord.text}
              </span>
            ) : null}
          </span>
        ) : null}
        {node.validation?.length ? <ValidationChips checks={node.validation} /> : null}
        {node.extra}
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
            data-testid={`${testIdPrefix}-node-error-tooltip`}
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
 * How a failed node's face shows its error. `first-line` shows the error's
 * first non-blank line; `joined` joins every line into one, as Multi Review
 * always has. Either way the node truncates it to its width, and the tooltip
 * and accessible description carry the whole text.
 */
export type FlowErrorFace = "first-line" | "joined";

/**
 * The error on one line. The node truncates it to its width; the whole text
 * stays in the element, which is the node's accessible description.
 */
export function errorExcerpt(error: string): string {
  return error.replace(/\s+/g, " ").trim();
}

/** The error's first non-blank line, its runs of spaces and tabs collapsed. */
export function errorFirstLine(error: string): string {
  const line = error.split(/\r\n|\r|\n/).find((candidate) => candidate.trim()) ?? "";
  return errorExcerpt(line);
}

export function flowNodeElementId(panelId: string, nodeId: string): string {
  return `${panelId}-node-${nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const EDGE_CLASS: Record<FlowEdgeState, string> = {
  complete: "stroke-success opacity-55",
  active: "stroke-cyan-400",
  ready: "stroke-success opacity-55",
  pending: "stroke-flow-edge",
  failed: "stroke-failure opacity-55",
};

const CONNECTOR_CLASS: Record<FlowEdgeState, string> = {
  complete: "border-success/55",
  active: "border-cyan-400",
  ready: "border-dashed border-success/55",
  pending: "border-dashed border-flow-edge",
  failed: "border-failure/55",
};

const PORT_CLASS: Record<FlowNodeState, string> = {
  "not-started": "fill-flow-edge",
  running: "fill-cyan-400",
  paused: "fill-amber-400",
  complete: "fill-success",
  failed: "fill-failure",
  cancelling: "fill-flow-edge",
  cancelled: "fill-flow-edge",
};

function isDashed(state: FlowEdgeState): boolean {
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
  state: FlowEdgeState;
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

function Port({ rect, side, state }: { rect: FlowRect; side: "in" | "out"; state: FlowNodeState }) {
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

/**
 * The canvas width, or null until it has been measured (and in DOM tests). A
 * hidden tab measures 0 and keeps the last width: forgetting it would swap the
 * stacked column for the shorter wide graph, and the page around it would lose
 * its scroll position to that when the tab is shown again.
 */
function useMeasuredWidth(): [(element: HTMLDivElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth(next);
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

/**
 * The stacked column's natural height, or null until it has been measured. A
 * hidden tab keeps the last height, as `useMeasuredWidth` does.
 */
function useMeasuredHeight(): [(element: HTMLDivElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    // `offsetHeight` ignores transforms, so zooming never feeds back into it.
    const measure = () => {
      if (element.offsetHeight > 0) setHeight(element.offsetHeight);
    };
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
    wrapperRef.current?.querySelector<HTMLButtonElement>("[data-flow-fullscreen-toggle]")?.focus();
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

/** One edge of the wide graph, from one node's right edge to another's left. */
export interface FlowGraphEdge {
  /** `data-flow-edge`, e.g. `into-reviewer-0`. */
  id: string;
  from: string;
  to: string;
  state: FlowEdgeState;
  /** `data-flow-source`, for an edge whose source can vary. */
  source?: string;
  /** `bypass` routes above the nodes between the two ends. */
  route?: "bypass";
}

/** One stage of the stacked column: its label, the connector into it, its nodes. */
export interface FlowStackStage {
  key: string;
  label: string;
  title?: string;
  nodes: FlowNodeModel[];
  /** The connector from the previous stage. Absent for the first. */
  edgeIn?: { id: string; state: FlowEdgeState };
  /** An edge that skips this stage and runs beside it into the next one. */
  bypass?: { id: string; source: string; state: FlowEdgeState };
}

export interface FlowGraphProps {
  /** Every node, in pipeline order: the order the arrow keys walk. */
  nodes: FlowNodeModel[];
  /** Where the nodes and column labels sit at a canvas width. */
  layout: (width: number) => FlowGraphGeometry;
  edges: FlowGraphEdge[];
  /** Port dots: where an edge leaves or enters a node. */
  ports: { nodeId: string; side: "in" | "out" }[];
  /** The same graph as one column, below {@link FLOW_GRAPH_STACK_BELOW} pixels. */
  stages: FlowStackStage[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** The inspector panel the nodes control. */
  panelId: string;
  /** Keys the remembered zoom and pan: the workflow id. */
  viewKey: string;
  /** The tablist's accessible name, e.g. "Multi Review pipeline". */
  ariaLabel: string;
  /** Prefix of the controls' test ids, e.g. `multi-review`. */
  testIdPrefix: string;
  /** The height dragged with the divider (null sizes it to the graph), and its setter. */
  storedHeight: number | null;
  onStoredHeightChange: (height: number | null) => void;
  /** Forces a layout; otherwise the measured width decides. */
  layoutMode?: "graph" | "stacked";
  /**
   * What fullscreen covers: a positioned element, the workflow's tab. The
   * graph is portaled into it, since an `@container` ancestor would confine a
   * fixed overlay to itself. Without one, fullscreen covers the window.
   */
  fullscreenContainer?: HTMLElement | null;
  /** Hidden tabs must not consume keyboard events from another pane. */
  isActive?: boolean;
  /** The shortest the graph's viewport sizes itself to; 460 px by default. */
  minHeight?: number;
  /**
   * Offers a Fit control that zooms the whole graph into view. Multi Review
   * leaves it off: Fit was removed there in #1199.
   */
  fitControl?: boolean;
  /** How a failed node's face shows its error; its first line by default. */
  errorFace?: FlowErrorFace;
}

/**
 * Room Fit leaves in the stacked layout: the sticky zoom controls above the
 * column and its padding below.
 */
const STACKED_FIT_MARGIN = 96;

function scrollingAncestor(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.clientHeight > 0) return node;
  }
  return null;
}

/**
 * A workflow as a left-to-right graph of nodes joined by hand-drawn edges.
 * Below {@link FLOW_GRAPH_STACK_BELOW} pixels it becomes a single column with
 * straight connectors.
 *
 * Nodes are tabs controlling the inspector: one tab stop for the graph, arrow
 * keys walk the pipeline in order, and Enter opens the node's session. The
 * graph zooms and pans inside its viewport (see `useFlowViewport`), and a node
 * reached from the keyboard is scrolled into view first. When the selection
 * moves to another stage, that stage is centred as far as the canvas scrolls.
 */
export function FlowGraph({
  nodes,
  layout,
  edges,
  ports,
  stages,
  selectedId,
  onSelect,
  panelId,
  viewKey,
  ariaLabel,
  testIdPrefix,
  storedHeight,
  onStoredHeightChange,
  layoutMode,
  fullscreenContainer,
  isActive = true,
  minHeight,
  fitControl = false,
  errorFace = "first-line",
}: FlowGraphProps) {
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
  const order = nodes;
  const stacked =
    layoutMode === "stacked" ||
    (layoutMode === undefined && measuredWidth !== null && measuredWidth < FLOW_GRAPH_STACK_BELOW);
  const geometry = layout(viewportWidth ?? measuredWidth ?? 1440);
  // The height dragged with the divider; while it drags, the height under the
  // pointer.
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const requestedHeight = dragHeight ?? storedHeight;
  const chosenHeight =
    requestedHeight === null ? null : resizedFlowViewportHeight(requestedHeight, geometry.height);
  const flowViewport = useFlowViewport({
    viewKey,
    measuredWidth: viewportWidth,
    content: { width: geometry.width, height: geometry.height },
    fillHeight: fullscreen ? viewportHeight : chosenHeight,
    minHeight,
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
    fitHeight: () => {
      const wrapper = stackedWrapperRef.current;
      // In fullscreen the column scrolls inside its own wrapper; otherwise
      // with the panel or page around it.
      const scroller = fullscreen ? wrapper : scrollingAncestor(wrapper);
      const visible = scroller?.clientHeight ?? window.innerHeight;
      return visible > STACKED_FIT_MARGIN ? visible - STACKED_FIT_MARGIN : null;
    },
  });
  const fitStacked = () => {
    stackedViewport.fit();
    // The column just got shorter; bring its top back into view.
    const wrapper = stackedWrapperRef.current;
    if (fullscreen && wrapper) wrapper.scrollTop = 0;
    else wrapper?.scrollIntoView?.({ block: "start" });
  };
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

  const nodeRect = (id: string): FlowRect | undefined => geometry.rects.get(id);

  // A new stage is centred once the viewport is measured, and again when the
  // width changes, since that resets the scroll. On the first measurement a
  // remembered view wins, so returning to the workflow keeps where it was left.
  const selectedNode = order.find((node) => node.id === selectedId);
  const selectedStage = selectedNode ? (selectedNode.stage ?? selectedNode.kind) : undefined;
  const centredRef = useRef<{ key: string; stage: string | undefined; width: number } | null>(null);
  const centerRef = useRef(() => {});
  useLayoutEffect(() => {
    centerRef.current = () => {
      const previous = centredRef.current;
      const last = previous?.key === viewKey ? previous : null;
      if (stacked || viewportWidth === null) return;
      centredRef.current = { key: viewKey, stage: selectedStage, width: viewportWidth };
      if (last && last.stage === selectedStage && last.width === viewportWidth) return;
      if (!last && useFlowGraphViewStore.getState().views.get(viewKey)?.width === viewportWidth)
        return;
      const rect = nodeRect(selectedId);
      if (rect) flowViewport.center(rect, { smooth: last?.width === viewportWidth });
    };
  });
  useEffect(() => {
    centerRef.current();
  }, [selectedStage, viewportWidth, stacked, viewKey]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, node: FlowNodeModel) => {
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

  const renderNode = (node: FlowNodeModel, style?: CSSProperties, className?: string) => (
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
      testIdPrefix={testIdPrefix}
      errorFace={errorFace}
    />
  );

  const canvasClass =
    "bg-flow-canvas bg-[radial-gradient(var(--color-divider)_1px,transparent_1px)] bg-size-[20px_20px]";

  if (stacked) {
    // A hop and the next stage's label. The negative margin takes back the
    // column's gaps, so the line runs from one node's edge to the next's and
    // the label sits beside it. `afterBranch` follows a bypass route around
    // the stage before: that route has already brought the line down, so the
    // hop only continues it into this stage's node.
    const connector = (state: FlowEdgeState, id: string, label: ReactNode, afterBranch = false) => (
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
    const renderStage = (stage: FlowStackStage, index: number) => {
      const label = <ColumnLabel title={stage.title}>{stage.label}</ColumnLabel>;
      const afterBranch = Boolean(stages[index - 1]?.bypass);
      const content = (
        <>
          {stage.edgeIn
            ? connector(stage.edgeIn.state, stage.edgeIn.id, label, afterBranch)
            : label}
          {stage.nodes.map((node) => renderNode(node, undefined, "w-full"))}
        </>
      );
      if (!stage.bypass) return <Fragment key={stage.key}>{content}</Fragment>;
      return (
        <div key={stage.key} className="relative flex flex-col gap-1.5">
          {content}
          <div
            aria-hidden="true"
            data-flow-edge={stage.bypass.id}
            data-flow-source={stage.bypass.source}
            data-edge-state={stage.bypass.state}
            className={cn(
              "pointer-events-none absolute inset-y-0 left-1/2 w-[calc(50%+8px)] rounded-r-xl border-y-2 border-r-2",
              CONNECTOR_CLASS[stage.bypass.state],
            )}
          />
          <div aria-hidden="true" className="h-5" />
        </div>
      );
    };
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
              onFit={fitControl ? fitStacked : undefined}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
              testIdPrefix={testIdPrefix}
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
              aria-label={ariaLabel}
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
              {stages.map(renderStage)}
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
  const portState = (nodeId: string) => order.find((node) => node.id === nodeId)?.state;

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
            aria-label={ariaLabel}
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
              {edges.map((edge) => {
                const from = nodeRect(edge.from);
                const to = nodeRect(edge.to);
                if (!from || !to) return null;
                return (
                  <FlowEdge
                    key={edge.id}
                    id={edge.id}
                    source={edge.source}
                    d={edge.route === "bypass" ? bypassEdgePath(from, to) : flowEdgePath(from, to)}
                    state={edge.state}
                  />
                );
              })}
              {ports.map((port) => {
                const rect = nodeRect(port.nodeId);
                const state = portState(port.nodeId);
                if (!rect || !state) return null;
                return (
                  <Port
                    key={`${port.nodeId}-${port.side}`}
                    rect={rect}
                    side={port.side}
                    state={state}
                  />
                );
              })}
            </svg>
            {geometry.labels.map((label) => (
              <ColumnLabel
                key={label.key}
                title={label.title}
                style={{ position: "absolute", left: label.x, top: 16 }}
              >
                {label.text}
              </ColumnLabel>
            ))}
            {order.map((node) => {
              const rect = nodeRect(node.id);
              return rect ? renderNode(node, place(rect)) : null;
            })}
          </div>
        </div>
      </div>
      <FlowZoomControls
        zoom={zoom}
        onZoomOut={() => flowViewport.zoomBy(-1)}
        onZoomIn={() => flowViewport.zoomBy(1)}
        onReset={flowViewport.resetZoom}
        onFit={fitControl ? flowViewport.fit : undefined}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        testIdPrefix={testIdPrefix}
      />
      {fullscreen ? null : (
        <FlowHeightDivider
          height={viewport.height}
          min={FLOW_VIEWPORT_RESIZE_MIN_HEIGHT}
          max={resizedFlowViewportHeight(Number.POSITIVE_INFINITY, geometry.height)}
          onResize={setDragHeight}
          onCommit={(height) => {
            setDragHeight(null);
            onStoredHeightChange(height);
          }}
          testIdPrefix={testIdPrefix}
        />
      )}
    </div>,
  );
}
