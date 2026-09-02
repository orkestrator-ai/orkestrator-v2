import {
  fsConstants,
  fs,
  os,
  path,
  inferLanguage,
  runCommand,
  MAX_BINARY_FILE_BYTES,
  validateRelativeFilePath,
  writeConfinedFile,
  INITIAL_PROMPT_STAGING_DIRECTORY,
} from "./commands-dependencies.js";
import { WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS } from "./commands-runtime-state.js";
import type { Environment, AppConfig, StorageService } from "./commands-dependencies.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  CONTAINER_GITHUB_CREDENTIAL_FILE,
  CONTAINER_CLAUDE_CREDENTIAL_FILE,
  CONTAINER_CURSOR_API_KEY_FILE,
  CONTAINER_CURSOR_CREDENTIAL_DIR,
  HOST_CLAUDE_KEYCHAIN_SERVICE,
  CONTAINER_UNTRACKED_STATS_SCANNER,
  gitFetchScheduler,
} from "./commands-runtime-state.js";
import {
  UNTRACKED_SCAN_CONCURRENCY,
  UNTRACKED_SCAN_MAX_FILES,
  FILE_LINE_COUNT_CHUNK_BYTES,
} from "./commands-validation.js";
import { quoteShell, validateGitRefName } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";

export const MAX_FILE_TREE_NODES = 5_000;

export type FileTreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  extension?: string;
};

function sortFileTreeLevel(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
  );
}

function sortFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
  for (const node of nodes) {
    if (node.children) sortFileTree(node.children);
  }
  return sortFileTreeLevel(nodes);
}

/**
 * Enumerates one container workspace without giving filenames control over the
 * record framing. The container already ships Node for the safe base64 reader,
 * so using it here also makes the production traversal directly testable
 * without a Docker daemon or host-specific GNU find extensions.
 */
export const CONTAINER_FILE_TREE_LISTER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const limit = Number(process.argv[2]);
const records = [];
let count = 0;

function visit(directory, relativeDirectory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (count >= limit) return;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const relativePath = relativeDirectory
      ? path.posix.join(relativeDirectory, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      records.push("d\t" + relativePath + "\0");
      count += 1;
      visit(path.join(directory, entry.name), relativePath);
    } else if (entry.isFile()) {
      records.push("f\t" + relativePath + "\0");
      count += 1;
    }
  }
}

