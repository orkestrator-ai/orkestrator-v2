import { expect, test } from "bun:test";
import { OPEN_CODE_MESSAGE_HISTORY_LIMIT } from "@orkestrator/protocol/opencode-message-id";
import { openCodeTranscriptSnapshot } from "./opencode-snapshots.js";

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
      openCodeTranscriptSnapshot({
        sessionId: "session-1",
        options: { limit, targetBytes: 64 * 1024 },
        revision: () => 3,
        currentMessages: () => undefined,
        readMessages: async (count) => {
          reads.push(count);
          return Array.from({ length: Math.min(count, 5) }, (_, index) => rawMessage(`m-${index}`));
        },
        replaceMessages: (messages) => replaced.push(messages),
        title: () => undefined,
        recordUnknown: () => undefined,
      }),
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
