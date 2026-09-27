/**
 * Format-level access to one source's server map: read entries, apply one
 * edit, and prove the edit did exactly what was intended.
 *
 * Verification is semantic and whole-document. After editing, the new text is
 * parsed and compared with the old document with the one intended change
 * applied in memory. Any difference anywhere — an unrelated server, a
 * top-level setting, project history in `~/.claude.json` — aborts the write.
 */

import { isForbiddenMapKey, mcpFailure } from "@orkestrator/protocol/mcp-management";

import {
  JsonEditError,
  countJsonKeys,
  parseJsonValue,
  removeJsonValue,
  renameJsonKey,
  setJsonValue,
} from "./json-edit.js";
import {
  TomlEditError,
  addTomlEntry,
  removeTomlEntry,
  renameTomlEntry,
  scanTomlLayout,
  tomlDeepEqual,
  tomlEntryLayout,
  tomlRootLayout,
  updateTomlEntry,
} from "./toml-edit.js";
import type { NativeEntry, SourceSpec } from "./types.js";

export interface ParsedSource {
  /** Server map path actually used (Pi may fall back to a bare map). */
  subtree: string[];
  entries: Map<string, NativeEntry>;
  /** Entries that exist but cannot be edited safely, with the reason. */
  entryIssues: Map<string, string>;
  /** Set when new entries cannot be added to this document's layout. */
  addBlock?: string;
  document: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(document: unknown, path: readonly string[]): unknown {
  let node = document;
  for (const segment of path) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

function allowComments(spec: SourceSpec): boolean {
  return spec.format === "jsonc";
}

function parseDocument(spec: SourceSpec, text: string): unknown {
  if (text.trim() === "") return spec.format === "toml" ? {} : {};
  if (spec.format === "toml") return Bun.TOML.parse(text);
  return parseJsonValue(text, allowComments(spec));
}

/** Parse a source. Throws `malformed-source` rather than ever returning an empty map for a bad file. */
export function parseSource(spec: SourceSpec, text: string): ParsedSource {
  let document: unknown;
  try {
    document = parseDocument(spec, text);
  } catch {
    throw mcpFailure("malformed-source", {
      message: `${spec.displayPath} could not be parsed; it was left unchanged.`,
    });
  }
  if (!isRecord(document))
    throw mcpFailure("malformed-source", { message: `${spec.displayPath} is not an object.` });
  let subtree = spec.subtree;
  let map = getPath(document, subtree);
  if (spec.bareMapFallback && map === undefined && Object.keys(document).length) {
    // Pi: a bare map is accepted when there is no `mcpServers` key.
    subtree = [];
    map = document;
  }
  const entries = new Map<string, NativeEntry>();
  const entryIssues = new Map<string, string>();
  const parsed: ParsedSource = { subtree, entries, entryIssues, document };
  if (map === undefined) return parsed;
  if (!isRecord(map)) {
    parsed.addBlock = "The server map is not an object.";
    return parsed;
  }
  for (const [name, value] of Object.entries(map)) {
    if (isRecord(value)) entries.set(name, value);
    else entryIssues.set(name, "The entry is not an object.");
    if (isForbiddenMapKey(name)) entryIssues.set(name, "Reserved key.");
  }
  if (spec.format === "toml") {
    const layout = scanTomlLayoutSafe(text);
    if (!layout) {
      parsed.addBlock = "The file uses TOML this editor cannot preserve.";
      for (const name of entries.keys())
        entryIssues.set(name, "The file uses TOML this editor cannot preserve.");
      return parsed;
    }
    if (tomlRootLayout(layout, subtree) === "unsupported") {
      parsed.addBlock = `Servers are defined inline under ${subtree.join(".")}; edit the file directly.`;
    }
    for (const name of entries.keys()) {
      const entry = tomlEntryLayout(layout, subtree, name);
      if (entry.kind === "unsupported")
        entryIssues.set(name, `This server is ${entry.reason}; edit the file directly.`);
    }
  } else {
    let counts: Map<string, number>;
    try {
      counts = countJsonKeys(text, subtree, allowComments(spec));
    } catch {
      throw mcpFailure("malformed-source", {
        message: `${spec.displayPath} could not be parsed; it was left unchanged.`,
      });
    }
    for (const [name, count] of counts) {
      if (count > 1) entryIssues.set(name, "This server is defined more than once in the file.");
    }
  }
  return parsed;
}

function scanTomlLayoutSafe(text: string) {
  try {
    return scanTomlLayout(text);
  } catch {
    return null;
  }
}

export type DocumentEdit =
  | { kind: "add"; name: string; entry: NativeEntry }
  | { kind: "update"; name: string; previous: NativeEntry; entry: NativeEntry }
  | { kind: "rename"; name: string; newName: string }
  | { kind: "remove"; name: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory application of the edit, used as the verification oracle. */
function expectedDocument(parsed: ParsedSource, edit: DocumentEdit): unknown {
  const document = clone(parsed.document) as Record<string, unknown>;
  let node: Record<string, unknown> = document;
  for (const segment of parsed.subtree) {
    if (!isRecord(node[segment])) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  switch (edit.kind) {
    case "add":
    case "update":
      node[edit.name] = clone(edit.entry);
      break;
    case "rename": {
      // Key order is not semantic; rebuild so the renamed key keeps its slot.
      const entries = Object.entries(node).map(
        ([key, value]) => [key === edit.name ? edit.newName : key, value] as const,
      );
      for (const key of Object.keys(node)) delete node[key];
      for (const [key, value] of entries) node[key] = value;
      break;
    }
    case "remove":
      delete node[edit.name];
      break;
  }
  return document;
}

function applyJsonEdit(
  spec: SourceSpec,
  text: string,
  parsed: ParsedSource,
  edit: DocumentEdit,
): string {
  const comments = allowComments(spec);
  const base = parsed.subtree;
  switch (edit.kind) {
    case "add":
      return setJsonValue(text, [...base, edit.name], edit.entry, comments);
    case "update": {
      let result = text;
      const keys = new Set([...Object.keys(edit.previous), ...Object.keys(edit.entry)]);
      for (const key of keys) {
        const before = edit.previous[key];
        const after = edit.entry[key];
        if (tomlDeepEqual(before, after)) continue;
        result =
          after === undefined
            ? removeJsonValue(result, [...base, edit.name, key], comments)
            : setJsonValue(result, [...base, edit.name, key], after, comments);
      }
      return result;
    }
    case "rename":
      return renameJsonKey(text, [...base, edit.name], edit.newName, comments);
    case "remove":
      return removeJsonValue(text, [...base, edit.name], comments);
  }
}

function applyTomlEdit(text: string, parsed: ParsedSource, edit: DocumentEdit): string {
  const root = parsed.subtree;
  switch (edit.kind) {
    case "add":
      return addTomlEntry(text, root, edit.name, edit.entry);
    case "update":
      return updateTomlEntry(text, root, edit.name, edit.previous, edit.entry);
    case "rename":
      return renameTomlEntry(text, root, edit.name, edit.newName);
    case "remove":
      return removeTomlEntry(text, root, edit.name);
  }
}

/**
 * An empty server map and an absent one mean the same thing to every
 * provider; TOML drops an empty table when its last entry goes. Only the
 * server-map path is normalized — anything else must match exactly.
 */
function pruneEmptyPath(document: unknown, subtree: readonly string[]): unknown {
  if (!subtree.length || !isRecord(document)) return document;
  const copy = clone(document) as Record<string, unknown>;
  const chain: Array<[Record<string, unknown>, string]> = [];
  let node: Record<string, unknown> = copy;
  for (const segment of subtree) {
    const child = node[segment];
    if (!isRecord(child)) return copy;
    chain.push([node, segment]);
    node = child;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const [parent, key] = chain[index]!;
    const child = parent[key];
    if (isRecord(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
  return copy;
}

/** Apply `edit` to `text` and verify the result. Never returns an unverified document. */
export function editSource(
  spec: SourceSpec,
  text: string,
  parsed: ParsedSource,
  edit: DocumentEdit,
): string {
  let result: string;
  try {
    result =
      spec.format === "toml"
        ? applyTomlEdit(text, parsed, edit)
        : applyJsonEdit(spec, text, parsed, edit);
  } catch (error) {
    if (error instanceof JsonEditError || error instanceof TomlEditError) {
      throw mcpFailure("ambiguous-source", {
        message: "The change could not be applied without disturbing other settings.",
      });
    }
    throw error;
  }
  let actual: unknown;
  try {
    actual = parseDocument(spec, result);
  } catch {
    throw mcpFailure("internal", {
      message: "The edited file did not parse; the original was left unchanged.",
    });
  }
  if (
    !tomlDeepEqual(
      pruneEmptyPath(actual, parsed.subtree),
      pruneEmptyPath(expectedDocument(parsed, edit), parsed.subtree),
    )
  ) {
    throw mcpFailure("ambiguous-source", {
      message: "The edit would have changed other settings in the file, so it was not saved.",
    });
  }
  return result;
}
