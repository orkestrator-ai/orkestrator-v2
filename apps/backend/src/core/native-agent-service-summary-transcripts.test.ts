/**
 * The native projection over a provider that serves lightweight summaries.
 *
 * The provider stub answers with the real protocol helpers a v2 bridge uses,
 * so these tests pin what the backend does with summary windows, remote
 * detail locators and direct history cursors — and, as importantly, which
 * expensive paths it no longer takes: legacy full-transcript reads, joined
 * projection refreshes and interactive snapshots.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  bridgeTranscriptPage,
  bridgeTranscriptPageCursorFor,
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import type {
  ProviderTranscriptDetail,
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import { applyNativeAgentTranscriptDelta } from "@orkestrator/protocol/native-agent";
import { positionedCursorBefore } from "./http-bridge/transcript-v2.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { collaborators, projectionInternals } from "./native-agent-service-test-collaborators.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

function message(id: string, parts: Array<Record<string, unknown>> = []): TestMessage {
  return {
    id,
    role: "assistant",
    content: `message ${id}`,
    parts,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
}

/** A provider that behaves like a v2 bridge over an in-memory history. */
function summaryProvider(
  history: {
    messages: TestMessage[];
    epoch: number;
    revision: number;
    /** Rows the bridge changed recently, newest first. */
    revised?: string[];
  },
  /**
   * `pages: false` is a bridge without page routes; `nameCursors: false` a
   * pageable source that can name no position in its window (only its own
   * `historyCursor`). `generation` sets the bridge generation, whose length
   * sets the length of every cursor.
   */
  bridge: { pages?: boolean; nameCursors?: boolean; generation?: string } = {},
) {
  const generation = bridge.generation ?? "g1";
  // As `historyEpoch` in `http-bridge/transcript-v2.ts` forms it.
  const historyEpoch = () => `${generation.slice(0, 63)}:${history.epoch}`;
  const transcriptSnapshot = async (
    _sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> => {
    const update = bridgeTranscriptSummaryUpdate(history.messages, {
      sessionIdentity: "provider-session",
      generation,
      contentEpoch: history.epoch,
      revision: history.revision,
      limit: options.limit,
      targetBytes: options.targetBytes,
      complete: true,
      pages: bridge.pages ?? true,
      ...(history.revised ? { revisedMessageIds: history.revised } : {}),
      ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
    });
    if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
    return {
      messages: update.value.messages,
      historyStartIndex: update.value.startIndex,
      sourceToken: update.token,
      complete: update.value.complete,
      generation,
      historyEpoch: historyEpoch(),
      freshness: "current",
      representation: "summary",
      historyPageable: bridge.pages ?? true,
      ...(update.value.historyCursor ? { historyCursor: update.value.historyCursor } : {}),
      // As `positionCursors` in `http-bridge/transcript-v2.ts` names them.
      ...((bridge.pages ?? true) && bridge.nameCursors !== false
        ? (() => {
            const cursorAt = (position: number) =>
              bridgeTranscriptPageCursorFor(generation, history.epoch, position);
            const atEnd = cursorAt(update.value.startIndex + update.value.messages.length);
            return {
              historyCursorBefore: positionedCursorBefore(
                update.value.messages,
                update.value.startIndex,
                cursorAt,
              ),
              ...(atEnd ? { historyCursorAtEnd: atEnd } : {}),
            };
          })()
        : {}),
      ...(update.value.revisedMessages ? { revisedMessages: update.value.revisedMessages } : {}),
      ...(update.value.historyReconciliationToken
        ? { historyReconciliationToken: update.value.historyReconciliationToken }
        : {}),
    };
  };
  const transcriptDetail = async (
    _sessionId: string,
    locator: string,
  ): Promise<ProviderTranscriptDetail | undefined> => {
    const result = readBridgeTranscriptDetail(history.messages, locator);
    if (result.status === "ok") return { status: "ok", detail: result.detail };
    if (result.status === "invalid") throw new Error("invalid locator");
    return { status: result.status };
  };
  const transcriptPage = async (
    _sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage | undefined> => {
    const page = bridgeTranscriptPage(history.messages, {
      generation,
      contentEpoch: history.epoch,
      complete: true,
      ...options,
    });
    if (page.status !== "page") return { status: "expired" };
    return {
      status: "page",
      messages: page.messages,
      historyStartIndex: page.startIndex,
      ...(page.nextCursor ? { historyCursor: page.nextCursor } : {}),
      complete: page.complete,
      truncated: page.truncated,
      historyEpoch: historyEpoch(),
      representation: "summary",
    };
  };
  const legacyMessages = mock(async () => history.messages);
  const interactiveSnapshot = mock(async () => {
    throw new Error("a summary read must not take the joined projection path");
  });
  const stub = createProviderStub("codex", {
    transcriptSnapshot,
    transcriptDetail,
    transcriptPage,
    messages: legacyMessages,
    interactiveSnapshot,
  });
  return { stub, legacyMessages, interactiveSnapshot };
}

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:summaries",
};

describe("summary transcripts", () => {
  test("a large tool body stays behind a remote reference until expanded", async () => {
    const output = "o".repeat(300 * 1024);
    const history = {
      messages: [
        { ...message("prompt"), role: "user" as const },
        message("m1", [
          {
            type: "tool-invocation",
            content: "Read",
            sourcePartId: "m1:0",
            toolUseId: "call-1",
            toolOutput: output,
            toolState: "success",
          },
        ]),
      ],
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-details-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const part = (update.value.messages[1] as TestMessage).parts[0]!;
        expect(part.toolOutput).toBeUndefined();
        expect(part.detail).toBeUndefined();
        expect(typeof part.detailRef).toBe("string");
        expect(stub.transcriptDetail).not.toHaveBeenCalled();

        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: part.detailRef as string,
        });
        expect(details.toolOutput).toBe(output);
        expect(stub.transcriptDetail).toHaveBeenCalledTimes(1);
        // A second expansion is served from the backend's bounded cache.
        await service.getProjectionToolDetails({
          ...identity,
          detailRef: part.detailRef as string,
        });
        expect(stub.transcriptDetail).toHaveBeenCalledTimes(1);

        expect(legacyMessages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test("a reference whose body changed reports it gone rather than serving the new body", async () => {
    const history = {
      messages: [
        message("m1", [
          {
            type: "tool-invocation",
            content: "Run",
            sourcePartId: "m1:0",
            toolUseId: "call-1",
            toolOutput: "a".repeat(10_000),
          },
        ]),
      ],
      epoch: 1,
      revision: 1,
    };
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-expired-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const detailRef = (update.value.messages[0] as TestMessage).parts[0]!.detailRef as string;
        history.messages[0]!.parts[0]!.toolOutput = "b".repeat(10_000);
        await expect(service.getProjectionToolDetails({ ...identity, detailRef })).rejects.toThrow(
          "no longer available",
        );
      },
    );
  });

  test("an incomplete summary window pages directly instead of hydrating the legacy transcript", async () => {
    const history = {
      messages: Array.from({ length: 250 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-pages-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.historyPaging).toBe("direct");
        expect(update.value.messageWindow?.canLoadEarlier).toBe(true);
        let cursor = update.value.historyCursor;
        const seen: string[] = [];
        let pages = 0;
        while (cursor) {
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
            limit: 60,
          });
          expect(page.historyEpoch).toBe(update.value.historyEpoch);
          seen.unshift(...page.messages.map((entry) => (entry as TestMessage).id));
          cursor = page.nextCursor;
          pages += 1;
          if (!cursor) expect(page.complete).toBe(true);
        }
        expect(pages).toBe(3);
        expect(seen).toEqual(history.messages.slice(0, 150).map((entry) => entry.id));
        // Give any stray background hydration a chance to have run.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(legacyMessages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test("a view whose byte bound drops rows the bridge sent pages from the first row it kept", async () => {
    // Calls with tiny outputs: the projection's detail reference is larger
    // than the output the summary kept inline, so the projected window is
    // larger than the bridge measured and its byte bound drops leading rows.
    const history = {
      messages: Array.from({ length: 250 }, (_, index) =>
        message(
          `m${index}`,
          Array.from({ length: 20 }, (_, call) => ({
            type: "tool-invocation",
            content: "Run",
            toolName: "bash",
            toolUseId: `call-${index}-${call}`,
            toolOutput: "ok",
            toolState: "completed",
          })),
        ),
      ).map((row) => ({ ...row, content: "c".repeat(4_000) })),
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-bounded-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const sent = await stub.provider.transcriptSnapshot!("provider-session", {
          limit: liveWindow.messages,
          targetBytes: liveWindow.targetBytes,
        });
        if ("unchanged" in sent) throw new Error("expected a snapshot");
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const ids = update.value.messages.map((entry) => (entry as TestMessage).id);
        // The bound dropped rows the bridge sent; the cursor names the first kept one.
        expect(ids.length).toBeLessThan(sent.messages.length);
        expect(ids[0]).not.toBe((sent.messages[0] as TestMessage).id);
        expect(update.value.historyPaging).toBe("direct");
        expect(update.value.messageWindow?.canLoadEarlier).toBe(true);
        let cursor = update.value.historyCursor;
        let pages = 0;
        while (cursor) {
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
            limit: 60,
          });
          expect(page.historyEpoch).toBe(update.value.historyEpoch);
          ids.unshift(...page.messages.map((entry) => (entry as TestMessage).id));
          cursor = page.nextCursor;
          pages += 1;
          if (!cursor) expect(page.complete).toBe(true);
          expect(pages).toBeLessThan(20);
        }
        // No gap and no repeat: the rows the bound dropped came back first.
        expect(ids).toEqual(history.messages.map((entry) => entry.id));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(legacyMessages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  // Joined paging retired (0232 task 4): the sync-v1 projection names no
  // history cursor, and a v1 cursor an older client still holds is refused
  // without a projection refresh or a page read.
  test("the sync-v1 projection mints no history cursor, and a v1 cursor is refused", async () => {
    const history = {
      messages: Array.from({ length: 250 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub: summaryStub } = summaryProvider(history);
    const interactiveSnapshot = mock(async () => ({
      status: "idle" as const,
      messages: history.messages,
    }));
    const provider = {
      ...summaryStub.provider,
      interactiveSnapshot,
    } as typeof summaryStub.provider;
    await withService(
      { prefix: "orkestrator-summary-sync-", provider: async () => provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update).not.toHaveProperty("historyCursor");
        expect(update).not.toHaveProperty("historyEpoch");
        expect(update).not.toHaveProperty("historyComplete");
        const reads = interactiveSnapshot.mock.calls.length;
        const joinedCursor = Buffer.from(
          JSON.stringify({ v: 1, key: "k", session: "s", epoch: "e", before: "b" }),
        ).toString("base64url");
        await expect(
          service.getMessagePage({ ...identity, syncVersion: 1, before: joinedCursor, limit: 60 }),
        ).rejects.toThrow("Native agent history cursor expired");
        expect(interactiveSnapshot.mock.calls.length).toBe(reads);
        expect(summaryStub.transcriptPage).not.toHaveBeenCalled();
      },
    );
  });

  const shortCalls = (index: number) =>
    Array.from({ length: 20 }, (_, call) => ({
      type: "tool-invocation",
      content: "Run",
      toolName: "bash",
      toolUseId: `call-${index}-${call}`,
      toolOutput: "ok",
      toolState: "completed",
    }));
  // Every real provider pages and names a cursor for its views (8110). For one
  // that could not, nothing older can be loaded: the view offers no cursor and
  // the sync-v1 projection mints none to page through instead.
  for (const [name, rows, options] of [
    ["a source without direct pages", (index: number) => message(`m${index}`), { pages: false }],
    [
      "a pageable source whose bounded view can name no cursor",
      (index: number) => ({
        ...message(`m${index}`, shortCalls(index)),
        content: "c".repeat(4_000),
      }),
      { nameCursors: false },
    ],
  ] as const) {
    test(`a view of ${name} offers no history cursor`, async () => {
      const history = {
        messages: Array.from({ length: 250 }, (_, index) => rows(index)),
        epoch: 1,
        revision: 1,
      };
      const { stub: summaryStub } = summaryProvider(history, options);
      const provider = {
        ...summaryStub.provider,
        interactiveSnapshot: mock(async () => ({
          status: "idle" as const,
          messages: history.messages,
        })),
      } as typeof summaryStub.provider;
      await withService(
        { prefix: "orkestrator-summary-no-cursor-", provider: async () => provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const view = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (view.status !== "snapshot") throw new Error("expected a snapshot");
          // Older history exists, and nothing names a way to it.
          expect(view.value.historyComplete).toBe(false);
          expect(view.value.historyCursor).toBeUndefined();
          expect(view.value.historyPaging).toBeUndefined();
          const update = await service.getProjectionUpdate({
            ...identity,
            syncVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          expect(update).not.toHaveProperty("historyCursor");
          expect(summaryStub.transcriptPage).not.toHaveBeenCalled();
        },
      );
    });
  }

  // The three cases that used to reach joined paging with no direct cursor
  // (8110): each now pages directly from the view, walking back to the first
  // message with no gap, no repeat and no whole read.
  const walkDirectly = async (
    service: {
      getTranscriptUpdate: (input: never) => Promise<unknown>;
      getMessagePage: (input: never) => Promise<unknown>;
    },
    history: { messages: TestMessage[] },
    expectView: (view: {
      messages: unknown[];
      historyCursor?: string;
      historyPaging?: string;
    }) => void,
  ) => {
    const update = (await service.getTranscriptUpdate({
      ...identity,
      viewVersion: 1,
      liveWindow,
      forceSnapshot: true,
    } as never)) as {
      status: string;
      value: {
        messages: unknown[];
        historyCursor?: string;
        historyPaging?: string;
        historyEpoch: string;
        messageWindow?: { canLoadEarlier?: boolean };
      };
    };
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    expectView(update.value);
    expect(update.value.historyPaging).toBe("direct");
    expect(update.value.messageWindow?.canLoadEarlier).toBe(true);
    const held = update.value.messages.map((entry) => (entry as TestMessage).id);
    const ids: string[] = [...held];
    let cursor = update.value.historyCursor;
    let pages = 0;
    while (cursor) {
      const page = (await service.getMessagePage({
        ...identity,
        syncVersion: 1,
        before: cursor,
        limit: 60,
      } as never)) as {
        messages: unknown[];
        historyEpoch: string;
        nextCursor?: string;
        complete: boolean;
      };
      expect(page.historyEpoch).toBe(update.value.historyEpoch);
      // The renderer drops rows it already holds by id.
      const fresh = page.messages
        .map((entry) => (entry as TestMessage).id)
        .filter((id) => !ids.includes(id));
      ids.unshift(...fresh);
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) expect(page.complete).toBe(true);
      expect(pages).toBeLessThan(40);
    }
    expect(ids).toEqual(history.messages.map((entry) => entry.id));
  };

  test("a view at the first message whose projected rows exceed the byte bound pages directly (8110)", async () => {
    // 75 rows fit the bridge's window whole, so it starts at the first message
    // and sends no cursor; projected, they exceed the backend's byte bound.
    const history = {
      messages: Array.from({ length: 75 }, (_, index) => ({
        ...message(`m${index}`, shortCalls(index)),
        content: "c".repeat(4_000),
      })),
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-first-message-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const sent = await stub.provider.transcriptSnapshot!("provider-session", {
          limit: liveWindow.messages,
          targetBytes: liveWindow.targetBytes,
        });
        if ("unchanged" in sent) throw new Error("expected a snapshot");
        expect(sent.historyStartIndex).toBe(0);
        expect(sent.messages).toHaveLength(75);
        expect(sent.historyCursor).toBeUndefined();
        await walkDirectly(service as never, history, (view) => {
          expect(view.messages.length).toBeLessThan(75);
          expect((view.messages[0] as TestMessage).id).not.toBe("m0");
        });
        expect(stub.transcriptPage).toHaveBeenCalled();
        expect(legacyMessages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test("a provider cursor too long to wrap is named by a handle and pages directly (8110)", async () => {
    // A long bridge generation makes every page cursor long enough that the
    // backend's wrapper would exceed the page command's 1,024-character bound.
    const generation = "g".repeat(600);
    const history = {
      messages: Array.from({ length: 250 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history, {
      generation,
    });
    await withService(
      { prefix: "orkestrator-summary-long-cursor-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const sent = await stub.provider.transcriptSnapshot!("provider-session", {
          limit: liveWindow.messages,
          targetBytes: liveWindow.targetBytes,
        });
        if ("unchanged" in sent) throw new Error("expected a snapshot");
        expect(sent.historyCursor!.length).toBeGreaterThan(700);
        await walkDirectly(service as never, history, (view) => {
          expect(view.historyCursor!.length).toBeLessThanOrEqual(1024);
        });
        expect(projectionInternals(service).directHistoryCursorHandles.size).toBeGreaterThan(0);
        expect(legacyMessages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test("a cached page whose continuation handle was evicted mints it again (8110)", async () => {
    const generation = "g".repeat(600);
    const history = {
      messages: Array.from({ length: 250 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub, legacyMessages } = summaryProvider(history, { generation });
    await withService(
      { prefix: "orkestrator-summary-evicted-handle-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const handles = projectionInternals(service).directHistoryCursorHandles;
        // The first walk reads every page from the provider and caches it.
        await walkDirectly(service as never, history, () => undefined);
        const providerReads = stub.transcriptPage!.mock.calls.length;
        expect(providerReads).toBeGreaterThan(1);

        // Another session's cursors push every handle out of the bounded store.
        handles.clear();
        expect(handles.size).toBe(0);

        // A cursor the renderer still holds reads as expired, which it
        // recovers from by re-reading the view.
        const update = (await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        } as never)) as { status: string; value: { historyCursor?: string } };
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const firstPage = (await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: update.value.historyCursor!,
          limit: 60,
        } as never)) as { nextCursor?: string };
        handles.clear();
        await expect(
          service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: firstPage.nextCursor!,
            limit: 60,
          } as never),
        ).rejects.toThrow("Native agent history cursor expired");

        // The fresh view walks the cached pages to the first message: each
        // cached page names its continuation again rather than a dead handle.
        await walkDirectly(service as never, history, () => undefined);
        expect(stub.transcriptPage!.mock.calls.length).toBe(providerReads);
        expect(handles.size).toBeGreaterThan(0);
        expect(legacyMessages).not.toHaveBeenCalled();
      },
    );
  });

  test("a page says when a row was trimmed, which `truncated` alone cannot", async () => {
    const history = {
      messages: Array.from({ length: 250 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub } = summaryProvider(history);
    const pageRows = stub.provider.transcriptPage!.bind(stub.provider);
    let trimNext = false;
    const provider = {
      ...stub.provider,
      transcriptPage: async (...args: Parameters<typeof pageRows>) => {
        const page = await pageRows(...args);
        // A bridge page's own `truncated` reports a row it trimmed.
        return page?.status === "page" && trimNext ? { ...page, truncated: true } : page;
      },
    } as typeof stub.provider;
    await withService(
      { prefix: "orkestrator-summary-trimmed-", provider: async () => provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const first = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: update.value.historyCursor!,
          limit: 60,
        });
        // Older rows remain, so the page is `truncated`, but nothing was trimmed.
        expect(first.nextCursor).toBeDefined();
        expect(first.truncated).toBe(true);
        expect(first.rowsTrimmed).toBeUndefined();
        trimNext = true;
        const second = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: first.nextCursor!,
          limit: 60,
        });
        expect(second.rowsTrimmed).toBe(true);
      },
    );
  });

  test("a direct cursor is refused for another session and after its epoch rotates", async () => {
    const history = {
      messages: Array.from({ length: 150 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
    };
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-cursor-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const other = { ...identity, logicalSessionKey: "env-env-1:other" };
        await service.ensureSession(other);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const before = update.value.historyCursor!;
        await expect(service.getMessagePage({ ...other, syncVersion: 1, before })).rejects.toThrow(
          "expired",
        );
        history.epoch = 2;
        history.revision += 1;
        await expect(
          service.getMessagePage({ ...identity, syncVersion: 1, before }),
        ).rejects.toThrow("expired");
      },
    );
  });
});

describe("revised rows before the window", () => {
  test("are projected like window rows, resolve their details, and deltas mirror them", async () => {
    const output = "late result ".repeat(1_000);
    const history = {
      messages: Array.from({ length: 150 }, (_, index) => message(`m${index}`)),
      epoch: 1,
      revision: 1,
      revised: [] as string[],
    };
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-revised-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const read = (knownToken?: string) =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            ...(knownToken ? { knownToken } : { forceSnapshot: true }),
          });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        expect(first.value.revisedMessages).toBeUndefined();

        // A background tool's result lands on a step long out of the window,
        // and a step inside the window changed too.
        history.messages[10] = message("m10", [
          {
            type: "tool-invocation",
            content: "Run",
            sourcePartId: "m10:0",
            toolUseId: "call-10",
            toolOutput: output,
            toolState: "success",
          },
        ]);
        history.messages[140] = { ...history.messages[140]!, content: "edited" };
        history.revised = ["m140", "m10"];
        history.revision += 1;
        const second = await read(first.token);
        if (second.status !== "delta") throw new Error(`expected a delta, got ${second.status}`);
        const revised = second.delta.revisedMessages as TestMessage[] | undefined;
        // The window row travels in the window; only the one before it is extra.
        expect(revised?.map((entry) => entry.id)).toEqual(["m10"]);
        const part = revised![0]!.parts[0]!;
        expect(part.toolOutput).toBeUndefined();
        expect(part.detail).toBeUndefined();
        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: part.detailRef as string,
        });
        expect(details.toolOutput).toBe(output);
        const view = applyNativeAgentTranscriptDelta(first.value, second.delta);
        if (!view) throw new Error("expected the delta to apply");
        expect(view.revisedMessages).toEqual(revised);

        // Ordinary streaming does not resend unchanged historical revisions.
        history.messages[149] = { ...history.messages[149]!, content: "streamed delta" };
        history.revision += 1;
        const streaming = await read(second.token);
        if (streaming.status !== "delta") throw new Error("expected delta");
        expect(streaming.delta.revisedMessages).toEqual([]);
        expect(Buffer.byteLength(JSON.stringify(streaming.delta))).toBeLessThan(
          Buffer.byteLength(JSON.stringify(second.delta)),
        );

        // Once the bridge stops naming the row, a delta's absence clears it.
        history.revised = [];
        history.revision += 1;
        const third = await read(streaming.token);
        if (third.status !== "delta") throw new Error(`expected a delta, got ${third.status}`);
        expect(third.delta.revisedMessages).toBeUndefined();
        expect(applyNativeAgentTranscriptDelta(view, third.delta)?.revisedMessages).toBeUndefined();
      },
    );
  });
});

describe("revised rows in a joined prefix", () => {
  test("replace the older copy the view joined ahead of the provider's window", async () => {
    const running = (id: string, state: string) =>
      message(id, [
        { type: "tool-invocation", content: "Run", toolUseId: `${id}-call`, toolState: state },
      ]);
    let read = 0;
    const transcriptSnapshot = async (): Promise<ProviderTranscriptSnapshot> => {
      read += 1;
      // The window moves forward by one row, and the row it left behind
      // settles: the provider names it as revised.
      return read === 1
        ? {
            messages: [running("m3", "pending"), message("m4"), message("m5")],
            historyStartIndex: 3,
            complete: false,
            historyEpoch: "g1:1",
            sourceToken: "t1",
            freshness: "current",
          }
        : {
            messages: [message("m4"), message("m5"), message("m6")],
            historyStartIndex: 4,
            complete: false,
            historyEpoch: "g1:1",
            sourceToken: "t2",
            freshness: "current",
            revisedMessages: [running("m3", "success")],
          };
    };
    const stub = createProviderStub("codex", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-summary-revised-join-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        const second = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (second.status !== "snapshot") throw new Error("expected a snapshot");
        const rows = second.value.messages as TestMessage[];
        expect(rows.map((row) => row.id)).toEqual(["m3", "m4", "m5", "m6"]);
        expect(rows[0]!.parts[0]!.toolState).toBe("success");
        // Already in the view, so not sent a second time.
        expect(second.value.revisedMessages).toBeUndefined();
      },
    );
  });
});

describe("remote detail reads", () => {
  function heavyHistory(count: number) {
    return {
      messages: Array.from({ length: count }, (_, index) =>
        message(`m${index}`, [
          {
            type: "tool-invocation",
            content: "Read",
            sourcePartId: `m${index}:0`,
            toolUseId: `call-${index}`,
            toolOutput: String(index).repeat(10_000),
          },
        ]),
      ),
      epoch: 1,
      revision: 1,
    };
  }

  test("concurrent expansions of one row share a single provider read", async () => {
    const history = heavyHistory(1);
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-shared-detail-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const detailRef = (update.value.messages[0] as TestMessage).parts[0]!.detailRef as string;
        const [first, second] = await Promise.all([
          service.getProjectionToolDetails({ ...identity, detailRef }),
          service.getProjectionToolDetails({ ...identity, detailRef }),
        ]);
        expect(first.toolOutput).toBe(second.toolOutput);
        expect(stub.transcriptDetail).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("an entry evicted while its read is in flight is not removed or un-counted again", async () => {
    const history = heavyHistory(6);
    const { stub } = summaryProvider(history);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      ...stub.provider,
      transcriptDetail: async () => {
        await gate;
        return { status: "expired" as const };
      },
    } as typeof stub.provider;
    await withService(
      {
        prefix: "orkestrator-summary-evicted-detail-",
        provider: async () => provider,
        toolDetailCacheMaxEntries: 3,
      },
      async ({ service }) => {
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        // With room for three references, m3 is the oldest one still cached.
        const detailRef = (first.value.messages[3] as TestMessage).parts[0]!.detailRef as string;
        const pending = service.getProjectionToolDetails({ ...identity, detailRef });
        // New bodies for m0–m2 mint new references ahead of m3, evicting it.
        for (let index = 0; index < 3; index += 1) {
          history.messages[index]!.parts[0]!.toolOutput = `changed ${index}`.repeat(1_000);
        }
        history.revision += 1;
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        release!();
        await expect(pending).rejects.toThrow("no longer available");
        const cache = projectionInternals(service);
        const counted = Array.from(cache.toolDetailCache.values()).reduce(
          (total, entry) => total + entry.bytes,
          0,
        );
        expect(cache.toolDetailCacheBytes()).toBe(counted);
        // The row was re-registered by the newer read; the stale read's
        // failure must not remove that fresh reference.
        expect(cache.toolDetailCache.has(detailRef)).toBe(true);
      },
    );
  });

  /*
   * An evicted provider-held reference (0110). A raw `sync-v1` refresh cannot
   * rebuild one, and the summary provider here throws on that path, so each
   * test also proves no raw transcript read was made.
   */
  describe("after eviction", () => {
    async function liveView(service: { getTranscriptUpdate: (input: never) => Promise<unknown> }) {
      const update = (await service.getTranscriptUpdate({
        ...identity,
        viewVersion: 1,
        liveWindow,
        forceSnapshot: true,
      } as never)) as {
        status: string;
        value: { messages: TestMessage[]; historyCursor?: string };
      };
      if (update.status !== "snapshot") throw new Error("expected a snapshot");
      return update.value;
    }

    test("remote references are told apart from inline ones", async () => {
      const history = heavyHistory(1);
      history.messages[0]!.parts.push({
        type: "tool-invocation",
        content: "Run",
        sourcePartId: "m0:1",
        toolUseId: "call-small",
        toolOutput: "short",
      });
      const { stub } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-ref-kinds-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const [remote, inline] = (await liveView(service)).messages[0]!.parts;
          expect(remote!.detailRef).toMatch(/^r[0-9a-f]{32}$/);
          expect(inline!.detailRef).toMatch(/^[0-9a-f]{32}$/);
        },
      );
    });

    test("a row in the live window is registered again from the row cache, with no read", async () => {
      const history = heavyHistory(3);
      const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-evicted-live-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const detailRef = (await liveView(service)).messages[1]!.parts[0]!.detailRef as string;
          projectionInternals(service).evictToolDetails();
          const reads = stub.transcriptSnapshot!.mock.calls.length;
          const details = await service.getProjectionToolDetails({ ...identity, detailRef });
          expect(details.toolOutput).toBe(history.messages[1]!.parts[0]!.toolOutput as string);
          expect(stub.transcriptSnapshot!.mock.calls.length).toBe(reads);
          expect(legacyMessages).not.toHaveBeenCalled();
          expect(interactiveSnapshot).not.toHaveBeenCalled();
        },
      );
    });

    test("a row of a cached page is registered again from the page cache", async () => {
      const history = heavyHistory(250);
      const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-evicted-page-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const before = (await liveView(service)).historyCursor!;
          const page = await service.getMessagePage({ ...identity, syncVersion: 1, before });
          const row = page.messages[10] as TestMessage;
          const internals = projectionInternals(service);
          internals.evictToolDetails();
          internals.projectedMessages.clear();
          const reads = stub.transcriptSnapshot!.mock.calls.length;
          const details = await service.getProjectionToolDetails({
            ...identity,
            detailRef: row.parts[0]!.detailRef as string,
          });
          expect(details.toolOutput).toBe(
            history.messages.find((entry) => entry.id === row.id)!.parts[0]!.toolOutput as string,
          );
          expect(stub.transcriptSnapshot!.mock.calls.length).toBe(reads);
          expect(legacyMessages).not.toHaveBeenCalled();
          expect(interactiveSnapshot).not.toHaveBeenCalled();
        },
      );
    });

    test("with nothing kept, a summary read of the live window recreates it", async () => {
      const history = heavyHistory(3);
      const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-evicted-reread-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const detailRef = (await liveView(service)).messages[2]!.parts[0]!.detailRef as string;
          const internals = projectionInternals(service);
          internals.evictToolDetails();
          internals.projectedMessages.clear();
          const reads = stub.transcriptSnapshot!.mock.calls.length;
          const details = await service.getProjectionToolDetails({ ...identity, detailRef });
          expect(details.toolOutput).toBe(history.messages[2]!.parts[0]!.toolOutput as string);
          // One summary read, with the window the view was read with.
          expect(stub.transcriptSnapshot!.mock.calls.length).toBe(reads + 1);
          expect(stub.transcriptSnapshot!.mock.calls.at(-1)![1]).toMatchObject({
            limit: liveWindow.messages,
            targetBytes: liveWindow.targetBytes,
            representation: "summary",
          });
          expect(stub.transcriptSnapshot!.mock.calls.at(-1)![1]!.knownSourceToken).toBeUndefined();
          const sourceToken = stub.transcriptSnapshot!.mock.calls[0]![1]!.knownSourceToken;
          expect(sourceToken).toBeUndefined();
          await liveView(service);
          const restoredToken = stub.transcriptSnapshot!.mock.calls.at(-1)![1]!.knownSourceToken;
          expect(restoredToken).toEqual(expect.any(String));
          await liveView(service);
          expect(stub.transcriptSnapshot!.mock.calls.at(-1)![1]!.knownSourceToken).toBe(
            restoredToken,
          );
          expect(legacyMessages).not.toHaveBeenCalled();
          expect(interactiveSnapshot).not.toHaveBeenCalled();
        },
      );
    });

    test("recovery waits for an in-flight conditional poll, then reads fresh summaries", async () => {
      const history = heavyHistory(3);
      const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-evicted-pending-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const detailRef = (await liveView(service)).messages[2]!.parts[0]!.detailRef as string;
          const snapshot = stub.transcriptSnapshot!;
          const original = snapshot.getMockImplementation()!;
          let release!: () => void;
          let started!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entered = new Promise<void>((resolve) => {
            started = resolve;
          });
          snapshot.mockImplementationOnce(async (...args) => {
            expect(args[1]!.knownSourceToken).toEqual(expect.any(String));
            const result = await original(...args);
            expect(result).toMatchObject({ unchanged: true });
            started();
            await gate;
            return result;
          });
          const poll = liveView(service);
          await entered;
          const internals = projectionInternals(service);
          internals.evictToolDetails();
          internals.projectedMessages.clear();
          const expansion = service.getProjectionToolDetails({ ...identity, detailRef });
          release();
          await poll;
          expect((await expansion).toolOutput).toBe(
            history.messages[2]!.parts[0]!.toolOutput as string,
          );
          expect(snapshot.mock.calls).toHaveLength(3);
          expect(snapshot.mock.calls[2]![1]!.knownSourceToken).toBeUndefined();
          await liveView(service);
          expect(snapshot.mock.calls.at(-1)![1]!.knownSourceToken).toEqual(expect.any(String));
          expect(legacyMessages).not.toHaveBeenCalled();
          expect(interactiveSnapshot).not.toHaveBeenCalled();
        },
      );
    });

    test("an older row held nowhere asks for a reload, without a raw read", async () => {
      const history = heavyHistory(250);
      const { stub, legacyMessages, interactiveSnapshot } = summaryProvider(history);
      await withService(
        { prefix: "orkestrator-summary-evicted-gone-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const before = (await liveView(service)).historyCursor!;
          const page = await service.getMessagePage({ ...identity, syncVersion: 1, before });
          const detailRef = (page.messages[10] as TestMessage).parts[0]!.detailRef as string;
          const internals = projectionInternals(service);
          internals.evictToolDetails();
          internals.projectedMessages.clear();
          internals.directHistoryPages.clear();
          await expect(
            service.getProjectionToolDetails({ ...identity, detailRef }),
          ).rejects.toThrow("Reload the conversation");
          expect(legacyMessages).not.toHaveBeenCalled();
          expect(interactiveSnapshot).not.toHaveBeenCalled();
          // Loading the page again makes it resolvable, as the message says.
          const again = await service.getMessagePage({ ...identity, syncVersion: 1, before });
          const ref = (again.messages[10] as TestMessage).parts[0]!.detailRef as string;
          expect(ref).toBe(detailRef);
          expect(
            (await service.getProjectionToolDetails({ ...identity, detailRef })).toolOutput,
          ).toBe(
            history.messages.find((entry) => entry.id === (again.messages[10] as TestMessage).id)!
              .parts[0]!.toolOutput as string,
          );
        },
      );
    });
  });
});

