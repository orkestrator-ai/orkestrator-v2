/**
 * Minimal, format-preserving edits for provider TOML (Codex and Grok
 * `config.toml`).
 *
 * Bun can parse TOML but cannot edit it without discarding comments and
 * formatting. This module lexes just enough TOML to find the exact text range
 * of every table header and key/value, and edits only the server entry being
 * changed. Unchanged keys keep their original text, so an integer/float or
 * string style the provider depends on is never silently rewritten.
 *
 * Only the canonical layout is editable: a server defined as `[root.name]`
 * tables (optionally with `[root.name.sub]` tables). A server defined inline
 * (`name = { ... }` under `[root]`) or through dotted keys elsewhere is
 * reported as an unsupported layout and stays read-only. Every edit is verified
 * by re-parsing the result and comparing it with the intended document.
 */

export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

export interface TomlHeader {
  path: string[];
  isArray: boolean;
  /** Offset of the first leading comment line attached to the header, or the header. */
  leadStart: number;
  start: number;
  /** Offset just past the header line's newline. */
  lineEnd: number;
}

export interface TomlKeyValue {
  /** Header path of the table this key belongs to. */
  table: string[];
  tableIndex: number;
  keyPath: string[];
  /** Line start of the key. */
  start: number;
  valueStart: number;
  valueEnd: number;
  /** Offset just past the line's newline (after any trailing comment). */
  lineEnd: number;
}

export interface TomlLayout {
  headers: TomlHeader[];
  keyValues: TomlKeyValue[];
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function formatTomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

export function formatTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TomlEditError("Non-finite numbers are not supported.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    );
    if (!entries.length) return "{}";
    return `{ ${entries.map(([key, item]) => `${formatTomlKey(key)} = ${formatTomlValue(item)}`).join(", ")} }`;
  }
  throw new TomlEditError("Unsupported TOML value.");
}

class Lexer {
  index = 0;
  constructor(readonly text: string) {}

  fail(message: string): never {
    throw new TomlEditError(`${message} at offset ${this.index}.`);
  }

  peek(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }

  skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.index += 1;
  }

  skipToLineEnd(): void {
    const newline = this.text.indexOf("\n", this.index);
    this.index = newline < 0 ? this.text.length : newline + 1;
  }

  /** Skip a string starting at the current quote. */
  skipString(): string {
    const text = this.text;
    const quote = text[this.index]!;
    const triple = text.startsWith(quote.repeat(3), this.index);
    const start = this.index;
    if (triple) {
      this.index += 3;
      for (;;) {
        if (this.index >= text.length) this.fail("Unterminated multi-line string");
        if (quote === '"' && text[this.index] === "\\") {
          this.index += 2;
          continue;
        }
        if (text.startsWith(quote.repeat(3), this.index)) {
          this.index += 3;
          // Up to two extra quotes may close a multi-line string.
          while (text[this.index] === quote && this.index - start < text.length) this.index += 1;
          return text.slice(start, this.index);
        }
        this.index += 1;
      }
    }
    this.index += 1;
    for (;;) {
      const char = text[this.index];
      if (char === undefined || char === "\n") this.fail("Unterminated string");
      if (quote === '"' && char === "\\") {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (char === quote) return text.slice(start, this.index);
    }
  }

  readKeySegment(): string {
    const char = this.peek();
    if (char === '"' || char === "'") {
      const raw = this.skipString();
      if (raw.startsWith('"""') || raw.startsWith("'''")) this.fail("Multi-line key");
      return char === '"'
        ? (JSON.parse(
            raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex) =>
              String.fromCodePoint(parseInt(hex, 16)),
            ),
          ) as string)
        : raw.slice(1, -1);
    }
    const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.index, this.index + 1024));
    if (!match) this.fail("Invalid key");
    this.index += match[0].length;
    return match[0];
  }

  readKeyPath(terminator: string): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipSpaces();
      path.push(this.readKeySegment());
      this.skipSpaces();
      if (this.peek() === ".") {
        this.index += 1;
        continue;
      }
      if (!this.text.startsWith(terminator, this.index)) this.fail(`Expected '${terminator}'`);
      return path;
    }
  }

  /** Skip a value, returning its end offset (before trailing spaces/comment). */
  skipValue(): number {
    const text = this.text;
    let depth = 0;
    let end = this.index;
    for (;;) {
      const char = text[this.index];
      if (char === undefined) {
        if (depth) this.fail("Unterminated array or inline table");
        return end;
      }
      if (char === '"' || char === "'") {
        this.skipString();
        end = this.index;
        continue;
      }
      if (char === "[" || char === "{") {
        depth += 1;
        this.index += 1;
        end = this.index;
        continue;
      }
      if (char === "]" || char === "}") {
        depth -= 1;
        if (depth < 0) this.fail("Unbalanced bracket");
        this.index += 1;
        end = this.index;
        continue;
      }
      if (char === "#") {
        if (!depth) return end;
        this.skipToLineEnd();
        continue;
      }
      if (char === "\n" || char === "\r") {
        if (!depth) return end;
        this.index += 1;
        continue;
      }
      if (char === " " || char === "\t" || char === ",") {
        this.index += 1;
        if (char === "," && depth) end = this.index;
        continue;
      }
      this.index += 1;
      end = this.index;
    }
  }
}

