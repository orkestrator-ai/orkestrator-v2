import type {
  NativeAgentContextUsage,
  NativeAgentRateLimitWindow,
} from "@orkestrator/protocol/native-agent";

export type ContextUsageSnapshot = Omit<NativeAgentContextUsage, "maximumTokens" | "percentage"> & {
  totalTokens?: number;
  percentUsed?: number;
};

export type AgentRateLimitWindow = NativeAgentRateLimitWindow;

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return `${Number((tokens / 1_000_000_000).toFixed(2))}B`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  }
  return `${tokens}`;
}
