/**
 * Read-only access to the flake registry (`docs/tests/flaky-tests/`) and the
 * Git questions the registry tools ask about it. Nothing here writes a file.
 *
 * Git runs through `Bun.spawn` with argument arrays only; no shell strings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const REGISTRY_RELATIVE = "docs/tests/flaky-tests";
export const INDEX = "0000-index.md";
const CASE_FILE = /^\d{4}-.+\.md$/;

export const DEFAULT_REPO = path.resolve(import.meta.dir, "../..");

export interface IndexRow {
  group: string;
  id: string;
  status: string;
  test: string;
  /** The raw File column. */
  fileColumn: string;
  /** Case file name, relative to the group folder. */
  caseFile: string;
}

export interface CaseRecord {
  group: string;
  id: string;
  caseFile: string;
  /** Path relative to the repository root, `/`-separated. */
  relativePath: string;
  /** `- **Status:**` line of the case file, or `undefined` when absent. */
  status: string | undefined;
  text: string;
}

function tableCells(line: string): string[] | undefined {
  if (!line.startsWith("| ")) return undefined;
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

/** Case rows of one group index, in table order. */
export function parseIndexRows(group: string, index: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 6 || !/^\d{4}$/.test(cells[0]!)) continue;
    const link = cells.at(-1)!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({
      group,
      id: cells[0]!,
      status: cells[1]!,
      test: cells[2]!,
      fileColumn: cells[3]!,
      caseFile: link[1]!,
    });
  }
  return rows;
}

export function groupFolders(registryRoot: string): string[] {
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every case row of every group index. */
export function readIndexRows(registryRoot: string, group?: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const folder of groupFolders(registryRoot)) {
    if (group !== undefined && folder !== group) continue;
    const index = path.join(registryRoot, folder, INDEX);
    if (existsSync(index)) rows.push(...parseIndexRows(folder, readFileSync(index, "utf8")));
  }
  return rows;
}

export function caseStatus(text: string): string | undefined {
  return text.match(/^- \*\*Status:\*\* (\S+)\s*$/m)?.[1];
}

/**
 * Normalizes a case query to a matcher: `210`, `0210`, `0210-slug` and
 * `0210-slug.md` all work; a slug selects one file when a number is shared.
 */
export function caseMatcher(query: string): (fileName: string) => boolean {
  const trimmed = query.trim().replace(/\.md$/, "");
  if (/^\d{1,4}$/.test(trimmed)) {
    const id = trimmed.padStart(4, "0");
    return (fileName) => fileName.startsWith(`${id}-`);
  }
  if (/^\d{4}-/.test(trimmed)) return (fileName) => fileName === `${trimmed}.md`;
  throw new Error(`Not a case id or case file name: ${query}`);
}

/** Lists `{group, caseFile}` pairs; the source is the working tree or a Git tree. */
export type CaseSource = {
  list(): Array<{ group: string; caseFile: string }>;
  read(group: string, caseFile: string): Promise<string>;
};

export function workingTreeSource(repo: string): CaseSource {
  const registryRoot = path.join(repo, REGISTRY_RELATIVE);
  return {
    list: () =>
      groupFolders(registryRoot).flatMap((group) =>
        readdirSync(path.join(registryRoot, group))
          .filter((name) => CASE_FILE.test(name) && name !== INDEX)
          .map((caseFile) => ({ group, caseFile })),
      ),
    read: async (group, caseFile) => readFileSync(path.join(registryRoot, group, caseFile), "utf8"),
  };
}

/** Reads the registry as committed at `ref` (for example `origin/main`). */
export async function gitTreeSource(repo: string, ref: string): Promise<CaseSource> {
  const listing = await git(repo, ["ls-tree", "-r", "--name-only", ref, "--", REGISTRY_RELATIVE]);
  if (listing.code !== 0) throw new Error(`Cannot list ${REGISTRY_RELATIVE} at ${ref}`);
  const entries = listing.stdout
    .split("\n")
    .map((line) => line.slice(REGISTRY_RELATIVE.length + 1).split("/"))
    .filter((parts) => parts.length === 2 && CASE_FILE.test(parts[1]!) && parts[1] !== INDEX)
    .map(([group, caseFile]) => ({ group: group!, caseFile: caseFile! }));
  return {
    list: () => entries,
    read: async (group, caseFile) => {
      const blob = await git(repo, ["show", `${ref}:${REGISTRY_RELATIVE}/${group}/${caseFile}`]);
      if (blob.code !== 0) throw new Error(`Cannot read ${group}/${caseFile} at ${ref}`);
      return blob.stdout;
    },
  };
}

export async function findCases(source: CaseSource, query: string): Promise<CaseRecord[]> {
  const matches = caseMatcher(query);
  const entries = source
    .list()
    .filter((entry) => matches(entry.caseFile))
    .sort((a, b) => `${a.group}/${a.caseFile}`.localeCompare(`${b.group}/${b.caseFile}`));
  return Promise.all(
    entries.map(async ({ group, caseFile }) => {
      const text = await source.read(group, caseFile);
      return {
        group,
        id: caseFile.slice(0, 4),
        caseFile,
        relativePath: `${REGISTRY_RELATIVE}/${group}/${caseFile}`,
        status: caseStatus(text),
        text,
      };
    }),
  );
}

const BACKTICKED_HASH = /`([0-9a-f]{7,40})`/g;
const BARE_HASH = /(?<![0-9A-Za-z_/.-])([0-9a-f]{7,40})(?![0-9A-Za-z_])/g;

/**
 * Commit-like tokens a case file cites, in order of first appearance.
 *
 * Backticked hex of 7–40 characters always counts. A bare token must mix
 * digits and letters, so plain numbers (durations, counts) are not mistaken for
 * abbreviated hashes. Callers still verify each one against the repository.
 */
