import { describe, expect, test } from "bun:test";
import {
  applyNativeAgentMessagePatch,
  buildNativeAgentMessagePatch,
  isNativeAgentMessagePatch,
  type NativeAgentMessagePatch,
} from "./native-agent-transcript-patch.js";
import {
  applyNativeAgentTranscriptDelta,
  isNativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
} from "./native-agent.js";

interface Part {
  type: string;
  content: string;
  sourcePartId?: string;
  toolUseId?: string;
  toolState?: string;
  toolOutput?: string;
}
interface Message {
  id: string;
  role: string;
  content: string;
  parts: Part[];
  createdAt: string;
  modelId?: string;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const ALPHABET = ["a", "é", "中", "😀", "\n", '"', "\ud83d"];
function text(next: () => number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[Math.floor(next() * ALPHABET.length)];
  }
  return value;
}

/** One step of a streaming turn: append, settle, add, replace or drop parts. */
function evolve(message: Message, next: () => number): Message {
  const parts = message.parts.map((part) => ({ ...part }));
  const roll = next();
  if (roll < 0.35 && parts.length > 0) {
    const index = parts.length - 1;
    parts[index] = { ...parts[index]!, content: parts[index]!.content + text(next, 5) };
  } else if (roll < 0.55) {
    parts.push({
      type: "tool-invocation",
      content: "Read",
      toolUseId: `call-${parts.length}-${Math.floor(next() * 1e6)}`,
      toolState: "pending",
    });
  } else if (roll < 0.7 && parts.length > 0) {
    const index = Math.floor(next() * parts.length);
    parts[index] = { ...parts[index]!, toolState: "success", toolOutput: text(next, 20) };
  } else if (roll < 0.8 && parts.length > 1) {
    parts.splice(Math.floor(next() * parts.length), 1);
  } else if (roll < 0.9) {
    parts.push({ type: "text", content: text(next, 3), sourcePartId: `p${parts.length}` });
  } else if (parts.length > 0) {
    // A rewrite that is not an append.
    parts[0] = { ...parts[0]!, content: text(next, 4) };
  }
  const content = next() < 0.85 ? message.content + text(next, 3) : text(next, 6);
  return {
    ...message,
    content,
    parts,
    ...(next() < 0.1 ? { modelId: "model-b" } : {}),
  };
}

describe("message patches", () => {
  test("applying a built patch reproduces the next message exactly", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      let message: Message = {
        id: "m1",
        role: "assistant",
        content: "",
        parts: [],
        createdAt: "2026-09-27T00:00:00.000Z",
      };
      for (let step = 0; step < 60; step += 1) {
        const following = evolve(message, next);
        const patch = buildNativeAgentMessagePatch(message, following);
        expect(patch).toBeDefined();
        expect(isNativeAgentMessagePatch(JSON.parse(JSON.stringify(patch)))).toBe(true);
        const applied = applyNativeAgentMessagePatch(message, JSON.parse(JSON.stringify(patch)));
        expect(applied).toEqual(following);
        message = following;
      }
    }
  });

  test("kept parts are the client's own objects, not copies", () => {
    const tool: Part = { type: "tool-invocation", content: "Read", toolUseId: "t1" };
    const previous: Message = {
      id: "m1",
      role: "assistant",
      content: "a",
      parts: [tool, { type: "text", content: "hel", sourcePartId: "p1" }],
      createdAt: "c",
    };
    const next: Message = {
      ...previous,
      content: "ab",
      parts: [{ ...tool }, { type: "text", content: "hello", sourcePartId: "p1" }],
    };
    const patch = buildNativeAgentMessagePatch(previous, next)!;
    expect(patch.parts).toEqual([{ keep: 0 }, { keep: 1, length: 3, append: "lo" }]);
    expect(patch.content).toEqual({ length: 1, append: "b" });
    const applied = applyNativeAgentMessagePatch(previous, patch) as Message;
    expect(applied.parts[0]).toBe(tool);
  });

  test("a patch against a different base is refused rather than misapplied", () => {
    const base: Message = {
      id: "m1",
      role: "assistant",
      content: "abc",
      parts: [{ type: "text", content: "x", sourcePartId: "p" }],
      createdAt: "c",
    };
    const patch: NativeAgentMessagePatch = {
      id: "m1",
      fields: { role: "assistant", createdAt: "c" },
      content: { length: 3, append: "d" },
      parts: [{ keep: 0 }],
    };
    expect(applyNativeAgentMessagePatch(base, patch)).not.toBeNull();
    expect(applyNativeAgentMessagePatch({ ...base, content: "ab" }, patch)).toBeNull();
    expect(applyNativeAgentMessagePatch(base, { ...patch, parts: [{ keep: 1 }] })).toBeNull();
    expect(
      applyNativeAgentMessagePatch(base, {
        ...patch,
        parts: [{ keep: 0, length: 5, append: "y" }],
      }),
    ).toBeNull();
    expect(applyNativeAgentMessagePatch(base, { ...patch, id: "m2" })).toBeNull();
  });

  test("the validator refuses shapes that could smuggle fields or break bounds", () => {
    const valid = {
      id: "m1",
      fields: {},
      content: { value: "" },
      parts: [{ keep: 0 }, { value: {} }, { keep: 1, length: 0, append: "" }],
    };
    expect(isNativeAgentMessagePatch(valid)).toBe(true);
    for (const invalid of [
      { ...valid, fields: { parts: [] } },
      { ...valid, fields: { id: "other" } },
      { ...valid, content: { length: -1, append: "" } },
      { ...valid, parts: [{ keep: 0, extra: true }] },
      { ...valid, parts: [{ keep: 1.5 }] },
      { ...valid, parts: Array.from({ length: 5_000 }, () => ({ keep: 0 })) },
      { ...valid, id: "" },
    ]) {
      expect(isNativeAgentMessagePatch(invalid)).toBe(false);
    }
  });
});

