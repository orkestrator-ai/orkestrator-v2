import { describe, expect, test } from "bun:test";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import {
  nativeAgentCapabilities,
  type NativeAgentCommandCatalogueState,
  type NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import {
  commandDispatchNeedsCatalogue,
  planCommandDispatch,
  type CommandDispatchInput,
} from "./native-agent-command-dispatch.js";

const ready: NativeAgentCommandCatalogueState = { status: "ready", revision: 1, enhanced: true };

const providerRows: NativeAgentSlashCommand[] = [
  {
    name: "/review",
    source: "project",
    id: "claude:/review",
    executionKind: "provider-prompt",
    bindingRevision: "r1",
    aliases: ["/rv"],
  },
  {
    name: "/clear",
    source: "unknown",
    id: "claude:/clear",
    executionKind: "provider-prompt",
    availability: {
      state: "unavailable",
      reason: "session-changing",
      message: "/clear would replace the session.",
    },
  },
  {
    name: "/text-only",
    source: "user",
    id: "claude:/text-only",
    executionKind: "provider-prompt",
    inputPolicy: { attachments: "none" },
  },
];

function plan(overrides: Partial<CommandDispatchInput> = {}) {
  const platform = overrides.platform ?? "claude";
  return planCommandDispatch({
    platform,
    agentLabel: "Claude",
    prompt: "/review src",
    intent: { kind: "typed" },
    commands: withSessionActionSlashCommands(providerRows, nativeAgentCapabilities(platform)),
    catalogue: ready,
    structuredOutput: false,
    attachments: [],
    ...overrides,
  });
}

describe("planCommandDispatch", () => {
  test("typed canonical and alias spellings send the canonical command with verbatim arguments", () => {
    const typed = plan({ prompt: "/review  line one\n\tline two  " });
    expect(typed).toEqual({
      kind: "prompt",
      allowProviderCommands: true,
      command: {
        id: "claude:/review",
        name: "/review",
        executionKind: "provider-prompt",
        bindingRevision: "r1",
        arguments: "line one\n\tline two  ",
      },
      persistedIntent: { kind: "selected", commandId: "claude:/review", bindingRevision: "r1" },
      commandName: "/review",
    });
    const alias = plan({ prompt: "/rv x" });
    expect(alias.kind === "prompt" && alias.command?.name).toBe("/review");
  });

  test("a selection resolves by identity; a removed or changed one is refused, never sent as text", () => {
    expect(
      plan({ intent: { kind: "selected", commandId: "claude:/review", bindingRevision: "r1" } }),
    ).toMatchObject({ kind: "prompt", command: { id: "claude:/review" } });
    expect(plan({ intent: { kind: "selected", commandId: "claude:/gone" } })).toMatchObject({
      kind: "rejected",
      staleSelection: true,
    });
    expect(
      plan({ intent: { kind: "selected", commandId: "claude:/review", bindingRevision: "r0" } }),
    ).toMatchObject({ kind: "rejected", staleSelection: true });
  });

  test("a stale selection against an unavailable catalogue says it could not be verified", () => {
    const result = plan({
      intent: { kind: "selected", commandId: "claude:/review" },
      commands: [],
      catalogue: { status: "unavailable", revision: 0, enhanced: false },
    });
    expect(result).toMatchObject({ kind: "rejected" });
    expect(result.kind === "rejected" && result.message).toContain("could not be verified");
  });

  test("known unavailable commands and attachment policy fail before dispatch", () => {
    expect(plan({ prompt: "/clear" })).toEqual({
      kind: "rejected",
      message: "/clear would replace the session.",
    });
    expect(plan({ prompt: "/text-only", attachments: [{ type: "image" }] })).toMatchObject({
      kind: "rejected",
    });
  });

  test("unknown slash text and paths stay ordinary, interpretable prompts", () => {
    expect(plan({ prompt: "/Users/me/file.ts is broken" })).toEqual({
      kind: "prompt",
      allowProviderCommands: true,
      persistedIntent: { kind: "typed" },
    });
    expect(plan({ prompt: "/unknown thing" }).kind).toBe("prompt");
  });

  test("literal intent is literal; providers without suppression refuse a known command", () => {
    expect(plan({ platform: "codex", intent: { kind: "literal" } })).toEqual({
      kind: "prompt",
      allowProviderCommands: false,
      persistedIntent: { kind: "literal" },
    });
    expect(plan({ platform: "claude", intent: { kind: "literal" } }).kind).toBe("rejected");
    expect(plan({ platform: "grok", intent: { kind: "literal" } }).kind).toBe("rejected");
    // Unknown text is safe to send literally even without suppression.
    expect(plan({ platform: "claude", intent: { kind: "literal" }, prompt: "/nothing" }).kind).toBe(
      "prompt",
    );
  });

  test("structured output is literal and cannot carry a selection", () => {
    expect(plan({ structuredOutput: true })).toMatchObject({
      kind: "prompt",
      allowProviderCommands: false,
    });
    expect(
      plan({ structuredOutput: true, intent: { kind: "selected", commandId: "claude:/review" } }),
    ).toMatchObject({ kind: "rejected" });
  });

  test("/compact resolves to the session action when the provider has no /compact", () => {
    const codex = plan({
      platform: "codex",
      prompt: "/compact",
      commands: withSessionActionSlashCommands([], nativeAgentCapabilities("codex")),
    });
    expect(codex).toEqual({ kind: "session-action", action: "compact", commandName: "/compact" });
    expect(
      plan({
        platform: "codex",
        prompt: "/compact now",
        commands: withSessionActionSlashCommands([], nativeAgentCapabilities("codex")),
      }).kind,
    ).toBe("rejected");
  });

  test("/steer on the prompt path keeps its legacy local reply", () => {
    expect(plan({ prompt: "/steer keep going" })).toMatchObject({
      kind: "prompt",
      allowProviderCommands: true,
      persistedIntent: { kind: "typed" },
    });
  });

  test("legacy catalogues never hand a bridge a selection it would ignore", () => {
    const result = plan({
      commands: [
        { name: "/review", source: "builtin", id: "legacy:/review", bindingRevision: "legacy" },
      ],
      catalogue: { status: "ready", revision: 1, enhanced: false },
    });
    expect(result).toMatchObject({ kind: "prompt", allowProviderCommands: true });
    expect(result.kind === "prompt" && result.command).toBeUndefined();
  });

  test("only command-shaped or selected submissions need the catalogue", () => {
    expect(commandDispatchNeedsCatalogue("codex", "hello", { kind: "typed" })).toBe(false);
    expect(commandDispatchNeedsCatalogue("codex", "/x", { kind: "typed" })).toBe(true);
    expect(commandDispatchNeedsCatalogue("codex", "/x", { kind: "literal" })).toBe(false);
    expect(commandDispatchNeedsCatalogue("claude", "/x", { kind: "literal" })).toBe(true);
    expect(
      commandDispatchNeedsCatalogue("codex", "hello", { kind: "selected", commandId: "a" }),
    ).toBe(true);
  });
});
