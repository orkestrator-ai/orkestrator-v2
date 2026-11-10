import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bridge's own Read, Grep (which also serves Glob) and LS, for a
 * read-only coordinator whose reading tools must check every path.
 *
 * `@cursor/sdk` lets a host replace these executors but not wrap them, so a
 * path check needs an implementation to delegate to. These follow the SDK
 * 1.3.1 host executors closely enough for the model: the argument and result
 * messages are the SDK's own (`ReadArgs`/`ReadResult`, `GrepArgs`/`GrepResult`,
 * `LsArgs`/`LsResult`), returned as plain objects that the SDK's protobuf
 * runtime turns into its message classes when it serialises them. Its
 * executor interfaces are unpublished, so every SDK bump has to recheck these
 * shapes (`read-tools.test.ts` pins them).
 *
 * Known differences from the host executors: only the workspace root's
 * `.cursorignore` is honoured, by Grep and LS, and a Grep or Glob `glob`
 * filter overrides it (ripgrep's globs override ignore files); Read does not
 * consult it. Images are returned as they are, without the SDK's resizing,
 * and searches run outside Cursor's provider sandbox. None of these widens
 * what a turn can reach in the data directory: the path check applies to
 * every result.
 */

/** The SDK's own cap on one read (`$5`), 8 MiB. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Files, count rows or content lines one search returns (the SDK's `CLIENT_LIMIT_LINES`). */
export const MAX_SEARCH_ENTRIES = 2000;
/** Longest line a content search returns before marking it truncated. */
export const MAX_MATCH_LINE_CHARS = 1000;
/** Bytes of ripgrep output read before the search is stopped as truncated. */
const MAX_RIPGREP_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Bytes of ripgrep's stderr kept for an error message. */
const MAX_RIPGREP_STDERR_BYTES = 4096;
/** The SDK's grep deadline (`MAIN_TIMEOUT_MS`). */
const SEARCH_TIMEOUT_MS = 25_000;
/** The SDK's LS default deadline and character budget. */
const LS_TIMEOUT_MS = 5000;
const LS_CHARACTER_BUDGET = 2500;

/** Decides whether an absolute path a tool would return or read is refused. */
export type PathRefused = (absolutePath: string) => boolean;

/* ---------------------------------------------------------------- Read --- */

export interface ReadArgsLike {
  path?: string;
  offset?: number;
  limit?: number;
  maxChars?: number;
}

export type ReadResultLike = {
  result:
    | { case: "success"; value: Record<string, unknown> }
    | { case: "error"; value: { path: string; error: string } }
    | { case: "rejected"; value: { path: string; reason: string } }
    | { case: "fileNotFound"; value: { path: string } }
    | { case: "permissionDenied"; value: { path: string } }
    | { case: "invalidFile"; value: { path: string; reason: string } };
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * The SDK's digest wrapper clones a successful read's value before replacing
 * its content with a hash, so that value needs a `clone` of its own. It is
 * not enumerable: the protobuf runtime copies only the message's fields.
 */
function withClone<T extends object>(value: T): T {
  Object.defineProperty(value, "clone", {
    value: () => withClone(structuredClone(value)),
    enumerable: false,
  });
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error occurred";
}

/** Line count as the SDK counts it (`qJ`): one more than the newlines. */
function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

function clampLine(value: number, total: number): number {
  if (Number.isNaN(value) || value === 0) return 0;
  if (value === Number.POSITIVE_INFINITY) return total;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  const whole = Math.trunc(value);
  return whole < 0 ? Math.max(total + whole, 0) : Math.min(whole, total);
}

/**
 * The line range a read asks for, as the SDK resolves it (`fB1`): `offset` is
 * one-based, a negative offset counts from the end, and an offset past the
 * end applies no range at all.
 */
export function readLineRange(
  totalLines: number,
  empty: boolean,
  args: ReadArgsLike,
): { applied: false } | { applied: true; start: number; end: number } {
  if (args.offset === undefined && args.limit === undefined) return { applied: false };
  if (empty) return { applied: false };
  const offset = args.offset ?? 1;
  const limit = args.limit ?? (offset < 0 ? Math.abs(offset) : totalLines);
  const first = offset < 0 ? Math.max(0, totalLines + offset) : Math.max(0, offset - 1);
  if (first >= totalLines) return { applied: false };
  const last = Math.min(totalLines, first + limit);
  const start = clampLine(first, totalLines);
  return { applied: true, start, end: Math.max(start, clampLine(last, totalLines)) };
}

function sliceLines(text: string, start: number, end: number): string {
  if (start >= end) return "";
  let from = 0;
  for (let line = 0; line < start; line += 1) {
    const next = text.indexOf("\n", from);
    if (next === -1) return "";
    from = next + 1;
  }
  let to = from;
  for (let line = start; line < end; line += 1) {
    const next = text.indexOf("\n", to);
    if (next === -1) return text.slice(from);
    to = next + 1;
  }
  return text.slice(from, to);
}

/** Characters a read may return (`cF8`): `maxChars` only bounds an unranged read. */
function readCharacterLimit(args: ReadArgsLike): number {
  if (args.maxChars === undefined || args.offset !== undefined || args.limit !== undefined) {
    return MAX_READ_BYTES;
  }
  return Math.min(MAX_READ_BYTES, args.maxChars + 2);
}

/** Never ends a truncated read on half a surrogate pair. */
function trimSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

const BINARY_SIGNATURES: readonly Buffer[] = [
  Buffer.from("%PDF-", "ascii"),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from("GIF87a", "ascii"),
  Buffer.from("GIF89a", "ascii"),
  Buffer.from("SQLite format 3\x00", "ascii"),
  Buffer.from([0x1f, 0x8b]),
];

function looksBinary(head: Buffer): boolean {
  if (BINARY_SIGNATURES.some((signature) => head.subarray(0, signature.length).equals(signature))) {
    return true;
  }
  return head.includes(0);
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function success(path: string, value: Record<string, unknown>): ReadResultLike {
  return { result: { case: "success", value: withClone({ path, ...value }) } };
}

/** Reads one file the boundary already admitted. */
export async function readFileTool(path: string, args: ReadArgsLike): Promise<ReadResultLike> {
  try {
    const stats = await stat(path);
    if (stats.isDirectory()) {
      return {
        result: {
          case: "invalidFile",
          value: { path, reason: "Path is a directory, not a file" },
        },
      };
    }
    if (!stats.isFile()) {
      return {
        result: {
          case: "invalidFile",
          value: { path, reason: "Path is neither a file nor a directory" },
        },
      };
    }
    const fileSize = BigInt(stats.size);
    const extension = extname(path).toLowerCase();
    const head = await readHead(path, Math.min(stats.size, 8192));
    if (IMAGE_EXTENSIONS.has(extension) || extension === ".pdf" || looksBinary(head)) {
      if (!(IMAGE_EXTENSIONS.has(extension) || extension === ".pdf")) {
        return {
          result: {
            case: "invalidFile",
            value: { path, reason: "File content is binary data, not text" },
          },
        };
      }
      if (stats.size > MAX_READ_BYTES) {
        return {
          result: {
            case: "invalidFile",
            value: { path, reason: `File is larger than ${MAX_READ_BYTES} bytes` },
          },
        };
      }
      const data = await readHead(path, stats.size);
      return success(path, {
        output: { case: "data", value: new Uint8Array(data) },
        totalLines: 0,
        fileSize,
        truncated: false,
      });
    }
    // Larger text is read up to the cap, as the SDK's streaming read caps it.
    const capped = stats.size > MAX_READ_BYTES;
    const bytes = await readHead(path, Math.min(stats.size, MAX_READ_BYTES));
    let text = bytes.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const totalLines = countLines(text);
    const range = readLineRange(totalLines, text === "", args);
    let content = range.applied ? sliceLines(text, range.start, range.end) : text;
    let truncated = capped;
    const limit = readCharacterLimit(args);
    if (content.length > limit) {
      content = trimSurrogate(content.substring(0, limit));
      truncated = true;
    }
    return success(path, {
      output: { case: "content", value: content },
      totalLines,
      fileSize,
      truncated,
      rangeApplied: range.applied,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { result: { case: "fileNotFound", value: { path } } };
    if (code === "EACCES" || code === "EPERM") {
      return { result: { case: "permissionDenied", value: { path } } };
    }
    return { result: { case: "error", value: { path, error: errorMessage(error) } } };
  }
}

/* ------------------------------------------------------------ ripgrep --- */

/** Where `@cursor/sdk` is really installed; its platform package sits beside it. */
function sdkDirectory(): string | undefined {
  try {
    return realpathSync(dirname(fileURLToPath(import.meta.resolve("@cursor/sdk"))));
  } catch {
    return undefined;
  }
}

/**
 * The ripgrep the SDK itself would run: `CURSOR_RIPGREP_PATH`, then the
 * binary in its native platform package (`@cursor/sdk-<platform>-<arch>`),
 * found by walking up from the SDK's own install and then from this module,
 * then `rg` on PATH. A candidate inside the workspace is skipped, as the SDK
 * skips it: a checkout must not supply the binary.
 */
export function resolveRipgrep(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  from: readonly (string | undefined)[] = [sdkDirectory(), dirname(fileURLToPath(import.meta.url))],
): string {
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const configured = env.CURSOR_RIPGREP_PATH?.trim();
  if (configured && isAbsolute(configured) && existsSync(configured)) return configured;
  const workspaceRoot = resolve(workspace);
  const insideWorkspace = (path: string) => {
    const inside = relative(workspaceRoot, path);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  };
  const relativeBinary = join(
    "node_modules",
    "@cursor",
    `sdk-${process.platform}-${process.arch}`,
    "bin",
    binary,
  );
  for (const start of from) {
    if (!start) continue;
    let directory = resolve(start);
    for (;;) {
      const candidate = join(directory, relativeBinary);
      if (!insideWorkspace(candidate) && existsSync(candidate)) return candidate;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return binary;
}

interface RipgrepRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
}

/** Runs ripgrep with bounded output and a deadline, killing only the child it spawned. */
export function runRipgrep(
  ripgrep: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<RipgrepRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ripgrep, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let timedOut = false;
    let outputCapped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputCapped) return;
      const room = MAX_RIPGREP_OUTPUT_BYTES - bytes;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        bytes += room;
        outputCapped = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_RIPGREP_STDERR_BYTES) {
        stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_RIPGREP_STDERR_BYTES);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(chunks),
        stderr,
        exitCode,
        timedOut,
        outputCapped,
      });
    });
  });
}

