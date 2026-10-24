import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import { formatElapsed } from "@/lib/format-elapsed";

/**
 * The running clock of a turn, as its own small component. It is the only
 * thing that re-renders each second: holding the tick in a transcript's
 * owner would re-render the whole tab, its shell and its list every second
 * a turn runs.
 *
 * `startedAt` is the backend-owned turn clock, so a remount or an
 * environment switch never restarts the count.
 */
export function LiveElapsed({
  startedAt,
  running = true,
  className = "text-xs text-muted-foreground/50",
}: {
  startedAt: number;
  running?: boolean;
  className?: string;
}) {
  const { elapsedSeconds } = useElapsedTimer(running, undefined, startedAt);
  if (elapsedSeconds === null || elapsedSeconds <= 0) return null;
  return <span className={className}>{formatElapsed(elapsedSeconds)}</span>;
}
