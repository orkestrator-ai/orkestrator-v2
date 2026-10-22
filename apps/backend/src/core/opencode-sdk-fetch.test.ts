import { afterEach, describe, expect, test } from "bun:test";
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
});
