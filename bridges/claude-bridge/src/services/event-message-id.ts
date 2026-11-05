import type { SSEEvent } from "../types/index.js";

/** The message a frame changes: a full `message.updated` or a `message.patched`. */
export function eventMessageId(event: SSEEvent): string | undefined {
  if (event.type !== "message.updated" && event.type !== "message.patched") return undefined;
  const data = event.data as { message?: { id?: unknown }; messageId?: unknown } | undefined;
  const id = event.type === "message.updated" ? data?.message?.id : data?.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