export function scanTomlLayout(text: string): TomlLayout {
  const lexer = new Lexer(text);
  const headers: TomlHeader[] = [];
  const keyValues: TomlKeyValue[] = [];
  let table: string[] = [];
  let tableIndex = -1;
  let commentRunStart: number | null = null;
  while (lexer.index < text.length) {
    const lineStart = lexer.index;
    lexer.skipSpaces();
    const char = lexer.peek();
    if (char === undefined) break;
    if (char === "\n" || char === "\r") {
      commentRunStart = null;
      lexer.skipToLineEnd();
      continue;
    }
    if (char === "#") {
      commentRunStart ??= lineStart;
      lexer.skipToLineEnd();
      continue;
    }
    if (char === "[") {
      const isArray = lexer.peek(1) === "[";
      lexer.index += isArray ? 2 : 1;
      const path = lexer.readKeyPath(isArray ? "]]" : "]");
      lexer.index += isArray ? 2 : 1;
      lexer.skipSpaces();
      if (lexer.peek() === "#") lexer.skipToLineEnd();
      else if (lexer.peek() === "\r" || lexer.peek() === "\n" || lexer.peek() === undefined)
        lexer.skipToLineEnd();
      else lexer.fail("Unexpected content after table header");
      headers.push({
        path,
        isArray,
        leadStart: commentRunStart ?? lineStart,
        start: lineStart,
        lineEnd: lexer.index,
      });
      table = path;
      tableIndex = headers.length - 1;
      commentRunStart = null;
      continue;
    }
    commentRunStart = null;
    const keyPath = lexer.readKeyPath("=");
    lexer.index += 1;
    lexer.skipSpaces();
    const valueStart = lexer.index;
    const valueEnd = lexer.skipValue();
    lexer.index = valueEnd;
    lexer.skipSpaces();
    if (
      lexer.peek() === "#" ||
      lexer.peek() === "\r" ||
      lexer.peek() === "\n" ||
      lexer.peek() === undefined
    ) {
      lexer.skipToLineEnd();
    } else {
      lexer.fail("Unexpected content after value");
    }
    keyValues.push({
      table,
      tableIndex,
      keyPath,
      start: lineStart,
      valueStart,
      valueEnd,
      lineEnd: lexer.index,
    });
  }
  return { headers, keyValues };
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function equalPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && startsWith(left, right);
}

export type TomlEntryLayout =
  | { kind: "absent" }
  | { kind: "tables"; main: number; blocks: number[] }
  | { kind: "unsupported"; reason: string };

/** Where the root map itself is defined, for add support. */
export function tomlRootLayout(layout: TomlLayout, root: readonly string[]): "ok" | "unsupported" {
  for (const entry of layout.keyValues) {
    const full = [...entry.table, ...entry.keyPath];
    // `mcp_servers = {...}` or `mcp_servers.x = ...` at a parent level, or a
    // `[mcp_servers]` table carrying inline servers, cannot take `[root.name]`.
    if (
      startsWith(root, full) ||
      (startsWith(full, root) && full.length > root.length && !startsWith(entry.table, root))
    ) {
      return "unsupported";
    }
    if (equalPath(entry.table, root)) return "unsupported";
  }
  for (const header of layout.headers) {
    if (header.isArray && startsWith(root, header.path)) return "unsupported";
  }
  return "ok";
}

