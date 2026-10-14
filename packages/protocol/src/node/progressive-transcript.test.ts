import { describe, expect, test } from "bun:test";
import {
  BRIDGE_TRANSCRIPT_MAX_MESSAGES,
  bridgeTranscriptUpdate,
} from "./progressive-transcript.js";

const message = (id: string, content = id) => ({ id, content, parts: [] });

describe("progressive bridge transcript", () => {
  test("bounds the newest tail and answers matching revisions conditionally", () => {
    const messages = Array.from({ length: BRIDGE_TRANSCRIPT_MAX_MESSAGES + 20 }, (_, index) =>
      message(String(index)),
    );
    const first = bridgeTranscriptUpdate(messages, {
      sessionIdentity: "session-1",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 7,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
    });
    expect(first.status).toBe("snapshot");
    if (first.status !== "snapshot") throw new Error("expected snapshot");
    expect(first.value.messages).toHaveLength(100);
    expect(first.value.messages[0]?.id).toBe("20");
    expect(first.value.startIndex).toBe(20);
    expect(first.value.messageWindow).toMatchObject({
      truncated: true,
      truncationReason: "count",
      omittedMessages: 20,
    });

    expect(
      bridgeTranscriptUpdate(messages, {
        sessionIdentity: "session-1",
        generation: "generation-1",
        contentEpoch: "epoch-1",
        revision: 7,
        limit: 100,
        targetBytes: 512 * 1024,
        knownToken: first.token,
        complete: true,
      }),
    ).toEqual({ version: 1, status: "unchanged", token: first.token });
  });

  test("a completeness transition invalidates the token", () => {
    const options = {
      sessionIdentity: "session-restored",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 0,
      limit: 100,
      targetBytes: 512 * 1024,
    } as const;
    const preview = bridgeTranscriptUpdate([], { ...options, complete: false });
    const hydrated = bridgeTranscriptUpdate([], {
      ...options,
      knownToken: preview.token,
      complete: true,
    });
    expect(hydrated.status).toBe("snapshot");
    if (hydrated.status !== "snapshot") throw new Error("expected snapshot");
    expect(hydrated.token).not.toBe(preview.token);
    expect(hydrated.value.complete).toBe(true);
  });

  test("generation, revision and window changes invalidate the token", () => {
    const options = {
      sessionIdentity: "session-1",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 7,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
    } as const;
    const first = bridgeTranscriptUpdate([message("1")], options);
    const changed = bridgeTranscriptUpdate([message("1", "changed")], {
      ...options,
      revision: 8,
      knownToken: first.token,
    });
    expect(changed.status).toBe("snapshot");
    expect(changed.token).not.toBe(first.token);
  });

  describe("envelope fields outside the message revision", () => {
    const options = {
      sessionIdentity: "session-1",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 7,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
      freshness: "current",
      title: "First title",
    } as const;

    // Each row changes exactly one envelope field and leaves the message
    // revision alone, which is what a bridge that passes a revision does on a
    // rename or a hydration transition. The reader must still get a snapshot.
    test.each([
      ["title", { title: "Renamed" }],
      ["a cleared title", { title: undefined }],
      ["freshness", { freshness: "cached" as const }],
      ["completeness", { complete: false }],
    ])("a %s-only change invalidates the token", (_name, change) => {
      const first = bridgeTranscriptUpdate([message("1")], options);
      const changed = bridgeTranscriptUpdate([message("1")], {
        ...options,
        ...change,
        knownToken: first.token,
      });
      expect(changed.status).toBe("snapshot");
      expect(changed.token).not.toBe(first.token);
      if (changed.status !== "snapshot") throw new Error("expected snapshot");
      expect(changed.value.title).toBe("title" in change ? change.title : options.title);

      // And the new token is itself stable once the reader holds it.
      expect(
        bridgeTranscriptUpdate([message("1")], {
          ...options,
          ...change,
          knownToken: changed.token,
        }).status,
      ).toBe("unchanged");
    });

    test("an omitted freshness is the same identity as an explicit current one", () => {
      const { freshness: _freshness, ...implicit } = options;
      expect(bridgeTranscriptUpdate([], implicit).token).toBe(
        bridgeTranscriptUpdate([], options).token,
      );
    });
  });

  describe("message serialization on an unchanged read", () => {
    // `toJSON` fires once per message per `JSON.stringify` visit, returning the
    // same fields, so the count is the number of message bodies walked.
    function countedHistory(count: number) {
      const visits = { count: 0 };
      const messages = Array.from({ length: count }, (_, index) => ({
        id: String(index),
        content: "x".repeat(1_024),
        parts: [] as unknown[],
        toJSON() {
          visits.count += 1;
          return { id: this.id, content: this.content, parts: this.parts };
        },
      }));
      return { messages, visits };
    }
    const base = {
      sessionIdentity: "session-large",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
      title: "Large",
    } as const;

    test("a revision answers unchanged without visiting any of 1,000 messages", () => {
      const { messages, visits } = countedHistory(1_000);
      const first = bridgeTranscriptUpdate(messages, { ...base, revision: 1 });
      visits.count = 0;
      const unchanged = bridgeTranscriptUpdate(messages, {
        ...base,
        revision: 1,
        knownToken: first.token,
      });
      expect(unchanged.status).toBe("unchanged");
      expect(visits.count).toBe(0);
    });

    test("the legacy content-hash fallback still invalidates on changed text", () => {
      const { messages, visits } = countedHistory(3);
      const first = bridgeTranscriptUpdate(messages, base);
      // Proves the fallback is the linear path this contract replaces for
      // bridges that can supply a revision.
      visits.count = 0;
      expect(bridgeTranscriptUpdate(messages, { ...base, knownToken: first.token }).status).toBe(
        "unchanged",
      );
      expect(visits.count).toBe(3);

      messages[1]!.content = "changed";
      expect(bridgeTranscriptUpdate(messages, { ...base, knownToken: first.token }).status).toBe(
        "snapshot",
      );
    });
  });

  test("keeps a ten-thousand-message source bounded at the transport boundary", () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      message(String(index), `message-${index}-${"x".repeat(8_192)}`),
    );
    const update = bridgeTranscriptUpdate(messages, {
      sessionIdentity: "session-large",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 10_000,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
    });

    expect(update.status).toBe("snapshot");
    if (update.status !== "snapshot") throw new Error("expected snapshot");
    expect(update.value.messages.length).toBeLessThanOrEqual(100);
    expect(update.value.messages.at(-1)?.id).toBe("9999");
    expect(update.value.startIndex).toBe(10_000 - update.value.messages.length);
    expect(update.value.messageWindow.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(update)).byteLength).toBeLessThan(600 * 1024);
  });

  test("attributes truncation to the window only when the window actually trimmed", () => {
    // A source that already dropped older history reports `complete: false`.
    // The reader is genuinely missing messages, but naming a byte or count trim
    // would describe a cut this response never made.
    const incomplete = bridgeTranscriptUpdate([message("1"), message("2")], {
      sessionIdentity: "session-1",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 3,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: false,
    });
    expect(incomplete.status).toBe("snapshot");
    if (incomplete.status !== "snapshot") throw new Error("expected snapshot");
    expect(incomplete.value.messages).toHaveLength(2);
    expect(incomplete.value.startIndex).toBe(0);
    expect(incomplete.value.complete).toBe(false);
    expect(incomplete.value.messageWindow.truncated).toBe(true);
    expect(incomplete.value.messageWindow.truncationReason).toBeUndefined();
    expect(incomplete.value.messageWindow.omittedMessages).toBeUndefined();

    // The same source once the window does cut: now the reason is real.
    const trimmed = bridgeTranscriptUpdate(
      Array.from({ length: 5 }, (_, index) => message(String(index))),
      {
        sessionIdentity: "session-1",
        generation: "generation-1",
        contentEpoch: "epoch-1",
        revision: 3,
        limit: 2,
        targetBytes: 512 * 1024,
        complete: false,
      },
    );
    expect(trimmed.status).toBe("snapshot");
    if (trimmed.status !== "snapshot") throw new Error("expected snapshot");
    expect(trimmed.value.messageWindow).toMatchObject({
      truncated: true,
      truncationReason: "count",
      omittedMessages: 3,
    });
  });

  test("reports a complete untruncated window without a reason", () => {
    const update = bridgeTranscriptUpdate([message("1")], {
      sessionIdentity: "session-1",
      generation: "generation-1",
      contentEpoch: "epoch-1",
      revision: 1,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
    });
    expect(update.status).toBe("snapshot");
    if (update.status !== "snapshot") throw new Error("expected snapshot");
    expect(update.value.complete).toBe(true);
    expect(update.value.messageWindow).toEqual({ truncated: false });
  });
});
