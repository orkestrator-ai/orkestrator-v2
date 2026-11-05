import { GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Auto-merge: lucide's `GitMerge` with a small "A" in its top-right corner.
 * Shared by the action bar's auto-merge switch and the pipeline's Integrate
 * button, which turns the same switch on. Decorative, like lucide icons.
 */
export function AutoMergeIcon({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-5 shrink-0 items-end justify-start", className)}
    >
      <GitMerge className={cn("h-4 w-4", iconClassName)} />
      <span className="absolute top-0 right-0 text-[9px] leading-none font-semibold">A</span>
    </span>
  );
}
