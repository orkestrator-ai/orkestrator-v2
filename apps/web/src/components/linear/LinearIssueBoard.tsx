import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import type { LinearIssueListItem } from "@/types/linear";
import type { LinearLane } from "./linear-issue-order";

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

function LinearCardContent({
  issue,
  type,
  pipelinePhase,
}: {
  issue: LinearIssueListItem;
  type?: string;
  pipelinePhase?: string;
}) {
  const details = [issue.priorityLabel, issue.assigneeName].filter(
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
        {pipelinePhase && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
            {pipelinePhase}
          </span>
        )}
      </div>
      <h4 className="mt-1 line-clamp-2 text-sm font-medium text-foreground">{issue.title}</h4>
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
  "group relative block w-full overflow-hidden rounded-lg border bg-card p-3 pl-4 text-left shadow-sm",
  "transition-[border-color,box-shadow,background-color]",
  "border-border hover:border-primary/50 hover:bg-accent/20 hover:shadow-md",
  "outline-none focus-hairline",
);

/** The copy of a card that follows the pointer while it is dragged. */
function LinearDragPreview(props: {
  issue: LinearIssueListItem;
  type?: string;
  pipelinePhase?: string;
}) {
  return (
    <div
      data-testid="linear-board-card-overlay"
      className={cn(CARD_CLASS, "rotate-1 border-primary/60 shadow-2xl shadow-black/50")}
    >
      <LinearCardContent {...props} />
    </div>
  );
}

function LinearBoardCard({
  issue,
  type,
  pipelinePhase,
  draggable,
  onClick,
}: {
  issue: LinearIssueListItem;
  type?: string;
  pipelinePhase?: string;
  draggable: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issue.id,
    disabled: !draggable,
  });
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
  const { role: _role, ...dragAttributes } = attributes;
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-testid="linear-board-card"
      data-issue-id={issue.id}
      {...(draggable ? { ...dragAttributes, ...listeners } : {})}
      onClick={() => {
        if (wasDraggingRef.current) {
          wasDraggingRef.current = false;
          return;
        }
        onClick();
      }}
      className={cn(
        CARD_CLASS,
        draggable && "cursor-grab active:cursor-grabbing",
        // The preview follows the pointer; the original stays as a dashed placeholder.
        isDragging && "border-dashed border-primary/60 bg-primary/5 opacity-50",
      )}
    >
      <LinearCardContent issue={issue} type={type} pipelinePhase={pipelinePhase} />
    </button>
  );
}

function LinearLaneColumn({
  lane,
  dragging,
  canDrag,
  moving,
  onSelectIssue,
  pipelinePhase,
}: {
  lane: LinearLane;
  /** The lane of the card being dragged, when one is. */
  dragging: LinearLane | null;
  canDrag: boolean;
  /** Issues whose move has not settled yet; they cannot be dragged again until it does. */
  moving: ReadonlySet<string>;
  onSelectIssue: (issueId: string) => void;
  pipelinePhase: (issueId: string) => string | undefined;
}) {
  // A lane without a state id cannot receive a card: there is nothing to move it to.
  const accepts = canDrag && Boolean(lane.stateId);
  const { setNodeRef, isOver } = useDroppable({
    id: `${LANE_DROP_PREFIX}${lane.status}`,
    disabled: !accepts,
  });
  const target = isOver && dragging !== null && dragging.status !== lane.status;
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
          target ? "bg-accent/20" : "bg-transparent",
        )}
      >
        <div className="space-y-2">
          {lane.issues.map((issue) => (
            <LinearBoardCard
              key={issue.id}
              issue={issue}
              type={lane.type}
              pipelinePhase={pipelinePhase(issue.id)}
              draggable={accepts && !moving.has(issue.id)}
              onClick={() => onSelectIssue(issue.id)}
            />
          ))}
        </div>
        {lane.issues.length === 0 && (
          <div
            className={cn(
              "flex h-20 items-center justify-center rounded-lg border border-dashed text-xs transition-colors",
              target
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

/**
 * The Linear tab's board view: one vertical lane per workflow state, in
 * Linear's order, like the Kanban board. Lanes the user hid are left out;
 * when every lane is hidden the board says so rather than showing nothing.
 *
 * With `onMoveIssue`, a card dragged to another lane moves the issue to that
 * lane's workflow state in Linear. Only lanes with a state id (read from the
 * board) take part; the caller moves the card and puts it back on a failure.
 * A card in `movingIssueIds` stays put until its move settles.
 */
export function LinearIssueBoard({
  lanes,
  hidden,
  onShowAll,
  onSelectIssue,
  pipelinePhase,
  onMoveIssue,
  movingIssueIds = NO_ISSUES,
}: {
  lanes: readonly LinearLane[];
  hidden: ReadonlySet<string>;
  onShowAll: () => void;
  onSelectIssue: (issueId: string) => void;
  pipelinePhase: (issueId: string) => string | undefined;
  onMoveIssue?: (issue: LinearIssueListItem, to: LinearLane) => void;
  /** Issues with a move in flight: shown, but not draggable until it settles. */
  movingIssueIds?: ReadonlySet<string>;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = lanes.filter((lane) => !hidden.has(lane.status));
  const laneOf = (issueId: string) =>
    lanes.find((lane) => lane.issues.some((issue) => issue.id === issueId)) ?? null;
  const activeLane = activeId ? laneOf(activeId) : null;
  const activeIssue = activeLane?.issues.find((issue) => issue.id === activeId) ?? null;

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const overId = event.over ? String(event.over.id) : "";
    if (!onMoveIssue || !overId.startsWith(LANE_DROP_PREFIX)) return;
    const to = lanes.find((lane) => lane.status === overId.slice(LANE_DROP_PREFIX.length));
    const from = laneOf(String(event.active.id));
    const issue = from?.issues.find((candidate) => candidate.id === String(event.active.id));
    if (!to?.stateId || !from || !issue || from.status === to.status) return;
    if (movingIssueIds.has(issue.id)) return;
    onMoveIssue(issue, to);
  };

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
    <div
      className={cn(
        "min-h-0 flex-1 overflow-x-auto p-3 sm:p-6",
        // Snapping fights the drag's edge scrolling and jumps a whole lane at
        // a time, so it is off while a card is held.
        activeId === null && "snap-x snap-mandatory",
      )}
      data-testid="linear-board"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        // Scroll the lanes only near the board's edges, and gently.
        autoScroll={{ threshold: { x: 0.1, y: 0.15 }, acceleration: 5 }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex h-full gap-3 sm:gap-4 [&>section]:snap-center">
          {visible.map((lane) => (
            <LinearLaneColumn
              key={lane.status}
              lane={lane}
              dragging={activeLane}
              canDrag={Boolean(onMoveIssue)}
              moving={movingIssueIds}
              onSelectIssue={onSelectIssue}
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
            />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
