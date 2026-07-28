import { writeContainerFile, writeLocalFile } from "@/lib/backend";
import type { InitialPromptImageAttachment } from "@/types";

export type { InitialPromptImageAttachment } from "@/types";

export interface SavedInitialPromptAttachment {
  name: string;
  path: string;
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || "clipboard.png";
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized === "." || sanitized === ".." ? "clipboard.png" : sanitized;
}

function allocateUniqueFilename(
  requestedName: string,
  usedNames: Set<string>,
): string {
  const sanitized = sanitizeFilename(requestedName);
  const lastDot = sanitized.lastIndexOf(".");
  const hasExtension = lastDot > 0;
  const stem = hasExtension ? sanitized.slice(0, lastDot) : sanitized;
  const extension = hasExtension ? sanitized.slice(lastDot) : "";
  let candidate = sanitized;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
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
  const usedNames = new Set<string>();
  let failed = 0;
  for (const attachment of attachments) {
    const filename = allocateUniqueFilename(attachment.name, usedNames);
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
      failed += 1;
      console.error("[initial-prompt-attachments] Failed to save image:", error);
    }
  }

  if (failed > 0) {
    throw new Error(
      `Failed to save ${failed} of ${attachments.length} initial prompt attachment${attachments.length === 1 ? "" : "s"}`,
    );
  }

  return saved;
}
