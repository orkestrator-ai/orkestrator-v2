import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTokenCount, type ContextUsageSnapshot } from "@/lib/context-usage";

interface ContextUsageWheelProps {
  usage: ContextUsageSnapshot | null | undefined;
  className?: string;
}

export function ContextUsageWheel({ usage, className }: ContextUsageWheelProps) {
  if (!usage) return null;

  const percentRounded = Math.max(0, Math.min(100, Math.round(usage.percentUsed)));
  const percentLeft = Math.max(0, 100 - percentRounded);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-center rounded-full text-foreground",
            className,
          )}
          aria-label={`Context window ${percentRounded}% used`}
        >
          <svg
            aria-hidden="true"
            className="h-5 w-5 -rotate-90"
            viewBox="0 0 20 20"
          >
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="3"
            />
            <circle
              data-context-usage-progress
              cx="10"
              cy="10"
              r="8"
              fill="none"
              pathLength="100"
              stroke="currentColor"
              strokeDasharray={`${percentRounded} ${100 - percentRounded}`}
              strokeWidth="3"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="px-3 py-2 text-xs leading-relaxed">
        <div className="font-medium">Context window:</div>
        <div>
          {percentRounded}% used ({percentLeft}% left)
        </div>
        <div>
          {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.totalTokens)} tokens used
        </div>
        {usage.modelId && <div className="text-muted-foreground">Model: {usage.modelId}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
