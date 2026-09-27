import { describe, expect, test } from "bun:test";
import type {
  NativeAgentCommandCatalogueState,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import {
  classifyNativeCommandSubmission,
  commandSubmissionIntent,
  draftCommandBusyTitle,
  HANDOFF_COMMAND_MESSAGE,
  literalEscapeAvailable,
  type NativeCommandSubmissionInput,
} from "./native-command-submission";

const READY: NativeAgentCommandCatalogueState = { status: "ready", revision: 3, enhanced: true };

const REVIEW: NativeAgentSlashCommand = {
  name: "/review",
  id: "codex:/review",
  source: "project",
  executionKind: "bridge-template",
  bindingRevision: "rev-1",
  inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
};
const SKILL: NativeAgentSlashCommand = {
  name: "$deploy",
  insertText: "$deploy",
  aliases: ["/skills:deploy"],
  id: "codex:skill:deploy",
  source: "skill",
  executionKind: "structured-skill",
  bindingRevision: "skill-1",
};
const LOGIN: NativeAgentSlashCommand = {
  name: "/login",
  id: "codex:/login",
  source: "builtin",
  executionKind: "provider-command",
  availability: {
    state: "unavailable",
    reason: "requires-interactive-ui",
    message: "Sign in from Settings instead.",
  },
};
const COMPACT: NativeAgentSlashCommand = {
  name: "/compact",
  id: "orkestrator:compact",
  source: "orkestrator",
  executionKind: "session-action",
  bindingRevision: "orkestrator:compact",
  inputPolicy: { arguments: "none", attachments: "none", busy: "idle" },
};
const STEER: NativeAgentSlashCommand = {
  name: "/steer",
  id: "orkestrator:steer",
  source: "orkestrator",
  executionKind: "session-action",
  inputPolicy: { arguments: "required", attachments: "none", busy: "running" },
};
const IDLE_ONLY: NativeAgentSlashCommand = {
  name: "/model",
  id: "codex:/model",
  source: "builtin",
  executionKind: "provider-command",
  inputPolicy: { busy: "idle" },
};

function classify(overrides: Partial<NativeCommandSubmissionInput> = {}) {
  return classifyNativeCommandSubmission({
    text: "",
    platform: "codex",
    agentLabel: "Codex",
    commands: [REVIEW, SKILL, LOGIN, COMPACT, STEER, IDLE_ONLY],
    catalogue: READY,
    selection: undefined,
    attachments: [],
    annotationCount: 0,
    pendingHandoff: false,
    busy: false,
    ...overrides,
  });
}

describe("classifyNativeCommandSubmission", () => {
  test("a legacy backend keeps today's ordinary prompt path", () => {
    expect(classify({ text: "/review x", catalogue: undefined })).toEqual({ kind: "prompt" });
    expect(
      classify({
        text: "/review x",
        catalogue: undefined,
        selection: { commandId: "codex:/review", token: "/review" },
      }),
    ).toEqual({ kind: "prompt" });
  });

  test("ordinary and unknown slash text stay ordinary prompts", () => {
    expect(classify({ text: "hello" })).toEqual({ kind: "prompt" });
    expect(classify({ text: "/usr/local/bin is on PATH" })).toEqual({ kind: "prompt" });
    expect(classify({ text: "/nope" })).toEqual({ kind: "prompt" });
  });

  test("a typed command resolves to a selection of that descriptor", () => {
    expect(classify({ text: "/review src/a.ts" })).toEqual({
      kind: "command",
      intent: { kind: "selected", commandId: "codex:/review", bindingRevision: "rev-1" },
      command: REVIEW,
    });
    expect(classify({ text: "/skills:deploy prod" })).toMatchObject({
      kind: "command",
      intent: { commandId: "codex:skill:deploy" },
    });
  });

  test("a retained selection is sent by identity even when its spelling is the insert text", () => {
    expect(
      classify({
        text: "$deploy  staging\t\n",
        selection: {
          commandId: "codex:skill:deploy",
          bindingRevision: "skill-1",
          token: "$deploy",
        },
      }),
    ).toEqual({
      kind: "command",
      intent: { kind: "selected", commandId: "codex:skill:deploy", bindingRevision: "skill-1" },
      command: SKILL,
    });
  });

  test("a selection that disappeared from an authoritative list is refused, not sent as text", () => {
    const result = classify({
      text: "/review x",
      commands: [SKILL],
      selection: { commandId: "codex:/review", bindingRevision: "rev-1", token: "/review" },
    });
    expect(result).toEqual({
      kind: "rejected",
      message: "The selected command is no longer available. Choose it again from the menu.",
    });
    expect(
      classify({
        text: "/review x",
        selection: { commandId: "codex:/review", bindingRevision: "rev-0", token: "/review" },
      }),
    ).toMatchObject({ kind: "rejected", message: expect.stringContaining("changed since") });
  });

  test("a selection the composer cannot see yet is left for the backend to verify", () => {
    for (const status of ["loading", "stale", "unavailable"] as const) {
      expect(
        classify({
          text: "/review x",
          commands: [],
          catalogue: { status, revision: 1, enhanced: true },
          selection: { commandId: "codex:/review", bindingRevision: "rev-1", token: "/review" },
        }),
      ).toEqual({
        kind: "command",
        intent: { kind: "selected", commandId: "codex:/review", bindingRevision: "rev-1" },
      });
    }
  });

  test("unavailable and ambiguous commands are refused with an escape where honest", () => {
    expect(classify({ text: "/login" })).toEqual({
      kind: "rejected",
      message: "Sign in from Settings instead.",
      literalEscape: true,
    });
    const twin = { ...REVIEW, id: "codex:/review-2", name: "/Review" };
    expect(classify({ text: "/REVIEW", commands: [REVIEW, twin] })).toMatchObject({
      kind: "rejected",
      literalEscape: true,
    });
    expect(classify({ text: "/login", platform: "claude", agentLabel: "Claude" })).toMatchObject({
      kind: "rejected",
      literalEscape: false,
    });
  });

  test("input policy is enforced before anything is sent", () => {
    expect(classify({ text: "/review x", annotationCount: 1 })).toMatchObject({
      kind: "rejected",
      message: "/review can't include transcript annotations. Remove them and retry.",
    });
    expect(classify({ text: "/review x", attachments: [{ type: "file" }] })).toMatchObject({
      kind: "rejected",
      message: "/review accepts image attachments only. Remove the other files and retry.",
    });
    expect(classify({ text: "/review x", attachments: [{ type: "image" }] })).toMatchObject({
      kind: "command",
    });
    expect(classify({ text: "/review x", pendingHandoff: true })).toEqual({
      kind: "rejected",
      message: HANDOFF_COMMAND_MESSAGE,
    });
  });

  test("compact runs as a session action, idle only, with no arguments or attachments", () => {
    expect(classify({ text: "/compact" })).toEqual({ kind: "compact", command: COMPACT });
    expect(classify({ text: "/compact now" })).toMatchObject({ kind: "rejected" });
    expect(classify({ text: "/compact", attachments: [{ type: "image" }] })).toMatchObject({
      kind: "rejected",
      message: "/compact does not accept attachments. Remove them and retry.",
    });
    expect(classify({ text: "/compact", busy: true })).toMatchObject({
      kind: "rejected",
      message: expect.stringContaining("only while Codex is idle"),
    });
    // Session actions never consume transferred history.
    expect(classify({ text: "/compact", pendingHandoff: true })).toMatchObject({
      kind: "compact",
    });
  });

  test("an idle /steer keeps its legacy prompt path", () => {
    expect(classify({ text: "/steer do it" })).toEqual({ kind: "prompt" });
  });

  test("an idle-only command may still queue; the backend holds it until idle", () => {
    expect(classify({ text: "/model", busy: true })).toMatchObject({
      kind: "command",
      command: IDLE_ONLY,
    });
  });

  test("send-as-text is literal where the provider can suppress commands", () => {
    expect(classify({ text: "/review x", literal: true })).toEqual({
      kind: "prompt",
      intent: { kind: "literal" },
    });
    expect(
      classify({ text: "/review x", literal: true, platform: "claude", agentLabel: "Claude" }),
    ).toMatchObject({ kind: "rejected", message: expect.stringContaining("Claude reads") });
    expect(
      classify({ text: "/unknown x", literal: true, platform: "grok", agentLabel: "Grok" }),
    ).toEqual({ kind: "prompt", intent: { kind: "literal" } });
    // Orkestrator's own actions are not provider commands the provider would run.
    expect(
      literalEscapeAvailable({ text: "/compact", platform: "claude", commands: [COMPACT] }),
    ).toBe(true);
  });
});

describe("command submission helpers", () => {
  test("only prompts and commands carry an intent", () => {
    expect(commandSubmissionIntent({ kind: "prompt" })).toBeUndefined();
    expect(commandSubmissionIntent({ kind: "prompt", intent: { kind: "literal" } })).toEqual({
      kind: "literal",
    });
    expect(
      commandSubmissionIntent({
        kind: "command",
        intent: { kind: "selected", commandId: "codex:/review" },
      }),
    ).toEqual({ kind: "selected", commandId: "codex:/review" });
    expect(commandSubmissionIntent({ kind: "compact", command: COMPACT })).toBeUndefined();
  });

  test("the send button says when a command waits for, or needs, an idle agent", () => {
    const running = { running: true, canQueue: true, agentLabel: "Codex" };
    expect(draftCommandBusyTitle(COMPACT, running)).toBe("/compact runs only while Codex is idle");
    expect(draftCommandBusyTitle(IDLE_ONLY, running)).toBe(
      "Queue /model — it runs when Codex is idle",
    );
    expect(draftCommandBusyTitle(REVIEW, running)).toBeUndefined();
    expect(draftCommandBusyTitle(COMPACT, { ...running, running: false })).toBeUndefined();
    expect(draftCommandBusyTitle(undefined, running)).toBeUndefined();
  });
});
