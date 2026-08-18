import {
  createWorkspaceAttachment,
  type WorkspaceAttachment,
} from "@/components/chat/NativeAttachmentMenu";
import type { FileCandidate } from "@/types";

/**
 * Attachments a single submission may carry.
 *
 * Workspace picks are delivered to providers by path, so the old per-tab byte
 * ceiling (OpenCode inlined base64 and its server rejected oversized bodies) is
 * expressed as a bound on how many files one prompt can carry. Pasted images
 * keep their own byte ceiling in `useNativeComposeBarPaste`.
 */
export const MAX_PROMPT_ATTACHMENTS = 20;

export interface WorkspaceAttachmentContext {
  containerId?: string;
  worktreePath?: string;
  /** Capability-gated: the agent accepts file attachments at all. */
  allowFiles: boolean;
  /** Capability-gated: the agent accepts image attachments. */
  allowImages: boolean;
  /**
   * False only when the selected model explicitly rejects images. Undefined
   * providers/models are treated as capable, matching the provider contract.
   */
  modelSupportsImages?: boolean;
  modelLabel?: string;
  /** Attachments already on this draft, for the shared ceiling. */
  attachedCount?: number;
}

export type WorkspaceAttachmentResult =
  | { attachment: WorkspaceAttachment }
  | { error: string; description?: string };

/**
 * Turn a picked workspace file into a prompt attachment, or explain why not.
 *
 * Provider-neutral by construction: every rule here is expressed against the
 * neutral capability flags and the neutral model metadata, so a provider that
 * gains image support gets the behavior without a new branch.
 */
export function resolveWorkspaceAttachment(
  file: FileCandidate,
  context: WorkspaceAttachmentContext,
): WorkspaceAttachmentResult {
  const attachment = createWorkspaceAttachment(file, context.containerId, context.worktreePath);
  if (!attachment) {
    return {
      error: "Cannot attach file",
      description: "Environment not properly configured for attachments",
    };
  }
  if (attachment.type === "image") {
    if (!context.allowImages) {
      return {
        error: "Cannot attach image",
        description: "This agent does not accept image attachments.",
      };
    }
    if (context.modelSupportsImages === false) {
      return {
        error: "Model cannot read images",
        description: `${context.modelLabel ?? "The selected model"} does not support image input. Switch to a vision-capable model or mention the file instead.`,
      };
    }
  } else if (!context.allowFiles) {
    return {
      error: "Cannot attach file",
      description: "This agent does not accept file attachments.",
    };
  }
  if ((context.attachedCount ?? 0) >= MAX_PROMPT_ATTACHMENTS) {
    return {
      error: "Cannot attach file",
      description: `A prompt can carry at most ${MAX_PROMPT_ATTACHMENTS} attachments. Remove one and try again.`,
    };
  }
  return { attachment };
}

/**
 * Keep only the attachments the target agent can actually receive.
 *
 * Capability is per type, not all-or-nothing: Codex takes images but refuses
 * files, and its bridge rejects the whole prompt rather than dropping the
 * offending entry. A draft that changes provider — or that is restored under
 * one — must therefore be reconciled against the new capabilities before it can
 * be submitted, or the send fails with an error naming an attachment the
 * composer never offered.
 */
export function retainSupportedAttachments<T extends { type: "file" | "image" }>(
  attachments: readonly T[],
  capabilities: { files: boolean; images: boolean } | undefined,
): T[] {
  if (!capabilities) return [];
  return attachments.filter((attachment) =>
    attachment.type === "image" ? capabilities.images : capabilities.files,
  );
}
