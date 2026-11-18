import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Columns3, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LinearIssueLabel, LinearIssueListItem } from "@/types/linear";
import { LinearAssigneeAvatar } from "./LinearAssigneeAvatar";
import { planLinearDrop, type LinearDropAnchor, type LinearLane } from "./linear-issue-order";

/** A lane's dot and a card's edge, by Linear's state type (the Kanban board's colours). */
const TYPE_DOT: Record<string, string> = {
  triage: "bg-violet-500",
  backlog: "bg-zinc-500",
  unstarted: "bg-slate-400",
  started: "bg-blue-500",
  completed: "bg-green-500",
  canceled: "bg-zinc-600",
  duplicate: "bg-zinc-600",
};

function laneColor(type: string | undefined): string {
  return TYPE_DOT[type ?? ""] ?? "bg-zinc-500";
}

/** The board's lane switches: one per workflow state, and Show all. */
export function LinearLanesMenu({
  lanes,
  hidden,
  onToggle,
  onShowAll,
}: {
  lanes: readonly LinearLane[];
  hidden: ReadonlySet<string>;
  onToggle: (status: string, visible: boolean) => void;
  onShowAll: () => void;
}) {
  const shown = lanes.filter((lane) => !hidden.has(lane.status)).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Choose board lanes">
          <Columns3 className="h-3.5 w-3.5" />
          Lanes
          <span className="text-muted-foreground">
            {shown}/{lanes.length}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Show lanes</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {lanes.map((lane) => (
          <DropdownMenuCheckboxItem
            key={lane.status}
            checked={!hidden.has(lane.status)}
            // Keep the menu open so several lanes can be switched in one go.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggle(lane.status, checked === true)}
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", laneColor(lane.type))} />
            <span className="min-w-0 flex-1 truncate">{lane.status}</span>
            <span className="text-xs text-muted-foreground">{lane.issues.length}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {hidden.size > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onShowAll}>
              <Eye className="h-3.5 w-3.5" />
              Show all lanes
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LANE_DROP_PREFIX = "linear-lane:";
const CARD_DROP_PREFIX = "linear-card:";

/** Labels a card names before folding the rest into "+N" (the Kanban card's limit is 3). */
const CARD_LABEL_LIMIT = 4;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A label's Linear colour, or none when it is missing or not a hex colour. */
function labelColor(label: LinearIssueLabel): string | undefined {
  return label.color && HEX_COLOR.test(label.color) ? label.color : undefined;
}

/**
 * An issue's labels on its card: a dot in each label's Linear colour beside
 * its name, as Linear shows them. The drag preview renders the same row, so
 * it keeps the card's height.
 */
function LinearCardLabels({ labels }: { labels: readonly LinearIssueLabel[] }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, CARD_LABEL_LIMIT);
  const rest = labels.slice(CARD_LABEL_LIMIT);
  return (
    <div data-testid="linear-card-labels" className="mt-2 flex flex-wrap items-center gap-1">
      {shown.map((label, index) => {
        const color = labelColor(label);
        return (
          <span
            key={label.id ?? `${label.name}:${index}`}
            data-testid="linear-card-label"
            data-label-color={color}
            title={label.name}
            className="inline-flex max-w-[9rem] items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-foreground/90"
          >
            <span
              aria-hidden="true"
              data-testid="linear-card-label-dot"
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", !color && "bg-muted-foreground")}
              style={color ? { backgroundColor: color } : undefined}
            />
            <span className="truncate">{label.name}</span>
          </span>
        );
      })}
      {rest.length > 0 && (
        <span
          data-testid="linear-card-labels-more"
          className="px-0.5 text-[10px] text-muted-foreground"
          title={rest.map((label) => label.name).join(", ")}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

function LinearCardContent({
  issue,
  type,
  pipelinePhase,
}: {
  issue: LinearIssueListItem;
  type?: string;
  pipelinePhase?: string;
}) {
  // The assignee shows as the avatar in the corner, as on Linear's own board.
  const details = [issue.priorityLabel].filter(
    (value): value is string => Boolean(value) && value !== "No priority",
  );
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-[3px]", laneColor(type))}
      />
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{issue.identifier}</span>
        {(pipelinePhase || issue.assigneeName) && (
          <span className="flex shrink-0 items-center gap-1.5">
            {pipelinePhase && (
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
                {pipelinePhase}
              </span>
            )}
            <LinearAssigneeAvatar issue={issue} />
          </span>
        )}
      </div>
      <h4 className="mt-1 line-clamp-2 text-sm font-medium text-foreground">{issue.title}</h4>
      <LinearCardLabels labels={issue.issueLabels ?? []} />
      {details.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {details.map((detail) => (
            <span key={detail}>{detail}</span>
          ))}
        </div>
      )}
    </>
  );
}

const CARD_CLASS = cn(
  "group relative block w-full overflow-hidden rounded-lg border bg-card p-3 pl-4 text-left",
  "transition-[border-color,background-color]",
  "border-border hover:border-primary/50",
  "outline-none focus-hairline",
);

/** The copy of the carried cards that follows the pointer while they are dragged. */
function LinearDragPreview({
  count,
  ...props
}: {
  issue: LinearIssueListItem;
  type?: string;
  pipelinePhase?: string;
  /** How many cards are carried; above one the preview shows a stack and the count. */
  count: number;
}) {
  return (
    <div className="relative rotate-1">
      {count > 1 && (
        <div
          aria-hidden="true"
          className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg border border-primary/40 bg-card shadow-lg"
        />
      )}
      <div
        data-testid="linear-board-card-overlay"
        className={cn(CARD_CLASS, "border-primary/60 shadow-2xl shadow-black/50")}
      >
        <LinearCardContent {...props} />
      </div>
      {count > 1 && (
        <span
          data-testid="linear-board-drag-count"
          className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground shadow"
        >
          {count}
        </span>
      )}
    </div>
  );
}

/** The line showing where a drop lands among a lane's cards. */
function DropIndicator({ placement }: { placement: "before" | "after" | "end" }) {
  return (
    <div
      aria-hidden="true"
      data-testid="linear-board-drop-indicator"
      data-placement={placement}
      className={cn(
        "pointer-events-none h-0.5 rounded-full bg-primary",
        placement === "before" && "absolute inset-x-1 -top-[5px]",
        placement === "after" && "absolute inset-x-1 -bottom-[5px]",
      )}
    />
  );
}

function LinearBoardCard({
  issue,
  laneStatus,
  type,
  pipelinePhase,
  draggable,
  droppable,
  selected,
  carried,
  indicator,
  onClick,
}: {
  issue: LinearIssueListItem;
  laneStatus: string;
  type?: string;
  pipelinePhase?: string;
  draggable: boolean;
  /** Whether a card can be dropped beside this one. */
  droppable: boolean;
  /** Picked with Cmd/Ctrl- or Shift-click: dragging any selected card carries them all. */
  selected: boolean;
  /** Carried by the drag in progress (the held card's preview shows them). */
  carried: boolean;
  /** Where a drop beside this card would land, while one is aimed here. */
  indicator?: "before" | "after";
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const drag = useDraggable({ id: issue.id, disabled: !draggable });
  const drop = useDroppable({
    id: `${CARD_DROP_PREFIX}${issue.id}`,
    disabled: !droppable,
    data: { issueId: issue.id, lane: laneStatus },
  });
  const { setNodeRef: setDragRef, isDragging } = drag;
  const { setNodeRef: setDropRef } = drop;
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  // A drag ends with a click on the card under the pointer; that click must
  // not open the issue (the Kanban card does the same).
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDraggingRef.current = true;
      return;
    }
    if (!wasDraggingRef.current) return;
    const timer = setTimeout(() => {
      wasDraggingRef.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [isDragging]);

  // The card is already a button; keep its own role.
  const { role: _role, ...dragAttributes } = drag.attributes;
  return (
    <div className="relative">
      {indicator && <DropIndicator placement={indicator} />}
      <button
        ref={setNodeRef}
        type="button"
        data-testid="linear-board-card"
        data-issue-id={issue.id}
        data-selected={selected ? "true" : undefined}
        {...(draggable ? { ...dragAttributes, ...drag.listeners } : {})}
        onMouseDown={(event) => {
          // Shift-click selects cards, not the text between them.
          if (event.shiftKey) event.preventDefault();
        }}
        onClick={(event) => {
          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            return;
          }
          onClick(event);
        }}
        className={cn(
          CARD_CLASS,
          draggable && "cursor-grab active:cursor-grabbing",
          selected && "border-primary bg-primary/10 ring-1 ring-primary hover:border-primary",
          !selected && !isDragging && !carried && "hover:bg-hover/50",
          // The preview follows the pointer; the originals stay as dashed placeholders.
          (isDragging || carried) && "border-dashed border-primary/60 bg-primary/5 opacity-50",
        )}
      >
        {selected && <span className="sr-only">Selected. </span>}
        <LinearCardContent issue={issue} type={type} pipelinePhase={pipelinePhase} />
      </button>
    </div>
  );
}

function LinearLaneColumn({
  lane,
  isTarget,
  canDrag,
  dragging,
  moving,
  selected,
  carried,
  dropAnchor,
  onCardClick,
  pipelinePhase,
}: {
  lane: LinearLane;
  /** A drag in progress would move cards into this lane from another. */
  isTarget: boolean;
  canDrag: boolean;
  /** Whether a card is being dragged. */
  dragging: boolean;
  /** Issues whose move has not settled yet; they cannot be dragged again until it does. */
  moving: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  carried: ReadonlySet<string>;
  /** Where a drop in this lane lands, shown as a line, when the drop places cards. */
  dropAnchor: LinearDropAnchor | undefined;
  onCardClick: (issue: LinearIssueListItem, event: MouseEvent<HTMLButtonElement>) => void;
  pipelinePhase: (issueId: string) => string | undefined;
}) {
  // A lane without a state id cannot receive a card: there is nothing to move it to.
  const accepts = canDrag && Boolean(lane.stateId);
  const { setNodeRef } = useDroppable({
    id: `${LANE_DROP_PREFIX}${lane.status}`,
    disabled: !accepts,
  });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${lane.status} lane`}
      className="flex h-full w-[calc(100vw-2rem)] min-w-[240px] shrink-0 flex-col sm:w-[300px] sm:min-w-[260px]"
    >
      <div className="mb-2 flex h-9 items-center gap-2 border-b border-border/60 px-1 pb-2">
        <span className={cn("h-2 w-2 rounded-full", laneColor(lane.type))} />
        <h3 className="truncate text-sm font-semibold text-foreground">{lane.status}</h3>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
          {lane.issues.length}
        </span>
      </div>
      <div
        className={cn(
          "min-h-[200px] flex-1 overflow-y-auto rounded-lg p-1 transition-colors",
          isTarget ? "bg-accent/20" : "bg-transparent",
        )}
      >
        <div className="space-y-2">
          {lane.issues.map((issue) => (
            <LinearBoardCard
              key={issue.id}
              issue={issue}
              laneStatus={lane.status}
              type={lane.type}
              pipelinePhase={pipelinePhase(issue.id)}
              draggable={accepts && !moving.has(issue.id)}
              droppable={accepts}
              selected={selected.has(issue.id)}
              carried={carried.has(issue.id)}
              indicator={
                dropAnchor?.issueId === issue.id
                  ? dropAnchor.before
                    ? "before"
                    : "after"
                  : undefined
              }
              onClick={(event) => onCardClick(issue, event)}
            />
          ))}
          {dropAnchor === null && lane.issues.length > 0 && <DropIndicator placement="end" />}
        </div>
        {lane.issues.length === 0 && (
          <div
            className={cn(
              "flex h-20 items-center justify-center rounded-lg border border-dashed text-xs transition-colors",
              isTarget
                ? "border-primary/60 bg-primary/5 text-primary"
                : "border-border/60 text-muted-foreground",
            )}
          >
            {dragging && accepts ? `Move to ${lane.status}` : "No issues"}
          </div>
        )}
      </div>
    </section>
  );
}

const NO_ISSUES: ReadonlySet<string> = new Set();

/** A drop the board asks its caller to carry out. */
export interface LinearBoardMove {
  /** The issues to move, in the order they should sit. */
  issues: LinearIssueListItem[];
  to: LinearLane;
  /**
   * Each placed issue's new Linear `sortOrder`. Empty when the drop only
   * changes lanes (another ticket order is chosen). May include destination
   * neighbours when a tied or exhausted gap requires fresh positions.
   */
  sortOrders: ReadonlyMap<string, number>;
}

/**
 * The Linear tab's board view: one vertical lane per workflow state, in
 * Linear's order, like the Kanban board. Lanes the user hid are left out;
 * when every lane is hidden the board says so rather than showing nothing.
 *
 * With `onMoveIssues`, cards dragged to another lane move to that lane's
 * workflow state in Linear. Only lanes with a state id (read from the board)
 * take part; the caller moves the cards and puts them back on a failure. A
 * card in `movingIssueIds` stays put until its move settles.
 *
 * With `reorderable` (the "Linear board" ticket order), a card dropped beside
 * another lands there: the move carries the Linear `sortOrder` that puts it
 * between its new neighbours, in its own lane or another.
 *
 * Cmd/Ctrl-click toggles a card's selection and Shift-click selects the run
 * of cards from the last one picked; dragging any selected card carries the
 * whole selection. A plain click opens the issue; Escape clears the selection.
 */
export function LinearIssueBoard({
  lanes,
  hidden,
  onShowAll,
  onSelectIssue,
  pipelinePhase,
  onMoveIssues,
  reorderable = false,
  movingIssueIds = NO_ISSUES,
}: {
  lanes: readonly LinearLane[];
  hidden: ReadonlySet<string>;
  onShowAll: () => void;
  onSelectIssue: (issueId: string) => void;
  pipelinePhase: (issueId: string) => string | undefined;
  onMoveIssues?: (move: LinearBoardMove) => void;
  /** Whether a drop beside a card sets the issues' Linear board order. */
  reorderable?: boolean;
  /** Issues with a move in flight: shown, but not draggable until it settles. */
  movingIssueIds?: ReadonlySet<string>;
}) {
  const [drag, setDrag] = useState<{ activeId: string; carried: string[] } | null>(null);
  const [dropAt, setDropAt] = useState<{ lane: string; anchor: LinearDropAnchor } | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_ISSUES);
  /** The card a Shift-click selects from: the last one picked or opened. */
  const anchorRef = useRef<string | null>(null);
  // Collision coordinates and rectangles share viewport space. Drag event delta
  // also includes scroll displacement, so it cannot locate the pointer.
  const geometry = useRef<Parameters<CollisionDetection>[0] | null>(null);
  const cardsFirst = useCallback<CollisionDetection>((args) => {
    geometry.current = args;
    const hits = pointerWithin(args);
    const card = hits.find((hit) => String(hit.id).startsWith(CARD_DROP_PREFIX));
    return card ? [card] : hits;
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = lanes.filter((lane) => !hidden.has(lane.status));
  const laneOf = (issueId: string) =>
    lanes.find((lane) => lane.issues.some((issue) => issue.id === issueId)) ?? null;
  const issueById = new Map(lanes.flatMap((lane) => lane.issues.map((issue) => [issue.id, issue])));
  const canSelect = Boolean(onMoveIssues);

  // Only cards that could be dragged now count as selected: a card that left
  // the board, sits in a hidden lane or has a move in flight drops out.
  const selected = useMemo(() => {
    if (selection.size === 0) return NO_ISSUES;
    const current = new Set<string>();
    for (const lane of lanes) {
      if (hidden.has(lane.status) || !lane.stateId) continue;
      for (const issue of lane.issues) {
        if (selection.has(issue.id) && !movingIssueIds.has(issue.id)) current.add(issue.id);
      }
    }
    return current;
  }, [selection, lanes, hidden, movingIssueIds]);

  useEffect(() => {
    if (selected.size === 0 || drag) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(NO_ISSUES);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected, drag]);

  const handleCardClick = (issue: LinearIssueListItem, event: MouseEvent<HTMLButtonElement>) => {
    const toggle = event.metaKey || event.ctrlKey;
    if (!canSelect || (!toggle && !event.shiftKey)) {
      setSelection(NO_ISSUES);
      anchorRef.current = issue.id;
      onSelectIssue(issue.id);
      return;
    }
    const lane = laneOf(issue.id);
    const anchor = anchorRef.current;
    const anchorIndex = anchor && lane ? lane.issues.findIndex((other) => other.id === anchor) : -1;
    if (event.shiftKey && lane && anchorIndex !== -1) {
      const index = lane.issues.findIndex((other) => other.id === issue.id);
      const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      const next = new Set(selected);
      for (const other of lane.issues.slice(from, to + 1)) {
        if (!movingIssueIds.has(other.id)) next.add(other.id);
      }
      setSelection(next);
      return;
    }
    const next = new Set(selected);
    if (next.has(issue.id)) next.delete(issue.id);
    else if (!movingIssueIds.has(issue.id)) next.add(issue.id);
    anchorRef.current = issue.id;
    setSelection(next);
  };

  /** Where the pointer would drop the carried cards, or null for nowhere useful. */
  const dropTarget = (
    event: DragMoveEvent | DragOverEvent | DragEndEvent,
    carried: readonly string[],
  ): { lane: LinearLane; anchor: LinearDropAnchor } | null => {
    const over = event.over;
    if (!over) return null;
    const overId = String(over.id);
    if (overId.startsWith(CARD_DROP_PREFIX)) {
      const issueId = String(over.data.current?.issueId ?? overId.slice(CARD_DROP_PREFIX.length));
      // Over a card being carried: the cards would land where they are.
      if (carried.includes(issueId)) return null;
      const lane = laneOf(issueId);
      if (!lane) return null;
      const y = geometry.current?.pointerCoordinates?.y ?? null;
      const before = y === null ? false : y < over.rect.top + over.rect.height / 2;
      return { lane, anchor: { issueId, before } };
    }
    if (!overId.startsWith(LANE_DROP_PREFIX)) return null;
    const lane = lanes.find(
      (candidate) => candidate.status === overId.slice(LANE_DROP_PREFIX.length),
    );
    if (!lane) return null;
    const y = geometry.current?.pointerCoordinates?.y;
    if (y !== undefined) {
      for (const issue of lane.issues) {
        if (carried.includes(issue.id)) continue;
        const rect = geometry.current?.droppableRects.get(`${CARD_DROP_PREFIX}${issue.id}`);
        if (rect && y < rect.top + rect.height / 2) {
          return { lane, anchor: { issueId: issue.id, before: true } };
        }
      }
    }
    return { lane, anchor: null };
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    if (selected.has(activeId)) {
      // The selection travels in board order, which is the order it lands in.
      const carried = visible.flatMap((lane) =>
        lane.issues.filter((issue) => selected.has(issue.id)).map((issue) => issue.id),
      );
      setDrag({ activeId, carried });
    } else {
      setSelection(NO_ISSUES);
      setDrag({ activeId, carried: [activeId] });
    }
  };

  /**
   * What dropping the carried cards here would do: the lane and spot, and the
   * move to ask for. Null when the drop would change nothing.
   */
  const planDrop = (
    event: DragMoveEvent | DragOverEvent | DragEndEvent,
    carriedIds: readonly string[],
  ): { anchor: LinearDropAnchor; move: LinearBoardMove } | null => {
    const target = dropTarget(event, carriedIds);
    if (!target?.lane.stateId) return null;
    const carriedIssues = carriedIds
      .map((id) => issueById.get(id))
      .filter((issue): issue is LinearIssueListItem => !!issue && !movingIssueIds.has(issue.id));
    if (carriedIssues.length === 0) return null;
    const sortOrders = reorderable
      ? (planLinearDrop(target.lane, carriedIssues, target.anchor) ?? new Map<string, number>())
      : new Map<string, number>();
    const placedIssues = [
      ...carriedIssues,
      ...target.lane.issues.filter(
        (issue) => !carriedIds.includes(issue.id) && sortOrders.has(issue.id),
      ),
    ];
    if (placedIssues.some((issue) => movingIssueIds.has(issue.id))) return null;
    const issues = placedIssues.filter(
      (issue) => issue.status !== target.lane.status || sortOrders.has(issue.id),
    );
    if (issues.length === 0) return null;
    return { anchor: target.anchor, move: { issues, to: target.lane, sortOrders } };
  };

  const handleDragMove = (event: DragMoveEvent | DragOverEvent) => {
    const plan = drag ? planDrop(event, drag.carried) : null;
    const next = plan ? { lane: plan.move.to.status, anchor: plan.anchor } : null;
    setDropAt((current) =>
      current?.lane === next?.lane &&
      current?.anchor?.issueId === next?.anchor?.issueId &&
      current?.anchor?.before === next?.anchor?.before
        ? current
        : next,
    );
  };

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const carriedIds = drag?.carried ?? [String(event.active.id)];
    endDrag();
    if (!onMoveIssues) return;
    const plan = planDrop(event, carriedIds);
    if (!plan) return;
    setSelection(NO_ISSUES);
    onMoveIssues(plan.move);
  };

  const carried = useMemo(() => new Set(drag?.carried ?? []), [drag]);
  const activeIssue = drag ? (issueById.get(drag.activeId) ?? null) : null;
  const activeLane = drag ? laneOf(drag.activeId) : null;
  const targetLane = dropAt ? lanes.find((lane) => lane.status === dropAt.lane) : undefined;
  // A lane lights up when the drop would bring a card in from another lane.
  const movesIn =
    targetLane !== undefined &&
    [...carried].some((id) => issueById.get(id)?.status !== targetLane.status);

  if (lanes.length > 0 && visible.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
          <EyeOff className="h-6 w-6" />
          <p className="text-sm">Every lane is hidden</p>
          <Button size="sm" variant="outline" onClick={onShowAll}>
            Show all lanes
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "min-h-0 flex-1 overflow-x-auto p-3 sm:p-6",
          // Snapping fights the drag's edge scrolling and jumps a whole lane at
          // a time, so it is off while a card is held.
          drag === null && "snap-x snap-mandatory",
        )}
        data-testid="linear-board"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={cardsFirst}
          // Scroll the lanes only near the board's edges, and gently.
          autoScroll={{ threshold: { x: 0.1, y: 0.15 }, acceleration: 5 }}
          onDragStart={handleDragStart}
          // A move within one target repositions the line; a new target
          // arrives as a drag over, since a move can still name the last one.
          onDragMove={handleDragMove}
          onDragOver={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={endDrag}
        >
          <div className="flex h-full gap-3 sm:gap-4 [&>section]:snap-center">
            {visible.map((lane) => (
              <LinearLaneColumn
                key={lane.status}
                lane={lane}
                isTarget={movesIn && targetLane?.status === lane.status}
                canDrag={Boolean(onMoveIssues)}
                dragging={drag !== null}
                moving={movingIssueIds}
                selected={selected}
                carried={carried}
                dropAnchor={
                  reorderable && dropAt?.lane === lane.status && lane.stateId
                    ? dropAt.anchor
                    : undefined
                }
                onCardClick={handleCardClick}
                pipelinePhase={pipelinePhase}
              />
            ))}
          </div>
          <DragOverlay>
            {activeIssue && (
              <LinearDragPreview
                issue={activeIssue}
                type={activeLane?.type}
                pipelinePhase={pipelinePhase(activeIssue.id)}
                count={carried.size}
              />
            )}
          </DragOverlay>
        </DndContext>
      </div>
      {selected.size > 0 && drag === null && (
        <div
          role="status"
          data-testid="linear-board-selection"
          className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-popover px-4 py-1.5 text-xs text-popover-foreground shadow-lg">
            <span className="font-medium">
              {selected.size} {selected.size === 1 ? "issue" : "issues"} selected
            </span>
            <span className="hidden text-muted-foreground sm:inline">
              Drag one to move them together
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setSelection(NO_ISSUES)}
            >
              Clear
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
