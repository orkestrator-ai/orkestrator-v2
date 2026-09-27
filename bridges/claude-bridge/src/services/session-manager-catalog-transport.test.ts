import { describe, expect, mock, test } from "bun:test";
import { commandBindingRevision } from "@orkestrator/protocol/agent-command-catalogue";
import {
  createSession,
  getSession,
  inspectDuringTurn,
  mockQuery,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  configureClaudeSession,
  gracefulInterruptClaudeSession,
  isClosedTransportError,
  readClaudeCommandCatalogue,
  readSessionCommands,
  readSessionMcpServers,
  recordCommandsChanged,
  refreshClaudeCommandCatalogue,
  resolveClaudeCommandInvocation,
  typedCommandUnavailableMessage,
} from "./session-manager.js";
import type { SessionState } from "../types/index.js";

/**
 * Catalogue reads and writes against a turn query that is on its way out.
 *
 * The SDK rejects every in-flight control request with "Query closed before
 * response received" once the CLI's stdout ends. `session.queryControl` outlives
 * that moment — it is cleared in the turn's `finally`, while stdin closes at the
 * result boundary — so these calls used to escape as uncaught 500s that told the
 * user nothing and the log even less.
 */

function closedTransport(): Error {
  return new Error("Query closed before response received");
}

describe("catalog reads against a closed transport", () => {
  test("identifies the SDK's closed-transport rejection", () => {
    expect(isClosedTransportError(closedTransport())).toBe(true);
    expect(isClosedTransportError(new Error("Query is closed"))).toBe(true);
    expect(isClosedTransportError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isClosedTransportError(undefined)).toBe(false);
  });

  test("serves the cached command list when the query dies mid-read", async () => {
    const supportedCommands = mock(async () => [
      { name: "/deploy", description: "Ship it", argumentHint: "" },
    ]);
    queryControlOverrides.supportedCommands = supportedCommands;

    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));

    // First read populates the cache from the live control.
    const initial = await readSessionCommands(session.id);
    expect(initial.map((command) => command.name)).toEqual(["/deploy"]);
    expect(session.commandInventory?.map((command) => command.name)).toEqual(["/deploy"]);

    // The CLI then exits with the next request already in flight. The live
    // control has to be patched directly: `queryControlOverrides` is consumed
    // when the mock control is built, so mutating it now would change nothing
    // and the test would pass without exercising the fallback at all.
    const dying = mock(async () => {
      throw closedTransport();
    });
    session.queryControl!.supportedCommands = dying;
    await expect(readSessionCommands(session.id)).resolves.toEqual(initial);
    expect(dying).toHaveBeenCalled();

    await finish();
  });

  test("skips a draining control instead of issuing a doomed request", async () => {
    const supportedCommands = mock(async () => [
      { name: "/review", description: "Review", argumentHint: "" },
    ]);
    queryControlOverrides.supportedCommands = supportedCommands;

    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    await readSessionCommands(session.id);
    const callsBeforeDrain = supportedCommands.mock.calls.length;

    // What `closeTurnInput()` records once the CLI's stdin is closed.
    session.queryControlDraining = session.queryControl;

    await expect(readSessionCommands(session.id)).resolves.toEqual(session.commandInventory ?? []);
    // The point of the marker: no request was even attempted.
    expect(supportedCommands.mock.calls.length).toBe(callsBeforeDrain);

    await finish();
  });

  test("keeps the last MCP inventory when the query dies mid-read", async () => {
    queryControlOverrides.mcpServerStatus = mock(async () => [
      { name: "context7", status: "connected" as const },
    ]);

    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    const initial = await readSessionMcpServers(session.id);
    expect(initial.map((server) => server.name)).toEqual(["context7"]);

    const dying = mock(async () => {
      throw closedTransport();
    });
    session.queryControl!.mcpServerStatus = dying;
    await expect(readSessionMcpServers(session.id)).resolves.toEqual(initial);
    expect(dying).toHaveBeenCalled();

    await finish();
  });

  test("a genuine catalogue failure still propagates", async () => {
    queryControlOverrides.mcpServerStatus = mock(async () => [
      { name: "context7", status: "connected" as const },
    ]);
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.queryControl!.mcpServerStatus = mock(async () => {
      throw new Error("MCP inventory exploded");
    });
    await expect(readSessionMcpServers(session.id)).rejects.toThrow("MCP inventory exploded");
    await finish();
  });
});

