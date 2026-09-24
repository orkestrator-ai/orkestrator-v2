import { describe, expect, test } from "bun:test";

import {
  JsonEditError,
  countJsonKeys,
  parseJsonValue,
  removeJsonValue,
  renameJsonKey,
  setJsonValue,
} from "./json-edit.js";

const JSONC = `{
  // user comment kept
  "theme": "dark",
  "mcpServers": {
    "a": { "command": "x" }, // trailing note
    "b": {
      /* block */
      "url": "https://b.example/mcp"
    },
  },
}
`;

describe("json-edit", () => {
  test("adds a property without reformatting the rest of the document", () => {
    const next = setJsonValue(
      JSONC,
      ["mcpServers", "c"],
      { command: "npx", args: ["-y", "c"] },
      true,
    );
    expect(next).toContain("// user comment kept");
    expect(next).toContain('"a": { "command": "x" }, // trailing note');
    expect(next).toContain("/* block */");
    expect(parseJsonValue(next, true)).toEqual({
      theme: "dark",
      mcpServers: {
        a: { command: "x" },
        b: { url: "https://b.example/mcp" },
        c: { command: "npx", args: ["-y", "c"] },
      },
    });
  });

  test("replaces only the target value", () => {
    const next = setJsonValue(JSONC, ["mcpServers", "b", "url"], "https://c.example/mcp", true);
    expect(next.replace("https://c.example/mcp", "https://b.example/mcp")).toBe(JSONC);
  });

  test("removes middle, last and only properties and keeps valid syntax", () => {
    let text = removeJsonValue(JSONC, ["mcpServers", "a"], true);
    expect(text).not.toContain("// trailing note");
    expect(parseJsonValue(text, true)).toEqual({
      theme: "dark",
      mcpServers: { b: { url: "https://b.example/mcp" } },
    });
    text = removeJsonValue(text, ["mcpServers", "b"], true);
    expect(parseJsonValue(text, true)).toEqual({ theme: "dark", mcpServers: {} });
    const strict = removeJsonValue('{"x": 1, "y": {"k": 2}}', ["y"], false);
    expect(JSON.parse(strict)).toEqual({ x: 1 });
    expect(removeJsonValue('{"x": 1}', ["missing"], false)).toBe('{"x": 1}');
  });

  test("preserves a standalone comment before the surviving next property", () => {
    const text = '{\n  "a": 1,\n  // documents b\n  "b": 2\n}\n';
    const next = removeJsonValue(text, ["a"], true);
    expect(next).toContain("// documents b");
    expect(parseJsonValue(next, true)).toEqual({ b: 2 });
  });

  test("renames a key while keeping its value text byte-for-byte", () => {
    const next = renameJsonKey(JSONC, ["mcpServers", "b"], "b 2", true);
    expect(next).toContain('"b 2": {\n      /* block */');
    expect(() => renameJsonKey(JSONC, ["mcpServers", "a"], "b", true)).toThrow(JsonEditError);
  });

  test("creates missing parents, including project-path keys with dots and slashes", () => {
    const next = setJsonValue(
      '{"numStartups": 3}',
      ["projects", "/home/u/a.b", "mcpServers", "k"],
      { url: "u" },
      false,
    );
    expect(JSON.parse(next)).toEqual({
      numStartups: 3,
      projects: { "/home/u/a.b": { mcpServers: { k: { url: "u" } } } },
    });
  });

  test("creates a document from an empty file and keeps CRLF line endings", () => {
    expect(JSON.parse(setJsonValue("", ["mcpServers", "k"], { url: "u" }, false))).toEqual({
      mcpServers: { k: { url: "u" } },
    });
    const crlf = '{\r\n  "a": 1\r\n}\r\n';
    expect(setJsonValue(crlf, ["b"], 2, false)).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
  });

  test("keeps comments when adding to or removing from an otherwise empty map", () => {
    const original = '{\n  "mcp": {\n    // keep this note\n  }\n}\n';
    const added = setJsonValue(original, ["mcp", "server"], { command: "x" }, true);
    expect(added).toContain("// keep this note");
    expect(parseJsonValue(added, true)).toEqual({ mcp: { server: { command: "x" } } });
    const removed = removeJsonValue(added, ["mcp", "server"], true);
    expect(removed).toContain("// keep this note");
    expect(parseJsonValue(removed, true)).toEqual({ mcp: {} });
  });

  test("keeps a trailing line comment with its original property", () => {
    const original = '{\n  "a": 1 // belongs to a\n}\n';
    const added = setJsonValue(original, ["b"], 2, true);
    expect(added).toContain('"a": 1, // belongs to a\n');
    expect(parseJsonValue(added, true)).toEqual({ a: 1, b: 2 });
    const withComma = '{\n  "a": 1, // belongs to a\n}\n';
    const addedAfterComma = setJsonValue(withComma, ["b"], 2, true);
    expect(addedAfterComma).toContain('"a": 1, // belongs to a\n');
    expect(parseJsonValue(addedAfterComma, true)).toEqual({ a: 1, b: 2 });
    const block = '{\n  "a": 1 /* // inside a block */\n}\n';
    expect(parseJsonValue(setJsonValue(block, ["b"], 2, true), true)).toEqual({ a: 1, b: 2 });
  });

  test("refuses comments in strict JSON and reports duplicate keys", () => {
    expect(() => setJsonValue('{ // no\n "a": 1 }', ["b"], 1, false)).toThrow(JsonEditError);
    expect(countJsonKeys('{"m": {"a": 1, "a": 2, "b": 3}}', ["m"], false).get("a")).toBe(2);
  });

  test("preserves unicode and escapes in untouched values", () => {
    const text = '{"a": "caf\\u00e9 \\"q\\"", "b": "日本"}';
    const next = setJsonValue(text, ["c"], "x", false);
    expect(next.startsWith('{"a": "caf\\u00e9 \\"q\\"", "b": "日本"')).toBe(true);
  });
});
