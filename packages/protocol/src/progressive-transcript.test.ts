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
});
