/** Compact line-change metadata shared by every agent transcript adapter. */
export interface ToolLineChangeStats {
  additions: number;
  deletions: number;
}

/**
 * The subset of a tool-diff payload that can be derived from a tool's raw
 * `input`. Deliberately a structural superset of nothing: every field is
 * optional, so the value is assignable to each adapter's own `ToolDiffMetadata`
 * without those types having to depend on this one.
 */
export interface ToolDiffSides {
  filePath?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}

/**
 * OpenCode's completed edit/write payload: Claude-shaped input plus the
 * provider's own `filediff` / `diff` metadata and, as a last resort, a
 * path-like tool title.
 */
export interface OpenCodeToolDiff extends ToolDiffSides {
  diff?: string;
}

/**
 * Count logical lines without allocating an array proportional to the payload.
 * A trailing newline terminates the final line; it does not create another one.
 */
export function countTextLines(value: string | undefined): number {
  if (!value) return 0;

  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return value.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Split into the same logical lines {@link countTextLines} would count.
 *
 * The expanded edit view has to render those lines, so it cannot use
 * `String#split("\n")`: a terminating newline would become an extra empty
 * row and disagree with the collapsed +/- badge.
 */
export function splitTextLines(value: string | undefined): string[] {
  if (!value) return [];
  if (!value.endsWith("\n")) return value.split("\n");
  return value.slice(0, -1).split("\n");
}

/**
 * Derive the small metadata shown on a collapsed edit row from replacement
 * sides before those potentially large strings are deferred or discarded.
 */
export function lineChangeStatsFromSides(
  before: string | undefined,
  after: string | undefined,
): ToolLineChangeStats | undefined {
  if (before === undefined && after === undefined) return undefined;
  return {
    additions: countTextLines(after),
    deletions: countTextLines(before),
  };
}

/** Tool names whose input carries a single old/new replacement pair. */
const EDIT_LIKE_TOOLS = new Set(["edit", "file_edit", "str_replace_editor", "replace"]);

/** Tool names whose input carries whole-file content with no prior state. */
const WRITE_LIKE_TOOLS = new Set(["write", "create_file"]);

/**
 * Every file-mutating tool name the OpenCode / Claude / Codex adapters render
 * as an edit row. Kept here so the backend projection and the live renderer
 * cannot disagree about which calls get a `toolDiff`.
 */
const FILE_EDIT_TOOL_NAMES = new Set([
  ...EDIT_LIKE_TOOLS,
  ...WRITE_LIKE_TOOLS,
  "patch",
  "apply_patch",
  "multiedit",
  "notebookedit",
  "insert",
]);

/** True when `toolName` is a file-mutating tool after case folding. */
export function isFileEditToolName(toolName?: string): boolean {
  if (!toolName) return false;
  return FILE_EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Resolve the file an edit tool targets.
 *
 * An empty string is skipped rather than returned: a blank path is not a
 * location, and returning it would render a nameless file row that the
 * "no path at all" branch would otherwise have handled correctly.
 */
export function filePathFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "filePath", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Concatenate the chunks of a multi-edit into one synthetic side.
 *
 * A chunk that already ends in a newline supplies its own separator. Joining
 * unconditionally with "\n" inserts a blank line after every such chunk, which
 * both shows a line the file never had and inflates the line count by one.
 */
function joinEditChunks(chunks: string[]): string {
  let joined = "";
  for (const chunk of chunks) {
    if (joined.length > 0 && !joined.endsWith("\n")) joined += "\n";
    joined += chunk;
  }
  return joined;
}

/**
 * Sum each chunk's own line count.
 *
 * Counting the joined string instead would charge the separators introduced by
 * {@link joinEditChunks} to the total.
 */
function countChunkLines(chunks: string[]): number {
  let lines = 0;
  for (const chunk of chunks) lines += countTextLines(chunk);
  return lines;
}

function multiEditSides(input: Record<string, unknown>): ToolDiffSides {
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const beforeChunks: string[] = [];
  const afterChunks: string[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
    const fields = edit as Record<string, unknown>;
    const before = stringField(fields, "old_string", "oldString");
    const after = stringField(fields, "new_string", "newString");
    if (before !== undefined) beforeChunks.push(before);
    if (after !== undefined) afterChunks.push(after);
  }
  return {
    before: joinEditChunks(beforeChunks),
    after: joinEditChunks(afterChunks),
    additions: countChunkLines(afterChunks),
    deletions: countChunkLines(beforeChunks),
  };
}

/**
 * Map a raw `tool_use.input` payload to the diff sides and line counts a
 * collapsed edit row renders.
 *
 * Shared because the same Claude tool schema is parsed twice — once in the
 * bridge from SDK messages and once in the tmux store from rollout JSONL — and
 * two copies drifted the moment they existed. Returns `undefined` for a tool
 * this mapping does not recognise, leaving the caller's own fallback in charge.
 */
export function toolDiffFromToolInput(
  toolName: string | undefined,
  input: Record<string, unknown>,
): ToolDiffSides | undefined {
  if (!toolName) return undefined;
  const name = toolName.toLowerCase();
  const filePath = filePathFromToolInput(input);

  if (EDIT_LIKE_TOOLS.has(name)) {
    const before = stringField(input, "old_string", "oldString");
    const after = stringField(input, "new_string", "newString");
    return { filePath, before, after, ...lineChangeStatsFromSides(before, after) };
  }

  if (WRITE_LIKE_TOOLS.has(name)) {
    const after = stringField(input, "content");
    return { filePath, before: "", after, ...lineChangeStatsFromSides("", after) };
  }

  if (name === "multiedit") {
    return { filePath, ...multiEditSides(input) };
  }

  if (name === "notebookedit") {
    // A delete-mode cell edit carries no new source. Reporting zero additions
    // there would state a count nothing measured, so the stats are omitted and
    // the row falls back to showing the path alone.
    const after = stringField(input, "new_source", "newSource");
    return { filePath, after, ...lineChangeStatsFromSides(undefined, after) };
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function numberField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function nonEmptyStringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * OpenCode's `ctx.metadata({ metadata: { diff, filediff } })` can nest one
 * extra `metadata` layer. Unwrap only when the outer object itself has none
 * of the edit fields, so a real `{ metadata: { retries } }` sibling is left
 * alone.
 */
function unwrapOpenCodeMetadata(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nested = asRecord(record.metadata);
  if (
    nested &&
    record.filediff === undefined &&
    record.diff === undefined &&
    record.filepath === undefined &&
    record.file === undefined &&
    record.filePath === undefined &&
    record.path === undefined &&
    record.additions === undefined &&
    record.deletions === undefined &&
    (nested.filediff !== undefined ||
      nested.diff !== undefined ||
      nested.filepath !== undefined ||
      nested.file !== undefined ||
      nested.patch !== undefined)
  ) {
    return nested;
  }
  return record;
}

/**
 * OpenCode's edit/write title is `path.relative(worktree, filePath)`. A
 * generic status string must not become a file row.
 */
function pathLikeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  if (/[\\/]/.test(trimmed)) return trimmed;
  if (/\.[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  return undefined;
}

function countUnifiedDiffLines(diff: string): ToolLineChangeStats {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function outputLooksLikeUnifiedDiff(output: string): boolean {
  return output.includes("@@") && (output.includes("\n+") || output.includes("\n-"));
}

/**
 * Build the edit-row payload from an OpenCode tool part's input, metadata,
 * title, and output.
 *
 * OpenCode 1.18+ stores the real change on `state.metadata.filediff`
 * (`file` / `patch` / `additions` / `deletions`) and a one-line success
 * string in `output`. The model input may still have `filePath` /
 * `oldString` / `newString`; when it does not, the title is the relative
 * path. Both the live renderer and the backend projection have to read
 * this the same way, or the card shows "Unknown file".
 */
export function toolDiffFromOpenCodeToolState(args: {
  toolName?: string;
  input?: unknown;
  metadata?: unknown;
  title?: string;
  output?: string;
}): OpenCodeToolDiff | undefined {
  if (!isFileEditToolName(args.toolName)) return undefined;

  const input = asRecord(args.input) ?? {};
  const meta = unwrapOpenCodeMetadata(args.metadata) ?? {};
  const filediff = asRecord(meta.filediff);
  const mappedSides = toolDiffFromToolInput(args.toolName, input);

  const filePath =
    nonEmptyStringField(input, "filePath", "file_path", "path", "file", "filepath") ??
    nonEmptyStringField(meta, "file", "filePath", "filepath", "path") ??
    nonEmptyStringField(filediff, "file", "filePath", "filepath", "path") ??
    mappedSides?.filePath ??
    pathLikeTitle(args.title);

  const oldString = stringField(input, "oldString", "old_string");
  const newString = stringField(input, "newString", "new_string", "content");
  const metaBefore = stringField(filediff ?? {}, "before") ?? stringField(meta, "before");
  const metaAfter = stringField(filediff ?? {}, "after") ?? stringField(meta, "after");
  const unifiedDiff =
    stringField(meta, "diff") ??
    stringField(filediff ?? {}, "patch", "diff") ??
    stringField(input, "patch", "diff");

  // OpenCode-native sides win when present. Mapped Claude-shaped input
  // (MultiEdit `edits[]`, Write `content`) fills the gap so those tools
  // still get a before/after body and per-chunk counts.
  const nativeBefore = oldString ?? metaBefore;
  const nativeAfter = newString ?? metaAfter;
  const usingMappedSides = nativeBefore === undefined && nativeAfter === undefined;
  const before = usingMappedSides ? mappedSides?.before : nativeBefore;
  const after = usingMappedSides ? mappedSides?.after : nativeAfter;

  let additions: number | undefined;
  let deletions: number | undefined;
  const metaAdditions = numberField(meta, "additions");
  const metaDeletions = numberField(meta, "deletions");
  const filediffAdditions = numberField(filediff, "additions");
  const filediffDeletions = numberField(filediff, "deletions");

  if (metaAdditions !== undefined && metaDeletions !== undefined) {
    additions = metaAdditions;
    deletions = metaDeletions;
  } else if (filediffAdditions !== undefined && filediffDeletions !== undefined) {
    additions = filediffAdditions;
    deletions = filediffDeletions;
  } else if (unifiedDiff) {
    ({ additions, deletions } = countUnifiedDiffLines(unifiedDiff));
  } else if (args.output && outputLooksLikeUnifiedDiff(args.output)) {
    const counted = countUnifiedDiffLines(args.output);
    if (counted.additions > 0 || counted.deletions > 0) {
      additions = counted.additions;
      deletions = counted.deletions;
    }
  } else if (
    usingMappedSides &&
    (mappedSides?.additions !== undefined || mappedSides?.deletions !== undefined)
  ) {
    additions = mappedSides.additions;
    deletions = mappedSides.deletions;
  } else if (before !== undefined || after !== undefined) {
    const stats = lineChangeStatsFromSides(before, after);
    if (before && after) {
      deletions = stats?.deletions;
      additions = stats?.additions;
    } else if (after) {
      additions = stats?.additions ?? 0;
      deletions = 0;
    } else if (before) {
      additions = 0;
      deletions = stats?.deletions ?? 0;
    }
  }

  if (
    filePath === undefined &&
    before === undefined &&
    after === undefined &&
    unifiedDiff === undefined &&
    additions === undefined &&
    deletions === undefined
  ) {
    return undefined;
  }

  return { filePath, before, after, diff: unifiedDiff, additions, deletions };
}
