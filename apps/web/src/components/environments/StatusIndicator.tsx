import { Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EnvironmentStatus } from "@/types";
import { cn } from "@/lib/utils";

interface StatusIndicatorProps {
  status: EnvironmentStatus;
  showLabel?: boolean;
  className?: string;
}

const statusConfig: Record<EnvironmentStatus, { color: string; label: string }> = {
  running: { color: "text-status-running", label: "Running" },
  stopped: { color: "text-status-stopped", label: "Stopped" },
  error: { color: "text-status-error", label: "Error" },
  creating: { color: "text-status-creating", label: "Creating" },
  stopping: { color: "text-status-stopped", label: "Stopping" },
};

export function StatusIndicator({ status, showLabel = false, className }: StatusIndicatorProps) {
  const config = statusConfig[status];
  const showSpinner = status === "creating" || status === "stopping";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-1.5", className, config.color)}>
          {showSpinner ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <div
              className={cn(
                "h-2 w-2 rounded-full bg-current",
                status === "running" && "animate-pulse",
              )}
            />
          )}
          {showLabel && <span className="text-xs">{config.label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{config.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
