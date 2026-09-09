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
