/**
 * Whether a provider's incomplete transcript preview already fills the live
 * window ("Incomplete previews and exact recovery" in
 * docs/architecture/native-transcripts.md).
 *
 * A progressive read of an incomplete window asks this to decide whether an
 * exact recovery read is needed: a preview short of the window by both count
 * and bytes is a hydration hole, not a bridge's byte cut. Answering it
 * serializes the provider's raw rows, inline tool output included, which are
 * fresh objects on every read, so the row encoding memo cannot help. The
 * answer is therefore remembered per view for as long as the provider's token
 * holds: a view polled while nothing changes (an interactive snapshot is
 * reprojected on every poll) measures its window once per revision.
 *
 * Only a token that changes whenever the rows do is trusted: the bridge's
 * `sourceToken`, or a derived token that includes the provider's revision. A
 * token derived from count and edge ids alone stays the same while a
 * streaming tail grows, so such a preview is measured on every read. Derived
 * revision tokens reuse only true answers: a short tail can grow past the byte
 * target before its provider revision advances, so false answers are remeasured.
 *
 * The window is measured whole. Measuring row by row with an early stop was
 * tried and cost about 15 µs more on a 500 KB window under the target, the
 * case a byte-cutting bridge produces; it gains only above the target, which
 * such a bridge never sends (benchmark `short-incomplete`).
 */
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import { progressiveHydrationToken } from "./native-agent-projection-helpers.js";

/** Views whose answer is remembered; the least recently asked is dropped first. */
export const PREVIEW_FILL_ANSWERS_LIMIT = 1_024;

interface PreviewFillAnswer {
  token: string;
  fills: boolean;
}

/** The token under which an answer may be reused, or undefined when none is safe. */
export function previewFillToken(
  snapshot: ProviderTranscriptSnapshot,
  targetBytes: number,
): string | undefined {
  if (snapshot.sourceToken) return `${targetBytes}\0source\0${snapshot.sourceToken}`;
  if (snapshot.revision === undefined) return undefined;
  return `${targetBytes}\0revision\0${progressiveHydrationToken(snapshot)}`;
}

export class PreviewFillAnswers {
  private readonly answers = new Map<string, PreviewFillAnswer>();

  constructor(private readonly limit = PREVIEW_FILL_ANSWERS_LIMIT) {}

  get size(): number {
    return this.answers.size;
  }

  /** Same answer as measuring `JSON.stringify(snapshot.messages)` against the window. */
  fills(
    key: string,
    snapshot: ProviderTranscriptSnapshot,
    liveWindow: { messages: number; targetBytes: number },
  ): boolean {
    if (snapshot.messages.length >= liveWindow.messages) return true;
    const token = previewFillToken(snapshot, liveWindow.targetBytes);
    const held = this.answers.get(key);
    if (token !== undefined && held?.token === token) {
      this.answers.delete(key);
      this.answers.set(key, held);
      return held.fills;
    }
    const fills = Buffer.byteLength(JSON.stringify(snapshot.messages)) >= liveWindow.targetBytes;
    this.answers.delete(key);
    if (token === undefined || (!snapshot.sourceToken && !fills)) return fills;
    this.answers.set(key, { token, fills });
    if (this.answers.size > this.limit) {
      const oldest = this.answers.keys().next();
      if (!oldest.done) this.answers.delete(oldest.value);
    }
    return fills;
  }

  /** Drop every view whose key starts with `prefix` (a session's views). */
  forgetPrefix(prefix: string): void {
    for (const key of Array.from(this.answers.keys())) {
      if (key.startsWith(prefix)) this.answers.delete(key);
    }
  }

  clear(): void {
    this.answers.clear();
  }
}