describe("catalog writes against a closed transport", () => {
  test("an interrupt that loses to the CLI exiting reports the turn as stopped", async () => {
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.queryControl!.interrupt = mock(async () => {
      throw closedTransport();
    });

    // The turn is over either way, which is what the caller asked for.
    await expect(gracefulInterruptClaudeSession(session.id)).resolves.toEqual({
      interrupted: true,
      stillQueued: [],
    });

    await finish();
  });

  test("a settings change that never landed is a conflict, not a fault", async () => {
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.queryControl!.setModel = mock(async () => {
      throw closedTransport();
    });

    // Reads may quietly fall back; a write must not pretend it succeeded.
    await expect(
      configureClaudeSession(session, { model: "claude-opus-mock" }),
    ).rejects.toMatchObject({ code: "conflict" });

    await finish();
  });

  test("a genuine settings failure keeps its own error", async () => {
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.queryControl!.setModel = mock(async () => {
      throw new Error("setModel exploded");
    });
    await expect(configureClaudeSession(session, { model: "claude-opus-mock" })).rejects.toThrow(
      "setModel exploded",
    );
    await finish();
  });

  test("configuring a session with no live control is a no-op", async () => {
    const session = createSession("no control");
    track(session.id);
    expect(getSession(session.id)?.queryControl).toBeUndefined();
    await expect(
      configureClaudeSession(session, { model: "claude-opus-mock" }),
    ).resolves.toBeUndefined();
  });
});

/** Run one turn that emits `messages` and ends, leaving the session idle. */
async function runTurn(sessionId: string, messages: unknown[]): Promise<void> {
  const turn = sendPrompt(sessionId, "test prompt");
  const call = await nextQueryCall();
  for (const message of messages) call.push(message);
  call.finish();
  await turn;
}

function init(fields: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "init",
    session_id: "sdk-commands",
    mcp_servers: [],
    plugins: [],
    slash_commands: [],
    skills: [],
    ...fields,
  };
}

function idleSession(title: string): SessionState {
  const session = createSession(title);
  track(session.id);
  return getSession(session.id)!;
}

