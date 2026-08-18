/**
 * Queue failures the user can resolve themselves.
 *
 * The queue dialog's generic "could not confirm the update" banner is the right
 * message for an unreachable backend, but the wrong one for a refusal the user
 * can act on: it tells them to wait for a refresh that will never change the
 * outcome. Anything thrown as a {@link PromptQueueActionError} carries its own
 * user-facing text instead.
 */
export class PromptQueueActionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptQueueActionError";
  }
}

/**
 * Recognised by `name` as well as by prototype: a test that mocks the module
 * boundary this error crosses would otherwise get a structurally identical
 * error that fails `instanceof`.
 */
export function isPromptQueueActionError(error: unknown): error is PromptQueueActionError {
  return (
    error instanceof PromptQueueActionError ||
    (error instanceof Error && error.name === "PromptQueueActionError")
  );
}

export const COMPOSER_OCCUPIED_MESSAGE =
  "The composer already has an unsent draft. Send or clear it before editing a queued prompt.";

/**
 * Editing a queued prompt loads it into the composer, so it cannot proceed
 * while the composer holds something else — the backend refuses to overwrite a
 * draft it did not create, and overwriting locally would discard input the user
 * never chose to lose.
 */
export function composerOccupiedError(options?: ErrorOptions): PromptQueueActionError {
  return new PromptQueueActionError(COMPOSER_OCCUPIED_MESSAGE, options);
}

/** The backend's refusal to overwrite a compose draft it did not create. */
export function isComposeDraftOccupiedBackendError(error: unknown): boolean {
  return error instanceof Error && /compose draft already exists/i.test(error.message);
}
