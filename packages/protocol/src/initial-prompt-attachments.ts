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
  const context = `Attached files have been saved in the workspace. Use these paths as task context:\n${references}`;
  return trimmedPrompt ? `${trimmedPrompt}\n\n${context}` : context;
}
