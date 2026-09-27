import { describe, expect, test } from "bun:test";
import { applyNativeAgentTranscriptDelta } from "@orkestrator/protocol/native-agent";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const createdAt = "2026-09-27T00:00:00.000Z";

/** A long tool-running turn whose newest text part keeps growing. */
function turn(completedTools: number, text: string) {
  return [
    {
      id: "prompt",
      role: "user" as const,
      content: "do the work",
      parts: [{ type: "text", content: "do the work" }],
      createdAt,
    },
    {
      id: "answer",
      role: "assistant" as const,
      content: text,
      parts: [
        ...Array.from({ length: completedTools }, (_, index) => ({
          type: "tool-invocation",
          content: `Read file ${index}`,
          sourcePartId: `answer:${index}`,
          toolUseId: `call-${index}`,
          toolName: "read",
          toolArgs: { path: `src/file-${index}.ts` },
          toolState: "success",
          // Small enough to stay inline, so the whole card rides every delta.
          toolOutput: `contents of file ${index} `.repeat(40),
        })),
        { type: "text", content: text, sourcePartId: "answer:text" },
      ],
      createdAt,
    },
  ];
}

describe("part-level transcript patches", () => {
  test("a negotiated delta patches the changed message and reproduces the snapshot exactly", async () => {
    let messages = turn(40, "Working");
    let revision = 1;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async (_id, options) => {
        const update = bridgeTranscriptUpdate(messages, {
          sessionIdentity: "s",
          generation: 1,
          contentEpoch: 1,
          revision,
          limit: options.limit,
          targetBytes: options.targetBytes,
          complete: true,
          ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
        });
        if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
        return {
          messages: update.value.messages,
          historyStartIndex: update.value.startIndex,
          sourceToken: update.token,
          complete: true,
          historyEpoch: "1:1",
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-transcript-patches-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:patches",
        };
        await service.ensureSession(identity);
        const read = (knownToken?: string, patchVersion?: 1) =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            ...(knownToken ? { knownToken } : {}),
            ...(patchVersion ? { patchVersion } : {}),
          });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a snapshot");

        messages = turn(40, "Working on it, now reading the next file");
        revision += 1;
        const patched = await read(first.token, 1);
        if (patched.status !== "delta") throw new Error("expected a delta");
        expect(patched.delta.messageUpserts).toHaveLength(0);
        expect(patched.delta.messagePatches).toHaveLength(1);

        const merged = applyNativeAgentTranscriptDelta(
          first.value,
          JSON.parse(JSON.stringify(patched.delta)),
        );
        const snapshot = await read(undefined);
        if (snapshot.status !== "snapshot") throw new Error("expected a snapshot");
        expect(JSON.parse(JSON.stringify(merged?.messages))).toEqual(
          JSON.parse(JSON.stringify(snapshot.value.messages)),
        );

        // The whole-message delta the same client would otherwise receive.
        const whole = Buffer.byteLength(JSON.stringify(snapshot.value.messages[1]));
        const patchBytes = Buffer.byteLength(JSON.stringify(patched.delta.messagePatches));
        expect(patchBytes * 10).toBeLessThan(whole);
      },
    );
  });

  test("a client that did not negotiate keeps whole-message deltas", async () => {
    let messages = turn(5, "a");
    let revision = 1;
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async (_id, options) => {
        const update = bridgeTranscriptUpdate(messages, {
          sessionIdentity: "s",
          generation: 1,
          contentEpoch: 1,
          revision,
          limit: options.limit,
          targetBytes: options.targetBytes,
          complete: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        return {
          messages: update.value.messages,
          historyStartIndex: update.value.startIndex,
          sourceToken: update.token,
          complete: true,
          historyEpoch: "1:1",
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-transcript-no-patches-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:no-patches",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        messages = turn(5, "ab");
        revision += 1;
        const next = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        if (next.status !== "delta") throw new Error("expected a delta");
        expect(next.delta.messagePatches).toBeUndefined();
        expect(next.delta.messageUpserts).toHaveLength(1);
      },
    );
  });
});
