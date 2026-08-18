import { writeInitialPromptAttachments } from "@/lib/backend";
import type { InitialPromptImageAttachment } from "@/types";

export type { InitialPromptImageAttachment } from "@/types";

export interface SavedInitialPromptAttachment {
  name: string;
  path: string;
}

export function buildInitialPromptWithAttachmentReferences(
  prompt: string,
  attachments: SavedInitialPromptAttachment[],
): string {
  const trimmedPrompt = prompt.trim();
  if (attachments.length === 0) {
    return trimmedPrompt;
  }

  const attachmentList = attachments
    .map((attachment) => `- ${attachment.name}: ${attachment.path}`)
    .join("\n");
  const attachmentText = `Attached images have been saved in the workspace. Use these image paths as task context:\n${attachmentList}`;

  return trimmedPrompt ? `${trimmedPrompt}\n\n${attachmentText}` : attachmentText;
}

export async function saveInitialPromptAttachments(options: {
  attachments: InitialPromptImageAttachment[];
  environmentId: string;
}): Promise<SavedInitialPromptAttachment[]> {
  const { attachments, environmentId } = options;
  if (attachments.length === 0) {
    return [];
  }
  return writeInitialPromptAttachments(
    environmentId,
    attachments.map(({ id, name, base64Data }) => ({
      id,
      name,
      base64Data,
    })),
  );
}
