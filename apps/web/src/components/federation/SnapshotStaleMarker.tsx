import { History, Loader2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";

/**
 * Says that what is on screen is this window's saved copy of a node, not the
 * node's current state (plan item 4003): it is shown from the local snapshot
 * while the node connects (`connecting`) and while its first authoritative
 * read is on the way (`refreshing`). Actions wait until it is gone.
 */
export function SnapshotStaleMarker({
  savedAt,
  phase,
  now,
  className,
}: {
  /** When the snapshot was captured (epoch ms). */
  savedAt: number;
  phase: "connecting" | "refreshing";
  /** For tests and previews; defaults to the current time. */
  now?: Date;
  className?: string;
}) {
  const age = formatRelativeTime(savedAt, now);
  const saved = age === "just now" ? "Saved just now" : `Saved ${age}`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="snapshot-stale-marker"
      data-phase={phase}
      title="This is the last copy this window saw. It is replaced as soon as the machine answers; actions wait until then."
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{saved}</span>
      <span aria-hidden="true" className="text-amber-600/60 dark:text-amber-300/50">
        ·
      </span>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
      <span>{phase === "connecting" ? "Connecting…" : "Refreshing…"}</span>
    </div>
  );
}
