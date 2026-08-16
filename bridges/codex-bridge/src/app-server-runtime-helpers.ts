import { createHash } from "node:crypto";
import type { AppServerEngine } from "./engine/app-server-engine.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "./app-server/approvals.js";
import {
  isInteractionAnswerMap,
  type InteractionAnswer,
  type InteractionRequest,
  type InteractionResolution,
} from "./app-server/interactions.js";
import type {
  EngineEvent,
  EngineGeneration,
  EngineRateLimitWindow,
  EngineRateLimitWindowUpdate,
  EngineThread,
  EngineTurnConfig,
  EngineUsageSnapshot,
  EngineUserInput,
} from "./engine/types.js";
import {
  OverlappingTurnError,
  ThreadRegistry,
  phaseToExternalStatus,
  type BridgeSession,
  type PromptAttachmentInput,
  type SessionPhase,
  type SessionTitleSource,
  type ThreadContext,
} from "./sessions/thread-registry.js";
import {
  TurnAccumulator,
  unconfirmedTurnId,
  type AssistantSegment,
} from "./sessions/turn-accumulator.js";
import {
  compareDispatchRecordsNewestFirst,
  DispatchJournal,
  DispatchJournalAdmissionError,
} from "./sessions/dispatch-journal.js";
import { BridgeSessionStore } from "./sessions/persistence.js";
import {
  beginTurnRenderState,
  createTurnRenderState,
  releaseTurnRenderState,
  renderTurn,
  SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
  type TurnRenderState,
} from "./messages/render-turn.js";
import { UpdateCoalescer } from "./messages/coalescer.js";
import { describeDiffBudget } from "./messages/diff-budget.js";
import { getTranscriptCacheStats } from "./transcript-cache.js";
import {
  createMessageId,
  createSessionId,
  type MessagePatchEventData,
  type NormalizedMessage,
  type NormalizedPart,
} from "./messages/types.js";
import { appendAttachmentTags } from "./messages/attachment-tags.js";
import {
  buildPromptInput,
  expandPromptTemplate,
  getAvailableSlashCommandDefinitions,
  isCodexCliNativeSlashCommand,
  parseCodexSteerCommand,
  parseSlashCommandPrompt,
  wrapPromptForConversationMode,
  type ConversationMode,
  type PromptSlashCommand,
} from "./prompts/slash-commands.js";
import {
  getWorkingDirectory,
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  listPersistedSessionsWithTitlesForCwd,
  type PersistedSessionMeta,
} from "./history/rollout.js";
import {
  buildFallbackSessionTitle,
  persistSessionTitle,
  readPersistedSessionTitleEntries,
  type PersistedSessionTitleSource,
} from "./session-titles.js";
import { AppServerRpcError, isMissingRolloutError } from "./app-server/errors.js";
import type { BridgeModel } from "./models-cache.js";
import {
  structuredOutputFailure,
  tryParseStructuredOutputText,
  type JsonSchema,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { fallbackReasoningId } from "@orkestrator/protocol/native-agent";


export function toEngineInput(prompt: string, attachments: PromptAttachmentInput[]): EngineUserInput[] {
  const input: EngineUserInput[] = [];
  // Codex stores the image itself as an opaque base64 data URL and forgets
  // where it came from, so the text carries the path as well. That is the only
  // copy a transcript rebuilt from the rollout can afford to replay, and it
  // doubles as the reference the model needs to read or edit the file.
  const text = appendAttachmentTags(prompt, attachments);
  if (text.length > 0) input.push({ type: "text", text });
  for (const attachment of attachments) {
    input.push({ type: "local_image", path: attachment.path });
  }
  // A prompt-less turn is not valid; attachments alone still need a text slot.
  if (input.length === 0) input.push({ type: "text", text });
  return input;
}

/** app-server model → the shape the frontend model picker already consumes. */
export function toBridgeModel(model: {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: Array<{ effort: string; description?: string }>;
  defaultReasoningEffort?: string;
}): BridgeModel {
  return {
    id: model.id,
    name: model.displayName || model.id,
    description: model.description,
    // Server order is meaningful; app-server documents that clients must not
    // derive it from the effort names.
    reasoningEfforts: model.supportedReasoningEfforts.map(
      (entry) => entry.effort,
    ) as BridgeModel["reasoningEfforts"],
    reasoningOptions: model.supportedReasoningEfforts.map((entry) => ({
      effort: entry.effort as BridgeModel["reasoningOptions"][number]["effort"],
      label: entry.effort.charAt(0).toUpperCase() + entry.effort.slice(1),
      description: entry.description,
    })),
    defaultReasoningEffort: (fallbackReasoningId(
      model.supportedReasoningEfforts.map((entry) => entry.effort),
      model.defaultReasoningEffort,
    ) ?? model.defaultReasoningEffort) as BridgeModel["defaultReasoningEffort"],
  };
}

export type { PersistedSessionTitleSource, SessionTitleSource };