/** ripgrep failed outright: an error and nothing found. */
function ripgrepFailed(run: RipgrepRun): boolean {
  return !run.timedOut && !run.outputCapped && run.exitCode === 2 && run.stdout.length === 0;
}

function ripgrepError(run: RipgrepRun): string {
  return run.stderr.trim().split(/\r?\n/)[0] || `ripgrep exited with code ${run.exitCode}`;
}

/* ---------------------------------------------------------------- Grep --- */

export interface GrepArgsLike {
  pattern?: string;
  path?: string;
  glob?: string;
  outputMode?: string;
  contextBefore?: number;
  contextAfter?: number;
  context?: number;
  caseInsensitive?: boolean;
  type?: string;
  headLimit?: number;
  multiline?: boolean;
  sort?: string;
  sortAscending?: boolean;
  offset?: number;
}

export type GrepResultLike = {
  result:
    | { case: "success"; value: Record<string, unknown> }
    | { case: "error"; value: { error: string } };
};

type OutputMode = "content" | "files_with_matches" | "count";

function outputModeOf(value: string | undefined): OutputMode | undefined {
  const mode = value ?? "content";
  return mode === "content" || mode === "files_with_matches" || mode === "count" ? mode : undefined;
}

/** A Glob call: a file search by pattern rather than by content (`Ll6`). */
function listsFiles(args: GrepArgsLike, mode: OutputMode): boolean {
  return mode === "files_with_matches" && (args.pattern ?? "") === "" && Boolean(args.glob);
}

