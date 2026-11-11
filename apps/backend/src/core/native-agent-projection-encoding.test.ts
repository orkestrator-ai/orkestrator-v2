import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import {
  digestWithMessages,
  encodedArrayBytes,
  encodedBytesWithMessages,
  encodedValue,
  isSpliceableResult,
  markSpliceableResult,
  reuseUnchangedMessages,
  sameEncoding,
  spliceEncodedJsonBytes,
  splicePlaceholderForTests,
  tailDeletions,
  updateHashWithFingerprints,
  valueFingerprint,
} from "./native-agent-projection-encoding.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("projected value encodings", () => {
  test("array bytes are exact, including multibyte text", () => {
    const values = [{ id: "a", content: 'é中😀\n"' }, { id: "b", parts: [1, 2] }, null, "s"];
    expect(encodedArrayBytes(values)).toBe(bytesOf(values));
    expect(encodedArrayBytes([])).toBe(2);
  });

  test("an object is serialized once however often it is measured", () => {
    let serializations = 0;
    const value = {
      id: "m",
      toJSON() {
        serializations += 1;
        return { id: "m" };
      },
    };
    encodedValue(value);
    encodedValue(value);
    sameEncoding(value, { id: "m" });
    expect(serializations).toBe(1);
  });

  test("unchanged messages keep the held object, changed ones do not", () => {
    const held = [
      { id: "a", content: "1" },
      { id: "b", content: "2" },
    ];
    const next = [
      { id: "a", content: "1" },
      { id: "b", content: "changed" },
      { id: "c", content: "3" },
    ];
    const reused = reuseUnchangedMessages(held, next);
    expect(reused[0]).toBe(held[0]);
    expect(reused[1]).toBe(next[1]);
    expect(reused[2]).toBe(next[2]);
  });

  test("digests and byte counts change with the messages and with the other fields", () => {
    const base = { title: "t", messages: [{ id: "a" }] };
    expect(digestWithMessages("p", base)).toBe(digestWithMessages("p", { ...base }));
    expect(digestWithMessages("p", base)).not.toBe(
      digestWithMessages("p", { ...base, messages: [{ id: "b" }] }),
    );
    expect(digestWithMessages("p", base)).not.toBe(
      digestWithMessages("p", { ...base, title: "u" }),
    );
    // Framing is approximated to a few bytes; the message array is exact.
    expect(Math.abs(encodedBytesWithMessages(base) - bytesOf(base))).toBeLessThanOrEqual(2);
  });
});

/** Characters fed to SHA-256 while `run` executes. */
function hashedCharacters(run: () => void): number {
  const update = spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
  try {
    run();
    return update.mock.calls.reduce(
      (total, [data]) => total + (typeof data === "string" ? data.length : 0),
      0,
    );
  } finally {
    update.mockRestore();
  }
}

describe("row fingerprints", () => {
  test("a row's fingerprint is hashed once and keeps its value", () => {
    const row = { id: "a", content: "x".repeat(10_000) };
    const expected = createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 24);
    expect(hashedCharacters(() => expect(valueFingerprint(row)).toBe(expected))).toBe(
      JSON.stringify(row).length,
    );
    expect(hashedCharacters(() => expect(valueFingerprint(row)).toBe(expected))).toBe(0);
    expect(valueFingerprint({ ...row })).toBe(expected);
    expect(valueFingerprint("s")).toBe(valueFingerprint("s"));
  });

  test("a token over fingerprints hashes a changed row once, not the window", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `m${index}`,
      content: "y".repeat(2_000),
    }));
    const digest = (values: readonly unknown[]) =>
      updateHashWithFingerprints(createHash("sha256"), values).digest("base64url");
    const before = digest(rows);
    const next = [...rows.slice(0, -1), { ...rows.at(-1)!, content: "moved" }];
    let after = "";
    const hashed = hashedCharacters(() => {
      after = digest(next);
    });
    expect(after).not.toBe(before);
    // The moved row's JSON, plus a short fixed string per row.
    expect(hashed).toBeLessThan(JSON.stringify(next.at(-1)).length + 30 * next.length);
    expect(digest(rows.map((row) => ({ ...row })))).toBe(before);
    expect(digest(rows.slice(1))).not.toBe(before);
    expect(digest([...rows.slice(1), rows[0]])).not.toBe(before);
  });

  test("a digest with messages hashes a changed row once, not the window", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `m${index}`,
      content: "z".repeat(2_000),
    }));
    const projection = { title: "t", messages: rows };
    const before = digestWithMessages("legacy-commit", projection);
    const moved = { ...projection, messages: [...rows.slice(0, -1), { id: "m49", content: "z" }] };
    let after = "";
    const hashed = hashedCharacters(() => {
      after = digestWithMessages("legacy-commit", moved);
    });
    expect(after).not.toBe(before);
    // The moved row's JSON and the other fields, plus a short string per row.
    expect(hashed).toBeLessThan(JSON.stringify(moved.messages.at(-1)).length + 30 * 51 + 64);
    expect(digestWithMessages("legacy-commit", { ...projection, messages: [...rows] })).toBe(
      before,
    );
    expect(
      digestWithMessages("legacy-commit", { ...projection, messages: rows.slice(1) }),
    ).not.toBe(before);
  });
});

