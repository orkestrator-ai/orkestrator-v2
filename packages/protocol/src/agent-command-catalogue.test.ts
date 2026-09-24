import { describe, expect, test } from "bun:test";
import {
  COMMAND_CATALOGUE_LIMITS,
  commandBindingRevision,
  legacyCommandId,
  literalCommandSuppression,
  normalizeCommandCataloguePayload,
  parseBridgeCommandInvocation,
  parseNativeAgentCommandIntent,
  parseNativeAgentResolvedCommandRecord,
  readBridgePromptCommandFields,
  truncateUtf8,
  utf8ByteLength,
  withCommandIdentities,
} from "./agent-command-catalogue.js";

function enhanced(commands: unknown[], extra: Record<string, unknown> = {}) {
  return normalizeCommandCataloguePayload({ catalogueVersion: 1, commands, ...extra });
}

describe("normalizeCommandCataloguePayload", () => {
  test("a successful empty list stays empty and is distinct from malformed input", () => {
    expect(enhanced([])).toMatchObject({ enhanced: true, commands: [], truncated: false });
    expect(normalizeCommandCataloguePayload(null)).toMatchObject({
      enhanced: false,
      commands: [],
    });
  });

  test("legacy rows get a synthetic identity and run as prompt text", () => {
    const result = normalizeCommandCataloguePayload({
      commands: ["review", { name: "/init", description: "Init", source: "builtin" }],
    });
    expect(result.enhanced).toBe(false);
    expect(result.commands).toEqual([
      {
        name: "/review",
        source: "unknown",
        id: legacyCommandId("/review"),
        executionKind: "provider-prompt",
        bindingRevision: "legacy",
      },
      {
        name: "/init",
        source: "builtin",
        id: legacyCommandId("/init"),
        executionKind: "provider-prompt",
        description: "Init",
        bindingRevision: "legacy",
      },
    ]);
  });

  test("enhanced rows without identity or execution kind are dropped, not guessed", () => {
    const result = enhanced([
      { name: "/ok", id: "a", executionKind: "provider-prompt", source: "project" },
      { name: "/no-id", executionKind: "provider-prompt" },
      { name: "/no-kind", id: "b" },
      { name: "/bad-kind", id: "c", executionKind: "shell" },
      // A bridge may not mint an Orkestrator session action.
      { name: "/steer", id: "d", executionKind: "session-action" },
    ]);
    expect(result.commands.map((command) => command.name)).toEqual(["/ok"]);
    expect(result.rejected).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test("duplicate identities keep the first row deterministically", () => {
    const result = enhanced([
      { name: "/one", id: "same", executionKind: "provider-prompt" },
      { name: "/two", id: "same", executionKind: "provider-prompt" },
    ]);
    expect(result.commands.map((command) => command.name)).toEqual(["/one"]);
  });

  test("overlong identity is rejected; overlong presentation is truncated", () => {
    const longName = `/${"é".repeat(200)}`; // 401 bytes
    const result = enhanced([
      { name: longName, id: "x", executionKind: "provider-prompt" },
      {
        name: "/fine",
        id: "y",
        executionKind: "provider-prompt",
        description: "d".repeat(5_000),
        argumentHint: "h".repeat(5_000),
      },
      { name: "/huge-id", id: "i".repeat(300), executionKind: "provider-prompt" },
    ]);
    expect(result.commands.map((command) => command.name)).toEqual(["/fine"]);
    const fine = result.commands[0]!;
    expect(utf8ByteLength(fine.description!)).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes,
    );
    expect(fine.description!.endsWith("…")).toBe(true);
    expect(utf8ByteLength(fine.argumentHint!)).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes,
    );
  });

  test("names keep provider spelling, namespaces and case", () => {
    const result = enhanced([
      { name: "plugin:Deploy", id: "p", executionKind: "provider-prompt", source: "plugin" },
      { name: "$skill", id: "s", executionKind: "structured-skill", source: "skill" },
    ]);
    expect(result.commands.map((command) => command.name)).toEqual(["/plugin:Deploy", "$skill"]);
  });

  test("aliases are bounded per row and in aggregate and never repeat the name", () => {
    const aliases = Array.from({ length: 40 }, (_, index) => `/a${index}`);
    const result = enhanced([
      {
        name: "/cmd",
        id: "c",
        executionKind: "provider-prompt",
        aliases: ["/cmd", "bad alias", ...aliases],
      },
    ]);
    const command = result.commands[0]!;
    expect(command.aliases).not.toContain("/cmd");
    expect(command.aliases!.length).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxAliasesPerCommand,
    );
  });

  test("row count is bounded and reported as truncated", () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({
      name: `/c${index}`,
      id: `c${index}`,
      executionKind: "provider-prompt",
    }));
    const result = enhanced(rows);
    expect(result.commands).toHaveLength(COMMAND_CATALOGUE_LIMITS.maxCommands);
    expect(result.truncated).toBe(true);
  });

  test("unavailable rows keep an allowlisted reason and stay unavailable when malformed", () => {
    const result = enhanced([
      {
        name: "/a",
        id: "a",
        executionKind: "provider-prompt",
        availability: { state: "unavailable", reason: "disabled", message: "Disabled" },
      },
      {
        name: "/b",
        id: "b",
        executionKind: "provider-prompt",
        availability: { state: "unavailable", reason: "made-up" },
      },
    ]);
    expect(result.commands[0]!.availability).toEqual({
      state: "unavailable",
      reason: "disabled",
      message: "Disabled",
    });
    expect(result.commands[1]!.availability).toEqual({
      state: "unavailable",
      reason: "unsupported",
    });
  });

  test("reads bridge-reported status, revision and freshness", () => {
    const result = enhanced([], { status: "unsupported", revision: 4, freshness: "push" });
    expect(result).toMatchObject({ status: "unsupported", revision: 4, freshness: "push" });
  });

  test("public descriptors never carry private binding fields", () => {
    const result = enhanced([
      {
        name: "$review",
        id: "skill:1",
        executionKind: "structured-skill",
        path: "/home/user/.codex/skills/review/SKILL.md",
        template: "secret body",
      },
    ]);
    const serialized = JSON.stringify(result.commands);
    expect(serialized).not.toContain("SKILL.md");
    expect(serialized).not.toContain("secret body");
  });
});

