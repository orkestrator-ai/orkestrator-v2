/** Content-only evidence shared by live qualification and deterministic regressions. */
export type Row = { id?: unknown; role?: unknown; content?: unknown; parts?: unknown };
export type TrailReads = { dir: string; stopsRead(row: Row): number[] };

export function rowText(row: Row): string {
  if (typeof row.content === "string" && row.content) return row.content;
  return parts(row)
    .map((part) => text(part))
    .join("");
}

function parts(row: Row): Record<string, unknown>[] {
  return Array.isArray(row.parts)
    ? row.parts.filter(
        (part): part is Record<string, unknown> => typeof part === "object" && part !== null,
      )
    : [];
}

function text(part: Record<string, unknown>): string {
  return typeof part.text === "string"
    ? part.text
    : typeof part.content === "string"
      ? part.content
      : "";
}

export function repeatedPrompts(rows: Row[]): number {
  const prompts = rows.filter((row) => row.role === "user").map(rowText);
  return prompts.length - new Set(prompts).size;
}

/** Only publication revisions and measured times are volatile. Keep every other part field,
 * including tool ids, arguments, outputs and state. Never strip keys inside toolArgs/output. */
function displayPart(part: Record<string, unknown>): unknown {
  const {
    createdAt: _createdAt,
    toolDurationMs: _duration,
    elapsedMs: _elapsed,
    ...display
  } = part;
  for (const key of ["parts", "childTools", "subagentActions"]) {
    if (Array.isArray(display[key])) display[key] = display[key].map(displayPart);
  }
  return display;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Rows are ordered, ids are compared separately. Row envelope times/revisions/usage are
 * transport metadata; role, flat content and all normalized display parts must converge. */
export function sameDisplayedRows(client: Row[], provider: Row[]): boolean {
  const display = (rows: Row[]) =>
    rows.map((row) => ({
      role: row.role,
      content: row.content,
      parts: parts(row).map(displayPart),
    }));
  return stable(display(client)) === stable(display(provider));
}

function proseParts(row: Row): string[] {
  if (!parts(row).length) return rowText(row).trim() ? [rowText(row)] : [];
  return parts(row)
    .filter((part) => ["text", "thinking", "reasoning"].includes(String(part.type)))
    .map(text)
    .filter((value) => value.trim());
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Sentence boundaries survive row/part splitting and merging. An unfinished
 * final sentence remains a prefix so streamed text may grow after the crash. */
function proseUnits(rows: Row[]): string[] {
  // Do not manufacture a sentence across two observed responses: the first
  // response may still grow before the second one in a recovered transcript.
  // Search these units in a joined target stream so replay may split them.
  return rows
    .filter((row) => row.role === "assistant")
    .flatMap(proseParts)
    .flatMap((value) => normalized(value).split(/(?<=[.!?])\s+/));
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function tools(row: Row): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const part of values) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool-invocation") found.push(part);
      for (const key of ["parts", "childTools", "subagentActions"]) visit(part[key]);
    }
  };
  visit(row.parts);
  return found;
}

