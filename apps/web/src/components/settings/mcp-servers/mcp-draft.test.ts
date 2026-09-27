import { describe, expect, test } from "bun:test";

import type { McpEditableDefinition } from "@orkestrator/protocol/mcp-management";

import {
  advancedTextProblem,
  definitionInputFromDraft,
  draftFromDefinition,
  emptyDraft,
  formatAdvancedValue,
  isEmptyPatch,
  newArgRow,
  newMapRow,
  parseAdvancedText,
  patchFromDraft,
  rebaseDraft,
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

  test("an empty replacement retains the saved literal while another edit is saved", () => {
    const draft = draftFromDefinition(saved);
    draft.env[0] = { ...draft.env[0]!, mode: "set", value: "" };
    draft.command = { kind: "set", value: "bun" };
    expect(patchFromDraft(saved, draft)).toEqual({ command: { kind: "set", value: "bun" } });
  });

  test("switching from HTTP provides the new command and removes old advanced fields", () => {
    const remote = {
      ...saved,
      transport: "http" as const,
      command: undefined,
      args: [],
      url: { kind: "visible" as const, value: "https://example.com/mcp" },
      advanced: { bearer_token_env_var: "TOKEN" },
      preservedFields: ["env_http_headers"],
    };
    const draft = draftFromDefinition(remote);
    draft.transport = "stdio";
    draft.command = { kind: "set", value: "bun" };
    const patch = patchFromDraft(remote, draft, [
      {
        id: "bearer_token_env_var",
        label: "Bearer token variable",
        type: "string",
        transports: ["http"],
      },
    ]);
    expect(patch.command).toEqual({ kind: "set", value: "bun" });
    expect(patch.transport?.discard).toContain("env_http_headers");
    expect(patch.advanced?.remove).toContain("bearer_token_env_var");
  });

  test("a new draft omits hidden advanced fields after a transport switch", () => {
    const draft = emptyDraft("http");
    draft.name = "docs";
    draft.url = { kind: "set", value: "https://example.com/mcp" };
    draft.advanced.bearer_token_env_var = "TOKEN";
    draft.transport = "stdio";
    draft.command = { kind: "set", value: "bun" };
    const input = definitionInputFromDraft(draft, false, [
      {
        id: "bearer_token_env_var",
        label: "Bearer token variable",
        type: "string",
        transports: ["http"],
      },
    ]);
    expect(input.advanced).toBeUndefined();
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

  test("typed advanced text parses without losing what is typed", () => {
    expect(parseAdvancedText("string-list", "a,")).toEqual(["a"]);
    expect(parseAdvancedText("string-list", "a, b")).toEqual(["a", "b"]);
    expect(parseAdvancedText("string-list", " , ")).toBe("");
    expect(parseAdvancedText("number", "1.")).toBe(1);
    expect(parseAdvancedText("number", "1.5")).toBe(1.5);
    expect(parseAdvancedText("number", "  ")).toBe("");
    // An unparseable number stays visible to the backend, never silently dropped.
    expect(parseAdvancedText("number", "12s")).toBe("12s");
    expect(parseAdvancedText("number", "Infinity")).toBe("Infinity");
    expect(parseAdvancedText("string", " keep spaces ")).toBe(" keep spaces ");
    expect(formatAdvancedValue(["a", "b"])).toBe("a, b");
    expect(formatAdvancedValue(1.5)).toBe("1.5");
    expect(formatAdvancedValue(undefined)).toBe("");
  });

  test("invalid numbers are explained, not coerced", () => {
    const field = {
      id: "t",
      label: "Timeout",
      type: "number" as const,
      transports: ["stdio" as const],
      min: 1,
      max: 600,
    };
    expect(advancedTextProblem(field, "")).toBeNull();
    expect(advancedTextProblem(field, "1.")).toBeNull();
    expect(advancedTextProblem(field, "abc")).toBe("Enter a number.");
    expect(advancedTextProblem(field, "0")).toBe("Use 1 or more.");
    expect(advancedTextProblem(field, "601")).toBe("Use 600 or less.");
    expect(advancedTextProblem({ ...field, type: "string-list" }, "a,,")).toBeNull();
  });

  test("a reload carries only the user's edits onto the latest revision", () => {
    const draft = draftFromDefinition(saved);
    draft.cwd = "/work";
    draft.env[0] = { ...draft.env[0]!, mode: "set", value: "typed" };
    draft.advanced = { ...draft.advanced, tool_timeout_sec: 30 };
    const latest: McpEditableDefinition = {
      ...saved,
      sourceRevision: "r1.def",
      command: { kind: "visible", value: "bunx" },
      args: [{ index: 0, value: { kind: "visible", value: "--fresh" } }],
      advanced: { startup_timeout_sec: 20, enabled_tools: ["a"] },
    };
    const rebased = rebaseDraft(saved, draft, latest);
    expect(rebased).not.toBeNull();
    // Another writer's command, arguments and advanced values survive…
    expect(rebased!.command).toEqual({ kind: "set", value: "bunx" });
    expect(rebased!.args.map((arg) => (arg.kind === "set" ? arg.value : arg.index))).toEqual([
      "--fresh",
    ]);
    // …and the user's own edits are kept.
    expect(rebased!.cwd).toBe("/work");
    expect(rebased!.env[0]).toMatchObject({ key: "API_KEY", mode: "set", value: "typed" });
    expect(rebased!.advanced).toEqual({
      startup_timeout_sec: 20,
      enabled_tools: ["a"],
      tool_timeout_sec: 30,
    });
    expect(patchFromDraft(latest, rebased!)).toEqual({
      cwd: { kind: "set", value: "/work" },
      env: [{ key: "API_KEY", edit: { kind: "set", value: "typed" } }],
      advanced: { set: { tool_timeout_sec: 30 } },
    });
  });

  test("a reload keeps a removed advanced value removed", () => {
    const draft = draftFromDefinition(saved);
    draft.advanced = { startup_timeout_sec: "" };
    const latest = { ...saved, advanced: { startup_timeout_sec: 10, other: true } };
    expect(patchFromDraft(latest, rebaseDraft(saved, draft, latest)!).advanced).toEqual({
      remove: ["startup_timeout_sec"],
    });
  });

  test("edited arguments that retain saved values by position cannot be carried over", () => {
    const draft = draftFromDefinition(saved);
    draft.args = [...draft.args, newArgRow("--extra")];
    expect(rebaseDraft(saved, draft, { ...saved, sourceRevision: "r1.def" })).toBeNull();
  });
});