describe("byte helpers", () => {
  test("measures UTF-8 bytes and truncates without splitting a code point", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
    // The marker counts against the budget, so the result always fits.
    const truncated = truncateUtf8("😀😀😀", 11);
    expect(truncated).toBe("😀😀…");
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(11);
    expect(truncateUtf8("😀😀😀", 9)).toBe("😀…");
  });

  test("binding revisions are stable and separator-aware", () => {
    expect(commandBindingRevision(["a", "b"])).toBe(commandBindingRevision(["a", "b"]));
    expect(commandBindingRevision(["ab", "c"])).not.toBe(commandBindingRevision(["a", "bc"]));
    expect(commandBindingRevision(["x"])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("intent and invocation parsing", () => {
  test("parses the three intents and rejects malformed selections", () => {
    expect(parseNativeAgentCommandIntent({ kind: "literal" })).toEqual({ kind: "literal" });
    expect(parseNativeAgentCommandIntent({ kind: "typed" })).toEqual({ kind: "typed" });
    expect(
      parseNativeAgentCommandIntent({ kind: "selected", commandId: "a", bindingRevision: "r" }),
    ).toEqual({ kind: "selected", commandId: "a", bindingRevision: "r" });
    expect(parseNativeAgentCommandIntent({ kind: "selected" })).toBeUndefined();
    expect(parseNativeAgentCommandIntent({ kind: "selected", commandId: "a b" })).toBeUndefined();
    expect(parseNativeAgentCommandIntent({ kind: "run" })).toBeUndefined();
  });

  test("round-trips a resolved record", () => {
    expect(
      parseNativeAgentResolvedCommandRecord({
        intent: { kind: "selected", commandId: "a" },
        commandId: "a",
        name: "/a",
        executionKind: "provider-command",
        bindingRevision: "r",
      }),
    ).toEqual({
      intent: { kind: "selected", commandId: "a" },
      commandId: "a",
      name: "/a",
      executionKind: "provider-command",
      bindingRevision: "r",
    });
  });

  test("a bridge invocation carries identity and verbatim arguments only", () => {
    expect(
      parseBridgeCommandInvocation({
        id: "a",
        name: "/a",
        executionKind: "provider-prompt",
        arguments: "  line one\n\tline two  ",
        path: "/etc/passwd",
      }),
    ).toEqual({
      ok: true,
      invocation: {
        id: "a",
        name: "/a",
        executionKind: "provider-prompt",
        arguments: "  line one\n\tline two  ",
      },
    });
    expect(parseBridgeCommandInvocation(undefined)).toEqual({ ok: true });
    expect(parseBridgeCommandInvocation({ id: "a" }).ok).toBe(false);
    expect(
      parseBridgeCommandInvocation({
        id: "a",
        name: "/a",
        executionKind: "provider-prompt",
        arguments: "x".repeat(COMMAND_CATALOGUE_LIMITS.maxArgumentBytes + 1),
      }).ok,
    ).toBe(false);
  });

  test("literal prompts cannot also carry a selection; legacy bodies default to interpret", () => {
    expect(readBridgePromptCommandFields({ prompt: "/x" })).toEqual({
      ok: true,
      allowProviderCommands: true,
    });
    expect(readBridgePromptCommandFields({ allowProviderCommands: false })).toEqual({
      ok: true,
      allowProviderCommands: false,
    });
    expect(
      readBridgePromptCommandFields({
        allowProviderCommands: false,
        command: { id: "a", name: "/a", executionKind: "provider-prompt", arguments: "" },
      }).ok,
    ).toBe(false);
    expect(readBridgePromptCommandFields({ allowProviderCommands: "no" }).ok).toBe(false);
  });

  test("records which providers cannot suppress command interpretation", () => {
    expect(literalCommandSuppression("claude")).toBe(false);
    expect(literalCommandSuppression("grok")).toBe(false);
    expect(literalCommandSuppression("codex")).toBe(true);
    expect(literalCommandSuppression("opencode")).toBe(true);
    expect(literalCommandSuppression("pi")).toBe(true);
    expect(literalCommandSuppression("cursor")).toBe(true);
  });

  test("withCommandIdentities leaves identified rows untouched", () => {
    const identified = { name: "/a", source: "user" as const, id: "a" };
    const [kept, synthesized] = withCommandIdentities([identified, { name: "/b", source: "user" }]);
    expect(kept).toBe(identified);
    expect(synthesized!.id).toBe(legacyCommandId("/b"));
  });
});
