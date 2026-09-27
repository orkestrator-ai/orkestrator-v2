/**
 * Minimal, format-preserving edits for JSON and JSONC documents.
 *
 * A one-server change must not pretty-print a whole `~/.claude.json` (which
 * holds unrelated project history) or strip a user's comments from an
 * `opencode.jsonc`. These helpers locate the exact byte range of a property
 * and splice only that range. Every caller re-parses the result and compares
 * it semantically with the intended document before committing it.
 */

export type JsonPath = readonly string[];

export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonEditError";
  }
}

type Node =
  | { type: "object"; start: number; end: number; properties: PropertyNode[] }
  | { type: "array"; start: number; end: number; items: Node[] }
  | { type: "value"; start: number; end: number };

type PropertyNode = {
  key: string;
  /** Start of the key's opening quote. */
  start: number;
  keyStart: number;
  keyEnd: number;
  value: Node;
};

class Scanner {
  index = 0;
  constructor(
    readonly text: string,
    readonly allowComments: boolean,
  ) {}

  skipTrivia(): void {
    const text = this.text;
    while (this.index < text.length) {
      const char = text[this.index]!;
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\uFEFF") {
        this.index += 1;
      } else if (this.allowComments && char === "/" && text[this.index + 1] === "/") {
        const newline = text.indexOf("\n", this.index);
        this.index = newline < 0 ? text.length : newline;
      } else if (this.allowComments && char === "/" && text[this.index + 1] === "*") {
        const close = text.indexOf("*/", this.index + 2);
        if (close < 0) throw new JsonEditError("Unterminated comment.");
        this.index = close + 2;
      } else {
        return;
      }
    }
  }

  fail(message: string): never {
    throw new JsonEditError(`${message} at offset ${this.index}.`);
  }

  parseValue(): Node {
    this.skipTrivia();
    const char = this.text[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') {
      const start = this.index;
      this.parseString();
      return { type: "value", start, end: this.index };
    }
    const start = this.index;
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.text.slice(start, start + 64),
    );
    if (!match) this.fail("Unexpected token");
    this.index += match[0].length;
    return { type: "value", start, end: this.index };
  }

  parseString(): string {
    const start = this.index;
    this.index += 1;
    const text = this.text;
    while (this.index < text.length) {
      const char = text[this.index]!;
      if (char === "\\") {
        this.index += 2;
      } else if (char === '"') {
        this.index += 1;
        return JSON.parse(text.slice(start, this.index)) as string;
      } else if (char === "\n") {
        this.fail("Unterminated string");
      } else {
        this.index += 1;
      }
    }
    this.fail("Unterminated string");
  }

  parseObject(): Node {
    const start = this.index;
    this.index += 1;
    const properties: PropertyNode[] = [];
    this.skipTrivia();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { type: "object", start, end: this.index, properties };
    }
    for (;;) {
      this.skipTrivia();
      if (this.allowComments && this.text[this.index] === "}" && properties.length) {
        this.index += 1;
        return { type: "object", start, end: this.index, properties };
      }
      if (this.text[this.index] !== '"') this.fail("Expected property name");
      const keyStart = this.index;
      const key = this.parseString();
      const keyEnd = this.index;
      this.skipTrivia();
      if (this.text[this.index] !== ":") this.fail("Expected ':'");
      this.index += 1;
      const value = this.parseValue();
      properties.push({ key, start: keyStart, keyStart, keyEnd, value });
      this.skipTrivia();
      const next = this.text[this.index];
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "}") {
        this.index += 1;
        return { type: "object", start, end: this.index, properties };
      }
      this.fail("Expected ',' or '}'");
    }
  }

  parseArray(): Node {
    const start = this.index;
    this.index += 1;
    const items: Node[] = [];
    this.skipTrivia();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { type: "array", start, end: this.index, items };
    }
    for (;;) {
      this.skipTrivia();
      if (this.allowComments && this.text[this.index] === "]" && items.length) {
        this.index += 1;
        return { type: "array", start, end: this.index, items };
      }
      items.push(this.parseValue());
      this.skipTrivia();
      const next = this.text[this.index];
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "]") {
        this.index += 1;
        return { type: "array", start, end: this.index, items };
      }
      this.fail("Expected ',' or ']'");
    }
  }
}

export interface JsonDocument {
  text: string;
  allowComments: boolean;
  root: Node;
}

export function parseJsonDocument(text: string, allowComments: boolean): JsonDocument {
  const scanner = new Scanner(text, allowComments);
  const root = scanner.parseValue();
  scanner.skipTrivia();
  if (scanner.index !== text.length) scanner.fail("Unexpected trailing content");
  return { text, allowComments, root };
}

