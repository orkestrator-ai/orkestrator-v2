import { useEffect, useState } from "react";
import { Check, Loader2, Minus } from "lucide-react";
import type {
  SelfImprovementProgress,
  SelfImprovementStage,
  SelfImprovementStageState,
  SelfImprovementStatus,
  SelfImprovementStep,
} from "@orkestrator/protocol/self-improvement";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import {
  ageMs,
  formatDuration,
  liveness,
  type ProgressClock,
  STATE_TEXT,
  STEP_PURPOSE,
  STEP_TEXT,
  stageFigures,
  stageSummary,
  type StageContext,
} from "@/lib/self-improvement-progress";
import { cn } from "@/lib/utils";
import { formatWhen } from "./SelfImprovementLists";

/** The window's clock, ticking while `active`, so ages keep counting between status reads. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

const MARK_CLASS: Record<SelfImprovementStageState, string> = {
  done: "border-emerald-500/70 bg-emerald-500/15 text-emerald-400",
  running: "border-sky-400/80 bg-sky-500/10 text-sky-300",
  pending: "border-zinc-600 text-transparent",
  skipped: "border-dashed border-zinc-700 text-zinc-500",
};

/** A tick box that is ticked by the run, not by the reader. */
function StageMark({ state }: { state: SelfImprovementStageState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
        MARK_CLASS[state],
      )}
    >
      {state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      {state === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {state === "skipped" ? <Minus className="h-3 w-3" /> : null}
    </span>
  );
}

type Running = NonNullable<SelfImprovementStatus["running"]>;

export interface RunProgressViewProps {
  running: Running;
  progress: SelfImprovementProgress;
  models: SelfImprovementStatus["models"];
  reviewOn: boolean;
  modelName(id: string): string;
  clock: ProgressClock;
}

function contextOf(props: RunProgressViewProps): StageContext {
  return {
    dryRun: props.running.trigger === "dry-run",
    reviewOn: props.reviewOn,
    models: props.models,
    modelName: props.modelName,
  };
}

function took(stage: SelfImprovementStage): string | null {
  if (!stage.startedAt || !stage.finishedAt) return null;
  return formatDuration(Date.parse(stage.finishedAt) - Date.parse(stage.startedAt));
}

const LIVENESS_CLASS = {
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  waiting: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  quiet: "border-amber-500/40 bg-amber-500/10 text-amber-300",
} as const;

/** The stages of the run in progress, each a button that opens the progress window. */
export function RunStages(
  props: RunProgressViewProps & { onOpen(step: SelfImprovementStep): void },
) {
  const { progress, clock, onOpen } = props;
  const context = contextOf(props);
  const state = liveness(progress, clock);
  return (
    <div className="space-y-2">
      <ul aria-label="Run stages" className="space-y-0.5">
        {progress.stages.map((stage) => {
          const summary = stageSummary(stage, progress, context);
          const duration = stage.state === "done" ? took(stage) : null;
          return (
            <li key={stage.step}>
              <button
                type="button"
                onClick={() => onOpen(stage.step)}
                title="Show details"
                aria-current={stage.state === "running" ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-800/60 focus-hairline focus-hairline-outset",
                  stage.state === "pending" || stage.state === "skipped"
                    ? "text-muted-foreground"
                    : "text-foreground",
                )}
              >
                <StageMark state={stage.state} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{STEP_TEXT[stage.step]}</span>
                  {summary ? (
                    <span className="block truncate text-xs text-muted-foreground">{summary}</span>
                  ) : null}
                </span>
                <span className="sr-only">{STATE_TEXT[stage.state]}</span>
                {duration ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{duration}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className={cn("rounded-md border px-2.5 py-1.5 text-xs", LIVENESS_CLASS[state.tone])}>
        {state.text}
      </p>
    </div>
  );
}

/**
 * What the run is doing, stage by stage. It reads the same status the page
 * polls, so it keeps counting while open and closing it never affects the run.
 * Raised above the fullscreen settings layer (`Z_FULLSCREEN_DIALOG`): the
 * shadcn default `z-50` would render it behind them.
 */
export function RunProgressDialog({
  open,
  onOpenChange,
  focus,
  ...props
}: RunProgressViewProps & {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The stage that was clicked, outlined in the list. */
  focus: SelfImprovementStep | null;
}) {
  const { running, progress, clock } = props;
  const context = contextOf(props);
  const state = liveness(progress, clock);
  const trigger = { manual: "Run", daily: "Daily run", "dry-run": "Preview" }[running.trigger];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="2xl"
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader>
          <DialogTitle>{trigger} in progress</DialogTitle>
          <DialogDescription>
            Started {formatWhen(running.startedAt)}, running for{" "}
            {formatDuration(ageMs(progress, running.startedAt, clock))}. Closing this window does
            not stop the run.
          </DialogDescription>
        </DialogHeader>
        <p
          className={cn("rounded-md border px-3 py-2 text-sm", LIVENESS_CLASS[state.tone])}
          role="status"
        >
          {state.text}
        </p>
        <ol aria-label="Stage details" className="space-y-2">
          {progress.stages.map((stage) => {
            const summary = stageSummary(stage, progress, context);
            const figures = stageFigures(stage, progress);
            const duration = took(stage);
            return (
              <li
                key={stage.step}
                aria-current={stage.step === focus ? "true" : undefined}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  stage.step === focus ? "border-sky-500/60 bg-sky-500/5" : "border-zinc-800",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <StageMark state={stage.state} />
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {STEP_TEXT[stage.step]}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {STATE_TEXT[stage.state]}
                    {duration ? `, ${duration}` : ""}
                    {stage.state === "running" && stage.startedAt
                      ? `, ${formatDuration(ageMs(progress, stage.startedAt, clock))} so far`
                      : ""}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {STEP_PURPOSE[stage.step]}
                </p>
                {summary || figures.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-foreground">
                    {summary ? <li>{summary}</li> : null}
                    {figures.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
