import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

export function openCodeContextUsage(
  rawMessages: readonly unknown[],
): NativeAgentContextUsage | undefined {
  const usageTurns = rawMessages.flatMap((message) => {
    const info = asRecord(asRecord(message)?.info);
    const tokens = asRecord(info?.tokens);
    if (!tokens) return [];
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const inputTokens = number(tokens.input);
    const outputTokens = number(tokens.output);
    const reasoningTokens = number(tokens.reasoning);
    const cache = asRecord(tokens.cache);
    const cacheReadTokens = number(cache?.read);
    const cacheWriteTokens = number(cache?.write);
    const reportedTotal = number(tokens.total);
    const usedTokens =
      reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens + cacheReadTokens;
    if (usedTokens <= 0) return [];
    const time = asRecord(info?.time);
    const created = number(time?.created);
    const completed = number(time?.completed);
    const providerId = nonEmptyString(info?.providerID);
    const modelId = nonEmptyString(info?.modelID);
    return [
      {
        usedTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: number(info?.cost),
        durationMs: completed >= created ? completed - created : 0,
        ...(modelId ? { modelId: providerId ? `${providerId}/${modelId}` : modelId } : {}),
      },
    ];
  });
  const latestTurn = usageTurns.at(-1);
  if (!latestTurn) return undefined;
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
      updatedAt: new Date().toISOString(),
    },
  );
}
