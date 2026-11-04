import { describe, expect, mock, test } from "bun:test";
import { Agent, request as httpRequest } from "node:http";
import { TERMINAL_WEBSOCKET_SUBPROTOCOL } from "@orkestrator/protocol/terminal-websocket";
import { WebSocket } from "ws";
import { nextTerminalControl, startGateway, websocketInbox } from "./gateway-test-harness.js";

/** Bun closes about a second after the 5 s default, so this idles past that close. */
const PAST_DEFAULT_CLOSE_MS = 6_500;

// Serve's upstream transport retires idle connections after 90 s. Exercise a
// reusable connection near that boundary and beyond Bun's default 60 s
// headersTimeout, without racing the client's own idle expiry.
const SERVE_IDLE_CONN_TIMEOUT_MS = 90_000;
const NEAR_SERVE_IDLE_CLOSE_MS = 85_000;

describe("gateway connections idle past the default keep-alive close", () => {
  test.each([PAST_DEFAULT_CLOSE_MS, NEAR_SERVE_IDLE_CLOSE_MS])(
    "the same connection serves another POST after %i ms idle with a Serve-style idle timeout",
    async (idleMs) => {
      const invoke = mock(async () => ({ ok: true }));
      const { info } = await startGateway({ backend: { invoke } });
      const endpoint = new URL(`${info.url}__orkestrator/invoke`);
      const body = JSON.stringify({ command: "ping", args: {} });
      const agent = new Agent({
        keepAlive: true,
        maxSockets: 1,
        maxFreeSockets: 1,
        timeout: SERVE_IDLE_CONN_TIMEOUT_MS,
      });
      const post = () =>
        new Promise<{ status: number | undefined; socket: unknown; reused: boolean }>(
          (resolve, reject) => {
            const request = httpRequest(
              endpoint,
              {
                agent,
                method: "POST",
                signal: AbortSignal.timeout(5_000),
                headers: {
                  authorization: `Bearer ${info.token}`,
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                },
              },
              (response) => {
                const socket = response.socket;
                response.on("error", reject);
                response.on("end", () =>
                  resolve({
                    status: response.statusCode,
                    socket,
                    reused: request.reusedSocket,
                  }),
                );
                response.resume();
              },
            );
            request.on("error", reject);
            request.end(body);
          },
        );

      try {
        const first = await post();
        expect(first.status).toBe(200);
        expect(first.reused).toBe(false);

        await Bun.sleep(idleMs);

        const second = await post();
        expect(second.status).toBe(200);
        // A successful request on a replacement connection hides the regression.
        expect(second.reused).toBe(true);
        expect(second.socket).toBe(first.socket);
        expect(invoke).toHaveBeenCalledTimes(2);
      } finally {
        agent.destroy();
      }
    },
    NEAR_SERVE_IDLE_CLOSE_MS + 15_000,
  );

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
