import { cn } from "@/lib/utils";

interface AgentThinkingIndicatorProps {
  agentName: string;
  className?: string;
  /**
   * Provider's running estimate of tokens spent in the current thinking block.
   * Approximate by definition, so it is shown as such.
   */
  thinkingTokens?: number;
}

/** "840 tokens", "1.2k tokens": the estimate is approximate, so is the text. */
export function formatThinkingTokens(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)} tokens`;
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}

export function AgentThinkingIndicator({
  agentName,
  className,
  thinkingTokens,
}: AgentThinkingIndicatorProps) {
  return (
    <span role="status" className={cn("agent-thinking-shimmer text-xs", className)}>
      {agentName} is thinking...
      {thinkingTokens !== undefined && thinkingTokens > 0 && (
        <span className="text-muted-foreground/60"> ~{formatThinkingTokens(thinkingTokens)}</span>
      )}
    </span>
  );
}
