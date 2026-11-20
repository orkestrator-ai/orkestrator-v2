export type RichInteractionErrorCode =
  | "invalid"
  | "capacity"
  | "not-found"
  | "forbidden"
  | "stale"
  | "closed"
  | "conflict"
  | "unavailable";

/** A refusal with a stable code and a readable, content-free message. */
export class RichInteractionError extends Error {
  constructor(
    readonly code: RichInteractionErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "RichInteractionError";
  }
}
