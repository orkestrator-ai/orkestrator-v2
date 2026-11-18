import { GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Auto-merge: lucide's `GitMerge` with a small "A" in its top-right corner.
 * Shared by the auto-merge toggles (action bar, ticket view) and the Merge PR
 * dialog's Auto-merge & Cleanup option. Decorative, like lucide icons.
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
      <svg className="absolute top-0 right-0 size-2" viewBox="0 0 8 8" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M3.35 1h1.3l2.6 7H5.9l-.68-1.9H2.78L2.1 8H.75L3.35 1ZM4 2.65l-.83 2.3h1.66L4 2.65Z"
        />
      </svg>
    </span>
  );
}
