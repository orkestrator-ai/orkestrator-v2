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
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/bridge-transcript-summary";
import type {
  ProviderTranscriptDetail,
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

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
function summaryProvider(history: { messages: TestMessage[]; epoch: number; revision: number }) {
  const generation = "g1";
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
      pages: true,
      ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
    });
    if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
    return {
      messages: update.value.messages,
      historyStartIndex: update.value.startIndex,
      sourceToken: update.token,
      complete: update.value.complete,
      generation,
      historyEpoch: `${generation}:${history.epoch}`,
      freshness: "current",
      representation: "summary",
      ...(update.value.historyCursor ? { historyCursor: update.value.historyCursor } : {}),
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
      historyEpoch: `${generation}:${history.epoch}`,
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
        const cache = service as unknown as {
          toolDetailCache: Map<string, { bytes: number }>;
          toolDetailCacheBytes: number;
        };
        const counted = Array.from(cache.toolDetailCache.values()).reduce(
          (total, entry) => total + entry.bytes,
          0,
        );
        expect(cache.toolDetailCacheBytes).toBe(counted);
        // The row was re-registered by the newer read; the stale read's
        // failure must not remove that fresh reference.
        expect(cache.toolDetailCache.has(detailRef)).toBe(true);
      },
    );
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
        (service as unknown as { toolDetailCache: Map<string, unknown> }).toolDetailCache.clear();
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
        (service as unknown as { invalidateProjection(key: string): void }).invalidateProjection(
          sessionKeyOf(),
        );
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
        const cache = (
          service as unknown as { directHistoryPages: { bytes: number; size: number } }
        ).directHistoryPages;
        expect(cache.size).toBe(1);
        expect(cache.bytes).toBeLessThanOrEqual(40 * 1024);
      },
    );
  });
});
