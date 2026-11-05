import { describe, expect, spyOn, test } from "bun:test";
import type WebSocket from "ws";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_CLOSE,
} from "@orkestrator/protocol/terminal-websocket";
import { OrkestratorBackend } from "../src/core/index";
import { ClientGrantService, MAX_GRANT_TTL_MS } from "../src/core/nodes/client-grants";
import type { BrowserSessionStore } from "../src/gateway-sessions";
import {
  blockingTerminalBackend,
  eventClients,
  HELD_INPUT,
  nextTerminalControl,
  openEventStream,
  openTerminalSocket,
  queueBehindBlockedWrite,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

type WatchedSocket = {
  ws: WebSocket;
  authenticated: boolean;
  credentialExpiryTimer: unknown;
  unsubscribeRevocation: unknown;
};

type GatewayInternals = {
  context: { browserSessions: BrowserSessionStore };
  terminalWebSocket: {
    sockets: Set<WatchedSocket>;
    operationSockets: Set<WatchedSocket>;
    pendingOperationCount: number;
    pendingOperationBytes: number;
    sessionOperations: Map<string, unknown>;
  };
};

type CredentialKind = "browser session" | "client grant";

const CONTROLLER = "bk_terminal_controller" as BackendId;
const OTHER_CONTROLLER = "bk_other_controller" as BackendId;

/**
 * A gateway on the production `nodeGateway()` hooks over a real grant service,
 * a real browser session store and a backend whose first terminal operation
 * blocks.
 *
 * `expiring` keeps a credential valid while its deadline is already due on the
 * timer clock, so its expiry timer re-arms until the test lapses it rather than
 * racing a wall-clock deadline. Otherwise the grant's deadline is the full 15
 * minutes away, so anything that reacts did not get there through the timer.
 */
async function credentialFixture(options: { expiring?: boolean } = {}) {
  const terminal = blockingTerminalBackend();
  let grantNow = Date.now() - (options.expiring ? 60_000 : 0);
  const grants = new ClientGrantService(() => grantNow);
  const issued = grants.issue({
    controllerId: CONTROLLER,
    label: "terminal test",
    ttlMs: options.expiring ? 30_000 : MAX_GRANT_TTL_MS,
  });
  const nodeHooks = OrkestratorBackend.prototype.nodeGateway.call({
    nodes: { isPortalOriginAllowed: () => false, noteControllerContact: () => {} },
    nodePortal: { grants },
  } as unknown as OrkestratorBackend);
  const { gateway, info } = await startGateway({ backend: terminal.backend, nodeHooks });
  const internals = gateway as unknown as GatewayInternals;
  const sessions = internals.context.browserSessions;
  const session = sessions.issue();
  let sessionExpired = false;
  if (options.expiring) {
    Object.defineProperty(sessions.records.get(session)!, "expiresAt", {
      get: () => (sessionExpired ? 0 : Date.now() + 1),
    });
  }
  return {
    ...terminal,
    gateway,
    info,
    grants,
    issued,
    sessions,
    session,
    terminalWebSocket: internals.terminalWebSocket,
    expireGrant: () => {
      grantNow = issued.grant.expiresAt;
    },
    setGrantNow: (now: number) => {
      grantNow = now;
    },
    expireSession: () => {
      sessionExpired = true;
    },
    open: async (kind: CredentialKind) => {
      if (kind === "client grant") return openTerminalSocket({ ...info, token: issued.token });
      const opened = await openTerminalSocket(info, {
        authenticate: false,
        headers: {
          Origin: new URL(info.url).origin,
          Cookie: `orkestrator_gateway_auth=${session}`,
        },
      });
      await nextTerminalControl(opened.inbox, "ready");
      return opened;
    },
    /** Revocation listeners registered with the service that owns this credential. */
    listeners: (kind: CredentialKind) =>
      kind === "client grant"
        ? ((
            grants as unknown as {
              grants: Map<string, { revocationListeners: Set<unknown> }>;
            }
          ).grants.get(issued.grant.grantId)?.revocationListeners.size ?? 0)
        : ((
            sessions as unknown as { revocationListeners: Map<string, Set<unknown>> }
          ).revocationListeners.get(session)?.size ?? 0),
  };
}

type Fixture = Awaited<ReturnType<typeof credentialFixture>>;

function onlySocket(fixture: Fixture): WatchedSocket {
  const sockets = [...fixture.terminalWebSocket.sockets];
  expect(sockets).toHaveLength(1);
  return sockets[0]!;
}

async function disconnect(fixture: Fixture, socket: { terminate(): void }): Promise<void> {
  socket.terminate();
  await waitUntil(
    () => fixture.terminalWebSocket.sockets.size === 0,
    "Disconnected socket stayed registered",
  );
}

function expectWatching(state: WatchedSocket): void {
  expect(state.unsubscribeRevocation).not.toBeNull();
  expect(state.credentialExpiryTimer).not.toBeNull();
}

function expectWatchReleased(state: WatchedSocket): void {
  expect(state.unsubscribeRevocation).toBeNull();
  expect(state.credentialExpiryTimer).toBeNull();
}

async function drained(fixture: Fixture): Promise<void> {
  await waitUntil(
    () =>
      fixture.terminalWebSocket.pendingOperationCount === 0 &&
      fixture.terminalWebSocket.operationSockets.size === 0,
    "Terminal operations stayed queued",
  );
  expect(fixture.terminalWebSocket.pendingOperationBytes).toBe(0);
  expect(fixture.terminalWebSocket.sessionOperations.size).toBe(0);
}

const LAPSES: Array<{
  name: string;
  kind: CredentialKind;
  expiring?: boolean;
  /** Published by the credential's owner, not noticed later by the expiry timer. */
  signalled: boolean;
  apply(fixture: Fixture): void;
}> = [
  {
    name: "browser session revocation",
    kind: "browser session",
    signalled: true,
    apply: (fixture) => fixture.sessions.revoke(fixture.session),
  },
  {
    name: "browser session expiry",
    kind: "browser session",
    expiring: true,
    signalled: false,
    apply: (fixture) => fixture.expireSession(),
  },
  {
    name: "client grant expiry",
    kind: "client grant",
    expiring: true,
    signalled: false,
    apply: (fixture) => fixture.expireGrant(),
  },
  {
    name: "single-grant revocation",
    kind: "client grant",
    signalled: true,
    apply: (fixture) => {
      expect(fixture.grants.revoke(fixture.issued.grant.grantId)).toBe(true);
    },
  },
  {
    name: "controller revocation",
    kind: "client grant",
    signalled: true,
    apply: (fixture) => {
      expect(fixture.grants.revokeController(CONTROLLER)).toBe(1);
    },
  },
  {
    name: "global revocation",
    kind: "client grant",
    signalled: true,
    apply: (fixture) => fixture.grants.revokeAll(),
  },
];

describe("terminal operations after a credential lapses", () => {
  // The write already in the backend cannot be recalled; nothing queued behind it
  // may run once the credential that admitted it has gone.
  for (const lapse of LAPSES) {
    test(`an open socket closes and its queue is refused on ${lapse.name}`, async () => {
      const fixture = await credentialFixture({ expiring: lapse.expiring });
      const terminal = await fixture.open(lapse.kind);
      try {
        const { channelId } = await queueBehindBlockedWrite(
          terminal,
          fixture.operations,
          fixture.terminalWebSocket,
        );
        const state = onlySocket(fixture);
        const closed = new Promise<number>((resolve) => terminal.socket.once("close", resolve));
        lapse.apply(fixture);
        if (lapse.signalled) {
          // Refused before this call returned, with the deadline still far away. The
          // client has not heard yet, so its next input races the close and must lose.
          expect(state.authenticated).toBe(false);
          terminal.socket.send(
            encodeTerminalBinaryFrame({
              type: TERMINAL_BINARY_FRAME_TYPE.input,
              channelId,
              generation: 1,
              revision: 4,
              bytes: HELD_INPUT,
            }),
          );
        }
        // Closed while the write is still blocked: nothing here waits on the queue.
        expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
        expect(fixture.operations).toEqual(["terminal_write"]);

        fixture.release();
        await drained(fixture);
        await waitUntil(
          () => fixture.terminalWebSocket.sockets.size === 0,
          "Revoked socket was not disposed",
        );
        expect(fixture.operations).toEqual(["terminal_write"]);
        expectWatchReleased(state);
        expect(fixture.listeners(lapse.kind)).toBe(0);
      } finally {
        fixture.release();
        terminal.socket.terminate();
      }
    });

    test(`a disconnected socket's queue is refused on ${lapse.name}`, async () => {
      const fixture = await credentialFixture({ expiring: lapse.expiring });
      const terminal = await fixture.open(lapse.kind);
      try {
        await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
        const state = onlySocket(fixture);
        await disconnect(fixture, terminal.socket);
        expectWatching(state);
        expect(fixture.listeners(lapse.kind)).toBe(1);

        lapse.apply(fixture);
        if (lapse.signalled) expect(state.authenticated).toBe(false);
        await waitUntil(() => !state.authenticated, "The lapse never reached the closed socket");
        // Released at once rather than at settlement: nothing can undo the refusal.
        expectWatchReleased(state);
        expect(fixture.listeners(lapse.kind)).toBe(0);

        fixture.release();
        await drained(fixture);
        expect(fixture.operations).toEqual(["terminal_write"]);
      } finally {
        fixture.release();
      }
    });
  }

  for (const transport of ["bearer header", "cookie"] as const) {
    for (const disconnected of [false, true]) {
      test(`an upgrade grant in a ${transport} refuses queued work on revocation (${disconnected ? "disconnected" : "open"})`, async () => {
        const fixture = await credentialFixture();
        const terminal = await openTerminalSocket(fixture.info, {
          authenticate: false,
          headers: {
            Origin: new URL(fixture.info.url).origin,
            ...(transport === "bearer header"
              ? { Authorization: `Bearer ${fixture.issued.token}` }
              : { Cookie: `orkestrator_gateway_auth=${fixture.issued.token}` }),
          },
        });
        try {
          // No authenticate frame: the upgrade credential alone must arm the watch.
          await nextTerminalControl(terminal.inbox, "ready");
          await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
          const state = onlySocket(fixture);
          expectWatching(state);
          expect(fixture.listeners("client grant")).toBe(1);
          if (disconnected) await disconnect(fixture, terminal.socket);
          const closed = disconnected
            ? null
            : new Promise<number>((resolve) => terminal.socket.once("close", resolve));

          expect(fixture.grants.revoke(fixture.issued.grant.grantId)).toBe(true);
          expect(state.authenticated).toBe(false);
          expectWatchReleased(state);
          expect(fixture.listeners("client grant")).toBe(0);
          if (closed) expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
          expect(fixture.operations).toEqual(["terminal_write"]);

          fixture.release();
          await drained(fixture);
          expect(fixture.operations).toEqual(["terminal_write"]);
        } finally {
          fixture.release();
          terminal.socket.terminate();
        }
      });
    }
  }

  for (const kind of ["browser session", "client grant"] as const) {
    test(`a plain disconnect on a valid ${kind} runs its queue, then releases the watch`, async () => {
      const fixture = await credentialFixture();
      const terminal = await fixture.open(kind);
      await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
      const state = onlySocket(fixture);
      await disconnect(fixture, terminal.socket);
      expectWatching(state);
      expect(fixture.listeners(kind)).toBe(1);

      fixture.release();
      await drained(fixture);
      expect(fixture.operations).toEqual(["terminal_write", "terminal_write", "terminal_resize"]);
      expect(state.authenticated).toBe(true);
      expectWatchReleased(state);
      expect(fixture.listeners(kind)).toBe(0);
    });
  }

  test("a credential still valid at its deadline keeps a disconnected queue running", async () => {
    const fixture = await credentialFixture({ expiring: true });
    const terminal = await fixture.open("client grant");
    await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
    const state = onlySocket(fixture);
    await disconnect(fixture, terminal.socket);

    // The re-arm branch runs against the closed socket, and resubscribes each time.
    const armed = state.credentialExpiryTimer;
    await waitUntil(() => state.credentialExpiryTimer !== armed, "Expiry timer never re-armed");
    expect(state.authenticated).toBe(true);
    expect(fixture.listeners("client grant")).toBe(1);

    fixture.release();
    await drained(fixture);
    expect(fixture.operations).toEqual(["terminal_write", "terminal_write", "terminal_resize"]);
    expectWatchReleased(state);
    expect(fixture.listeners("client grant")).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.credentialExpiryTimer).toBeNull();
  });

  for (const kind of ["browser session", "client grant"] as const) {
    test(`expiry discovered during authentication closes a ${kind} gracefully once`, async () => {
      const fixture = await credentialFixture({ expiring: true });
      const terminal = await fixture.open(kind);
      const state = onlySocket(fixture);
      const close = spyOn(state.ws, "close");
      const terminate = spyOn(state.ws, "terminate");
      try {
        const closed = new Promise<number>((resolve) => terminal.socket.once("close", resolve));
        if (kind === "client grant") fixture.expireGrant();
        else fixture.expireSession();
        expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
        expect(close).toHaveBeenCalledTimes(1);
        expect(terminate).not.toHaveBeenCalled();
        expectWatchReleased(state);
        expect(fixture.listeners(kind)).toBe(0);
      } finally {
        close.mockRestore();
        terminate.mockRestore();
        terminal.socket.terminate();
      }
    });
  }

  test("renewing a real grant preserves a disconnected queue past its original deadline", async () => {
    const fixture = await credentialFixture({ expiring: true });
    const terminal = await fixture.open("client grant");
    try {
      await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
      const state = onlySocket(fixture);
      await disconnect(fixture, terminal.socket);
      const armed = state.credentialExpiryTimer;

      fixture.setGrantNow(fixture.issued.grant.expiresAt - 1);
      const renewed = fixture.grants.renew({
        grantId: fixture.issued.grant.grantId,
        controllerId: CONTROLLER,
        ttlMs: MAX_GRANT_TTL_MS,
      });
      expect(renewed).not.toBeNull();
      expect(renewed!.expiresAt).toBeGreaterThan(fixture.issued.grant.expiresAt);
      fixture.expireGrant(); // Cross the original deadline with the renewed record in place.
      await waitUntil(() => state.credentialExpiryTimer !== armed, "Renewed timer never re-armed");
      expect(state.authenticated).toBe(true);
      expectWatching(state);
      expect(fixture.listeners("client grant")).toBe(1);
      expect(fixture.operations).toEqual(["terminal_write"]);

      fixture.release();
      await drained(fixture);
      expect(fixture.operations).toEqual(["terminal_write", "terminal_write", "terminal_resize"]);
      expectWatchReleased(state);
      expect(fixture.listeners("client grant")).toBe(0);
    } finally {
      fixture.release();
      terminal.socket.terminate();
    }
  });

  test("every disconnected socket holds one listener until its own queue settles", async () => {
    const fixture = await credentialFixture();
    const first = await fixture.open("client grant");
    const second = await fixture.open("client grant");
    await queueBehindBlockedWrite(first, fixture.operations, fixture.terminalWebSocket);
    second.socket.send(JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "other" }));
    const subscribed = await nextTerminalControl(second.inbox, "subscribed");
    if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
    expect(fixture.listeners("client grant")).toBe(2);

    // No queue on the second socket, so its listener goes with the socket.
    second.socket.terminate();
    await waitUntil(() => fixture.listeners("client grant") === 1, "Idle socket kept its listener");
    expect(fixture.terminalWebSocket.sockets.size).toBe(1);

    await disconnect(fixture, first.socket);
    expect(fixture.listeners("client grant")).toBe(1);
    fixture.release();
    await drained(fixture);
    expect(fixture.listeners("client grant")).toBe(0);
  });

  test("an open socket keeps watching after its queue drains, so an idle one still closes", async () => {
    const fixture = await credentialFixture();
    const terminal = await fixture.open("client grant");
    await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
    const state = onlySocket(fixture);
    fixture.release();
    await drained(fixture);
    expectWatching(state);
    expect(fixture.listeners("client grant")).toBe(1);

    const closed = new Promise<number>((resolve) => terminal.socket.once("close", resolve));
    fixture.grants.revoke(fixture.issued.grant.grantId);
    expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
    expectWatchReleased(state);
  });

  test("revoking another grant or controller leaves the socket and its queue alone", async () => {
    const fixture = await credentialFixture();
    const other = fixture.grants.issue({
      controllerId: OTHER_CONTROLLER,
      label: "unrelated",
      ttlMs: 60_000,
    });
    const terminal = await fixture.open("client grant");
    try {
      await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
      const state = onlySocket(fixture);

      expect(fixture.grants.revoke(fixture.issued.grant.grantId, OTHER_CONTROLLER)).toBe(false);
      expect(fixture.grants.revoke(other.grant.grantId)).toBe(true);
      expect(fixture.grants.revokeController(OTHER_CONTROLLER)).toBe(0);
      expect(state.authenticated).toBe(true);

      fixture.release();
      await drained(fixture);
      expect(fixture.operations).toEqual(["terminal_write", "terminal_write", "terminal_resize"]);
      expect(terminal.socket.readyState).toBe(terminal.socket.OPEN);
    } finally {
      fixture.release();
      terminal.socket.terminate();
    }
  });

  test("a revoked grant's queue does not hold back another credential's input", async () => {
    const fixture = await credentialFixture();
    const revoked = await fixture.open("client grant");
    const durable = await openTerminalSocket(fixture.info);
    try {
      await queueBehindBlockedWrite(revoked, fixture.operations, fixture.terminalWebSocket);
      durable.socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "queued" }));
      const subscribed = await nextTerminalControl(durable.inbox, "subscribed");
      if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
      durable.socket.send(
        encodeTerminalBinaryFrame({
          type: TERMINAL_BINARY_FRAME_TYPE.input,
          channelId: subscribed.channelId,
          generation: 1,
          revision: 1,
          bytes: new TextEncoder().encode("durable"),
        }),
      );
      await waitUntil(
        () => fixture.terminalWebSocket.pendingOperationCount === 4,
        "Durable input was not queued",
      );

      revoked.socket.terminate();
      await waitUntil(
        () => fixture.terminalWebSocket.sockets.size === 1,
        "Disconnected socket stayed registered",
      );
      fixture.grants.revoke(fixture.issued.grant.grantId);
      fixture.release();
      expect(await nextTerminalControl(durable.inbox, "operation-result")).toMatchObject({
        ok: true,
        operation: "input",
      });
      await drained(fixture);
      expect(
        fixture.backend.invoke.mock.calls
          .filter(([command]) => command === "terminal_write" || command === "terminal_resize")
          .map(([, args]) => args.data),
      ).toEqual(["held", "durable"]);
    } finally {
      fixture.release();
      durable.socket.terminate();
    }
  });

  test("gateway stop releases a disconnected socket's watch while its write runs", async () => {
    const fixture = await credentialFixture();
    const terminal = await fixture.open("client grant");
    await queueBehindBlockedWrite(terminal, fixture.operations, fixture.terminalWebSocket);
    const state = onlySocket(fixture);
    await disconnect(fixture, terminal.socket);
    expectWatching(state);

    await fixture.gateway.stop();
    expect(state.authenticated).toBe(false);
    expectWatchReleased(state);
    expect(fixture.listeners("client grant")).toBe(0);
    expect(fixture.terminalWebSocket.pendingOperationCount).toBe(3);

    fixture.release();
    await drained(fixture);
    expect(fixture.operations).toEqual(["terminal_write"]);
  });

  test("grant revocation ends an event stream, and closing one releases its listener", async () => {
    const fixture = await credentialFixture();
    const revoked = await openEventStream(fixture.gateway, {
      ...fixture.info,
      token: fixture.issued.token,
    });
    const closedByClient = await openEventStream(fixture.gateway, {
      ...fixture.info,
      token: fixture.issued.token,
    });
    expect(fixture.listeners("client grant")).toBe(2);

    closedByClient.close();
    await waitUntil(
      () => fixture.listeners("client grant") === 1,
      "A closed event stream kept its listener",
    );

    fixture.grants.revoke(fixture.issued.grant.grantId);
    await waitUntil(() => eventClients(fixture.gateway).size === 0, "Event stream stayed open");
    await waitUntil(() => revoked.aborted(), "Event stream client was not disconnected");
  });
});
