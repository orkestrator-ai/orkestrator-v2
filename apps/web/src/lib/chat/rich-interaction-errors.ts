/** Refusals from the rich-interactions commands (`rich-interaction:<code>: …`). */

/** The stable refusal code the backend puts in its message (`rich-interaction:<code>: …`). */
export function richInteractionErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rich-interaction:([a-z-]+):/u.exec(message)?.[1] ?? null;
}

/** The readable part of a refusal, without its code prefix. */
export function richInteractionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.replace(/^.*?rich-interaction:[a-z-]+:\s*/u, "").slice(0, 500) || "The request failed."
  );
}
