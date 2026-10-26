import { describe, expect, test } from "bun:test";
import { OPEN_CODE_MESSAGE_HISTORY_LIMIT } from "@orkestrator/protocol/opencode-message-id";
import type {
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import { openCodeHistoryServer, openCodeMessageId } from "./opencode-history-test-support.js";
import {
  openCodeSessionStateSnapshot,
  openCodeTranscriptPage,
  openCodeTranscriptSnapshot,
  openCodeTranscriptSource,
} from "./opencode-snapshots.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";

function rawMessage(id: string): unknown {
  return { info: { id, role: "assistant", time: { created: 1 } }, parts: [] };
}

function input(limit: number) {
  const replaced: unknown[][] = [];
  const reads: number[] = [];
  return {
    replaced,
    reads,
    run: () =>
      openCodeTranscriptSnapshot(
        {
          revision: () => 3,
          currentMessages: () => undefined,
          currentMessagesFromStart: () => false,
          historyEpoch: () => "epoch-1",
          readMessages: async (count) => {
            reads.push(count);
            return Array.from({ length: Math.min(count, 5) }, (_, index) =>
              rawMessage(`m-${index}`),
            );
          },
          replaceMessages: (messages) => replaced.push(messages),
          title: () => undefined,
          recordUnknown: () => undefined,
        },
        { limit, targetBytes: 64 * 1024 },
      ),
  };
}

test("a short tail read (a progress probe) never seeds the stream cache", async () => {
  const probe = input(1);
  const snapshot = await probe.run();
  expect("messages" in snapshot && snapshot.messages).toHaveLength(1);
  expect(probe.reads).toEqual([1]);
  // Seeding with one message would make every later display read serve it
  // as the whole "current" transcript.
  expect(probe.replaced).toEqual([]);
});

test("a read covering the retained history still seeds the stream cache", async () => {
  const display = input(OPEN_CODE_MESSAGE_HISTORY_LIMIT);
  await display.run();
  expect(display.replaced).toHaveLength(1);
});

test("body-free state snapshots carry last-assistant model and reasoning evidence", () => {
  const snapshot = openCodeSessionStateSnapshot({
    status: "idle",
    revision: 3,
    runtime: {},
    notices: [],
    messages: [
      {
        info: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "deepseek-v4-flash",
          variant: "high",
        },
        parts: [{ type: "text", text: "private body" }],
      },
      { info: { role: "user" }, parts: [] },
    ],
  });
  expect(snapshot.lastAssistantModelId).toBe("opencode-go/deepseek-v4-flash");
  expect(snapshot.lastAssistantReasoningId).toBe("high");
  expect(JSON.stringify(snapshot)).not.toContain("private body");
  expect("messages" in snapshot).toBe(false);
});

function rowIds(messages: readonly unknown[]): string[] {
  return messages.map((message) => (message as { id: string }).id);
}

function decodeCursor(cursor: string | undefined): unknown {
  return cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) : undefined;
}