describe("encoded measures", () => {
  test("revised rows are measured through the memo and never undercounted", () => {
    let serializations = 0;
    const revised = {
      id: "r",
      toJSON() {
        serializations += 1;
        return { id: "r", content: "é".repeat(100) };
      },
    };
    const views = [
      { messages: [{ id: "a" }], revisedMessages: [revised], title: "t" },
      { messages: [], revisedMessages: [revised] },
      { messages: [{ id: "a" }], revisedMessages: [] },
      { messages: [{ id: "a" }] },
    ];
    for (const view of views) {
      const bytes = encodedBytesWithMessages(view);
      expect(bytes).toBeGreaterThanOrEqual(bytesOf(view));
      expect(bytes - bytesOf(view)).toBeLessThanOrEqual(2);
    }
    // The first measure encoded the revised row into the memo; later ones
    // reuse it rather than serializing `revisedMessages` again.
    serializations = 0;
    encodedBytesWithMessages(views[0]!);
    encodedBytesWithMessages(views[1]!);
    expect(serializations).toBe(0);
  });
});

describe("spliced responses", () => {
  test("match JSON.stringify for every shape a result can hold", () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    const row = { id: "m", content: 'é "q" \n', parts: [{ type: "text", omitted: undefined }] };
    encodedValue(row);
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: [row] } } } } } } } } } };
    const values: unknown[] = [
      { status: "snapshot", token: "t", value: { messages: [row, { id: "x" }], skip: undefined } },
      [row, undefined, () => 1, Symbol("s"), null, 1.5, "s", true],
      { date: new Date(0), point: new Point(1, 2), nested: [[row]], fn: () => 1 },
      deep,
      // oxlint-disable-next-line no-sparse-arrays -- a hole serializes as null
      [1, , 3],
      { __proto__: null, plain: "null prototype" },
      { toJSON: () => ({ replaced: true }) },
      "text",
      7,
      null,
    ];
    for (const value of values) {
      expect(spliceEncodedJsonBytes(value)?.toString("utf8")).toBe(JSON.stringify(value));
    }
    expect(spliceEncodedJsonBytes(undefined)).toBeUndefined();
    expect(spliceEncodedJsonBytes(() => 1)).toBeUndefined();
  });

  test("size the body exactly when rows and other fields hold multi-byte text", () => {
    const rows = [
      { id: "a", content: "é ü — 漢字 🙂", parts: [{ type: "text", content: "\ud83d lone" }] },
      { id: "b", content: "plain" },
      { id: "c", content: "\u2028 line separator, \u0000 nul, \\ backslash" },
    ];
    for (const row of rows) encodedValue(row);
    const result = {
      status: "snapshot",
      token: "tök 🙂",
      value: {
        title: "Ünïcode 漢字",
        // oxlint-disable-next-line no-sparse-arrays -- a hole between rows serializes as null
        messages: [rows[0], , rows[1], { id: "fresh", content: "não memoizado" }, rows[2]],
        revisedMessages: [rows[2]],
      },
    };
    const body = spliceEncodedJsonBytes({ result });
    const expected = Buffer.from(JSON.stringify({ result }));
    expect(body?.byteLength).toBe(expected.byteLength);
    expect(body?.equals(expected)).toBe(true);
  });

  test("leave the result and its arrays untouched", () => {
    const row = { id: "m", content: "x" };
    encodedValue(row);
    const messages = [row, { id: "n" }];
    const value = { messages, nested: { messages } };
    spliceEncodedJsonBytes(value);
    expect(value.messages).toBe(messages);
    expect(value.nested.messages).toBe(messages);
    expect(messages).toEqual([row, { id: "n" }]);
  });

  test("serialize whole when a field already holds the placeholder text", () => {
    const row = { id: "m", content: "original" };
    encodedValue(row);
    row.content = "changed";
    const forged = `${splicePlaceholderForTests()}0`;
    // A field that spells a placeholder can never be mistaken for a row: the
    // body falls back to serializing the value as it is now.
    for (const value of [
      { before: forged, messages: [row] },
      { messages: [row], after: forged },
      { [forged]: 1, messages: [row] },
    ]) {
      expect(spliceEncodedJsonBytes(value)?.toString("utf8")).toBe(JSON.stringify(value));
    }
  });

  test("copy an encoded row from its memo, and leave the result a plain object", () => {
    const row = { id: "m", content: "original" };
    encodedValue(row);
    // Never done in production: shows the row is not serialized again.
    row.content = "changed";
    expect(spliceEncodedJsonBytes({ messages: [row] })?.toString("utf8")).toBe(
      '{"messages":[{"id":"m","content":"original"}]}',
    );
    const result = { status: "delta", delta: { messageUpserts: [row] } };
    expect(markSpliceableResult(result)).toBe(result);
    expect(isSpliceableResult(result)).toBe(true);
    expect(isSpliceableResult({ ...result })).toBe(false);
    expect(Object.keys(result)).toEqual(["status", "delta"]);
  });
});