describe("patched transcript deltas", () => {
  const identity = {
    backendInstanceId: "b",
    environmentId: "e",
    platform: "codex" as const,
    logicalSessionKey: "k",
    providerSessionId: "s",
    sourceGeneration: "g",
  };
  function view(messages: Message[]): NativeAgentTranscriptView<Message> {
    return { identity, freshness: "current", messages, historyEpoch: "h", historyComplete: true };
  }

  test("a delta applies every patch or none", () => {
    const m1: Message = { id: "m1", role: "assistant", content: "a", parts: [], createdAt: "c" };
    const m2: Message = { id: "m2", role: "assistant", content: "b", parts: [], createdAt: "c" };
    const current = view([m1, m2]);
    const good = buildNativeAgentMessagePatch(m1, { ...m1, content: "aa" })!;
    const bad = {
      ...buildNativeAgentMessagePatch(m2, { ...m2, content: "bb" })!,
      content: { length: 9, append: "x" },
    };
    const delta = {
      messageUpserts: [],
      deletedMessageIds: [],
      freshness: "current" as const,
      historyEpoch: "h",
      historyComplete: true,
    };
    expect(
      applyNativeAgentTranscriptDelta(current, { ...delta, messagePatches: [good] })?.messages[0]
        ?.content,
    ).toBe("aa");
    expect(
      applyNativeAgentTranscriptDelta(current, { ...delta, messagePatches: [good, bad] }),
    ).toBeNull();
    // A message cannot be both patched and upserted.
    expect(
      applyNativeAgentTranscriptDelta(current, {
        ...delta,
        messagePatches: [good],
        messageUpserts: [{ ...m1, content: "zz" }],
      }),
    ).toBeNull();
  });

  test("the update validator accepts patched deltas and rejects malformed patches", () => {
    const envelope = (messagePatches: unknown) => ({
      viewVersion: 1,
      status: "delta",
      baseToken: "a",
      token: "b",
      identity,
      delta: {
        messageUpserts: [],
        deletedMessageIds: [],
        freshness: "current",
        historyEpoch: "h",
        historyComplete: true,
        messagePatches,
      },
    });
    expect(
      isNativeAgentTranscriptUpdate(
        envelope([{ id: "m", fields: {}, content: { value: "" }, parts: [] }]),
      ),
    ).toBe(true);
    expect(isNativeAgentTranscriptUpdate(envelope([{ id: "m" }]))).toBe(false);
    expect(isNativeAgentTranscriptUpdate(envelope("nope"))).toBe(false);
  });
});
