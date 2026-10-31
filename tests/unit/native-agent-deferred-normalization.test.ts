import { expect, test } from "bun:test";
import { normalizeNativeMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type {
  NativeMessage,
  NativeMessagePart,
} from "../../apps/web/src/lib/chat/native-message-types";
import {
  createProviderStub,
  withService,
} from "../../apps/backend/src/core/native-agent-service-projection-test-support";

function thinkingParts(parts: NativeMessagePart[]): NativeMessagePart[] {
  return parts.flatMap((part) =>
    part.type === "thinking" ? [part] : part.type === "tool-group" ? thinkingParts(part.parts) : [],
  );
}

test("projected reasoning with matching previews keeps both expandable bodies after browser normalization", async () => {
  const prefix = "Shared reasoning. ".repeat(75);
  const bodies = [prefix + "First conclusion", prefix + "Second conclusion"];
  const messages: NativeMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      createdAt: "2026-10-31T10:00:00.000Z",
      parts: [
        ...bodies.map((content) => ({ type: "thinking" as const, content })),
        { type: "text", content: "Done" },
      ],
    },
  ];
  const stub = createProviderStub("codex", {
    interactiveSnapshot: async () => ({ status: "idle", messages }),
  });
  const identity = {
    environmentId: "env-1",
    agent: "codex" as const,
    logicalSessionKey: "env-env-1:tab-deferred-normalization",
  };
  await withService(
    { prefix: "orkestrator-deferred-normalization-", provider: async () => stub.provider },
    async ({ service }) => {
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const normalized = normalizeNativeMessages(projection!.messages as NativeMessage[]);
      const parts = normalized.flatMap((message) => thinkingParts(message.parts));
      expect(parts).toHaveLength(2);
      expect(parts[0]!.content).toBe(parts[1]!.content);
      const refs = parts.map((part) => part.contentDetailRef);
      expect(refs.every((ref) => typeof ref === "string")).toBe(true);
      expect(new Set(refs).size).toBe(2);
      for (const [index, ref] of refs.entries()) {
        const detail = await service.getProjectionToolDetails({ ...identity, detailRef: ref! });
        expect(detail.thinking).toBe(bodies[index]);
      }
    },
  );
});
