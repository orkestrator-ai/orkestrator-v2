/**
 * How suborks read in a transcript.
 *
 * `/subork` reaches the provider as a carrier the backend wrote, so its row goes
 * back to the words the person typed. The group has no durable transcript row of
 * its own: it is derived from the session snapshot, so a reload shows the same
 * rows and a provider that renders its tool calls differently changes nothing.
 */
import {
  isSuborkRequestCarrier,
  parseSuborkRequestCarrier,
  type NativeAgentSuborkBatchView,
} from "@orkestrator/protocol/suborks";
import { SUBORK_GROUP_MESSAGE_PREFIX } from "./client-only-messages";
import type { NativeMessage } from "./native-message-types";

/** The person's own words for a row that is a `/subork` carrier; otherwise the row itself. */
export function withSuborkRequestText<T extends NativeMessage>(message: T): T {
  if (message.role !== "user") return message;
  const firstText = message.parts.find((part) => part.type === "text");
  const carrier = isSuborkRequestCarrier(message.content)
    ? message.content
    : firstText && isSuborkRequestCarrier(firstText.content)
      ? firstText.content
      : undefined;
  if (carrier === undefined) return message;
  const request = parseSuborkRequestCarrier(carrier)?.request;
  const text = request === undefined ? "/subork" : `/subork ${request}`;
  return { ...message, content: text, parts: [{ type: "text", content: text }] };
}

function suborkGroupRow(batch: NativeAgentSuborkBatchView): NativeMessage {
  return {
    id: `${SUBORK_GROUP_MESSAGE_PREFIX}${batch.id}`,
    role: "system",
    content: "",
    parts: [],
    createdAt: batch.createdAt,
    suborkGroup: batch,
  };
}

/**
 * Places each call where it happened. A call older than the loaded window stays
 * out until its turn is paged in, rather than appearing at the top.
 */
export function withSuborkGroupRows<T extends readonly NativeMessage[]>(
  messages: T,
  batches: readonly NativeAgentSuborkBatchView[] | undefined,
  options: { canLoadEarlier?: boolean } = {},
): T | NativeMessage[] {
  // The same array when there is nothing to add, so a transcript with no calls
  // keeps every reference it had before suborks existed.
  if (!batches || batches.length === 0) return messages;
  const firstAt = Date.parse(messages[0]?.createdAt ?? "");
  const rows = batches
    .filter(
      (batch) =>
        !options.canLoadEarlier ||
        !Number.isFinite(firstAt) ||
        Date.parse(batch.createdAt) >= firstAt,
    )
    .map(suborkGroupRow);
  const result: NativeMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    while (next < rows.length && Number.isFinite(at) && Date.parse(rows[next]!.createdAt) < at) {
      result.push(rows[next]!);
      next += 1;
    }
    result.push(message);
  }
  for (; next < rows.length; next += 1) result.push(rows[next]!);
  return result;
}
