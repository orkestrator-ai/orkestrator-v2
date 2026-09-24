import { describe, expect, mock, test } from "bun:test";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { openCodeContextUsage } from "./opencode-usage.js";
import {
  createProviderStub,
  internals,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

function progressiveMessage(id: string, content = id) {
  return {
    id,
    role: "assistant" as const,
    content,
    parts: [] as unknown[],
    createdAt: "2026-09-09T00:00:00.000Z",
  };
}

function progressiveMessages(count: number, prefix = "m") {
  return Array.from({ length: count }, (_, index) =>
    progressiveMessage(`${prefix}${index}`, `${prefix}${index}`),
  );
}

describe("native agent progressive remainder", () => {
  test.each([false, true])(
    "keeps long-turn activity visible while recovering a part-trimmed preview (prompt: %s)",
    async (withPrompt) => {
      let revision = 1;
      let contentEpoch = 1;
      let large = false;
      let release: (() => void) | undefined;
      const transcript = () => [
        ...(withPrompt ? [{ ...progressiveMessage("prompt"), role: "user" }] : []),
        {
          ...progressiveMessage("response", `Update ${revision}`),
          parts: [
            ...Array.from({ length: revision >= 3 ? 4 : 3 }, (_, index) => ({
              type: "tool-invocation",
              toolUseId: `call-${index}`,
              toolName: "exec_command",
              content: `Command ${index}`,
              toolOutput: large ? "x".repeat((revision >= 3 ? 160 : 250) * 1024) : "done",
              toolState: "success",
            })),
            {
              type: "progress",
              toolUseId: "call-0",
              content: `Running ${revision}`,
              elapsedMs: revision * 100,
            },
            { type: "text", content: `Update ${revision}` },
          ],
        },
      ];
      const messages = mock(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return transcript();
      });
      const stub = createProviderStub("codex", {
        messages,
        transcriptSnapshot: async () => {
          const update = bridgeTranscriptUpdate(transcript(), {
            sessionIdentity: "session-1",
            generation: 1,
            contentEpoch,
            revision,
            limit: liveWindow.messages,
            targetBytes: liveWindow.targetBytes,
            complete: true,
          });
          if (update.status !== "snapshot") throw new Error("expected snapshot");
          return {
            ...update.value,
            omittedParts: update.value.messageWindow.omittedParts,
            historyStartIndex: update.value.startIndex,
            sourceToken: update.token,
            historyEpoch: `1:${contentEpoch}`,
          };
        },
      });
      await withService(
        { prefix: "orkestrator-progressive-part-flicker-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: "env-env-1:part-flicker",
          };
          await service.ensureSession(identity);
          const read = () =>
            service.getTranscriptUpdate({
              ...identity,
              viewVersion: 1,
              liveWindow,
              forceSnapshot: true,
            });
          const initial = await read();
          if (initial.status !== "snapshot") throw new Error("expected snapshot");
          try {
            large = true;
            for (revision = 2; revision <= 3; revision += 1) {
              const pending = await read();
              if (pending.status !== "snapshot") throw new Error("expected snapshot");
              expect(pending.value.messages).toEqual(initial.value.messages);
              await waitForCondition(() => release !== undefined);
              const finish = release!;
              release = undefined;
              finish();
              await waitForCondition(async () => {
                const next = await read();
                return (
                  next.status === "snapshot" &&
                  (next.value.messages.at(-1) as { content: string }).content ===
                    `Update ${revision}`
                );
              });
              const hydrated = await read();
              if (hydrated.status !== "snapshot") throw new Error("expected snapshot");
              expect(hydrated.value.messages).toHaveLength(withPrompt ? 2 : 1);
              expect(hydrated.value.messages.at(-1)).toMatchObject({
                parts: [
                  ...Array.from({ length: revision >= 3 ? 4 : 3 }, (_, index) => ({
                    type: "tool-invocation",
                    content: `Command ${index}`,
                    ...(index === 0
                      ? {
                          progress: {
                            content: `Running ${revision}`,
                            elapsedMs: revision * 100,
                          },
                        }
                      : {}),
                  })),
                  { type: "text", content: `Update ${revision}` },
                ],
              });
              expect(JSON.stringify(hydrated.value).length).toBeLessThan(liveWindow.targetBytes);
              initial.value = hydrated.value;
            }
            // A rewrite must not preserve activity from the old history.
            contentEpoch += 1;
            const rewritten = await read();
            if (rewritten.status !== "snapshot") throw new Error("expected snapshot");
            expect(
              (rewritten.value.messages.at(-1) as { parts: unknown[] }).parts.length,
            ).toBeLessThan(5);
            await waitForCondition(() => release !== undefined);
            release!();
            release = undefined;
            await waitForCondition(async () => {
              const recovered = await read();
              return (
                recovered.status === "snapshot" &&
                (recovered.value.messages.at(-1) as { parts: unknown[] }).parts.length === 5
              );
            });
            // Complete snapshots still replace an earlier, longer reply.
            large = false;
            revision = 1;
            const complete = await read();
            if (complete.status !== "snapshot") throw new Error("expected snapshot");
            expect(complete.value.messages.at(-1)).toMatchObject({ content: "Update 1" });
          } finally {
            release?.();
          }
        },
      );
    },
  );

  test("retries a failed part recovery without a source-token change", async () => {
    let trimmed = false;
    const full = {
      ...progressiveMessage("response", "Update 2"),
      parts: [
        { type: "tool-invocation", toolUseId: "call-1", content: "Command 1" },
        { type: "text", content: "Update 2" },
      ],
    };
    const preview = { ...full, parts: full.parts.slice(1) };
    let exactReads = 0;
    const messages = mock(async () => {
      exactReads += 1;
      if (exactReads === 1) throw new Error("temporary exact-read failure");
      return [full];
    });
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () =>
        trimmed
          ? {
              messages: [preview],
              complete: false,
              omittedParts: 1,
              sourceToken: "stable-source-2",
              historyEpoch: "1:1",
              freshness: "current" as const,
            }
          : {
              messages: [{ ...full, content: "Update 1" }],
              complete: true,
              sourceToken: "source-1",
              historyEpoch: "1:1",
              freshness: "current" as const,
            },
    });
    await withService(
      { prefix: "orkestrator-progressive-part-retry-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:part-retry",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        const initial = await service.getTranscriptUpdate(input);
        if (initial.status !== "snapshot") throw new Error("expected snapshot");

        trimmed = true;
        const held = await service.getTranscriptUpdate(input);
        if (held.status !== "snapshot") throw new Error("expected snapshot");
        expect(held.value.messages).toEqual(initial.value.messages);

        await waitForCondition(() => exactReads >= 2);
        await waitForCondition(async () => {
          const recovered = await service.getTranscriptUpdate(input);
          return (
            recovered.status === "snapshot" &&
            (recovered.value.messages[0] as { content: string }).content === "Update 2"
          );
        });
        expect(messages).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("releases a part-trim hold when exact recovery makes no progress", async () => {
    let trimmed = false;
    const full = {
      ...progressiveMessage("response", "Update 1"),
      parts: [
        { type: "tool-invocation", toolUseId: "call-1", content: "Command 1" },
        { type: "text", content: "Update 1" },
      ],
    };
    const preview = {
      ...full,
      content: "Update 2",
      parts: [{ type: "text", content: "Update 2" }],
    };
    const messages = mock(async () => [preview]);
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () => ({
        messages: [trimmed ? preview : full],
        complete: !trimmed,
        ...(trimmed ? { omittedParts: 1 } : {}),
        sourceToken: trimmed ? "stable-source-2" : "source-1",
        historyEpoch: "1:1",
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-part-release-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:part-release",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        const initial = await service.getTranscriptUpdate(input);
        if (initial.status !== "snapshot") throw new Error("expected snapshot");

        trimmed = true;
        const held = await service.getTranscriptUpdate(input);
        if (held.status !== "snapshot") throw new Error("expected snapshot");
        expect(held.value.messages).toEqual(initial.value.messages);

        await waitForCondition(() => messages.mock.calls.length === 3);
        const released = await service.getTranscriptUpdate(input);
        if (released.status !== "snapshot") throw new Error("expected snapshot");
        expect(released.value.messages[0]).toMatchObject({
          content: "Update 2",
          parts: [{ type: "text", content: "Update 2" }],
        });
        expect(messages).toHaveBeenCalledTimes(3);
      },
    );
  });

  test.each([
    { name: "disjoint preview", epoch: "epoch-1", ids: ["other"], expected: ["other"] },
    { name: "reordered overlap", epoch: "epoch-1", ids: ["m1", "m0"], expected: ["m1", "m0"] },
    { name: "unversioned history", epoch: undefined, ids: ["m1"], expected: ["m1"] },
    {
      name: "count-bounded tail",
      epoch: "epoch-1",
      ids: Array.from({ length: liveWindow.messages }, (_, index) => `m${index + 1}`),
      expected: Array.from({ length: liveWindow.messages }, (_, index) => `m${index + 1}`),
    },
  ])("does not retain an unsafe or oversized prefix: $name", async ({ epoch, ids, expected }) => {
    let streaming = false;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: (streaming ? ids : ["m0", "m1"]).map((id) => progressiveMessage(id)),
        complete: !streaming,
        historyEpoch: epoch,
        sourceToken: streaming ? "source-2" : "source-1",
        freshness: "current" as const,
      }),
      messages: async () => [],
    });
    await withService(
      { prefix: "orkestrator-progressive-prefix-bounds-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:prefix-bounds",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        await service.getTranscriptUpdate(input);
        streaming = true;
        const next = await service.getTranscriptUpdate(input);
        if (next.status !== "snapshot") throw new Error("expected snapshot");
        expect(next.value.messages.map((message) => (message as { id: string }).id)).toEqual(
          Array.from(expected),
        );
        expect(next.value.historyComplete).toBe(false);
        expect(next.value.messages.length).toBeLessThanOrEqual(liveWindow.messages);
      },
    );
  });

  test.each([
    {
      name: "a shorter overlapping window",
      preview: ["b"],
      startIndex: 1,
    },
    {
      name: "an out-of-order overlap",
      preview: ["b", "x", "c"],
      startIndex: 1,
    },
  ])("rejects positioned prefix reuse for $name", async ({ preview, startIndex }) => {
    let streaming = false;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: (streaming ? preview : ["a", "b", "c"]).map((id) => progressiveMessage(id)),
        complete: !streaming,
        historyEpoch: "epoch-1",
        historyStartIndex: streaming ? startIndex : 0,
        sourceToken: streaming ? "source-2" : "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-progressive-position-rejection-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: `env-env-1:position-rejection-${startIndex}-${preview.join("-")}`,
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        await service.getTranscriptUpdate(input);
        streaming = true;
        const next = await service.getTranscriptUpdate(input);
        if (next.status !== "snapshot") throw new Error("expected snapshot");
        expect(next.value.messages.map((message) => (message as { id: string }).id)).toEqual(
          Array.from(preview),
        );
      },
    );
  });

  test("merges a positioned overlap while preserving an incomplete prior history", async () => {
    let streaming = false;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: (streaming ? ["b", "c", "d"] : ["a", "b", "c"]).map((id) =>
          progressiveMessage(id),
        ),
        complete: false,
        historyEpoch: "epoch-1",
        historyStartIndex: streaming ? 1 : 0,
        sourceToken: streaming ? "source-2" : "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-progressive-incomplete-overlap-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:incomplete-overlap",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        await service.getTranscriptUpdate(input);
        streaming = true;
        const next = await service.getTranscriptUpdate(input);
        if (next.status !== "snapshot") throw new Error("expected snapshot");
        expect(next.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "a",
          "b",
          "c",
          "d",
        ]);
        expect(next.value.historyComplete).toBe(false);
      },
    );
  });

  test.each(["provider session", "source generation"] as const)(
    "does not reuse a positioned prefix after a $change change",
    async (change) => {
      let streaming = false;
      const stub = createProviderStub("codex", {
        transcriptSnapshot: async () => ({
          messages: (streaming ? ["b", "c", "d"] : ["a", "b", "c"]).map((id) =>
            progressiveMessage(id),
          ),
          complete: !streaming,
          historyEpoch: "epoch-1",
          historyStartIndex: streaming ? 1 : 0,
          sourceToken: streaming ? "source-2" : "source-1",
          freshness: "current" as const,
        }),
      });
      await withService(
        { prefix: "orkestrator-progressive-identity-change-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: `env-env-1:identity-change-${change}`,
          };
          await service.ensureSession(identity);
          const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
          await service.getTranscriptUpdate(input);
          if (change === "provider session") {
            for (const entry of internals(service).progressiveTranscriptCache.values()) {
              const value = entry.value as { identity?: { providerSessionId: string } };
              if (value.identity) value.identity.providerSessionId = "provider-session-before";
            }
          } else {
            internals(service).providerConnections.set("env-1\0codex", "generation-2");
          }
          streaming = true;
          const next = await service.getTranscriptUpdate(input);
          if (next.status !== "snapshot") throw new Error("expected snapshot");
          expect(next.value.messages.map((message) => (message as { id: string }).id)).toEqual([
            "b",
            "c",
            "d",
          ]);
        },
      );
    },
  );

  test("keeps a hydrated prefix for an adjacent fresh-id streaming window", async () => {
    let phase: "base" | "append" | "rewrite" | "complete" = "base";
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages:
          phase === "base"
            ? [progressiveMessage("prompt"), progressiveMessage("old-assistant")]
            : [progressiveMessage("new-user"), progressiveMessage("new-assistant")],
        complete: phase === "base" || phase === "complete",
        historyEpoch: phase === "rewrite" ? "epoch-2" : "epoch-1",
        historyStartIndex: phase === "append" ? 2 : 0,
        sourceToken: `source-${phase}`,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-fresh-id-append-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:fresh-id-append",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        await service.getTranscriptUpdate(input);
        phase = "append";
        const appended = await service.getTranscriptUpdate(input);
        if (appended.status !== "snapshot") throw new Error("expected snapshot");
        expect(appended.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "prompt",
          "old-assistant",
          "new-user",
          "new-assistant",
        ]);
        expect(appended.value.historyComplete).toBe(true);

        phase = "rewrite";
        const rewritten = await service.getTranscriptUpdate(input);
        if (rewritten.status !== "snapshot") throw new Error("expected snapshot");
        expect(rewritten.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "new-user",
          "new-assistant",
        ]);

        phase = "complete";
        const completed = await service.getTranscriptUpdate(input);
        if (completed.status !== "snapshot") throw new Error("expected snapshot");
        expect(completed.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "new-user",
          "new-assistant",
        ]);
      },
    );
  });

  test("retains a provider-deleted row until an incomplete same-epoch window becomes complete", async () => {
    let complete = true;
    let deleted = false;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: deleted
          ? [progressiveMessage("response")]
          : [progressiveMessage("prompt"), progressiveMessage("response")],
        complete,
        historyEpoch: "epoch-1",
        historyStartIndex: deleted && !complete ? 1 : 0,
        sourceToken: `source-${deleted}-${complete}`,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-deleted-row-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:deleted-row",
        };
        await service.ensureSession(identity);
        const input = { ...identity, viewVersion: 1 as const, liveWindow, forceSnapshot: true };
        await service.getTranscriptUpdate(input);
        deleted = true;
        complete = false;
        const pending = await service.getTranscriptUpdate(input);
        if (pending.status !== "snapshot") throw new Error("expected snapshot");
        expect(pending.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "prompt",
          "response",
        ]);
        complete = true;
        const authoritative = await service.getTranscriptUpdate(input);
        if (authoritative.status !== "snapshot") throw new Error("expected snapshot");
        expect(
          authoritative.value.messages.map((message) => (message as { id: string }).id),
        ).toEqual(["response"]);
      },
    );
  });

  test("does not claim complete history when byte bounding drops a joined prefix", async () => {
    let streaming = false;
    const byteWindow = { messages: 100, targetBytes: 512 } as const;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: [
          streaming
            ? progressiveMessage("new", "x".repeat(4_096))
            : progressiveMessage("old", "old"),
        ],
        complete: !streaming,
        historyEpoch: "epoch-1",
        historyStartIndex: streaming ? 1 : 0,
        sourceToken: streaming ? "source-2" : "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-byte-joined-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:byte-joined",
        };
        await service.ensureSession(identity);
        const input = {
          ...identity,
          viewVersion: 1 as const,
          liveWindow: byteWindow,
          forceSnapshot: true,
        };
        await service.getTranscriptUpdate(input);
        streaming = true;
        const next = await service.getTranscriptUpdate(input);
        if (next.status !== "snapshot") throw new Error("expected snapshot");
        expect(next.value.messages).toHaveLength(1);
        expect(next.value.messages[0]).toMatchObject({ id: "new" });
        expect(next.value.messageWindow).toMatchObject({
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: false,
        });
        expect(next.value.historyComplete).toBe(false);
      },
    );
  });

  test("keeps a recovered initial attachment visible across byte-trimmed streaming previews", async () => {
    const prompt = {
      ...progressiveMessage("prompt", "Inspect this screenshot"),
      role: "user",
      parts: [
        {
          type: "file",
          content: "/workspace/screenshot.png",
          fileUrl: `data:image/png;base64,${"a".repeat(200 * 1024)}`,
        },
      ],
    };
    let revision = 1;
    let contentEpoch = 1;
    let includePrompt = true;
    let largeOutput = true;
    const response = () => ({
      ...progressiveMessage("response", `Update ${revision}`),
      parts: [
        { type: "tool-invocation", toolOutput: largeOutput ? "x".repeat(400 * 1024) : "done" },
      ],
    });
    const messages = mock(async () => [...(includePrompt ? [prompt] : []), response()]);
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () => {
        const update = bridgeTranscriptUpdate([...(includePrompt ? [prompt] : []), response()], {
          sessionIdentity: "session-1",
          generation: 1,
          contentEpoch,
          revision,
          limit: liveWindow.messages,
          targetBytes: liveWindow.targetBytes,
          complete: true,
        });
        if (update.status !== "snapshot") throw new Error("expected bridge snapshot");
        return {
          ...update.value,
          historyStartIndex: update.value.startIndex,
          sourceToken: update.token,
          historyEpoch: `1:${contentEpoch}`,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-streaming-prefix-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:streaming-prefix",
        };
        await service.ensureSession(identity);
        const read = () =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
        const preview = await read();
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toMatchObject([{ id: "response" }]);
        await waitForCondition(async () => {
          const hydrated = await read();
          return hydrated.status === "snapshot" && hydrated.value.messages.length === 2;
        });
        for (revision = 2; revision <= 4; revision += 1) {
          // Read before the next asynchronous full-history recovery can finish.
          const streaming = await read();
          expect(streaming.status).toBe("snapshot");
          if (streaming.status !== "snapshot") throw new Error("expected snapshot");
          expect(streaming.value.messages).toMatchObject([
            { id: "prompt", parts: [{ type: "file", content: "/workspace/screenshot.png" }] },
            { id: "response", content: `Update ${revision}` },
          ]);
          expect(streaming.value.historyComplete).toBe(true);
          expect(JSON.stringify(streaming.value).length).toBeLessThan(liveWindow.targetBytes);
        }
        // A rewritten history cannot inherit the old prompt, even with overlap.
        contentEpoch += 1;
        revision += 1;
        const replaced = await read();
        if (replaced.status !== "snapshot") throw new Error("expected snapshot");
        expect(replaced.value.messages).toMatchObject([{ id: "response" }]);
        await waitForCondition(async () => {
          const hydrated = await read();
          return hydrated.status === "snapshot" && hydrated.value.messages.length === 2;
        });
        // A complete authoritative snapshot must still be allowed to delete it.
        includePrompt = false;
        largeOutput = false;
        revision += 1;
        const deleted = await read();
        if (deleted.status !== "snapshot") throw new Error("expected snapshot");
        expect(deleted.value.messages).toMatchObject([{ id: "response" }]);
      },
    );
  });

  test("shows a provider-trimmed first prompt when the full turn still fits", async () => {
    const prompt = {
      id: "prompt",
      role: "user",
      content: "Original request",
      parts: [],
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const response = {
      id: "response",
      role: "assistant",
      content: "Latest update",
      parts: [{ type: "text", text: "Earlier response activity" }],
      createdAt: "2026-09-09T00:01:00.000Z",
    };
    // The live preview omitted the prompt and reported `complete: false`
    // before hydration finished. One prompt plus one reply still fits the
    // window, so the remainder must be inlined rather than hidden.
    const stub = createProviderStub("claude", {
      transcriptSnapshot: async () => ({
        messages: [{ ...response, parts: [] }],
        complete: false,
        freshness: "current",
      }),
      messages: async () => [prompt, response],
    });
    await withService(
      { prefix: "orkestrator-progressive-trimmed-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:progressive-trimmed",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toMatchObject([{ id: "response" }]);
        await waitForCondition(async () => {
          const next = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          return next.status === "snapshot" && next.value.messages.length === 2;
        });
        const hydrated = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(hydrated.status).toBe("snapshot");
        if (hydrated.status !== "snapshot") throw new Error("expected snapshot");
        expect(hydrated.value.messages).toMatchObject([prompt, { id: "response" }]);
        expect(hydrated.value.historyComplete).toBe(true);
        expect(hydrated.value.messageWindow).toMatchObject({
          truncated: false,
          canLoadEarlier: false,
        });
      },
    );
  });

  test("does not offer to load earlier when an incomplete preview has no remainder", async () => {
    const response = {
      id: "response",
      role: "assistant",
      content: "Latest update",
      parts: [],
      createdAt: "2026-09-09T00:01:00.000Z",
    };
    const messages = mock(async () => [response]);
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [response],
        complete: false,
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-no-remainder-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-no-remainder",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toHaveLength(1);
        expect(preview.value.historyComplete).toBe(false);
        expect(preview.value.messageWindow?.canLoadEarlier).toBe(false);
        expect(preview.value.messageWindow?.truncated).toBe(true);
        await waitForCondition(() => messages.mock.calls.length === 1);
        const settled = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(settled.status).toBe("snapshot");
        if (settled.status !== "snapshot") throw new Error("expected snapshot");
        expect(settled.value.historyComplete).toBe(false);
        expect(settled.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: false,
        });
      },
    );
  });

  test("does not treat a part-trimmed live head as pageable history", async () => {
    const parts = Array.from({ length: 40 }, (_, index) => ({
      type: "text",
      content: `${index}:${"x".repeat(20 * 1024)}`,
    }));
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: [
          {
            id: "turn",
            role: "assistant",
            content: "done",
            parts,
            createdAt: "2026-09-09T00:01:00.000Z",
          },
        ],
        complete: true,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-omitted-parts-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-omitted-parts",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.historyComplete).toBe(true);
        expect(preview.value.messageWindow).toMatchObject({
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: false,
        });
        expect(preview.value.messageWindow?.omittedParts).toBeGreaterThan(0);
        expect(preview.value.messages).toHaveLength(1);
      },
    );
  });

  test("marks a byte-capped incomplete tail non-pageable without declaring history complete", async () => {
    const tail = progressiveMessages(liveWindow.messages).map((message) => ({
      ...message,
      content: `${message.id}:${"x".repeat(8 * 1024)}`,
    }));
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: tail,
        complete: false,
        freshness: "current" as const,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-progressive-byte-capped-incomplete-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-byte-capped-incomplete",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");

        expect(preview.value.messages.length).toBeLessThan(liveWindow.messages);
        expect(preview.value.historyComplete).toBe(false);
        expect(preview.value.messageWindow).toMatchObject({
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: false,
        });
        expect(preview.value.messageWindow?.omittedMessages).toBeGreaterThan(0);
      },
    );
  });

  test("shares one legacy interactive snapshot between transcript and state", async () => {
    const interactiveSnapshot = mock(async () => ({
      status: "idle" as const,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "shared",
          parts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    }));
    const stub = createProviderStub("cursor", { interactiveSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-share-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-share",
        };
        await service.ensureSession(identity);
        const [transcript, state] = await Promise.all([
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
          }),
          service.getSessionStateUpdate({ ...identity, viewVersion: 1 }),
        ]);
        expect(transcript.status).toBe("snapshot");
        expect(state.status).toBe("snapshot");
        expect(interactiveSnapshot).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("schedules one trailing transcript read after an invalidation", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transcriptSnapshot = mock(async () => {
      calls += 1;
      if (calls === 1) await firstHeld;
      return {
        messages: [
          {
            id: `m${calls}`,
            role: "assistant",
            content: `round-${calls}`,
            parts: [],
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        complete: true,
        revision: calls,
        sourceToken: `source-${calls}`,
        freshness: "current" as const,
      };
    });
    const stub = createProviderStub("cursor", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-trail-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-trail",
        };
        await service.ensureSession(identity);
        const first = service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        await waitForCondition(() => transcriptSnapshot.mock.calls.length === 1);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const before = internals(service).projectionEpochs.get(sessionKey) ?? 0;
        internals(service).invalidateProjection(sessionKey);
        const after = internals(service).projectionEpochs.get(sessionKey) ?? 0;
        expect(after).toBeGreaterThan(before);
        releaseFirst();
        const update = await first;
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(transcriptSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(update.value.messages[0]).toMatchObject({ content: "round-2" });
      },
    );
  });

  test("persists a display tail and serves it after a memory-cache miss", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "preview",
            parts: [],
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        complete: true,
        revision: 1,
        sourceToken: "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-persist-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-persist",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        const persisted = await storage.getNativeAgentDisplayTail(sessionKey);
        expect(persisted?.messages).toHaveLength(1);
        internals(service).progressiveTranscriptCache.clear();
        const cached = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(cached.status).toBe("snapshot");
        if (cached.status !== "snapshot") throw new Error("expected snapshot");
        expect(cached.value.freshness).toBe("cached");
        expect(cached.value.messages[0]).toMatchObject({ content: "preview" });
        expect(cached.value.historyComplete).toBe(true);
      },
    );
  });

  test("keeps a persisted tail while a restored Codex thread hydrates", async () => {
    let coldPreview = false;
    let releaseExact!: () => void;
    const exactGate = new Promise<void>((resolve) => {
      releaseExact = resolve;
    });
    const transcriptSnapshot = mock(async () =>
      coldPreview
        ? {
            messages: [],
            complete: false,
            sourceToken: "source-restored-empty",
            freshness: "cached" as const,
          }
        : {
            messages: [progressiveMessage("m1", "persisted conversation")],
            complete: true,
            sourceToken: "source-before-restart",
            freshness: "current" as const,
          },
    );
    const messages = mock(async () => {
      await exactGate;
      return [progressiveMessage("m1", "persisted conversation")];
    });
    const stub = createProviderStub("codex", { transcriptSnapshot, messages });
    await withService(
      { prefix: "orkestrator-progressive-codex-restored-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-restored",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        internals(service).progressiveTranscriptCache.clear();
        coldPreview = true;

        const restored = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(restored.status).toBe("snapshot");
        if (restored.status !== "snapshot") throw new Error("expected snapshot");
        expect(restored.value.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);
        expect(restored.value.freshness).toBe("cached");
        const afterColdStart = await storage.getNativeAgentDisplayTail(sessionKey);
        expect(afterColdStart?.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);

        await waitForCondition(() => messages.mock.calls.length === 1);
        const whileHydrating = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(whileHydrating.status).toBe("snapshot");
        if (whileHydrating.status !== "snapshot") throw new Error("expected snapshot");
        expect(whileHydrating.value.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect((await storage.getNativeAgentDisplayTail(sessionKey))?.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);

        releaseExact();
        await waitForCondition(async () => {
          const hydrated = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          return hydrated.status === "snapshot" && hydrated.value.freshness === "current";
        });
        const settled = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(settled.status).toBe("snapshot");
        if (settled.status !== "snapshot") throw new Error("expected snapshot");
        expect(settled.value.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);
        expect(settled.value.freshness).toBe("current");
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect((await storage.getNativeAgentDisplayTail(sessionKey))?.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
        ]);
      },
    );
  });

  test("replaces a persisted tail once hydration returns a different transcript", async () => {
    let coldPreview = false;
    const transcriptSnapshot = mock(async () =>
      coldPreview
        ? {
            messages: [],
            complete: false,
            sourceToken: "source-restored-empty",
            freshness: "cached" as const,
          }
        : {
            messages: [progressiveMessage("m1", "persisted conversation")],
            complete: true,
            sourceToken: "source-before-restart",
            freshness: "current" as const,
          },
    );
    const messages = mock(async () => [
      progressiveMessage("m1", "persisted conversation"),
      progressiveMessage("m2", "hydrated later turn"),
    ]);
    const stub = createProviderStub("codex", { transcriptSnapshot, messages });
    await withService(
      { prefix: "orkestrator-progressive-codex-replace-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-replace",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        internals(service).progressiveTranscriptCache.clear();
        coldPreview = true;

        const restored = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(restored.status).toBe("snapshot");
        if (restored.status !== "snapshot") throw new Error("expected snapshot");
        expect(restored.value.messages).toMatchObject([{ id: "m1" }]);

        await waitForCondition(async () => {
          const hydrated = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          return hydrated.status === "snapshot" && hydrated.value.messages.length === 2;
        });
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect((await storage.getNativeAgentDisplayTail(sessionKey))?.messages).toMatchObject([
          { id: "m1", content: "persisted conversation" },
          { id: "m2", content: "hydrated later turn" },
        ]);
      },
    );
  });

  test("projects an authoritative empty current snapshot over a persisted tail", async () => {
    let emptied = false;
    const transcriptSnapshot = mock(async () =>
      emptied
        ? {
            messages: [],
            complete: true,
            sourceToken: "source-empty-current",
            freshness: "current" as const,
          }
        : {
            messages: [progressiveMessage("m1", "persisted conversation")],
            complete: true,
            sourceToken: "source-before-empty",
            freshness: "current" as const,
          },
    );
    const stub = createProviderStub("codex", { transcriptSnapshot });
    await withService(
      {
        prefix: "orkestrator-progressive-codex-empty-current-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-empty-current",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        internals(service).progressiveTranscriptCache.clear();
        emptied = true;

        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.messages).toEqual([]);
        expect(update.value.freshness).toBe("empty");
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect((await storage.getNativeAgentDisplayTail(sessionKey))?.messages).toEqual([]);
      },
    );
  });

  test("projects an empty cached incomplete preview when the provider session changed", async () => {
    let coldPreview = false;
    const transcriptSnapshot = mock(async () =>
      coldPreview
        ? {
            messages: [],
            complete: false,
            sourceToken: "source-other-session",
            freshness: "cached" as const,
          }
        : {
            messages: [progressiveMessage("m1", "other conversation")],
            complete: true,
            sourceToken: "source-before",
            freshness: "current" as const,
          },
    );
    const stub = createProviderStub("codex", { transcriptSnapshot });
    await withService(
      {
        prefix: "orkestrator-progressive-codex-session-mismatch-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-session-mismatch",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        for (const entry of internals(service).progressiveTranscriptCache.values()) {
          const value = entry.value as { identity?: { providerSessionId?: string } };
          if (value.identity) value.identity.providerSessionId = "other-provider-session";
        }
        coldPreview = true;
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.messages).toEqual([]);
      },
    );
  });

  test("projects an empty cached incomplete preview when the cached view is empty", async () => {
    const transcriptSnapshot = mock(async () => ({
      messages: [],
      complete: false,
      sourceToken: "source-empty-cached",
      freshness: "cached" as const,
    }));
    const stub = createProviderStub("codex", { transcriptSnapshot });
    await withService(
      {
        prefix: "orkestrator-progressive-codex-empty-cached-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-empty-cached",
        };
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.messages).toEqual([]);
        expect(update.value.freshness).not.toBe("current");
      },
    );
  });

  test("returns a transcript delta when only an older message changes", async () => {
    let revision = 1;
    const transcriptSnapshot = mock(async () => ({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: revision === 1 ? "running" : "done",
          parts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
      complete: true,
      revision,
      sourceToken: `source-${revision}`,
      freshness: "current" as const,
    }));
    const stub = createProviderStub("cursor", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-delta-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-delta",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("expected snapshot");
        revision = 2;
        const second = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        expect(second.status).toBe("delta");
        if (second.status !== "delta") throw new Error("expected delta");
        expect(second.delta.messageUpserts).toHaveLength(1);
        expect(second.delta.messageUpserts[0]).toMatchObject({ content: "done" });
      },
    );
  });

  test("records transcript metrics without session identifiers", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        revision: 1,
        sourceToken: "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-metrics-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-metrics",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        const samples = internals(service).progressiveMetrics.list() as Array<{
          domain: string;
          outcome: string;
        }>;
        expect(samples.some((sample) => sample.domain === "transcript")).toBe(true);
        expect(JSON.stringify(samples)).not.toContain(identity.logicalSessionKey);
      },
    );
  });

  test("held discovery does not delay a progressive transcript snapshot", async () => {
    const discoveryHeld = new Promise<never>(() => undefined);
    const slashCommands = mock(async () => discoveryHeld);
    const modelCatalog = mock(async () => discoveryHeld);
    const stub = createProviderStub("cursor", {
      slashCommands,
      modelCatalog,
      transcriptSnapshot: async () => ({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "visible",
            parts: [],
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        complete: true,
        revision: 1,
        sourceToken: "source-1",
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => ({ status: "idle" as const }),
    });
    await withService(
      { prefix: "orkestrator-progressive-discovery-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-discovery",
        };
        await service.ensureSession(identity);
        void service.getDiscoveryUpdate({
          ...identity,
          viewVersion: 1,
          sections: ["models", "commands"],
        });
        const transcript = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(transcript.status).toBe("snapshot");
        if (transcript.status !== "snapshot") throw new Error("expected snapshot");
        expect(transcript.value.messages[0]).toMatchObject({ content: "visible" });
      },
    );
  });
  test("fills a provider-omitted context window in the progressive state view", async () => {
    const stub = createProviderStub("cursor", {
      sessionStateSnapshot: async () => ({
        status: "idle" as const,
        phase: "idle" as const,
        contextUsage: { usedTokens: 50_000, source: "cursor" as const },
        composer: {
          models: [
            {
              platform: "cursor" as const,
              id: "cursor/default",
              label: "Default",
              contextWindow: 200_000,
            },
          ],
          selectedModelId: "cursor/default",
          fastModeEnabled: false,
          fastModeAvailable: true,
          modes: [{ id: "build", label: "Build" }],
        },
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-context-window-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-context-window",
        };
        await service.ensureSession(identity);
        const update = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.contextUsage).toMatchObject({
          usedTokens: 50_000,
          maximumTokens: 200_000,
          percentage: 25,
        });
      },
    );
  });

  test("projects a running turn's provider activity onto the progressive turn state", async () => {
    let status: "running" | "idle" = "running";
    const stub = createProviderStub("claude", {
      sessionStateSnapshot: async () => ({
        status,
        phase: status,
        turnActivity: { compacting: true, thinkingTokens: 1_200 },
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-turn-activity-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:progressive-turn-activity",
        };
        await service.ensureSession(identity);
        const running = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (running.status !== "snapshot") throw new Error("expected snapshot");
        expect(running.value.turn.activity).toEqual({ compacting: true, thinkingTokens: 1_200 });

        // A stale report from the provider must not outlive the turn.
        status = "idle";
        const idle = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (idle.status !== "snapshot") throw new Error("expected snapshot");
        expect(idle.value.turn.activity).toBeUndefined();
      },
    );
  });

  test("returns unchanged for an OpenCode state read whose transcript is stable", async () => {
    const messages = [
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          tokens: { input: 7, output: 3, cache: { read: 1, write: 0 } },
          time: { created: 1, completed: 2 },
        },
        parts: [],
      },
    ];
    const stub = createProviderStub("opencode", {
      sessionStateSnapshot: async () => ({
        status: "idle" as const,
        phase: "idle" as const,
        contextUsage: openCodeContextUsage(messages),
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-stable-token-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:progressive-stable-token",
        };
        await service.ensureSession(identity);
        const first = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("expected snapshot");
        // A per-read timestamp would change the hashed state view and force a
        // redundant snapshot on every poll.
        const second = await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          knownToken: first.token,
        });
        expect(second.status).toBe("unchanged");
      },
    );
  });

  test("keeps the projected context window when OpenCode reports usage without a composer", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle" as const,
        messages: [],
        contextUsage: { usedTokens: 50_000, source: "opencode" as const },
        composer: {
          models: [
            {
              platform: "opencode" as const,
              id: "opencode/claude-sonnet",
              label: "Claude Sonnet",
              contextWindow: 200_000,
            },
          ],
          selectedModelId: "opencode/claude-sonnet",
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
        },
      }),
      sessionStateSnapshot: async () => ({
        status: "idle" as const,
        phase: "idle" as const,
        contextUsage: { usedTokens: 60_000, source: "opencode" as const },
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-cold-catalogue-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:progressive-cold-catalogue",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.contextUsage).toMatchObject({
          usedTokens: 50_000,
          maximumTokens: 200_000,
          percentage: 25,
        });
        // The state read carries no composer and the catalogue is still cold, so
        // the window has to come from the projection rather than dropping out.
        const update = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.contextUsage).toMatchObject({
          usedTokens: 60_000,
          maximumTokens: 200_000,
          percentage: 30,
        });
      },
    );
  });

  test("keeps the projected usage when a state read races ahead of the provider cache", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle" as const,
        messages: [],
        contextUsage: { usedTokens: 50_000, source: "opencode" as const },
        composer: {
          models: [
            {
              platform: "opencode" as const,
              id: "opencode/claude-sonnet",
              label: "Claude Sonnet",
              contextWindow: 200_000,
            },
          ],
          selectedModelId: "opencode/claude-sonnet",
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
        },
      }),
      sessionStateSnapshot: async () => ({ status: "idle" as const, phase: "idle" as const }),
    });
    await withService(
      { prefix: "orkestrator-progressive-race-usage-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:progressive-race-usage",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.contextUsage).toMatchObject({ usedTokens: 50_000 });
        // The provider answered before its transcript cache was ready, so the
        // state read omits usage; the projection's counters must survive.
        const update = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.contextUsage).toMatchObject({
          usedTokens: 50_000,
          maximumTokens: 200_000,
          percentage: 25,
        });
      },
    );
  });
});