export function tomlEntryLayout(
  layout: TomlLayout,
  root: readonly string[],
  name: string,
): TomlEntryLayout {
  const entryPath = [...root, name];
  const blocks: number[] = [];
  let main = -1;
  layout.headers.forEach((header, index) => {
    if (!startsWith(header.path, entryPath)) return;
    blocks.push(index);
    if (equalPath(header.path, entryPath)) {
      if (header.isArray) main = -2;
      else if (main === -1) main = index;
    }
  });
  const stray = layout.keyValues.some((entry) => {
    const full = [...entry.table, ...entry.keyPath];
    return startsWith(full, entryPath) && !startsWith(entry.table, entryPath);
  });
  if (stray) return { kind: "unsupported", reason: "defined with dotted keys or an inline table" };
  if (main === -2) return { kind: "unsupported", reason: "defined as an array of tables" };
  if (!blocks.length) return { kind: "absent" };
  if (main < 0) return { kind: "unsupported", reason: "defined only through sub-tables" };
  return { kind: "tables", main, blocks };
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * End of a table block: past its last key/value line and any blank lines that
 * follow, but never into the next header's attached comments. Standalone
 * comments after a blank line belong to nobody and are kept.
 */
function blockEnd(text: string, layout: TomlLayout, headerIndex: number): number {
  const header = layout.headers[headerIndex]!;
  let end = header.lineEnd;
  for (const kv of layout.keyValues)
    if (kv.tableIndex === headerIndex) end = Math.max(end, kv.lineEnd);
  const limit = layout.headers[headerIndex + 1]?.leadStart ?? text.length;
  for (;;) {
    const match = /^[ \t]*\r?\n/.exec(text.slice(end, limit));
    if (!match) break;
    end += match[0].length;
  }
  if (limit === text.length && /^[ \t]*$/.test(text.slice(end))) end = text.length;
  return end;
}

function serializeEntryTable(path: string[], entry: Record<string, unknown>, eol: string): string {
  const lines = [`[${path.map(formatTomlKey).join(".")}]`];
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
  }
  return lines.join(eol) + eol;
}

/** Append a new `[root.name]` table. */
export function addTomlEntry(
  text: string,
  root: string[],
  name: string,
  entry: Record<string, unknown>,
): string {
  const layout = scanTomlLayout(text);
  if (tomlRootLayout(layout, root) === "unsupported") {
    throw new TomlEditError("The server map is not defined with tables.");
  }
  if (tomlEntryLayout(layout, root, name).kind !== "absent")
    throw new TomlEditError("Entry exists.");
  const eol = eolOf(text);
  const block = serializeEntryTable([...root, name], entry, eol);
  if (!text.trim()) return block;
  const trimmed = text.replace(/[\r\n]*$/, "");
  return `${trimmed}${eol}${eol}${block}`;
}

export function removeTomlEntry(text: string, root: string[], name: string): string {
  const layout = scanTomlLayout(text);
  const entry = tomlEntryLayout(layout, root, name);
  if (entry.kind === "absent") return text;
  if (entry.kind === "unsupported") throw new TomlEditError(`Entry is ${entry.reason}.`);
  let result = text;
  // Back to front, so earlier offsets stay valid.
  for (const index of [...entry.blocks].reverse()) {
    const header = layout.headers[index]!;
    const end = blockEnd(text, layout, index);
    if (end === text.length) {
      // Removing the final block: also drop the blank lines that separated it.
      const head = result.slice(0, header.leadStart).replace(/\s*$/, "");
      result = head ? `${head}${eolOf(text)}` : "";
      continue;
    }
    result = result.slice(0, header.leadStart) + result.slice(end);
  }
  return result;
}

