export interface ContextUsageSnapshot {
  usedTokens: number;
  totalTokens: number;
  percentUsed: number;
  modelId?: string;
}

const USED_KEYS = [
  "usedTokens",
  "used_tokens",
  "totalTokens",
  "total_tokens",
  "tokensUsed",
  "tokens_used",
];

const TOTAL_KEYS = [
  "totalContextTokens",
  "total_context_tokens",
  "maxContextTokens",
  "max_context_tokens",
  "contextWindowTokens",
  "context_window_tokens",
  "contextWindow",
  "context_window",
  "maxTokens",
  "max_tokens",
  "tokenLimit",
  "token_limit",
];

const MODEL_KEYS = ["model", "modelId", "model_id", "lastModel", "last_model"];

function parseTokenNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;

  const suffix = match[2];
  if (suffix === "k") return Math.round(base * 1_000);
  if (suffix === "m") return Math.round(base * 1_000_000);
  if (suffix === "b") return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function readNumericField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseTokenNumber(source[key]);
    if (typeof parsed === "number") return parsed;
  }
  return undefined;
}

function readModelField(source: Record<string, unknown>): string | undefined {
  for (const key of MODEL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function readUsageCandidate(node: Record<string, unknown>): ContextUsageSnapshot | null {
  const usageNode = node.contextUsage;
  if (usageNode && typeof usageNode === "object" && !Array.isArray(usageNode)) {
    const nested = readUsageCandidate(usageNode as Record<string, unknown>);
    if (nested) {
      return {
        ...nested,
        modelId: nested.modelId ?? readModelField(node),
      };
    }
  }

  const usage = node.usage;
  const usageObject = usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined;

  const source = usageObject ?? node;

  let usedTokens = readNumericField(source, USED_KEYS);
  const inputTokens = parseTokenNumber(source.inputTokens ?? source.input_tokens);
  const outputTokens = parseTokenNumber(source.outputTokens ?? source.output_tokens);
  const totalTokensFromUsage = parseTokenNumber(source.totalTokens ?? source.total_tokens);

  if (typeof usedTokens !== "number") {
    if (typeof inputTokens === "number" && typeof outputTokens === "number") {
      usedTokens = inputTokens + outputTokens;
    } else if (typeof totalTokensFromUsage === "number") {
      usedTokens = totalTokensFromUsage;
    }
  }

  const totalTokens = readNumericField(node, TOTAL_KEYS)
    ?? readNumericField(source, TOTAL_KEYS)
    ?? parseTokenNumber(source.max_input_tokens)
    ?? parseTokenNumber(source.maxInputTokens);

  if (typeof usedTokens !== "number" || typeof totalTokens !== "number") {
    return null;
  }

  if (usedTokens <= 0 || totalTokens <= 0 || usedTokens > totalTokens) {
    return null;
  }

  return {
    usedTokens,
    totalTokens,
    percentUsed: Math.max(0, Math.min(100, (usedTokens / totalTokens) * 100)),
    modelId: readModelField(node) ?? readModelField(source),
  };
}

export function extractContextUsage(payload: unknown): ContextUsageSnapshot | null {
  if (!payload || typeof payload !== "object") return null;

  const queue: Record<string, unknown>[] = [payload as Record<string, unknown>];
  const visited = new WeakSet<object>();
  let bestCandidate: ContextUsageSnapshot | null = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (visited.has(current)) continue;
    visited.add(current);

    const candidate = readUsageCandidate(current);
    if (candidate) {
      const isBetterCandidate =
        !bestCandidate
        || candidate.usedTokens > bestCandidate.usedTokens
        || (
          candidate.usedTokens === bestCandidate.usedTokens
          && !bestCandidate.modelId
          && !!candidate.modelId
        );

      if (isBetterCandidate) {
        bestCandidate = candidate;
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") {
              queue.push(item as Record<string, unknown>);
            }
          }
        } else {
          queue.push(value as Record<string, unknown>);
        }
      }
    }
  }

  return bestCandidate;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  }
  return `${tokens}`;
}
