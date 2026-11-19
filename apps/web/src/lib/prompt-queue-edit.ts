import {
  buildInitialPromptWithAttachmentReferences,
  extractMarkedAttachmentReferences,
} from "@orkestrator/protocol/initial-prompt-attachments";
import {
  promptQueueEditLeaseExpired,
  type PromptQueueEditBeginRefusal,
  type PromptQueueEditConflict,
  type PromptQueueEditLease,
  type PromptQueueEditView,
} from "@orkestrator/protocol/prompt-queue-edit";
import { queuedPromptEditText } from "@/lib/chat/queued-prompt-text";

export type { PromptQueueEditConflict, PromptQueueEditView };

// The answers of the in-place edit commands, as the web reads them. The queue
// itself is opaque here: callers refresh their own projection afterwards.

export type PromptQueueEditBeginResult =
  | {
      status: "editing";
      lease: PromptQueueEditLease;
      message: unknown;
      tookOver?: boolean;
      queue: unknown;
    }
  | {
      status: "refused";
      reason: PromptQueueEditBeginRefusal;
      expiresAt?: string;
      queue: unknown;
    };

export type PromptQueueEditRenewResult =
  | { status: "renewed"; expiresAt: string }
  | { status: "conflict"; reason: PromptQueueEditConflict };

export type PromptQueueEditFinishResult =
  | { status: "committed" | "released"; queue: unknown }
  | { status: "conflict"; reason: PromptQueueEditConflict; current?: unknown; queue: unknown };

/** A file or image a queued prompt carries, as stored. */
export interface QueuedPromptStoredAttachment {
  type: "image" | "file";
  path: string;
  filename?: string;
  dataUrl?: string;
  [key: string]: unknown;
}

/** What the editor starts from: the text a person wrote, and the files. */
export interface QueuedPromptEditSource {
  /** The text without the attachment path-reference block, when that block was removable. */
  text: string;
  attachments: QueuedPromptStoredAttachment[];
  /** Whether a path-reference block was removed, so a commit writes it back. */
  referencesStripped: boolean;
}

/** The stored attachments of a queued item, keeping only well-formed ones. */
export function queuedPromptStoredAttachments(message: unknown): QueuedPromptStoredAttachment[] {
  if (!message || typeof message !== "object") return [];
  const candidates = (message as { attachments?: unknown }).attachments;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate): QueuedPromptStoredAttachment[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const attachment = candidate as Record<string, unknown>;
    if (attachment.type !== "image" && attachment.type !== "file") return [];
    if (typeof attachment.path !== "string" || !attachment.path) return [];
    return [attachment as QueuedPromptStoredAttachment];
  });
}

/** The display name of a stored attachment. */
export function queuedPromptAttachmentName(attachment: QueuedPromptStoredAttachment): string {
  return attachment.filename || attachment.path.split(/[\\/]/).at(-1) || "attachment";
}

/**
 * The editor's starting point for a queued item. A marked path-reference block
 * that names exactly the item's attachments is transport, not something the
 * person wrote, so it is hidden and written back on commit for the files kept.
 */
export function queuedPromptEditSource(message: unknown): QueuedPromptEditSource {
  const record = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
  const raw = typeof record.text === "string" ? record.text : "";
  const attachments = queuedPromptStoredAttachments(message);
  const text = queuedPromptEditText(raw, attachments);
  return { text, attachments, referencesStripped: text !== raw };
}

/**
 * What a commit sends: the edited text, with the path-reference block rebuilt
 * for the attachments still kept when the source had one, and those
 * attachments. The two travel in one request, so they change together.
 */
export function queuedPromptEditCommit(
  source: Pick<QueuedPromptEditSource, "referencesStripped">,
  text: string,
  attachments: readonly QueuedPromptStoredAttachment[],
): { text: string; attachments: QueuedPromptStoredAttachment[] } {
  const kept = [...attachments];
  if (!source.referencesStripped) return { text, attachments: kept };
  return {
    text: buildInitialPromptWithAttachmentReferences(
      extractMarkedAttachmentReferences(text).prompt,
      kept.map((attachment) => ({
        name: queuedPromptAttachmentName(attachment),
        path: attachment.path,
      })),
    ),
    attachments: kept,
  };
}

/** Whether a commit would leave the prompt with nothing to send. */
export function queuedPromptEditEmpty(
  text: string,
  attachments: readonly QueuedPromptStoredAttachment[],
): boolean {
  return text.trim().length === 0 && attachments.length === 0;
}

/** How a queued row stands with respect to in-place edits. */
export type QueuedPromptEditState =
  /** This client is editing it. */
  | "local"
  /** Another client holds a live lease. */
  | "elsewhere"
  /** A lease ran out without being finished: held until someone reviews it. */
  | "review";

/** The edit state of each queued item, from the projection's `editing` list. */
export function queuedPromptEditStates(
  editing: readonly PromptQueueEditView[] | undefined,
  localLeaseId: string | undefined,
  now = Date.now(),
): Map<string, QueuedPromptEditState> {
  const states = new Map<string, QueuedPromptEditState>();
  for (const view of editing ?? []) {
    states.set(
      view.messageId,
      view.leaseId === localLeaseId
        ? "local"
        : promptQueueEditLeaseExpired(view, now)
          ? "review"
          : "elsewhere",
    );
  }
  return states;
}

/** The note a queued row shows for its edit state. */
export function queuedPromptEditNote(state: QueuedPromptEditState): string {
  switch (state) {
    case "local":
      return "Editing; it will not be sent until you save or cancel.";
    case "elsewhere":
      return "Being edited on another device; it will not be sent until that edit finishes.";
    case "review":
      return "An edit was left unfinished, so this prompt is held. Edit it or release it to send.";
  }
}

/** Why an edit could not begin, as the person reads it. */
export function describePromptQueueEditRefusal(reason: PromptQueueEditBeginRefusal): string {
  switch (reason) {
    case "missing":
      return "This prompt already left the queue, so it can no longer be edited.";
    case "frozen":
      return "This queued item can't be edited.";
    case "held-elsewhere":
      return "This prompt is being edited on another device. Take over to edit it here.";
  }
}

/** A conflict the editor shows, with what the person can do about it. */
export function describePromptQueueEditConflict(reason: PromptQueueEditConflict): string {
  switch (reason) {
    case "lease-lost":
      return "Another device took over editing this prompt. Your text is still here.";
    case "changed":
      return "This prompt was changed elsewhere while you were editing. Your text is still here.";
    case "missing":
      return "This prompt was removed from the queue while you were editing. Your text is still here.";
  }
}
