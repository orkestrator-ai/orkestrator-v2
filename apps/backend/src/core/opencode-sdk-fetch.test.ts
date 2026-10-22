import { afterEach, describe, expect, mock, test } from "bun:test";
import { openCodeSdkFetch } from "./http-bridge-transport.js";
import { createOpenCodeSdkClient } from "./opencode-sdk-client.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";

// OpenCode SDK clients reach their server without `bridgeFetch`, so their
// requests are charged through the fetch the SDK is given.

afterEach(() => {
  recurringWorkMetrics.reset();
});

describe("openCodeSdkFetch", () => {
  test("charges one provider request per call to the job that made it", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const url = `http://127.0.0.1:${server.port}/session`;
      await recurringWorkMetrics.observe("native-activity-sweep", async () => {
        expect(await (await openCodeSdkFetch(new Request(url))).text()).toBe("ok");
        expect(await (await openCodeSdkFetch(url, { method: "POST" })).text()).toBe("ok");
      });
      const snapshot = recurringWorkMetrics.snapshot();
      expect(snapshot.kinds["native-activity-sweep"]?.workUnits).toEqual({
        "provider-request": 2,
      });
      expect(snapshot.unattributed.workUnits).toEqual({});
    } finally {
      await server.stop(true);
    }
  });

  test("the caller's signal still aborts a request", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    });
    try {
      const controller = new AbortController();
      const pending = openCodeSdkFetch(`http://127.0.0.1:${server.port}/event`, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  });

  test("the provider's default SDK client charges its requests", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
    try {
      const client = createOpenCodeSdkClient({ baseUrl: `http://127.0.0.1:${server.port}` });
      await recurringWorkMetrics.observe("native-activity-sweep", async () => {
        expect((await client.session.list()).data).toEqual([]);
      });
      expect(recurringWorkMetrics.snapshot().kinds["native-activity-sweep"]?.workUnits).toEqual({
        "provider-request": 1,
      });
    } finally {
      await server.stop(true);
    }
  });
  test("disables Bun's idle timeout while preserving request headers and caller cancellation", async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(async () => new Response("ok"));
    const replacement = Object.assign(fetchMock, { preconnect: original.preconnect });
    const controller = new AbortController();
    const request = new Request("http://127.0.0.1:1/oauth", {
      signal: controller.signal,
      headers: { "x-test": "kept" },
    });
    try {
      globalThis.fetch = replacement as typeof fetch;
      await openCodeSdkFetch(request, { signal: controller.signal, method: "POST" });
      expect(fetchMock).toHaveBeenCalledWith(request, {
        signal: controller.signal,
        method: "POST",
        timeout: false,
      });
      expect(request.headers.get("x-test")).toBe("kept");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("SDK event-stream reconnects charge each HTTP attempt and cancellation stops the stream", async () => {
    let requests = 0;
    const paths: string[] = [];
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        requests += 1;
        if (requests === 1) return new Response("retry", { status: 503 });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"event-1","type":"server.connected","properties":{}}\n\n',
                ),
              );
            },
            cancel() {
              cancelled();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const controller = new AbortController();
    try {
      const client = createOpenCodeSdkClient({ baseUrl: `http://127.0.0.1:${server.port}` });
      await recurringWorkMetrics.observe("native-activity-sweep", async () => {
        const events = await client.event.subscribe(undefined, {
          signal: controller.signal,
          sseDefaultRetryDelay: 1,
          sseMaxRetryAttempts: 3,
        });
        const stream = events.stream;
        expect((await stream.next()).value).toEqual({
          id: "event-1",
          type: "server.connected",
          properties: {},
        });
        controller.abort();
        expect((await stream.next()).done).toBe(true);
      });
      await cancellation;
      expect(paths).toEqual(["/event", "/event"]);
      expect(recurringWorkMetrics.snapshot().kinds["native-activity-sweep"]?.workUnits).toEqual({
        "provider-request": 2,
      });
      expect(recurringWorkMetrics.snapshot().unattributed.workUnits).toEqual({});
    } finally {
      controller.abort();
      await server.stop(true);
    }
  });
});
