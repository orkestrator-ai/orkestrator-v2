import { useRef, type ReactNode } from "react";
import type { CoordinatorActivityState } from "@orkestrator/protocol/coordinator-activity";
import { useTimelineSyncedAnimations } from "@/hooks/useTimelineSyncedAnimations";
import { cn } from "@/lib/utils";

// The same ring and halo an environment row's marker draws around its dot.
const RING_CLASSES: Record<CoordinatorActivityState | "idle", string> = {
  idle: "hidden",
  working: "environment-working-spinner forced-colors:border-solid",
  waiting: "bg-yellow-400/50 animate-pulse forced-colors:border-dashed",
};

/**
 * A coordinator's icon with the environment rows' activity ring around it: a
 * spinner while the coordinator works, a pulsing yellow halo while it waits on
 * the user, nothing while it is idle. The ring sits in a negative margin, so
 * showing it never moves the icon or the text beside it, and it turns on the
 * shared document timeline in step with every environment spinner. Forced
 * colours replace it with a static solid (working) or dashed (waiting)
 * outline. Decorative: callers name the state in text where it matters.
 */
export function CoordinatorActivityIcon({
  state,
  children,
}: {
  state: CoordinatorActivityState | null;
  children: ReactNode;
}) {
  const ringRef = useRef<HTMLSpanElement>(null);
  const shown = state ?? "idle";
  useTimelineSyncedAnimations(ringRef, shown);
  return (
    <span
      data-testid="coordinator-activity-icon"
      data-shape="square"
      data-state={shown}
      className="relative isolate -m-[3px] inline-flex shrink-0 items-center justify-center p-[3px]"
    >
      <span
        ref={ringRef}
        data-testid="coordinator-activity-ring"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[5px] transition-colors forced-colors:animate-none forced-colors:border-2 forced-colors:border-[CanvasText] forced-colors:bg-transparent",
          RING_CLASSES[shown],
        )}
      />
      <span className="relative z-10 inline-flex">{children}</span>
    </span>
  );
}

/** What the coordinator's state reads as in text, e.g. a hover card. */
export function coordinatorActivityLabel(state: CoordinatorActivityState | null): string | null {
  if (state === "working") return "Coordinator working";
  if (state === "waiting") return "Coordinator waiting for you";
  return null;
}
