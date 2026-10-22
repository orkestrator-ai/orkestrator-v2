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

/**
 * Markup around the path-reference block so transcripts can hide it.
 *
 * The block is transport for the agent, not something the user wrote, and the
 * files it names already render as attachments. Wrapping it lets a transcript
 * remove it exactly, without guessing from the heading text.
 */
const ATTACHMENT_REFERENCES_OPEN_TAG = '<orkestrator-attachment-paths source="orkestrator">';
const ATTACHMENT_REFERENCES_CLOSE_TAG = "</orkestrator-attachment-paths>";
const ATTACHMENT_REFERENCES_BLOCK = new RegExp(
  `\\s*${ATTACHMENT_REFERENCES_OPEN_TAG}\\n?([\\s\\S]*?)\\n?${ATTACHMENT_REFERENCES_CLOSE_TAG}`,
  "g",
);

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
    // JSON preserves separators and line breaks in both fields. Escape markup so
    // a filename cannot terminate the transport block.
    .map(({ name, path }) => `- ${JSON.stringify({ name, path }).replace(/</g, "\\u003c")}`)
    .join("\n");
  const context =
    `${ATTACHMENT_REFERENCES_OPEN_TAG}\n` +
    `${INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING}\n${references}\n` +
    ATTACHMENT_REFERENCES_CLOSE_TAG;
  return trimmedPrompt ? `${trimmedPrompt}\n\n${context}` : context;
}

/**
 * Remove every valid, source-qualified path-reference block from transcript text.
 *
 * Returns the text without the blocks and the attachments they named, so a
 * transcript with no structured file part can still show the files. Text with
 * no marked block is returned unchanged.
 */
export function extractMarkedAttachmentReferences(prompt: string): {
  prompt: string;
  attachments: SavedInitialPromptAttachment[];
} {
  if (!prompt.includes(ATTACHMENT_REFERENCES_OPEN_TAG)) return { prompt, attachments: [] };

  const attachments: SavedInitialPromptAttachment[] = [];
  let found = false;
  const stripped = prompt.replace(ATTACHMENT_REFERENCES_BLOCK, (_block, body: string) => {
    const lines = body.split("\n");
    if (lines.shift() !== INITIAL_PROMPT_ATTACHMENT_REFERENCE_HEADING) return _block;
    const references: SavedInitialPromptAttachment[] = [];
    for (const line of lines) {
      if (!line.startsWith("- ")) return _block;
      try {
        const reference: unknown = JSON.parse(line.slice(2));
        if (
          !reference ||
          typeof reference !== "object" ||
          !("name" in reference) ||
          typeof reference.name !== "string" ||
          !("path" in reference) ||
          typeof reference.path !== "string"
        )
          return _block;
        references.push({ name: reference.name, path: reference.path });
      } catch {
        return _block;
      }
    }
    if (references.length === 0) return _block;
    found = true;
    attachments.push(...references);
    return "";
  });
  return found ? { prompt: stripped.trim(), attachments } : { prompt, attachments: [] };
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
