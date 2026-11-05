import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  GitPullRequest,
  Hammer,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  SearchCheck,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  COORDINATOR_WORK_BUCKETS,
  isClearableWorkItem,
  type CoordinatorWorkBucket,
  type CoordinatorWorkCounts,
  type CoordinatorWorkItem,
  type CoordinatorWorkKind,
  type CoordinatorWorkStop,
  type CoordinatorWorkTarget,
  nextWakeLine,
} from "@/lib/coordinator-work-items";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/uiStore";

/** At or above this width the Work panel opens beside the conversation by default. */
export const WORK_PANEL_WIDE_QUERY = "(min-width: 1280px)";

const BUCKET_TITLES: Record<CoordinatorWorkBucket, string> = {
  "needs-you": "Needs you",
  running: "Running",
  finished: "Finished",
};

const KIND_LABELS: Record<CoordinatorWorkKind, string> = {
  worker: "Worker",
  build: "Build",
  review: "Multi Review",
  "graph-run": "Graph run",
  "pull-request": "Pull request",
};

const KIND_ICONS: Record<CoordinatorWorkKind, typeof Bot> = {
  worker: Bot,
  build: Hammer,
  review: SearchCheck,
  "graph-run": Workflow,
  "pull-request": GitPullRequest,
};

function BucketIcon({ bucket }: { bucket: CoordinatorWorkBucket }) {
  if (bucket === "needs-you")
    return <AlertCircle className="size-3.5 shrink-0 text-amber-300" aria-hidden="true" />;
  if (bucket === "running")
    return <Loader2 className="size-3.5 shrink-0 text-sky-300" aria-hidden="true" />;
  return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-300" aria-hidden="true" />;
}

/** What a row runs on and for how long, in the order someone scans it. */
function workMeta(item: CoordinatorWorkItem): string[] {
  return [
    ...(item.agent ? [AGENT_PLATFORM_LABELS[item.agent]] : []),
    ...(item.model ? [item.model] : []),
    ...(item.overridden ? ["requested"] : []),
    ...(item.age ? [item.age] : []),
  ];
}

