import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  GitPullRequest,
  Hammer,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  SearchCheck,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  COORDINATOR_WORK_BUCKETS,
  type CoordinatorWorkBucket,
  type CoordinatorWorkCounts,
  type CoordinatorWorkItem,
  type CoordinatorWorkKind,
  type CoordinatorWorkTarget,
} from "@/lib/coordinator-work-items";
import { cn } from "@/lib/utils";

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

function WorkRow({
  item,
  onOpen,
}: {
  item: CoordinatorWorkItem;
  onOpen: (target: CoordinatorWorkTarget) => void;
}) {
  const KindIcon = KIND_ICONS[item.kind];
  const target = item.target;
  return (
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
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-6 shrink-0 px-2 text-[11px]"
        aria-label={`Open ${item.name}`}
        title={target ? `Open ${item.name}` : item.unavailableReason}
        disabled={!target}
        onClick={() => {
          if (target) onOpen(target);
        }}
      >
        Open
      </Button>
    </li>
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
}: {
  items: CoordinatorWorkItem[];
  counts: CoordinatorWorkCounts;
  /** Running delegations, exposed for end-to-end checks. */
  openDelegations: number;
  onOpen: (target: CoordinatorWorkTarget) => void;
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
          className="flex w-9 flex-col items-center gap-2 py-2 text-[11px] text-muted-foreground hover:bg-elevated focus-visible:outline-2 focus-visible:outline-ring"
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
            const sectionId = `${headingId}-${bucket}`;
            return (
              <section key={bucket} aria-labelledby={sectionId} className="mb-1">
                <h3
                  id={sectionId}
                  className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground"
                >
                  <BucketIcon bucket={bucket} />
                  {BUCKET_TITLES[bucket]} ({rows.length})
                </h3>
                <ul className="flex flex-col">
                  {rows.map((item) => (
                    <WorkRow key={item.key} item={item} onOpen={onOpen} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
