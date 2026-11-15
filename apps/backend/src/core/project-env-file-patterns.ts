import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The "Environment Files" setting (`envFilePatterns`): which project files are
 * found for copying into a new environment.
 *
 * This module only *finds* candidates. Every candidate is then read through
 * the seed-file reader (`container-project-seed-files.ts`), which refuses a
 * link, anything but a regular file, a real path outside the project and a
 * file over 1 MiB. The rules here (security review in to-do 8106 (retired),
 * recorded in `docs/architecture/container-lifecycle.md`):
 *
 * - A pattern is a relative path of `/`-separated segments; `*` matches any
 *   run of characters within one segment and `?` one character. Everything
 *   else is literal. `**`, absolute paths, `.`/`..` segments, backslashes,
 *   control characters and any `.git` segment are refused, so a pattern can
 *   only name files below the project root and never Git's own data.
 * - A wildcard does not match a name starting with `.` unless the segment
 *   itself starts with `.` (as in a shell), and never matches `.git`.
 * - Matching never descends through a linked directory: a link where a
 *   directory segment should be is refused and reported.
 * - Directory listings stop after `scannedEntries` entries; the caller then
 *   copies none of the matches.
 */

export const ENV_FILE_PATTERN_LIMITS = Object.freeze({
  /** Patterns beyond this are refused, not silently ignored. */
  patterns: 32,
  patternLength: 256,
  segments: 8,
  /** More matches than this and none are copied. */
  matches: 32,
  /** Matched bytes in total; each file is also held to the 1 MiB file bound. */
  totalBytes: 4 * 1024 * 1024,
  /** Directory entries examined across every wildcard listing. */
  scannedEntries: 5000,
});

export type EnvFilePatternProblem =
  | "empty"
  | "absolute"
  | "parent-segment"
  | "recursive-wildcard"
  | "git-directory"
  | "invalid-character"
  | "too-long"
  | "too-deep";

interface PatternSegment {
  text: string;
  wildcard: boolean;
  regex: RegExp | null;
}

export type ParsedEnvFilePattern =
  | { ok: true; pattern: string; segments: PatternSegment[]; literal: boolean }
  | { ok: false; pattern: string; problem: EnvFilePatternProblem };

// C0 controls, DEL and C1 controls: a name holding one can rewrite the setup
// terminal when it is shown there, or split a line-based copy loop.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function hasUnsafeNameCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value) || value.includes("\\");
}

function segmentRegex(segment: string): RegExp {
  let source = "^";
  for (const character of segment) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

export function parseEnvFilePattern(raw: string): ParsedEnvFilePattern {
  const pattern = raw.trim();
  const refuse = (problem: EnvFilePatternProblem): ParsedEnvFilePattern => ({
    ok: false,
    pattern,
    problem,
  });
  if (pattern.length === 0) return refuse("empty");
  if (pattern.length > ENV_FILE_PATTERN_LIMITS.patternLength) return refuse("too-long");
  if (hasUnsafeNameCharacters(pattern)) return refuse("invalid-character");
  if (
    pattern.startsWith("/") ||
    pattern.startsWith("~") ||
    path.win32.isAbsolute(pattern) ||
    /^[A-Za-z]:/.test(pattern)
  ) {
    return refuse("absolute");
  }
  const parts = pattern.split("/");
  if (parts.length > ENV_FILE_PATTERN_LIMITS.segments) return refuse("too-deep");
  const segments: PatternSegment[] = [];
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return refuse("parent-segment");
    if (part.includes("**")) return refuse("recursive-wildcard");
    if (part.toLowerCase() === ".git") return refuse("git-directory");
    const wildcard = part.includes("*") || part.includes("?");
    segments.push({ text: part, wildcard, regex: wildcard ? segmentRegex(part) : null });
  }
  return { ok: true, pattern, segments, literal: segments.every((segment) => !segment.wildcard) };
}

function wildcardMatches(segment: PatternSegment, name: string): boolean {
  if (name.toLowerCase() === ".git") return false;
  if (name.startsWith(".") && !segment.text.startsWith(".")) return false;
  return segment.regex?.test(name) ?? false;
}

