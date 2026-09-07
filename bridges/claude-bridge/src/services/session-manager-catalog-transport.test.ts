import { describe, expect, mock, test } from "bun:test";
import {
  createSession,
  getSession,
  inspectDuringTurn,
  queryControlOverrides,
  track,
} from "./session-manager-test-harness.js";
import {
  configureClaudeSession,
  gracefulInterruptClaudeSession,
  isClosedTransportError,
  readSessionCommands,
  readSessionMcpServers,
} from "./session-manager.js";

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
