import { coordinatorRuntimeId, type CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import type { NativeComposeDraft } from "@/stores/nativeComposeStore";
import { createSessionKey } from "@/lib/utils";

/** Whether this window's composer holds anything the user wrote, attached, or is sending. */
function composerInUse(draft: NativeComposeDraft | undefined): boolean {
  if (!draft) return false;
  return (
    draft.text.trim().length > 0 ||
    draft.mentions.length > 0 ||
    draft.attachments.length > 0 ||
    draft.annotations.length > 0 ||
    Boolean(draft.submissionPending || draft.heldSubmit || draft.pendingTranscriptConfirmation)
  );
}

/**
 * Side agents this window shows as empty, unassigned composers: the candidates
 * a new conversation may close so they cannot fill the open-conversation
 * limit.
 *
 * Only a hint. The live draft covers text typed in the last few hundred
 * milliseconds that the backend has not saved yet; the backend still checks
 * its saved drafts, mail and owned work before closing anything. The main
 * coordinator is never offered, and neither is a conversation whose first
 * prompt is being sent (`launchingConversationId`).
 */
export function unusedCoordinatorConversationIds(
  workspace: CoordinatorWorkspace,
  drafts: ReadonlyMap<string, NativeComposeDraft>,
  launchingConversationId?: string,
): string[] {
  return workspace.conversations
    .filter(
      (item) =>
        !item.closedAt &&
        item.role === "side" &&
        !item.agent &&
        item.id !== launchingConversationId &&
        !composerInUse(
          drafts.get(createSessionKey(coordinatorRuntimeId(workspace.id, item.id), item.tabId)),
        ),
    )
    .map((item) => item.id);
}
