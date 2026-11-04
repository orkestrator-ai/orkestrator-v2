import { describe, expect, test } from "bun:test";
import { TERMINAL_WEBSOCKET_CLOSE } from "@orkestrator/protocol/terminal-websocket";
import { nextTerminalControl, openTerminalSocket, startGateway } from "./gateway-test-harness";

describe("gateway terminal WebSocket liveness probe", () => {
  test("advertises ping in ready and answers each ping with its nonce", async () => {
    const { info } = await startGateway();
    const { socket, inbox } = await openTerminalSocket(info, { authenticate: false });
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
    expect(await nextTerminalControl(inbox, "ready")).toMatchObject({ features: ["ping"] });

    socket.send(JSON.stringify({ type: "ping", nonce: 41 }));
    socket.send(JSON.stringify({ type: "ping", nonce: 42 }));
    expect(await nextTerminalControl(inbox, "pong")).toEqual({ type: "pong", nonce: 41 });
    expect(await nextTerminalControl(inbox, "pong")).toEqual({ type: "pong", nonce: 42 });
    socket.terminate();
  });

  test("refuses a ping before authentication", async () => {
    const { info } = await startGateway();
    const { socket } = await openTerminalSocket(info, { authenticate: false });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "ping", nonce: 1 }));
    expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
  });
});