if (Number.isSafeInteger(limit) && limit > 0) visit(root, "");
process.stdout.write(records.join(""));
`.trim();

const UNSAFE_CONTAINER_TREE_PATH_CHARS = /[\u0000-\u001f\u007f]/;

/** Build the shared tree shape from the bounded, NUL-framed container listing. */
export function parseContainerFileTree(output: string): FileTreeNode[] {
  if (!output) return [];
  if (!output.endsWith("\0")) {
    throw new Error("Malformed container file tree: missing NUL terminator");
  }

  const roots: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode>();

  for (const record of output.slice(0, -1).split("\0")) {
    const separator = record.indexOf("\t");
    const entryType = separator === -1 ? "" : record.slice(0, separator);
    const relativePath = separator === -1 ? "" : record.slice(separator + 1);
    if ((entryType !== "d" && entryType !== "f") || !relativePath) {
      throw new Error("Malformed container file tree entry");
    }

    // A cloned repository controls filenames. Keep paths that normalize to a
    // different target, or contain UI-spoofing control characters, out of the
    // tree without letting one such name erase every other entry.
    let validatedPath: string;
    try {
      validatedPath = validateRelativeFilePath(relativePath, "container file tree path");
    } catch {
      continue;
    }
    if (validatedPath !== relativePath || UNSAFE_CONTAINER_TREE_PATH_CHARS.test(relativePath)) {
      continue;
    }

    const parentPath = path.posix.dirname(relativePath);
    const siblings = parentPath === "." ? roots : directories.get(parentPath)?.children;
    if (!siblings) {
      throw new Error(
        `Malformed container file tree: missing parent directory for ${relativePath}`,
      );
    }

    const isDirectory = entryType === "d";
    const node: FileTreeNode = {
      name: path.posix.basename(relativePath),
      path: relativePath,
      isDirectory,
      ...(isDirectory ? { children: [] } : { extension: path.posix.extname(relativePath) }),
    };
    siblings.push(node);
    if (isDirectory) directories.set(relativePath, node);
  }

  return sortFileTree(roots);
}

/**
 * Build a bounded local file tree.
 *
 * The container equivalent already stops at 5,000 nodes. Without the shared
 * budget here, opening the files panel on a generated or dependency-heavy
 * worktree recursively read every directory and retained an unbounded response
 * object before any bytes crossed IPC.
 */
export async function buildFileTree(
  rootPath: string,
  relativePath = "",
  budget: { remaining: number } = { remaining: MAX_FILE_TREE_NODES },
): Promise<FileTreeNode[]> {
  if (budget.remaining <= 0) return [];
  const fullPath = path.join(rootPath, relativePath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    // Workspace symlinks are not valid picker targets. In addition to keeping
    // the tree inside its declared root, skipping them here prevents recursive
    // traversal if platform Dirent semantics ever change.
    if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    budget.remaining -= 1;
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRelativePath,
        isDirectory: true,
        children: await buildFileTree(rootPath, childRelativePath, budget),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: childRelativePath,
        isDirectory: false,
        extension: path.extname(entry.name),
      });
    }
  }
  return sortFileTreeLevel(nodes);
}

export type GitFileChange = {
  path: string;
  originalPath?: string;
  filename: string;
  directory: string;
  additions: number;
  deletions: number;
  status: string;
};

export function splitNulTerminatedGitFields(output: string, label: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) {
    throw new Error(`Malformed ${label}: missing NUL terminator`);
  }
  return output.slice(0, -1).split("\0");
}

export function parseGitNumstat(
  numstatOutput: string,
): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const fields = splitNulTerminatedGitFields(numstatOutput, "git numstat output");
  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : header.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab === -1) {
      throw new Error("Malformed git numstat output: invalid record header");
    }
    const additions = header.slice(0, firstTab);
    const deletions = header.slice(firstTab + 1, secondTab);
    if (
      (additions !== "-" && !/^\d+$/.test(additions)) ||
      (deletions !== "-" && !/^\d+$/.test(deletions))
    ) {
      throw new Error("Malformed git numstat output: invalid statistics");
    }
    const inlinePath = header.slice(secondTab + 1);
    let filePath = inlinePath;
    if (inlinePath.length === 0) {
      if (index + 1 >= fields.length) {
        throw new Error("Malformed git numstat output: truncated rename/copy record");
      }
      index += 1; // The preimage path is not the result path used by name-status.
      filePath = fields[index++] ?? "";
    }
    if (!filePath) {
      throw new Error("Malformed git numstat output: empty path");
    }
    stats.set(filePath, {
      additions: additions === "-" ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: deletions === "-" ? 0 : Number.parseInt(deletions, 10) || 0,
    });
  }
  return stats;
}

export function parseGitFileChanges(
  nameStatusOutput: string,
  numstatOutput: string,
): GitFileChange[] {
  const stats = parseGitNumstat(numstatOutput);
  const fields = splitNulTerminatedGitFields(nameStatusOutput, "git name-status output");
  const changes: GitFileChange[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    if (!status) throw new Error("Malformed git name-status output: empty status");
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
    const pathCount = isRenameOrCopy ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error("Malformed git name-status output: truncated record");
    }
    const originalPath = isRenameOrCopy ? fields[index++] : undefined;
    const filePath = fields[index++] ?? "";
    if (!filePath || (isRenameOrCopy && !originalPath)) {
      throw new Error("Malformed git name-status output: empty path");
    }
    const fileStats = stats.get(filePath) ?? { additions: 0, deletions: 0 };
    changes.push({
      path: filePath,
      originalPath,
      filename: path.basename(filePath),
      directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      status,
    });
  }
  return changes;
}

export function decodeGitStatusSection(payload: string, label: string): string {
  // Whitespace is stripped before validating because it is never part of a base64
  // payload, but base64 implementations disagree about emitting it: GNU coreutils
  // with -w0 emits none, macOS appends a trailing newline, and an implementation
  // that ignores -w0 wraps at 76 columns. Tolerating all three keeps the framing
  // strict about content while not depending on the container's exact coreutils.
  const encoded = payload.replace(/\s+/g, "");
  if (encoded.length === 0) return "";
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error(`Malformed ${label}: invalid base64`);
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

export function parseContainerUntrackedStats(output: string): GitFileChange[] {
  const fields = splitNulTerminatedGitFields(output, "container untracked stats");
  return fields.map((field) => {
    const separator = field.indexOf("\t");
    if (separator <= 0) {
      throw new Error("Malformed container untracked stats record");
    }
    const additionsText = field.slice(0, separator);
    const filePath = field.slice(separator + 1);
    if (!/^\d+$/.test(additionsText) || !filePath) {
      throw new Error("Malformed container untracked stats record");
    }
    return {
      path: filePath,
      originalPath: undefined,
      filename: path.basename(filePath),
      directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
      additions: Number.parseInt(additionsText, 10),
      deletions: 0,
      status: "?",
    };
  });
}

// Section markers are framed with ASCII record/unit separators, which git never
// emits inside a path, so a filename can never be mistaken for a frame. They are
// built from char codes rather than written literally: raw control bytes in source
// are invisible in diffs and editors, and a marker that silently loses its frame
// still "looks" correct while failing every response.
export const GIT_STATUS_FRAME_START = String.fromCharCode(0x1e);
export const GIT_STATUS_FRAME_END = String.fromCharCode(0x1f);
export function gitStatusMarker(name: string): string {
  return `${GIT_STATUS_FRAME_START}${name}${GIT_STATUS_FRAME_END}`;
}
export const GIT_STATUS_NAME_STATUS_MARKER = gitStatusMarker("ORKESTRATOR_NAME_STATUS");
export const GIT_STATUS_NUMSTAT_MARKER = gitStatusMarker("ORKESTRATOR_NUMSTAT");
export const GIT_STATUS_UNTRACKED_MARKER = gitStatusMarker("ORKESTRATOR_UNTRACKED");
export const GIT_STATUS_END_MARKER = gitStatusMarker("ORKESTRATOR_END");
export const GIT_STATUS_MISSING_REF_MARKER = gitStatusMarker("ORKESTRATOR_TARGET_REF_NOT_FOUND");

/**
 * Builds the single shell program that collects a container's git status.
 *
 * Everything is framed so a partial or reordered response is detectable, and the
 * three git payloads are base64'd because they are NUL-delimited and may contain
 * any byte a filename can.
 */
export function buildContainerGitStatusScript(ref: string, includeWorkingTree: boolean): string {
  const branch = quoteShell(ref);
  const untrackedScanner = `node -e ${quoteShell(CONTAINER_UNTRACKED_STATS_SCANNER)} -- ${MAX_BINARY_FILE_BYTES} ${UNTRACKED_SCAN_MAX_FILES}`;
  return `
      set -e -o pipefail
      # A bare 'exit 0' here would come back as exit 1: this runs under 'bash -l',
      # whose ~/.bash_logout calls 'clear_console -q', and that fails with no
      # console attached. Under 'set -e' the failing logout hook replaces the
      # explicit status, so drop errexit before exiting deliberately.
      if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        set +e
        exit 0
      fi
      # Excluding Orkestrator's own artifacts is housekeeping, not part of reading
      # status. Running it inside a function invoked with '|| true' keeps a
      # read-only or unwritable .git from failing the whole request under 'set -e'.
      maintain_git_exclude() {
        exclude_path="$(git rev-parse --git-path info/exclude 2>/dev/null || true)"
        [ -n "$exclude_path" ] || return 0
        case "$exclude_path" in
          /*) exclude_file="$exclude_path" ;;
          *) exclude_file="$(pwd)/$exclude_path" ;;
        esac
        mkdir -p "$(dirname "$exclude_file")" || return 0
        for pattern in ".orkestrator" ".claude/settings.local.json"; do
          if ! grep -qxF "$pattern" "$exclude_file" 2>/dev/null; then
            if [ -s "$exclude_file" ] && [ "$(tail -c 1 "$exclude_file" 2>/dev/null)" != "" ]; then
              printf '\\n' >> "$exclude_file" || return 0
            fi
            printf '%s\\n' "$pattern" >> "$exclude_file" || return 0
          fi
        done
      }
      maintain_git_exclude || true
      ref=${branch}
      git fetch origin "$ref" >/dev/null 2>&1 || true
      if git rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
        base="origin/$ref"
      else
        base="$ref"
      fi
      # Reported on stdout as a framed marker rather than as a non-zero exit: the
      # exec error message echoes the command back, so a literal marker in the
      # script text would match failures that had nothing to do with the ref.
      if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
        printf '\\036ORKESTRATOR_TARGET_REF_NOT_FOUND\\037'
        set +e
        exit 0
      fi
      end_ref=${includeWorkingTree ? "" : "HEAD"}
      printf '\\036ORKESTRATOR_NAME_STATUS\\037'
      git diff --name-status -z -M "$base" $end_ref | base64 -w0
      printf '\\036ORKESTRATOR_NUMSTAT\\037'
      git diff --numstat -z -M "$base" $end_ref | base64 -w0
      printf '\\036ORKESTRATOR_UNTRACKED\\037'
      ${includeWorkingTree ? `git status --porcelain=v1 -z --untracked-files=all | ${untrackedScanner} | base64 -w0` : ""}
      printf '\\036ORKESTRATOR_END\\037'
    `;
}

export function isMissingTargetRefResponse(output: string): boolean {
  return output === GIT_STATUS_MISSING_REF_MARKER;
}

export function parseContainerGitStatusResponse(
  output: string,
  includeWorkingTree: boolean,
): GitFileChange[] {
  return parseContainerGitStatusResponseDetailed(output, includeWorkingTree).changes;
}

export function parseContainerGitStatusResponseDetailed(
  output: string,
  includeWorkingTree: boolean,
): { changes: GitFileChange[]; truncated: boolean } {
  // A workspace that is not a git repository exits before emitting any frame.
  if (output.length === 0) return { changes: [], truncated: false };
  const nameStatusStart = output.indexOf(GIT_STATUS_NAME_STATUS_MARKER);
  const numstatStart = output.indexOf(GIT_STATUS_NUMSTAT_MARKER);
  const untrackedStart = output.indexOf(GIT_STATUS_UNTRACKED_MARKER);
  const endStart = output.indexOf(GIT_STATUS_END_MARKER);
  if (
    nameStatusStart !== 0 ||
    numstatStart < nameStatusStart ||
    untrackedStart < numstatStart ||
    endStart < untrackedStart ||
    endStart + GIT_STATUS_END_MARKER.length !== output.length
  ) {
    throw new Error("Malformed container git status response");
  }

  const nameStatusOutput = decodeGitStatusSection(
    output.slice(nameStatusStart + GIT_STATUS_NAME_STATUS_MARKER.length, numstatStart),
    "container git name-status section",
  );
  const numstatOutput = decodeGitStatusSection(
    output.slice(numstatStart + GIT_STATUS_NUMSTAT_MARKER.length, untrackedStart),
    "container git numstat section",
  );
  const changes = parseGitFileChanges(nameStatusOutput, numstatOutput);
  if (!includeWorkingTree) return { changes, truncated: false };

  const existingPaths = new Set(changes.map((change) => change.path));
  const untrackedOutput = decodeGitStatusSection(
    output.slice(untrackedStart + GIT_STATUS_UNTRACKED_MARKER.length, endStart),
    "container untracked section",
  );
  const untracked = parseContainerUntrackedStats(untrackedOutput);
  for (const change of untracked) {
    if (!existingPaths.has(change.path)) changes.push(change);
  }
  // The scanner stops opening files past the same cap the host applies locally,
  // so the record count is what says whether any went uncounted.
  return { changes, truncated: untracked.length > UNTRACKED_SCAN_MAX_FILES };
}

export async function getLocalGitStatus(
  worktreePath: string,
  targetBranch: string,
  includeUncommitted: boolean,
): Promise<GitFileChange[]> {
  return (await getLocalGitStatusDetailed(worktreePath, targetBranch, includeUncommitted)).changes;
}

/** Reads a container workspace's changes, reporting whether the scan was capped. */
export async function getContainerGitStatusDetailed(
  containerId: string,
  targetBranch: string,
  includeWorkingTree: boolean,
): Promise<{ changes: GitFileChange[]; truncated: boolean }> {
  const ref = validateGitRefName(targetBranch, "target branch");
  const output = await dockerExec(
    containerId,
    buildContainerGitStatusScript(ref, includeWorkingTree),
  );
  // Distinguishes "the requested baseline is not in this container" - which
  // happens when a container is recreated from a different clone - from a
  // corrupt response, so callers do not see both as one opaque exec failure.
  if (isMissingTargetRefResponse(output)) {
    throw new Error(`Target ref is not present in the container: ${ref}`);
  }
  return parseContainerGitStatusResponseDetailed(output, includeWorkingTree);
}

/**
 * Reads a worktree's changes, reporting whether the untracked scan was capped.
 *
 * The three git reads are independent of each other, so they run together: the
 * status read used to wait for both diffs to finish before starting, which cost
 * a whole round of process spawn and git startup for nothing.
 */
export async function getLocalGitStatusDetailed(
  worktreePath: string,
  targetBranch: string,
  includeUncommitted: boolean,
): Promise<{ changes: GitFileChange[]; truncated: boolean }> {
  validateGitRefName(targetBranch, "target branch");
  await addLocalWorkspaceArtifactsToGitExclude(worktreePath);

  const base = await resolveLocalGitBase(worktreePath, targetBranch);
  const endRef = includeUncommitted ? [] : ["HEAD"];
  const [nameStatus, numstat, porcelain] = await Promise.all([
    runCommand("git", ["-C", worktreePath, "diff", "--name-status", "-z", "-M", base, ...endRef], {
      timeoutMs: 60_000,
    }),
    runCommand("git", ["-C", worktreePath, "diff", "--numstat", "-z", "-M", base, ...endRef], {
      timeoutMs: 60_000,
    }),
    includeUncommitted
      ? runCommand(
          "git",
          ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { timeoutMs: 60_000 },
        )
      : Promise.resolve({ stdout: "" }),
  ]);

  const changes = parseGitFileChanges(nameStatus.stdout, numstat.stdout);
  if (!includeUncommitted) return { changes, truncated: false };

  const existingPaths = new Set(changes.map((change) => change.path));
  const untrackedPaths: string[] = [];
  for (const line of porcelain.stdout.split("\0").filter(Boolean)) {
    if (!line.startsWith("?? ")) continue;
    const filePath = line.slice(3);
    if (existingPaths.has(filePath)) continue;
    untrackedPaths.push(filePath);
  }

  // A worktree can hold more untracked files than are worth opening on every
  // change signal. The cap is reported rather than applied silently, so a
  // truncated count never reads as an exact one.
  const truncated = untrackedPaths.length > UNTRACKED_SCAN_MAX_FILES;
  const scanned = truncated ? untrackedPaths.slice(0, UNTRACKED_SCAN_MAX_FILES) : untrackedPaths;

  // Counting lines is one open + a streamed read per file, so a worktree with a
  // few thousand untracked files spends nearly all of its time waiting on the
  // disk. Running a bounded window concurrently keeps that wait overlapped
  // without letting a large worktree exhaust the process file descriptors.
  const additionsPerPath = await mapWithConcurrency(
    scanned,
    UNTRACKED_SCAN_CONCURRENCY,
    (filePath) => countLocalFileLines(worktreePath, filePath).catch(() => 0),
  );

  untrackedPaths.forEach((filePath, index) => {
    changes.push({
      path: filePath,
      originalPath: undefined,
      filename: path.basename(filePath),
      directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
      // Files past the cap are still listed - the user must be able to see them
      // in the Files panel - they just carry no line count.
      additions: additionsPerPath[index] ?? 0,
      deletions: 0,
      status: "?",
    });
  });

  return { changes, truncated };
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * Workers pull from a shared cursor rather than being sliced into fixed batches,
 * so one slow file cannot idle the rest of the window behind it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Counts the lines in an untracked file without materialising it.
 *
 * Reading the whole file and splitting it allocated three copies of every
 * untracked file on each poll - the buffer, the decoded string, and an array
 * holding every line - for a number that only needs a running separator count.
 * The chunked walk below is the same algorithm the container scanner uses
 * (CONTAINER_UNTRACKED_STATS_SCANNER), so both environment types report
 * identical counts for identical content.
 */
export async function countLocalFileLines(rootPath: string, relativePath: string): Promise<number> {
  const target = validateRelativeFilePath(relativePath, "git status path");
  const fullPath = path.join(rootPath, target);

  // O_NOFOLLOW, and a stat of the descriptor rather than the path, so an
  // untracked symlink cannot be followed out of the worktree and the file that
  // gets measured is provably the one that passed the size check.
  const handle = await fs.open(
    fullPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BINARY_FILE_BYTES) return 0;

    const buffer = Buffer.allocUnsafe(FILE_LINE_COUNT_CHUNK_BYTES);
    let total = 0;
    let separators = 0;
    let previousWasCarriageReturn = false;
    let lastByte = -1;

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // The file can grow between the stat and the read; stop rather than let an
      // actively-written log turn one poll into an unbounded scan.
      if (total > MAX_BINARY_FILE_BYTES) return 0;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index]!;
        if (byte === 0) return 0;
        if (byte === 0x0d) {
          separators += 1;
          previousWasCarriageReturn = true;
        } else if (byte === 0x0a) {
          if (!previousWasCarriageReturn) separators += 1;
          previousWasCarriageReturn = false;
        } else {
          previousWasCarriageReturn = false;
        }
        lastByte = byte;
      }
    }

    return separators + (lastByte !== 0x0d && lastByte !== 0x0a ? 1 : 0);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function gitRefExists(worktreePath: string, refName: string): Promise<boolean> {
  return runCommand(
    "git",
    ["-C", worktreePath, "rev-parse", "--verify", "--quiet", `${refName}^{commit}`],
    { timeoutMs: 10_000 },
  ).then(
    () => true,
    () => false,
  );
}