function trailRead(tool: Record<string, unknown>): string | undefined {
  if (!["bash", "exec_command", "exec"].includes(String(tool.toolName))) return undefined;
  const args = tool.toolArgs as Record<string, unknown> | undefined;
  const rawCommand = args?.cmd ?? args?.command;
  if (typeof rawCommand !== "string") return undefined;
  const command = rawCommand
    .trim()
    .replace(/^(?:\/[^\s]+\/)?(?:bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/, "$2");
  // This spec's command reads exactly one randomly named trail file. app-server
  // publishes bash + {command}; rollout keeps exec_command + {cmd, command,
  // workdir, yield_time_ms, max_output_tokens}, or code-mode exec + {input,
  // command} (the bridge extracts the command preview from the source). Compare
  // this single-file read and its count independently of that envelope.
  return command.match(/^cat\s+['"]?(trail-[0-9a-f]+\/[0-9a-f]{10}\.txt)['"]?$/)?.[1];
}

/** An exec replay carries the same path in both source and command preview.
 * Count the operation once, while distinct invocation parts remain distinct. */
export function trailStopsRead(row: Row, positions: ReadonlyMap<string, number>): number[] {
  return tools(row).flatMap((tool) => {
    const files = new Set(
      Array.from(
        JSON.stringify(tool.toolArgs ?? {}).matchAll(/([0-9a-f]{10})\.txt/g),
        (match) => `${match[1]}.txt`,
      ),
    );
    return Array.from(files).flatMap((file) => {
      const stop = positions.get(file);
      return stop === undefined ? [] : [stop];
    });
  });
}

function toolKey(tool: Record<string, unknown>): string {
  const file = trailRead(tool);
  if (file) return stable({ trailRead: file });
  // Other tools retain their full arguments; only live/replay ids and state differ.
  return stable({ name: tool.toolName, args: tool.toolArgs });
}

function toolResult(tool: Record<string, unknown>, key: string): string | undefined {
  const value = tool[key];
  if (typeof value !== "string") return undefined;
  if (!trailRead(tool)) return value;
  // exec_command's rollout output includes the tool runner receipt; the live
  // command item carries only stdout. Do not strip an arbitrary tool's output.
  return value
    .replace(
      /^Chunk ID:[^\n]*\nWall time:[^\n]*\n(?:Process exited with code[^\n]*\n|Process running with session ID[^\n]*\n)(?:Original token count:[^\n]*\n)?(?:Final output|Output):\n/,
      "",
    )
    .trim();
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function missing(before: string[], after: string[]): number {
  const available = counts(after);
  let lost = 0;
  for (const value of before) {
    const left = available.get(value) ?? 0;
    if (left === 0) lost += 1;
    else available.set(value, left - 1);
  }
  return lost;
}

/** Consume occurrences, rather than set membership. Joining prose makes provider row
 * splits irrelevant; containment still allows a partial streamed reply/output to grow. */
export function lostContent(
  before: Row[],
  after: Row[],
  trails: TrailReads[],
): { prompts: number; stops: number; replies: number } {
  const repliesAfter = normalized(
    after
      .filter((row) => row.role === "assistant")
      .flatMap(proseParts)
      .join(" "),
  );
  const repliesBefore = proseUnits(before);
  let replies = 0;
  for (const [prose, count] of counts(repliesBefore))
    replies += Math.max(0, count - occurrences(repliesAfter, prose));
  // A cached pending call may have completed, but its input and any output already shown
  // must exist in the authoritative transcript, independent of replay's new row ids.
  const availableTools = after.flatMap(tools);
  for (const tool of before.flatMap(tools)) {
    const index = availableTools.findIndex(
      (candidate) =>
        toolKey(candidate) === toolKey(tool) &&
        ["toolOutput", "toolError"].every((key) => {
          const expected = toolResult(tool, key);
          // A completed failure moves stdout from toolOutput to toolError.
          // The cached text still exists when either terminal field holds it.
          return (
            expected === undefined ||
            ["toolOutput", "toolError"].some((field) =>
              (toolResult(candidate, field) ?? "").includes(expected),
            )
          );
        }),
    );
    if (index < 0) replies += 1;
    else availableTools.splice(index, 1);
  }
  const stops = (rows: Row[]) =>
    trails.flatMap((trail) =>
      rows.flatMap((row) => trail.stopsRead(row).map((stop) => `${trail.dir}:${stop}`)),
    );
  return {
    prompts: missing(
      before.filter((row) => row.role === "user").map(rowText),
      after.filter((row) => row.role === "user").map(rowText),
    ),
    stops: missing(stops(before), stops(after)),
    replies,
  };
}

/** Match each existing prompt's response independently. Explicit follow-up and restart
 * continuation prompts start a new segment and may intentionally re-read an earlier file. */
function segments(rows: Row[]): Array<{ prompt: string; rows: Row[] }> {
  const result: Array<{ prompt: string; rows: Row[] }> = [{ prompt: "", rows: [] }];
  for (const row of rows) {
    if (row.role === "user") result.push({ prompt: rowText(row), rows: [] });
    else result.at(-1)!.rows.push(row);
  }
  return result;
}

/** Compare prose only through the last observed tool when the original turn
 * has made new progress. New model steps may legitimately repeat boilerplate;
 * they are not replay. Tool occurrence counts still cover the entire segment. */
function replayProseRange(before: Row[], after: Row[]): { before: Row[]; after: Row[] } {
  const oldKeys = counts(before.flatMap(tools).map(toolKey));
  if (!after.flatMap(tools).some((tool) => !oldKeys.has(toolKey(tool)))) return { before, after };
  const lastOldTool = before.flatMap(tools).at(-1);
  if (!lastOldTool) return { before: [], after: [] };
  const frontier = toolKey(lastOldTool);
  const ordinal = oldKeys.get(frontier)!;
  const throughFrontier = (rows: Row[]) => {
    let seen = 0;
    for (let i = 0; i < rows.length; i++) {
      for (const tool of tools(rows[i]!)) {
        if (toolKey(tool) === frontier && ++seen === ordinal) return rows.slice(0, i + 1);
      }
    }
    return rows;
  };
  return { before: throughFrontier(before), after: throughFrontier(after) };
}

export function duplicatedContent(before: Row[], after: Row[]): { replies: number; tools: number } {
  const result = { replies: 0, tools: 0 };
  const afterSegments = segments(after);
  let offset = 0;
  for (const segment of segments(before)) {
    const index = afterSegments.findIndex(
      (candidate, i) => i >= offset && candidate.prompt === segment.prompt,
    );
    if (index < 0) continue; // Loss is checked separately.
    offset = index + 1;
    const next = afterSegments[index]!.rows;
    const replay = replayProseRange(segment.rows, next);
    const oldText = normalized(
      replay.before
        .filter((row) => row.role === "assistant")
        .flatMap(proseParts)
        .join(" "),
    );
    const newText = normalized(
      replay.after
        .filter((row) => row.role === "assistant")
        .flatMap(proseParts)
        .join(" "),
    );
    // Keep each observed response part as a candidate too: an intermediate
    // response need not end with punctuation, and replay may merge it with the
    // next response. Count candidates in the joined stream, never by row id.
    const observedParts = replay.before
      .filter((row) => row.role === "assistant")
      .flatMap(proseParts)
      .map(normalized);
    for (const prose of new Set([...proseUnits(replay.before), ...observedParts])) {
      result.replies += Math.max(0, occurrences(newText, prose) - occurrences(oldText, prose));
    }
    const oldTools = counts(segment.rows.flatMap(tools).map(toolKey));
    const newTools = counts(next.flatMap(tools).map(toolKey));
    for (const [key, count] of oldTools)
      result.tools += Math.max(0, (newTools.get(key) ?? 0) - count);
  }
  return result;
}

export function trailOrder(
  rows: Row[],
  stopsRead: (row: Row) => number[],
): { highest: number; outOfOrder: number; duplicates: number } {
  let highest = 0;
  let outOfOrder = 0;
  let duplicates = 0;
  let seen = new Set<number>();
  for (const row of rows) {
    if (row.role === "user") seen = new Set();
    for (const stop of stopsRead(row)) {
      if (seen.has(stop)) duplicates += 1;
      else if (stop > highest) {
        if (stop !== highest + 1) outOfOrder += 1;
        highest = stop;
      }
      seen.add(stop);
    }
  }
  return { highest, outOfOrder, duplicates };
}
