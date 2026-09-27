import { afterEach, describe, expect, test } from "bun:test";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import {
  digestWithMessages,
  encodedArrayBytes,
  encodedBytesWithMessages,
  encodedValue,
  reuseUnchangedMessages,
  sameEncoding,
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
