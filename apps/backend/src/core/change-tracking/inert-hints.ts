/**
 * Which settled watcher hints cannot move a provisional capture's tree
 * (todo 7840). A test run or a build writes only Git-ignored output
 * (`dist/`, `coverage/`, `node_modules/.cache/`); a capture after it costs a
 * full warm pass and a snapshot row and always finds the tree it already
 * published.
 *
 * A host capture inventories tracked files, untracked files Git does not
 * ignore, and every path the previous manifest covered. So a hint whose every
 * path is in none of those cannot change what the capture records. This
 * module holds the pure half of that test: which hints are precise enough to
 * reason about at all, and whether the previous manifest covers a path. The
 * Git half is `CaptureExecutor.ignoredAndUnlisted`, and
 * `WorktreeChangeOwner.hintCannotMoveTree` combines them.
 *
 * The filter may only skip work. Anything it cannot reason about (no paths, an
 * overflowing burst, a Git metadata change in the burst, an ignore-rule file,
 * a name the watcher could not spell exactly) is reported as able to move the
 * tree, so it captures as before.
 */

import path from "node:path";
import { decodePath, encodePath, type Manifest } from "./capture.js";

/** One settled watcher hint, as the environment scan forwards it. */
export interface WorktreeActivity {
  /** Worktree-relative paths the burst touched; null when unknown or overflowing. */
  paths: readonly string[] | null;
  /** The burst also changed Git metadata, which `paths` never names. */
  gitMetadata: boolean;
}

/** Files whose edit changes which other paths Git ignores. */
const IGNORE_RULE_FILES = new Set([".gitignore"]);

const utf8 = new TextEncoder();

/**
 * The hint's paths in Git's spelling when every one can be reasoned about,
 * otherwise null (the caller captures). A rejected path is not judged
 * dangerous, only unknown: an absolute or `..` name, an empty one, one with a
 * replacement character (the platform could not spell the bytes), anything
 * under `.git`, and any ignore-rule file, whose edit can make other paths
 * visible.
 */
export function filterablePaths(activity: WorktreeActivity): string[] | null {
  if (activity.gitMetadata || !activity.paths || activity.paths.length === 0) return null;
  const result: string[] = [];
  for (const raw of activity.paths) {
    const normalized = raw.split(path.sep).join("/").replace(/\/+$/, "");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      normalized.includes("\0") ||
      normalized.includes("�")
    )
      return null;
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
      return null;
    if (segments.includes(".git")) return null;
    if (IGNORE_RULE_FILES.has(segments[segments.length - 1]!)) return null;
    result.push(normalized);
  }
  return result;
}

interface ManifestCoverage {
  /** Every recorded path id and every directory above one. */
  readonly covered: Set<string>;
  /** Recorded path ids without a trailing slash (an untracked nested repository is `dir/`). */
  readonly recorded: Set<string>;
}

/** Built once per manifest; a manifest is immutable and replaced by each capture. */
const coverage = new WeakMap<Manifest, ManifestCoverage>();

/** The id without a trailing slash, then the ids of every directory above it. */
function idChain(id: string): { self: string; ancestors: string[] } {
  if (id.startsWith("u:")) {
    const text = id.slice(2).replace(/\/+$/, "");
    const ancestors: string[] = [];
    for (let index = text.indexOf("/"); index > 0; index = text.indexOf("/", index + 1))
      ancestors.push(`u:${text.slice(0, index)}`);
    return { self: `u:${text}`, ancestors };
  }
  let bytes = decodePath(id);
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0x2f) bytes = bytes.subarray(0, -1);
  const ancestors: string[] = [];
  for (let index = 1; index < bytes.length; index++)
    if (bytes[index] === 0x2f) ancestors.push(encodePath(bytes.subarray(0, index)));
  return { self: encodePath(bytes), ancestors };
}

function coverageOf(manifest: Manifest): ManifestCoverage {
  const cached = coverage.get(manifest);
  if (cached) return cached;
  const covered = new Set<string>();
  const recorded = new Set<string>();
  const add = (id: string) => {
    const { self, ancestors } = idChain(id);
    recorded.add(self);
    if (covered.has(self)) return;
    covered.add(self);
    for (const ancestor of ancestors) covered.add(ancestor);
  };
  for (const entry of manifest.entries) add(entry.p);
  for (const omission of manifest.omitted) add(omission.p);
  for (const id of manifest.unstable) add(id);
  const built = { covered, recorded };
  coverage.set(manifest, built);
  return built;
}

/**
 * Whether the manifest records any of the paths, anything below one, or
 * something one lies inside (a gitlink, or an untracked nested repository the
 * capture records as one directory). A capture rechecks every path its
 * previous manifest covered even once Git ignores it, so a write there can
 * move the tree.
 */
export function manifestCovers(manifest: Manifest, paths: readonly string[]): boolean {
  const { covered, recorded } = coverageOf(manifest);
  return paths.some((name) => {
    const { self, ancestors } = idChain(encodePath(utf8.encode(name)));
    return covered.has(self) || ancestors.some((ancestor) => recorded.has(ancestor));
  });
}
