import type { NativeMessage } from "./native-message-types";

/**
 * Transcript entries this renderer cannot display because they came from a
 * different Orkestrator version, so a view can say so instead of rendering
 * them as empty rows or dropping them without a trace.
 *
 * Views that render backend transcripts directly (build-pipeline stages, Multi
 * Review reviewers) expect display rows: `{ id, role, content, parts }`. Two
 * kinds of entry are not that:
 *
 * - A known legacy shape, which an older backend still sends and this renderer
 *   no longer reads. Each is listed in {@link LEGACY_TRANSCRIPT_SHAPES} with the
 *   first backend version that stopped sending it.
 * - An entry with none of a display row's fields: most likely a newer
 *   backend's shape reaching this renderer, or a corrupt snapshot.
 *
 * Detection is by shape, not by version. It needs no round trip, still works
 * when a backend cannot name its version, and never hides a row that is in
 * the shape this renderer reads, whatever version sent it. Which side is older
 * is the version reminder's job (`BackendVersionReminder`).
 */

/** Why an entry was not displayed. */
export type TranscriptSkewKind = keyof typeof LEGACY_TRANSCRIPT_SHAPES | "unrecognized";

/** How a view should treat one transcript entry. */
export type TranscriptEntryShape = "display" | TranscriptSkewKind;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface LegacyTranscriptShape {
  /** Agent named in the notice. */
  agentLabel: string;
  /** First backend version that sends display rows instead of this shape. */
  displayRowsSince: string;
  matches(entry: Record<string, unknown>): boolean;
}

/**
 * Shapes older backends send that this renderer no longer reads. Retire an
 * entry once the mixed-version support window no longer covers backends older
 * than its `displayRowsSince` (`docs/todo/cross-cutting/0034-mixed-version-compatibility.md`).
 */
const LEGACY_TRANSCRIPT_SHAPES = {
  /*
   * OpenCode's raw `{ info, parts }` message. Backends before 2.19.17 served
   * build-pipeline and Multi Review transcripts raw and left normalizing them
   * to the renderer; the backend has normalized them on the way out since
   * #970 (`opencode-display-transcript.ts`), and the renderer's own normalizer
   * is gone. Its role lives inside `info`, so an entry with a top-level role is
   * a display row that merely carries an `info` field.
   */
  "opencode-envelope": {
    agentLabel: "OpenCode",
    displayRowsSince: "2.19.17",
    matches: (entry) => asRecord(entry.info) !== null && typeof entry.role !== "string",
  },
} as const satisfies Record<string, LegacyTranscriptShape>;

const LEGACY_SHAPE_KINDS = Object.keys(LEGACY_TRANSCRIPT_SHAPES) as Array<
  keyof typeof LEGACY_TRANSCRIPT_SHAPES
>;

/** True when the entry carries any field of a display row. */
function isDisplayRow(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.role === "string" ||
    typeof entry.content === "string" ||
    Array.isArray(entry.parts)
  );
}

/**
 * Classify one transcript entry. Legacy shapes are checked first: OpenCode's
 * envelope also has a `parts` array, so it would otherwise pass as a display
 * row and render empty.
 */
export function classifyTranscriptEntry(entry: Record<string, unknown>): TranscriptEntryShape {
  const legacy = LEGACY_SHAPE_KINDS.find((kind) => LEGACY_TRANSCRIPT_SHAPES[kind].matches(entry));
  if (legacy) return legacy;
  return isDisplayRow(entry) ? "display" : "unrecognized";
}

/** The entry's own id, wherever its shape keeps it, for a stable notice id. */
export function transcriptEntryId(entry: Record<string, unknown>): string | undefined {
  const id = entry.id ?? asRecord(entry.info)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** What the notice for `count` skipped entries of one kind says. */
export function describeTranscriptSkew(kind: TranscriptSkewKind, count: number): string {
  const one = count === 1;
  if (kind === "unrecognized") {
    return `${count} transcript ${one ? "entry" : "entries"} not shown: ${
      one ? "it is" : "they are"
    } in a format this app does not recognize. If this app and its backend run different Orkestrator versions, update the older one.`;
  }
  const shape = LEGACY_TRANSCRIPT_SHAPES[kind];
  const them = one ? "it" : "them";
  return `${count} ${shape.agentLabel} ${one ? "message" : "messages"} not shown. The backend runs an Orkestrator version older than ${shape.displayRowsSince}, which sends ${them} in a format this app no longer reads. Update Orkestrator on the computer running the backend to see ${them}.`;
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
