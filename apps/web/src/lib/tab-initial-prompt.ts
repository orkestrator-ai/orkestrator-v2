import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { enqueuePromptQueueMessage } from "@/lib/backend";
import { composeDraftKey, updateSavedComposeDraft } from "@/lib/compose-draft-persistence";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { promptQueueKey } from "@/lib/prompt-queue-persistence";
import { createSessionKey } from "@/lib/utils";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  buildTabInitialPromptQueueMessage,
  tabInitialPromptRequestId,
  type TabInitialPromptOptions,
} from "@orkestrator/protocol/tab-initial-prompt";

/*
 * The request id and the per-provider queue message shape are the backend
 * dispatcher's contract, so they live in the protocol package; this module
 * keeps only the renderer side of the hand-off.
 */
export { buildTabInitialPromptQueueMessage, tabInitialPromptRequestId };
export type { TabInitialPromptOptions };

// Only live attempts are retained; hand-off marks them before clearing the tab.
const fallbacks = new Map<string, Set<{ backendOwned: boolean }>>();

export function beginTabInitialPromptFallback(requestId: string) {
  const attempt = { backendOwned: false };
  const attempts = fallbacks.get(requestId) ?? new Set();
  attempts.add(attempt);
  fallbacks.set(requestId, attempts);
  return {
    get backendOwned() {
      return attempt.backendOwned;
    },
    release() {
      attempts.delete(attempt);
      if (attempts.size === 0) fallbacks.delete(requestId);
    },
  };
}

/** Remove only input owned by this opening prompt, including an earlier failed fallback. */
async function removeOpeningPromptDraft(
  input: {
    environmentId: string;
    tabId: string;
    agent: AgentPlatform;
    prompt: string;
    options?: TabInitialPromptOptions;
  },
  requestId: string,
) {
  const sessionKey = createSessionKey(input.environmentId, input.tabId);
  const seeded = input.options?.attachments ?? [];
  const isSeeded = (attachment: { id?: string; path: string }) =>
    seeded.some(
      (image) =>
        image.path === attachment.path && (image.id === undefined || image.id === attachment.id),
    );
  const store = useNativeComposeStore.getState();
  const draft = nativeComposeDraft(store, sessionKey);
  const restored = draft.requestId === requestId && draft.text === input.prompt;
  const attachments = draft.attachments.filter((attachment) => !isSeeded(attachment));
  if (restored || attachments.length !== draft.attachments.length) {
    store.updateDraft(sessionKey, {
      attachments,
      ...(restored
        ? {
            text: "",
            requestId: undefined,
            pendingTranscriptConfirmation: undefined,
            submissionError: undefined,
          }
        : {}),
    });
  }
  // This also works after the persistence hook has flushed and unmounted.
  await updateSavedComposeDraft<{
    text: string;
    mentions: unknown[];
    attachments: Array<{ id?: string; path: string }>;
    metadata?: { requestId?: string; pendingTranscriptConfirmation?: unknown };
  }>(composeDraftKey(input.agent, input.environmentId, sessionKey), (value) => {
    const restored = value.metadata?.requestId === requestId && value.text === input.prompt;
    const attachments = value.attachments.filter((attachment) => !isSeeded(attachment));
    if (!restored && attachments.length === value.attachments.length) return value;
    return {
      ...value,
      attachments,
      ...(restored
        ? {
            text: "",
            metadata: {
              ...value.metadata,
              requestId: undefined,
              pendingTranscriptConfirmation: undefined,
            },
          }
        : {}),
    };
  });
}

/**
 * Hands a new tab's opening prompt to the backend's durable prompt queue, so it
 * is sent whether or not the tab (or its environment) is ever mounted. The
 * backend dispatcher creates the session, waits until the environment is ready
 * for agents and sends the prompt under {@link tabInitialPromptRequestId}.
 *
 * The caller keeps the prompt on the tab as a renderer fallback until this
 * resolves; once the queue entry is durable the fallback is removed. A mount
 * that wins the race sends the same request id, which the backend treats as
 * already dispatched. On enqueue failure the fallback stays and the error propagates.
 * Successful hand-off also clears owned draft input after pending persistence writes.
 */
export async function handTabInitialPromptToBackend(
  input: {
    environmentId: string;
    tabId: string;
    agent: AgentPlatform;
    prompt: string;
    options?: TabInitialPromptOptions;
  },
  enqueue: typeof enqueuePromptQueueMessage = enqueuePromptQueueMessage,
): Promise<void> {
  const requestId = tabInitialPromptRequestId(input.environmentId, input.tabId);
  await enqueue(
    promptQueueKey(input.agent, createSessionKey(input.environmentId, input.tabId)),
    input.environmentId,
    buildTabInitialPromptQueueMessage(input.agent, requestId, input.prompt, input.options),
  );
  for (const attempt of fallbacks.get(requestId) ?? []) attempt.backendOwned = true;
  usePaneLayoutStore.getState().clearTabInitialPrompt(input.tabId, input.environmentId);
  await removeOpeningPromptDraft(input, requestId);
}
