/**
 * OpenCode's pending revert, and the transcript it leaves on screen.
 *
 * OpenCode 1.19 does not delete a reverted turn. `session.revert` records
 * `Session.revert = { messageID, partID?, snapshot, diff }` and keeps every
 * message; `session.unrevert` clears the marker, and the next prompt runs
 * `SessionRevert.cleanup`, which deletes what the marker covers and then clears
 * it. OpenCode's TUI hides the covered messages meanwhile. The projection does
 * the same, from the marker alone, so the revert stays undoable: nothing is
 * deleted here, and clearing the marker brings the rows back.
 *
 * What the marker covers follows `cleanup` exactly: every message from
 * `messageID` on, except that with a `partID` the target message itself keeps
 * its parts before that part. OpenCode sets `partID` only when the target
 * keeps a text or tool part ahead of it; its own Undo (and Orkestrator's)
 * names a user message, which reverts that whole turn.
 */
import type { NativeAgentNotice } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

export type OpenCodeRevertMarker = { messageId: string; partId?: string };

/** Wider than any OpenCode id; a longer one is not OpenCode's and is ignored. */
const MAX_REVERT_ID_LENGTH = 256;

function boundedId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  return id && id.length <= MAX_REVERT_ID_LENGTH ? id : undefined;
}

/** The pending revert recorded on an OpenCode `Session`, if any. */
export function openCodeRevertMarker(session: unknown): OpenCodeRevertMarker | undefined {
  const revert = asRecord(asRecord(session)?.revert);
  const messageId = boundedId(revert?.messageID);
  if (!messageId) return undefined;
  const partId = boundedId(revert?.partID);
  return partId ? { messageId, partId } : { messageId };
}

export function sameOpenCodeRevertMarker(
  left: OpenCodeRevertMarker | undefined,
  right: OpenCodeRevertMarker | undefined,
): boolean {
  return left?.messageId === right?.messageId && left?.partId === right?.partId;
}

function messageId(message: unknown): string | undefined {
  return nonEmptyString(asRecord(asRecord(message)?.info)?.id) ?? undefined;
}

/**
 * The index of the first message the marker hides, or `messages.length`.
 *
 * A read that holds the target cuts there. One that does not — an older page,
 * or a window starting after the target — compares ids instead, as OpenCode's
 * TUI does: its message ids ascend with creation time, so every message from
 * the target on has an id at least the target's. Rows without an OpenCode id
 * (the stream's own compaction row) are judged by position.
 */
function revertCut(messages: readonly unknown[], marker: OpenCodeRevertMarker): number {
  const exact = messages.findIndex((message) => messageId(message) === marker.messageId);
  if (exact >= 0) return exact;
  if (!marker.messageId.startsWith("msg_")) return messages.length;
  const later = messages.findIndex((message) => {
    const id = messageId(message);
    return id !== undefined && id.startsWith("msg_") && id >= marker.messageId;
  });
  return later < 0 ? messages.length : later;
}

/**
 * The messages a pending revert leaves, in order: the read itself when there
 * is no marker or it covers nothing here. Never mutates `messages`.
 */
export function withoutRevertedOpenCodeMessages(
  messages: readonly unknown[],
  marker: OpenCodeRevertMarker | undefined,
): readonly unknown[] {
  if (!marker) return messages;
  const cut = revertCut(messages, marker);
  if (cut >= messages.length) return messages;
  const kept = messages.slice(0, cut);
  const target = asRecord(messages[cut]);
  if (marker.partId && target && messageId(target) === marker.messageId) {
    const parts = Array.isArray(target.parts) ? target.parts : [];
    const at = parts.findIndex((part) => nonEmptyString(asRecord(part)?.id) === marker.partId);
    // `cleanup` keeps the whole target when the part is not in it.
    kept.push(at < 0 ? target : { ...target, parts: parts.slice(0, at) });
  }
  return kept;
}

/**
 * Says a turn is undone while OpenCode holds it, as its TUI does: the next
 * prompt deletes it for good, and Redo brings it back until then.
 */
export function openCodeRevertNotice(
  marker: OpenCodeRevertMarker | undefined,
): NativeAgentNotice[] {
  if (!marker) return [];
  return [
    {
      kind: "advisory",
      severity: "info",
      occurrenceId: `opencode-revert:${marker.messageId}:${marker.partId ?? ""}`,
      message:
        "Turn undone. Sending a new prompt discards it for good; Redo turn in Agent Info brings it back.",
    },
  ];
}
