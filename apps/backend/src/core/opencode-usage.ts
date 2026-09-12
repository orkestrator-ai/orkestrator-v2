import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

export const MAX_LEDGER_MESSAGES = 8_192;
/** Replay-safe tombstones for ids folded out of `byMessageId`. */
export const MAX_RETIRED_MESSAGE_IDS = 16_384;
const MAX_USABLE_TIMESTAMP_MS = 8.64e15;

export type OpenCodeUsageContribution = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
};

export type OpenCodeUsageLedger = {
  totals: OpenCodeUsageContribution;
  byMessageId: Map<string, OpenCodeUsageContribution>;
  retiredIds: Set<string>;
  latest?: {
    usedTokens: number;
    modelId?: string;
    timestamp?: number;
  };
};

type OpenCodeMessageUsage = OpenCodeUsageContribution & {
  messageId?: string;
  usedTokens: number;
  timestamp?: number;
  modelId?: string;
};

const emptyContribution = (): OpenCodeUsageContribution => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  durationMs: 0,
});

export function createOpenCodeUsageLedger(): OpenCodeUsageLedger {
  return { totals: emptyContribution(), byMessageId: new Map(), retiredIds: new Set() };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usableTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_USABLE_TIMESTAMP_MS
    ? value
    : undefined;
}

function isoFromTimestamp(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const usable = usableTimestamp(value);
  if (usable === undefined) return undefined;
  const date = new Date(usable);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contributionTotal(usage: OpenCodeUsageContribution): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    usage.reasoningTokens
  );
}

function addContribution(
  left: OpenCodeUsageContribution,
  right: OpenCodeUsageContribution,
): OpenCodeUsageContribution {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsd: left.costUsd + right.costUsd,
    durationMs: left.durationMs + right.durationMs,
  };
}

function subtractContribution(
  left: OpenCodeUsageContribution,
  right: OpenCodeUsageContribution,
): OpenCodeUsageContribution {
  return {
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    reasoningTokens: left.reasoningTokens - right.reasoningTokens,
    cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens - right.cacheWriteTokens,
    costUsd: left.costUsd - right.costUsd,
    durationMs: left.durationMs - right.durationMs,
  };
}

function maxContribution(
  left: OpenCodeUsageContribution,
  right: OpenCodeUsageContribution,
): OpenCodeUsageContribution {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningTokens: Math.max(left.reasoningTokens, right.reasoningTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    costUsd: Math.max(left.costUsd, right.costUsd),
    durationMs: Math.max(left.durationMs, right.durationMs),
  };
}

function extractOpenCodeMessageUsage(message: unknown): OpenCodeMessageUsage | undefined {
  const info = asRecord(asRecord(message)?.info);
  const tokens = asRecord(info?.tokens);
  if (!tokens) return undefined;
  const messageId = nonEmptyString(info?.id);
  const inputTokens = nonNegative(tokens.input);
  const outputTokens = nonNegative(tokens.output);
  const reasoningTokens = nonNegative(tokens.reasoning);
  const cache = asRecord(tokens.cache);
  const cacheReadTokens = nonNegative(cache?.read);
  const cacheWriteTokens = nonNegative(cache?.write);
  const reportedTotal = nonNegative(tokens.total);
  const usedTokens =
    reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens + cacheReadTokens;
  const time = asRecord(info?.time);
  const created = usableTimestamp(time?.created);
  const completed = usableTimestamp(time?.completed);
  const completedWasUnusable =
    time?.completed != null && usableTimestamp(time.completed) === undefined;
  const providerId = nonEmptyString(info?.providerID);
  const modelId = nonEmptyString(info?.modelID);
  return {
    ...(messageId ? { messageId } : {}),
    usedTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: nonNegative(info?.cost),
    durationMs:
      created !== undefined && completed !== undefined && completed >= created
        ? completed - created
        : 0,
    timestamp:
      completed !== undefined && completed > 0
        ? completed
        : completedWasUnusable
          ? undefined
          : created !== undefined && created > 0
            ? created
            : undefined,
    ...(modelId ? { modelId: providerId ? `${providerId}/${modelId}` : modelId } : {}),
  };
}

