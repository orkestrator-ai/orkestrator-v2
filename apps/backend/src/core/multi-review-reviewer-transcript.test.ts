import { describe, expect, test } from "bun:test";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  MAX_REVIEWER_TRANSCRIPT_MESSAGES,
  boundReviewerTranscript,
  readReviewerTranscript,
} from "./multi-review-reviewer-transcript.js";

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("reviewer transcript bounds", () => {
  test("keeps the newest messages within the count bound", () => {
    const messages = Array.from({ length: MAX_REVIEWER_TRANSCRIPT_MESSAGES + 25 }, (_, index) => ({
      index,
    }));
    const bounded = boundReviewerTranscript(messages);
    expect(bounded.messages).toHaveLength(MAX_REVIEWER_TRANSCRIPT_MESSAGES);
    expect(bounded.messages[0]).toEqual({ index: 25 });
    expect(bounded.truncated).toBe(true);
  });

  test("measures UTF-8 bytes, not characters", () => {
    const multibyte = { text: "é".repeat(400) }; // 800 bytes of text
    const limits = { maxMessages: 100, maxBytes: bytes([multibyte, multibyte]) };
    expect(boundReviewerTranscript([multibyte, multibyte, multibyte], limits)).toMatchObject({
      truncated: true,
      messages: [multibyte, multibyte],
    });
    expect(boundReviewerTranscript([multibyte, multibyte], limits).truncated).toBe(false);
  });

  test("never ships a single message that alone exceeds the byte bound", () => {
    const huge = { text: "x".repeat(10_000) };
    const bounded = boundReviewerTranscript([{ text: "older" }, huge], {
      maxMessages: 10,
      maxBytes: 1_000,
    });
    expect(bounded.messages).toEqual([]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBeLessThanOrEqual(1_000);
  });
});

describe("conditional reviewer transcript reads", () => {
  function snapshotProvider() {
    const calls: Array<{ limit: number; targetBytes: number; knownSourceToken?: string }> = [];
    let revision = 1;
    const provider = {
      agent: "claude",
      async messages() {
        throw new Error("the unbounded route must not be used");
      },
      async transcriptSnapshot(
        _sessionId: string,
        options: { limit: number; targetBytes: number; knownSourceToken?: string },
      ) {
        calls.push(options);
        const token = `rev-${revision}`;
        if (options.knownSourceToken === token)
          return { unchanged: true as const, sourceToken: token };
        return { messages: [{ revision }], sourceToken: token, complete: true };
      },
    };
    return {
      provider: provider as unknown as BuildPipelineProvider,
      calls,
      advance() {
        revision += 1;
      },
    };
  }

  test("sends bounded arguments and answers unchanged without messages", async () => {
    const fake = snapshotProvider();
    const first = await readReviewerTranscript(fake.provider, "session-a", undefined);
    expect(first).toMatchObject({ kind: "snapshot", messages: [{ revision: 1 }], fallback: false });
    expect(fake.calls[0]).toEqual({ limit: 500, targetBytes: 2 * 1024 * 1024 });

    const second = await readReviewerTranscript(
      fake.provider,
      "session-a",
      first.kind === "snapshot" ? first.sourceToken : undefined,
    );
    expect(second).toEqual({
      kind: "unchanged",
      sourceToken: first.kind === "snapshot" ? first.sourceToken! : "",
      fallback: false,
    });
    expect(fake.calls[1]?.knownSourceToken).toBe("rev-1");

    fake.advance();
    const third = await readReviewerTranscript(fake.provider, "session-a", second.sourceToken);
    expect(third).toMatchObject({ kind: "snapshot", messages: [{ revision: 2 }] });
  });

  test("a token from another session is never forwarded to the provider", async () => {
    const fake = snapshotProvider();
    const first = await readReviewerTranscript(fake.provider, "session-a", undefined);
    const replaced = await readReviewerTranscript(
      fake.provider,
      "session-b",
      first.kind === "snapshot" ? first.sourceToken : undefined,
    );
    expect(replaced.kind).toBe("snapshot");
    expect(fake.calls[1]?.knownSourceToken).toBeUndefined();
  });

  test("an oversized or foreign token is ignored rather than trusted", async () => {
    const fake = snapshotProvider();
    await readReviewerTranscript(fake.provider, "session-a", "x".repeat(5_000));
    await readReviewerTranscript(fake.provider, "session-a", "rt1.not-this-session.rev-1");
    expect(fake.calls.every((call) => call.knownSourceToken === undefined)).toBe(true);
  });

  test("providers without a snapshot surface use the bounded compatibility path", async () => {
    const provider = {
      agent: "claude",
      async messages() {
        return Array.from({ length: 700 }, (_, index) => ({ index }));
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "session", undefined);
    expect(read).toMatchObject({ kind: "snapshot", fallback: true, truncated: true });
    expect(read.kind === "snapshot" ? read.messages : []).toHaveLength(500);
    expect(read.kind === "snapshot" ? read.sourceToken : "token").toBeUndefined();
  });
});