export function renameTomlEntry(
  text: string,
  root: string[],
  name: string,
  newName: string,
): string {
  const layout = scanTomlLayout(text);
  const entry = tomlEntryLayout(layout, root, name);
  if (entry.kind !== "tables") throw new TomlEditError("Entry cannot be renamed in this layout.");
  if (tomlEntryLayout(layout, root, newName).kind !== "absent")
    throw new TomlEditError("Destination exists.");
  let result = text;
  for (const index of [...entry.blocks].reverse()) {
    const header = layout.headers[index]!;
    const path = [...header.path];
    path[root.length] = newName;
    const open = header.isArray ? "[[" : "[";
    const close = header.isArray ? "]]" : "]";
    // Keep any trailing comment on the header line.
    const line = result.slice(header.start, header.lineEnd);
    const closeAt = findHeaderClose(line, header.isArray);
    const replacement = `${line.match(/^[ \t]*/)![0]}${open}${path.map(formatTomlKey).join(".")}${close}${line.slice(closeAt)}`;
    result = result.slice(0, header.start) + replacement + result.slice(header.lineEnd);
  }
  return result;
}

function findHeaderClose(line: string, isArray: boolean): number {
  const lexer = new Lexer(line);
  lexer.skipSpaces();
  lexer.index += isArray ? 2 : 1;
  lexer.readKeyPath(isArray ? "]]" : "]");
  return lexer.index + (isArray ? 2 : 1);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (typeof left === "object") {
    if (Array.isArray(right)) return false;
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

export { deepEqual as tomlDeepEqual };

/**
 * Rewrite one `[root.name]` entry to `next`, touching only keys whose value
 * changed. Changed nested tables are rewritten as inline tables in the main
 * table; sub-table blocks for those keys are removed.
 */
export function updateTomlEntry(
  text: string,
  root: string[],
  name: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string {
  const layout = scanTomlLayout(text);
  const entry = tomlEntryLayout(layout, root, name);
  if (entry.kind !== "tables") throw new TomlEditError("Entry cannot be edited in this layout.");
  const entryPath = [...root, name];
  const eol = eolOf(text);
  type Edit = { start: number; end: number; insert: string };
  const edits: Edit[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const mainKeyValues = layout.keyValues.filter((kv) => kv.tableIndex === entry.main);
  const additions: string[] = [];
  for (const key of keys) {
    if (deepEqual(previous[key], next[key])) continue;
    const direct = mainKeyValues.filter((kv) => kv.keyPath.length === 1 && kv.keyPath[0] === key);
    const dotted = mainKeyValues.filter((kv) => kv.keyPath.length > 1 && kv.keyPath[0] === key);
    const subBlocks = entry.blocks.filter((index) => {
      const path = layout.headers[index]!.path;
      return path.length > entryPath.length && path[entryPath.length] === key;
    });
    const value = next[key];
    for (const kv of dotted) edits.push({ start: kv.start, end: kv.lineEnd, insert: "" });
    for (const index of subBlocks) {
      edits.push({
        start: layout.headers[index]!.leadStart,
        end: blockEnd(text, layout, index),
        insert: "",
      });
    }
    if (direct.length === 1 && value !== undefined && !dotted.length && !subBlocks.length) {
      edits.push({
        start: direct[0]!.valueStart,
        end: direct[0]!.valueEnd,
        insert: formatTomlValue(value),
      });
      continue;
    }
    for (const kv of direct) edits.push({ start: kv.start, end: kv.lineEnd, insert: "" });
    if (value !== undefined) additions.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
  }
  if (additions.length) {
    const lastKv = mainKeyValues[mainKeyValues.length - 1];
    const header = layout.headers[entry.main]!;
    const at = lastKv ? lastKv.lineEnd : header.lineEnd;
    const needsNewline = at > 0 && text[at - 1] !== "\n";
    edits.push({
      start: at,
      end: at,
      insert: `${needsNewline ? eol : ""}${additions.join(eol)}${eol}`,
    });
  }
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let result = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    if (edit.end > floor) throw new TomlEditError("Overlapping edits.");
    result = result.slice(0, edit.start) + edit.insert + result.slice(edit.end);
    floor = edit.start;
  }
  return result;
}
