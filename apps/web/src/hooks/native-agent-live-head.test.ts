import { describe, expect, spyOn, test } from "bun:test";
import { preferCompleteLiveHead } from "./native-agent-live-head";

// A copy of the merge as it was when it compared serialized parts, kept so the
// parity test below proves the comparison change altered no result. It is verbatim
// except where marked "#1867", which changed those results on purpose: a held
// row as long as the omitted count used to read as the cut prefix even when the
// incoming parts overlapped it, and an unchanged row always reported a restored
// prefix. The tests above the parity test pin the new answers directly.
/* oxlint-disable no-unused-vars -- the old code destructured fields away to drop them. */
/**
 * A provider identity for one part that survives its content changing: a
 * tool row keeps its `toolUseId` as it settles, and a streamed text or
 * thinking part keeps its source id and arrival time as it grows.
 */
function oldDurablePartIdentity(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const { type, toolUseId, sourcePartId, createdAt, toolName, toolTitle, content } = part as {
    type?: unknown;
    toolUseId?: unknown;
    sourcePartId?: unknown;
    createdAt?: unknown;
    toolName?: unknown;
    toolTitle?: unknown;
    content?: unknown;
  };
  if (typeof toolUseId === "string" && toolUseId) {
    // One Codex file-change item gives every changed file the same tool id.
    if (toolName === "apply_patch" && typeof content === "string") {
      return `${String(type)}\0tool\0${toolUseId}\0${String(toolTitle)}\0${content}`;
    }
    return `${String(type)}\0tool\0${toolUseId}`;
  }
  const source = typeof sourcePartId === "string" && sourcePartId ? sourcePartId : undefined;
  const arrived = typeof createdAt === "string" && createdAt ? createdAt : undefined;
  if (!source && !arrived) return undefined;
  return `${String(type)}\0${source ?? ""}\0${arrived ?? ""}`;
}

/**
 * Where `incoming` (a contiguous run of one message's parts) starts inside the
 * `local` copy of that message, or -1 when the two cannot be proven to overlap.
 *
 * Parts with a durable identity match on it. Parts without one must be equal,
 * except the last local part, which may still have been streaming when this
 * client read it; that loose match never counts on its own.
 */