describe("changed transcript reads", () => {
  const originalStringify = JSON.stringify;
  afterEach(() => {
    JSON.stringify = originalStringify;
  });

  test("serialize each message of the window about once, not once per consumer", async () => {
    const createdAt = "2026-09-27T00:00:00.000Z";
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: `m${index}`,
      role: "assistant" as const,
      content: `message ${index} ${"x".repeat(200)}`,
      parts: [] as unknown[],
      createdAt,
    }));
    let revision = 1;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => {
        const update = bridgeTranscriptUpdate(history, {
          sessionIdentity: "s",
          generation: 1,
          contentEpoch: 1,
          revision,
          limit: 100,
          targetBytes: 512 * 1024,
          complete: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        return {
          messages: update.value.messages,
          historyStartIndex: update.value.startIndex,
          sourceToken: update.token,
          complete: true,
          historyEpoch: "1:1",
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-encoding-count-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:encoding",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (first.status !== "snapshot") throw new Error("expected a snapshot");

        // Only the tail changes.
        history[99] = { ...history[99]!, content: "streaming more" };
        revision += 1;
        let messageSerializations = 0;
        // The fake bridge windows its own source rows; only the backend's
        // projected rows are counted.
        const sourceRows = new Set<unknown>(history);
        JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
          if (
            value &&
            !sourceRows.has(value) &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof (value as { id?: unknown }).id === "string" &&
            (value as { role?: unknown }).role === "assistant"
          ) {
            messageSerializations += 1;
          }
          return (originalStringify as (...args: unknown[]) => string)(value, ...rest);
        }) as typeof JSON.stringify;
        const second = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        JSON.stringify = originalStringify;
        expect(second.status).toBe("delta");
        if (second.status !== "delta") return;
        expect(second.delta.messageUpserts).toHaveLength(1);
        // One pass to compare each freshly projected row with the held one;
        // the token, cache bytes, delta and delta-vs-snapshot choice reuse it.
        // (Previously: token + bytes + two per comparison + two sizings.)
        expect(messageSerializations).toBeLessThanOrEqual(history.length + 2);
      },
    );
  });
});

describe("tail deletions", () => {
  test("a row that aged out of the window's front is not a deletion", () => {
    expect(tailDeletions(["m1", "m2", "m3"], ["m2", "m3", "m4"], true)).toEqual([]);
  });

  test("a row removed behind the oldest shared row is a deletion", () => {
    expect(tailDeletions(["m1", "m2", "m3", "m4"], ["m1", "m2"], false)).toEqual(["m3", "m4"]);
    expect(tailDeletions(["m1", "m2", "m3"], ["m2", "m4"], true)).toEqual(["m3"]);
  });

  test("a window that jumped past every held row deletes nothing while older rows exist", () => {
    expect(tailDeletions(["m142"], ["m143", "m144"], true)).toEqual([]);
    expect(tailDeletions(["m1", "m2"], ["m3"], false)).toEqual(["m1", "m2"]);
  });
});
