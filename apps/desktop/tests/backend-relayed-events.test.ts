import { afterEach, describe, expect, mock, test } from "bun:test";
import { BackendHttpClient, type BackendListenOptions } from "../electron/backend-process";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const LEAF_EVENT = "relayed-node-event:bk_leaf";
const OTHER_EVENT = "relayed-node-event:bk_other";

type Opened = {
  url: URL;
  authorization: string | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
  aborted: () => boolean;
};

/** A gateway's event route as `fetch` sees it; each request stays open until told. */
function scriptedGateway(respond: (url: URL) => Response | null = () => null) {
  const opened: Opened[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const canned = respond(url);
      if (canned) return canned;
      let aborted = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          opened.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
            controller,
            aborted: () => aborted,
          });
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          });
        },
      });
      return new Response(body, { status: 200 });
    }),
    { preconnect: originalFetch.preconnect },
  );
  const relayed = () => opened.filter((stream) => stream.url.searchParams.has("includeEvents"));
  const main = () => opened.filter((stream) => !stream.url.searchParams.has("includeEvents"));
  return {
    relayed,
    main,
    frame(stream: Opened, id: string, event: string, payload: unknown) {
      stream.controller.enqueue(
        encoder.encode(`id: ${id}\ndata: ${JSON.stringify({ event, payload })}\n\n`),
      );
    },
  };
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 400 && !predicate(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!predicate()) throw new Error(message);
}

function startClient(options: BackendListenOptions = {}, reconnectDelayMs = 1) {
  const delivered: Array<[string, unknown]> = [];
  const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
    eventReconnectDelayMs: reconnectDelayMs,
  });
  client.listen((event, payload) => void delivered.push([event, payload]), options);
  return { client, delivered };
}

const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("the desktop client's relayed stream", () => {
  test("opens for the first event, with the current credential and its own filter", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient();
    await until(() => gateway.main().length === 1, "No main stream");
    expect(gateway.relayed()).toEqual([]);

    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    const stream = gateway.relayed()[0]!;
    expect(stream.url.pathname).toBe("/__orkestrator/events");
    expect(stream.url.searchParams.get("includeEvents")).toBe(LEAF_EVENT);
    // The gateway decides the relayed window from the filter, not this parameter.
    expect(stream.url.searchParams.has("relayedEvents")).toBe(false);
    expect(stream.authorization).toBe("Bearer fixture-token");
    client.stopListening();
  });

  test("a change reopens it from its own cursor and leaves the main stream alone", async () => {
    const gateway = scriptedGateway();
    const { client, delivered } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    gateway.frame(gateway.relayed()[0]!, "relayed:4", LEAF_EVENT, { id: "one" });
    await until(() => delivered.some(([event]) => event === LEAF_EVENT), "Frame not delivered");
    const mainStreams = gateway.main().length;

    client.setRelayedEvents([LEAF_EVENT, OTHER_EVENT]);
    await until(() => gateway.relayed().length === 2, "The filter did not widen");
    const widened = gateway.relayed()[1]!;
    expect(widened.url.searchParams.get("includeEvents")?.split(",").sort()).toEqual(
      [LEAF_EVENT, OTHER_EVENT].sort(),
    );
    expect(widened.url.searchParams.get("since")).toBe("relayed:4");
    expect(gateway.relayed()[0]!.aborted()).toBe(true);
    expect(gateway.main()).toHaveLength(mainStreams);
    expect(gateway.main()[0]!.aborted()).toBe(false);

    // A cursor frame from the main stream is not this stream's cursor.
    gateway.frame(gateway.main()[0]!, "main:99", "environment-renamed", {});
    await until(
      () => delivered.some(([event]) => event === "environment-renamed"),
      "No main frame",
    );
    client.setRelayedEvents([OTHER_EVENT]);
    await until(() => gateway.relayed().length === 3, "The filter did not narrow");
    expect(gateway.relayed()[2]!.url.searchParams.get("since")).toBe("relayed:4");
    client.stopListening();
  });

  test("the last event leaving closes it; the next one starts fresh", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    gateway.frame(gateway.relayed()[0]!, "relayed:4", LEAF_EVENT, {});

    client.setRelayedEvents([]);
    await until(() => gateway.relayed()[0]!.aborted(), "The stream stayed open");
    client.setRelayedEvents([OTHER_EVENT]);
    await client.relayedEventReady(OTHER_EVENT);
    expect(gateway.relayed()[1]!.url.searchParams.has("since")).toBe(false);
    client.stopListening();
  });

  test("a stream the gateway has gone silent on is given up and resumed", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient({ streamSilenceLimitMs: 40, streamConnectTimeoutMs: 40 });
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    gateway.frame(gateway.relayed()[0]!, "relayed:7", LEAF_EVENT, {});

    await until(() => gateway.relayed().length >= 2, "A silent stream was never replaced");
    expect(gateway.relayed()[1]!.url.searchParams.get("since")).toBe("relayed:7");
    client.stopListening();
  });

  test("a failed attempt retries, and only an open stream counts as ready", async () => {
    let refusals = 2;
    const gateway = scriptedGateway((url) => {
      if (!url.searchParams.has("includeEvents") || refusals === 0) return null;
      refusals -= 1;
      return new Response("", { status: 503 });
    });
    const { client } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    let ready = false;
    const settled = client.relayedEventReady(LEAF_EVENT).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    await settled;
    expect(refusals).toBe(0);
    expect(gateway.relayed()).toHaveLength(1);
    client.stopListening();
  });

  test("a route awaiting verification gets no request until it is retargeted", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    gateway.frame(gateway.relayed()[0]!, "relayed:4", LEAF_EVENT, {});
    await until(() => gateway.relayed().length === 1, "No stream");
    await quietPeriod();

    client.suspend();
    await until(() => gateway.relayed()[0]!.aborted(), "Suspending left the stream open");
    client.setRelayedEvents([LEAF_EVENT, OTHER_EVENT]);
    await quietPeriod();
    expect(gateway.relayed()).toHaveLength(1);

    client.retarget("http://127.0.0.1:34122/", "next-token", { preserveCursor: true });
    await until(() => gateway.relayed().length === 2, "Retargeting did not reopen it");
    const resumed = gateway.relayed()[1]!;
    expect(resumed.url.origin).toBe("http://127.0.0.1:34122");
    expect(resumed.authorization).toBe("Bearer next-token");
    expect(resumed.url.searchParams.get("since")).toBe("relayed:4");
    client.stopListening();
  });

  test("another backend process gets no cursor from the last one", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);
    gateway.frame(gateway.relayed()[0]!, "relayed:4", LEAF_EVENT, {});
    await quietPeriod();

    client.retarget("http://127.0.0.1:34122/", "fixture-token", { preserveCursor: false });
    await until(() => gateway.relayed().length === 2, "Retargeting did not reopen it");
    expect(gateway.relayed()[1]!.url.searchParams.has("since")).toBe(false);
    client.stopListening();
  });

  test("stopping the client closes it, settles the wait and reopens nothing", async () => {
    const gateway = scriptedGateway();
    const { client } = startClient();
    client.setRelayedEvents([LEAF_EVENT]);
    await client.relayedEventReady(LEAF_EVENT);

    client.setRelayedEvents([LEAF_EVENT, OTHER_EVENT]);
    const waiting = client.relayedEventReady(OTHER_EVENT);
    client.stopListening();
    await waiting;
    await quietPeriod();
    const count = gateway.relayed().length;
    expect(gateway.relayed().every((stream) => stream.aborted())).toBe(true);
    await quietPeriod();
    expect(gateway.relayed()).toHaveLength(count);
  });
});
