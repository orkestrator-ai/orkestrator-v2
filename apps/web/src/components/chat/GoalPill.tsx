import type { ComponentType } from "react";
import { CircleAlert, CircleCheck, CircleHelp, Gauge, Goal, Loader2, Pause } from "lucide-react";
import {
  describeGoalStatus,
  type NativeAgentGoalStatus,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { GOAL_STATUS_LABELS, goalClock } from "@/lib/chat/goal-presentation";
import { cn } from "@/lib/utils";

export const GOAL_STATUS_STYLES: Record<
  NativeAgentGoalStatus,
  { icon: ComponentType<{ className?: string }>; frame: string; spin?: boolean }
> = {
  active: { icon: Goal, frame: "border-sky-400/30 bg-sky-400/[0.06] text-sky-200" },
  checking: {
    icon: Loader2,
    frame: "border-sky-400/30 bg-sky-400/[0.06] text-sky-200",
    spin: true,
  },
  verifying: {
    icon: Loader2,
    frame: "border-sky-400/30 bg-sky-400/[0.06] text-sky-200",
    spin: true,
  },
  paused: { icon: Pause, frame: "border-border/70 bg-muted/40 text-foreground/80" },
  blocked: { icon: CircleAlert, frame: "border-amber-400/30 bg-amber-400/[0.06] text-amber-200" },
  limited: { icon: Gauge, frame: "border-amber-400/30 bg-amber-400/[0.06] text-amber-200" },
  claimed: { icon: CircleHelp, frame: "border-amber-400/30 bg-amber-400/[0.06] text-amber-200" },
  complete: {
    icon: CircleCheck,
    frame: "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200",
  },
};

/** The clock as its own component: only this re-renders each second of a goal. */
export function GoalElapsed({
  goal,
  className,
}: {
  goal: Pick<NativeAgentGoalView, "status" | "setAt" | "updatedAt" | "endedAt">;
  className?: string;
}) {
  const clock = goalClock(goal);
  const running = clock?.running === true;
  const { elapsedSeconds } = useElapsedTimer(
    running,
    undefined,
    running ? clock.startedAt : undefined,
  );
  const seconds = clock?.running === false ? clock.seconds : elapsedSeconds;
  if (seconds === null || seconds === undefined) return null;
  return <span className={className}>{formatElapsedWithHours(seconds)}</span>;
}

/**
 * The goal at a glance, above the composer: status, iteration and limit, and how
 * long it has been going. From the session snapshot only, so a tab opened or
 * reloaded mid-goal shows the current state. Opens the panel.
 */
export function GoalPill({ goal, onOpen }: { goal: NativeAgentGoalView; onOpen: () => void }) {
  const style = GOAL_STATUS_STYLES[goal.status];
  const Icon = style.icon;
  const description = describeGoalStatus(goal);
  return (
    <button
      type="button"
      data-testid="goal-pill"
      data-goal-status={goal.status}
      onClick={onOpen}
      title={description}
      aria-label={`Goal: ${description}. ${goal.iterations} of ${goal.maxIterations} turns. Open goal details.`}
      className={cn(
        "flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        style.frame,
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", style.spin && "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
      <span className="shrink-0 font-medium">{GOAL_STATUS_LABELS[goal.status]}</span>
      <span className="shrink-0 tabular-nums opacity-80">
        {goal.iterations}/{goal.maxIterations}
      </span>
      <GoalElapsed goal={goal} className="shrink-0 tabular-nums opacity-80" />
      {/* The objective gives way first: a narrow composer keeps the numbers. */}
      <span className="hidden min-w-0 truncate opacity-70 @lg:inline">{goal.objective}</span>
    </button>
  );
}