describe("native agent progressive remainder recovery", () => {
  test("keeps a provider-truncated live-window tail pageable", async () => {
    const tail = progressiveMessages(liveWindow.messages);
    const older = progressiveMessage("older", "earlier history");
    const messages = mock(async () => [older, ...tail]);
    const stub = createProviderStub("claude", {
      transcriptSnapshot: async () => ({
        messages: tail,
        complete: false,
        sourceToken: "source-full",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-full-tail-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:progressive-full-tail",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toHaveLength(liveWindow.messages);
        expect(preview.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: true,
        });
        expect(preview.value.historyComplete).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(messages).toHaveBeenCalledTimes(0);
      },
    );
  });

  test("keeps recovery when messages() returns exactly the live-window tail", async () => {
    const previewRows = progressiveMessages(40, "preview");
    const recovered = progressiveMessages(liveWindow.messages, "bridge");
    const messages = mock(async () => recovered);
    const stub = createProviderStub("claude", {
      transcriptSnapshot: async () => ({
        messages: previewRows,
        complete: false,
        sourceToken: "source-bridge",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-bridge-limit-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:progressive-bridge-limit",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toHaveLength(40);
        await waitForCondition(async () => {
          const next = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          return next.status === "snapshot" && next.value.messages.length === liveWindow.messages;
        });
        const hydrated = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(hydrated.status).toBe("snapshot");
        if (hydrated.status !== "snapshot") throw new Error("expected snapshot");
        expect(hydrated.value.messages).toHaveLength(liveWindow.messages);
        expect(hydrated.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: true,
        });
        expect(hydrated.value.historyComplete).toBe(false);
      },
    );
  });

  test("returns the incomplete preview before a deferred messages() recovery", async () => {
    const prompt = {
      id: "prompt",
      role: "user" as const,
      content: "Original request",
      parts: [],
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const response = progressiveMessage("response", "Latest update");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const messages = mock(async () => {
      await held;
      return [prompt, response];
    });
    const stub = createProviderStub("claude", {
      transcriptSnapshot: async () => ({
        messages: [response],
        complete: false,
        sourceToken: "source-deferred",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-deferred-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:progressive-deferred",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toMatchObject([{ id: "response" }]);
        expect(messages).toHaveBeenCalledTimes(0);
        await waitForCondition(() => messages.mock.calls.length === 1);
        const stillPreview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(stillPreview.status).toBe("snapshot");
        if (stillPreview.status !== "snapshot") throw new Error("expected snapshot");
        expect(stillPreview.value.messages).toHaveLength(1);
        release();
        await waitForCondition(async () => {
          const next = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          return next.status === "snapshot" && next.value.messages.length === 2;
        });
      },
    );
  });

  test("calls messages() at most once per source-token change", async () => {
    let sourceToken = "source-1";
    const messages = mock(async () => [progressiveMessage("response", "Latest update")]);
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [progressiveMessage("response", "Latest update")],
        complete: false,
        sourceToken,
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-once-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-once",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await waitForCondition(() => messages.mock.calls.length === 1);
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(messages).toHaveBeenCalledTimes(1);
        sourceToken = "source-2";
        await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        await waitForCondition(() => messages.mock.calls.length === 2);
        expect(messages).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("does not attach a Codex thread while reading an incomplete preview", async () => {
    let attached = false;
    const messages = mock(async () => {
      attached = true;
      return progressiveMessages(50, "codex");
    });
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: progressiveMessages(50, "codex"),
        complete: false,
        sourceToken: "source-codex",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-codex-notouch-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-codex-notouch",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toHaveLength(50);
        expect(attached).toBe(false);
        expect(messages).toHaveBeenCalledTimes(0);
      },
    );
  });

  test("keeps a rejected messages() preview retryable", async () => {
    const messages = mock(async () => {
      throw new Error("recovery failed");
    });
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [progressiveMessage("response", "Latest update")],
        complete: false,
        sourceToken: "source-throw",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-throw-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-throw",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        await waitForCondition(() => messages.mock.calls.length === 1);
        const settled = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(settled.status).toBe("snapshot");
        if (settled.status !== "snapshot") throw new Error("expected snapshot");
        expect(settled.value.messages).toHaveLength(1);
        expect(settled.value.historyComplete).toBe(false);
        expect(settled.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: false,
        });
      },
    );
  });

  test("does not stamp completeness from a non-array messages() fallback", async () => {
    const messages = mock(async () => ({ not: "an array" }) as unknown as unknown[]);
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [progressiveMessage("response", "Latest update")],
        complete: false,
        sourceToken: "source-nonarray",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-nonarray-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-nonarray",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await waitForCondition(() => messages.mock.calls.length === 1);
        const settled = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(settled.status).toBe("snapshot");
        if (settled.status !== "snapshot") throw new Error("expected snapshot");
        expect(settled.value.historyComplete).toBe(false);
        expect(settled.value.messageWindow?.truncated).toBe(true);
      },
    );
  });

  test("ignores raw OpenCode envelopes instead of installing them as display rows", async () => {
    const normalized = [progressiveMessage("kept", "normalized")];
    const raw = [
      ...Array.from({ length: liveWindow.messages }, (_, index) => ({
        info: { id: `raw-${index}`, role: "assistant", time: { created: 0 } },
        parts: [],
      })),
      { parts: [] },
    ];
    const messages = mock(async () => raw);
    const stub = createProviderStub("opencode", {
      transcriptSnapshot: async () => ({
        messages: normalized,
        complete: false,
        sourceToken: "source-opencode",
        freshness: "current" as const,
      }),
      messages,
    });
    await withService(
      { prefix: "orkestrator-progressive-opencode-raw-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:progressive-opencode-raw",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toMatchObject([{ id: "kept", content: "normalized" }]);
        await waitForCondition(() => messages.mock.calls.length === 1);
        const settled = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(settled.status).toBe("snapshot");
        if (settled.status !== "snapshot") throw new Error("expected snapshot");
        expect(settled.value.messages).toMatchObject([{ id: "kept" }]);
        expect(settled.value.historyComplete).toBe(false);
        expect(settled.value.messageWindow?.truncated).toBe(true);
      },
    );
  });

  test("restores an incomplete persisted tail when the provider refresh fails", async () => {
    const tail = progressiveMessages(liveWindow.messages);
    let failing = false;
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        if (failing) throw new Error("provider refresh failed");
        return {
          messages: tail,
          complete: false,
          sourceToken: "source-persist",
          freshness: "current" as const,
        };
      },
    });
    await withService(
      {
        prefix: "orkestrator-progressive-persist-incomplete-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-persist-incomplete",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("expected snapshot");
        expect(first.value.historyComplete).toBe(false);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        const persisted = await storage.getNativeAgentDisplayTail(sessionKey);
        expect(persisted?.historyComplete).toBe(false);
        expect(persisted?.messageWindow?.canLoadEarlier).toBe(true);
        internals(service).progressiveTranscriptCache.clear();
        failing = true;
        const cached = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(cached.status).toBe("snapshot");
        if (cached.status !== "snapshot") throw new Error("expected snapshot");
        expect(cached.value.freshness).toBe("cached");
        expect(cached.value.historyComplete).toBe(false);
        expect(cached.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: true,
        });
      },
    );
  });
});

