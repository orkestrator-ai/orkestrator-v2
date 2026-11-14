import { expect, mock, test } from "bun:test";
import { Agent, request as httpRequest } from "node:http";
import { startGateway } from "./gateway-test-harness.js";

/** Bun closes about a second after the 5 s default, so this idles past that close. */
export const PAST_DEFAULT_CLOSE_MS = 6_500;

// Serve's upstream transport retires idle connections after 90 s. Exercise a
// reusable connection near that boundary and beyond Bun's default 60 s
// headersTimeout, without racing the client's own idle expiry.
const SERVE_IDLE_CONN_TIMEOUT_MS = 90_000;
export const NEAR_SERVE_IDLE_CLOSE_MS = 85_000;

/**
 * Registers the test that an idle keep-alive connection serves another POST.
 *
 * The idle waits are the subject, so they stay real, and the cases live in
 * separate files (the gateway harness cleans up every gateway after each test,
 * which rules out running them side by side in one file): a runner with spare
 * workers waits them out together instead of one after another.
 */
export function idlePostTest(idleMs: number, timeoutMs: number): void {
  test(
    `the same connection serves another POST after ${idleMs} ms idle with a Serve-style idle timeout`,
    async () => {
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
    timeoutMs,
  );
}
