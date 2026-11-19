import { NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-agent";
import { NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-terminal-rows";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/**
 * Whether a row is, as a whole, a provider failure: an inline error row a
 * provider wrote (`error-…`) or the backend's terminal error row
 * (`native-terminal:error:…`). Assistant prose never is.
 */
export function isProviderFailureRow(message: Pick<NativeMessage, "id">): boolean {
  return (
    message.id.startsWith(NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX) ||
    message.id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX)
  );
}

/**
 * Whether a row reports how the turn failed: a failure row, or a reply whose
 * turn ended on an error status line (Codex and Pi put the failure there, and
 * the backend then adds no terminal row of its own).
 */
export function messageReportsProviderFailure(
  message: Pick<NativeMessage, "id" | "parts">,
): boolean {
  if (isProviderFailureRow(message)) return true;
  return message.parts.some((part) => part.type === "status" && part.severity === "error");
}

/**
 * The one failure row a recovery action may act on: the transcript's last
 * row, when it reports a failure. Anything the user did after a failure (a new
 * prompt, a reply that followed) moves the last row on, which retires the
 * actions of every earlier failure.
 */
export function actionableProviderFailureId(
  messages: readonly Pick<NativeMessage, "id" | "parts" | "role">[],
): string | undefined {
  const last = messages.at(-1);
  return last && last.role !== "user" && messageReportsProviderFailure(last) ? last.id : undefined;
}

/**
 * A provider-reported reset time in the reader's own clock, or undefined when
 * it is not a time or has already passed.
 */
export function formatProviderFailureReset(
  resetsAt: string | undefined,
  now: number,
  locale?: string,
): string | undefined {
  if (!resetsAt) return undefined;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return undefined;
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: "short", day: "numeric", month: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