function retireOldestIfNeeded(ledger: OpenCodeUsageLedger): void {
  const overflow = ledger.byMessageId.size - MAX_LEDGER_MESSAGES;
  if (overflow <= 0) return;
  const retiring = [...ledger.byMessageId.keys()].slice(0, overflow);
  for (const messageId of retiring) {
    ledger.byMessageId.delete(messageId);
    ledger.retiredIds.add(messageId);
  }
  const retiredOverflow = ledger.retiredIds.size - MAX_RETIRED_MESSAGE_IDS;
  if (retiredOverflow <= 0) return;
  for (const messageId of [...ledger.retiredIds].slice(0, retiredOverflow)) {
    ledger.retiredIds.delete(messageId);
  }
}

export function recordOpenCodeUsageMessages(
  ledger: OpenCodeUsageLedger,
  messages: readonly unknown[],
): void {
  for (const message of messages) {
    const extracted = extractOpenCodeMessageUsage(message);
    if (!extracted?.messageId) continue;
    if (ledger.retiredIds.has(extracted.messageId)) continue;
    const previous = ledger.byMessageId.get(extracted.messageId);
    if (contributionTotal(extracted) <= 0 && extracted.costUsd <= 0) {
      continue;
    }
    const next = previous ? maxContribution(previous, extracted) : extracted;
    ledger.byMessageId.set(extracted.messageId, next);
    ledger.totals = addContribution(
      previous ? subtractContribution(ledger.totals, previous) : ledger.totals,
      next,
    );
    if (
      extracted.usedTokens > 0 &&
      (ledger.latest === undefined || (extracted.timestamp ?? 0) >= (ledger.latest.timestamp ?? 0))
    ) {
      ledger.latest = {
        usedTokens: extracted.usedTokens,
        ...(extracted.modelId ? { modelId: extracted.modelId } : {}),
        ...(extracted.timestamp === undefined ? {} : { timestamp: extracted.timestamp }),
      };
    }
  }
  retireOldestIfNeeded(ledger);
}

function stepFinishTurns(rawMessages: readonly unknown[]): NativeAgentContextUsage["turns"] {
  const turns = rawMessages.flatMap((message) => {
    const envelope = asRecord(message);
    const info = asRecord(envelope?.info);
    const providerId = nonEmptyString(info?.providerID);
    const modelId = nonEmptyString(info?.modelID);
    const qualifiedModelId = modelId
      ? providerId
        ? `${providerId}/${modelId}`
        : modelId
      : undefined;
    return Array.isArray(envelope?.parts)
      ? envelope.parts.flatMap((candidate) => {
          const part = asRecord(candidate);
          if (part?.type !== "step-finish") return [];
          const tokens = asRecord(part.tokens);
          const turnId = nonEmptyString(part.id) ?? nonEmptyString(part.messageID);
          if (!tokens || !turnId) return [];
          const cache = asRecord(tokens.cache);
          const inputTokens = optionalNonNegative(tokens.input);
          const outputTokens = optionalNonNegative(tokens.output);
          const reasoningTokens = optionalNonNegative(tokens.reasoning);
          const cacheReadTokens = optionalNonNegative(cache?.read);
          const cacheWriteTokens = optionalNonNegative(cache?.write);
          const totalTokens =
            inputTokens === undefined &&
            outputTokens === undefined &&
            cacheReadTokens === undefined &&
            cacheWriteTokens === undefined
              ? undefined
              : (inputTokens ?? 0) +
                (outputTokens ?? 0) +
                (cacheReadTokens ?? 0) +
                (cacheWriteTokens ?? 0);
          return [
            {
              turnId,
              ...(optionalNonNegative(part.cost) === undefined
                ? {}
                : { costUsd: optionalNonNegative(part.cost) }),
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
              ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
              ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
              ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
              ...(totalTokens === undefined ? {} : { totalTokens }),
              ...(qualifiedModelId ? { modelId: qualifiedModelId } : {}),
            },
          ];
        })
      : [];
  });
  return turns.length > 0 ? turns.slice(-20) : undefined;
}

