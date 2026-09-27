/**
 * The ACP command inventory reducer and the enhanced catalogue built on it.
 *
 * In process, because these are pure decisions about untrusted rows: what is
 * kept, what is rejected rather than truncated, and when a list is allowed to
 * authorize a command. The spawned-bridge tests cover the wire around them.
 */
import { describe, expect, test } from "bun:test";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  COMMAND_CATALOGUE_LIMITS,
  commandBindingRevision,
  normalizeCommandCataloguePayload,
  utf8ByteLength,
} from "@orkestrator/protocol/agent-command-catalogue";

// `acp-context` resolves its provider at module load. Whichever provider this
// process ends up with, identities are derived from it, so the assertions
// below read it back rather than assuming one.
process.env.ACP_PROVIDER ??= "grok";

const { applySessionUpdate, attachChild } = await import("./acp-session.js");
const { emptySessionConfig } = await import("./acp-persistence.js");
const { provider } = await import("./acp-context.js");
const {
  applyCommandInventory,
  commandCatalogue,
  normalizeAdvertisedCommands,
  refreshCommandCatalogue,
  resolveSelectedCommand,
  restorePersistedCommands,
} = await import("./acp-commands.js");
type SessionState = import("./acp-context.js").SessionState;
type AcpProcess = import("./acp-context.js").AcpProcess;

