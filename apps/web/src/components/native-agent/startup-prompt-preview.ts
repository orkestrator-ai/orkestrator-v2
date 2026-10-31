import { parseCoordinatorDelegatedPrompt } from "@orkestrator/protocol/review-evidence-frames";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/**
 * The opening prompt a tab was created with, shown before anything can echo it.
 *
 * A new tab's provider session has to be created before the prompt can be sent,
 * and a backend-owned startup launch dispatches it from the backend once setup
 * is ready. Both take seconds, and until the provider echoes the prompt into the
 * transcript the tab had nothing to show but the connecting logo, so the prompt
 * appeared to arrive late. The preview puts the prompt on screen the moment the
 * tab opens; the wait that remains is the wait for the first response.
 *
 * It is presentation only: it never sends anything, and it retires as soon as
 * the transcript has an authoritative row of its own.
 */
export interface StartupPromptPreview {
  text: string;
  createdAt: string;
  /**
   * The backend dispatches this prompt (`pendingAgentLaunch`), so the tab's own
   * `initialPrompt` is not where it lives. The launch flags clear when dispatch
   * returns, which can be before the echo lands, so a backend preview is held
   * until the transcript or a terminal launch failure retires it.
   */
  backendOwned: boolean;
}

export interface StartupPromptPreviewState {
  preview: StartupPromptPreview | null;
  /** Latched: a retired preview never comes back for the rest of the mount. */
  retired: boolean;
}

export const INITIAL_STARTUP_PROMPT_PREVIEW_STATE: StartupPromptPreviewState = {
  preview: null,
  retired: false,
};

export interface StartupPromptPreviewInput {
  /** The prompt the tab is waiting to send, or the backend is dispatching. */
  source: string | undefined;
  backendOwned: boolean;
  /** The tab's own pending prompt; its removal means the tab consumed it. */
  tabInitialPrompt: string | undefined;
  /** The transcript has a row from the provider, so the preview is redundant. */
  hasAuthoritativeMessages: boolean;
  /** The backend gave up on the startup launch; the prompt will not be sent. */
  launchFailed: boolean;
}

/** What a user bubble shows for `source`; a coordinator frame is not the user's text. */
export function startupPromptDisplayText(source: string | undefined): string {
  const trimmed = source?.trim() ?? "";
  if (!trimmed) return "";
  return parseCoordinatorDelegatedPrompt(trimmed)?.source.trim() ?? trimmed;
}

/**
 * Advance the preview for one render. Returns `state` itself when nothing
 * changed, so callers can set state during render without looping.
 *
 * `now` is read only when a preview is latched, so a caller can pass a clock
 * from a state updater and still compare the result in render.
 */
export function nextStartupPromptPreviewState(
  state: StartupPromptPreviewState,
  input: StartupPromptPreviewInput,
  now: () => string,
): StartupPromptPreviewState {
  if (state.retired) return state;
  const { preview } = state;
  if (preview) {
    const consumed = preview.backendOwned ? input.launchFailed : !input.tabInitialPrompt?.trim();
    if (input.hasAuthoritativeMessages || consumed) return { preview: null, retired: true };
    return state;
  }
  // A transcript that already has rows is a conversation, not an opening.
  if (input.hasAuthoritativeMessages || (input.backendOwned && input.launchFailed)) return state;
  const text = startupPromptDisplayText(input.source);
  if (!text) return state;
  return {
    preview: { text, createdAt: now(), backendOwned: input.backendOwned },
    retired: false,
  };
}

export function startupPromptPreviewMessageId(sessionKey: string): string {
  // The `optimistic-` prefix keeps it client-only for echo detection and
  // anchoring, and the distinct id keeps it out of the centered first-prompt
  // layout, which hides the transcript.
  return `optimistic-native-startup:${sessionKey}`;
}

export function createStartupPromptPreviewMessage(
  sessionKey: string,
  preview: StartupPromptPreview,
): NativeMessage {
  return createOptimisticNativeMessage(
    startupPromptPreviewMessageId(sessionKey),
    preview.text,
    [],
    preview.createdAt,
  );
}