export async function resolveRemoteWorktreeStartPoint(
  projectPath: string,
  baseBranch: string,
): Promise<string> {
  const branch = validateGitRefName(baseBranch, "base branch");
  await runCommand("git", ["-C", projectPath, "fetch", "origin", branch], { timeoutMs: 120_000 });

  const remoteRef = `origin/${branch}`;
  if (!(await gitRefExists(projectPath, remoteRef))) {
    throw new Error(`Remote base branch not found: ${remoteRef}`);
  }
  return remoteRef;
}

/**
 * True for a full commit SHA, which names the same commit forever.
 *
 * Environments created from a recorded commit pass that SHA as their baseline.
 * Fetching before resolving it cannot change the answer - the commit is already
 * in the worktree it was created from - so the network round trip on every diff
 * poll is pure cost.
 */
export function isImmutableCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref.trim());
}

export async function resolveLocalGitBase(
  worktreePath: string,
  targetBranch: string,
): Promise<string> {
  const branch = validateGitRefName(targetBranch, "target branch");

  if (isImmutableCommitRef(branch) && (await gitRefExists(worktreePath, branch))) {
    return branch;
  }

  // Rate limited and shared across every worktree of this repository, rather
  // than a network round trip per read per environment.
  await gitFetchScheduler.ensureFetched(worktreePath, branch);

  const remoteRef = `origin/${branch}`;
  if (await gitRefExists(worktreePath, remoteRef)) return remoteRef;
  if (await gitRefExists(worktreePath, branch)) return branch;
  return remoteRef;
}

