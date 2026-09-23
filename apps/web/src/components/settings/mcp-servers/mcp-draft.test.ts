import { describe, expect, test } from "bun:test";

import type { McpEditableDefinition } from "@orkestrator/protocol/mcp-management";

import {
  definitionInputFromDraft,
  draftFromDefinition,
  emptyDraft,
  isEmptyPatch,
  newMapRow,
  patchFromDraft,
  removeMapRow,
} from "./mcp-draft";

const saved: McpEditableDefinition = {
  entryId: "claude:user/ZG9jcw",
  sourceId: "claude:user",
  sourceRevision: "r1.abc",
  name: "docs",
  transport: "stdio",
  enabled: null,
  command: { kind: "visible", value: "npx" },
  args: [
    { index: 0, value: { kind: "visible", value: "-y" } },
    { index: 1, value: { kind: "visible", value: "--token" } },
    { index: 2, value: { kind: "redacted", display: "(retained value)" } },
  ],
  env: [
    { key: "API_KEY", presence: "literal" },
    { key: "REF", presence: "reference", reference: "${HOME_REF}" },
  ],
  headers: [],
  advanced: { startup_timeout_sec: 10 },
  preservedFields: ["custom"],
};

describe("mcp draft model", () => {
  test("an untouched draft produces an empty patch", () => {
    expect(isEmptyPatch(patchFromDraft(saved, draftFromDefinition(saved)))).toBe(true);
  });

  test("saved secrets never enter the draft", () => {
    const draft = draftFromDefinition(saved);
    expect(draft.env[0]).toMatchObject({ key: "API_KEY", mode: "keep", value: "" });
    expect(draft.env[1]).toMatchObject({ key: "REF", mode: "set", value: "${HOME_REF}" });
    expect(draft.args[2]).toMatchObject({ kind: "keep", index: 2 });
  });

  test("renaming a saved key moves the value without sending it", () => {
    const draft = draftFromDefinition(saved);
    draft.env[0] = { ...draft.env[0]!, key: "DOCS_KEY" };
    expect(patchFromDraft(saved, draft)).toEqual({
      env: [{ key: "DOCS_KEY", edit: { kind: "keep", fromKey: "API_KEY" } }],
    });
  });

  test("replace sends set, removing a saved row sends clear", () => {
    let draft = draftFromDefinition(saved);
    draft.env[0] = { ...draft.env[0]!, mode: "set", value: "new-value" };
    draft = removeMapRow(draft, "env", draft.env[1]!.id);
    expect(patchFromDraft(saved, draft).env).toEqual([
      { key: "API_KEY", edit: { kind: "set", value: "new-value" } },
      { key: "REF", edit: { kind: "clear" } },
    ]);
  });

  test("argument edits keep retained values by their saved position", () => {
    const draft = draftFromDefinition(saved);
    draft.args = [draft.args[2]!, draft.args[0]!];
    expect(patchFromDraft(saved, draft).args).toEqual([
      { kind: "keep", index: 2 },
      { kind: "set", value: "-y" },
    ]);
  });

  test("switching transport names the fields it discards", () => {
    const draft = draftFromDefinition(saved);
    draft.transport = "http";
    draft.url = { kind: "set", value: "https://a.example/mcp" };
    const patch = patchFromDraft(saved, draft);
    expect(patch.transport).toEqual({ to: "http", discard: ["command", "args", "cwd"] });
    expect(patch.url).toEqual({ kind: "set", value: "https://a.example/mcp" });
  });

  test("advanced fields are set and removed explicitly", () => {
    const draft = draftFromDefinition(saved);
    draft.advanced = { startup_timeout_sec: "", tool_timeout_sec: 30 };
    expect(patchFromDraft(saved, draft).advanced).toEqual({
      set: { tool_timeout_sec: 30 },
      remove: ["startup_timeout_sec"],
    });
  });

  test("a new definition keeps argument boundaries and omits empty rows", () => {
    const draft = emptyDraft();
    draft.name = " my-server ";
    draft.command = { kind: "set", value: "/opt/My Tools/server" };
    draft.args = [{ id: "a", kind: "set", value: "a b; c" }];
    draft.env = [{ ...newMapRow(), key: "A", value: "${A}" }, newMapRow()];
    expect(definitionInputFromDraft(draft, false)).toEqual({
      name: "my-server",
      transport: "stdio",
      command: "/opt/My Tools/server",
      args: ["a b; c"],
      env: [{ key: "A", value: "${A}" }],
    });
  });
});