describe("direct history page cache", () => {
  function pagedHistory(count: number) {
    return {
      messages: Array.from({ length: count }, (_, index) =>
        message(`m${index}`, [
          {
            type: "tool-invocation",
            content: "Read",
            sourcePartId: `m${index}:0`,
            toolUseId: `call-${index}`,
            toolOutput: String(index % 10).repeat(10_000),
          },
        ]),
      ),
      epoch: 1,
      revision: 1,
    };
  }

  const sessionKeyOf = () =>
    nativeAgentSessionStorageKey(
      identity.environmentId,
      identity.agent,
      identity.logicalSessionKey,
    );

  async function firstCursor(service: {
    getTranscriptUpdate: (input: never) => Promise<unknown>;
  }): Promise<string> {
    const update = (await service.getTranscriptUpdate({
      ...identity,
      viewVersion: 1,
      liveWindow,
      forceSnapshot: true,
    } as never)) as { status: string; value: { historyCursor?: string } };
    if (update.status !== "snapshot" || !update.value.historyCursor) {
      throw new Error("expected a snapshot with a direct cursor");
    }
    return update.value.historyCursor;
  }

  test("a repeated page is served from memory, and its detail references still resolve", async () => {
    const history = pagedHistory(250);
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-page-cache-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const before = await firstCursor(service);
        const first = await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(1);
        // Even with every detail reference evicted, the cached page is served
        // and re-registers the provider-held references it carries.
        projectionInternals(service).toolDetailCache.clear();
        const second = await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        const row = second.messages[10] as TestMessage;
        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: row.parts[0]!.detailRef as string,
        });
        expect(details.toolOutput).toBe(
          history.messages.find((entry) => entry.id === row.id)!.parts[0]!.toolOutput as string,
        );
      },
    );
  });

  test("an observed epoch change or a session invalidation drops cached pages", async () => {
    const history = pagedHistory(250);
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-page-epoch-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const before = await firstCursor(service);
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        // A rewind (session action) invalidates the session's pages.
        collaborators(service).projections.invalidateProjection(sessionKeyOf());
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(2);

        // The provider rotates its epoch; the next live read observes it, so
        // the old cursor goes back to the provider and is refused there.
        history.epoch = 2;
        history.revision += 1;
        await firstCursor(service);
        await expect(
          service.getMessagePage({ ...identity, syncVersion: 1, before }),
        ).rejects.toThrow("expired");
        expect(stub.transcriptPage).toHaveBeenCalledTimes(3);
      },
    );
  });

  test("a row revised since a page was cached is read again, not served stale", async () => {
    const history = { ...pagedHistory(250), revised: [] as string[] };
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-page-revised-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const before = await firstCursor(service);
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        // An unchanged revised list keeps the cache.
        await firstCursor(service);
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(1);

        history.messages[2] = message("m2", [{ type: "text", content: "settled late" }]);
        history.revised = ["m2"];
        history.revision += 1;
        await firstCursor(service);
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(2);
        // Named again unchanged, it does not drop the cache a second time.
        history.revision += 1;
        await firstCursor(service);
        await service.getMessagePage({ ...identity, syncVersion: 1, before });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("two concurrent readers of one page share a single provider read", async () => {
    const history = pagedHistory(250);
    const { stub } = summaryProvider(history);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const provider = {
      ...stub.provider,
      transcriptPage: async (...args: Parameters<NonNullable<typeof stub.transcriptPage>>) => {
        reads += 1;
        await gate;
        return stub.transcriptPage!(...args);
      },
    } as typeof stub.provider;
    await withService(
      { prefix: "orkestrator-summary-page-shared-", provider: async () => provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const before = await firstCursor(service);
        const first = service.getMessagePage({ ...identity, syncVersion: 1, before });
        const second = service.getMessagePage({ ...identity, syncVersion: 1, before });
        while (reads === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setTimeout(resolve, 5));
        release!();
        const [a, b] = await Promise.all([first, second]);
        expect(reads).toBe(1);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        // Each caller owns its message array.
        expect(a.messages).not.toBe(b.messages);
      },
    );
  });

  test("byte-limited pages advance, and a second walk is served entirely from memory", async () => {
    const history = pagedHistory(160);
    const { stub } = summaryProvider(history);
    await withService(
      { prefix: "orkestrator-summary-page-bytes-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const start = await firstCursor(service);
        const walk = async () => {
          const ids: string[] = [];
          let cursor: string | undefined = start;
          let pages = 0;
          while (cursor) {
            const page = await service.getMessagePage({
              ...identity,
              syncVersion: 1,
              before: cursor,
              limit: 50,
              targetBytes: 4 * 1024,
            });
            expect(page.messages.length).toBeGreaterThan(0);
            expect(page.messages.length).toBeLessThan(50);
            ids.unshift(...page.messages.map((entry) => (entry as TestMessage).id));
            cursor = page.nextCursor;
            pages += 1;
          }
          return { ids, pages };
        };
        const cold = await walk();
        expect(cold.ids).toEqual(history.messages.slice(0, 60).map((entry) => entry.id));
        const coldReads = stub.transcriptPage!.mock.calls.length;
        expect(coldReads).toBe(cold.pages);
        const warm = await walk();
        expect(warm).toEqual(cold);
        expect(stub.transcriptPage!.mock.calls.length).toBe(coldReads);
        // A different byte target is a different page.
        await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: start,
          limit: 50,
          targetBytes: 8 * 1024,
        });
        expect(stub.transcriptPage!.mock.calls.length).toBe(coldReads + 1);
      },
    );
  });

  test("pages evict under the byte bound and are read again", async () => {
    const history = pagedHistory(250);
    const { stub } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-summary-page-evict-",
        provider: async () => stub.provider,
        // Room for one ~60-row page only.
        directHistoryPageCacheLimits: { maxBytes: 40 * 1024 },
      },
      async ({ service }) => {
        await service.ensureSession(identity);
        const before = await firstCursor(service);
        const first = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before,
          limit: 60,
        });
        await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: first.nextCursor!,
          limit: 60,
        });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(2);
        await service.getMessagePage({ ...identity, syncVersion: 1, before, limit: 60 });
        expect(stub.transcriptPage).toHaveBeenCalledTimes(3);
        const cache = projectionInternals(service).directHistoryPages;
        expect(cache.size).toBe(1);
        expect(cache.bytes).toBeLessThanOrEqual(40 * 1024);
      },
    );
  });
});

