import { describe, expect, test } from "bun:test";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import {
  LEGACY_HISTORY_EPOCH,
  MAX_REVIEWER_TRANSCRIPT_MESSAGES,
  boundReviewerTranscript,
  readReviewerHistoryPage,
  readReviewerToolDetails,
  readReviewerTranscript,
  reviewerHistoryDigest,
  reviewerHistoryKey,
} from "./multi-review-reviewer-transcript.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";
import { openCodeHistoryServer, openCodeMessageId } from "./opencode-history-test-support.js";
import {
  openCodeTranscriptSource,
  openCodeTranscriptSnapshot,
  openCodeTranscriptPage,
} from "./opencode-snapshots.js";
import { encodeDirectHistoryCursor } from "./native-agent-direct-history.js";

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

describe("revised reviewer rows", () => {
  test("rows the provider revised outside the tail travel beside it, not ones it shows", async () => {
    const provider = {
      agent: "claude",
      async messages() {
        throw new Error("the unbounded route must not be used");
      },
      async transcriptSnapshot() {
        return {
          messages: [{ id: "m9", role: "assistant", content: "tail", parts: [] }],
          sourceToken: "rev-1",
          complete: false,
          revisedMessages: [
            { id: "m2", role: "assistant", content: "settled late", parts: [] },
            { id: "m9", role: "assistant", content: "tail", parts: [] },
          ],
        };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "session-a", undefined);
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(read.revisedMessages).toEqual([
      { id: "m2", role: "assistant", content: "settled late", parts: [] },
    ]);
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
    expect(first).toMatchObject({ kind: "snapshot", messages: [{ revision: 1 }] });
    expect(fake.calls[0]).toEqual({ limit: 500, targetBytes: 2 * 1024 * 1024 });

    const second = await readReviewerTranscript(
      fake.provider,
      "session-a",
      first.kind === "snapshot" ? first.sourceToken : undefined,
    );
    expect(second).toEqual({
      kind: "unchanged",
      sourceToken: first.kind === "snapshot" ? first.sourceToken! : "",
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

  test("a provider without a snapshot surface fails the read instead of reading unbounded", async () => {
    let reads = 0;
    const provider = {
      agent: "claude",
      async messages() {
        reads += 1;
        return [];
      },
    } as unknown as BuildPipelineProvider;
    await expect(readReviewerTranscript(provider, "session", undefined)).rejects.toThrow(
      "no bounded transcript snapshot surface",
    );
    expect(reads).toBe(0);
  });
});

describe("lightweight reviewer transcripts", () => {
  const output = "o".repeat(64 * 1024);
  function history() {
    return [
      {
        id: "m1",
        role: "assistant",
        content: "",
        createdAt: "2026-09-27T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Read",
            sourcePartId: "m1:0",
            toolUseId: "call-1",
            toolOutput: output,
          },
        ],
      },
    ];
  }

  function summaryProvider(messages = history()) {
    const requested: Array<string | undefined> = [];
    const provider = {
      agent: "codex",
      async messages() {
        throw new Error("the unbounded route must not be used");
      },
      async transcriptSnapshot(
        _sessionId: string,
        options: { limit: number; targetBytes: number; representation?: "summary" },
      ) {
        requested.push(options.representation);
        const update = bridgeTranscriptSummaryUpdate(messages, {
          sessionIdentity: "s",
          generation: "g",
          contentEpoch: 1,
          revision: 1,
          limit: 100,
          targetBytes: options.targetBytes,
          complete: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        return {
          messages: update.value.messages,
          sourceToken: update.token,
          complete: true,
          representation: "summary" as const,
        };
      },
      async transcriptDetail(_sessionId: string, locator: string) {
        const result = readBridgeTranscriptDetail(messages, locator);
        return result.status === "ok"
          ? { status: "ok" as const, detail: result.detail }
          : { status: result.status as "missing" | "expired" | "too-large" };
      },
    } as unknown as BuildPipelineProvider;
    return { provider, requested, messages };
  }

  test("asks for summaries and exposes each locator as the row's detail reference", async () => {
    const { provider, requested } = summaryProvider();
    const read = await readReviewerTranscript(provider, "session-1", undefined);
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(requested).toEqual(["summary"]);
    const part = (read.messages[0] as { parts: Array<Record<string, unknown>> }).parts[0]!;
    expect(part.toolOutput).toBeUndefined();
    expect(part.detail).toBeUndefined();
    expect(typeof part.detailRef).toBe("string");
    expect(read.bytes).toBeLessThan(4 * 1024);

    const details = await readReviewerToolDetails(provider, "session-1", part.detailRef as string);
    expect(details).toEqual({ detailRef: part.detailRef as string, toolOutput: output });
  });

  test("a changed body or a forged reference is refused, never swapped", async () => {
    const { provider, messages } = summaryProvider();
    const read = await readReviewerTranscript(provider, "session-1", undefined);
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    const detailRef = (read.messages[0] as { parts: Array<{ detailRef: string }> }).parts[0]!
      .detailRef;
    messages[0]!.parts[0]!.toolOutput = "changed";
    await expect(readReviewerToolDetails(provider, "session-1", detailRef)).rejects.toThrow(
      "no longer available",
    );
    await expect(readReviewerToolDetails(provider, "session-1", "/etc/passwd")).rejects.toThrow(
      "invalid",
    );
  });

  test("a provider without detail reads keeps raw bodies inline", async () => {
    const { provider } = summaryProvider();
    delete (provider as { transcriptDetail?: unknown }).transcriptDetail;
    const requested: Array<string | undefined> = [];
    const raw = {
      ...provider,
      async transcriptSnapshot(_id: string, options: { representation?: "summary" }) {
        requested.push(options.representation);
        return { messages: history(), sourceToken: "t", complete: true };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(raw, "session-1", undefined);
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(requested).toEqual([undefined]);
    expect(
      (read.messages[0] as { parts: Array<{ toolOutput?: string }> }).parts[0]!.toolOutput,
    ).toBe(output);
  });
});

describe("reviewer history pages", () => {
  const key = reviewerHistoryKey("multi-1", "reviewer-1");
  const output = "o".repeat(32 * 1024);

  function toolMessage(index: number) {
    return {
      id: `m${index}`,
      role: "assistant",
      content: "",
      createdAt: "2026-09-27T00:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Read",
          sourcePartId: `m${index}:0`,
          toolUseId: `call-${index}`,
          toolOutput: `${index}:${output}`,
        },
      ],
    };
  }

  /** A v2 bridge that serves summaries, details and direct pages. */
  function pagingProvider(count: number) {
    const state = { messages: Array.from({ length: count }, (_, i) => toolMessage(i)), epoch: 1 };
    const calls = { legacy: 0, pages: 0 };
    const provider = {
      agent: "codex",
      async messages() {
        calls.legacy += 1;
        throw new Error("direct paging must not read the legacy transcript");
      },
      async transcriptSnapshot(_id: string, options: { limit: number; targetBytes: number }) {
        const update = bridgeTranscriptSummaryUpdate(state.messages, {
          sessionIdentity: "s",
          generation: "g",
          contentEpoch: state.epoch,
          revision: 1,
          limit: Math.min(options.limit, 100),
          targetBytes: options.targetBytes,
          complete: true,
          pages: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        return {
          messages: update.value.messages,
          historyStartIndex: update.value.startIndex,
          sourceToken: update.token,
          complete: update.value.complete,
          historyEpoch: `g:${state.epoch}`,
          representation: "summary" as const,
          ...(update.value.historyCursor ? { historyCursor: update.value.historyCursor } : {}),
        };
      },
      async transcriptPage(
        _id: string,
        options: { cursor: string; limit: number; targetBytes: number },
      ) {
        calls.pages += 1;
        const page = bridgeTranscriptPage(state.messages, {
          generation: "g",
          contentEpoch: state.epoch,
          complete: true,
          ...options,
        });
        if (page.status !== "page") return { status: "expired" as const };
        return {
          status: "page" as const,
          messages: page.messages,
          historyStartIndex: page.startIndex,
          ...(page.nextCursor ? { historyCursor: page.nextCursor } : {}),
          complete: page.complete,
          truncated: page.truncated,
          historyEpoch: `g:${state.epoch}`,
          representation: "summary" as const,
        };
      },
      async transcriptDetail(_id: string, locator: string) {
        const result = readBridgeTranscriptDetail(state.messages, locator);
        return result.status === "ok"
          ? { status: "ok" as const, detail: result.detail }
          : { status: result.status as "missing" | "expired" | "too-large" };
      },
    } as unknown as BuildPipelineProvider;
    return { provider, state, calls };
  }

  function ids(messages: unknown[]): string[] {
    return messages.map((message) => (message as { id: string }).id);
  }

  test("direct pages reach the start of history in order, with expandable details", async () => {
    const { provider, calls } = pagingProvider(250);
    const owner = { sessionKey: key, providerSessionId: "session-1" };
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(ids(read.messages)[0]).toBe("m150");
    expect(read.historyEpoch).toBe("g:1");
    expect(read.historyCursor).toBeDefined();

    const earlier: unknown[] = [];
    let cursor = read.historyCursor;
    let last: Awaited<ReturnType<typeof readReviewerHistoryPage>> | undefined;
    for (let guard = 0; cursor && guard < 10; guard += 1) {
      last = await readReviewerHistoryPage(provider, owner, cursor, { limit: 60 });
      if (last.kind !== "page") throw new Error("expected a page");
      expect(last.nextCursor).not.toBe(cursor);
      earlier.unshift(...last.messages);
      cursor = last.nextCursor;
    }
    expect(ids(earlier)).toEqual(Array.from({ length: 150 }, (_, i) => `m${i}`));
    expect(last).toMatchObject({ kind: "page", complete: true, truncated: false, fallback: false });
    expect(calls.legacy).toBe(0);

    // An earlier page's tool body stays deferred and expands through the
    // same reviewer-scoped detail read the tail uses.
    const part = (earlier[3] as { parts: Array<Record<string, unknown>> }).parts[0]!;
    expect(part.toolOutput).toBeUndefined();
    expect(typeof part.detailRef).toBe("string");
    await expect(
      readReviewerToolDetails(provider, "session-1", part.detailRef as string),
    ).resolves.toMatchObject({ toolOutput: `3:${output}` });
  });

  test("a rotated history epoch answers expired, never an empty or complete page", async () => {
    const { provider, state } = pagingProvider(250);
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    state.epoch = 2;
    await expect(
      readReviewerHistoryPage(
        provider,
        { sessionKey: key, providerSessionId: "session-1" },
        read.historyCursor,
      ),
    ).resolves.toEqual({ kind: "expired", reason: "history-changed" });
  });

  test("a replaced session expires the cursor and another reviewer's cursor is refused", async () => {
    const { provider, calls } = pagingProvider(250);
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    await expect(
      readReviewerHistoryPage(
        provider,
        { sessionKey: key, providerSessionId: "session-2" },
        read.historyCursor,
      ),
    ).resolves.toEqual({ kind: "expired", reason: "session-replaced" });
    const otherReviewer = { sessionKey: reviewerHistoryKey("multi-1", "reviewer-2") };
    await expect(
      readReviewerHistoryPage(
        provider,
        { ...otherReviewer, providerSessionId: "session-1" },
        read.historyCursor,
      ),
    ).rejects.toThrow("does not belong to this reviewer");
    // A native-agent tab's cursor for the same provider session is not this
    // reviewer's either.
    const nativeCursor = encodeDirectHistoryCursor({
      sessionKey: "native:env:codex:tab",
      providerSessionId: "session-1",
      historyEpoch: "g:1",
      providerCursor: "bp1.x",
    })!;
    await expect(
      readReviewerHistoryPage(
        provider,
        { sessionKey: key, providerSessionId: "session-1" },
        nativeCursor,
      ),
    ).rejects.toThrow("does not belong to this reviewer");
    await expect(
      readReviewerHistoryPage(
        provider,
        { sessionKey: key, providerSessionId: "session-1" },
        "junk",
      ),
    ).rejects.toThrow("does not belong to this reviewer");
    expect(calls.pages).toBe(0);
  });

  test("the cursor digests match the native direct cursor's owner fields", () => {
    const cursor = encodeDirectHistoryCursor({
      sessionKey: key,
      providerSessionId: "session-1",
      historyEpoch: "e",
      providerCursor: "c",
    })!;
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    expect(body.key).toBe(reviewerHistoryDigest(key));
    expect(body.session).toBe(reviewerHistoryDigest("session-1"));
  });

  test("providers without pages use the joined fallback by message identity", async () => {
    let messages: Array<{ id: string; role: string; content: string }> = Array.from(
      { length: 700 },
      (_, i) => ({ id: `m${i}`, role: "assistant", content: `step ${i}` }),
    );
    const limits: Array<number | undefined> = [];
    const provider = {
      agent: "claude",
      async messages(_id: string, options?: { limit?: number }) {
        limits.push(options?.limit);
        return options?.limit && messages.length > options.limit
          ? messages.slice(-options.limit)
          : messages;
      },
      // A snapshot surface with no epoch and no page route.
      async transcriptSnapshot(_id: string, options: { limit: number }) {
        return {
          messages: messages.slice(-options.limit),
          complete: messages.length <= options.limit,
          sourceToken: "t",
        };
      },
    } as unknown as BuildPipelineProvider;
    const owner = { sessionKey: key, providerSessionId: "session-1" };
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    expect(read).toMatchObject({ historyEpoch: LEGACY_HISTORY_EPOCH });
    expect(ids(read.messages)[0]).toBe("m200");

    const first = await readReviewerHistoryPage(provider, owner, read.historyCursor, {
      limit: 150,
    });
    expect(first).toMatchObject({ kind: "page", fallback: true, complete: false, truncated: true });
    if (first.kind !== "page" || !first.nextCursor) throw new Error("expected a page");
    expect(ids(first.messages)).toEqual(Array.from({ length: 150 }, (_, i) => `m${50 + i}`));
    const second = await readReviewerHistoryPage(provider, owner, first.nextCursor, {
      limit: 150,
    });
    expect(second).toMatchObject({ kind: "page", complete: true, truncated: false });
    if (second.kind !== "page") throw new Error("expected a page");
    expect(ids(second.messages)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    expect(second.nextCursor).toBeUndefined();
    // The fallback read is count-bounded, never an unlimited transcript read.
    expect(limits.every((limit) => typeof limit === "number")).toBe(true);

    // History rewritten under the cursor: its message is gone, so it expires.
    messages = messages.map((message) => ({ ...message, id: `new-${message.id}` }));
    await expect(readReviewerHistoryPage(provider, owner, first.nextCursor)).resolves.toEqual({
      kind: "expired",
      reason: "history-changed",
    });
  });

  test("a joined cursor expires when the provider reports a new history epoch", async () => {
    const messages = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, role: "assistant" }));
    let epoch = "g:1";
    const provider = {
      agent: "claude",
      async messages() {
        return messages;
      },
      async transcriptSnapshot(_id: string, options: { limit: number }) {
        return {
          messages: messages.slice(-Math.min(options.limit, 100)),
          complete: false,
          historyEpoch: epoch,
          sourceToken: "t",
        };
      },
    } as unknown as BuildPipelineProvider;
    const owner = { sessionKey: key, providerSessionId: "session-1" };
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    expect(read.historyEpoch).toBe("g:1");
    await expect(
      readReviewerHistoryPage(provider, owner, read.historyCursor),
    ).resolves.toMatchObject({ kind: "page", historyEpoch: "g:1", complete: true });
    epoch = "g:2";
    await expect(readReviewerHistoryPage(provider, owner, read.historyCursor)).resolves.toEqual({
      kind: "expired",
      reason: "history-changed",
    });
  });

  test("OpenCode envelopes page by their info id and ship as display messages", async () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({
      info: { id: `msg_${i}`, role: "assistant", time: { created: 1_800_000_000_000 + i } },
      parts: [{ id: `part_${i}`, type: "text", text: `row ${i}` }],
    }));
    const provider = {
      agent: "opencode",
      async messages(_id: string, options?: { limit?: number }) {
        return options?.limit ? messages.slice(-options.limit) : messages;
      },
      // Raw envelopes, no epoch and no page route: pages join by identity.
      async transcriptSnapshot(_id: string, options: { limit: number }) {
        return {
          messages: messages.slice(-options.limit),
          complete: messages.length <= options.limit,
          sourceToken: "t",
        };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "ses", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    // The renderer has no OpenCode normalizer: the raw envelope never leaves.
    expect(read.messages[0]).toEqual({
      id: "msg_100",
      role: "assistant",
      content: "row 100",
      parts: [{ type: "text", content: "row 100", sourcePartId: "part_100" }],
      createdAt: new Date(1_800_000_000_100).toISOString(),
    });
    expect(read.bytes).toBe(bytes(read.messages));
    const owner = { sessionKey: key, providerSessionId: "ses" };
    const page = await readReviewerHistoryPage(provider, owner, read.historyCursor, { limit: 40 });
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.messages).toHaveLength(40);
    expect(page.messages[0]).toMatchObject({ id: "msg_60", content: "row 60" });
    expect(page.messages.every((message) => !("info" in (message as object)))).toBe(true);
    expect(page.bytes).toBe(bytes(page.messages));
    // The page's cursor still names a raw row, so the next page continues
    // exactly where this one began.
    if (!page.nextCursor) throw new Error("expected a cursor");
    const next = await readReviewerHistoryPage(provider, owner, page.nextCursor, { limit: 100 });
    if (next.kind !== "page") throw new Error("expected a page");
    expect(next.messages).toHaveLength(60);
    expect(next.messages[0]).toMatchObject({ id: "msg_0" });
    expect(next.messages.at(-1)).toMatchObject({ id: "msg_59" });
    expect(next.complete).toBe(true);
  });

  test("a raw snapshot tail normalizes OpenCode rows and keeps its cursor on the raw row", async () => {
    // An id-less envelope gets a display id; the cursor must still name a row
    // the next page's raw window search can find, or none at all.
    const messages = [
      ...Array.from({ length: 499 }, (_, i) => ({
        info: { id: `msg_${i}`, role: "assistant" },
        parts: [{ type: "text", text: `row ${i}` }],
      })),
      {
        info: { id: "failed", role: "assistant", error: { name: "UnknownError", data: {} } },
        parts: [],
      },
      { id: "flat", role: "assistant", content: "bridge row" },
    ];
    const provider = {
      agent: "opencode",
      async messages(_id: string, options?: { limit?: number }) {
        return options?.limit ? messages.slice(-options.limit) : messages;
      },
      // Raw envelopes, no epoch and no page route: pages join by identity.
      async transcriptSnapshot(_id: string, options: { limit: number }) {
        return {
          messages: messages.slice(-options.limit),
          complete: messages.length <= options.limit,
          sourceToken: "t",
        };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "ses", undefined, { key });
    if (read.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(read.messages).toHaveLength(500);
    expect(read.messages.at(-2)).toMatchObject({ id: "error-opencode-failed", role: "assistant" });
    expect(read.messages.at(-1)).toBe(messages.at(-1));
    expect(read.messages[0]).toMatchObject({ id: "msg_1", content: "row 1" });
    if (!read.historyCursor) throw new Error("expected a cursor");
    const page = await readReviewerHistoryPage(
      provider,
      { sessionKey: key, providerSessionId: "ses" },
      read.historyCursor,
    );
    expect(page).toMatchObject({ kind: "page", complete: true });
    expect(page.kind === "page" ? page.messages : []).toEqual([
      expect.objectContaining({ id: "msg_0", content: "row 0" }),
    ]);
  });

  test("the joined fallback reads no more than a bounded-tail provider accepts", async () => {
    // OpenCode keeps 64 messages and refuses a larger read; rows large enough
    // to exceed the tab's byte bound make the snapshot mint a joined cursor.
    const messages = Array.from({ length: 64 }, (_, i) => ({
      info: { id: `msg_${i}`, role: "assistant" },
      parts: [{ type: "text", text: "x".repeat(48 * 1024) }],
    }));
    const provider = {
      agent: "opencode",
      messageReadLimit: 64,
      async messages(_id: string, options?: { limit?: number }) {
        if (options?.limit === undefined || options.limit > 64) {
          throw new RangeError("OpenCode transcript limit is invalid");
        }
        return messages.slice(-options.limit);
      },
      async transcriptSnapshot() {
        return { messages, complete: true, sourceToken: "t" };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "ses", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    const owner = { sessionKey: key, providerSessionId: "ses" };
    let cursor: string | undefined = read.historyCursor;
    let page: Awaited<ReturnType<typeof readReviewerHistoryPage>> | undefined;
    for (let pages = 0; cursor && pages < 10; pages += 1) {
      page = await readReviewerHistoryPage(provider, owner, cursor);
      if (page.kind !== "page") throw new Error("expected a page");
      cursor = page.nextCursor;
    }
    if (page?.kind !== "page") throw new Error("expected a page");
    expect(page.messages[0]).toMatchObject({ id: "msg_0" });
    // A full provider window may have hidden older history: not complete.
    expect(page).toMatchObject({ complete: false, truncated: true });
    expect(page.nextCursor).toBeUndefined();
  });

  test("history the provider reports but cannot return is unreachable, not complete", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, role: "assistant" }));
    const provider = {
      agent: "cursor",
      async messages() {
        return messages;
      },
      async transcriptSnapshot() {
        // The bridge trimmed its own store: older history existed once.
        return { messages, complete: false, historyEpoch: "g:1", sourceToken: "t" };
      },
    } as unknown as BuildPipelineProvider;
    const read = await readReviewerTranscript(provider, "session-1", undefined, { key });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected a cursor");
    await expect(
      readReviewerHistoryPage(
        provider,
        { sessionKey: key, providerSessionId: "session-1" },
        read.historyCursor,
      ),
    ).resolves.toEqual({
      kind: "page",
      messages: [],
      historyEpoch: "g:1",
      complete: false,
      truncated: true,
      fallback: true,
      bytes: 2,
    });
  });

  test("a complete window mints no cursor, and reads without a history key are unchanged", async () => {
    const { provider } = pagingProvider(10);
    const complete = await readReviewerTranscript(provider, "session-1", undefined, { key });
    expect(complete).toMatchObject({ kind: "snapshot", truncated: false, historyEpoch: "g:1" });
    expect(complete.kind === "snapshot" ? complete.historyCursor : "x").toBeUndefined();
    const keyless = await readReviewerTranscript(
      pagingProvider(250).provider,
      "session-1",
      undefined,
    );
    expect(keyless.kind === "snapshot" ? keyless.historyCursor : "x").toBeUndefined();
    expect(keyless.kind === "snapshot" ? keyless.historyEpoch : "x").toBeUndefined();
  });
});

test("Multi Review adopts inline OpenCode cursors and pages beyond the retained cache", async () => {
  const server = openCodeHistoryServer(220);
  const stream = new OpenCodeStreamState();
  stream.replaceMessages("owned-session", server.read(64), undefined, 64);
  const source = openCodeTranscriptSource(stream, "owned-session", {
    readMessages: async (limit, before) => server.read(limit, before),
    recordUnknown: () => undefined,
  });
  let pages = 0;
  const provider = {
    agent: "opencode",
    messages: async () => {
      throw new Error("legacy read must not run");
    },
    transcriptSnapshot: async (
      _id: string,
      options: Parameters<typeof openCodeTranscriptSnapshot>[1],
    ) => openCodeTranscriptSnapshot(source, options),
    transcriptPage: async (_id: string, options: Parameters<typeof openCodeTranscriptPage>[1]) => {
      pages++;
      return openCodeTranscriptPage(source, options);
    },
  } as unknown as BuildPipelineProvider;
  const owner = { sessionKey: "reviewer", providerSessionId: "owned-session" };
  const read = await readReviewerTranscript(provider, owner.providerSessionId, undefined, {
    key: owner.sessionKey,
  });
  if (read.kind !== "snapshot") throw new Error("expected snapshot");
  const held = [...read.messages];
  let cursor = read.historyCursor;
  for (let guard = 0; cursor && guard < 10; guard++) {
    const page = await readReviewerHistoryPage(provider, owner, cursor, { limit: 50 });
    if (page.kind !== "page") throw new Error("expected page");
    expect(page.fallback).toBe(false);
    held.unshift(...page.messages);
    cursor = page.nextCursor;
  }
  expect(pages).toBeGreaterThan(0);
  expect((held[0] as { id: string }).id).toBe(openCodeMessageId(0));
  expect(held).toHaveLength(220);
});

test.each([1.2, 3.8])(
  "Multi Review accepts a %s MiB whole bridge row and continues older paging",
  async (mib) => {
    const history = Array.from({ length: 120 }, (_, index) => ({
      id: `oversized-${index}`,
      role: "assistant" as const,
      content: "small",
      parts:
        index === 19
          ? Array.from({ length: Math.floor((mib * 1024) / 4) }, (_, i) => ({
              type: "text",
              content: `${i}:${"x".repeat(4 * 1024)}`,
            }))
          : [],
      createdAt: "now",
    }));
    const provider = {
      agent: "codex",
      messages: async () => {
        throw new Error("legacy read must not run");
      },
      transcriptSnapshot: async () => {
        const update = bridgeTranscriptSummaryUpdate(history, {
          sessionIdentity: "s",
          generation: "g",
          contentEpoch: 1,
          revision: 1,
          complete: true,
          pages: true,
          limit: 100,
          targetBytes: 512 * 1024,
        });
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        return {
          messages: update.value.messages,
          complete: false,
          historyCursor: update.value.historyCursor,
          historyEpoch: "g:1",
          representation: "summary",
        };
      },
      transcriptPage: async (
        _id: string,
        options: { cursor: string; limit: number; targetBytes: number },
      ) => {
        const page = bridgeTranscriptPage(history, {
          ...options,
          generation: "g",
          contentEpoch: 1,
          complete: true,
        });
        if (page.status !== "page") return { status: "expired" };
        return {
          status: "page",
          messages: page.messages,
          historyCursor: page.nextCursor,
          historyEpoch: "g:1",
          complete: page.complete,
          truncated: page.truncated,
          representation: "summary",
        };
      },
    } as unknown as BuildPipelineProvider;
    const owner = { sessionKey: "reviewer", providerSessionId: "s" };
    const read = await readReviewerTranscript(provider, "s", undefined, { key: owner.sessionKey });
    if (read.kind !== "snapshot" || !read.historyCursor) throw new Error("expected cursor");
    const first = await readReviewerHistoryPage(provider, owner, read.historyCursor, {
      limit: 100,
      targetBytes: 256 * 1024,
    });
    if (first.kind !== "page") throw new Error("expected page");
    expect(first.messages).toEqual([history[19]]);
    expect(first.complete).toBe(false);
    const older = await readReviewerHistoryPage(provider, owner, first.nextCursor!, {
      limit: 100,
      targetBytes: 256 * 1024,
    });
    if (older.kind !== "page") throw new Error("expected page");
    expect(older.messages).toEqual(history.slice(0, 19));
    expect(older.complete).toBe(true);
  },
);

test("OpenCode revised inline steps outside a byte-bounded reviewer tail retain display identities", async () => {
  const server = openCodeHistoryServer(64, () => "x".repeat(80 * 1024));
  const stream = new OpenCodeStreamState();
  stream.replaceMessages("owned-session", server.read(64), undefined, 64);
  const id = openCodeMessageId(1);
  const part = server.messages[1]!.parts[0]!;
  stream.apply({
    type: "message.part.updated",
    properties: { sessionID: "owned-session", part: { ...part, text: "settled late" } },
  } as never);
  const source = openCodeTranscriptSource(stream, "owned-session", {
    readMessages: async (limit, before) => server.read(limit, before),
    recordUnknown: () => undefined,
  });
  const provider = {
    agent: "opencode",
    messages: async () => [],
    transcriptSnapshot: async (
      _id: string,
      options: Parameters<typeof openCodeTranscriptSnapshot>[1],
    ) => openCodeTranscriptSnapshot(source, options),
  } as unknown as BuildPipelineProvider;
  const read = await readReviewerTranscript(provider, "owned-session", undefined);
  if (read.kind !== "snapshot") throw new Error("expected snapshot");
  expect(read.messages.some((row) => (row as { id: string }).id === id)).toBe(false);
  expect(read.revisedMessages).toEqual([
    expect.objectContaining({
      id,
      content: "settled late",
      parts: [expect.objectContaining({ type: "text", content: "settled late" })],
    }),
  ]);
});
