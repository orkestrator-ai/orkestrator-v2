import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  answerSessionActivityBatch,
  buildSessionActivityBatchResponse,
  isBatchableSessionId,
  parseSessionActivityBatchRequest,
  parseSessionActivityBatchResponse,
  parseSessionActivityObservation,
  readBoundedBody,
  SESSION_ACTIVITY_BATCH_LIMITS,
} from "./session-activity-batch";

function webBody(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe("session activity batch request", () => {
  test("accepts a bounded, unique id list", () => {
    expect(parseSessionActivityBatchRequest({ version: 1, sessionIds: ["a", "b"] })).toEqual({
      ok: true,
      sessionIds: ["a", "b"],
    });
    expect(parseSessionActivityBatchRequest({ version: 1, sessionIds: [] })).toEqual({
      ok: true,
      sessionIds: [],
    });
  });

  test("refuses anything outside the contract", () => {
    const tooMany = Array.from({ length: SESSION_ACTIVITY_BATCH_LIMITS.maxSessions + 1 }, (_, i) =>
      String(i),
    );
    for (const body of [
      null,
      [],
      { sessionIds: ["a"] },
      { version: 2, sessionIds: ["a"] },
      { version: 1, sessionIds: "a" },
      { version: 1, sessionIds: [""] },
      { version: 1, sessionIds: [1] },
      { version: 1, sessionIds: ["a", "a"] },
      { version: 1, sessionIds: ["x".repeat(SESSION_ACTIVITY_BATCH_LIMITS.maxSessionIdBytes + 1)] },
      { version: 1, sessionIds: tooMany },
    ]) {
      expect(parseSessionActivityBatchRequest(body).ok).toBe(false);
    }
  });

  test("bounds ids by UTF-8 bytes, not characters", () => {
    const multiByte = "é".repeat(SESSION_ACTIVITY_BATCH_LIMITS.maxSessionIdBytes / 2);
    expect(isBatchableSessionId(multiByte)).toBe(true);
    expect(isBatchableSessionId(`${multiByte}é`)).toBe(false);
  });
});

describe("session activity observation", () => {
  test("keeps every field the single route answers", () => {
    expect(
      parseSessionActivityObservation({
        activity: "waiting",
        readyForInput: true,
        asyncQuestionItemIds: ["q-1"],
        closing: false,
      }),
    ).toEqual({
      activity: "waiting",
      readyForInput: true,
      asyncQuestionItemIds: ["q-1"],
      closing: false,
    });
  });

  test("drops unknown fields but refuses malformed known ones", () => {
    expect(parseSessionActivityObservation({ activity: "idle", future: 1 })).toEqual({
      activity: "idle",
    });
    for (const value of [
      { activity: "blocked" },
      { activity: "unavailable" },
      { activity: "idle", readyForInput: "yes" },
      { activity: "idle", closing: 1 },
      { activity: "idle", asyncQuestionItemIds: [""] },
      { activity: "idle", asyncQuestionItemIds: "q" },
      {
        activity: "idle",
        asyncQuestionItemIds: Array.from(
          { length: SESSION_ACTIVITY_BATCH_LIMITS.maxAsyncQuestionItemIds + 1 },
          (_, i) => `q-${i}`,
        ),
      },
    ]) {
      expect(parseSessionActivityObservation(value)).toBeUndefined();
    }
  });
});

describe("session activity batch response", () => {
  test("answers every id, isolating a failed or malformed read to that id", async () => {
    const response = await buildSessionActivityBatchResponse(
      ["ok", "throws", "malformed", "gone", "__proto__"],
      async (id) => {
        if (id === "throws") throw new Error("probe failed");
        if (id === "malformed") return { activity: "blocked" };
        if (id === "gone") return { activity: "missing" };
        return { activity: "working", readyForInput: true };
      },
    );
    expect(response.version).toBe(1);
    expect(Object.keys(response.observations)).toEqual([
      "ok",
      "throws",
      "malformed",
      "gone",
      "__proto__",
    ]);
    expect(response.observations.ok).toEqual({ activity: "working", readyForInput: true });
    expect(response.observations.throws).toEqual({ activity: "unavailable" });
    expect(response.observations.malformed).toEqual({ activity: "unavailable" });
    expect(response.observations.gone).toEqual({ activity: "missing" });
    // Data, not a prototype rewrite, and it survives the wire.
    const wire = JSON.parse(JSON.stringify(response));
    const parsed = parseSessionActivityBatchResponse(wire, [
      "ok",
      "throws",
      "malformed",
      "gone",
      "__proto__",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entries.get("__proto__")).toEqual({ activity: "working", readyForInput: true });
    }
  });

  test("defers the largest observations when the answer exceeds its budget", async () => {
    const itemIds = Array.from({ length: 64 }, (_, i) => `item-${i}-${"x".repeat(200)}`);
    const response = await buildSessionActivityBatchResponse(
      ["small", "large"],
      (id) =>
        id === "large"
          ? { activity: "waiting", asyncQuestionItemIds: itemIds }
          : { activity: "idle" },
      { maxResponseBytes: 1_024 },
    );
    expect(response.observations).toEqual({
      small: { activity: "idle" },
      large: { activity: "deferred" },
    });
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(1_024);
  });

  test("bounds read fan-out", async () => {
    let active = 0;
    let peak = 0;
    await buildSessionActivityBatchResponse(
      Array.from({ length: 20 }, (_, i) => `s-${i}`),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { activity: "idle" };
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  test("refuses a response that omits, adds or mangles an id", () => {
    const good = {
      version: 1,
      observations: { a: { activity: "idle" }, b: { activity: "unavailable" } },
    };
    expect(parseSessionActivityBatchResponse(good, ["a", "b"]).ok).toBe(true);
    for (const value of [
      { version: 1, observations: { a: { activity: "idle" } } },
      {
        version: 1,
        observations: { a: { activity: "idle" }, b: { activity: "idle" }, c: { activity: "idle" } },
      },
      { version: 1, observations: { a: { activity: "idle" }, c: { activity: "idle" } } },
      { version: 1, observations: { a: { activity: "idle" }, b: { activity: "later" } } },
      { version: 2, observations: good.observations },
      { version: 1, observations: [] },
      null,
    ]) {
      expect(parseSessionActivityBatchResponse(value, ["a", "b"]).ok).toBe(false);
    }
  });
});

describe("bounded request body", () => {
  test("reads web streams and node streams alike", async () => {
    expect(await readBoundedBody(webBody("{}"))).toEqual({ ok: true, text: "{}" });
    expect(await readBoundedBody(Readable.from([Buffer.from("{"), "}"]))).toEqual({
      ok: true,
      text: "{}",
    });
    expect(await readBoundedBody(null)).toEqual({ ok: true, text: "" });
  });

  test("stops at the byte bound", async () => {
    expect(await readBoundedBody(webBody("x".repeat(11)), 10)).toEqual({ ok: false });
    expect(await readBoundedBody(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10)).toEqual({
      ok: false,
    });
  });
});

describe("answerSessionActivityBatch", () => {
  const read = (id: string) => ({ activity: id === "gone" ? "missing" : "idle" });

  test("answers a valid request", async () => {
    const answer = await answerSessionActivityBatch(
      webBody(JSON.stringify({ version: 1, sessionIds: ["a", "gone"] })),
      read,
    );
    expect(answer).toEqual({
      status: 200,
      body: {
        version: 1,
        observations: { a: { activity: "idle" }, gone: { activity: "missing" } },
      },
    });
  });

  test("refuses oversized, malformed and invalid requests without reading sessions", async () => {
    let reads = 0;
    const counting = (id: string) => {
      reads += 1;
      return read(id);
    };
    expect(
      (await answerSessionActivityBatch(webBody("{}"), counting, { contentLength: "999999" }))
        .status,
    ).toBe(413);
    expect(
      (
        await answerSessionActivityBatch(
          webBody("x".repeat(SESSION_ACTIVITY_BATCH_LIMITS.maxRequestBytes + 1)),
          counting,
        )
      ).status,
    ).toBe(413);
    expect((await answerSessionActivityBatch(webBody("{"), counting)).status).toBe(400);
    expect(
      (await answerSessionActivityBatch(webBody(JSON.stringify({ version: 1 })), counting)).status,
    ).toBe(400);
    expect(reads).toBe(0);
  });
});
