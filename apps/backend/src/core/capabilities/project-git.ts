/**
 * Keeping project deliveries out of Git
 * (docs/architecture/agent-capabilities-management.md, "Shared locations and
 * isolation").
 *
 * A project setup is written into a worktree's own provider directories
 * (`.claude/skills/<name>`, ...). Those copies must never show up in
 * `git status` and must never replace anything the repository tracks:
 *
 * - every managed path, and the transient names the atomic writers use, is
 *   listed in the repository's `info/exclude` (in the Git common directory,
 *   so linked worktrees share it) inside a block owned by one environment;
 *   the tracked `.gitignore` is never edited;
 * - a path the index tracks is a collision, whether or not it is on disk.
 *
 * Git runs read-only (`rev-parse`, `ls-files`); only `info/exclude` is
 * written, atomically, and only when its content changes.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parseGraphBranchWorktreePath } from "@orkestrator/protocol/graphs/run";

import { runCommand } from "../shell.js";
import { CapabilityError, writeFileAtomically } from "./security.js";

/** Runs `git` in a directory and returns stdout; throws when Git fails. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const defaultGitRunner: GitRunner = async (cwd, args) =>
  (await runCommand("git", args, { cwd, timeoutMs: 15_000 })).stdout;

const BLOCK_START = "# >>> orkestrator capabilities ";
const BLOCK_END = "# <<< orkestrator capabilities ";

/** The Git common directory of a worktree, or null when it is not in a repository. */
export async function gitCommonDir(git: GitRunner, worktree: string): Promise<string | null> {
  try {
    const out = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
    if (!out) throw new Error("Git returned no common directory.");
    return path.resolve(worktree, out);
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    if (typeof stderr === "string" && /^fatal: not a git repository(?:[ (]|$)/m.test(stderr)) {
      return null;
    }
    throw error;
  }
}

/** Which of `paths` (worktree-relative, `/`-separated) the index tracks, or has below them. */
export async function trackedPaths(
  git: GitRunner,
  worktree: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const tracked = new Set<string>();
  if (paths.length === 0) return tracked;
  const out = await git(worktree, ["ls-files", "-z", "--full-name", "--", ...paths]);
  const files = out.split("\0").filter(Boolean);
  for (const candidate of paths) {
    if (files.some((file) => file === candidate || file.startsWith(`${candidate}/`))) {
      tracked.add(candidate);
    }
  }
  return tracked;
}

/** The anchored `info/exclude` patterns for one managed entry and its directory's transient names. */
export function excludePatterns(entries: ReadonlyArray<{ relative: string; directory: boolean }>) {
  const patterns = new Set<string>();
  for (const entry of entries) {
    patterns.add(`/${entry.relative}${entry.directory ? "/" : ""}`);
    const parent = path.posix.dirname(entry.relative);
    // Atomic writers' staging names (`.name.orkestrator-new-*`, `name.md.orkestrator-*`).
    patterns.add(`/${parent}/*.orkestrator-*`);
    if (!entry.directory) patterns.add(`/${parent}/.orkestrator-capabilities.json`);
  }
  return [...patterns].sort();
}

function blockName(owner: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(owner)) {
    throw new CapabilityError("invalid-request", "The exclude block owner is not a safe name.");
  }
  return owner;
}

/** Splits `info/exclude` into lines outside managed blocks and the blocks by owner. */
function parseExclude(text: string): { outside: string[]; blocks: Map<string, string[]> } {
  const outside: string[] = [];
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (current === null && line.startsWith(BLOCK_START) && line.endsWith(" >>>")) {
      current = line.slice(BLOCK_START.length, -" >>>".length);
      blocks.set(current, []);
      continue;
    }
    if (current !== null && line === `${BLOCK_END}${current} <<<`) {
      current = null;
      continue;
    }
    if (current !== null) blocks.get(current)!.push(line);
    else outside.push(line);
  }
  while (outside.length > 0 && outside[outside.length - 1] === "") outside.pop();
  return { outside, blocks };
}

const excludeWrites = new Map<string, Promise<unknown>>();

export function writeExcludeBlock(
  commonDir: string,
  owner: string,
  patterns: readonly string[],
  keep?: (owner: string) => boolean,
  append = false,
): Promise<boolean> {
  const previous = excludeWrites.get(commonDir) ?? Promise.resolve();
  const next = previous.then(() => updateExcludeBlock(commonDir, owner, patterns, keep, append));
  const settled = next.catch(() => undefined);
  excludeWrites.set(commonDir, settled);
  void settled.then(() => {
    if (excludeWrites.get(commonDir) === settled) excludeWrites.delete(commonDir);
  });
  return next;
}

/**
 * Replaces the block `owner` holds in `<commonDir>/info/exclude` with
 * `patterns` (none removes it), and drops the blocks of owners `keep` no
 * longer names. Lines outside managed blocks are kept as they are.
 */
async function updateExcludeBlock(
  commonDir: string,
  owner: string,
  patterns: readonly string[],
  keep: ((owner: string) => boolean) | undefined,
  append: boolean,
): Promise<boolean> {
  const name = blockName(owner);
  const infoDir = path.join(commonDir, "info");
  const file = path.join(infoDir, "exclude");
  const stat = await fs.lstat(infoDir).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new CapabilityError(
      "unsafe-content",
      "The repository's info directory is not a directory.",
    );
  }
  const before = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const { outside, blocks } = parseExclude(before);
  for (const existing of blocks.keys()) {
    if (existing !== name && keep && !keep(existing)) blocks.delete(existing);
  }
  if (patterns.length > 0) {
    blocks.set(
      name,
      [...new Set([...(append ? (blocks.get(name) ?? []) : []), ...patterns])].sort(),
    );
  } else blocks.delete(name);
  const lines = [...outside];
  for (const [blockOwner, body] of [...blocks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${BLOCK_START}${blockOwner} >>>`, ...body, `${BLOCK_END}${blockOwner} <<<`);
  }
  const after = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (after === before || (after === "" && before.trim() === "")) return false;
  await fs.mkdir(infoDir, { recursive: true });
  await writeFileAtomically(file, after);
  return true;
}

/**
 * Refuses a write whose directory passes through a link or a non-directory
 * between `root` and `relative`: a tracked `.claude -> elsewhere` link would
 * otherwise carry the write out of the worktree.
 */
export async function linkedAncestor(root: string, relative: string): Promise<string | null> {
  let current = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return path.relative(root, current).split(path.sep).join("/");
    }
  }
  return null;
}

function graphExcludePrefix(runId: string): string {
  return `graph-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}-`;
}

/** Linked worktrees share info/exclude. Give each activation its own removable block. */
export async function syncGraphWorktreeExclude(
  commonDir: string,
  relative: string,
  entries: ReadonlyArray<{ relative: string; directory: boolean }>,
): Promise<void> {
  const branch = parseGraphBranchWorktreePath(relative);
  if (!branch) return;
  const suffix = createHash("sha256").update(relative).digest("hex").slice(0, 32);
  await writeExcludeBlock(
    commonDir,
    graphExcludePrefix(branch.runId) + suffix,
    excludePatterns(entries),
    undefined,
    true,
  );
}

export async function clearGraphRunExcludes(commonDir: string, runId: string): Promise<void> {
  const prefix = graphExcludePrefix(runId);
  await writeExcludeBlock(commonDir, prefix, [], (owner) => !owner.startsWith(prefix));
}