export function citedHashes(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(BACKTICKED_HASH)) found.add(match[1]!);
  for (const match of text.matchAll(BARE_HASH)) {
    const token = match[1]!;
    if (/[0-9]/.test(token) && /[a-f]/.test(token)) found.add(token);
  }
  return Array.from(found);
}

/** Text of every `Resolution` section (any heading level), where a fix commit is cited. */
export function resolutionText(text: string): string {
  const lines = text.split("\n");
  const sections: string[] = [];
  let level = 0;
  for (const line of lines) {
    const heading = line.match(/^(#+)\s+(.*)$/);
    if (heading) {
      const depth = heading[1]!.length;
      if (/^resolution\b/i.test(heading[2]!)) {
        level = depth;
        sections.push(line);
        continue;
      }
      if (level > 0 && depth <= level) level = 0;
    }
    if (level > 0) sections.push(line);
  }
  return sections.join("\n");
}

const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

/** The newest valid `YYYY-MM-DD` in the text that is not after `today`. */
export function newestDate(text: string, today: string): string | undefined {
  let newest: string | undefined;
  for (const match of text.matchAll(DATE)) {
    const [value, year, month, day] = match as unknown as [string, string, string, string];
    const date = new Date(`${value}T00:00:00Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day)
    ) {
      continue;
    }
    if (value > today) continue;
    if (newest === undefined || value > newest) newest = value;
  }
  return newest;
}

export function daysBetween(earlier: string, later: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000,
  );
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Repository paths named in an index row's File column. Cells separate paths
 * with `;`, `,`, `<br>` or "and", may wrap them in backticks and may append a
 * `:line`; prose such as "see case" is dropped.
 */
export function owningFiles(fileColumn: string): string[] {
  const files = new Set<string>();
  for (const raw of fileColumn.replace(/<br\s*\/?>/gi, ";").split(/[;,]|\s+and\s+/)) {
    const token = raw
      .trim()
      .replace(/^`|`$/g, "")
      .replace(/^and\s+/, "")
      .replace(/:\d+$/, "");
    if (/^[\w@.-]+(?:\/[\w@.[\]-]+)+\.\w+$/.test(token)) files.add(token);
  }
  return Array.from(files);
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(repo: string, args: string[], input?: string): Promise<GitResult> {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd: repo,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The full hash of `revision` when it names a commit in this repository. */
export async function resolveCommit(repo: string, revision: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function isAncestor(repo: string, ancestor: string, of: string): Promise<boolean> {
  const result = await git(repo, ["merge-base", "--is-ancestor", ancestor, of]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${of} failed: ${result.stderr.trim()}`);
}

/**
 * Resolves many abbreviated hashes with one `git cat-file --batch-check`.
 * Ambiguous or missing ones are left out.
 */
export async function resolveCommits(
  repo: string,
  hashes: readonly string[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (hashes.length === 0) return resolved;
  const result = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    hashes.map((hash) => `${hash}^{commit}`).join("\n") + "\n",
  );
  if (result.code !== 0) throw new Error(`git cat-file failed: ${result.stderr.trim()}`);
  const lines = result.stdout.split("\n");
  hashes.forEach((hash, index) => {
    const [object, type] = (lines[index] ?? "").split(" ");
    if (type === "commit" && object) resolved.set(hash, object);
  });
  return resolved;
}

/** Every commit reachable from `ref`. */
export async function reachableCommits(repo: string, ref: string): Promise<Set<string>> {
  const result = await git(repo, ["rev-list", ref]);
  if (result.code !== 0) throw new Error(`git rev-list ${ref} failed: ${result.stderr.trim()}`);
  return new Set(result.stdout.split("\n").filter(Boolean));
}

/**
 * The newest commit on `ref` that set the case file's status line to
 * `resolved`. The registry's rule is that a fix flips its case in the same
 * change, so on a squash-merged main this is the commit that landed the fix.
 * Renames between group folders are followed and do not count.
 */
export async function statusFlipCommit(
  repo: string,
  ref: string,
  relativePath: string,
): Promise<string | undefined> {
  const result = await git(repo, [
    "log",
    ref,
    "--follow",
    "-p",
    "--format=%x00%H",
    "-G",
    "^- \\*\\*Status:\\*\\* resolved",
    "--",
    relativePath,
  ]);
  if (result.code !== 0) return undefined;
  for (const chunk of result.stdout.split("\0").slice(1)) {
    const newline = chunk.indexOf("\n");
    const hash = chunk.slice(0, newline === -1 ? undefined : newline).trim();
    if (/^\+- \*\*Status:\*\* resolved\s*$/m.test(chunk)) return hash;
  }
  return undefined;
}

export interface Commit {
  hash: string;
  /** Committer date, `YYYY-MM-DD`. */
  date: string;
  files: string[];
}

/** Commits on `ref` committed on or after `since` (`YYYY-MM-DD`), with the paths each touched. */
export async function commitsSince(repo: string, ref: string, since: string): Promise<Commit[]> {
  const result = await git(repo, [
    "log",
    ref,
    `--since=${since}T00:00:00Z`,
    "--format=%x00%H %cs",
    "--name-only",
  ]);
  if (result.code !== 0) throw new Error(`git log failed: ${result.stderr.trim()}`);
  return result.stdout
    .split("\0")
    .slice(1)
    .map((chunk) => {
      const [header = "", ...files] = chunk.split("\n");
      const [hash = "", date = ""] = header.trim().split(" ");
      return { hash, date, files: files.map((file) => file.trim()).filter(Boolean) };
    });
}
