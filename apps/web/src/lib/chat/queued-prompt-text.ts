import { extractMarkedAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";

/** An attachment a queued prompt carries, as the queue row shows it. */
export interface QueuedPromptAttachment {
  name: string;
  path?: string;
  type?: "image" | "file";
}

/**
 * What a queued prompt row shows: its text without the marked path-reference
 * block, and the attachments it carries.
 *
 * The block is transport for the agent, not something the user wrote, so the
 * queue hides it exactly as the transcript does
 * (`extractMarkedAttachmentReferences`). The structured attachments win when
 * the row has them; otherwise the files the block names are shown.
 */
export function queuedPromptDisplay(
  text: string,
  attachments?: readonly QueuedPromptAttachment[],
): { text: string; attachments: QueuedPromptAttachment[] } {
  const marked = extractMarkedAttachmentReferences(text);
  return {
    text: marked.prompt,
    attachments:
      attachments && attachments.length > 0
        ? [...attachments]
        : marked.attachments.map(({ name, path }) => ({ name, path })),
  };
}

/**
 * The structured attachments a queued item carries, read defensively from its
 * stored record (`{ type, path, filename }`).
 */
export function queuedPromptAttachments(queued: unknown): QueuedPromptAttachment[] {
  if (!queued || typeof queued !== "object") return [];
  const candidates = (queued as { attachments?: unknown }).attachments;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate): QueuedPromptAttachment[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const attachment = candidate as Record<string, unknown>;
    const path = typeof attachment.path === "string" && attachment.path ? attachment.path : "";
    const name =
      typeof attachment.filename === "string" && attachment.filename
        ? attachment.filename
        : (path.split(/[\\/]/).at(-1) ?? "");
    return [
      {
        name: name || "attachment",
        ...(path ? { path } : {}),
        ...(attachment.type === "image" || attachment.type === "file"
          ? { type: attachment.type }
          : {}),
      },
    ];
  });
}

/**
 * The text to put back in the composer when a queued prompt is edited.
 *
 * Sending appends a path-reference block for the draft's attachments, and the
 * edit restores those attachments to the draft, so keeping the queued block in
 * the text would send it twice. The block is removed only when it names
 * exactly the restored attachments' paths: anything else in it would be lost
 * with it, so the text is then left as it was.
 */
export function queuedPromptEditText(
  text: string,
  attachments: readonly { path: string }[],
): string {
  if (attachments.length === 0) return text;
  const marked = extractMarkedAttachmentReferences(text);
  if (marked.attachments.length === 0) return text;
  const restored = new Set(attachments.map((attachment) => attachment.path));
  const referenced = new Set(marked.attachments.map((reference) => reference.path));
  if (restored.size !== referenced.size) return text;
  for (const path of referenced) if (!restored.has(path)) return text;
  return marked.prompt;
}