test("a revised row exceeding the projection budget is skipped whole and signals paging recovery", async () => {
  const huge = message(
    "old-huge",
    Array.from({ length: 100 }, (_, index) => ({
      type: "text",
      content: `${index}:${"x".repeat(4 * 1024)}`,
    })),
  );
  const tail = message("tail");
  const stub = createProviderStub("codex", {
    transcriptSnapshot: async () => ({
      messages: [tail],
      complete: false,
      historyEpoch: "e1",
      revision: 1,
      revisedMessages: [huge],
    }),
  });
  await withService(
    { prefix: "orkestrator-revised-oversized-", provider: async () => stub.provider },
    async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "tab-1",
      };
      await service.ensureSession(identity);
      const update = await service.getTranscriptUpdate({
        ...identity,
        viewVersion: 1,
        liveWindow,
        forceSnapshot: true,
      });
      if (update.status !== "snapshot") throw new Error("expected snapshot");
      expect(update.value.revisedMessages).toBeUndefined();
      expect(update.value.historyReconciliationToken).toBeDefined();
      expect(update.value.messages.map((row) => (row as TestMessage).id)).toEqual(["tail"]);
    },
  );
});

test("a missed-revision delta supplies authoritative live ids for inactive remounts", async () => {
  const history = {
    messages: Array.from({ length: 150 }, (_, i) => message(`m${i}`)),
    epoch: 1,
    revision: 1,
    revised: [] as string[],
  };
  const { stub } = summaryProvider(history);
  await withService(
    { prefix: "orkestrator-revision-overflow-", provider: async () => stub.provider },
    async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "tab-1",
      };
      await service.ensureSession(identity);
      const first = await service.getTranscriptUpdate({
        ...identity,
        viewVersion: 1,
        liveWindow,
        forceSnapshot: true,
      });
      if (first.status !== "snapshot") throw new Error("expected snapshot");
      for (let i = 0; i < 40; i++)
        history.messages[i] = { ...history.messages[i]!, content: "late revision" };
      history.revised = Array.from({ length: 40 }, (_, i) => `m${i}`);
      history.revision++;
      const next = await service.getTranscriptUpdate({
        ...identity,
        viewVersion: 1,
        liveWindow,
        knownToken: first.token,
      });
      if (next.status !== "delta") throw new Error("expected delta");
      expect(next.delta.historyReconciliationToken).toBeDefined();
      expect(next.delta.liveMessageIds).toEqual(
        first.value.messages.map((row) => (row as TestMessage).id),
      );
    },
  );
});
