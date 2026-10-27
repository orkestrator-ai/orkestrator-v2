import type { EngineUserInput } from "./engine/types.js";
import { type PromptAttachmentInput, type SessionTitleSource } from "./sessions/thread-registry.js";
import { appendAttachmentTags } from "./messages/attachment-tags.js";
import type { PersistedSessionTitleSource } from "./session-title-index.js";
import type { BridgeModel } from "./models-cache.js";
import { fallbackReasoningId } from "@orkestrator/protocol/native-agent";

export function toEngineInput(
  prompt: string,
  attachments: PromptAttachmentInput[],
): EngineUserInput[] {
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

/**
 * Adds the structured skill binding to a turn's input.
 *
 * The result is exactly one text item (the `$name` marker plus arguments),
 * then the skill item, then any images — app-server attaches the skill's
 * instructions from the item and reads the arguments from the text.
 */
export function withSkillInput(
  input: EngineUserInput[],
  skill: { name: string; path: string } | undefined,
): EngineUserInput[] {
  if (!skill) return input;
  const textIndex = input.findIndex((item) => item.type === "text");
  const skillItem: EngineUserInput = { type: "skill", name: skill.name, path: skill.path };
  return textIndex === -1
    ? [skillItem, ...input]
    : [...input.slice(0, textIndex + 1), skillItem, ...input.slice(textIndex + 1)];
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
