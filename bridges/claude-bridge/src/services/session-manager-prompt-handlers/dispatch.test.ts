import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { promptMessageHandler } from "./dispatch.js";
import { LEAF_MESSAGE_HANDLERS } from "./leaf.js";
import { turnFixture } from "./turn-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("prompt message dispatch", () => {
  test.each(Object.keys(LEAF_MESSAGE_HANDLERS))("%p goes to its leaf handler", (type) => {
    expect(promptMessageHandler(type)).toBe(
      LEAF_MESSAGE_HANDLERS[type as keyof typeof LEAF_MESSAGE_HANDLERS]!,
    );
  });

  test.each(["constructor", "toString", "__proto__"])(
    "%p never resolves to a prototype member",
    (type) => {
      const { turn, dispose } = turnFixture();
      cleanups.push(dispose);
      expect(promptMessageHandler(type)(turn, { type } as unknown as SDKMessage)).toBeUndefined();
    },
  );

  test.each([
    ["invented_later", ["invented_later"]],
    [undefined, ["(untyped)"]],
    ["command_lifecycle", undefined],
  ])("an unclaimed %p frame is recorded as %p", (type, unknownKinds) => {
    const { session, turn, dispose } = turnFixture();
    cleanups.push(dispose);
    const handled = promptMessageHandler(type)(turn, { type } as unknown as SDKMessage);
    expect(handled).toBeUndefined();
    expect(session.health?.drift()?.unknownKinds).toEqual(unknownKinds);
  });
});