function oldLocateIncomingParts(
  local: readonly unknown[],
  incoming: readonly unknown[],
  hint: number | undefined,
  // #1867: the length rule below now asks for the loose match too.
  acceptGrowth: boolean,
): number {
  if (local.length === 0 || incoming.length === 0) return -1;
  const serialized: Array<string | undefined> = [];
  const serialize = (index: number) => (serialized[index] ??= JSON.stringify(local[index]));
  const incomingSerialized: Array<string | undefined> = [];
  const serializeIncoming = (index: number) =>
    (incomingSerialized[index] ??= JSON.stringify(incoming[index]));
  const contentWithoutIdentity = (part: unknown) => {
    if (!part || typeof part !== "object") return JSON.stringify(part);
    const {
      sourcePartId: _sourcePartId,
      createdAt: _createdAt,
      ...content
    } = part as Record<string, unknown>;
    return JSON.stringify(content);
  };
  const match = (
    localIndex: number,
    incomingIndex: number,
  ): "identity" | "strict" | "loose" | false => {
    const held = oldDurablePartIdentity(local[localIndex]);
    const next = oldDurablePartIdentity(incoming[incomingIndex]);
    if (held !== undefined || next !== undefined) {
      if (held === next) return "identity";
      // A bridge may reissue source ids for otherwise identical parts.
      return contentWithoutIdentity(local[localIndex]) ===
        contentWithoutIdentity(incoming[incomingIndex])
        ? "strict"
        : false;
    }
    if (serialize(localIndex) === serializeIncoming(incomingIndex)) return "strict";
    const heldPart = local[localIndex] as { type?: unknown; content?: unknown } | null;
    const nextPart = incoming[incomingIndex] as { type?: unknown; content?: unknown } | null;
    const growsHeldPart =
      (heldPart?.type === "text" || (acceptGrowth && heldPart?.type === "thinking")) &&
      nextPart?.type === heldPart.type &&
      typeof heldPart.content === "string" &&
      typeof nextPart?.content === "string" &&
      nextPart.content.startsWith(heldPart.content);
    return localIndex === local.length - 1 && growsHeldPart ? "loose" : false;
  };
  const overlapAt = (offset: number) => {
    const overlap = Math.min(local.length - offset, incoming.length);
    // #1867 review: only content-only matches require a suffix.
    let identity = false;
    let strict = 0;
    for (let index = 0; index < overlap; index += 1) {
      const result = match(offset + index, index);
      if (!result) return 0;
      if (result === "identity") identity = true;
      if (result !== "loose") strict += 1;
    }
    // Repeated content inside a true prefix is ambiguous, but a shared identity
    // proves this is a copy even when the incoming window ends before local.
    if (acceptGrowth && offset + overlap < local.length && !identity) return 0;
    return strict > 0 || acceptGrowth ? overlap : 0;
  };
  let bestOffset = -1;
  let bestOverlap = 0;
  for (let offset = 0; offset < local.length; offset += 1) {
    const overlap = overlapAt(offset);
    if (
      overlap > bestOverlap ||
      (overlap > 0 &&
        overlap === bestOverlap &&
        offset + overlap === local.length &&
        bestOffset + bestOverlap !== local.length) ||
      (overlap > 0 &&
        overlap === bestOverlap &&
        (offset + overlap === local.length) === (bestOffset + bestOverlap === local.length) &&
        (offset === hint || (bestOffset !== hint && offset > bestOffset)))
    ) {
      bestOffset = offset;
      bestOverlap = overlap;
    }
  }
  return bestOffset;
}

/**
 * The live tail may omit leading parts of its first message to fit the byte
 * window. If this client already holds a copy of that same row, lay the
 * incoming parts over it at the offset where they overlap: the local copy
 * supplies the leading parts the window cut, so the cut cannot open a hole in
 * the middle of a turn the tab has already rendered, and the incoming parts
 * stay authoritative for everything they cover, including parts appended
 * since the tab last read the row.
 *
 * Choosing whole copies by part count alone froze the row: a trimmed head that
 * gained a final part still had fewer parts than the fuller copy on screen, so
 * the new part was never shown and later polls reported the view unchanged.
 * When a nonempty incoming copy cannot be proven to overlap, it wins.
 */
function oldPreferCompleteLiveHead<TMessage>(
  held: readonly TMessage[] | undefined,
  incoming: readonly TMessage[],
  omittedParts?: number,
): { messages: TMessage[]; restoredPrefix: boolean } {
  const incomingOnly = () => ({ messages: [...incoming], restoredPrefix: false });
  if (!held?.length || incoming.length === 0) return incomingOnly();
  const head = incoming[0]!;
  const headId = (head as { id?: unknown })?.id;
  if (typeof headId !== "string") return incomingOnly();
  const local = held.find((message) => (message as { id?: unknown })?.id === headId);
  const localParts = (local as { parts?: unknown } | undefined)?.parts;
  const headParts = (head as { parts?: unknown }).parts;
  if (!Array.isArray(localParts) || !Array.isArray(headParts)) return incomingOnly();
  // #1867: overlap comes first; content-only matches must be a suffix.
  const located =
    headParts.length === 0 && (omittedParts ?? 0) > 0
      ? localParts.length
      : oldLocateIncomingParts(
          localParts,
          headParts,
          omittedParts,
          omittedParts === localParts.length,
        );
  const offset = located < 0 && omittedParts === localParts.length ? localParts.length : located;
  if (offset < 0 || (offset === 0 && headParts.length >= localParts.length)) {
    return incomingOnly();
  }
  const parts = [
    ...localParts.slice(0, offset),
    ...headParts,
    ...localParts.slice(offset + headParts.length),
  ];
  const sameHeadFields =
    local &&
    Object.keys(head as object).length === Object.keys(local as object).length &&
    Object.entries(head as object).every(
      ([key, value]) => key === "parts" || value === (local as Record<string, unknown>)[key],
    );
  if (
    sameHeadFields &&
    parts.length === localParts.length &&
    headParts.every(
      (part, index) => JSON.stringify(part) === JSON.stringify(localParts[offset + index]),
    )
  ) {
    return {
      messages: [local, ...incoming.slice(1)],
      // #1867: an unchanged row short of the omitted count restores nothing.
      restoredPrefix: omittedParts === undefined || offset >= omittedParts,
    };
  }
  return {
    messages: [{ ...head, parts } as TMessage, ...incoming.slice(1)],
    restoredPrefix: omittedParts === undefined ? offset > 0 : offset >= omittedParts,
  };
}
/* oxlint-enable no-unused-vars */

