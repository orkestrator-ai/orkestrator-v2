import { afterEach, describe, expect, test } from "bun:test";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  retriesAreSpread,
  retryRungs,
  startOutageLink,
  type OutageLink,
} from "./client-outage-support";

// The test preload replaces the global with happy-dom's, which applies a page's
// same-origin policy to these loopback requests.
const fetch = Bun.fetch;
const SECOND_RUNG_WINDOW = () => 1_000;

describe("retry rungs", () => {
  test("compares each owner's nth attempt, only for rungs every owner reached", () => {
    const rungs = retryRungs(
      new Map([
        ["a", [1_000, 3_000, 7_000]],
        ["b", [1_500, 3_900]],
      ]),
    );
    expect(rungs.map((rung) => rung.spanMs)).toEqual([500, 900]);
    expect(rungs.map((rung) => rung.coincidentPairs)).toEqual([0, 0]);
  });

  test("one owner has nothing to be spread against", () => {
    expect(retryRungs(new Map([["a", [1_000]]]))).toEqual([]);
  });

  test("lock-step retries fail the rule however long the outage runs", () => {
    // The browser's own fixed retry, measured across three tabs.
    const lockStep = retryRungs(
      new Map([
        ["a", [3_006, 6_010, 9_012]],
        ["b", [3_007, 6_011, 9_014]],
        ["c", [3_009, 6_012, 9_015]],
      ]),
    );
    expect(lockStep.every((rung) => rung.coincidentPairs === rung.pairs)).toBe(true);
    expect(retriesAreSpread(lockStep, SECOND_RUNG_WINDOW)).toBe(false);
  });

  test("jittered retries pass, and a rare coincidence does not fail them", () => {
    const jittered = retryRungs(
      new Map([
        ["a", [1_239, 4_408, 11_339]],
        ["b", [1_630, 4_800, 10_074]],
        ["c", [1_395, 5_067, 10_964]],
        ["d", [2_003, 4_391, 10_711]],
      ]),
    );
    expect(jittered.some((rung) => rung.coincidentPairs > 0)).toBe(true);
    expect(retriesAreSpread(jittered, SECOND_RUNG_WINDOW)).toBe(true);
  });

  test("every rung narrower than half its window fails", () => {
    const narrow = retryRungs(
      new Map([
        ["a", [1_000, 3_000]],
        ["b", [1_100, 3_100]],
      ]),
    );
    expect(retriesAreSpread(narrow, SECOND_RUNG_WINDOW)).toBe(false);
  });

  test("a last rung that lands close together by chance does not fail a spread client", () => {
    // Three tabs from a real run: rung windows 1, 2, 4, 8 and 8 s.
    const eventWindow = (rung: number) => Math.min(16_000, 2_000 * 2 ** rung) / 2;
    const chance = retryRungs(
      new Map([
        ["a", [1_641, 5_570, 12_262, 24_545, 33_150]],
        ["b", [1_325, 4_027, 9_890, 19_795, 36_768]],
        ["c", [1_500, 4_500, 11_000, 22_000, 35_000]],
      ]),
    );
    expect(chance.at(-1)!.spanMs).toBeLessThan(eventWindow(4) / 2);
    expect(retriesAreSpread(chance, eventWindow)).toBe(true);
  });
});

describe("outage link", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function serve(handler: http.RequestListener): Promise<{ server: Server; url: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function link(gatewayUrl: string): Promise<OutageLink> {
    const created = await startOutageLink({ owner: "test", gatewayUrl, rendererUrl: gatewayUrl });
    closers.push(() => created.close());
    return created;
  }

  const invokeBody = JSON.stringify({ command: "get_projects", args: { secret: "never-kept" } });

  test("records kinds, statuses and command names, and nothing from a body", async () => {
    const gateway = await serve((_request, response) => response.end("{}"));
    const outage = await link(gateway.url);
    const answer = await fetch(`${outage.url}/__orkestrator/invoke`, {
      method: "POST",
      body: invokeBody,
    });
    expect(answer.status).toBe(200);
    expect(outage.requests).toHaveLength(1);
    expect(outage.requests[0]).toMatchObject({
      kind: "invoke",
      command: "get_projects",
      status: 200,
    });
    expect(JSON.stringify(outage.requests)).not.toContain("never-kept");
  });

  test("reset refuses new requests and ends an open stream", async () => {
    const gateway = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
    });
    const outage = await link(gateway.url);
    const stream = await fetch(`${outage.url}/__orkestrator/events?excludeEvents=x`);
    const reader = stream.body!.getReader();
    await reader.read();

    outage.setMode("reset");
    await expect(reader.read()).rejects.toThrow();
    await expect(fetch(`${outage.url}/__orkestrator/events`)).rejects.toThrow();
    expect(outage.requests.at(-1)).toMatchObject({ kind: "main-stream", dropped: true });
  });

  test("blackhole answers nothing and errors nothing, until the link returns", async () => {
    let writes = 0;
    let stream: http.ServerResponse | undefined;
    const gateway = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      stream = response;
    });
    const outage = await link(gateway.url);
    const open = await fetch(`${outage.url}/__orkestrator/events`);
    const reader = open.body!.getReader();
    await reader.read();

    outage.setMode("blackhole");
    stream!.write("data: unseen\n\n");
    writes += 1;
    const silence = await Promise.race([
      reader.read().then(() => "delivered"),
      new Promise((resolve) => setTimeout(() => resolve("silent"), 100)),
    ]);
    expect(silence).toBe("silent");
    expect(writes).toBe(1);

    const held = fetch(`${outage.url}/__orkestrator/events`).then(
      () => "answered",
      () => "refused",
    );
    const heldState = await Promise.race([
      held,
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    expect(heldState).toBe("waiting");

    // The peer's TCP would have given up on what it held by the time it returned.
    outage.setMode("up");
    expect(await held).toBe("refused");
    await expect(
      fetch(`${outage.url}/__orkestrator/invoke`, { method: "POST", body: "{}" }),
    ).resolves.toBeTruthy();
  });

  test("a terminal stall stops only terminal streams, and releases them", async () => {
    const streams = new Map<string, http.ServerResponse>();
    const gateway = await serve((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      streams.set(
        new URL(request.url!, "http://x").searchParams.has("includeEvents") ? "terminal" : "main",
        response,
      );
    });
    const outage = await link(gateway.url);
    const main = (await fetch(`${outage.url}/__orkestrator/events`)).body!.getReader();
    const terminal = (
      await fetch(`${outage.url}/__orkestrator/events?includeEvents=terminal-output-a`)
    ).body!.getReader();
    await main.read();
    await terminal.read();

    outage.setTerminalStall(true);
    streams.get("terminal")!.write("data: held\n\n");
    streams.get("main")!.write("data: passes\n\n");
    expect(new TextDecoder().decode((await main.read()).value)).toContain("passes");
    const pending = terminal.read();
    const state = await Promise.race([
      pending.then(() => "delivered"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 100)),
    ]);
    expect(state).toBe("stalled");

    outage.setTerminalStall(false);
    expect(new TextDecoder().decode((await pending).value)).toContain("held");
  });
});
