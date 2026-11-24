import {
  createOptimisticNativeMessage,
  isClientOnlyNativeMessage,
  positionOptimisticNativeMessage,
} from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeComposeDraft } from "@/stores/nativeComposeStore";

export type TranscriptConfirmation = NonNullable<
  NativeComposeDraft["pendingTranscriptConfirmation"]
>;

export interface OptimisticPrompt {
  id: string;
  text: string;
  attachments: Parameters<typeof createOptimisticNativeMessage>[2];
  createdAt: string;
  requestId?: string;
  sessionId?: string;
  confirmation?: TranscriptConfirmation;
  // Captured when the prompt first appears, before it can produce any rows.
  priorDisplayIds: readonly string[];
  shownBeforeDispatch?: boolean;
  echoId?: string;
}

/**
 * An echo follows every still-visible row from the dispatch snapshot in the
 * same session. Earlier pages can introduce unseen rows before that boundary,
 * and the provider may reshape the submitted text.
 */
export function findPromptEcho(
  messages: readonly NativeMessage[],
  confirmation: TranscriptConfirmation | undefined,
  sessionId: string | undefined,
  after: number,
): number {
  if (!confirmation?.sessionId || confirmation.sessionId !== sessionId) return -1;
  const priorIds = new Set(confirmation.priorMessageIds);
  for (let index = messages.length - 1; index > after; index -= 1) {
    if (priorIds.has(messages[index]!.id)) {
      after = index;
      break;
    }
  }
  return messages.findIndex(
    (message, index) =>
      index > after &&
      message.role === "user" &&
      !isClientOnlyNativeMessage(message) &&
      !priorIds.has(message.id),
  );
}

export function reconcileOptimisticPrompts(
  prompts: readonly OptimisticPrompt[],
  messages: readonly NativeMessage[],
  sessionId: string | undefined,
): readonly OptimisticPrompt[] {
  let lastEcho = -1;
  let changed = false;
  const reconciled: OptimisticPrompt[] = [];
  for (const prompt of prompts) {
    // A resume replaces the transcript. A first dispatch, on the other hand,
    // learns its session id when the initial projection arrives.
    if (prompt.sessionId && sessionId && prompt.sessionId !== sessionId) {
      changed = true;
      continue;
    }
    if (prompt.echoId) {
      const index = messages.findIndex((message) => message.id === prompt.echoId);
      if (index < 0) changed = true;
      else {
        lastEcho = Math.max(lastEcho, index);
        reconciled.push(prompt);
      }
      continue;
    }
    const current =
      sessionId && prompt.confirmation && !prompt.confirmation.sessionId
        ? { ...prompt, sessionId, confirmation: { ...prompt.confirmation, sessionId } }
        : prompt;
    const echo = findPromptEcho(messages, current.confirmation, sessionId, lastEcho);
    if (echo >= 0) {
      lastEcho = echo;
      reconciled.push({
        ...current,
        echoId: messages[echo]!.id,
        // The authoritative row now owns the content and attachments.
        text: "",
        attachments: undefined,
        confirmation: undefined,
      });
      changed = true;
    } else {
      reconciled.push(current);
      changed ||= current !== prompt;
    }
  }
  return changed ? reconciled : prompts;
}

export function placeOptimisticPrompts(
  messages: NativeMessage[],
  prompts: readonly OptimisticPrompt[],
): NativeMessage[] {
  const placedIds = new Map<string, string>();
  let rows = messages;
  for (const prompt of prompts) {
    const echo = prompt.echoId ? rows.find((row) => row.id === prompt.echoId) : undefined;
    if (prompt.echoId && !echo) continue;
    if (echo && !prompt.shownBeforeDispatch) continue;
    const row =
      echo ??
      createOptimisticNativeMessage(prompt.id, prompt.text, prompt.attachments, prompt.createdAt);
    // Preserve the provider ID for history and row actions. A later send can
    // still use the earlier provisional row as an anchor after it has echoed.
    placedIds.set(prompt.id, row.id);
    rows = positionOptimisticNativeMessage(
      echo ? rows.filter(({ id }) => id !== echo.id) : rows,
      row,
      prompt.priorDisplayIds.map((id) => placedIds.get(id) ?? id),
    );
  }
  return rows;
}