function state(): SessionState {
  return {
    id: "bridge-session",
    acpSessionId: "acp-1",
    status: "idle",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 0,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
}

function announce(session: SessionState, availableCommands: unknown): void {
  applySessionUpdate(session, {
    sessionId: session.acpSessionId,
    update: { sessionUpdate: "available_commands_update", availableCommands },
  });
}

describe("ACP command normalization", () => {
  test("the standard nested input.hint wins over the legacy spellings", () => {
    const { commands, truncated } = normalizeAdvertisedCommands([
      {
        name: "review",
        description: "Review changes",
        input: { hint: "<path>" },
        inputHint: "legacy input hint",
        argumentHint: "legacy argument hint",
      },
      { name: "legacy-input", description: "Old agent", inputHint: "<file>" },
      { name: "legacy-argument", description: "Older agent", argumentHint: "<n>" },
      // A blank standard hint is no hint; the fallback may speak instead.
      { name: "blank", description: "Blank", input: { hint: "  " }, inputHint: "<x>" },
    ]);
    expect(truncated).toBe(false);
    expect(commands.map((command) => [command.name, command.argumentHint])).toEqual([
      ["/review", "<path>"],
      ["/legacy-input", "<file>"],
      ["/legacy-argument", "<n>"],
      ["/blank", "<x>"],
    ]);
    expect(commands[0]).toEqual({
      name: "/review",
      id: `${provider}:review`,
      executionKind: "provider-prompt",
      source: "unknown",
      scope: "session",
      description: "Review changes",
      argumentHint: "<path>",
      bindingRevision: commandBindingRevision([provider, "review"]),
    });
  });

  test("advertised over ACP is not a claim of builtin ownership", () => {
    const { commands } = normalizeAdvertisedCommands([
      { name: "deploy", description: "x", _meta: { source: "builtin" } },
    ]);
    expect(commands[0]?.source).toBe("unknown");
    expect(commands[0]).not.toHaveProperty("origin");
  });

  test("malformed rows, duplicates and invalid names are dropped deterministically", () => {
    const rows = [
      null,
      "review",
      { description: "no name" },
      { name: "", description: "empty" },
      { name: "has space", description: "whitespace" },
      { name: "tab\there", description: "control" },
      { name: "/", description: "sigil only" },
      { name: "plugin:ns/tool", description: "namespaced" },
      { name: "/slashed", description: "leading sigil" },
      { name: "review", description: "first" },
      { name: "review", description: "second" },
      { name: "Review", description: "different case is a different name" },
    ];
    const first = normalizeAdvertisedCommands(rows);
    const second = normalizeAdvertisedCommands(rows);
    expect(second).toEqual(first);
    expect(first.truncated).toBe(true);
    expect(first.commands.map((command) => [command.name, command.description])).toEqual([
      ["/plugin:ns/tool", "namespaced"],
      ["/slashed", "leading sigil"],
      ["/review", "first"],
      ["/Review", "different case is a different name"],
    ]);
    expect(first.commands[0]?.id).toBe(`${provider}:plugin:ns/tool`);
    expect(first.commands[1]?.id).toBe(`${provider}:slashed`);
  });

  test("an overlong name is rejected, never truncated into another command", () => {
    const budget = COMMAND_CATALOGUE_LIMITS.maxIdBytes - utf8ByteLength(`${provider}:`);
    const fits = "a".repeat(budget);
    const overlong = "a".repeat(budget + 1);
    // Four-byte characters: the limit is bytes, not UTF-16 units.
    const emoji = "😀".repeat(Math.floor(budget / 4) + 1);
    const { commands, truncated } = normalizeAdvertisedCommands([
      { name: overlong, description: "too long" },
      { name: emoji, description: "too many bytes" },
      { name: fits, description: "fits" },
    ]);
    expect(truncated).toBe(true);
    expect(commands.map((command) => command.name)).toEqual([`/${fits}`]);
  });

  test("presentation text is bounded in bytes without splitting a code point", () => {
    const { commands } = normalizeAdvertisedCommands([
      {
        name: "wide",
        description: "é".repeat(2_000),
        input: { hint: "😀".repeat(500) },
      },
    ]);
    const command = commands[0]!;
    expect(utf8ByteLength(command.description!)).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes,
    );
    expect(utf8ByteLength(command.argumentHint!)).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes,
    );
    expect(command.description!.endsWith("…")).toBe(true);
    // No lone surrogate: every code point survived whole.
    expect(command.argumentHint).toBe(`${"😀".repeat(127)}…`);
  });

  test("row count and response bytes stay inside the wire budget", () => {
    const rows = Array.from({ length: COMMAND_CATALOGUE_LIMITS.maxCommands + 10 }, (_, index) => ({
      name: `command-${index}`,
      description: "d".repeat(COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes),
      input: { hint: "h".repeat(COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes) },
    }));
    const session = state();
    applyCommandInventory(session, rows);
    const catalogue = commandCatalogue(session);
    expect(catalogue.truncated).toBe(true);
    expect(catalogue.commands.length).toBeLessThanOrEqual(COMMAND_CATALOGUE_LIMITS.maxCommands);
    expect(utf8ByteLength(JSON.stringify(catalogue))).toBeLessThanOrEqual(
      COMMAND_CATALOGUE_LIMITS.maxWireBytes,
    );
    // The backend's own normalizer accepts every row the bridge serves.
    const normalized = normalizeCommandCataloguePayload(catalogue);
    expect(normalized.enhanced).toBe(true);
    expect(normalized.rejected).toBe(0);
    expect(normalized.commands).toHaveLength(catalogue.commands.length);
  });

  test("persisted rows are rebuilt from their public fields, hint included", () => {
    const { commands } = normalizeAdvertisedCommands([
      { name: "review", description: "Review", input: { hint: "<path>" } },
    ]);
    // Only public fields are read back; a forged identity is re-derived.
    const restored = restorePersistedCommands([
      { ...commands[0], id: "forged", bindingRevision: "forged", source: "builtin" },
    ]);
    expect(restored.commands).toEqual(commands);
  });
});

