import { describe, expect, mock, test } from "bun:test";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { TERMINAL_WEBSOCKET_SUBPROTOCOL } from "@orkestrator/protocol/terminal-websocket";
import { WebSocket } from "ws";
import { nextTerminalControl, startGateway, websocketInbox } from "./gateway-test-harness.js";

/** Bun closes about a second after the 5 s default, so this idles past that close. */
const PAST_DEFAULT_CLOSE_MS = 6_500;

describe("gateway connections idle past the default keep-alive close", () => {
  test("the same connection serves another POST", async () => {
    const invoke = mock(async () => ({ ok: true }));
    const { info } = await startGateway({ backend: { invoke } });
    const { hostname, port } = new URL(info.url);
    const body = JSON.stringify({ command: "ping", args: {} });
    const post =
      `POST /__orkestrator/invoke HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${info.token}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}`;
    const socket = connect(Number(port), hostname);
    let closed = false;
    socket.once("close", () => (closed = true));
    const nextResponse = () =>
      new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(String(chunk))));

    const first = nextResponse();
    socket.write(post);
    expect(await first).toStartWith("HTTP/1.1 200");

    await Bun.sleep(PAST_DEFAULT_CLOSE_MS);
    expect(closed).toBe(false);

    const second = nextResponse();
    socket.write(post);
    expect(await second).toStartWith("HTTP/1.1 200");
    socket.destroy();
    expect(invoke).toHaveBeenCalledTimes(2);
  }, 15_000);

  test("a quiet event stream and terminal WebSocket stay open and deliver", async () => {
    // No keepalive frame may hide a stream that the idle close has ended.
    const { gateway, info } = await startGateway({ keepaliveMs: 60_000 });
    const endpoint = new URL(`${info.url}__orkestrator/events`);
    let received = "";
    let streamEnded = false;
    const stream = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        headers: { authorization: `Bearer ${info.token}`, "accept-encoding": "identity" },
      },
      (response) => {
        response.on("data", (chunk) => (received += String(chunk)));
        response.once("close", () => (streamEnded = true));
      },
    );
    stream.on("error", () => (streamEnded = true));
    stream.end();

    const socket = new WebSocket(
      `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`,
      TERMINAL_WEBSOCKET_SUBPROTOCOL,
    );
    const inbox = websocketInbox(socket);
    let socketClosed = false;
    socket.once("close", () => (socketClosed = true));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
    await nextTerminalControl(inbox, "ready");

    await Bun.sleep(PAST_DEFAULT_CLOSE_MS);
    expect(streamEnded).toBe(false);
    expect(socketClosed).toBe(false);
    const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()));
    socket.ping();
    await pong;

    gateway.emit("keep-alive-probe", { delivered: true });
    const deadline = Date.now() + 2_000;
    while (!received.includes("keep-alive-probe") && Date.now() < deadline) await Bun.sleep(10);
    expect(received).toContain("keep-alive-probe");

    socket.terminate();
    stream.destroy();
  }, 15_000);
});
