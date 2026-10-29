/**
 * What a transcript image should say about the version it shows.
 *
 * A pinned image is the copy saved when its message first showed the file.
 * Pins are made on first display, so a message first displayed after its file
 * was overwritten holds the newer bytes; the file's modification time, later
 * than the message, is how that is detected. A live image is the file as it
 * is now, because no copy could be kept.
 */
import type { TranscriptMediaSnapshot } from "@orkestrator/protocol/transcript-media-pins";
import { useRichMessageIdentity } from "@/lib/chat/rich-identity";

/** Clock differences between the agent's host and the file's writer. */
const CLOCK_SLACK_MS = 2_000;

export interface MediaSnapshotNote {
  kind: "live" | "late";
  /** Short visible label. */
  text: string;
  /** Full explanation (tooltip and accessible description). */
  description: string;
}

export function mediaSnapshotNote(
  snapshot: TranscriptMediaSnapshot | null | undefined,
  messageCreatedAt: string | undefined,
): MediaSnapshotNote | null {
  if (!snapshot) return null;
  if (snapshot.status === "live") {
    return {
      kind: "live",
      text: "Current file",
      description:
        snapshot.reason === "missing"
          ? "The copy saved with this message is missing, so this is the file as it is now."
          : "This environment's saved image storage is full, so this is the file as it is now.",
    };
  }
  const modified = snapshot.fileModifiedAt ? Date.parse(snapshot.fileModifiedAt) : NaN;
  const message = messageCreatedAt ? Date.parse(messageCreatedAt) : NaN;
  if (
    Number.isFinite(modified) &&
    Number.isFinite(message) &&
    modified > message + CLOCK_SLACK_MS
  ) {
    return {
      kind: "late",
      text: "Changed since",
      description:
        "The file changed after this message and before it was first shown here, so this may be a newer version than the message showed.",
    };
  }
  return null;
}

/** {@link mediaSnapshotNote} for the message being rendered. */
export function useMediaSnapshotNote(
  snapshot: TranscriptMediaSnapshot | null | undefined,
): MediaSnapshotNote | null {
  return mediaSnapshotNote(snapshot, useRichMessageIdentity()?.createdAt);
}
