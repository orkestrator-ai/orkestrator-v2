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