describe("native agent progressive failure and lifecycle", () => {
  test("reports an unavailable transcript rather than an absent session", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        throw new Error("bridge refused the transcript read");
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-transcript-error-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-transcript-error",
        };
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        // `missing` would tell the renderer the session is gone, which it would
        // act on by dropping the tab. A failed read is not that answer.
        expect(update.status).toBe("unavailable");
        if (update.status !== "unavailable") throw new Error("expected unavailable");
        expect(update.retryable).toBe(true);
        expect(update.error).toContain("bridge refused the transcript read");
      },
    );
  });

  test("keeps the cached identity when a session-state read fails", async () => {
    let failing = false;
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        revision: 1,
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => {
        if (failing) throw new Error("status endpoint timed out");
        return { status: "idle" as const };
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-state-error-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-state-error",
        };
        await service.ensureSession(identity);
        const first = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(first.status).toBe("snapshot");
        failing = true;
        const second = await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          forceSnapshot: true,
        });
        expect(second.status).toBe("unavailable");
        if (second.status !== "unavailable") throw new Error("expected unavailable");
        expect(second.retryable).toBe(true);
        expect(second.error).toContain("status endpoint timed out");
        // The identity is what lets the renderer tell "this session failed a
        // read" apart from "some other session answered".
        expect(second.identity?.logicalSessionKey).toBe(identity.logicalSessionKey);
      },
    );
  });

  test("reports a missing session once the provider has no session to read", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-missing-", provider: async () => stub.provider },
      async ({ service }) => {
        const update = await service.getTranscriptUpdate({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:never-created",
          viewVersion: 1,
          liveWindow,
        });
        expect(update.status).toBe("missing");
      },
    );
  });

  test("an invalidation during a discovery read leaves the epoch prunable", async () => {
    let releaseDiscovery!: () => void;
    const heldDiscovery = new Promise<null>((resolve) => {
      releaseDiscovery = () => resolve(null);
    });
    const stub = createProviderStub("cursor", {
      authStatus: async () => heldDiscovery as never,
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => ({ status: "idle" as const }),
    });
    await withService(
      { prefix: "orkestrator-progressive-prune-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-prune",
        };
        await service.ensureSession(identity);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await service.getDiscoveryUpdate({
          ...identity,
          viewVersion: 1,
          sections: ["auth"],
        });
        const view = internals(service);
        await waitForCondition(() =>
          Array.from(view.progressiveReads.keys()).some((key) => key.includes("discovery:")),
        );
        view.invalidateProjection(sessionKey);
        // Discovery has no trailing read that could ever consume a follow-up
        // marker, so marking it would pin this session's epoch forever.
        expect(
          Array.from(view.progressiveDirtyFollowUps.keys()).filter((key) =>
            key.includes("discovery:"),
          ),
        ).toEqual([]);
        releaseDiscovery();
        await waitForCondition(() => view.progressiveReads.size === 0);
        view.projectionCache.delete(sessionKey);
        view.projectionEpochs.set(sessionKey, 4);
        view.pruneProjectionEpoch(sessionKey);
        expect(view.projectionEpochs.has(sessionKey)).toBe(false);
      },
    );
  });

  test("clears the trailing follow-up marker even when a second read is needed", async () => {
    // Two invalidations, each landing while a read is in flight. The first
    // schedules the trailing read; the second lands inside it, which is the
    // only path that re-reads and used to return without clearing the marker.
    let calls = 0;
    const gates = new Map<number, () => void>();
    const held = (call: number) =>
      new Promise<void>((resolve) => {
        gates.set(call, resolve);
      });
    const holds = new Map<number, Promise<void>>([
      [1, held(1)],
      [2, held(2)],
    ]);
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        calls += 1;
        await holds.get(calls);
        return {
          messages: [
            {
              id: `m${calls}`,
              role: "assistant",
              content: `round-${calls}`,
              parts: [],
              createdAt: "2026-09-09T00:00:00.000Z",
            },
          ],
          complete: true,
          revision: calls,
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-marker-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-marker",
        };
        await service.ensureSession(identity);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const view = internals(service);
        const inFlight = service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await waitForCondition(() => calls === 1);
        view.invalidateProjection(sessionKey);
        gates.get(1)!();

        await waitForCondition(() => calls === 2);
        view.invalidateProjection(sessionKey);
        gates.get(2)!();

        await inFlight;
        await waitForCondition(() => view.progressiveTrailing.size === 0);
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(Array.from(view.progressiveDirtyFollowUps.keys())).toEqual([]);
      },
    );
  });
});
