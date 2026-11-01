import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Bell, Boxes, FolderGit2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MachineDot } from "@/components/federation/MachineDot";
import { cn } from "@/lib/utils";
import { activityRowClassName, type EnvironmentRowFrameData } from "./EnvironmentRowFrame";

export function measureActivityRowLayoutTop(element: HTMLElement): number {
  const getOffsetTop = (node: HTMLElement | null): number => {
    let top = 0;
    let current = node;
    while (current) {
      top += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return top;
  };
  return getOffsetTop(element) - getOffsetTop(element.parentElement);
}

export function animateActivityRowMovement(
  element: HTMLElement,
  previousTop: number | null,
  reduceMotion: boolean,
): { top: number; animation: Animation | null } {
  const nextTop = measureActivityRowLayoutTop(element);
  const offset = previousTop === null ? 0 : previousTop - nextTop;
  let animation: Animation | null = null;
  if (offset !== 0 && !reduceMotion && typeof element.animate === "function") {
    animation = element.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
  }
  return { top: nextTop, animation };
}

function AnimatedActivityRow({
  environmentId,
  position,
  className,
  data,
  children,
}: {
  environmentId: string;
  position: number;
  className: string;
  data?: EnvironmentRowFrameData;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const previousTopRef = useRef<number | null>(null);
  const previousPositionRef = useRef(position);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    // Activity, unread, and status updates all re-render the sidebar. Only run
    // the FLIP animation when this row's actual list position changes so those
    // unrelated updates cannot restart transforms across the whole list.
    if (previousTopRef.current !== null && previousPositionRef.current === position) {
      // A preceding row may have changed height without changing this row's
      // numeric position. Refresh the transform-independent layout baseline,
      // but leave any in-flight animation alone.
      previousTopRef.current = measureActivityRowLayoutTop(row);
      return;
    }

    let previousTop = previousTopRef.current;
    const activeAnimation = animationRef.current;
    if (activeAnimation && activeAnimation.playState === "running") {
      // Preserve the row's current visual position when activity changes again
      // before the prior movement finishes. Cancelling first would otherwise
      // make the row jump to its new layout position.
      const parentTop = row.parentElement?.getBoundingClientRect().top ?? 0;
      const transformedTop = row.getBoundingClientRect().top - parentTop;
      activeAnimation.cancel();
      const layoutTop = row.getBoundingClientRect().top - parentTop;
      previousTop = (previousTopRef.current ?? layoutTop) + (transformedTop - layoutTop);
    }

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const result = animateActivityRowMovement(row, previousTop, reduceMotion);
    previousTopRef.current = result.top;
    previousPositionRef.current = position;
    animationRef.current = result.animation;
  });

  return (
    <div ref={rowRef} data-environment-id={environmentId} className={className} {...data}>
      {children}
    </div>
  );
}

/** A project the activity bar's "Create environment" menu offers. */
export interface ActivityCreateTarget {
  key: string;
  name: string;
  /** Its machine, where the list mixes machines. */
  machine?: { name: string; colorToken: string };
  onSelect: () => void;
}

/** One row of the activity list: its content and how its frame looks. */
export interface ActivityListRow {
  key: string;
  environmentId: string;
  selected: boolean;
  offline?: boolean;
  data?: EnvironmentRowFrameData;
  content: ReactNode;
}

/**
 * "By activity": the controls bar (create, total and waiting counts), the
 * project homes that need attention, then every environment in activity
 * order, with rows animating to their new places. The same list whether it
 * shows this window's machine alone or several machines.
 */
export function ActivityEnvironmentList({
  testId,
  createTargets,
  totalCount,
  waitingCount,
  homes,
  rows,
}: {
  testId: string;
  createTargets: readonly ActivityCreateTarget[];
  totalCount: number;
  waitingCount: number;
  homes: ReactNode;
  rows: readonly ActivityListRow[];
}) {
  return (
    <div data-testid={testId}>
      <div
        data-testid="activity-controls-bar"
        className="sticky top-0 z-10 flex h-10 items-center border-b border-border/60 bg-sidebar/95 px-2 backdrop-blur-sm md:h-8"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:bg-zinc-800 hover:text-foreground"
              aria-label="Create environment"
              title="Create environment"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              New environment in
            </DropdownMenuLabel>
            {createTargets.map((target) => (
              <DropdownMenuItem key={target.key} onSelect={target.onSelect}>
                {target.machine ? (
                  <MachineDot
                    machineName={target.machine.name}
                    colorToken={target.machine.colorToken}
                  />
                ) : (
                  <FolderGit2 className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="truncate">{target.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] tabular-nums text-zinc-400"
                aria-label={`${totalCount} ${totalCount === 1 ? "environment" : "environments"}`}
              >
                <Boxes className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                <span>{totalCount}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>
              Environments
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex h-7 min-w-9 items-center justify-center gap-1.5 rounded-md px-2 font-mono text-[11px] tabular-nums",
                  waitingCount > 0 ? "bg-amber-500/10 text-amber-400" : "text-zinc-600",
                )}
                aria-label={`${waitingCount} waiting ${
                  waitingCount === 1 ? "environment" : "environments"
                }`}
              >
                <Bell
                  className={cn("h-3.5 w-3.5", waitingCount > 0 && "fill-amber-400/20")}
                  aria-hidden="true"
                />
                <span>{waitingCount}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>
              Waiting environments
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {homes}
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No environments yet
        </div>
      ) : (
        <div data-testid="activity-environment-rows" className="px-1 pt-2">
          {rows.map((row, position) => (
            <AnimatedActivityRow
              key={row.key}
              environmentId={row.environmentId}
              position={position}
              className={cn(
                activityRowClassName(row.selected, row.offline),
                "will-change-transform",
              )}
              data={row.data}
            >
              <div className="min-w-0 flex-1 pl-2">{row.content}</div>
            </AnimatedActivityRow>
          ))}
        </div>
      )}
    </div>
  );
}
