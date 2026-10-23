/**
 * "Load earlier" over OpenCode, through the native projection.
 *
 * OpenCode records each agent-loop step as its own message, so a long turn
 * outgrows the live window by itself. Its snapshot carries inline bodies and
 * no absolute positions, but names an OpenCode `before` cursor; these tests
 * pin that the progressive view turns it into a direct cursor and that pages
 * walk back to the session's first message — without the joined projection or
 * a legacy full read, which only ever see OpenCode's newest messages.
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  NativeAgentTranscriptDelta,
  NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import { openCodeHistoryServer } from "./opencode-history-test-support.js";
import { openCodeTranscriptPage, openCodeTranscriptSnapshot } from "./opencode-snapshots.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:opencode-history",
};

function openCodeProviderStub(server: ReturnType<typeof openCodeHistoryServer>) {
  const history = { epoch: 1, revision: 1 };
  const messages = mock(async () => {
    throw new Error("a paged OpenCode view must not take the legacy read");
  });
  const interactiveSnapshot = mock(async () => {
    throw new Error("a paged OpenCode view must not take the joined projection path");
  });
  const stub = createProviderStub("opencode", {
    transcriptSnapshot: async (_sessionId, options) =>
      openCodeTranscriptSnapshot(
        {
          revision: () => history.revision,
          currentMessages: () => undefined,
          currentMessagesFromStart: () => false,
          historyEpoch: () => `opencode:test:${history.epoch}`,
          readMessages: async (limit) => server.read(limit),
          replaceMessages: () => undefined,
          title: () => undefined,
          recordUnknown: () => undefined,
        },
        options,
      ),
    transcriptPage: async (_sessionId, options) =>
      openCodeTranscriptPage(
        {
          historyEpoch: () => `opencode:test:${history.epoch}`,
          readMessages: async (limit, before) => server.read(limit, before),
          recordUnknown: () => undefined,
        },
        options,
      ),
    messages,
    interactiveSnapshot,
  });
  return { stub, history, messages, interactiveSnapshot };
}

describe("OpenCode history through the native projection", () => {
  test("a long turn's early steps page back directly to the first message", async () => {
    const server = openCodeHistoryServer(260);
    // An early step's tool output is inline; its page must still register it.
    const early = server.messages[7]!;
    early.parts.push({
      id: "tool-early",
      messageID: early.info.id,
      type: "tool",
      tool: "bash",
      callID: "call-early",
      state: { status: "completed", input: {}, output: "early output", title: "run" },
    });
    const { stub, messages, interactiveSnapshot } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-", provider: async () => stub.provider },
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
        expect(update.value.historyComplete).toBe(false);
        expect(update.value.messageWindow?.canLoadEarlier).toBe(true);

        const ids = update.value.messages.map((entry) => (entry as { id: string }).id);
        let cursor = update.value.historyCursor;
        let pages = 0;
        let earlyPart: Record<string, unknown> | undefined;
        while (cursor) {
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
            limit: 60,
          });
          expect(page.historyEpoch).toBe(update.value.historyEpoch);
          for (const entry of page.messages as Array<{ id: string; parts: unknown[] }>) {
            if (entry.id === early.info.id) {
              earlyPart = entry.parts.find(
                (part) => (part as { toolName?: unknown }).toolName === "bash",
              ) as Record<string, unknown>;
            }
          }
          ids.unshift(...page.messages.map((entry) => (entry as { id: string }).id));
          cursor = page.nextCursor;
          pages += 1;
          if (!cursor) expect(page.complete).toBe(true);
          expect(pages).toBeLessThan(20);
        }
        expect(ids).toEqual(server.messages.map((message) => message.info.id));
        expect(new Set(ids).size).toBe(ids.length);

        expect(earlyPart?.toolOutput).toBeUndefined();
        expect(typeof earlyPart?.detailRef).toBe("string");
        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: earlyPart!.detailRef as string,
        });
        expect(details.toolOutput).toBe("early output");

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(messages).not.toHaveBeenCalled();
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test("tool-dense steps keep the cursor: the window and pages fit their byte bounds", async () => {
    // Many small tool calls a step: the references projection puts in place of
    // their output are a large share of each row, so a measure that ignored
    // them would overfill the window and the live view would drop its head.
    const server = openCodeHistoryServer(120, (index) => `${index}:`.padEnd(2_000, "x"));
    for (const message of server.messages) {
      for (let call = 0; call < 40; call += 1) {
        message.parts.push({
          id: `tool-${message.info.id}-${call}`,
          messageID: message.info.id,
          type: "tool",
          tool: "read",
          callID: `call-${message.info.id}-${call}`,
          state: { status: "completed", input: {}, output: "o".repeat(2_000), title: "read" },
        });
      }
    }
    const { stub } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-bytes-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.messages.length).toBeLessThan(120);
        expect(update.value.historyPaging).toBe("direct");
        const ids = update.value.messages.map((entry) => (entry as { id: string }).id);
        let cursor = update.value.historyCursor;
        while (cursor) {
          const targetBytes = 256 * 1024;
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
            targetBytes,
          });
          // A reader trims a page over its budget from the old end, stranding
          // those rows behind the next cursor.
          expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(targetBytes);
          ids.unshift(...page.messages.map((entry) => (entry as { id: string }).id));
          cursor = page.nextCursor;
        }
        expect(ids).toEqual(server.messages.map((message) => message.info.id));
      },
    );
  });

  test("a session that fits the window offers no history to load", async () => {
    const server = openCodeHistoryServer(20);
    const { stub } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-short-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.messages).toHaveLength(20);
        expect(update.value.historyComplete).toBe(true);
        expect(update.value.historyCursor).toBeUndefined();
        expect(update.value.messageWindow?.canLoadEarlier ?? false).toBe(false);
      },
    );
  });

  test("a removed message rotates the epoch and expires cursors into the old history", async () => {
    const server = openCodeHistoryServer(150);
    const { stub, history } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-epoch-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const before = update.value.historyCursor!;
        // Cached under the epoch it was read in.
        await service.getMessagePage({ ...identity, syncVersion: 1, before });

        const removed = server.messages[3]!.info.id;
        server.remove(removed);
        history.epoch += 1;
        history.revision += 1;
        const fresh = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (fresh.status !== "snapshot") throw new Error("expected a snapshot");
        expect(fresh.value.historyEpoch).not.toBe(update.value.historyEpoch);
        // Observing the new epoch dropped the cached page; OpenCode's own read
        // now answers in the new epoch, which the old cursor does not name.
        await expect(
          service.getMessagePage({ ...identity, syncVersion: 1, before }),
        ).rejects.toThrow("expired");

        const page = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: fresh.value.historyCursor!,
        });
        const ids = page.messages.map((entry) => (entry as { id: string }).id);
        expect(ids).toHaveLength(49);
        expect(ids).not.toContain(removed);
        expect(page.complete).toBe(true);
      },
    );
  });
  /** Walks "load earlier" from a fresh snapshot to the session's first message. */
  async function walkHistory(
    service: Parameters<Parameters<typeof withService>[1]>[0]["service"],
    targetBytes?: number,
  ) {
    const update = await service.getTranscriptUpdate({
      ...identity,
      viewVersion: 1,
      liveWindow,
      forceSnapshot: true,
    });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    const ids = update.value.messages.map((entry) => (entry as { id: string }).id);
    const pages: Array<{ messages: unknown[]; truncated: boolean }> = [];
    let cursor = update.value.historyCursor;
    while (cursor) {
      const page = await service.getMessagePage({
        ...identity,
        syncVersion: 1,
        before: cursor,
        ...(targetBytes ? { targetBytes } : {}),
      });
      ids.unshift(...page.messages.map((entry) => (entry as { id: string }).id));
      pages.push(page);
      cursor = page.nextCursor;
      expect(pages.length).toBeLessThan(40);
    }
    return { update, ids: [...new Set(ids)], pages };
  }

  function attachPdf(
    message: { info: { id: string }; parts: Array<Record<string, unknown>> },
    bytes: number,
  ) {
    message.parts.unshift({
      id: `file-${message.info.id}`,
      messageID: message.info.id,
      type: "file",
      mime: "application/pdf",
      filename: "spec.pdf",
      url: `data:application/pdf;base64,${"p".repeat(bytes)}`,
    });
  }

  test("an inline PDF near the end of a session leaves the history before it pageable", async () => {
    const server = openCodeHistoryServer(150);
    attachPdf(server.messages[140]!, 600 * 1024);
    const { stub } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-pdf-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const { update, ids } = await walkHistory(service);
        expect(update.value.historyPaging).toBe("direct");
        expect(update.value.messageWindow?.canLoadEarlier).toBe(true);
        expect(ids).toEqual(server.messages.map((message) => message.info.id));
      },
    );
  });

  test("a page reaching a row larger than any page still walks on to the first message", async () => {
    const server = openCodeHistoryServer(300);
    // A failed step renders as its row plus an error row: one page group whose
    // first row alone is over every page bound.
    const failed = server.messages[51]!;
    attachPdf(failed, 5 * 1024 * 1024);
    failed.info.error = { name: "ProviderError", data: { message: "upstream failed" } };
    const { stub } = openCodeProviderStub(server);
    await withService(
      { prefix: "orkestrator-opencode-history-huge-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const { ids, pages } = await walkHistory(service, 1024 * 1024);
        expect(ids.filter((id) => id.startsWith("msg_"))).toEqual(
          server.messages.map((message) => message.info.id),
        );
        const huge = pages.find((page) =>
          page.messages.some((entry) => (entry as { id: string }).id === failed.info.id),
        )!;
        // Sent with its error row and trimmed on its own, rather than refused
        // on every attempt.
        expect(huge.messages.map((entry) => (entry as { id: string }).id)).toEqual([
          failed.info.id,
          `error-opencode-${failed.info.id}`,
        ]);
        expect(huge.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(huge.messages))).toBeLessThan(5 * 1024 * 1024);
      },
    );
  });

  test("rows that leave a provider-trimmed window are not reported as deletions", async () => {
    const { stub } = openCodeProviderStub(openCodeHistoryServer(1));
    await withService(
      { prefix: "orkestrator-opencode-history-delta-", provider: async () => stub.provider },
      async ({ service }) => {
        const row = (id: string) => ({
          id,
          role: "assistant",
          content: id,
          parts: [],
          createdAt: "2026-10-14T00:00:00.000Z",
        });
        const view = (ids: string[]): NativeAgentTranscriptView => ({
          identity: {} as NativeAgentTranscriptView["identity"],
          freshness: "current",
          messages: ids.map(row),
          // OpenCode trimmed its own window: nothing was omitted locally.
          messageWindow: { limit: 100, truncated: false },
          historyCursor: "cursor",
          historyPaging: "direct",
          historyEpoch: "epoch",
          historyComplete: false,
        });
        const delta = projectionInternals(service).transcriptDelta(
          view(["a", "b"]),
          view(["c", "d"]),
        );
        expect(delta.deletedMessageIds).toEqual([]);
      },
    );
  });

  test("a cursor the view could not use does not stop exact recovery", async () => {
    const server = openCodeHistoryServer(30);
    const fuller = mock(async () =>
      server.messages.slice(-5).map((message) => ({
        id: message.info.id,
        role: "assistant",
        content: "recovered",
        parts: [],
        createdAt: "2026-10-14T00:00:00.000Z",
      })),
    );
    const stub = createProviderStub("opencode", {
      // A window the projection cannot hold as given: one row it rejects.
      transcriptSnapshot: async () => ({
        messages: [{ id: "broken", role: "assistant", content: "x", parts: [] }],
        complete: false,
        freshness: "current",
        historyEpoch: "opencode:test:1",
        historyCursor: Buffer.from(
          JSON.stringify({ id: server.messages[25]!.info.id, time: 1_008 }),
        ).toString("base64url"),
        sourceToken: "token-1",
      }),
      messages: fuller,
    });
    await withService(
      { prefix: "orkestrator-opencode-history-unadopted-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const read = () =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
        expect(await read()).toMatchObject({ status: "unavailable" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fuller).toHaveBeenCalled();
        const recovered = await read();
        if (recovered.status !== "snapshot") throw new Error("expected the recovered transcript");
        expect(recovered.value.messages).toHaveLength(5);
      },
    );
  });
});
