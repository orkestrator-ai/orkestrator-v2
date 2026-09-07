import { afterEach, describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";

/**
 * `dispose()` against a live event stream, using the real OpenCode SDK client.
 *
 * The rest of the OpenCode suite injects a fake client whose event harness
 * closes cleanly the moment its signal aborts. That is exactly the case this
 * regression is not: in production the stream is a real `fetch` body, and
 * aborting it while a `reader.read()` is pending left the SDK's own
 * `reader.cancel()` rejecting with nobody listening. Under Bun that unhandled
 * rejection killed the backend process, and the desktop supervisor answers a
 * backend exit by closing the app.
 *
 * So this test deliberately drives the real client against a real HTTP server.
 * A fake cannot reproduce it, which is why the bug shipped.
 */

type Harness = {
  url: string;
  stop: () => void;
  connections: number;
};

function startEventServer(): Harness {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const harness: Partial<Harness> & { connections: number } = { connections: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.endsWith("/event")) {
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        });
      }
      harness.connections++;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // One event, then an open stream. The provider's monitor loop parks
          // on `reader.read()`, which is the state dispose() has to survive.
          controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'));
          const timer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            } catch {
              clearInterval(timer);
            }
          }, 25);
          timers.add(timer);
        },
        cancel() {
          for (const timer of timers) clearInterval(timer);
          timers.clear();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  harness.url = `http://127.0.0.1:${server.port}`;
  harness.stop = () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    server.stop(true);
  };
  return harness as Harness;
}

const restoreListeners: Array<() => void> = [];

afterEach(() => {
  while (restoreListeners.length > 0) restoreListeners.pop()?.();
});

/** Collect unhandled rejections without letting them fail the run. */
function captureUnhandledRejections(): { reasons: unknown[] } {
  const captured: unknown[] = [];
  const handler = (reason: unknown) => captured.push(reason);
  process.on("unhandledRejection", handler as NodeJS.UnhandledRejectionListener);
  restoreListeners.push(() => {
    process.off("unhandledRejection", handler as NodeJS.UnhandledRejectionListener);
  });
  return { reasons: captured };
}

describe("OpenCode provider dispose", () => {
  test("aborting a live event stream does not leave an unhandled rejection", async () => {
    const harness = startEventServer();
    const captured = captureUnhandledRejections();
    try {
      const provider = createNativeAgentProvider(
        {
          agent: "opencode",
          baseUrl: harness.url,
          authToken: "test-token",
          directory: "/workspace",
        },
        // No injected client: the real SDK client and its real SSE reader are
        // the subject of this test.
        { autoAnswerRequests: false, monitorRetryMs: 1 },
      );

      // Let the subscription connect and park mid-read before disposing.
      const deadline = Date.now() + 5_000;
      while (harness.connections === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(harness.connections).toBeGreaterThan(0);
      await Bun.sleep(50);

      await provider.dispose?.();

      // Rejections surface on a later microtask turn than the abort.
      await Bun.sleep(100);
      expect(captured.reasons).toEqual([]);
    } finally {
      harness.stop();
    }
  }, 15_000);

  test("dispose stays idempotent and resolves once the stream is gone", async () => {
    const harness = startEventServer();
    const captured = captureUnhandledRejections();
    try {
      const provider = createNativeAgentProvider(
        {
          agent: "opencode",
          baseUrl: harness.url,
          authToken: "test-token",
          directory: "/workspace",
        },
        { autoAnswerRequests: false, monitorRetryMs: 1 },
      );
      const deadline = Date.now() + 5_000;
      while (harness.connections === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      await provider.dispose?.();
      await expect(provider.dispose?.()).resolves.toBeUndefined();
      await Bun.sleep(100);
      expect(captured.reasons).toEqual([]);
    } finally {
      harness.stop();
    }
  }, 15_000);
});
