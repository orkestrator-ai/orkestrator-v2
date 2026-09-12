import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

/**
 * Last assistant model from a provider snapshot or normalized transcript.
 *
 * OpenCode reports `providerID`/`modelID` on `info`; shared projections already
 * flatten that into `modelId`. Both shapes have to win over the catalog default
 * when session controls were never persisted.
 */
export function lastAssistantModelRef(messages: readonly unknown[]): {
  modelId?: string;
  reasoningId?: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = message.role ?? info?.role;
    if (role !== "assistant") continue;
    const providerId = nonEmptyString(info?.providerID);
    const localId = nonEmptyString(info?.modelID);
    const modelId =
      nonEmptyString(message.modelId) ??
      (providerId && localId ? `${providerId}/${localId}` : undefined);
    if (!modelId) continue;
    const reasoningId = nonEmptyString(message.reasoningId) ?? nonEmptyString(info?.variant);
    return {
      modelId,
      ...(reasoningId ? { reasoningId } : {}),
    };
  }
  return {};
}

/**
 * Persist only evidence of what this session used or what OpenCode stored —
 * never the catalog default, which is how Nemotron overwrote DeepSeek.
 */
export function openCodeComposerSelectionToPersist(input: {
  sessionControlsModelId?: string;
  lastAssistantModelId?: string;
  lastAssistantReasoningId?: string;
  sessionModelId?: string;
  sessionReasoningId?: string;
}): { modelId: string; reasoningId?: string } | undefined {
  if (nonEmptyString(input.sessionControlsModelId)) return undefined;
  if (input.lastAssistantModelId) {
    return {
      modelId: input.lastAssistantModelId,
      ...(input.lastAssistantReasoningId ? { reasoningId: input.lastAssistantReasoningId } : {}),
    };
  }
  if (input.sessionModelId) {
    return {
      modelId: input.sessionModelId,
      ...(input.sessionReasoningId ? { reasoningId: input.sessionReasoningId } : {}),
    };
  }
  return undefined;
}