function WorkRow({
  item,
  onOpen,
  onStop,
  onClear,
}: {
  item: CoordinatorWorkItem;
  onOpen: (target: CoordinatorWorkTarget) => void;
  /** Settles when the stop has finished; its failure is the caller's to show. */
  onStop?: (stop: CoordinatorWorkStop) => Promise<void>;
  /** Present on rows that can be cleared, which are the ones with a right-click menu. */
  onClear?: () => void;
}) {
  const KindIcon = KIND_ICONS[item.kind];
  const target = item.target;
  const [stopping, setStopping] = useState(false);
  const stop = item.stop;
  const meta = workMeta(item);
  const row = (
    <li
      className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-elevated/60"
      data-work-kind={item.kind}
      data-work-bucket={item.bucket}
      data-work-key={item.key}
    >
      <KindIcon
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-label={KIND_LABELS[item.kind]}
        role="img"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1 text-xs">
          <span className="truncate font-medium text-foreground" title={item.name}>
            {item.name}
          </span>
          {item.machine ? (
            <span className="shrink-0 truncate text-[11px] text-muted-foreground">
              on {item.machine}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 break-words" data-work-stage="">
            {item.stage}
          </span>
          {item.criteria ? (
            <span
              className="shrink-0 rounded bg-elevated px-1 tabular-nums"
              data-work-criteria=""
              title={`${item.criteria.passed} of ${item.criteria.total} acceptance criteria passed`}
            >
              {item.criteria.passed}/{item.criteria.total} criteria
            </span>
          ) : null}
        </div>
        {item.summary ? (
          <p
            className="mt-0.5 line-clamp-2 break-words text-[11px] text-foreground/70"
            title={item.summary}
            data-work-summary=""
          >
            {item.summary}
          </p>
        ) : null}
        {meta.length > 0 ? (
          <div className="mt-0.5 break-words text-[10px] text-muted-foreground" data-work-meta="">
            {meta.join(" · ")}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          aria-label={`Open ${item.name}${!target && item.unavailableReason ? `: ${item.unavailableReason}` : ""}`}
          title={target ? `Open ${item.name}` : item.unavailableReason}
          disabled={!target}
          onClick={() => {
            if (target) onOpen(target);
          }}
        >
          Open
        </Button>
        {stop && onStop ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            aria-label={`Stop ${item.name}`}
            title="Stop this worker's running turn. The environment and its conversation stay, and the coordinator is told."
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void onStop(stop).finally(() => setStopping(false));
            }}
          >
            <Square className="size-3" aria-hidden="true" />
            Stop
          </Button>
        ) : null}
      </div>
    </li>
  );
  if (!onClear) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onClear}>
          <X className="size-4" />
          Clear
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkSection({
  bucket,
  rows,
  headingId,
  onOpen,
  onStop,
  onClearFinished,
}: {
  bucket: CoordinatorWorkBucket;
  rows: CoordinatorWorkItem[];
  headingId: string;
  onOpen: (target: CoordinatorWorkTarget) => void;
  onStop?: (stop: CoordinatorWorkStop) => Promise<void>;
  onClearFinished: (associationIds: string[]) => Promise<void>;
}) {
  const collapsed = useUIStore((state) => state.collapsedWorkBuckets.includes(bucket));
  const toggleCollapsed = useUIStore((state) => state.toggleWorkBucketCollapsed);
  const [clearing, setClearing] = useState(false);
  const clearable = bucket === "finished" ? rows.filter(isClearableWorkItem) : [];
  const clear = () => {
    setClearing(true);
    void onClearFinished(clearable.flatMap((item) => item.associationIds)).finally(() =>
      setClearing(false),
    );
  };
  return (
    <Collapsible open={!collapsed} onOpenChange={() => toggleCollapsed(bucket)} asChild>
      <section aria-labelledby={headingId} className="mb-1">
        <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5">
          <h3 id={headingId} className="min-w-0 flex-1">
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-hairline">
              <ChevronRight
                className={cn("size-3 shrink-0 transition-transform", !collapsed && "rotate-90")}
                aria-hidden="true"
              />
              <BucketIcon bucket={bucket} />
              {BUCKET_TITLES[bucket]} ({rows.length})
            </CollapsibleTrigger>
          </h3>
          {clearable.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 shrink-0 px-1.5 text-[11px] text-muted-foreground"
              aria-label={`Clear ${clearable.length} finished ${clearable.length === 1 ? "item" : "items"}`}
              title={
                clearable.length < rows.length
                  ? "Remove finished work from this list. Work whose pull request is still open stays."
                  : "Remove finished work from this list"
              }
              disabled={clearing}
              onClick={clear}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <CollapsibleContent>
          <ul className="flex flex-col">
            {rows.map((item) => (
              <WorkRow
                key={item.key}
                item={item}
                onOpen={onOpen}
                {...(onStop ? { onStop } : {})}
                {...(isClearableWorkItem(item)
                  ? { onClear: () => void onClearFinished(item.associationIds) }
                  : {})}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function countsText(counts: CoordinatorWorkCounts): string {
  return `${counts.running} running, ${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`;
}

/**
 * Everything this coordinator started and where each piece is.
 *
 * Open by default beside the conversation on wide screens. On narrow screens
 * it is a strip with the running and needs-you counts, which opens the list
 * over the conversation when clicked; Escape or the close button returns to
 * the strip. Either way the user's last choice holds until the screen crosses
 * the width threshold.
 */
export function CoordinatorWorkPanel({
  items,
  counts,
  openDelegations,
  onOpen,
  onStop,
  onClearFinished,
}: {
  items: CoordinatorWorkItem[];
  counts: CoordinatorWorkCounts;
  /** Running delegations, exposed for end-to-end checks. */
  openDelegations: number;
  onOpen: (target: CoordinatorWorkTarget) => void;
  /** Absent while nothing can be stopped from here (coordination paused, no conversation). */
  onStop?: (stop: CoordinatorWorkStop) => Promise<void>;
  /** Settles when the clear has finished; its failure is the caller's to show. */
  onClearFinished: (associationIds: string[]) => Promise<void>;
}) {
  const wide = useMediaQuery(WORK_PANEL_WIDE_QUERY);
  const [choice, setChoice] = useState<{ wide: boolean; open: boolean } | null>(null);
  const open = choice && choice.wide === wide ? choice.open : wide;
  const listId = useId();
  const headingId = useId();
  const stripRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const setOpen = (next: boolean) => {
    setChoice({ wide, open: next });
    // Keep keyboard focus on the control that now stands for the panel.
    requestAnimationFrame(() => (next ? closeRef.current : stripRef.current)?.focus());
  };
  const shared = {
    "data-coordinator-work": "",
    "data-open-delegations": openDelegations,
    "data-work-running": counts.running,
    "data-work-needs-you": counts.needsYou,
  };

  if (!open) {
    return (
      <div className="flex shrink-0 border-l border-border/70 bg-chrome" {...shared}>
        <button
          ref={stripRef}
          type="button"
          className="flex w-9 flex-col items-center gap-2 py-2 text-[11px] text-muted-foreground hover:bg-elevated focus-hairline"
          aria-expanded={false}
          aria-controls={listId}
          aria-label={`Show work: ${countsText(counts)}`}
          title={`Show work: ${countsText(counts)}`}
          onClick={() => setOpen(true)}
          data-work-strip=""
        >
          <PanelRightOpen className="size-4" aria-hidden="true" />
          <span className="[writing-mode:vertical-rl]">Work</span>
          <span className="flex flex-col items-center gap-0.5" data-work-strip-running="">
            <Loader2 className="size-3 text-sky-300" aria-hidden="true" />
            <span className="tabular-nums">{counts.running}</span>
            <span className="[writing-mode:vertical-rl]">running</span>
          </span>
          <span
            className={cn(
              "flex flex-col items-center gap-0.5",
              counts.needsYou > 0 && "text-amber-300",
            )}
            data-work-strip-needs-you=""
          >
            <AlertCircle className="size-3" aria-hidden="true" />
            <span className="tabular-nums">{counts.needsYou}</span>
            <span className="[writing-mode:vertical-rl]">needs you</span>
          </span>
        </button>
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!wide && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <aside
      id={listId}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-0 w-72 shrink-0 flex-col border-l border-border/70 bg-chrome",
        // Narrow screens open the list over the conversation instead of squeezing it.
        !wide && "absolute inset-y-0 right-0 z-20 shadow-xl",
      )}
      {...shared}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <h2 id={headingId} className="text-xs font-medium text-foreground">
          Work
        </h2>
        <span className="flex-1 truncate text-[11px] text-muted-foreground" data-work-counts="">
          {countsText(counts)}
        </span>
        <Button
          ref={closeRef}
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label="Hide work panel"
          aria-expanded={true}
          aria-controls={listId}
          title="Hide work panel"
          onClick={() => setOpen(false)}
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {items.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Nothing yet. Workers, builds, reviews, graph runs and pull requests this coordinator
            starts are listed here.
          </p>
        ) : (
          COORDINATOR_WORK_BUCKETS.map((bucket) => {
            const rows = items.filter((item) => item.bucket === bucket);
            if (rows.length === 0) return null;
            return (
              <WorkSection
                key={bucket}
                bucket={bucket}
                rows={rows}
                headingId={`${headingId}-${bucket}`}
                onOpen={onOpen}
                {...(onStop ? { onStop } : {})}
                onClearFinished={onClearFinished}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

/**
 * What the next wake waits for, on a screen too narrow to keep the Work panel
 * open beside the conversation. Wide screens already show this in the panel.
 */
export function CoordinatorNextWakeLine({
  items,
  quiet,
}: {
  items: readonly CoordinatorWorkItem[];
  /** The coordinator is running a turn or paused: no wake is what it is waiting for. */
  quiet: boolean;
}) {
  const wide = useMediaQuery(WORK_PANEL_WIDE_QUERY);
  const line = wide || quiet ? null : nextWakeLine(items);
  if (!line) return null;
  return (
    <div
      role="status"
      className="shrink-0 truncate border-t border-border/60 px-3 py-1 text-center text-[11px] text-muted-foreground"
      title={line}
      data-coordinator-next-wake=""
    >
      {line}
    </div>
  );
}
