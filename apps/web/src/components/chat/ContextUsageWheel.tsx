import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTokenCount, type ContextUsageSnapshot } from "@/lib/context-usage";

interface ContextUsageWheelProps {
  usage: ContextUsageSnapshot | null | undefined;
  className?: string;
}

export function ContextUsageWheel({ usage, className }: ContextUsageWheelProps) {
  const percentRounded = usage ? Math.max(0, Math.min(100, Math.round(usage.percentUsed))) : 0;
  const percentLeft = Math.max(0, 100 - percentRounded);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-center rounded-full",
            usage ? "text-foreground" : "text-muted-foreground/50",
            className,
          )}
          aria-label={
            usage ? `Context window ${percentRounded}% used` : "Context window usage unavailable"
          }
        >
          <svg aria-hidden="true" className="h-5 w-5 -rotate-90" viewBox="0 0 20 20">
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="3"
            />
            {usage ? (
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
            ) : null}
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="px-3 py-2 text-xs leading-relaxed">
        <div className="font-medium">Context window:</div>
        {usage ? (
          <>
            <div>
              {percentRounded}% used ({percentLeft}% left)
            </div>
            <div>
              {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.totalTokens)} tokens
              used
            </div>
            {usage.modelId && <div className="text-muted-foreground">Model: {usage.modelId}</div>}
          </>
        ) : (
          <div className="text-muted-foreground">Usage is not available yet.</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
