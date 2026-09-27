/**
 * Deterministic, bounded excerpt of an annotation thread's earlier discussion.
 *
 * No model is involved: the "summary" is the most recent human and agent
 * entries, each collapsed to one line, truncated, and attributed. It is page-
 * and agent-authored text, so the brief places it inside the untrusted
 * evidence envelope; it never replaces the latest explicit host instruction
 * (the caller excludes that entry). Identical input gives identical output.
 */
import type { WebAnnotationEntry } from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationThreadSummary } from "./web-annotation-contracts.js";

export const THREAD_SUMMARY_LIMITS = Object.freeze({
  entries: 8,
  entryChars: 280,
  totalChars: 2_400,
});

function attribution(entry: WebAnnotationEntry): string | null {
  if (entry.provenance === "host-user" && entry.kind === "comment") return "user note";
  if (entry.provenance === "agent-reference" || entry.kind === "agent-response") {
    const session = entry.transcript
      ? `${entry.transcript.agent} tab ${entry.transcript.tabId}`
      : "agent";
    return `response from ${session}`;
  }
  if (entry.provenance === "legacy-page-comment") return "imported page comment";
  return null;
}

function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let end = max - 1;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

/**
 * @param entries Published thread entries, any order.
 * @param include Which entries may be excerpted (e.g. already-delivered ones).
 */
export function buildWebAnnotationThreadSummary(
  entries: readonly WebAnnotationEntry[],
  include: (entry: WebAnnotationEntry) => boolean,
  context: WebAnnotationThreadSummary["context"],
): WebAnnotationThreadSummary | null {
  const candidates = entries
    .filter(
      (entry) =>
        !entry.supersededBy &&
        typeof entry.body === "string" &&
        entry.body.trim().length > 0 &&
        attribution(entry) !== null &&
        include(entry),
    )
    .sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-THREAD_SUMMARY_LIMITS.entries);
  const lines = candidates.map(
    (entry) =>
      `- [${attribution(entry)}, ${entry.createdAt}] ${excerpt(entry.body!, THREAD_SUMMARY_LIMITS.entryChars)}`,
  );
  // Drop the oldest lines until the excerpt fits; the newest context matters most.
  let start = 0;
  const size = () => lines.slice(start).join("\n").length;
  while (start < lines.length && size() > THREAD_SUMMARY_LIMITS.totalChars) start++;
  if (start >= lines.length) return null;
  return {
    text: lines.slice(start).join("\n"),
    entryIds: candidates.slice(start).map((entry) => entry.id),
    context,
  };
}