export interface EnvFilePatternCandidates {
  /**
   * Relative paths (`/`-separated) to read, in pattern order, each once. A
   * literal pattern's path is listed whether or not it exists; only an absent
   * literal may be filled from a command node's staged copy.
   */
  candidates: { name: string; literal: boolean }[];
  /** A pattern that could not be used, or a linked directory on the way. */
  refused: { name: string; reason: "invalid-pattern" | "too-many-patterns" | "symlink" }[];
  /** True when listing stopped at `scannedEntries`. */
  scanLimitReached: boolean;
}

interface WalkState {
  scanned: number;
  scanLimitReached: boolean;
  refusedLinks: Set<string>;
}

async function listMatching(
  directory: string,
  segment: PatternSegment,
  state: WalkState,
): Promise<{ name: string; directory: boolean; link: boolean }[]> {
  const matches: { name: string; directory: boolean; link: boolean }[] = [];
  const handle = await fs.opendir(directory).catch(() => null);
  if (!handle) return matches;
  try {
    for await (const entry of handle) {
      if (state.scanned >= ENV_FILE_PATTERN_LIMITS.scannedEntries) {
        state.scanLimitReached = true;
        break;
      }
      state.scanned += 1;
      if (!wildcardMatches(segment, entry.name)) continue;
      matches.push({
        name: entry.name,
        directory: entry.isDirectory(),
        link: entry.isSymbolicLink(),
      });
    }
  } finally {
    // A `for await` that ran to the end has already closed the handle.
    await handle.close().catch(() => undefined);
  }
  return matches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function walk(
  root: string,
  relative: string[],
  segments: readonly PatternSegment[],
  state: WalkState,
  found: string[],
): Promise<void> {
  if (state.scanLimitReached) return;
  const [segment, ...rest] = segments;
  if (!segment) return;
  const directory = path.join(root, ...relative);
  if (rest.length === 0) {
    if (!segment.wildcard) {
      found.push([...relative, segment.text].join("/"));
      return;
    }
    for (const entry of await listMatching(directory, segment, state)) {
      found.push([...relative, entry.name].join("/"));
    }
    return;
  }
  // A directory segment: descend only into real directories.
  const children = segment.wildcard
    ? await listMatching(directory, segment, state)
    : await fs.lstat(path.join(directory, segment.text)).then(
        (stats) => [
          { name: segment.text, directory: stats.isDirectory(), link: stats.isSymbolicLink() },
        ],
        () => [],
      );
  for (const child of children) {
    if (state.scanLimitReached) return;
    const next = [...relative, child.name];
    if (child.link) {
      if (state.refusedLinks.size < ENV_FILE_PATTERN_LIMITS.matches) {
        state.refusedLinks.add(next.join("/"));
      }
      continue;
    }
    if (!child.directory) continue;
    await walk(root, next, rest, state, found);
  }
}

/**
 * Finds the paths `patterns` name below `projectRoot` (already a real path).
 * Never reads a file and never throws for a pattern or a missing directory.
 */
export async function findEnvFilePatternCandidates(
  projectRoot: string,
  patterns: readonly string[],
): Promise<EnvFilePatternCandidates> {
  const result: EnvFilePatternCandidates = {
    candidates: [],
    refused: [],
    scanLimitReached: false,
  };
  const state: WalkState = { scanned: 0, scanLimitReached: false, refusedLinks: new Set() };
  const seen = new Set<string>();
  const usable = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  for (const [index, raw] of usable.entries()) {
    if (index >= ENV_FILE_PATTERN_LIMITS.patterns) {
      // Reported once: the rest are refused the same way.
      if (index === ENV_FILE_PATTERN_LIMITS.patterns) {
        result.refused.push({ name: raw, reason: "too-many-patterns" });
      }
      continue;
    }
    const parsed = parseEnvFilePattern(raw);
    if (!parsed.ok) {
      result.refused.push({ name: parsed.pattern, reason: "invalid-pattern" });
      continue;
    }
    const found: string[] = [];
    await walk(projectRoot, [], parsed.segments, state, found);
    for (const candidate of found) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      result.candidates.push({ name: candidate, literal: parsed.literal });
    }
    if (state.scanLimitReached) break;
  }
  for (const link of state.refusedLinks) result.refused.push({ name: link, reason: "symlink" });
  result.scanLimitReached = state.scanLimitReached;
  return result;
}
