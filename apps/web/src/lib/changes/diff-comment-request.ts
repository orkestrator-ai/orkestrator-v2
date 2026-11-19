import type { DiffComment, DiffCommentLine } from "@/stores/diffCommentsStore";

/**
 * Builds the one correction request a batch of diff comments is sent as.
 *
 * Every comment is quoted with the lines it was written about, as they were
 * captured, so the request stays precise after the file moves on. A comment
 * whose file has changed since says so instead of pretending its line numbers
 * still hold.
 */

/** A request longer than this is refused; send fewer comments at a time. */
export const MAX_DIFF_COMMENT_REQUEST_CHARACTERS = 200_000;

export interface DiffCommentRequestItem {
  comment: DiffComment;
  outdated: boolean;
}

function excerptLine(line: DiffCommentLine): string {
  if (line.type === "no-newline") return "\\ No newline at end of file";
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  return `${prefix}${line.text}`;
}

/** A fence longer than any backtick run inside the block. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** `src/app.ts:42`, `src/app.ts:42 (removed line)` or `src/app.ts, hunk @@ … @@`. */
export function diffCommentLocation(comment: DiffComment): string {
  const { anchor } = comment;
  if (anchor.kind === "hunk" || anchor.line === null)
    return `${anchor.path}, hunk ${anchor.hunkHeader}`;
  return anchor.side === "old"
    ? `${anchor.path}:${anchor.line} (removed line)`
    : `${anchor.path}:${anchor.line}`;
}

export function buildDiffCommentRequest(items: readonly DiffCommentRequestItem[]): string {
  const files = new Set(items.map((item) => item.comment.anchor.path));
  const count = items.length === 1 ? "1 comment" : `${items.length} comments`;
  const across = files.size > 1 ? ` across ${files.size} files` : "";
  const sections = items.map(({ comment, outdated }, index) => {
    const { anchor } = comment;
    const lines = [`## ${index + 1}. ${diffCommentLocation(comment)}`];
    if (outdated) {
      lines.push(
        "",
        "Note: this file has changed since the comment was written, so the line numbers may have moved. The code below is what the comment was written about.",
      );
    } else if (anchor.source === "historical") {
      lines.push("", "Note: written on an earlier recorded change to this file.");
    }
    if (anchor.excerpt.length > 0) {
      const code = anchor.excerpt.map(excerptLine).join("\n");
      const fence = fenceFor(code);
      lines.push("", `${fence}diff`, code, ...(anchor.excerptTruncated ? ["…"] : []), fence);
    }
    lines.push("", comment.body);
    return lines.join("\n");
  });
  return [
    `Please address these review comments on the changes in this workspace (${count}${across}). Each quotes the diff lines it refers to; line numbers count in the file as shown in that diff.`,
    ...sections,
  ].join("\n\n");
}

/** 64-bit FNV-1a, as hex; enough to name one batch, not a security boundary. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The request id of one batch: the same comments at the same revisions sent
 * to the same tab get the same id, so retrying a send whose answer was lost
 * finds the queued copy instead of queueing a second one.
 */
export function diffCommentRequestId(
  environmentId: string,
  tabId: string,
  items: ReadonlyArray<{ id: string; revision: number }>,
): string {
  const key = [environmentId, tabId, ...items.map((item) => `${item.id}@${item.revision}`)].join(
    "\0",
  );
  return `diff-comments:${fnv1a64(key)}`;
}