/** Semantic parse with the same comment rules as the editor. */
export function parseJsonValue(text: string, allowComments: boolean): unknown {
  parseJsonDocument(text, allowComments);
  return allowComments ? Bun.JSONC.parse(text) : JSON.parse(text);
}

function findNode(root: Node, path: JsonPath): Node | undefined {
  let node: Node | undefined = root;
  for (const segment of path) {
    if (!node || node.type !== "object") return undefined;
    node = findLastProperty(node, segment)?.value;
  }
  return node;
}

/** JSON takes the last duplicate key; so do we. */
function findLastProperty(node: Node & { type: "object" }, key: string): PropertyNode | undefined {
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    if (node.properties[index]!.key === key) return node.properties[index];
  }
  return undefined;
}

function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return "  ";
  const indent = match[1]!;
  if (indent.startsWith("\t")) return "\t";
  return indent.length >= 2 && indent.length % 2 === 0
    ? " ".repeat(Math.min(indent.length, 4))
    : "  ";
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : "";
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Serialize `value` so continuation lines sit at `baseIndent`. */
function formatValue(value: unknown, unit: string, baseIndent: string, eol: string): string {
  const text = JSON.stringify(value, null, unit);
  if (text === undefined) throw new JsonEditError("Value is not serializable.");
  return text.split("\n").join(`${eol}${baseIndent}`);
}

function isCompactObject(text: string, node: Node & { type: "object" }): boolean {
  return !text.slice(node.start, node.end).includes("\n");
}

function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

/**
 * Set `path` to `value`, creating missing parent objects. Existing values are
 * replaced in place; new properties are appended to their object.
 */
export function setJsonValue(
  text: string,
  path: JsonPath,
  value: unknown,
  allowComments: boolean,
): string {
  if (!path.length) throw new JsonEditError("Refusing to replace the whole document.");
  const eol = detectEol(text);
  const unit = detectIndentUnit(text);
  if (text.trim() === "") {
    let nested: unknown = value;
    for (let index = path.length - 1; index >= 0; index -= 1) nested = { [path[index]!]: nested };
    return `${JSON.stringify(nested, null, unit).split("\n").join(eol)}${eol}`;
  }
  const document = parseJsonDocument(text, allowComments);
  // Walk to the deepest existing object on the path.
  let parent: Node = document.root;
  let depth = 0;
  for (; depth < path.length - 1; depth += 1) {
    if (parent.type !== "object")
      throw new JsonEditError(`${path.slice(0, depth).join(".")} is not an object.`);
    const property = findLastProperty(parent, path[depth]!);
    if (!property) break;
    parent = property.value;
  }
  if (parent.type !== "object")
    throw new JsonEditError(`${path.slice(0, depth).join(".")} is not an object.`);

  if (depth === path.length - 1) {
    const existing = findLastProperty(parent, path[depth]!);
    if (existing) {
      const indent = lineIndentAt(text, existing.start);
      const compact =
        !text.slice(existing.value.start, existing.value.end).includes("\n") &&
        isCompactObject(text, parent);
      const formatted = compact ? JSON.stringify(value) : formatValue(value, unit, indent, eol);
      return splice(text, existing.value.start, existing.value.end, formatted);
    }
  }
  // Build the remaining nested value and insert it as a new property.
  let nested: unknown = value;
  for (let index = path.length - 1; index > depth; index -= 1) nested = { [path[index]!]: nested };
  return insertProperty(text, parent, path[depth]!, nested, unit, eol);
}

