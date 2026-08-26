import { writeInitialPromptAttachments } from "@/lib/backend";
import type { InitialPromptImageAttachment } from "@/types";
import type { SavedInitialPromptAttachment } from "@orkestrator/protocol/initial-prompt-attachments";
export { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
export type { SavedInitialPromptAttachment } from "@orkestrator/protocol/initial-prompt-attachments";

export type { InitialPromptImageAttachment } from "@/types";

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
