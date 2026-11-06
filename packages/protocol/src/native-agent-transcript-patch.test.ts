import { describe, expect, spyOn, test } from "bun:test";
import {
  applyNativeAgentMessagePatch,
  buildNativeAgentMessagePatch,
  isNativeAgentMessagePatch,
  NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION,
  nativeAgentPartsDigest,
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
  subagentActions?: Part[];
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
  } else if (roll < 0.85) {
    parts.push({ type: "text", content: text(next, 3), sourcePartId: `p${parts.length}` });
  } else if (roll < 0.95) {
    // A sub-agent: open one, or grow, stream into and settle its actions.
    const index = parts.findIndex((part) => part.type === "subagent");
    if (index < 0) {
      parts.push({ type: "subagent", content: "Agent", toolUseId: "agent", subagentActions: [] });
    } else {
      const agent = parts[index]!;
      const actions = (agent.subagentActions ?? []).map((action) => ({ ...action }));
      const which = next();
      if (which < 0.4 || actions.length === 0) {
        actions.push({ type: "tool-invocation", content: "Read", toolUseId: `a${actions.length}` });
      } else if (which < 0.7) {
        const last = actions.length - 1;
        actions[last] = { ...actions[last]!, content: actions[last]!.content + text(next, 4) };
      } else {
        const at = Math.floor(next() * actions.length);
        actions[at] = { ...actions[at]!, toolState: "success" };
      }
      parts[index] = {
        ...agent,
        subagentActions: actions,
        ...(next() < 0.2 ? { toolState: "success" } : {}),
      };
    }
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

/** The digest as patch version 2 shipped it; the value must never change. */
function shippedPartsDigest(parts: readonly unknown[]): string {
  const serialized = JSON.stringify(parts);
  let first = 2_166_136_261;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

/** A memoizing encoder like the backend's, counting what it serializes. */
function memoEncoder(): { encode: (value: unknown) => string; serialized: unknown[] } {
  const memo = new WeakMap<object, string>();
  const serialized: unknown[] = [];
  return {
    serialized,
    encode: (value) => {
      if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
      let json = memo.get(value);
      if (json === undefined) {
        serialized.push(value);
        json = JSON.stringify(value);
        memo.set(value, json);
      }
      return json;
    },
  };
}

describe("parts digest", () => {
  test("is byte-identical to the shipped digest, with or without a memoizing encode", () => {
    const lists: unknown[][] = [
      [],
      [{ type: "text", content: 'é 中 😀 \ud83d \n "' }],
      [null, 1, "s", true, undefined, () => 1, [1, [2]], { nested: { a: undefined } }],
    ];
    for (let seed = 1; seed <= 20; seed += 1) {
      const next = random(seed);
      let message: Message = { id: "m", role: "assistant", content: "", parts: [], createdAt: "" };
      for (let step = 0; step < 30; step += 1) {
        message = evolve(message, next);
        lists.push(message.parts);
      }
    }
    // Unchanged digest, so no new patch version is needed.
    expect(NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION).toBe(2);
    const { encode } = memoEncoder();
    for (const parts of lists) {
      const shipped = shippedPartsDigest(parts);
      expect(nativeAgentPartsDigest(parts)).toBe(shipped);
      expect(nativeAgentPartsDigest(parts, encode)).toBe(shipped);
      // Twice: the second pass reads every part from the memo.
      expect(nativeAgentPartsDigest(parts, encode)).toBe(shipped);
    }
  });

  test("a memoizing builder serializes each part once and never the whole list", () => {
    const previous: Message = {
      id: "m",
      role: "assistant",
      content: "a",
      createdAt: "",
      parts: Array.from({ length: 20 }, (_, index) => ({
        type: "tool-invocation",
        toolUseId: `call-${index}`,
        content: `body ${index}`,
        toolState: "success",
      })),
    };
    const following: Message = {
      ...previous,
      content: "ab",
      parts: [
        ...previous.parts.slice(0, -1),
        { ...previous.parts.at(-1)!, content: "body 19 and more" },
      ],
    };
    const { encode, serialized } = memoEncoder();
    const stringify = spyOn(JSON, "stringify");
    let patch: NativeAgentMessagePatch | undefined;
    try {
      patch = buildNativeAgentMessagePatch(previous, following, encode);
      const lists = stringify.mock.calls.filter(
        ([value]) => value === previous.parts || value === following.parts,
      );
      expect(lists).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
    expect(patch?.basePartsDigest).toBe(shippedPartsDigest(previous.parts));
    expect(new Set(serialized).size).toBe(serialized.length);
    expect(patch?.parts.at(-1)).toEqual({ keep: 19, length: 7, append: " and more" });
    expect(applyNativeAgentMessagePatch(previous, patch!)).toEqual(following);
  });

  test("an append is recognised exactly when the rest of the part encodes the same", () => {
    const base = (part: Record<string, unknown>) => ({
      id: "m",
      role: "assistant",
      content: "",
      createdAt: "",
      parts: [part],
    });
    const append = (before: Record<string, unknown>, after: Record<string, unknown>) =>
      buildNativeAgentMessagePatch(base(before), base(after))?.parts[0];
    const long = "x".repeat(200);
    // Fields JSON omits do not count; field order and values do.
    expect(
      append(
        { type: "text", content: long, hidden: undefined },
        { type: "text", content: `${long}!` },
      ),
    ).toEqual({ keep: 0, length: 200, append: "!" });
    expect(
      append({ type: "text", content: long, a: 1 }, { type: "text", a: 1, content: `${long}!` }),
    ).toEqual({ keep: 0, length: 200, append: "!" });
    expect(
      append(
        { type: "text", a: 1, b: 2, content: long },
        { type: "text", b: 2, a: 1, content: `${long}!` },
      ),
    ).not.toHaveProperty("append");
    expect(
      append(
        { type: "text", content: long, a: { b: 1 } },
        { type: "text", content: `${long}!`, a: { b: 2 } },
      ),
    ).not.toHaveProperty("append");
  });
});

describe("message patches", () => {
  test("applying a built patch reproduces the next message exactly", () => {
    const memo = memoEncoder();
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
        // The backend's memoizing encode builds the very same patch.
        expect(buildNativeAgentMessagePatch(message, following, memo.encode)).toEqual(patch);
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
      ...buildNativeAgentMessagePatch(base, { ...base, content: "abcd" })!,
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
    expect(
      applyNativeAgentMessagePatch(
        { ...base, parts: [{ ...base.parts[0]!, content: "different" }] },
        patch,
      ),
    ).toBeNull();
    expect(
      applyNativeAgentMessagePatch({ ...base, parts: [...base.parts, base.parts[0]!] }, patch),
    ).toBeNull();
  });

  test("the validator refuses shapes that could smuggle fields or break bounds", () => {
    const valid = {
      id: "m1",
      basePartsCount: 2,
      basePartsDigest: "abc:def",
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
        envelope([
          {
            id: "m",
            basePartsCount: 0,
            basePartsDigest: "abc:def",
            fields: {},
            content: { value: "" },
            parts: [],
          },
        ]),
      ),
    ).toBe(true);
    expect(isNativeAgentTranscriptUpdate(envelope([{ id: "m" }]))).toBe(false);
    expect(isNativeAgentTranscriptUpdate(envelope("nope"))).toBe(false);
  });
});

describe("nested part patches", () => {
  test("a sub-agent gaining one action sends only that action", () => {
    const actions = Array.from({ length: 30 }, (_, index) => ({
      type: "tool-invocation",
      content: `Read ${index} ${"x".repeat(500)}`,
      toolUseId: `a${index}`,
    }));
    const agent = {
      type: "subagent",
      content: "Agent",
      toolUseId: "agent",
      subagentActions: actions,
    };
    const previous = { id: "m", role: "assistant", content: "", parts: [agent], createdAt: "c" };
    const added = { type: "tool-invocation", content: "Read 30", toolUseId: "a30" };
    const next = {
      ...previous,
      parts: [{ ...agent, subagentActions: [...actions.map((a) => ({ ...a })), added] }],
    };
    const patch = buildNativeAgentMessagePatch(previous, next)!;
    expect(patch.parts[0]).toMatchObject({ keep: 0, field: "subagentActions" });
    expect(Buffer.byteLength(JSON.stringify(patch)) * 10).toBeLessThan(
      Buffer.byteLength(JSON.stringify(next)),
    );
    const applied = applyNativeAgentMessagePatch(previous, patch) as typeof next;
    expect(applied).toEqual(next);
    // Unchanged nested actions are the client's own objects.
    expect(applied.parts[0]!.subagentActions[0]).toBe(actions[0]);
  });

  test("nesting is bounded in both the builder and the validator", () => {
    const deep = (depth: number): Record<string, unknown> =>
      depth === 0 ? { keep: 0 } : { keep: 0, field: "parts", children: [deep(depth - 1)] };
    const patch = (depth: number) => ({
      id: "m",
      basePartsCount: 1,
      basePartsDigest: "abc:def",
      fields: {},
      content: { value: "" },
      parts: [deep(depth)],
    });
    expect(isNativeAgentMessagePatch(patch(4))).toBe(true);
    expect(isNativeAgentMessagePatch(patch(5))).toBe(false);
    expect(
      isNativeAgentMessagePatch({
        ...patch(1),
        parts: [{ keep: 0, field: "__proto__", children: [] }],
      }),
    ).toBe(false);
  });
});
