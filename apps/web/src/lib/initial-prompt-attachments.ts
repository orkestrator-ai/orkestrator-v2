import { writeContainerFile, writeLocalFile } from "@/lib/backend";

export interface InitialPromptImageAttachment {
  id: string;
  name: string;
  previewUrl: string;
  base64Data: string;
}

export interface SavedInitialPromptAttachment {
  name: string;
  path: string;
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || "clipboard.png";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
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
  containerId: string | null;
  worktreePath?: string | null;
}): Promise<SavedInitialPromptAttachment[]> {
  const { attachments, containerId, worktreePath } = options;
  if (attachments.length === 0) {
    return [];
  }
  if (!containerId && !worktreePath) {
    throw new Error("Cannot save initial prompt attachments without a container or worktree path");
  }

  const saved: SavedInitialPromptAttachment[] = [];
  for (const attachment of attachments) {
    const filename = sanitizeFilename(attachment.name);
    const relativePath = `.orkestrator/initial-prompt/${filename}`;

    try {
      let path: string;

      if (containerId) {
        await writeContainerFile(containerId, relativePath, attachment.base64Data);
        path = `/workspace/${relativePath}`;
      } else {
        path = await writeLocalFile(worktreePath!, relativePath, attachment.base64Data);
      }

      saved.push({ name: filename, path });
    } catch (error) {
      console.error("[initial-prompt-attachments] Failed to save image:", error);
    }
  }

  return saved;
}
