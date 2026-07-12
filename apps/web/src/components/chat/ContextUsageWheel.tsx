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
          className={cn("inline-flex items-center justify-center rounded-full", className)}
          aria-label={`Context window ${percentRounded}% used`}
        >
          <span
            className="relative h-5 w-5 rounded-full"
            style={{
              background: `conic-gradient(hsl(var(--foreground) / 0.85) ${percentRounded}%, hsl(var(--muted-foreground) / 0.25) ${percentRounded}% 100%)`,
            }}
          >
            <span className="absolute inset-[3px] rounded-full bg-background" />
          </span>
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
