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
        timestamp: completed > 0 ? completed : created > 0 ? created : undefined,
        ...(modelId ? { modelId: providerId ? `${providerId}/${modelId}` : modelId } : {}),
      },
    ];
  });
  const latestTurn = usageTurns.at(-1);
  if (!latestTurn) return undefined;
  const turns = rawMessages
    .flatMap((message) => {
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
            const number = (value: unknown) =>
              typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
            const inputTokens = number(tokens.input);
            const outputTokens = number(tokens.output);
            const reasoningTokens = number(tokens.reasoning);
            const cacheReadTokens = number(cache?.read);
            const cacheWriteTokens = number(cache?.write);
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
                ...(number(part.cost) === undefined ? {} : { costUsd: number(part.cost) }),
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
    })
    .slice(-20);
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
      ...(latestTurn.timestamp === undefined
        ? {}
        : { updatedAt: new Date(latestTurn.timestamp).toISOString() }),
      ...(turns.length > 0 ? { turns } : {}),
    },
  );
}
