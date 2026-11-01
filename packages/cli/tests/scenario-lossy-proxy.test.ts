import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { startLossyProxy, type LossyProxy } from "../scenarios/lossy-proxy.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A stand-in backend that records what reached it and answers each invoke. */
async function upstream() {
  const received: Array<{ action: unknown; authorization: string | null; path: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { args: { action: unknown } };
      received.push({
        action: body.args.action,
        authorization: request.headers.get("authorization"),
        path: new URL(request.url).pathname,
      });
      return new Response(gzipSync(JSON.stringify({ result: { action: body.args.action } })), {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    },
  });
  stops.push(async () => {
    await server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, received };
}

async function invoke(proxy: LossyProxy, action: string) {
  return fetch(`${proxy.url}/__orkestrator/invoke?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer token-0123456789abcdef", "content-type": "application/json" },
    body: JSON.stringify({ command: "public_action", args: { action } }),
  });
}

test("loses only the first answer per named action, after the backend received it", async () => {
  const backend = await upstream();
  const proxy = await startLossyProxy({
    upstream: backend.url,
    dropFirst: ["environment.start"],
  });
  stops.push(() => proxy.stop());

  const lost = await invoke(proxy, "environment.start");
  expect(lost.status).toBe(504);
  expect(await lost.text()).toBe("upstream timeout");
  // The backend saw the submission, with the client's credential and path.
  expect(backend.received).toEqual([
    {
      action: "environment.start",
      authorization: "Bearer token-0123456789abcdef",
      path: "/__orkestrator/invoke",
    },
  ]);

  const lookup = await invoke(proxy, "run.get");
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toEqual({ result: { action: "run.get" } });
  const again = await invoke(proxy, "environment.start");
  expect(again.status).toBe(200);

  expect(proxy.submissions("environment.start")).toBe(2);
  expect(proxy.dropped("environment.start")).toBe(1);
  expect(proxy.submissions("run.get")).toBe(1);
  expect(proxy.dropped("run.get")).toBe(0);
});