function insertProperty(
  text: string,
  object: Node & { type: "object" },
  key: string,
  value: unknown,
  unit: string,
  eol: string,
): string {
  const objectIndent = lineIndentAt(text, object.start);
  if (!object.properties.length) {
    const indent = objectIndent + unit;
    const insert = `${eol}${indent}${JSON.stringify(key)}: ${formatValue(value, unit, indent, eol)}${eol}${objectIndent}`;
    if (/\/\/|\/\*/.test(text.slice(object.start + 1, object.end - 1))) {
      return splice(text, object.start + 1, object.start + 1, insert);
    }
    return splice(text, object.start + 1, object.end - 1, insert);
  }
  const last = object.properties[object.properties.length - 1]!;
  if (isCompactObject(text, object)) {
    const insert = `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    return splice(text, last.value.end, last.value.end, insert);
  }
  const indent = lineIndentAt(text, last.start);
  // Respect an existing JSONC trailing comma after the last property.
  const scanner = new Scanner(text, true);
  scanner.index = last.value.end;
  scanner.skipTrivia();
  const hasTrailingComma = text[scanner.index] === ",";
  const property = `${JSON.stringify(key)}: ${formatValue(value, unit, indent, eol)}`;
  const commentLineEnd = trailingLineCommentEnd(text, last.value.end, object.end - 1);
  if (commentLineEnd !== null) {
    const addedComma = hasTrailingComma ? text : splice(text, last.value.end, last.value.end, ",");
    const shifted = hasTrailingComma ? commentLineEnd : commentLineEnd + 1;
    return splice(
      addedComma,
      shifted,
      shifted,
      `${indent}${property}${hasTrailingComma ? "," : ""}${eol}`,
    );
  }
  if (hasTrailingComma) {
    return splice(text, scanner.index + 1, scanner.index + 1, `${eol}${indent}${property},`);
  }
  // Insert directly after the last value when no trailing comment owns its line.
  return splice(text, last.value.end, last.value.end, `,${eol}${indent}${property}`);
}

function trailingLineCommentEnd(text: string, from: number, to: number): number | null {
  let index = from;
  while (index < to) {
    if (/\s|,/.test(text[index]!)) {
      index += 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? to : end + 2;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index + 2);
      return end < 0 || end >= to ? null : end + 1;
    } else {
      break;
    }
  }
  return null;
}

/** Remove `path` if present. Returns the original text when absent. */
export function removeJsonValue(text: string, path: JsonPath, allowComments: boolean): string {
  if (!path.length) throw new JsonEditError("Refusing to remove the whole document.");
  if (text.trim() === "") return text;
  const document = parseJsonDocument(text, allowComments);
  const parent = findNode(document.root, path.slice(0, -1));
  if (!parent || parent.type !== "object") return text;
  const key = path[path.length - 1]!;
  let result = text;
  // Remove every duplicate, last first, so offsets stay valid.
  const matches = parent.properties
    .map((property, index) => ({ property, index }))
    .filter(({ property }) => property.key === key)
    .reverse();
  for (const { index } of matches) {
    const reparsed = findNode(parseJsonDocument(result, allowComments).root, path.slice(0, -1));
    if (!reparsed || reparsed.type !== "object") break;
    result = removePropertyAt(result, reparsed, index);
  }
  return result;
}

function removePropertyAt(text: string, object: Node & { type: "object" }, index: number): string {
  const property = object.properties[index]!;
  const previous = object.properties[index - 1];
  const next = object.properties[index + 1];
  if (next) {
    // Keep trivia before the next key: a standalone comment can document it.
    const from = lineStartIfOnlyWhitespace(text, property.start);
    const comma = text.indexOf(",", property.value.end);
    if (comma < 0 || comma >= next.start) throw new JsonEditError("Missing property separator.");
    let to = comma + 1;
    while (text[to] === " " || text[to] === "\t") to += 1;
    if (text.startsWith("//", to)) {
      const newline = text.indexOf("\n", to);
      to = newline < 0 ? text.length : newline + 1;
      return splice(text, from, to, "");
    }
    if (text[to] === "\r") to += 1;
    if (text[to] === "\n") to += 1;
    else to = comma + 1;
    return splice(text, from, to, "");
  }
  if (previous) {
    // Last property: drop the comma after the previous value through this value.
    const scanner = new Scanner(text, true);
    scanner.index = property.value.end;
    scanner.skipTrivia();
    const end = text[scanner.index] === "," ? scanner.index + 1 : property.value.end;
    return splice(text, previous.value.end, end, "");
  }
  // Only property: remove its key and value, retaining comments in the interior.
  const from = lineStartIfOnlyWhitespace(text, property.start);
  const end = text[property.value.end] === "," ? property.value.end + 1 : property.value.end;
  return splice(text, from, end, "");
}

function lineStartIfOnlyWhitespace(text: string, offset: number): number {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, offset)) ? lineStart : offset;
}

/** Rename the last `path` key in place, keeping its value text byte-for-byte. */
export function renameJsonKey(
  text: string,
  path: JsonPath,
  newKey: string,
  allowComments: boolean,
): string {
  const document = parseJsonDocument(text, allowComments);
  const parent = findNode(document.root, path.slice(0, -1));
  if (!parent || parent.type !== "object") throw new JsonEditError("Parent object not found.");
  const property = findLastProperty(parent, path[path.length - 1]!);
  if (!property) throw new JsonEditError("Property not found.");
  if (findLastProperty(parent, newKey)) throw new JsonEditError("Destination key exists.");
  return splice(text, property.keyStart, property.keyEnd, JSON.stringify(newKey));
}

/** Count properties with `key` in the object at `path` (duplicate-key detection). */
export function countJsonKeys(
  text: string,
  path: JsonPath,
  allowComments: boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (text.trim() === "") return counts;
  const node = findNode(parseJsonDocument(text, allowComments).root, path);
  if (!node || node.type !== "object") return counts;
  for (const property of node.properties)
    counts.set(property.key, (counts.get(property.key) ?? 0) + 1);
  return counts;
}
