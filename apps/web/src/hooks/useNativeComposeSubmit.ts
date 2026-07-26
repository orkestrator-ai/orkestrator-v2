import { useCallback, useState } from "react";
import { toast } from "sonner";
import { fileMentionsEqual } from "@/lib/chat/file-mentions-equal";
import type { FileMention } from "@/types";

/**
 * The slice of a native chat store the submit controller needs. All three
 * agent stores satisfy this through `createNativeChatStoreSlice`.
 */
interface ComposeDraftStore {
  getState: () => {
    getDraftText: (sessionKey: string) => string;
    getDraftMentions: (sessionKey: string) => FileMention[];
    setDraftText: (sessionKey: string, text: string) => void;
    setDraftMentions: (sessionKey: string, mentions: FileMention[]) => void;
    removeAttachment: (sessionKey: string, attachmentId: string) => void;
  };
}

interface UseNativeComposeSubmitOptions<TAttachment extends { id: string }> {
  agentLabel: string;
  sessionKey: string;
  store: ComposeDraftStore;

  /** Current draft, as already read by the compose bar. */
  text: string;
  mentions: FileMention[];
  attachments: TAttachment[];

  /** Expands @mentions to full relative paths before dispatch. */
  serializeForLLM: (text: string, mentions: FileMention[]) => string;

  onSend: (text: string, attachments: TAttachment[]) => Promise<void> | void;
  /** When absent, submitting mid-turn is a no-op rather than a queue. */
  onQueue?: (text: string, attachments: TAttachment[]) => Promise<void> | void;

  isLoading: boolean;
  disabled?: boolean;
  /**
   * Extra reason to refuse a submit, evaluated at click time. OpenCode uses
   * this to block while attachment snapshots are still being read.
   */
  canSubmit?: () => boolean;
  /**
   * Refuse to submit mid-turn when there is no queue to fall back on.
   *
   * Codex sets this: its bridge rejects a second concurrent prompt with a 409,
   * so sending would fail rather than race. Claude and OpenCode instead fall
   * through to `onSend`, which is their long-standing behaviour.
   */
  refuseWhenBusyWithoutQueue?: boolean;
}

interface UseNativeComposeSubmitResult {
  isSending: boolean;
  setIsSending: (sending: boolean) => void;
  /** Send, or queue when a turn is already running and `onQueue` was given. */
  submit: () => Promise<void>;
  /** Send a canned prompt (the review "address all" action). */
  submitPrompt: (prompt: string) => Promise<void>;
}

/**
 * Submit controller shared by the three compose bars.
 *
 * The subtle part — and the reason this is worth sharing rather than
 * reimplementing — is the draft reconciliation after an await: the draft is
 * only cleared if it still holds exactly what was submitted. If the user kept
 * typing while the send was in flight, clearing would eat their input.
 * Attachments are removed by id for the same reason.
 */
export function useNativeComposeSubmit<TAttachment extends { id: string }>({
  agentLabel,
  sessionKey,
  store,
  text,
  mentions,
  attachments,
  serializeForLLM,
  onSend,
  onQueue,
  isLoading,
  disabled = false,
  canSubmit,
  refuseWhenBusyWithoutQueue = false,
}: UseNativeComposeSubmitOptions<TAttachment>): UseNativeComposeSubmitResult {
  const [isSending, setIsSending] = useState(false);

  const submit = useCallback(async () => {
    if (isSending || disabled) return;
    if (canSubmit && !canSubmit()) return;

    const trimmed = text.trim();
    if (attachments.length === 0 && trimmed.length === 0) return;

    const isQueueing = isLoading && Boolean(onQueue);
    if (isLoading && !onQueue && refuseWhenBusyWithoutQueue) return;

    const submittedText = text;
    const submittedMentions = mentions;
    const submittedAttachments = attachments;

    setIsSending(true);
    try {
      const serializedText = serializeForLLM(trimmed, mentions);
      if (isQueueing) {
        await onQueue!(serializedText, attachments);
      } else {
        await onSend(serializedText, attachments);
      }

      const state = store.getState();
      if (
        state.getDraftText(sessionKey) === submittedText
        && fileMentionsEqual(state.getDraftMentions(sessionKey), submittedMentions)
      ) {
        state.setDraftText(sessionKey, "");
        state.setDraftMentions(sessionKey, []);
      }
      for (const attachment of submittedAttachments) {
        state.removeAttachment(sessionKey, attachment.id);
      }
    } catch (error) {
      console.error(
        `[${agentLabel}ComposeBar] Failed to ${isQueueing ? "queue" : "send"} prompt:`,
        error,
      );
      toast.error(isQueueing ? "Failed to queue prompt" : "Failed to send prompt");
    } finally {
      setIsSending(false);
    }
  }, [
    agentLabel,
    attachments,
    canSubmit,
    disabled,
    isLoading,
    isSending,
    mentions,
    onQueue,
    onSend,
    serializeForLLM,
    sessionKey,
    store,
    text,
  ]);

  const submitPrompt = useCallback(
    async (prompt: string) => {
      // Canned prompts never queue — they are an action on the finished turn.
      if (disabled || isSending || isLoading) return;

      setIsSending(true);
      try {
        await onSend(prompt, [] as unknown as TAttachment[]);
      } catch (error) {
        console.error(
          `[${agentLabel}ComposeBar] Failed to send review follow-up:`,
          error,
        );
        toast.error("Failed to send prompt");
      } finally {
        setIsSending(false);
      }
    },
    [agentLabel, disabled, isLoading, isSending, onSend],
  );

  return { isSending, setIsSending, submit, submitPrompt };
}
