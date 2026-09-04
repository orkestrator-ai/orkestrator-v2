import type { SessionState, SessionUsageSnapshot } from "../types/index.js";

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StreamUsageSnapshot extends UsageTotals {
  /** Usage of the most recently completed provider model call. */
  latest: UsageTotals;
  modelId?: string;
}

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFrom(value: unknown): Partial<UsageTotals> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const parsed: Partial<UsageTotals> = {};
  const inputTokens = token(usage.input_tokens) ?? token(usage.inputTokens);
  const outputTokens = token(usage.output_tokens) ?? token(usage.outputTokens);
  const cacheReadTokens =
    token(usage.cache_read_input_tokens) ??
    token(usage.cacheReadInputTokens) ??
    token(usage.cacheReadTokens);
  const cacheWriteTokens =
    token(usage.cache_creation_input_tokens) ??
    token(usage.cacheCreationInputTokens) ??
    token(usage.cacheWriteTokens);
  if (inputTokens !== undefined) parsed.inputTokens = inputTokens;
  if (outputTokens !== undefined) parsed.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) parsed.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) parsed.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function total(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Accumulates completed Anthropic Messages API calls inside one Claude query.
 *
 * A query can make many model calls around tool use. `message_start` carries
 * input/cache usage and `message_delta` advances output usage; neither alone is
 * a completed bill. Publishing only on `message_stop` gives the review meter a
 * monotonic lower bound without counting the same streamed message twice.
 */
export class ClaudeStreamUsageAccumulator {
  private completed = emptyTotals();
  private current: UsageTotals | undefined;
  private currentModelId: string | undefined;

  apply(message: unknown): StreamUsageSnapshot | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const wrapper = message as Record<string, unknown>;
    if (wrapper.type !== "stream_event") return undefined;
    const event = wrapper.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
    const frame = event as Record<string, unknown>;

    if (frame.type === "message_start") {
      const apiMessage =
        frame.message && typeof frame.message === "object" && !Array.isArray(frame.message)
          ? (frame.message as Record<string, unknown>)
          : undefined;
      this.current = { ...emptyTotals(), ...usageFrom(apiMessage?.usage) };
      this.currentModelId =
        typeof apiMessage?.model === "string" ? apiMessage.model : this.currentModelId;
      return undefined;
    }

    if (frame.type === "message_delta") {
      const usage = usageFrom(frame.usage);
      if (usage) {
        const current = this.current ?? emptyTotals();
        // Stream usage fields are cumulative snapshots of this API message,
        // not deltas to add. Some runtimes repeat an earlier category as zero
        // on the final delta, so keep each field monotonic until message_stop.
        this.current = {
          inputTokens: Math.max(current.inputTokens, usage.inputTokens ?? 0),
          outputTokens: Math.max(current.outputTokens, usage.outputTokens ?? 0),
          cacheReadTokens: Math.max(current.cacheReadTokens, usage.cacheReadTokens ?? 0),
          cacheWriteTokens: Math.max(current.cacheWriteTokens, usage.cacheWriteTokens ?? 0),
        };
      }
      return undefined;
    }

    if (frame.type !== "message_stop" || !this.current) return undefined;
    const latest = this.current;
    this.current = undefined;
    this.completed = {
      inputTokens: this.completed.inputTokens + latest.inputTokens,
      outputTokens: this.completed.outputTokens + latest.outputTokens,
      cacheReadTokens: this.completed.cacheReadTokens + latest.cacheReadTokens,
      cacheWriteTokens: this.completed.cacheWriteTokens + latest.cacheWriteTokens,
    };
    if (total(latest) === 0) return undefined;
    return {
      ...this.completed,
      latest,
      ...(this.currentModelId ? { modelId: this.currentModelId } : {}),
    };
  }

  reset(): void {
    this.completed = emptyTotals();
    this.current = undefined;
    this.currentModelId = undefined;
  }
}

/** Project a completed-model-call lower bound over the last exact session total. */
export function inProgressClaudeUsage(
  session: SessionState,
  live: StreamUsageSnapshot,
): SessionUsageSnapshot {
  const previous = session.usage;
  const liveTokens = total(live);
  const latestTokens = total(live.latest);
  // A context window belongs to a model, not to the session. Reusing the
  // previous denominator after a model switch pairs the new model with the old
  // model's capacity until the terminal context query catches up.
  const canReusePreviousContext =
    live.modelId === undefined ||
    (previous?.modelId !== undefined && previous.modelId === live.modelId);
  const maximumTokens = canReusePreviousContext ? previous?.totalTokens : undefined;
  return {
    usedTokens: latestTokens,
    ...(maximumTokens !== undefined
      ? {
          totalTokens: maximumTokens,
          percentUsed: Math.max(0, Math.min(100, (latestTokens / maximumTokens) * 100)),
        }
      : {}),
    modelId: live.modelId ?? previous?.modelId,
    inputTokens: (previous?.inputTokens ?? 0) + live.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + live.outputTokens,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + live.cacheReadTokens,
    cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + live.cacheWriteTokens,
    lastTurnTokens: liveTokens,
    sessionTokens: (previous?.sessionTokens ?? 0) + liveTokens,
    ...(previous?.costUsd !== undefined ? { costUsd: previous.costUsd } : {}),
    ...(previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
    ...(previous?.apiDurationMs !== undefined ? { apiDurationMs: previous.apiDurationMs } : {}),
    ...(previous?.permissionDenials !== undefined
      ? { permissionDenials: previous.permissionDenials }
      : {}),
    ...(canReusePreviousContext && previous?.contextCategories
      ? { contextCategories: previous.contextCategories }
      : {}),
    ...(session.rateLimits ? { rateLimits: session.rateLimits } : {}),
    estimated: true,
    source: "claude",
    updatedAt: new Date().toISOString(),
  };
}

const cumulativeTokenKeys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "lastTurnTokens",
  "sessionTokens",
] as const;

/**
 * Combine terminal context metadata with the stream's monotonic token floor.
 *
 * A terminal result can contain an exact context reading while omitting the
 * per-turn counters. That makes the snapshot useful, but not authoritative for
 * cumulative spend. Never let such a partial result walk observed tokens back.
 */
export function reconcileClaudeUsage(
  terminal: SessionUsageSnapshot | undefined,
  streamed: SessionUsageSnapshot | undefined,
): SessionUsageSnapshot | undefined {
  if (!terminal) return streamed;
  if (!streamed) return terminal;

  const reconciled: SessionUsageSnapshot = { ...streamed, ...terminal };
  let retainedStreamedFloor = false;
  for (const key of cumulativeTokenKeys) {
    const terminalValue = terminal[key];
    const streamedValue = streamed[key];
    if (terminalValue === undefined && streamedValue === undefined) continue;
    const value = Math.max(terminalValue ?? 0, streamedValue ?? 0);
    reconciled[key] = value;
    if (streamedValue !== undefined && streamedValue > (terminalValue ?? 0)) {
      retainedStreamedFloor = true;
    }
  }
  if (retainedStreamedFloor) reconciled.estimated = true;
  return reconciled;
}
