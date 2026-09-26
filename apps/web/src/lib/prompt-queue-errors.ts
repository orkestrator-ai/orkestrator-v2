import { WEB_ANNOTATION_QUEUE_ITEM_FROZEN } from "@orkestrator/protocol/web-annotations";

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

/**
 * Shown instead of the backend's `WEB_ANNOTATION_QUEUE_ITEM_FROZEN` refusal.
 * An annotation request in the queue is a frozen snapshot of the brief the
 * user approved; its text is changed on the note, not in the chat queue.
 */
export const WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE =
  "Web annotation requests can't be edited here. Open the note to change it, or remove it to cancel the request.";

/** The backend's refusal to edit or move-to-draft a web annotation queue item. */
export function isWebAnnotationQueueItemFrozenError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return message !== undefined && message.includes(WEB_ANNOTATION_QUEUE_ITEM_FROZEN);
}

export function webAnnotationQueueItemFrozenError(options?: ErrorOptions): PromptQueueActionError {
  return new PromptQueueActionError(WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE, options);
}

/**
 * User-facing text for a failed queue action: a refusal the user can act on
 * carries its own instruction, a frozen annotation request gets the friendly
 * explanation, and anything else is an unconfirmed update.
 */
export function describePromptQueueActionError(error: unknown): string {
  if (isPromptQueueActionError(error)) return error.message;
  if (isWebAnnotationQueueItemFrozenError(error)) return WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE;
  return "Could not confirm the prompt queue update. Wait for the queue to refresh before retrying.";
}
