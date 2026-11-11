import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Markdown link checks shared by the documentation tests
 * (`tests/unit/todo-index.test.ts`, `tests/unit/docs/instruction-links.test.ts`).
 */

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * The lines of `markdown` outside fenced code blocks, in order. A fence closes
 * on a marker of the same character at least as long as the one that opened it.
 */
export function linesOutsideFences(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === undefined) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

/**
 * The anchors a Markdown file's headings produce, the way GitHub renders them:
 * the heading text lower-cased, punctuation dropped, each space a hyphen, and
 * `-1`, `-2`, ... appended to repeats. Headings inside code fences are skipped.
 */
export function headingAnchors(markdown: string): { anchors: Set<string>; repeated: Set<string> } {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of linesOutsideFences(markdown)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  const repeated = new Set([...seen].filter(([, count]) => count > 1).map(([base]) => base));
  return { anchors, repeated };
}

/**
 * Why a relative link from the file `from` does not land where it says, or
 * undefined when it does. The target must exist, and an anchor into a Markdown
 * file must name one of its headings. Unless `allowRepeatedAnchors` is set, the
 * anchor must also not be the bare form of a heading text the file repeats,
 * because that silently lands on the first of them.
 */
export function relativeLinkProblem(
  from: string,
  link: string,
  options: { allowRepeatedAnchors?: boolean } = {},
): string | undefined {
  const hash = link.indexOf("#");
  const file = hash === -1 ? link : link.slice(0, hash);
  const anchor = hash === -1 ? undefined : decodeURIComponent(link.slice(hash + 1));
  const target = file === "" ? from : path.resolve(path.dirname(from), decodeURIComponent(file));
  if (!existsSync(target)) return "the target does not exist";
  if (anchor === undefined || !target.endsWith(".md")) return undefined;
  const { anchors, repeated } = headingAnchors(readFileSync(target, "utf8"));
  if (!anchors.has(anchor)) return "no heading has this anchor";
  if (!options.allowRepeatedAnchors && repeated.has(anchor))
    return "several headings share this anchor's text";
  return undefined;
}

/** A link target with a URL scheme (`https:`, `mailto:`) is not a repository path. */
export function isExternalLink(link: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(link);
}