/** What one search keeps: an offset, then a head limit, then the client cap. */
function page<T>(
  entries: readonly T[],
  args: GrepArgsLike,
): { kept: T[]; headLimitApplied?: number; offsetApplied?: number; clientTruncated: boolean } {
  const offset = args.offset !== undefined && args.offset > 0 ? Math.trunc(args.offset) : 0;
  let kept = entries.slice(offset);
  let headLimitApplied: number | undefined;
  if (args.headLimit !== undefined && args.headLimit > 0 && kept.length > args.headLimit) {
    headLimitApplied = Math.trunc(args.headLimit);
    kept = kept.slice(0, headLimitApplied);
  }
  const clientTruncated = kept.length > MAX_SEARCH_ENTRIES;
  if (clientTruncated) kept = kept.slice(0, MAX_SEARCH_ENTRIES);
  return {
    kept,
    ...(headLimitApplied !== undefined ? { headLimitApplied } : {}),
    ...(offset > 0 ? { offsetApplied: offset } : {}),
    clientTruncated,
  };
}

function grepArguments(args: GrepArgsLike, mode: OutputMode, target: string): string[] {
  const files = listsFiles(args, mode);
  const rg: string[] = [];
  if (mode === "content") {
    rg.push("--json");
    if (args.contextBefore !== undefined) rg.push("--before-context", String(args.contextBefore));
    if (args.contextAfter !== undefined) rg.push("--after-context", String(args.contextAfter));
    if (
      args.context !== undefined &&
      args.contextBefore === undefined &&
      args.contextAfter === undefined
    ) {
      rg.push("--context", String(args.context));
    }
  } else if (mode === "files_with_matches") {
    rg.push(files ? "--files" : "--files-with-matches", "--null");
  } else {
    rg.push("--count", "--with-filename", "--null");
  }
  rg.push(args.caseInsensitive === true ? "--ignore-case" : "--case-sensitive");
  if (args.type) rg.push("--type", args.type);
  if (args.glob) {
    rg.push("--iglob", args.glob);
    if (files) rg.push("--iglob", "!**/.git");
  }
  if (args.multiline) rg.push("--multiline", "--multiline-dotall");
  const sort = args.sort ?? "modified";
  if (sort !== "none") rg.push(args.sortAscending === true ? "--sort" : "--sortr", sort);
  rg.push("--no-config", "--color=never", "--hidden", "--follow");
  if (!files) rg.push("--regexp", args.pattern ?? "");
  rg.push("--", target);
  return rg;
}