/**
 * Turns on git's own caches for a worktree.
 *
 * `git status` is dominated by walking and stat'ing the tree. The untracked
 * cache remembers which directories had no untracked files and skips re-reading
 * them, and fsmonitor lets git ask the OS what changed instead of asking the
 * filesystem about everything. Both are one-time settings that speed up every
 * git call the application makes against this worktree, not only diff stats.
 *
 * Best effort by design: an old git rejects the fsmonitor value, and a
 * repository on a filesystem that cannot support the daemon must still work.
 */
export async function enableGitScanCaches(worktreePath: string): Promise<void> {
  // Scoped to this worktree with `--worktree`, never to the shared config. These
  // worktrees hang off a clone the user also drives by hand, and turning on a
  // background fsmonitor daemon for their own repository is not this
  // application's decision to make. `extensions.worktreeConfig` is the one
  // shared write, and it only enables per-worktree config - it changes no
  // behaviour on its own.
  const enabled = await runCommand(
    "git",
    ["-C", worktreePath, "config", "extensions.worktreeConfig", "true"],
    { timeoutMs: 10_000 },
  ).then(
    () => true,
    () => false,
  );
  // Without per-worktree scoping the only way to set these would be to write the
  // shared config, so stop rather than reach outside the worktree.
  if (!enabled) return;

  for (const [key, value] of [
    ["core.untrackedCache", "true"],
    ["core.fsmonitor", "true"],
  ] as const) {
    await runCommand("git", ["-C", worktreePath, "config", "--worktree", key, value], {
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }
}

export function validateWorkspaceMutationPath(relativePath: string, label = "filePath"): string {
  const target = validateRelativeFilePath(relativePath, label);
  if (target === ".git" || target.startsWith(".git/")) {
    throw new Error(`Invalid ${label}: Git metadata cannot be modified`);
  }
  return target;
}

export async function assertNoLocalSymlinkAncestors(
  worktreePath: string,
  target: string,
): Promise<void> {
  const root = await fs.realpath(worktreePath);
  let current = root;
  const ancestors = target.split("/").slice(0, -1);

  for (const segment of ancestors) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Invalid filePath: symlink ancestor is not allowed: ${target}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Invalid filePath: ancestor is not a directory: ${target}`);
    }
  }
}

/** Batch directories kept under `.orkestrator/initial-prompt`, newest first. */
export const INITIAL_PROMPT_BATCH_RETENTION = 10;
export const INITIAL_PROMPT_PRUNE_BODY = String.raw`
const batches = fs.readdirSync(".", { withFileTypes: true }).flatMap(entry => {
  if (!entry.isDirectory()) return [];
  const stat = fs.lstatSync(entry.name);
  return stat.isDirectory() && !stat.isSymbolicLink() ? [{ name: entry.name, mtimeMs: stat.mtimeMs }] : [];
});
batches.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
for (const stale of batches.slice(Number(keep))) fs.rmSync(stale.name, { recursive: true, force: true });
`;
export const PINNED_INITIAL_PROMPT_PRUNE = String.raw`
const fs = require("node:fs");
const [expectedDev, expectedIno, keep] = process.argv.slice(1);
const cwd = fs.statSync(".");
if (String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) process.exit(73);
${INITIAL_PROMPT_PRUNE_BODY}`;

/**
 * Drops every initial-prompt batch beyond the newest {@link
 * INITIAL_PROMPT_BATCH_RETENTION}, minus the one about to be created.
 *
 * Each batch owns an unpredictable directory, so a successful write leaves it
 * behind forever - and `docker/workspace-setup.sh` deliberately preserves the
 * directory across re-setup. The traversal follows the same confinement rules
 * as the writer: a symlinked ancestor or entry is skipped, never followed.
 */
export async function pruneLocalInitialPromptBatches(worktreePath: string): Promise<void> {
  let directory = await fs.realpath(worktreePath);
  for (const segment of INITIAL_PROMPT_STAGING_DIRECTORY.split("/")) {
    directory = path.join(directory, segment);
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  }

  const expected = await fs.lstat(directory);
  await runCommand(
    process.execPath,
    [
      "-e",
      PINNED_INITIAL_PROMPT_PRUNE,
      String(expected.dev),
      String(expected.ino),
      String(INITIAL_PROMPT_BATCH_RETENTION - 1),
    ],
    { cwd: directory, timeoutMs: 30_000 },
  );
}

/** The container-side equivalent of {@link pruneLocalInitialPromptBatches}. */
export function containerPruneInitialPromptBatchesCommand(): string {
  const script = String.raw`
const fs = require("node:fs"), path = require("node:path");
let current = "/workspace";
for (const segment of ${JSON.stringify(INITIAL_PROMPT_STAGING_DIRECTORY.split("/"))}) {
  if (current === "/workspace") process.chdir(current);
  let stat; try { stat = fs.lstatSync(segment); } catch { process.exit(0); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(0);
  process.chdir(segment);
  const pinnedSegment = fs.statSync(".");
  if (pinnedSegment.dev !== stat.dev || pinnedSegment.ino !== stat.ino) process.exit(73);
  current = path.join(current, segment);
}
const keep = ${INITIAL_PROMPT_BATCH_RETENTION - 1};
${INITIAL_PROMPT_PRUNE_BODY}`;
  return `node -e ${quoteShell(script)}`;
}

export const CONTAINER_PINNED_ATTACHMENT_WRITE = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const [workspaceRoot, relativeDirectory, filename, expectedBytes, readyToken, writeMode, fileMode] = process.argv.slice(1);
let current = workspaceRoot;
const root = fs.lstatSync(current);
if (root.isSymbolicLink() || !root.isDirectory()) process.exit(73);
process.chdir(current);
const pinnedRoot = fs.statSync(".");
if (pinnedRoot.dev !== root.dev || pinnedRoot.ino !== root.ino) process.exit(73);
for (const segment of relativeDirectory.split("/")) {
  try {
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(73);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    try { fs.mkdirSync(segment, { mode: 0o700 }); }
    catch (mkdirError) { if (!mkdirError || mkdirError.code !== "EEXIST") throw mkdirError; }
  }
  const expected = fs.lstatSync(segment);
  process.chdir(segment);
  const pinned = fs.statSync(".");
  if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) process.exit(73);
}
if (readyToken) process.stdout.write(readyToken + "\n");
const chunks = []; let encodedBytes = 0;
process.stdin.on("data", chunk => { encodedBytes += chunk.length; if (encodedBytes > Number(expectedBytes) * 2 + 16) process.exit(74); chunks.push(chunk); });
process.stdin.on("end", () => {
  const content = Buffer.from(Buffer.concat(chunks).toString("ascii"), "base64");
  if (content.length !== Number(expectedBytes)) process.exit(74);
  const temp = "." + filename + "." + crypto.randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, content); if (fileMode) fs.fchmodSync(fd, Number(fileMode)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (writeMode === "overwrite") fs.renameSync(temp, filename);
    else { fs.linkSync(temp, filename); fs.unlinkSync(temp); }
    const published = fs.lstatSync(filename);
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== identity.dev || published.ino !== identity.ino) process.exit(75);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    process.stderr.write(error && error.code || "WRITE_FAILED"); process.exit(76);
  }
});
`;

export const CONTAINER_PINNED_ATTACHMENT_REMOVE = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [workspaceRoot, relativeDirectory, readyToken] = process.argv.slice(1);
const segments = relativeDirectory.split("/"), batch = segments.pop();
let current = workspaceRoot;
const root = fs.lstatSync(current);
if (root.isSymbolicLink() || !root.isDirectory()) process.exit(0);
process.chdir(current);
const pinnedRoot = fs.statSync(".");
if (pinnedRoot.dev !== root.dev || pinnedRoot.ino !== root.ino) process.exit(0);
for (const segment of segments) {
  let stat; try { stat = fs.lstatSync(segment); } catch { process.exit(0); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(0);
  process.chdir(segment);
  const pinned = fs.statSync(".");
  if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) process.exit(0);
}
let target; try { target = fs.lstatSync(batch); } catch { process.exit(0); }
if (!target.isDirectory() || target.isSymbolicLink()) process.exit(0);
const remove = () => fs.rmSync(batch, { recursive: true, force: true });
if (readyToken) {
  process.stdout.write(readyToken + "\n");
  process.stdin.resume();
  process.stdin.on("end", remove);
} else remove();
`;

export function containerRemoveInitialPromptBatchCommand(relativeDirectory: string): string {
  const safeDirectory = validateRelativeFilePath(relativeDirectory, "attachment directory");
  return `node -e ${quoteShell(CONTAINER_PINNED_ATTACHMENT_REMOVE)} -- /workspace ${quoteShell(safeDirectory)}`;
}

/**
 * Writes one command-owned workspace artifact without following a repository
 * symlink. Attachment batches use an unpredictable, newly-created directory,
 * and the final file is opened with O_EXCL + O_NOFOLLOW.
 */
export function writeConfinedLocalArtifact(
  worktreePath: string,
  relativePath: string,
  payload: string | Buffer,
): Promise<string> {
  return writeConfinedFile(worktreePath, relativePath, payload, { exclusive: true });
}

export async function removeLocalWorkspacePath(
  worktreePath: string,
  target: string,
): Promise<void> {
  await assertNoLocalSymlinkAncestors(worktreePath, target);
  await runCommand("git", ["-C", worktreePath, "rm", "-f", "--ignore-unmatch", "--", target], {
    timeoutMs: 30_000,
  });
  // Git clean understands worktree boundaries and does not traverse a symlinked
  // parent. It handles the untracked/ignored case left behind by git rm.
  await runCommand("git", ["-C", worktreePath, "clean", "-f", "-x", "--", target], {
    timeoutMs: 30_000,
  });
}

export async function gitPathExistsAtRef(
  worktreePath: string,
  refName: string,
  target: string,
): Promise<boolean> {
  const { stdout } = await runCommand(
    "git",
    ["-C", worktreePath, "ls-tree", "-z", "--name-only", refName, "--", target],
    { timeoutMs: 10_000 },
  );
  return stdout.split("\0").includes(target);
}

export async function findLocalRenamePair(
  worktreePath: string,
  base: string,
  target: string,
): Promise<{ source: string; destination: string } | null> {
  const { stdout } = await runCommand(
    "git",
    ["-C", worktreePath, "diff", "--name-status", "-z", "-M", base],
    { timeoutMs: 60_000 },
  );
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = fields[index++] ?? "";
      const destination = fields[index++] ?? "";
      if (status.startsWith("R") && (source === target || destination === target)) {
        return { source, destination };
      }
    } else {
      index += 1;
    }
  }
  return null;
}

export async function restoreLocalPathFromBase(
  worktreePath: string,
  base: string,
  target: string,
): Promise<void> {
  await assertNoLocalSymlinkAncestors(worktreePath, target);
  if (await gitPathExistsAtRef(worktreePath, base, target)) {
    await runCommand(
      "git",
      ["-C", worktreePath, "restore", `--source=${base}`, "--staged", "--worktree", "--", target],
      { timeoutMs: 30_000 },
    );
  } else {
    await removeLocalWorkspacePath(worktreePath, target);
  }
}

export async function revertLocalFile(
  worktreePath: string,
  relativePath: string,
  targetBranch: string,
): Promise<string> {
  const target = validateWorkspaceMutationPath(relativePath);
  const base = await resolveLocalGitBase(worktreePath, targetBranch);
  if (!(await gitRefExists(worktreePath, base))) {
    throw new Error(`Target ref not found: ${targetBranch}`);
  }
  const rename = await findLocalRenamePair(worktreePath, base, target);
  if (rename) {
    const source = validateWorkspaceMutationPath(rename.source);
    const destination = validateWorkspaceMutationPath(rename.destination);
    // Preflight both endpoints before changing either one so a rejected
    // destination cannot leave a half-reverted rename behind.
    await assertNoLocalSymlinkAncestors(worktreePath, source);
    await assertNoLocalSymlinkAncestors(worktreePath, destination);
    await restoreLocalPathFromBase(worktreePath, base, source);
    await restoreLocalPathFromBase(worktreePath, base, destination);
  } else {
    await restoreLocalPathFromBase(worktreePath, base, target);
  }

  return target;
}

export async function deleteLocalFile(worktreePath: string, relativePath: string): Promise<string> {
  const target = validateWorkspaceMutationPath(relativePath);
  await removeLocalWorkspacePath(worktreePath, target);
  return target;
}

export async function requireLocalMutationEnvironment(
  storage: StorageService,
  environmentId: string,
): Promise<Environment> {
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  if (environment.environmentType !== "local" || !environment.worktreePath) {
    throw new Error(`Environment is not a local worktree: ${environmentId}`);
  }
  return environment;
}

export async function requireContainerMutationEnvironment(
  storage: StorageService,
  environmentId: string,
): Promise<Environment> {
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  if (environment.environmentType === "local" || !environment.containerId) {
    throw new Error(`Environment is not containerized: ${environmentId}`);
  }
  return environment;
}

export const CONTAINER_SAFE_MUTATION_FUNCTIONS = [
  "assert_safe_path() {",
  '  local candidate="$1"',
  '  case "$candidate" in .git|.git/*) echo "Git metadata cannot be modified" >&2; return 1 ;; esac',
  "  local current=/workspace",
  "  local -a parts=()",
  "  local index",
  '  IFS=/ read -r -a parts <<< "$candidate"',
  "  for ((index = 0; index < ${#parts[@]} - 1; index++)); do",
  '    current="$current/${parts[$index]}"',
  '    if [ -L "$current" ]; then',
  '      echo "Symlink ancestor is not allowed: $candidate" >&2',
  "      return 1",
  "    fi",
  '    if [ -e "$current" ] && [ ! -d "$current" ]; then',
  '      echo "Path ancestor is not a directory: $candidate" >&2',
  "      return 1",
  "    fi",
  "  done",
  "}",
  "remove_path() {",
  '  local candidate="$1"',
  '  assert_safe_path "$candidate" || return 1',
  '  git rm -f --ignore-unmatch -- "$candidate"',
  '  git clean -f -x -- "$candidate"',
  "}",
].join("\n");

export function containerRevertFileCommand(target: string, branch: string): string {
  return `
    set -euo pipefail
    cd /workspace
    branch=${quoteShell(branch)}
    target=${quoteShell(target)}
    ${CONTAINER_SAFE_MUTATION_FUNCTIONS}
    git fetch origin "$branch" >/dev/null 2>&1 || true
    if git rev-parse --verify --quiet "origin/$branch^{commit}" >/dev/null; then
      base="origin/$branch"
    elif git rev-parse --verify --quiet "$branch^{commit}" >/dev/null; then
      base="$branch"
    else
      echo "Target ref not found: $branch" >&2
      exit 1
    fi

    diff_file=$(mktemp)
    tree_file=$(mktemp)
    trap 'rm -f "$diff_file" "$tree_file"' EXIT
    if ! git diff --name-status -z -M "$base" > "$diff_file"; then
      exit 1
    fi

    source_path=""
    destination_path=""
    while IFS= read -r -d '' status; do
      case "$status" in
        R*|C*)
          IFS= read -r -d '' old_path || exit 1
          IFS= read -r -d '' new_path || exit 1
          if [[ "$status" == R* ]] && { [ "$old_path" = "$target" ] || [ "$new_path" = "$target" ]; }; then
            source_path="$old_path"
            destination_path="$new_path"
            break
          fi
          ;;
        *)
          IFS= read -r -d '' changed_path || exit 1
          ;;
      esac
    done < "$diff_file"

    restore_path() {
      local candidate="$1"
      local found=0
      assert_safe_path "$candidate" || return 1
      if ! git ls-tree -z --name-only "$base" -- "$candidate" > "$tree_file"; then
        return 1
      fi
      while IFS= read -r -d '' base_path; do
        if [ "$base_path" = "$candidate" ]; then
          found=1
          break
        fi
      done < "$tree_file"
      if [ "$found" -eq 1 ]; then
        git restore --source="$base" --staged --worktree -- "$candidate"
      else
        remove_path "$candidate"
      fi
    }

    if [ -n "$source_path" ]; then
      assert_safe_path "$source_path"
      assert_safe_path "$destination_path"
      restore_path "$source_path"
      restore_path "$destination_path"
    else
      restore_path "$target"
    fi
  `;
}

export function containerDeleteFileCommand(target: string): string {
  return `
    set -euo pipefail
    cd /workspace
    target=${quoteShell(target)}
    ${CONTAINER_SAFE_MUTATION_FUNCTIONS}
    remove_path "$target"
  `;
}

export function isGitShowMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("exists on disk, but not in") ||
    message.includes("does not exist in") ||
    (message.includes("Path ") && message.includes(" does not exist"))
  );
}

export async function readLocalFileAtBranch(
  worktreePath: string,
  filePath: string,
  branch: string,
): Promise<{ path: string; content: string; language: string } | null> {
  const target = validateRelativeFilePath(filePath, "filePath");
  const base = await resolveLocalGitBase(worktreePath, branch);
  try {
    const { stdout } = await runCommand("git", ["-C", worktreePath, "show", `${base}:${target}`], {
      timeoutMs: 30_000,
    });
    return { path: target, content: stdout, language: inferLanguage(target) };
  } catch (error) {
    if (isGitShowMissingPathError(error)) return null;
    throw error;
  }
}

export function buildSyncContainerGitHubCredentialCommand(
  credentialFile = CONTAINER_GITHUB_CREDENTIAL_FILE,
): string {
  return `
  set -e
  credential_file=${quoteShell(credentialFile)}
  credential_dir="$(dirname "$credential_file")"
  umask 077
  mkdir -p "$credential_dir"
  credential_tmp="$(mktemp "$credential_dir/.github-token.XXXXXX")"
  trap 'rm -f "$credential_tmp"' EXIT
  cat > "$credential_tmp"
  chmod 600 "$credential_tmp"
  mv -f "$credential_tmp" "$credential_file"
  credential_tmp=
  trap - EXIT

  git config --global --list 2>/dev/null |
    grep '^url\\.https://x-access-token:' |
    sed 's/\\.insteadof=.*//' |
    sort -u |
    while read -r section; do
      git config --global --remove-section "$section" 2>/dev/null || true
    done

  token="$(cat "$credential_file")"
  if [ -n "$token" ]; then
    token_url="https://x-access-token:$token@github.com/"
    git config --global --replace-all "url.$token_url.insteadOf" "https://github.com/"
    git config --global --add "url.$token_url.insteadOf" "https://github.com"
    git config --global --add "url.$token_url.insteadOf" "git@github.com:"
  fi
  unset token token_url
`;
}

export const SYNC_CONTAINER_GITHUB_CREDENTIAL_COMMAND = buildSyncContainerGitHubCredentialCommand();

export async function getHostGitHubToken(): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand("gh", ["auth", "token", "--hostname", "github.com"], {
      timeoutMs: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveContainerGitHubToken(
  globalConfig: AppConfig["global"],
): Promise<string | undefined> {
  if (globalConfig.useHostGitHubCredentials !== false) {
    return getHostGitHubToken();
  }
  return globalConfig.githubToken?.trim() || undefined;
}

export async function getContainerGitHubCredentialStatus(
  globalConfig: AppConfig["global"],
): Promise<{ source: "host-cli" | "pat"; available: boolean }> {
  if (globalConfig.useHostGitHubCredentials !== false) {
    return {
      source: "host-cli",
      available: Boolean(await getHostGitHubToken()),
    };
  }
  return {
    source: "pat",
    available: Boolean(globalConfig.githubToken?.trim()),
  };
}

export async function syncContainerGitHubCredential(
  containerId: string,
  token: string | undefined,
): Promise<void> {
  await runCommand(
    "docker",
    ["exec", "-i", containerId, "bash", "-lc", SYNC_CONTAINER_GITHUB_CREDENTIAL_COMMAND],
    {
      stdin: token ?? "",
      timeoutMs: 30_000,
      redactValues: [token],
    },
  );
}

/**
 * Materializes the host's Claude Code OAuth credential inside a container.
 *
 * Unlike Codex, whose token lives in `~/.codex/auth.json` and therefore rides
 * the read-only `/codex-home` mount straight into the container, Claude Code on
 * macOS keeps its credential in the login Keychain. Nothing under `~/.claude` is
 * copied by the entrypoint because nothing is there, which is why a container
 * agent reported "Not logged in - Please run /login" while Codex was signed in.
 *
 * The payload is piped over stdin rather than passed as a `docker create` env
 * var: an env var is readable from `docker inspect` and `/proc/1/environ` for
 * the life of the container, and would go stale the first time the OAuth token
 * refreshed. Syncing on every start also re-arms a refreshed token.
 */
export function buildSyncContainerClaudeCredentialCommand(
  credentialFile = CONTAINER_CLAUDE_CREDENTIAL_FILE,
): string {
  return `
  set -e
  credential_file=${quoteShell(credentialFile)}
  credential_dir="$(dirname "$credential_file")"
  umask 077
  mkdir -p "$credential_dir"
  payload="$(cat)"
  # An empty payload means the host had nothing to offer. Leave any credential
  # already inside the container alone rather than logging the agent out.
  if [ -z "$payload" ]; then
    exit 0
  fi
  credential_tmp="$(mktemp "$credential_dir/.credentials.XXXXXX")"
  trap 'rm -f "$credential_tmp"' EXIT
  printf '%s' "$payload" > "$credential_tmp"
  chmod 600 "$credential_tmp"
  mv -f "$credential_tmp" "$credential_file"
  credential_tmp=
  trap - EXIT
  unset payload
`;
}

export const SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND = buildSyncContainerClaudeCredentialCommand();

const MAX_HOST_AGENT_CREDENTIAL_BYTES = 1024 * 1024;

/**
 * Reads one named Keychain record, preferring an explicit login-Keychain path.
 *
 * The explicit path is what makes an isolated agent-test profile deterministic:
 * its HOME holds no Keychain preferences, so an unqualified lookup would resolve
 * against whatever the launching session happens to default to. A host that is
 * not isolated has no such requirement and may legitimately keep the record in a
 * keychain other than `login.keychain-db`, so it retries the default search list
 * — which is what an unqualified lookup did before the path was pinned — rather
 * than reporting a logged-in user as signed out.
 */
async function readMacKeychainPassword(
  service: string,
  homeDir: string,
  account?: string,
  allowDefaultSearchList = false,
): Promise<string | undefined> {
  const args = ["find-generic-password"];
  if (account) args.push("-a", account);
  args.push("-s", service, "-w");
  const attempts = [[...args, path.join(homeDir, "Library", "Keychains", "login.keychain-db")]];
  if (allowDefaultSearchList) attempts.push(args);
  for (const attempt of attempts) {
    try {
      const { stdout } = await runCommand("security", attempt, { timeoutMs: 10_000 });
      const value = stdout.trim();
      // An empty or oversized payload is not a reason to stop looking; a second
      // keychain may still hold the real record.
      if (!value || Buffer.byteLength(value) > MAX_HOST_AGENT_CREDENTIAL_BYTES) continue;
      return value;
    } catch {
      // A missing item and a declined access prompt look identical from here.
    }
  }
  return undefined;
}

/**
 * Reads the host's Claude Code credential, preferring the macOS Keychain.
 *
 * Returns the raw credential JSON, or undefined when the host has no usable
 * credential. A non-JSON or empty Keychain payload is discarded rather than
 * forwarded, so a corrupt entry cannot overwrite a working in-container login.
 */
export async function getHostClaudeCredentials(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  configDir?: string,
  options: { allowDefaultKeychainSearchList?: boolean } = {},
): Promise<string | undefined> {
  const isUsable = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "{}") return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return Object.keys(parsed as Record<string, unknown>).length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };

  if (platform === "darwin") {
    const fromKeychain = isUsable(
      await readMacKeychainPassword(
        HOST_CLAUDE_KEYCHAIN_SERVICE,
        homeDir,
        undefined,
        options.allowDefaultKeychainSearchList === true,
      ),
    );
    if (fromKeychain) return fromKeychain;
  }

  // `CLAUDE_CONFIG_DIR` first, because that is where Claude Code itself keeps
  // the on-disk credential when it is set. An agent-test profile runs with an
  // isolated HOME but is pointed at the host configuration, so reading only
  // `homeDir` would look inside the empty isolated home and report no login.
  for (const directory of [configDir, path.join(homeDir, ".claude")]) {
    if (!directory) continue;
    try {
      const found = isUsable(await fs.readFile(path.join(directory, ".credentials.json"), "utf-8"));
      if (found) return found;
    } catch {
      // Try the next location; a missing file is not an error here.
    }
  }
  return undefined;
}

/**
 * Grace period applied to a recorded OAuth expiry.
 *
 * The token is read once, at bridge start, and never refreshed. One that lapses
 * during startup would be indistinguishable from a broken login, so treat the
 * final moments of its life as already expired.
 */
const CLAUDE_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * Extracts the single OAuth access token that may be handed to one bridge.
 *
 * An expired token is treated as no token at all. It is a non-empty bearer
 * credential that the CLI prefers over every other source, so forwarding a
 * lapsed one turns a stale host login into opaque authentication failures
 * instead of the signed-out state the agent reports clearly. A credential that
 * records no expiry is not evidence of expiry, so only a real timestamp that has
 * already passed rejects.
 */
export function getClaudeOAuthAccessToken(
  credentials: string | undefined,
  now: number = Date.now(),
): string | undefined {
  if (!credentials) return undefined;
  try {
    const parsed = JSON.parse(credentials) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const accessToken = parsed.claudeAiOauth?.accessToken;
    if (typeof accessToken !== "string") return undefined;
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    if (
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt <= now + CLAUDE_OAUTH_EXPIRY_SKEW_MS
    ) {
      return undefined;
    }
    const trimmed = accessToken.trim();
    return trimmed && Buffer.byteLength(trimmed) <= MAX_HOST_AGENT_CREDENTIAL_BYTES
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

export async function syncContainerClaudeCredential(
  containerId: string,
  credentials: string | undefined,
): Promise<void> {
  if (!credentials) return;
  await runCommand(
    "docker",
    ["exec", "-i", containerId, "bash", "-lc", SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND],
    {
      stdin: credentials,
      timeoutMs: 30_000,
      redactValues: [credentials],
    },
  );
}

/**
 * Deliver the current Cursor key without putting it in Docker argv, logs, or a
 * shell command. Bridge startup reads the owner-only file into its environment.
 */
export async function syncContainerCursorApiKey(
  containerId: string,
  apiKey: string | undefined,
): Promise<void> {
  if (!apiKey) {
    await dockerExec(containerId, `rm -f ${CONTAINER_CURSOR_API_KEY_FILE}`);
    return;
  }
  const command = [
    "set -eu",
    `credential_dir=${quoteShell(CONTAINER_CURSOR_CREDENTIAL_DIR)}`,
    'mkdir -p "$credential_dir"',
    'chmod 700 "$credential_dir"',
    'credential_tmp="$(mktemp "$credential_dir/.cursor-api-key.XXXXXX")"',
    "trap 'rm -f \"$credential_tmp\"' EXIT",
    'cat > "$credential_tmp"',
    'chmod 600 "$credential_tmp"',
    `mv "$credential_tmp" ${quoteShell(CONTAINER_CURSOR_API_KEY_FILE)}`,
    "trap - EXIT",
  ].join("\n");
  await runCommand("docker", ["exec", "-i", containerId, "sh", "-c", command], {
    stdin: apiKey,
    timeoutMs: 30_000,
    redactValues: [apiKey],
  });
}

/**
 * Resolves the credential to deliver, honouring the user's opt-out.
 *
 * The gate is checked before the Keychain is read, not after: the point of
 * turning this off is that a long-lived host OAuth token never enters an
 * environment that runs untrusted repository code, so it must not be read into
 * this process either. Absent means on, matching `useHostGitHubCredentials`.
 */
export async function resolveContainerClaudeCredentials(
  globalConfig: AppConfig["global"],
): Promise<string | undefined> {
  if (globalConfig.useHostClaudeCredentials === false) return undefined;
  const agentTestHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  return getHostClaudeCredentials(
    process.platform,
    agentTestHostHome || os.homedir(),
    process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim() ||
      process.env.CLAUDE_CONFIG_DIR?.trim() ||
      undefined,
    // Only an agent-test profile needs the lookup pinned to one keychain file.
    // An ordinary install runs as the logged-in user and may keep the record
    // outside `login.keychain-db`, so it keeps the default search list.
    { allowDefaultKeychainSearchList: !agentTestHostHome },
  );
}

/**
 * Best-effort variant used on the environment start path.
 *
 * A credential that cannot be delivered leaves the agent logged out, which the
 * agent itself reports clearly. Failing the whole environment start over it
 * would be a worse outcome, so this only warns — and never with the payload.
 */
export async function syncContainerClaudeCredentialBestEffort(
  containerId: string,
  globalConfig: AppConfig["global"],
): Promise<void> {
  try {
    await syncContainerClaudeCredential(
      containerId,
      await resolveContainerClaudeCredentials(globalConfig),
    );
  } catch (error) {
    console.warn(
      "[commands] Failed to sync Claude credentials into container:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// `docker cp` behaves like `cp -a`: it preserves the staging tree's modes and
// makes files copied into a container root-owned. The staging root comes from
// `mkdtemp` (0700), so the image's `node` user cannot even traverse
// `/project-files` until access is repaired after the container starts. Keep the
// files root-owned and private, but let the node group read files and traverse
// directories so workspace-setup.sh can copy them into the workspace.
export const ENSURE_CONTAINER_PROJECT_FILES_ACCESS_COMMAND =
  "if [ -d /project-files ]; then chgrp -R node /project-files && chmod -R g+rX,o-rwx /project-files; fi";

export async function ensureContainerProjectFilesAccess(containerId: string): Promise<void> {
  await runCommand(
    "docker",
    [
      "exec",
      "--user",
      "root",
      containerId,
      "sh",
      "-c",
      ENSURE_CONTAINER_PROJECT_FILES_ACCESS_COMMAND,
    ],
    { timeoutMs: 30_000 },
  );
}

export async function addLocalWorkspaceArtifactsToGitExclude(worktreePath: string): Promise<void> {
  const excludeFile = await resolveLocalGitExcludeFile(worktreePath);
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });

  const existing = await fs.readFile(excludeFile, "utf8").catch(() => "");
  const existingPatterns = new Set(existing.split(/\r?\n/));
  let next = existing;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";

  for (const pattern of WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS) {
    if (existingPatterns.has(pattern)) continue;
    next += `${pattern}\n`;
  }

  if (next !== existing) {
    await fs.writeFile(excludeFile, next);
  }
}

export async function resolveLocalGitExcludeFile(worktreePath: string): Promise<string> {
  const { stdout } = await runCommand(
    "git",
    ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"],
    { timeoutMs: 10_000 },
  );
  const excludeFile = stdout.trim();
  if (!excludeFile) throw new Error(`Could not resolve git exclude file for ${worktreePath}`);
  return path.isAbsolute(excludeFile) ? excludeFile : path.resolve(worktreePath, excludeFile);
}
