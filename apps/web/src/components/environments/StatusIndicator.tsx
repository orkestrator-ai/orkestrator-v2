import { Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EnvironmentStatus } from "@/types";
import { cn } from "@/lib/utils";

interface StatusIndicatorProps {
  status: EnvironmentStatus;
  showLabel?: boolean;
  className?: string;
}

const statusConfig: Record<
  EnvironmentStatus,
  { color: string; label: string; bgColor: string }
> = {
  running: {
    color: "bg-green-500",
    bgColor: "bg-green-500/20",
    label: "Running",
  },
  stopped: {
    color: "bg-zinc-500",
    bgColor: "bg-zinc-500/20",
    label: "Stopped",
  },
  error: {
    color: "bg-red-500",
    bgColor: "bg-red-500/20",
    label: "Error",
  },
  creating: {
    color: "bg-blue-500",
    bgColor: "bg-blue-500/20",
    label: "Creating",
  },
  stopping: {
    color: "bg-orange-500",
    bgColor: "bg-orange-500/20",
    label: "Stopping",
  },
};

export function StatusIndicator({
  status,
  showLabel = false,
  className,
}: StatusIndicatorProps) {
  const config = statusConfig[status];
  const showSpinner = status === "creating" || status === "stopping";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-1.5", className)}>
          {showSpinner ? (
            <Loader2
              className={cn(
                "h-3 w-3 animate-spin",
                status === "creating" && "text-blue-500",
                status === "stopping" && "text-orange-500"
              )}
            />
          ) : (
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                config.color,
                status === "running" && "animate-pulse"
              )}
            />
          )}
          {showLabel && (
            <span
              className={cn(
                "text-xs",
                status === "running" && "text-green-500",
                status === "stopped" && "text-muted-foreground",
                status === "error" && "text-red-500",
                status === "creating" && "text-blue-500",
                status === "stopping" && "text-orange-500"
              )}
            >
              {config.label}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{config.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