function withoutDotSlash(path: string): string {
  return path.startsWith(`.${sep}`) ? path.slice(2) : path;
}

function splitNull(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .map((entry) => entry.replace(/^\r?\n/, ""))
    .filter((entry) => entry !== "");
}

interface RipgrepJsonText {
  text?: string;
  bytes?: string;
}

function jsonText(value: RipgrepJsonText | undefined): string {
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  return typeof value.bytes === "string" ? Buffer.from(value.bytes, "base64").toString("utf8") : "";
}

interface ContentLine {
  file: string;
  lineNumber: number;
  content: string;
  contentTruncated: boolean;
  isContextLine: boolean;
}

function contentLines(output: Buffer): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const raw of output.toString("utf8").split("\n")) {
    if (!raw.trim()) continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue; // The last line of a capped stream.
    }
    if (event.type !== "match" && event.type !== "context") continue;
    const data = event.data ?? {};
    const file = jsonText(data.path as RipgrepJsonText | undefined);
    const text = jsonText(data.lines as RipgrepJsonText | undefined).replace(/\r?\n$/, "");
    const lineNumber = typeof data.line_number === "number" ? data.line_number : 0;
    // A multiline match spans several lines; each is reported on its own.
    text.split("\n").forEach((line, index) => {
      const truncated = line.length > MAX_MATCH_LINE_CHARS;
      lines.push({
        file: withoutDotSlash(file),
        lineNumber: lineNumber + index,
        content: truncated ? line.slice(0, MAX_MATCH_LINE_CHARS) : line,
        contentTruncated: truncated,
        isContextLine: event.type === "context",
      });
    });
  }
  return lines;
}

/**
 * Searches for the boundary-checked root. Every file ripgrep reports is
 * checked again before it is returned, because a search follows links: one
 * rooted in the checkout reaches whatever a link inside it points at.
 */