function textPart(index: number, content = `text ${index}`) {
  return { type: "text", content, sourcePartId: `part-${index}`, createdAt: `t${index}` };
}

function row(parts: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "head", role: "assistant", parts, ...extra };
}

/** How many times `JSON.stringify` runs during `run`. */
function stringifyCalls(run: () => void): number {
  const spy = spyOn(JSON, "stringify");
  try {
    run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("preferCompleteLiveHead", () => {
  const parts = Array.from({ length: 200 }, (_, index) => textPart(index));

  test("returns the incoming rows without comparing anything when the row is the held row", () => {
    const head = row(parts);
    const tail = { id: "next", parts: [] };
    let result: ReturnType<typeof preferCompleteLiveHead<unknown>> | undefined;
    const calls = stringifyCalls(() => {
      result = preferCompleteLiveHead<unknown>([head], [head, tail]);
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ messages: [head, tail], restoredPrefix: false });
  });

  test("does not serialize the parts of an unchanged trimmed head", () => {
    const held = row(parts);
    const incoming = row(structuredClone(parts.slice(150)));
    let result: ReturnType<typeof preferCompleteLiveHead<unknown>> | undefined;
    const calls = stringifyCalls(() => {
      result = preferCompleteLiveHead<unknown>([held], [incoming], 150);
    });
    expect(calls).toBe(0);
    expect(oldStringifyCalls(held, incoming, 150)).toBeGreaterThan(0);
    // Nothing changed, so the row on screen keeps its identity.
    expect(result?.messages[0]).toBe(held);
    expect(result?.restoredPrefix).toBe(true);
  });

  test("does not serialize parts when a bridge reissued their source ids", () => {
    const held = row(parts);
    const reissued = parts
      .slice(150)
      .map((part, index) => ({ ...part, sourcePartId: `new-${index}`, createdAt: `n${index}` }));
    const incoming = row(reissued);
    let result: ReturnType<typeof preferCompleteLiveHead<unknown>> | undefined;
    const calls = stringifyCalls(() => {
      result = preferCompleteLiveHead<unknown>([held], [incoming], 150);
    });
    expect(calls).toBe(0);
    expect(oldStringifyCalls(held, incoming, 150)).toBeGreaterThan(0);
    expect(result).toEqual(oldPreferCompleteLiveHead<unknown>([held], [incoming], 150));
  });

  test("lays a changed trimmed head over the held prefix", () => {
    const held = row(parts.slice(0, 3));
    const grown = { ...parts[2]!, content: "text 2 and more" };
    const incoming = row([grown, textPart(3)]);
    const result = preferCompleteLiveHead<unknown>([held], [incoming], 2);
    expect(result.messages[0]).toEqual(row([parts[0], parts[1], grown, textPart(3)]));
    expect(result.restoredPrefix).toBe(true);
  });

  describe("a held row as long as the omitted count", () => {
    const plainText = (content: string) => ({ type: "text", content });

    test("does not show a part twice when it is an earlier trimmed copy that grew", () => {
      const held = row([textPart(1, "kept")]);
      const incoming = row([textPart(1, "kept and grown")]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    test("does not show a part twice when the trimmed copy has not changed", () => {
      const held = row([textPart(1)]);
      const incoming = row([textPart(1)]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    test("does not show a part twice when the row shares its parts with the held row", () => {
      const held = row([textPart(1)]);
      const incoming = row(held.parts);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    test("keeps incoming parts authoritative where a trimmed copy partly overlaps", () => {
      const grown = textPart(2, "text 2 and more");
      const held = row([textPart(1), textPart(2)]);
      const incoming = row([grown, textPart(3)]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 2);
      expect(result.messages[0]).toEqual(row([textPart(1), grown, textPart(3)]));
      // Part 0 is still missing: one held part cannot stand in for two omitted.
      expect(result.restoredPrefix).toBe(false);
    });

    test("does not report a restored prefix for an unchanged copy that falls short", () => {
      const held = row([textPart(1), textPart(2)]);
      const result = preferCompleteLiveHead<unknown>([held], [row([textPart(2)])], 2);
      expect(result.messages[0]).toBe(held);
      expect(result.restoredPrefix).toBe(false);
    });

    test.each([false, true])(
      "uses an interior durable-identity overlap when the incoming part grew: %s",
      (grows) => {
        const held = row([textPart(1), textPart(2)]);
        const first = textPart(1, grows ? "text 1 and more" : "text 1");
        const result = preferCompleteLiveHead<unknown>([held], [row([first])], 2);
        expect(result.messages[0]).toEqual(row([first, textPart(2)]));
        expect(result.restoredPrefix).toBe(false);
        if (!grows) expect(result.messages[0]).toBe(held);
      },
    );

    test("does not confuse reissued ids with a shared interior durable identity", () => {
      const prefix = [textPart(1, "same"), textPart(2)];
      const next = textPart(3, "same");
      const result = preferCompleteLiveHead<unknown>([row(prefix)], [row([next])], 2);
      expect(result.messages[0]).toEqual(row([...prefix, next]));
      expect(result.restoredPrefix).toBe(true);
    });

    test("restores a true cut prefix that does not overlap the incoming parts", () => {
      const held = row([textPart(0), textPart(1)]);
      const incoming = row([textPart(2), textPart(3)]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 2);
      expect(result.messages[0]).toEqual(row([textPart(0), textPart(1), textPart(2), textPart(3)]));
      expect(result.restoredPrefix).toBe(true);
    });

    test("restores a true cut prefix with no durable identity when the content differs", () => {
      const held = row([plainText("first")]);
      const incoming = row([plainText("second")]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toEqual(row([plainText("first"), plainText("second")]));
      expect(result.restoredPrefix).toBe(true);
    });

    test("restores a true cut prefix when repeated content matches before its final part", () => {
      const prefix = [plainText("a"), plainText("b"), plainText("c")];
      const incoming = row([plainText("a")]);
      const result = preferCompleteLiveHead<unknown>([row(prefix)], [incoming], 3);
      expect(result.messages[0]).toEqual(row([...prefix, plainText("a")]));
      expect(result.restoredPrefix).toBe(true);
    });

    test("uses a shorter suffix overlap instead of a longer match inside the prefix", () => {
      const prefix = [plainText("a"), plainText("b"), plainText("c"), plainText("a")];
      const incoming = row([plainText("a"), plainText("b")]);
      const result = preferCompleteLiveHead<unknown>([row(prefix)], [incoming], 4);
      expect(result.messages[0]).toEqual(row([...prefix, plainText("b")]));
      expect(result.restoredPrefix).toBe(false);
    });

    test("reads a growing text part with no durable identity as an overlap", () => {
      const held = row([plainText("kept")]);
      const incoming = row([plainText("kept and grown")]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    test("reads a growing thinking part with no durable identity as an overlap", () => {
      const held = row([{ type: "thinking", content: "kept" }]);
      const incoming = row([{ type: "thinking", content: "kept and grown" }]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    // When the match reaches the held row's end, nothing in these parts separates
    // a repeated part from the same part read twice. Showing it once and reporting
    // no restored prefix is the safe answer:
    // the caller falls back to the contiguous tail, and the cut part returns when
    // a later read delivers the whole row.
    test("shows equal parts once when no identity can tell a true prefix from a copy", () => {
      const held = row([plainText("same")]);
      const incoming = row([plainText("same")]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });

    test("reads equal content under reissued ids as an overlap too", () => {
      const held = row([textPart(1, "same")]);
      const incoming = row([textPart(2, "same")]);
      const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
      expect(result.messages[0]).toBe(incoming);
      expect(result.restoredPrefix).toBe(false);
    });
  });

  test("counts growth alone as an overlap only for a held row as long as the omitted count", () => {
    const held = row([textPart(0), { type: "text", content: "kept" }]);
    const incoming = row([{ type: "text", content: "kept and grown" }]);
    const result = preferCompleteLiveHead<unknown>([held], [incoming], 1);
    expect(result.messages[0]).toBe(incoming);
    expect(result.restoredPrefix).toBe(false);
  });

  test("does not report a restored prefix for an unchanged row short of the omitted count", () => {
    const held = row([textPart(3), textPart(4), textPart(5)]);
    const result = preferCompleteLiveHead<unknown>([held], [row([textPart(5)])], 5);
    expect(result.messages[0]).toBe(held);
    expect(result.restoredPrefix).toBe(false);
  });

  test("gives the old merge's answer for random heads", () => {
    let seed = 0x2f6e2b1;
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const randomPart = () => {
      const index = random(6);
      switch (random(5)) {
        case 0:
          return { type: "text", content: `text ${index}` };
        case 1:
          return textPart(index, `text ${random(3)}`);
        case 2:
          return { type: "tool-invocation", toolUseId: `tool-${index}`, state: random(2) };
        case 3:
          return {
            type: "tool-invocation",
            toolUseId: "patch",
            toolName: "apply_patch",
            content: `file ${index}`,
            nested: { list: [index, { deep: random(2) }], absent: undefined },
          };
        default:
          return { type: "thinking", content: `${index}`, createdAt: `t${random(2)}` };
      }
    };
    const randomParts = () => Array.from({ length: random(6) }, randomPart);
    const shuffledKeys = (part: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(part).reverse());

    for (let round = 0; round < 4000; round += 1) {
      const localParts = randomParts();
      const head = (() => {
        switch (random(5)) {
          case 0:
            return row(localParts);
          case 1:
            return row(structuredClone(localParts));
          case 2:
            return row(structuredClone(localParts.slice(random(localParts.length + 1))));
          case 3:
            return row(
              structuredClone(localParts)
                .slice(random(localParts.length + 1))
                .map((part) => (random(3) === 0 ? shuffledKeys(part) : part))
                .concat(random(2) === 0 ? [randomPart()] : []),
            );
          default:
            return row(randomParts());
        }
      })();
      const local = random(4) === 0 ? { ...row(localParts), extra: 1 } : row(localParts);
      const omitted = [undefined, 0, 1, 2, localParts.length][random(5)];
      const message = `round ${round}`;
      const held = random(10) === 0 ? undefined : [random(3) === 0 ? head : local];
      const next = preferCompleteLiveHead<unknown>(held, [head], omitted);
      const old = oldPreferCompleteLiveHead<unknown>(held, [head], omitted);
      expect(next, message).toEqual(old);
      // Which row object survives is what later identity checks read.
      expect(next.messages[0] === head, message).toBe(old.messages[0] === head);
      expect(next.messages[0] === held?.[0], message).toBe(old.messages[0] === held?.[0]);
    }
  });
});

function oldStringifyCalls(held: unknown, incoming: unknown, omitted: number): number {
  return stringifyCalls(() => {
    oldPreferCompleteLiveHead<unknown>([held], [incoming], omitted);
  });
}
