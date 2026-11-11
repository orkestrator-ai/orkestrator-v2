import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import { BackendHttpClient } from "../electron/backend-process";
import { readLocalWindowGatewayTransport } from "../electron/local-window-transport";

const originalFetch = globalThis.fetch;
const directories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir(config?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-window-transport-"));
  directories.push(dir);
  if (config !== undefined) await writeFile(path.join(dir, "config.json"), config);
  return dir;
}

describe("the localWindowGatewayTransport setting", () => {
  test("is on unless the config turns it off", async () => {
    expect(readLocalWindowGatewayTransport(await dataDir())).toBe(true);
    expect(readLocalWindowGatewayTransport(await dataDir("{not json"))).toBe(true);
    expect(readLocalWindowGatewayTransport(await dataDir("null"))).toBe(true);
    expect(readLocalWindowGatewayTransport(await dataDir(JSON.stringify({ global: {} })))).toBe(
      true,
    );
    expect(
      readLocalWindowGatewayTransport(
        await dataDir(JSON.stringify({ global: { localWindowGatewayTransport: true } })),
      ),
    ).toBe(true);
  });

  test("keeps an explicit false, as a release before the flip stored it, off", async () => {
    expect(
      readLocalWindowGatewayTransport(
        await dataDir(JSON.stringify({ global: { localWindowGatewayTransport: false } })),
      ),
    ).toBe(false);
  });
});

describe("direct transport authorization", () => {
  const client = () => new BackendHttpClient("http://127.0.0.1:50123/", "local-token");

  test("covers the command and event routes of this backend only", () => {
    expect(
      client().directTransportAuthorization("http://127.0.0.1:50123/__orkestrator/invoke"),
    ).toBe("Bearer local-token");
    expect(
      client().directTransportAuthorization(
        "http://127.0.0.1:50123/__orkestrator/events?excludeEvents=terminal-output-",
      ),
    ).toBe("Bearer local-token");
    for (const url of [
      "http://127.0.0.1:50123/__orkestrator/gateway-settings",
      "http://127.0.0.1:50123/__orkestrator/browser/loopback/3000/",
      "http://127.0.0.1:50123/",
      "http://127.0.0.1:50124/__orkestrator/invoke",
      "http://localhost:50123/__orkestrator/invoke",
      "not a url",
    ]) {
      expect(client().directTransportAuthorization(url)).toBeNull();
    }
  });

  test("follows a rotated token", async () => {
    const backend = client();
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ token: "rotated-token" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await backend.setToken("rotated-token");
    expect(
      backend.directTransportAuthorization("http://127.0.0.1:50123/__orkestrator/invoke"),
    ).toBe("Bearer rotated-token");
  });
});

/** The stream main keeps for itself once no window takes terminal output from it. */
const filteredDesktopAdapter: EventStreamContractAdapter = {
  start(server, observe, onEvent) {
    let attempt = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL) => {
        attempt += 1;
        const url = new URL(String(input));
        expect(url.searchParams.get("excludeEvents")).toBe("terminal-output-");
        const connection = server(attempt, url.searchParams.get("since"));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of connection.chunks) controller.enqueue(encoder.encode(chunk));
              if (connection.close) controller.close();
            },
          }),
          { status: 200 },
        );
      }),
      { preconnect: originalFetch.preconnect },
    );
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      eventReconnectDelayMs: 5,
      relayTerminalOutput: false,
    });
    const observed = new Set(observe);
    client.listen((event, payload) => {
      if (observed.has(event)) onEvent(event, payload);
    });
    return { stop: () => client.stopListening() };
  },
};

describe("Electron event stream contract without terminal output", () => {
  for (const scenario of gatewayEventStreamContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(filteredDesktopAdapter);
      expect(actual).toEqual(expected);
    });
  }
});

describe("changing whether the stream carries terminal output", () => {
  function scriptedStreams() {
    const urls: string[] = [];
    const encoder = new TextEncoder();
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `id: backend1:7\ndata: ${JSON.stringify({ event: "resource-changed", payload: {} })}\n\n`,
                ),
              );
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
          { status: 200 },
        );
      }),
      { preconnect: originalFetch.preconnect },
    );
    return urls;
  }
  const settle = async (urls: string[], count: number) => {
    for (let turn = 0; turn < 200 && urls.length < count; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  test("the relay's default stream is unchanged", async () => {
    const urls = scriptedStreams();
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token");
    client.listen(() => undefined);
    await settle(urls, 1);
    expect(urls[0]).toBe("http://127.0.0.1:34121/__orkestrator/events?relayedEvents=per-node");
    client.setTerminalOutputRelay(true);
    await settle(urls, 2);
    expect(urls).toHaveLength(1);
    client.stopListening();
  });

  test("restarts from its cursor, and tells a relay window to re-read terminals", async () => {
    const urls = scriptedStreams();
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      relayTerminalOutput: false,
    });
    const events: string[] = [];
    client.listen((event) => events.push(event));
    await settle(urls, 1);
    expect(new URL(urls[0]!).searchParams.get("excludeEvents")).toBe("terminal-output-");
    const opensBefore = events.filter(
      (event) => event === "terminal-event-stream-connected",
    ).length;

    client.setTerminalOutputRelay(true);
    await settle(urls, 2);
    const reopened = new URL(urls[1]!);
    expect(reopened.searchParams.has("excludeEvents")).toBe(false);
    expect(reopened.searchParams.get("since")).toBe("backend1:7");
    // Relayed events stay off this stream, whatever it carries.
    expect(reopened.searchParams.get("relayedEvents")).toBe("per-node");
    expect(events.filter((event) => event === "terminal-event-stream-connected").length).toBe(
      opensBefore + 1,
    );

    client.setTerminalOutputRelay(false);
    await settle(urls, 3);
    expect(new URL(urls[2]!).searchParams.get("excludeEvents")).toBe("terminal-output-");
    client.stopListening();
  });
});