export async function grepTool(
  args: GrepArgsLike,
  options: { cwd: string; target: string; refused: PathRefused; ripgrep: string },
): Promise<GrepResultLike> {
  const mode = outputModeOf(args.outputMode);
  if (!mode) {
    return {
      result: { case: "error", value: { error: `Unknown output mode: ${args.outputMode}` } },
    };
  }
  const { cwd, refused } = options;
  try {
    const targetStats = await stat(options.target).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!targetStats) {
      return {
        result: { case: "error", value: { error: `Path does not exist: ${options.target}` } },
      };
    }
    const inside = relative(cwd, options.target);
    const target =
      inside === ""
        ? "."
        : !inside.startsWith("..") && !isAbsolute(inside)
          ? inside
          : options.target;
    const rgArgs = grepArguments(args, mode, target);
    const cursorIgnore = join(cwd, ".cursorignore");
    if (existsSync(cursorIgnore)) rgArgs.unshift("--ignore-file", cursorIgnore);
    const run = await runRipgrep(options.ripgrep, rgArgs, cwd, SEARCH_TIMEOUT_MS);
    if (ripgrepFailed(run)) {
      return { result: { case: "error", value: { error: ripgrepError(run) } } };
    }
    const ripgrepTruncated = run.timedOut || run.outputCapped;
    const admitted = (file: string) => !refused(resolve(cwd, file));
    let union: Record<string, unknown>;
    if (mode === "content") {
      const lines = contentLines(run.stdout).filter((line) => admitted(line.file));
      const paged = page(lines, args);
      const byFile = new Map<string, Omit<ContentLine, "file">[]>();
      for (const { file, ...line } of paged.kept) {
        const matches = byFile.get(file) ?? [];
        matches.push(line);
        byFile.set(file, matches);
      }
      union = {
        case: "content",
        value: {
          matches: Array.from(byFile, ([file, matches]) => ({ file, matches })),
          totalLines: lines.length,
          totalMatchedLines: lines.filter((line) => !line.isContextLine).length,
          clientTruncated: paged.clientTruncated,
          ripgrepTruncated,
          headLimitApplied: paged.headLimitApplied,
          offsetApplied: paged.offsetApplied,
        },
      };
    } else if (mode === "files_with_matches") {
      const files = splitNull(run.stdout).map(withoutDotSlash).filter(admitted);
      const paged = page(files, args);
      union = {
        case: "files",
        value: {
          files: paged.kept,
          totalFiles: files.length,
          clientTruncated: paged.clientTruncated,
          ripgrepTruncated,
          headLimitApplied: paged.headLimitApplied,
          offsetApplied: paged.offsetApplied,
        },
      };
    } else {
      const entries = run.stdout.toString("utf8").split("\n");
      const counts: { file: string; count: number }[] = [];
      for (const entry of entries) {
        const separator = entry.lastIndexOf("\0");
        if (separator === -1) continue;
        const file = withoutDotSlash(entry.slice(0, separator));
        const count = Number.parseInt(entry.slice(separator + 1), 10);
        if (Number.isFinite(count) && admitted(file)) counts.push({ file, count });
      }
      const paged = page(counts, args);
      union = {
        case: "count",
        value: {
          counts: paged.kept,
          totalFiles: counts.length,
          totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
          clientTruncated: paged.clientTruncated,
          ripgrepTruncated,
          headLimitApplied: paged.headLimitApplied,
          offsetApplied: paged.offsetApplied,
        },
      };
    }
    return {
      result: {
        case: "success",
        value: {
          pattern: args.pattern ?? "",
          path: args.path ?? "",
          outputMode: mode,
          workspaceResults: { [cwd]: { result: union } },
        },
      },
    };
  } catch (error) {
    return { result: { case: "error", value: { error: errorMessage(error) } } };
  }
}

/* ------------------------------------------------------------------ LS --- */

export interface LsArgsLike {
  path?: string;
  ignore?: readonly string[];
  timeoutMs?: number;
}

export type LsResultLike = {
  result:
    | { case: "success"; value: { directoryTreeRoot: TreeNode } }
    | { case: "timeout"; value: { directoryTreeRoot: TreeNode } }
    | { case: "error"; value: { path: string; error: string } }
    | { case: "rejected"; value: { path: string; reason: string } };
};

export interface TreeNode {
  absPath: string;
  childrenDirs: TreeNode[];
  childrenFiles: { name: string }[];
  childrenWereProcessed: boolean;
  fullSubtreeExtensionCounts: Record<string, number>;
  numFiles?: number;
}

function treeNode(absPath: string, processed: boolean): TreeNode {
  return {
    absPath,
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: processed,
    fullSubtreeExtensionCounts: {},
  };
}

