import type { ScopeBackend } from "@/lib/backend/scope-backend";
import type { InitialPromptImageAttachment } from "@/types";
import type { SavedInitialPromptAttachment } from "@orkestrator/protocol/initial-prompt-attachments";
export { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
export type { SavedInitialPromptAttachment } from "@orkestrator/protocol/initial-prompt-attachments";

export type { InitialPromptImageAttachment } from "@/types";

export async function saveInitialPromptAttachments(options: {
  attachments: InitialPromptImageAttachment[];
  environmentId: string;
  /** The environment's node (`backendForScope(scope)`, plan item 4007). */
  backend: Pick<ScopeBackend, "writeInitialPromptAttachments">;
}): Promise<SavedInitialPromptAttachment[]> {
  const { attachments, environmentId, backend } = options;
  if (attachments.length === 0) {
    return [];
  }
  return backend.writeInitialPromptAttachments(
    environmentId,
    attachments.map(({ id, name, base64Data }) => ({
      id,
      name,
      base64Data,
    })),
  );
}