function usageFromTotals(
  totals: OpenCodeUsageContribution,
  latest: OpenCodeMessageUsage | OpenCodeUsageLedger["latest"],
  turns: NativeAgentContextUsage["turns"],
): NativeAgentContextUsage {
  const updatedAt = isoFromTimestamp(latest?.timestamp);
  return {
    usedTokens: latest?.usedTokens ?? 0,
    lastTurnTokens: latest?.usedTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    sessionTokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    costUsd: totals.costUsd,
    durationMs: totals.durationMs,
    estimated: false,
    source: "opencode",
    ...(latest && "modelId" in latest && latest.modelId ? { modelId: latest.modelId } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(turns ? { turns } : {}),
  };
}

export function openCodeContextUsageFromLedger(
  ledger: OpenCodeUsageLedger,
  rawMessages: readonly unknown[] = [],
): NativeAgentContextUsage | undefined {
  const windowed = openCodeContextUsage(rawMessages);
  const totals = ledger.totals;
  const sessionTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  if (sessionTokens <= 0 && totals.costUsd <= 0 && !windowed) return undefined;
  const latest = windowed
    ? {
        usedTokens: windowed.usedTokens,
        ...(windowed.modelId ? { modelId: windowed.modelId } : {}),
        timestamp:
          windowed.updatedAt !== undefined
            ? Date.parse(windowed.updatedAt)
            : ledger.latest?.timestamp,
      }
    : ledger.latest;
  return usageFromTotals(totals, latest, windowed?.turns ?? stepFinishTurns(rawMessages));
}

export function openCodeContextUsage(
  rawMessages: readonly unknown[],
): NativeAgentContextUsage | undefined {
  const usageTurns = rawMessages.flatMap((message) => {
    const extracted = extractOpenCodeMessageUsage(message);
    if (!extracted || extracted.usedTokens <= 0) return [];
    return [extracted];
  });
  const latestTurn = usageTurns.at(-1);
  if (!latestTurn) return undefined;
  const turns = stepFinishTurns(rawMessages);
  const updatedAt = isoFromTimestamp(latestTurn.timestamp);
  return usageTurns.reduce<NativeAgentContextUsage>(
    (usage, turn) => ({
      ...usage,
      inputTokens: (usage.inputTokens ?? 0) + turn.inputTokens,
      outputTokens: (usage.outputTokens ?? 0) + turn.outputTokens,
      reasoningTokens: (usage.reasoningTokens ?? 0) + turn.reasoningTokens,
      cacheReadTokens: (usage.cacheReadTokens ?? 0) + turn.cacheReadTokens,
      cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + turn.cacheWriteTokens,
      sessionTokens:
        (usage.sessionTokens ?? 0) +
        turn.inputTokens +
        turn.outputTokens +
        turn.cacheReadTokens +
        turn.cacheWriteTokens,
      costUsd: (usage.costUsd ?? 0) + turn.costUsd,
      durationMs: (usage.durationMs ?? 0) + turn.durationMs,
    }),
    {
      usedTokens: latestTurn.usedTokens,
      lastTurnTokens: latestTurn.usedTokens,
      ...(latestTurn.modelId ? { modelId: latestTurn.modelId } : {}),
      estimated: false,
      source: "opencode",
      // Derived from the transcript, never from the wall clock. A fresh
      // timestamp on every read would give this object a new identity on each
      // call, so the progressive state token — a hash of the whole state view —
      // would keep changing for an unchanged session and force the renderer to
      // apply a full snapshot on every poll. The latest turn's completion time
      // is stable while the transcript is.
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(turns ? { turns } : {}),
    },
  );
}
