import { describe, expect, mock, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:history-boundaries",
};
const liveWindow = { messages: 100, targetBytes: 2_000 };

function row(id: string, bytes = 0) {
  return {
    id,
    role: "assistant" as const,
    content: id + "x".repeat(bytes),
    parts: [] as unknown[],
    createdAt: "2026-10-27T00:00:00.000Z",
  };
}

function providerCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString()).cursor;
}

describe("progressive history boundaries after byte bounding", () => {
  test("a hydrated snapshot keeps its original cursor closure and skips an unnameable recovered row", async () => {
    const preview = [row("m2"), row("m3")];
    const history = [
      row("m0", 3_000),
      row("m1"),
      { ...preview[0]!, parts: [{ type: "text", content: "recovered" }] },
      preview[1]!,
    ];
    // This closure deliberately knows only pre-hydration rows. Hydration
    // spreads the original snapshot and replaces its messages, not the map.
    const cursors = new Map(preview.map((message) => [message.id, `before:${message.id}`]));
    const cursorBefore = mock((id: string) => cursors.get(id));
    const messages = mock(async () => history);
    const interactiveSnapshot = mock(async () => {
      throw new Error("history must not take the joined path");
    });
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: preview,
        complete: false,
        omittedParts: 1,
        historyStartIndex: 2,
        historyEpoch: "epoch-1",
        historyCursor: "before:m2",
        historyCursorBefore: cursorBefore,
        sourceToken: "preview-1",
        freshness: "current",
      }),
      transcriptPage: async (_session, options) => {
        expect(options.cursor).toBe("before:m2");
        return {
          status: "page",
          truncated: false,
          messages: history.slice(0, 2),
          complete: true,
          historyEpoch: "epoch-1",
        };
      },
      messages,
      interactiveSnapshot,
    });
    await withService(
      { prefix: "orkestrator-history-hydrated-boundary-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const read = () =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
        await read();
        await waitForCondition(() =>
          [...projectionInternals(service).progressiveHydrations.values()].some(
            (entry) => entry.snapshot !== undefined,
          ),
        );
        const hydrated = [...projectionInternals(service).progressiveHydrations.values()][0]!
          .snapshot!;
        expect(hydrated.historyCursorBefore).toBe(cursorBefore);
        expect(hydrated.messages).toHaveLength(4);
        cursorBefore.mockClear();
        const update = await read();
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "m1",
          "m2",
          "m3",
        ]);
        expect(cursorBefore.mock.calls.map(([id]) => id)).toEqual(["m1", "m2"]);
        expect(update.value.historyPaging).toBe("direct");
        expect(providerCursor(update.value.historyCursor!)).toBe("before:m2");
        const page = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: update.value.historyCursor!,
        });
        const ids = [...page.messages, ...update.value.messages].map(
          (message) => (message as { id: string }).id,
        );
        expect(ids.filter((id) => id === "m1")).toHaveLength(2);
        expect([...new Set(ids)]).toEqual(history.map((message) => message.id));
        expect(page.complete).toBe(true);
        expect(messages).toHaveBeenCalledTimes(1);
        expect(interactiveSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  test.each([false, true])(
    "partial byte drops preserve prefix and snapshot paging (snapshot cut: %s)",
    async (cutSnapshot) => {
      const history = [row("root"), row("m0", 800), row("m1"), row("m2"), row("m3", 1_000)];
      let streaming = false;
      const cursorBefore = mock((id: string) =>
        ["m2", "m3"].includes(id) ? `before:${id}` : undefined,
      );
      const forbiddenRead = mock(async () => {
        throw new Error("direct paging must not hydrate or join");
      });
      const stub = createProviderStub("codex", {
        transcriptSnapshot: async (): Promise<ProviderTranscriptSnapshot> => ({
          messages: streaming ? history.slice(cutSnapshot ? 1 : 3) : history.slice(1, 4),
          complete: false,
          representation: "summary",
          historyStartIndex: streaming ? (cutSnapshot ? 1 : 3) : 1,
          historyEpoch: "epoch-1",
          historyCursor: streaming ? (cutSnapshot ? "before:m0" : "before:m2") : "before:m0",
          historyCursorBefore: cursorBefore,
          sourceToken: streaming ? "stream-2" : "stream-1",
          freshness: "current",
        }),
        transcriptPage: async (_session, options) => {
          expect(options.cursor).toBe("before:m2");
          return {
            status: "page",
            truncated: false,
            messages: history.slice(0, 3),
            complete: true,
            historyEpoch: "epoch-1",
          };
        },
        messages: forbiddenRead,
        interactiveSnapshot: forbiddenRead,
      });
      await withService(
        { prefix: "orkestrator-history-joined-boundary-", provider: async () => stub.provider },
        async ({ service }) => {
          await service.ensureSession(identity);
          const read = () =>
            service.getTranscriptUpdate({
              ...identity,
              viewVersion: 1,
              liveWindow,
              forceSnapshot: true,
            });
          const initial = await read();
          if (initial.status !== "snapshot") throw new Error("expected a snapshot");
          expect(initial.value.messages.map((message) => (message as { id: string }).id)).toEqual([
            "m0",
            "m1",
            "m2",
          ]);
          streaming = true;
          cursorBefore.mockClear();
          const update = await read();
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          expect(update.value.messages.map((message) => (message as { id: string }).id)).toEqual([
            "m1",
            "m2",
            "m3",
          ]);
          expect(update.value.messageWindow).toMatchObject({
            truncationReason: "bytes",
            omittedMessages: 1,
          });
          expect(update.value.historyPaging).toBe("direct");
          // A retained prefix can safely reuse the snapshot cursor. When the
          // bound cuts into snapshot rows, skip m1, which cannot name one.
          // Both first pages repeat m1, which the reader deduplicates.
          expect(cursorBefore.mock.calls.map(([id]) => id)).toEqual(
            cutSnapshot ? ["m1", "m2"] : [],
          );
          expect(providerCursor(update.value.historyCursor!)).toBe("before:m2");
          const request = {
            ...identity,
            syncVersion: 1 as const,
            before: update.value.historyCursor!,
          };
          const page = await service.getMessagePage(request);
          const repeated = await service.getMessagePage(request);
          expect(repeated).toEqual(page);
          const ids = [...page.messages, ...update.value.messages].map(
            (message) => (message as { id: string }).id,
          );
          expect(ids.filter((id) => id === "m1")).toHaveLength(2);
          expect([...new Set(ids)]).toEqual(history.map((message) => message.id));
          expect(page.complete).toBe(true);
          expect(stub.transcriptPage).toHaveBeenCalledTimes(1);
          expect(forbiddenRead).not.toHaveBeenCalled();
        },
      );
    },
  );
});