describe("ACP command inventory", () => {
  test("no update yet is stale and empty, never an authoritative empty list", () => {
    const session = state();
    expect(commandCatalogue(session)).toMatchObject({
      catalogueVersion: 1,
      status: "stale",
      revision: 0,
      freshness: "push",
      commands: [],
    });
  });

  test("an empty update is a known empty list and removes every command", () => {
    const session = state();
    announce(session, [{ name: "review", description: "Review" }]);
    expect(commandCatalogue(session)).toMatchObject({ status: "ready", revision: 1 });
    announce(session, []);
    expect(commandCatalogue(session)).toMatchObject({
      status: "ready",
      revision: 2,
      truncated: false,
      commands: [],
    });
  });

  test("each update replaces the list; nothing is merged back", () => {
    const session = state();
    announce(session, [
      { name: "review", description: "Review" },
      { name: "commit", description: "Commit" },
    ]);
    announce(session, [{ name: "test", description: "Test" }]);
    expect(session.availableCommands?.map((command) => command.name)).toEqual(["/test"]);
  });

  test("an inventory announced before the session handler attached is applied on attach", () => {
    const session = state();
    // Agents announce straight after `session/new` answers, so the process
    // holds that announcement until `attachChild` wires the session up.
    const child = {
      earlyCommandsUpdate: {
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "review", description: "Review" }],
        },
      },
    } as unknown as AcpProcess;
    attachChild(session, child);
    expect(child.earlyCommandsUpdate).toBeNull();
    expect(commandCatalogue(session)).toMatchObject({ status: "ready", revision: 1 });
    expect(session.availableCommands?.map((command) => command.name)).toEqual(["/review"]);
  });

  test("an update without a list is ignored rather than read as empty", () => {
    const session = state();
    announce(session, [{ name: "review", description: "Review" }]);
    announce(session, undefined);
    expect(commandCatalogue(session)).toMatchObject({ status: "ready", revision: 1 });
    expect(session.availableCommands).toHaveLength(1);
  });

  test("restored rows are stale and cannot run until the agent re-reports", () => {
    const session = state();
    session.availableCommands = restorePersistedCommands([
      { name: "/review", description: "Review" },
    ]).commands;
    session.commandsRevision = 4;
    const catalogue = commandCatalogue(session);
    expect(catalogue).toMatchObject({ status: "stale", revision: 4 });
    const invocation = {
      id: catalogue.commands[0]!.id!,
      name: "/review",
      executionKind: "provider-prompt" as const,
      bindingRevision: catalogue.commands[0]!.bindingRevision!,
      arguments: "",
    };
    expect(resolveSelectedCommand(session, invocation)).toMatchObject({ ok: false });
    expect(refreshCommandCatalogue(session).outcome).toBe("unsupported");

    announce(session, [{ name: "review", description: "Review" }]);
    expect(commandCatalogue(session)).toMatchObject({ status: "ready", revision: 5 });
    expect(resolveSelectedCommand(session, invocation)).toMatchObject({
      ok: true,
      text: "/review",
    });
    expect(refreshCommandCatalogue(session).outcome).toBe("reread");
  });

  test("a selection builds canonical text with arguments verbatim", () => {
    const session = state();
    announce(session, [{ name: "review", description: "Review" }]);
    const command = session.availableCommands![0]!;
    const base = {
      id: command.id!,
      name: command.name,
      executionKind: "provider-prompt" as const,
      bindingRevision: command.bindingRevision!,
    };
    expect(
      resolveSelectedCommand(session, { ...base, arguments: "src/a.ts\n  and  b.ts\n" }),
    ).toMatchObject({ ok: true, text: "/review src/a.ts\n  and  b.ts\n" });
    // The provider spelling without its sigil names the same command.
    expect(
      resolveSelectedCommand(session, { ...base, name: "review", arguments: "" }),
    ).toMatchObject({ ok: true, text: "/review" });
    for (const mismatch of [
      { ...base, id: `${provider}:gone`, arguments: "" },
      { ...base, bindingRevision: "0000000000000000", arguments: "" },
      { ...base, name: "/other", arguments: "" },
      { ...base, executionKind: "provider-command" as const, arguments: "" },
    ]) {
      expect(resolveSelectedCommand(session, mismatch)).toMatchObject({ ok: false });
    }
  });

  test("an unknown session reads as missing and its refresh as failed", () => {
    expect(commandCatalogue(undefined)).toEqual({
      catalogueVersion: 1,
      status: "missing",
      commands: [],
    });
    expect(refreshCommandCatalogue(undefined).outcome).toBe("failed");
  });
});
