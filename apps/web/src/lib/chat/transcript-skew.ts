import type { NativeMessage } from "./native-message-types";

/**
 * Transcript entries this renderer cannot display because they came from a
 * different Orkestrator version, so a view can say so instead of rendering
 * them as empty rows or dropping them without a trace.
 *
 * Views that render backend transcripts directly (build-pipeline stages, Multi
 * Review reviewers) expect display rows: `{ id, role, content, parts }`. An
 * entry with none of a display row's fields is most likely a newer backend's
 * shape reaching this renderer, or a corrupt snapshot. Known legacy shapes an
 * older backend still sends would be listed beside it (see
 * {@link TranscriptSkewKind}); none is inside the support window today.
 *
 * Detection is by shape, not by version. It needs no round trip, still works
 * when a backend cannot name its version, and never hides a row that is in
 * the shape this renderer reads, whatever version sent it. Which side is older
 * is the version reminder's job (`BackendVersionReminder`).
 */

/**
 * Why an entry was not displayed. Only "unrecognized" today: the one legacy
 * shape this guarded, OpenCode's raw `{ info, parts }` envelope from backends
 * before 2.19.17, retired on 2026-10-24 because those backends are outside the
 * support window (`docs/architecture/version-compatibility.md`). When a
 * backend change stops sending a shape older renderers read, add a kind here,
 * check its matcher in {@link classifyTranscriptEntry} before the display-row
 * test, name the first backend version without it in its notice, and retire
 * it with the window.
 */
export type TranscriptSkewKind = "unrecognized";

/** How a view should treat one transcript entry. */
export type TranscriptEntryShape = "display" | TranscriptSkewKind;

/** True when the entry carries any field of a display row. */
function isDisplayRow(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.role === "string" ||
    typeof entry.content === "string" ||
    Array.isArray(entry.parts)
  );
}

/** Classify one transcript entry. */
export function classifyTranscriptEntry(entry: Record<string, unknown>): TranscriptEntryShape {
  return isDisplayRow(entry) ? "display" : "unrecognized";
}

/** The entry's own id, for a stable notice id. */
export function transcriptEntryId(entry: Record<string, unknown>): string | undefined {
  const id = entry.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** What the notice for `count` skipped entries of one kind says. */
export function describeTranscriptSkew(_kind: TranscriptSkewKind, count: number): string {
  const one = count === 1;
  return `${count} transcript ${one ? "entry" : "entries"} not shown: ${
    one ? "it is" : "they are"
  } in a format this app does not recognize. If this app and its backend run different Orkestrator versions, update the older one.`;
}

/**
 * One system row standing in for a run of entries this renderer cannot show.
 * `anchor` names the run (its first entry's id, or its position) so the row
 * keeps its identity while the run grows.
 */
export function transcriptSkewNoticeMessage({
  kind,
  count,
  anchor,
  createdAt,
}: {
  kind: TranscriptSkewKind;
  count: number;
  anchor: string;
  createdAt: string;
}): NativeMessage {
  const content = describeTranscriptSkew(kind, count);
  return {
    id: `transcript-skew:${kind}:${anchor}`,
    role: "system",
    content,
    parts: [{ type: "text", content }],
    createdAt,
  };
}