/** The tree the SDK's LS builds (`addPathToTree`), with its character budget. */
class TreeBuilder {
  readonly root: TreeNode;
  private readonly nodes = new Map<string, TreeNode>();
  private charactersUsed: number;
  private budgetExceeded = false;

  constructor(private readonly rootPath: string) {
    this.root = treeNode(rootPath, true);
    this.nodes.set(rootPath, this.root);
    this.charactersUsed = rootPath.length;
  }

  private ancestors(directory: string): TreeNode[] {
    const chain: TreeNode[] = [];
    let current = directory;
    for (;;) {
      const node = this.nodes.get(current);
      if (node) chain.push(node);
      if (current === this.rootPath) break;
      const parent = dirname(current);
      if (parent === current || !parent.startsWith(this.rootPath)) break;
      current = parent;
    }
    return chain;
  }

  private ensureDirectory(directory: string): TreeNode | undefined {
    const existing = this.nodes.get(directory);
    if (existing) return existing;
    if (!directory.startsWith(`${this.rootPath}${sep}`)) return undefined;
    const parent = this.ensureDirectory(dirname(directory));
    const node = treeNode(directory, !this.budgetExceeded);
    this.nodes.set(directory, node);
    parent?.childrenDirs.push(node);
    return node;
  }

  add(file: string): void {
    const name = basename(file);
    const directory = dirname(file);
    const node = this.ensureDirectory(directory);
    if (!node) return;
    if (!this.budgetExceeded && this.charactersUsed + name.length <= LS_CHARACTER_BUDGET) {
      node.childrenFiles.push({ name });
      this.charactersUsed += name.length;
      return;
    }
    const chain = this.ancestors(directory);
    if (!this.budgetExceeded) {
      this.budgetExceeded = true;
      for (const ancestor of chain) ancestor.childrenWereProcessed = false;
    }
    const extension = extname(name).replace(/^\./, "") || name;
    for (const ancestor of chain) {
      ancestor.fullSubtreeExtensionCounts[extension] =
        (ancestor.fullSubtreeExtensionCounts[extension] ?? 0) + 1;
      ancestor.numFiles = (ancestor.numFiles ?? 0) + 1;
    }
  }

  sorted(): TreeNode {
    const sort = (node: TreeNode) => {
      node.childrenDirs.sort((a, b) => basename(a.absPath).localeCompare(basename(b.absPath)));
      node.childrenFiles.sort((a, b) => a.name.localeCompare(b.name));
      node.childrenDirs.forEach(sort);
    };
    sort(this.root);
    return this.root;
  }
}

/**
 * Lists the boundary-checked directory. Each file is checked again before it
 * is listed, so a directory above the data directory lists everything but it.
 */
export async function lsTool(
  path: string,
  args: LsArgsLike,
  options: { refused: PathRefused; ripgrep: string },
): Promise<LsResultLike> {
  try {
    let stats;
    try {
      stats = await stat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return {
          result: { case: "error", value: { path, error: `Path does not exist: ${path}` } },
        };
      }
      return { result: { case: "error", value: { path, error: errorMessage(error) } } };
    }
    if (!stats.isDirectory()) {
      return {
        result: { case: "error", value: { path, error: `Path is not a directory: ${path}` } },
      };
    }
    const rgArgs = ["--files", "--hidden", "--no-require-git", "--no-config", "--color=never"];
    for (const ignore of args.ignore ?? []) rgArgs.push("--iglob", `!${ignore}`);
    const cursorIgnore = join(path, ".cursorignore");
    if (existsSync(cursorIgnore)) rgArgs.push("--ignore-file", cursorIgnore);
    const run = await runRipgrep(options.ripgrep, rgArgs, path, args.timeoutMs ?? LS_TIMEOUT_MS);
    if (ripgrepFailed(run)) {
      return { result: { case: "error", value: { path, error: ripgrepError(run) } } };
    }
    const tree = new TreeBuilder(path);
    for (const line of run.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const file = resolve(path, line);
      if (options.refused(file)) continue;
      tree.add(file);
    }
    const directoryTreeRoot = tree.sorted();
    return run.timedOut
      ? { result: { case: "timeout", value: { directoryTreeRoot } } }
      : { result: { case: "success", value: { directoryTreeRoot } } };
  } catch (error) {
    return { result: { case: "error", value: { path, error: errorMessage(error) } } };
  }
}
