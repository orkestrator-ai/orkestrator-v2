export const MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES = 32 * 1024 * 1024;

export interface InitialPromptAttachmentStorageRecord {
  id: string;
  name: string;
  type?: "image" | "file";
  previewUrl?: string;
  base64Data: string;
}

export interface DurableInitialPromptAttachment {
  id: string;
  name: string;
  type?: "image" | "file";
  base64Data: string;
}

export interface SavedInitialPromptAttachment {
  name: string;
  path: string;
}

const INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING =
  "Attached files have been saved in the workspace. Use these paths as task context:";

export function toDurableInitialPromptAttachments(
  attachments: readonly InitialPromptAttachmentStorageRecord[],
): DurableInitialPromptAttachment[] {
  return attachments.map(({ id, name, type, base64Data }) => ({
    id,
    name,
    ...(type === undefined ? {} : { type }),
    base64Data,
  }));
}

export function serializedInitialPromptAttachmentBytes(
  attachments: readonly InitialPromptAttachmentStorageRecord[],
): number {
  const serialized = JSON.stringify(toDurableInitialPromptAttachments(attachments));
  return new TextEncoder().encode(serialized).byteLength;
}

export function buildInitialPromptWithAttachmentReferences(
  prompt: string,
  attachments: readonly SavedInitialPromptAttachment[],
): string {
  const trimmedPrompt = prompt.trim();
  if (attachments.length === 0) return trimmedPrompt;

  const references = attachments
    .map((attachment) => `- ${attachment.name}: ${attachment.path}`)
    .join("\n");
  const context = `${INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING}\n${references}`;
  return trimmedPrompt ? `${trimmedPrompt}\n\n${context}` : context;
}

/**
 * Remove the legacy path-reference suffix from transcript presentation.
 *
 * The suffix remains part of the provider prompt because terminal agents and
 * persisted startup launches use the workspace paths as task context. Native
 * transcripts can render the same files as structured attachment parts,
 * though, so showing this transport detail beside those parts is redundant.
 * Matching attachment metadata is required so user-authored text and startup
 * files that have no structured transcript part remain visible.
 */
export function stripInitialPromptAttachmentReferences(
  prompt: string,
  attachments: readonly SavedInitialPromptAttachment[],
): string {
  if (attachments.length === 0) return prompt;

  const trimmedPrompt = prompt.trimEnd();
  const embeddedMarker = `\n\n${INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING}\n`;
  const leadingMarker = `${INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING}\n`;
  const embeddedIndex = trimmedPrompt.lastIndexOf(embeddedMarker);
  const markerIndex =
    embeddedIndex >= 0 ? embeddedIndex : trimmedPrompt.startsWith(leadingMarker) ? 0 : -1;
  if (markerIndex < 0) return prompt;

  const referencesStart =
    markerIndex + (embeddedIndex >= 0 ? embeddedMarker.length : leadingMarker.length);
  const references = trimmedPrompt.slice(referencesStart).split("\n");
  const availableReferences = attachments.map(
    (attachment) => `- ${attachment.name}: ${attachment.path}`,
  );
  for (const reference of references) {
    const matchIndex = availableReferences.indexOf(reference);
    if (matchIndex < 0) return prompt;
    availableReferences.splice(matchIndex, 1);
  }

  return trimmedPrompt.slice(0, markerIndex).trimEnd();
}