describe("OpenCode history paging", () => {
  const liveWindow = { limit: 100, targetBytes: 512 * 1024 };

  function snapshotOf(
    server: ReturnType<typeof openCodeHistoryServer>,
    options: { limit: number; targetBytes: number } = liveWindow,
    cache?: { messages: unknown[]; fromStart: boolean },
  ): Promise<ProviderTranscriptSnapshot> {
    return openCodeTranscriptSnapshot(
      {
        revision: () => 1,
        currentMessages: () => cache?.messages,
        currentMessagesFromStart: () => cache?.fromStart ?? false,
        historyEpoch: () => "epoch-1",
        readMessages: async (limit) => server.read(limit),
        replaceMessages: () => undefined,
        title: () => undefined,
        recordUnknown: () => undefined,
      },
      options,
    ) as Promise<ProviderTranscriptSnapshot>;
  }

  function pageOf(
    server: ReturnType<typeof openCodeHistoryServer>,
    cursor: string,
    options: { limit: number; targetBytes: number; epoch?: () => string },
  ): Promise<ProviderTranscriptPage> {
    return openCodeTranscriptPage(
      {
        historyEpoch: options.epoch ?? (() => "epoch-1"),
        readMessages: async (limit, before) => server.read(limit, before),
        recordUnknown: () => undefined,
      },
      { cursor, limit: options.limit, targetBytes: options.targetBytes },
    );
  }

  test("a session longer than the window names a cursor at its oldest kept message", async () => {
    const server = openCodeHistoryServer(150);
    const snapshot = await snapshotOf(server);
    expect(snapshot.messages).toHaveLength(100);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.historyEpoch).toBe("epoch-1");
    expect(snapshot.historyStartIndex).toBeUndefined();
    expect(decodeCursor(snapshot.historyCursor)).toEqual({
      id: openCodeMessageId(50),
      time: 1_000 + Math.floor(50 / 3),
    });
  });

  test("a session that fits is complete and offers no cursor", async () => {
    const snapshot = await snapshotOf(openCodeHistoryServer(12));
    expect(snapshot.messages).toHaveLength(12);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.historyCursor).toBeUndefined();
  });

  test("a cached window that was not read from the start still pages", async () => {
    const server = openCodeHistoryServer(80);
    // Seeded by a 64-message read and grown by streamed steps since.
    const cached = server.read(OPEN_CODE_MESSAGE_HISTORY_LIMIT);
    const snapshot = await snapshotOf(server, liveWindow, { messages: cached, fromStart: false });
    expect(snapshot.messages).toHaveLength(OPEN_CODE_MESSAGE_HISTORY_LIMIT);
    expect(snapshot.complete).toBe(false);
    expect(decodeCursor(snapshot.historyCursor)).toMatchObject({ id: openCodeMessageId(16) });

    const fromStart = await snapshotOf(server, liveWindow, {
      messages: server.read(),
      fromStart: true,
    });
    expect(fromStart.complete).toBe(true);
    expect(fromStart.historyCursor).toBeUndefined();
  });

  test("paging walks back to the first message without gaps or duplicates", async () => {
    const server = openCodeHistoryServer(301);
    const snapshot = await snapshotOf(server);
    const seen = rowIds(snapshot.messages);
    let cursor = snapshot.historyCursor;
    let pages = 0;
    while (cursor) {
      const page = await pageOf(server, cursor, { limit: 40, targetBytes: 512 * 1024 });
      if (page.status !== "page") throw new Error("expected a page");
      expect(page.messages.length).toBeLessThanOrEqual(40);
      expect(page.historyEpoch).toBe("epoch-1");
      seen.unshift(...rowIds(page.messages));
      cursor = page.historyCursor;
      expect(page.complete).toBe(cursor === undefined);
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    // 201 older messages at 40 a page; the last page reaches the start itself.
    expect(pages).toBe(6);
    expect(seen).toEqual(server.messages.map((message) => message.info.id));
  });

  test("windows and pages hold whole messages within their byte targets", async () => {
    const server = openCodeHistoryServer(60, (index) => `${index}:`.padEnd(20_000, "x"));
    const snapshot = await snapshotOf(server, { limit: 100, targetBytes: 128 * 1024 });
    const kept = snapshot.messages.length;
    expect(kept).toBeGreaterThan(1);
    expect(Buffer.byteLength(JSON.stringify(snapshot.messages))).toBeLessThanOrEqual(128 * 1024);
    expect(decodeCursor(snapshot.historyCursor)).toMatchObject({
      id: openCodeMessageId(60 - kept),
    });

    const page = await pageOf(server, snapshot.historyCursor!, {
      limit: 50,
      targetBytes: 64 * 1024,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(64 * 1024);
    expect(rowIds(page.messages).at(-1)).toBe(openCodeMessageId(60 - kept - 1));
    expect(page.complete).toBe(false);

    // One message over the target still advances the walk, whole.
    const single = await pageOf(server, snapshot.historyCursor!, { limit: 50, targetBytes: 1 });
    if (single.status !== "page") throw new Error("expected a page");
    expect(rowIds(single.messages)).toEqual([openCodeMessageId(60 - kept - 1)]);
    expect(decodeCursor(single.historyCursor)).toMatchObject({
      id: openCodeMessageId(60 - kept - 1),
    });
  });

  test("tool output does not count against the window: it is shown behind a reference", async () => {
    const server = openCodeHistoryServer(30);
    for (const message of server.messages) {
      message.parts.push({
        id: `tool-${message.info.id}`,
        messageID: message.info.id,
        type: "tool",
        tool: "bash",
        callID: `call-${message.info.id}`,
        state: { status: "completed", input: {}, output: "o".repeat(100_000), title: "run" },
      });
    }
    const snapshot = await snapshotOf(server, { limit: 100, targetBytes: 512 * 1024 });
    expect(snapshot.messages).toHaveLength(30);
    expect(snapshot.complete).toBe(true);
  });

  test("a page never asks OpenCode for more than its own bounded read", async () => {
    const server = openCodeHistoryServer(200);
    const limits: number[] = [];
    const page = await openCodeTranscriptPage(
      {
        historyEpoch: () => "epoch-1",
        readMessages: async (limit, before) => {
          limits.push(limit);
          return server.read(limit, before);
        },
        recordUnknown: () => undefined,
      },
      { cursor: (await snapshotOf(server)).historyCursor!, limit: 1_000, targetBytes: 512 * 1024 },
    );
    if (page.status !== "page") throw new Error("expected a page");
    expect(limits).toEqual([OPEN_CODE_MESSAGE_HISTORY_LIMIT + 1]);
    expect(page.messages).toHaveLength(OPEN_CODE_MESSAGE_HISTORY_LIMIT);
  });

  test("a cursor expires when its epoch moves during the read or it is not OpenCode's", async () => {
    const server = openCodeHistoryServer(150);
    const cursor = (await snapshotOf(server)).historyCursor!;
    let epoch = "epoch-1";
    const raced = await openCodeTranscriptPage(
      {
        historyEpoch: () => epoch,
        readMessages: async (limit, before) => {
          epoch = "epoch-2";
          return server.read(limit, before);
        },
        recordUnknown: () => undefined,
      },
      { cursor, limit: 40, targetBytes: 512 * 1024 },
    );
    expect(raced).toEqual({ status: "expired" });

    for (const forged of [
      "",
      "not-a-cursor",
      Buffer.from('{"id":"x","time":1}').toString("base64url"),
    ]) {
      expect(await pageOf(server, forged, { limit: 40, targetBytes: 512 * 1024 })).toEqual({
        status: "expired",
      });
    }
  });
  function attach(
    message: { info: { id: string }; parts: Array<Record<string, unknown>> },
    url: string,
  ) {
    message.parts.push({
      id: `file-${message.info.id}`,
      messageID: message.info.id,
      type: "file",
      mime: url.slice(5, url.indexOf(";")),
      filename: "attachment",
      url,
    });
  }

  test("an inline attachment the projection keeps counts in full toward the window", async () => {
    // A PDF stays inline when projected; only images move behind a reference.
    const pdf = openCodeHistoryServer(150);
    attach(pdf.messages[140]!, `data:application/pdf;base64,${"p".repeat(600 * 1024)}`);
    const kept = await snapshotOf(pdf);
    expect(rowIds(kept.messages)[0]).toBe(openCodeMessageId(141));
    expect(decodeCursor(kept.historyCursor)).toMatchObject({ id: openCodeMessageId(141) });

    const image = openCodeHistoryServer(150);
    attach(image.messages[140]!, `data:image/png;base64,${"i".repeat(600 * 1024)}`);
    const deferred = await snapshotOf(image);
    expect(rowIds(deferred.messages)).toContain(openCodeMessageId(140));
  });

  test("a server that ignores the cursor expires explicitly", async () => {
    const server = openCodeHistoryServer(150);
    const cursor = (await snapshotOf(server)).historyCursor!;
    const page = await openCodeTranscriptPage(
      {
        historyEpoch: () => "epoch-1",
        readMessages: async (limit) => server.read(limit),
        recordUnknown: () => undefined,
      },
      { cursor, limit: 40, targetBytes: 512 * 1024 },
    );
    expect(page).toEqual({ status: "expired" });
    expect((page as { historyCursor?: string }).historyCursor).toBeUndefined();
  });

  test("the cursor is named from the oldest kept message OpenCode itself reported", async () => {
    const server = openCodeHistoryServer(12);
    const stream = new OpenCodeStreamState();
    stream.replaceMessages("owned-session", server.read().slice(0, 10), undefined, 64);
    // Message 10's part arrives before its `message.updated`: the stream makes
    // a placeholder whose clock is not the message's creation time.
    const early = server.messages[10]!;
    stream.apply({
      type: "message.part.updated",
      properties: { sessionID: "owned-session", part: early.parts[0], time: Date.now() },
    } as never);
    stream.apply({
      type: "message.updated",
      properties: { sessionID: "owned-session", info: server.messages[11]!.info },
    } as never);
    const source = openCodeTranscriptSource(stream, "owned-session", {
      readMessages: async (limit, before) => server.read(limit, before),
      recordUnknown: () => undefined,
    });
    const snapshot = (await openCodeTranscriptSnapshot(source, {
      limit: 2,
      targetBytes: 512 * 1024,
    })) as ProviderTranscriptSnapshot;
    expect(rowIds(snapshot.messages)).toEqual([openCodeMessageId(10), openCodeMessageId(11)]);
    expect(decodeCursor(snapshot.historyCursor)).toMatchObject({ id: openCodeMessageId(11) });
    // The first page overlaps the placeholder (the reader deduplicates by id)
    // rather than skipping or repeating anything around it.
    const page = await pageOf(server, snapshot.historyCursor!, { limit: 40, targetBytes: 1 << 20 });
    if (page.status !== "page") throw new Error("expected a page");
    expect(rowIds(page.messages)).toEqual(
      server.messages.slice(0, 11).map((message) => message.info.id),
    );

    // The stream's own compaction row cannot name a cursor either.
    stream.apply({
      type: "session.compacted",
      id: "compaction-1",
      properties: { sessionID: "owned-session" },
    } as never);
    const compacted = (await openCodeTranscriptSnapshot(source, {
      limit: 1,
      targetBytes: 512 * 1024,
    })) as ProviderTranscriptSnapshot;
    expect(compacted.complete).toBe(false);
    expect(compacted.historyCursor).toBeUndefined();
  });

  test("messages changed in place before the window travel as revised rows", async () => {
    const server = openCodeHistoryServer(150);
    const stream = new OpenCodeStreamState();
    stream.replaceMessages("owned-session", server.read(100), undefined, 100);
    const source = openCodeTranscriptSource(stream, "owned-session", {
      readMessages: async (limit, before) => server.read(limit, before),
      recordUnknown: () => undefined,
    });
    // A late tool result on a step long out of a narrow window, and an edit
    // inside it.
    for (const index of [60, 149]) {
      stream.apply({
        type: "message.part.updated",
        properties: {
          sessionID: "owned-session",
          part: {
            id: `tool-${index}`,
            messageID: openCodeMessageId(index),
            type: "tool",
            tool: "bash",
            callID: `call-${index}`,
            state: { status: "completed", input: {}, output: "late", title: "run" },
          },
        },
      } as never);
    }
    const snapshot = (await openCodeTranscriptSnapshot(source, {
      limit: 20,
      targetBytes: 512 * 1024,
    })) as ProviderTranscriptSnapshot;
    expect(rowIds(snapshot.messages)).toContain(openCodeMessageId(149));
    expect(rowIds(snapshot.revisedMessages ?? [])).toEqual([openCodeMessageId(60)]);
    const tool = (
      snapshot.revisedMessages![0] as { parts: Array<Record<string, unknown>> }
    ).parts.at(-1);
    expect(tool?.toolOutput).toBe("late");
  });
  test("a re-read after a stream gap is never answered as unchanged", async () => {
    const server = openCodeHistoryServer(20);
    const stream = new OpenCodeStreamState();
    stream.replaceMessages("owned-session", server.read(), undefined, 100);
    const source = openCodeTranscriptSource(stream, "owned-session", {
      readMessages: async (limit, before) => server.read(limit, before),
      recordUnknown: () => undefined,
    });
    const options = { limit: 100, targetBytes: 512 * 1024 };
    const before = (await openCodeTranscriptSnapshot(
      source,
      options,
    )) as ProviderTranscriptSnapshot;

    // A step's text changes while the stream is down; no event reports it.
    stream.markGap();
    server.messages[19]!.parts[0]!.text = "finished while disconnected";
    stream.replaceMessages(
      "owned-session",
      server.read(),
      stream.eventVersion("owned-session"),
      100,
    );
    const after = await openCodeTranscriptSnapshot(source, {
      ...options,
      knownSourceToken: before.sourceToken!,
    });
    expect("unchanged" in after).toBe(false);
    expect((after as ProviderTranscriptSnapshot).historyEpoch).toBe(before.historyEpoch);
  });
  test("a read that proves a rewrite after a gap is labelled with the new epoch", async () => {
    const server = openCodeHistoryServer(150);
    const stream = new OpenCodeStreamState();
    stream.replaceMessages("owned-session", server.read(100), undefined, 100);
    const source = openCodeTranscriptSource(stream, "owned-session", {
      readMessages: async (limit, before) => server.read(limit, before),
      recordUnknown: () => undefined,
    });
    const initial = stream.historyEpoch("owned-session");
    stream.markGap();
    // Reverted while the stream was down: the newest steps are gone.
    for (const index of [149, 148]) server.remove(openCodeMessageId(index));
    const snapshot = (await openCodeTranscriptSnapshot(source, {
      limit: 100,
      targetBytes: 512 * 1024,
    })) as ProviderTranscriptSnapshot;
    expect(snapshot.historyEpoch).not.toBe(initial);
    expect(snapshot.historyEpoch).toBe(stream.historyEpoch("owned-session"));
  });
});

test("a mixed inclusive or ignored before response cannot claim history completion", async () => {
  const server = openCodeHistoryServer(150);
  const cursor = Buffer.from(
    JSON.stringify({
      id: server.messages[50]!.info.id,
      time: server.messages[50]!.info.time.created,
    }),
  ).toString("base64url");
  const page = await openCodeTranscriptPage(
    {
      historyEpoch: () => "epoch-1",
      readMessages: async () => [server.messages[1]!, server.messages[149]!],
      recordUnknown: () => undefined,
    },
    { cursor, limit: 40, targetBytes: 512 * 1024 },
  );
  expect(page).toEqual({ status: "expired" });
});

describe("pending reverts in transcript snapshots", () => {
  function revertedSnapshot(options: {
    cached?: { from: number; fromStart: boolean };
    cut: number;
    limit: number;
    revised?: string[];
  }) {
    const server = openCodeHistoryServer(12);
    return openCodeTranscriptSnapshot(
      {
        revision: () => 7,
        historyEpoch: () => "revert-epoch",
        currentMessages: () =>
          options.cached ? server.read().slice(options.cached.from) : undefined,
        currentMessagesFromStart: () => options.cached?.fromStart ?? false,
        readMessages: async (limit) => server.read(limit),
        replaceMessages: () => undefined,
        title: () => undefined,
        recordUnknown: () => undefined,
        revertMarker: async () => ({ messageId: openCodeMessageId(options.cut) }),
        revisedMessageIds: () => options.revised ?? [],
      },
      { limit: options.limit, targetBytes: 512 * 1024 },
    ) as Promise<ProviderTranscriptSnapshot>;
  }

  test("revised messages hidden by a revert do not request history reconciliation", async () => {
    const snapshot = await revertedSnapshot({
      cached: { from: 0, fromStart: true },
      cut: 8,
      limit: 3,
      revised: [openCodeMessageId(1), openCodeMessageId(9)],
    });
    expect(rowIds(snapshot.messages)).toEqual([5, 6, 7].map(openCodeMessageId));
    expect(rowIds(snapshot.revisedMessages ?? [])).toEqual([openCodeMessageId(1)]);
    expect(snapshot.historyReconciliationToken).toBeUndefined();
    // A revised id genuinely absent from this retained read still reconciles.
    const missing = await revertedSnapshot({
      cached: { from: 4, fromStart: false },
      cut: 8,
      limit: 3,
      revised: [openCodeMessageId(1), openCodeMessageId(9)],
    });
    expect(missing.historyReconciliationToken).toBeDefined();
  });

  test("a fully hidden uncached tail uses its oldest raw message as the history cursor", async () => {
    const snapshot = await revertedSnapshot({ cut: 4, limit: 4 });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(decodeCursor(snapshot.historyCursor)).toEqual({
      id: openCodeMessageId(8),
      time: 1_002,
    });
  });

  test("a fully hidden cached suffix preserves the cursor when earlier history is unknown", async () => {
    const snapshot = await revertedSnapshot({
      cached: { from: 6, fromStart: false },
      cut: 4,
      limit: 4,
    });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(decodeCursor(snapshot.historyCursor)).toEqual({
      id: openCodeMessageId(6),
      time: 1_002,
    });
  });

  test("a revert hiding a whole session known from its start needs no history cursor", async () => {
    const snapshot = await revertedSnapshot({
      cached: { from: 0, fromStart: true },
      cut: 0,
      limit: 4,
    });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.historyCursor).toBeUndefined();
  });

  for (const fromStart of [true, false]) {
    test(`a revert shrinking a cached window respects fromStart=${fromStart}`, async () => {
      const snapshot = await revertedSnapshot({
        cached: { from: 2, fromStart },
        cut: 5,
        limit: 4,
      });
      expect(rowIds(snapshot.messages)).toEqual([2, 3, 4].map(openCodeMessageId));
      expect(snapshot.complete).toBe(fromStart);
      expect(decodeCursor(snapshot.historyCursor)).toEqual(
        fromStart ? undefined : { id: openCodeMessageId(2), time: 1_000 },
      );
    });
  }

  test("visible rows exceeding the limit still have older history when cached from the start", async () => {
    const snapshot = await revertedSnapshot({
      cached: { from: 0, fromStart: true },
      cut: 8,
      limit: 4,
    });
    expect(rowIds(snapshot.messages)).toEqual([4, 5, 6, 7].map(openCodeMessageId));
    expect(snapshot.complete).toBe(false);
    expect(decodeCursor(snapshot.historyCursor)).toEqual({
      id: openCodeMessageId(4),
      time: 1_001,
    });
  });
});
