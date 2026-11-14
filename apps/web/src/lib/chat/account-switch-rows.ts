import {
  normalizeAgentMailNotice,
  type AgentMailMessageSummary,
} from "@orkestrator/protocol/agent-mail";
import { createPeerMailNativeMessage } from "./client-only-messages";
import type { NativeMessage } from "./native-message-types";

/**
 * Account-switch notices in a mailbox that the transcript cannot show yet.
 *
 * An automatic account switch rides along with the coordinator's next turn
 * instead of starting one, so until other mail wakes it there is no provider
 * row to draw it from. These rows come from the mailbox instead, which the
 * backend owns, so they appear at once and are there again after a reload.
 * Delivered notices are left to the transcript's own carrier row; muted ones
 * were refused, so they are not shown.
 */
export function accountSwitchRowsFromMailbox(
  messages: readonly AgentMailMessageSummary[] | undefined,
): NativeMessage[] {
  if (!messages?.length) return [];
  const rows: NativeMessage[] = [];
  for (const message of messages) {
    if (message.from.kind !== "system") continue;
    if (message.placement === "injected" || message.placement === "bounced") continue;
    const notice = normalizeAgentMailNotice(message.notice);
    if (notice?.resource.kind !== "account-switch") continue;
    try {
      rows.push(
        createPeerMailNativeMessage({
          id: message.id,
          from: message.from,
          trust: message.trust,
          ...(message.subject ? { subject: message.subject } : {}),
          // The one-line row draws from the notice's facts; the body is the
          // coordinator's, and the summary does not carry it.
          body: message.subject ?? "",
          notice,
          createdAt: message.createdAt,
        }),
      );
    } catch {
      // Rows are built while rendering; an unusable entry must not reach React.
    }
  }
  return rows.sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
}

function timeOf(createdAt: string | undefined): number {
  const time = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/**
 * The transcript with `rows` placed by time. A row the transcript already
 * shows (its carrier was delivered) is left out, so a notice is never drawn
 * twice. When older history is not loaded, a row from before the first loaded
 * row is left out too: it belongs in history that is not on screen.
 */
export function withAccountSwitchRows(
  messages: NativeMessage[],
  rows: readonly NativeMessage[],
  options: { earlierHistoryUnloaded?: boolean } = {},
): NativeMessage[] {
  if (rows.length === 0) return messages;
  const shown = new Set(messages.map((message) => message.id));
  const first = messages.find((message) => message.createdAt)?.createdAt;
  const extra = rows.filter(
    (row) =>
      !shown.has(row.id) &&
      !(options.earlierHistoryUnloaded && first && timeOf(row.createdAt) < timeOf(first)),
  );
  if (extra.length === 0) return messages;
  const merged: NativeMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    if (Number.isFinite(at)) {
      while (next < extra.length && timeOf(extra[next]!.createdAt) < at)
        merged.push(extra[next++]!);
    }
    merged.push(message);
  }
  while (next < extra.length) merged.push(extra[next++]!);
  return merged;
}