describe("Claude command catalogue", () => {
  test("an empty SDK inventory stays empty: no rows are invented", async () => {
    queryControlOverrides.supportedCommands = mock(async () => []);
    const session = idleSession("empty inventory");
    await runTurn(session.id, [
      init({ slash_commands: ["help"] }),
      { type: "result", subtype: "success" },
    ]);
    await waitFor(() => session.commandInventoryState?.authority === "live");

    const catalogue = await readClaudeCommandCatalogue(session.id);
    expect(catalogue).toMatchObject({ catalogueVersion: 1, status: "ready", commands: [] });
  });

  test("keeps SDK names and aliases, annotates skills and verified plugins, and never guesses", async () => {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "foo", description: "Foo skill", argumentHint: "<topic>" },
      { name: "superpowers:brainstorm", description: "Brainstorm", argumentHint: "" },
      { name: "team:deploy", description: "Deploy", argumentHint: "" },
      { name: "usage", description: "Show usage", argumentHint: "", aliases: ["cost", "stats"] },
    ]);
    const session = idleSession("annotated inventory");
    await runTurn(session.id, [
      init({
        skills: ["foo"],
        plugins: [{ name: "superpowers", path: "/plugins/superpowers", status: "loaded" }],
        slash_commands: ["foo", "superpowers:brainstorm", "team:deploy", "usage"],
      }),
      { type: "result", subtype: "success" },
    ]);
    await waitFor(() => session.commandInventoryState?.authority === "live");

    const { status, commands } = await readClaudeCommandCatalogue(session.id);
    expect(status).toBe("ready");
    expect(commands.map((command) => command.name)).toEqual([
      "/foo",
      "/superpowers:brainstorm",
      "/team:deploy",
      "/usage",
    ]);
    expect(commands.some((command) => command.name.startsWith("/skill:"))).toBe(false);
    const byName = new Map(commands.map((command) => [command.name, command]));
    expect(byName.get("/foo")).toMatchObject({
      id: "claude:/foo",
      executionKind: "provider-prompt",
      source: "skill",
      description: "Foo skill",
      argumentHint: "<topic>",
      bindingRevision: commandBindingRevision(["claude", "/foo"]),
    });
    expect(byName.get("/superpowers:brainstorm")).toMatchObject({
      source: "plugin",
      origin: "plugin",
    });
    // A colon alone is not plugin provenance, and absent metadata is unknown.
    expect(byName.get("/team:deploy")?.source).toBe("unknown");
    expect(byName.get("/usage")).toMatchObject({ source: "unknown", aliases: ["/cost", "/stats"] });
  });

  test("session-changing and terminal-only commands are listed but unavailable", async () => {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "clear", description: "Clear", argumentHint: "", aliases: ["reset"] },
      { name: "theme-picker", description: "Pick a theme", argumentHint: "" },
      { name: "compact", description: "Compact", argumentHint: "" },
    ]);
    const session = idleSession("unavailable rows");
    await runTurn(session.id, [
      init({ terminal_slash_commands: ["theme-picker"] }),
      { type: "result", subtype: "success" },
    ]);
    await waitFor(() => session.commandInventoryState?.authority === "live");
    const byName = new Map(
      (await readClaudeCommandCatalogue(session.id)).commands.map((command) => [
        command.name,
        command,
      ]),
    );
    expect(byName.get("/clear")?.availability).toMatchObject({
      state: "unavailable",
      reason: "session-changing",
    });
    expect(byName.get("/theme-picker")?.availability).toMatchObject({
      state: "unavailable",
      reason: "requires-interactive-ui",
    });
    // The SDK's own /compact runs through its own events.
    expect(byName.get("/compact")?.availability).toBeUndefined();
  });

  test("commands_changed replaces the inventory and stale init names never resurrect a removal", async () => {
    const session = idleSession("replacement");
    await runTurn(session.id, [
      init({ slash_commands: ["keep", "gone"] }),
      {
        type: "system",
        subtype: "commands_changed",
        commands: [{ name: "keep", description: "Still here", argumentHint: "" }],
        uuid: "changed-1",
        session_id: "sdk-commands",
      },
      { type: "result", subtype: "success" },
    ]);
    expect(session.commandInventoryState?.authority).toBe("replacement");
    const revision = session.commandInventoryState!.revision;

    // The next turn's init still names the removed command.
    await runTurn(session.id, [
      init({ slash_commands: ["keep", "gone"] }),
      { type: "result", subtype: "success" },
    ]);
    const callsBeforeRead = mockQuery.mock.calls.length;
    const catalogue = await readClaudeCommandCatalogue(session.id);
    expect(catalogue.status).toBe("ready");
    expect(catalogue.commands.map((command) => command.name)).toEqual(["/keep"]);
    expect(catalogue.revision).toBe(revision);
    // An idle read with a retained inventory spawns no discovery process.
    expect(mockQuery.mock.calls.length).toBe(callsBeforeRead);
  });

  test("init names alone produce plain rows, reported as stale", async () => {
    const session = idleSession("init only");
    await runTurn(session.id, [
      init({ slash_commands: ["review"], skills: ["foo"] }),
      { type: "result", subtype: "success" },
    ]);
    const catalogue = await readClaudeCommandCatalogue(session.id);
    expect(catalogue.status).toBe("stale");
    expect(catalogue.commands.map((command) => [command.name, command.source])).toEqual([
      ["/review", "unknown"],
      ["/foo", "skill"],
    ]);
  });

  test("a genuine live read failure propagates instead of serving the cache", async () => {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "review", description: "Review", argumentHint: "" },
    ]);
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    await readClaudeCommandCatalogue(session.id);
    session.queryControl!.supportedCommands = mock(async () => {
      throw new Error("inventory exploded");
    });
    await expect(readClaudeCommandCatalogue(session.id)).rejects.toThrow("inventory exploded");
    await finish();
  });

  test("a slow live read cannot undo a newer commands_changed replacement", async () => {
    queryControlOverrides.supportedCommands = mock(async () => []);
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    await waitFor(() => session.commandInventoryState?.authority === "live");
    let release!: (rows: unknown[]) => void;
    const slow = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    session.queryControl!.supportedCommands = mock(() => slow) as never;

    const read = readClaudeCommandCatalogue(session.id);
    recordCommandsChanged(session, {
      commands: [{ name: "fresh", description: "", argumentHint: "" }],
    });
    release([{ name: "old", description: "", argumentHint: "" }]);

    expect((await read).commands.map((command) => command.name)).toEqual(["/fresh"]);
    await finish();
  });

  test("an unknown session is answered in band without spawning anything", async () => {
    const callsBefore = mockQuery.mock.calls.length;
    await expect(readClaudeCommandCatalogue("session-never-seen")).resolves.toEqual({
      catalogueVersion: 1,
      status: "missing",
      commands: [],
    });
    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });

  test("a cold read runs one probe configured like the session's turns", async () => {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "review", description: "Review", argumentHint: "" },
    ]);
    const session = idleSession("cold probe");
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "restricted",
    };
    const [first, second] = await Promise.all([
      readClaudeCommandCatalogue(session.id),
      readClaudeCommandCatalogue(session.id),
    ]);
    // Single flight: both readers share one CLI.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const probe = await nextQueryCall();
    expect(probe.options).toMatchObject({ maxTurns: 0, settingSources: ["user"] });
    expect(probe.isClosed()).toBe(true);
    // A probe cannot see everything a real turn can: provisional, not ready.
    expect(first.status).toBe("stale");
    expect(second.commands.map((command) => command.name)).toEqual(["/review"]);
  });
});

