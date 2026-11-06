import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { GatewayContext } from "./gateway-context.js";
import { GatewayLifecycle } from "./gateway-lifecycle.js";

test("listener wiring classifies socket closure in event order and releases tracking once", async () => {
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const noteConnection = mock((_listener: string) => {});
  const noteSocketClosed = mock((_socket: Socket, _reason: string) => {});
  const ctx = {
    sockets,
    servers,
    env: {},
    traffic: { noteConnection, noteSocketClosed },
  } as unknown as GatewayContext;
  const lifecycle = new GatewayLifecycle(ctx, { handle: async () => {} });
  await lifecycle.listen("127.0.0.1", 0, "browser");
  const server = Array.from(servers)[0]!;
  // Exercise the exact connection handler installed by listen, without an
  // operating-system-dependent FIN/reset race in the HTTP compatibility layer.
  const connected = server.listeners("connection").at(-1)!;
  const cases = [
    { events: ["end", "close"], writableEnded: false, hadError: false, expected: "peer" },
    { events: ["close"], writableEnded: false, hadError: false, expected: "server" },
    { events: ["end", "close"], writableEnded: true, hadError: false, expected: "server" },
    { events: ["error", "close"], writableEnded: false, hadError: false, expected: "error" },
    { events: ["end", "error", "close"], writableEnded: false, hadError: false, expected: "error" },
    { events: ["error", "end", "close"], writableEnded: false, hadError: false, expected: "error" },
    { events: ["close"], writableEnded: false, hadError: true, expected: "error" },
  ];
  try {
    for (const scenario of cases) {
      const socket = Object.assign(new EventEmitter(), { writableEnded: scenario.writableEnded });
      // HTTP's handler ends the writable side on peer FIN. Our prepended
      // observer must see its original value before that happens.
      socket.once("end", () => {
        socket.writableEnded = true;
      });
      const trackedSocket = socket as unknown as Socket;
      connected(trackedSocket);
      expect(sockets.has(socket as unknown as Socket)).toBe(true);
      for (const event of scenario.events) {
        socket.emit(event, event === "error" ? new Error("reset") : scenario.hadError);
      }
      expect(noteSocketClosed.mock.calls.at(-1)).toEqual([trackedSocket, scenario.expected]);
      expect(sockets.has(socket as unknown as Socket)).toBe(false);
      const count = noteSocketClosed.mock.calls.length;
      socket.emit("close", false);
      expect(noteSocketClosed).toHaveBeenCalledTimes(count);
    }
    expect(noteConnection).toHaveBeenCalledTimes(cases.length);
    expect(noteConnection.mock.calls.every((args) => args[0] === "browser")).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    servers.clear();
  }
});
