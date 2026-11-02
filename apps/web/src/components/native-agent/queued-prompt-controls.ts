import type {
  NativeAgentComposerState,
  NativeAgentControlUpdate,
} from "@orkestrator/protocol/native-agent";

/**
 * The settings change that editing a queued prompt has to make so the
 * composer sends it the way it was queued.
 *
 * Only selections that differ from the composer are returned. A prompt queued
 * during the running turn was captured from the composer, whose settings are
 * locked while the turn runs, so it normally needs no change at all. That
 * matters because providers refuse a settings change mid-turn (Claude's bridge
 * answers 409), which used to make every queued prompt uneditable until the
 * turn finished.
 */
export function queuedPromptControlRestore(
  queued: Record<string, unknown>,
  composer: NativeAgentComposerState | undefined,
  selectedExecutionProfileId: string | undefined,
): NativeAgentControlUpdate {
  const executionProfileId =
    typeof queued.executionAgent === "string"
      ? queued.executionAgent
      : typeof queued.agent === "string"
        ? queued.agent
        : undefined;
  const modelChanged =
    typeof queued.model === "string" && queued.model !== composer?.selectedModelId;
  return {
    ...(modelChanged ? { modelId: queued.model as string } : {}),
    // Reasoning is validated against the model, so a model change carries it.
    ...(typeof queued.reasoningEffort === "string" &&
    (modelChanged || queued.reasoningEffort !== composer?.selectedReasoningId)
      ? { reasoningId: queued.reasoningEffort }
      : {}),
    ...((queued.mode === "build" || queued.mode === "plan") &&
    queued.mode !== composer?.selectedModeId
      ? { mode: queued.mode }
      : {}),
    ...(typeof queued.fastMode === "boolean" && queued.fastMode !== composer?.fastModeEnabled
      ? { fastMode: queued.fastMode }
      : {}),
    ...(executionProfileId !== undefined && executionProfileId !== selectedExecutionProfileId
      ? { executionProfileId }
      : {}),
    ...(typeof queued.includeLocalSettings === "boolean" &&
    queued.includeLocalSettings !== composer?.includeLocalSettings
      ? { includeLocalSettings: queued.includeLocalSettings }
      : {}),
    ...(typeof queued.promptSuggestions === "boolean" &&
    queued.promptSuggestions !== composer?.promptSuggestionsEnabled
      ? { promptSuggestions: queued.promptSuggestions }
      : {}),
  };
}