describe("Claude command refresh", () => {
  test("reloads resources and re-reads through the live control", async () => {
    queryControlOverrides.supportedCommands = mock(async () => []);
    queryControlOverrides.reloadSkills = mock(async () => ({ skills: [] }));
    queryControlOverrides.reloadPlugins = mock(async () => ({ commands: [], error_count: 0 }));
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    await expect(refreshClaudeCommandCatalogue(session.id)).resolves.toEqual({
      outcome: "reloaded",
    });
    await finish();
  });

  test.each([
    ["a rejected reload", async () => Promise.reject(new Error("plugin dir unreadable"))],
    ["plugins that failed to load", async () => ({ commands: [], error_count: 2 })],
  ])("reports %s as failed, not success", async (_label, reloadPlugins) => {
    queryControlOverrides.supportedCommands = mock(async () => []);
    queryControlOverrides.reloadSkills = mock(async () => ({ skills: [] }));
    queryControlOverrides.reloadPlugins = mock(reloadPlugins);
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    const result = await refreshClaudeCommandCatalogue(session.id);
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("plugins");
    expect((await readClaudeCommandCatalogue(session.id)).status).toBe("ready");
    await finish();
  });

  test("an idle session defers rather than let a probe replace its live list", async () => {
    queryControlOverrides.supportedCommands = mock(async () => []);
    const session = idleSession("idle live refresh");
    await runTurn(session.id, [init(), { type: "result", subtype: "success" }]);
    await waitFor(() => session.commandInventoryState?.authority === "live");
    const callsBefore = mockQuery.mock.calls.length;

    await expect(refreshClaudeCommandCatalogue(session.id)).resolves.toMatchObject({
      outcome: "deferred",
    });
    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });

  test("a provisional list is re-read through a probe, and a failed probe keeps it as stale", async () => {
    const session = idleSession("idle provisional refresh");
    // No control read: the inventory is init names only.
    await runTurn(session.id, [
      init({ slash_commands: ["review"] }),
      { type: "result", subtype: "success" },
    ]);
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "review", description: "Review", argumentHint: "" },
    ]);
    await expect(refreshClaudeCommandCatalogue(session.id)).resolves.toMatchObject({
      outcome: "reread",
    });
    expect(session.commandInventoryState?.authority).toBe("probe");

    queryControlOverrides.supportedCommands = mock(async () => {
      throw new Error("discovery exploded");
    });
    await expect(refreshClaudeCommandCatalogue(session.id)).resolves.toMatchObject({
      outcome: "failed",
      message: "discovery exploded",
    });
    const retained = await readClaudeCommandCatalogue(session.id);
    expect(retained.status).toBe("stale");
    expect(retained.commands.map((command) => command.name)).toEqual(["/review"]);
  });

  test("an unknown session fails in band", async () => {
    await expect(refreshClaudeCommandCatalogue("session-never-seen")).resolves.toMatchObject({
      outcome: "failed",
    });
  });
});

