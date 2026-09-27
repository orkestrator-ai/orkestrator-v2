import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError, type BridgeConnection } from "./agent-provider-contract.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  httpProvider,
  type RequestRecord,
} from "./agent-provider-test-support.js";
import {
  ACTIVITY_BATCH_UNSUPPORTED_RECHECK_MS,
  HttpBridgeActivityBatchReader,
} from "./http-bridge-activity-batch.js";

function batchAnswer(observations: Record<string, unknown>): Response {
  return Response.json({ version: 1, observations });
}

function reader(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  connection: BridgeConnection = claudeConnection,
) {
  let clock = 1_000;
  const requests: RequestRecord[] = [];
  const instance = new HttpBridgeActivityBatchReader(
    connection,
    (async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return handler(String(input), init);
    }) as typeof fetch,
    () => clock,
  );
  return {
    reader: instance,
    requests,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("HTTP bridge activity batch", () => {
  test("posts a versioned request with the bridge's credentials to the batch route", async () => {
    const { provider, requests } = httpProvider(
      () => batchAnswer({ "s-1": { activity: "idle" }, "s/2": { activity: "missing" } }),
      codexConnection,
    );

    await provider.observeActivityBatch!(["s-1", "s/2"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://codex.test/sessions/activity");
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      version: 1,
      sessionIds: ["s-1", "s/2"],
    });
    expect(new Headers(requests[0]!.init.headers).get("X-Orkestrator-Codex-Token")).toBe(
      "codex-token",
    );
  });

  test("returns the same observation shape as the single route", async () => {
    const answers = {
      a: { activity: "working", readyForInput: true },
      b: { activity: "waiting", asyncQuestionItemIds: ["q-1", "q-1", "q-2"] },
      c: { activity: "idle", closing: true },
      d: { activity: "missing" },
      e: { activity: "unavailable" },
      f: { activity: "deferred" },
    };
    const batch = httpProvider(() => batchAnswer(answers), cursorConnection).provider;
    const entries = await batch.observeActivityBatch!(Object.keys(answers));
    expect(entries).not.toBe("unsupported");
    const map = entries as ReadonlyMap<string, unknown>;

    for (const id of ["a", "b", "c", "d"] as const) {
      const single = httpProvider(() => Response.json(answers[id]), cursorConnection).provider;
      // Metadata parity: the reconciler cannot tell which route answered.
      expect(map.get(id)).toEqual(await single.observeActivity!(id));
    }
    expect(map.get("b")).toEqual({ state: "waiting", asyncQuestionItemIds: ["q-1", "q-2"] });
    expect(map.get("e")).toBe("unavailable");
    expect(map.get("f")).toBe("deferred");
  });

  test("remembers an old bridge's 404/405 for this connection until the recheck expires", async () => {
    for (const status of [404, 405]) {
      let supported = false;
      const {
        reader: batch,
        requests,
        advance,
      } = reader(() =>
        supported
          ? batchAnswer({ a: { activity: "idle" } })
          : new Response("Not Found", { status }),
      );

      expect(await batch.read(["a"])).toBe("unsupported");
      expect(await batch.read(["a"])).toBe("unsupported");
      expect(requests).toHaveLength(1);

      // An in-place upgrade behind the same coordinates is found again.
      supported = true;
      advance(ACTIVITY_BATCH_UNSUPPORTED_RECHECK_MS - 1);
      expect(await batch.read(["a"])).toBe("unsupported");
      advance(1);
      expect(await batch.read(["a"])).toEqual(new Map([["a", { state: "idle" }]]));
      expect(requests).toHaveLength(2);
    }
  });

  test("a new connection generation re-detects the route", async () => {
    // A restarted bridge gets new coordinates and therefore a new provider;
    // the old one's negative answer must not follow it.
    const old = httpProvider(() => new Response("Not Found", { status: 404 }), claudeConnection);
    expect(await old.provider.observeActivityBatch!(["a"])).toBe("unsupported");

    const restarted = httpProvider(() => batchAnswer({ a: { activity: "working" } }), {
      ...claudeConnection,
      authToken: "rotated-token",
    });
    expect(await restarted.provider.observeActivityBatch!(["a"])).toEqual(
      new Map([["a", { state: "working" }]]),
    );
  });

  test("a timeout, 5xx or malformed answer rejects without concluding anything", async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response("busy", { status: 503 }),
      () => new Response("boom", { status: 500 }),
      () => batchAnswer({ a: { activity: "idle" } }), // omits `b`
      () => batchAnswer({ a: { activity: "idle" }, b: { activity: "later" } }),
      () => Response.json({ version: 2, observations: {} }),
      () => new Response("{", { status: 200 }),
      () => new Promise<Response>(() => undefined), // the 25 ms test timeout aborts
    ];
    for (const answer of answers) {
      let calls = 0;
      const { reader: batch } = reader((_url, init) => {
        calls += 1;
        if (calls === 1) {
          const pending = answer();
          if (pending instanceof Promise) {
            return new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            });
          }
          return pending;
        }
        return batchAnswer({ a: { activity: "idle" }, b: { activity: "idle" } });
      });
      await expect(batch.read(["a", "b"])).rejects.toBeInstanceOf(Error);
      // Not remembered as unsupported: the next sweep tries the batch again.
      expect(await batch.read(["a", "b"])).not.toBe("unsupported");
    }
  });

  test("malformed answers surface as provider unavailability", async () => {
    const { reader: batch } = reader(() => batchAnswer({}));
    await expect(batch.read(["a"])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test("refuses to send a request outside the protocol bounds", async () => {
    const { reader: batch, requests } = reader(() => batchAnswer({}));
    await expect(
      batch.read(Array.from({ length: 65 }, (_, index) => `s-${index}`)),
    ).rejects.toThrow("outside the protocol bounds");
    await expect(batch.read(["a", "a"])).rejects.toThrow("outside the protocol bounds");
    await expect(batch.read(["x".repeat(1_025)])).rejects.toThrow("outside the protocol bounds");
    expect(requests).toEqual([]);
  });
});
