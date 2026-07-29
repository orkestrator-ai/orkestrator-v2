/**
 * Seed a renderer queue projection in tests.
 *
 * Production code never appends to `messageQueue` directly — a queue change the
 * backend does not know about is reverted by the next hydrate — so the stores
 * expose only `setQueueProjection`. Tests still need a cheap way to put a tab
 * into "there are already prompts queued" without standing up the whole backend
 * command path, and that is all this is for. A test asserting how a *mutation*
 * behaves should drive `@/lib/prompt-queue-sources` instead, so that it fails
 * when the real path breaks.
 */
interface QueueProjectionState<TQueued> {
  getQueuedMessages: (sessionKey: string) => TQueued[];
  setQueueProjection: (sessionKey: string, messages: TQueued[]) => void;
}

export function seedQueuedPrompt<TQueued>(
  state: QueueProjectionState<TQueued>,
  sessionKey: string,
  message: TQueued,
): void {
  // Read through the action rather than a captured map: callers hold a state
  // snapshot from before earlier seeds, and zustand actions always see current
  // state.
  state.setQueueProjection(sessionKey, [
    ...state.getQueuedMessages(sessionKey),
    message,
  ]);
}
