import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { startGateway } from "./gateway-test-harness.js";
import { GATEWAY_KEEP_ALIVE_TIMEOUT_MS } from "../src/gateway-lifecycle";

/** Tailscale Serve's idle upstream timeout: `getTransport` in ipn/ipnlocal/serve.go. */
const SERVE_IDLE_CONN_TIMEOUT_MS = 90_000;

/** The keep-alive hint a listener sends over a real keep-alive connection. */
function keepAliveHint(baseUrl: string, token: string): Promise<string | undefined> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `GET /__orkestrator/status HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          `Authorization: Bearer ${token}\r\nConnection: keep-alive\r\n\r\n`,
      );
    });
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(/^keep-alive:\s*(.*)$/im.exec(String(chunk))?.[1]?.trim());
    });
    socket.once("error", reject);
  });
}

describe("gateway keep-alive", () => {
  test("outlasts Tailscale Serve's idle timeout, so Serve is the side that closes", () => {
    expect(GATEWAY_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(SERVE_IDLE_CONN_TIMEOUT_MS);
  });

  test("every listener runs with it, as its response header shows", async () => {
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      loopbackClientPort: 0,
    });
    const expected = `timeout=${GATEWAY_KEEP_ALIVE_TIMEOUT_MS / 1000}`;
    for (const url of [info.controlUrl!, info.browserUrl!, info.loopbackClientUrl!]) {
      expect(await keepAliveHint(url, info.token)).toBe(expected);
    }
  });
});