describe("selected Claude commands", () => {
  async function sessionWithInventory(): Promise<SessionState> {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "review", description: "Review", argumentHint: "<path>" },
      { name: "clear", description: "Clear", argumentHint: "" },
    ]);
    const session = idleSession("selected commands");
    await runTurn(session.id, [init(), { type: "result", subtype: "success" }]);
    await waitFor(() => session.commandInventoryState?.authority === "live");
    return session;
  }

  test("sends the canonical name and the argument suffix byte for byte", async () => {
    const session = await sessionWithInventory();
    const callsBefore = mockQuery.mock.calls.length;
    const args = "src/a.ts\n\n  keep  this\tspacing \n";
    const resolution = await resolveClaudeCommandInvocation(session, {
      id: "claude:/review",
      name: "/review",
      executionKind: "provider-prompt",
      bindingRevision: commandBindingRevision(["claude", "/review"]),
      arguments: args,
    });
    expect(resolution).toMatchObject({ ok: true, providerPrompt: `/review ${args}` });
    // A retained inventory answers; no probe per prompt.
    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });

  test.each([
    ["an unknown id", { id: "claude:/deploy", name: "/deploy" }],
    ["a forged name", { id: "claude:/review", name: "/deploy" }],
    ["a stale binding", { bindingRevision: "ffffffffffffffff" }],
    ["an unavailable row", { id: "claude:/clear", name: "/clear" }],
    ["a foreign execution kind", { executionKind: "bridge-local" as const }],
  ])("refuses %s", async (_label, override) => {
    const session = await sessionWithInventory();
    const resolution = await resolveClaudeCommandInvocation(session, {
      id: "claude:/review",
      name: "/review",
      executionKind: "provider-prompt",
      arguments: "",
      ...override,
    });
    expect(resolution.ok).toBe(false);
  });
});

describe("typed text naming an unavailable command", () => {
  test("refuses held unavailable rows and fixed names, case-folded, and passes the rest", async () => {
    queryControlOverrides.supportedCommands = mock(async () => [
      { name: "clear", description: "Clear", argumentHint: "", aliases: ["reset"] },
      { name: "review", description: "Review", argumentHint: "" },
      { name: "picker", description: "Pick", argumentHint: "" },
    ]);
    const session = idleSession("typed guard");
    await runTurn(session.id, [
      init({ terminal_slash_commands: ["picker"] }),
      { type: "result", subtype: "success" },
    ]);
    await waitFor(() => session.commandInventoryState?.authority === "live");

    expect(typedCommandUnavailableMessage(session, "/clear")).toContain("new Claude conversation");
    expect(typedCommandUnavailableMessage(session, "  /RESET now")).toContain(
      "new Claude conversation",
    );
    expect(typedCommandUnavailableMessage(session, "/Picker")).toContain("terminal");
    expect(typedCommandUnavailableMessage(session, "/review src/a.ts")).toBeUndefined();
    expect(typedCommandUnavailableMessage(session, "/tmp/build.log is empty")).toBeUndefined();
    expect(typedCommandUnavailableMessage(session, "/unknown-thing")).toBeUndefined();
    expect(typedCommandUnavailableMessage(session, "plain text /clear")).toBeUndefined();
  });

  test("still refuses a known session-changing name when no inventory is held", () => {
    const session = idleSession("typed guard without inventory");
    expect(session.commandInventoryState).toBeUndefined();
    expect(typedCommandUnavailableMessage(session, "/clear")).toContain("new Claude conversation");
    expect(typedCommandUnavailableMessage(session, "/model opus")).toContain("model picker");
  });
});
