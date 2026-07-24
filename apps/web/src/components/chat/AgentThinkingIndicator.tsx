import { cn } from "@/lib/utils";

interface AgentThinkingIndicatorProps {
  agentName: string;
  className?: string;
}

export function AgentThinkingIndicator({
  agentName,
  className,
}: AgentThinkingIndicatorProps) {
  return (
    <span
      role="status"
      className={cn("agent-thinking-shimmer text-xs", className)}
    >
      {agentName} is thinking...
    </span>
  );
}
