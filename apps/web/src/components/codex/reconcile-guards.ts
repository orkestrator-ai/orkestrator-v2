/**
 * Returns true when an initial prompt exists but has not yet been dispatched.
 * While this is true, session reconciliation should be skipped to avoid a race
 * where reconcile fires before the initial prompt is sent.
 */
export function hasPendingInitialPrompt(
  initialPrompt: string | undefined,
  initialPromptSent: boolean,
): boolean {
  return Boolean(initialPrompt) && !initialPromptSent;
}
