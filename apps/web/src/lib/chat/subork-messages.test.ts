import { describe, expect, test } from "bun:test";
import {
  renderSuborkRequestCarrier,
  type NativeAgentSuborkBatchView,
} from "@orkestrator/protocol/suborks";
import { isClientOnlyNativeMessage } from "./client-only-messages";
import type { NativeMessage } from "./native-message-types";
import { withSuborkGroupRows, withSuborkRequestText } from "./subork-messages";

function row(id: string, createdAt: string, content = id): NativeMessage {
  return { id, role: "user", content, createdAt, parts: [{ type: "text", content }] };
}

function batch(id: string, createdAt: string): NativeAgentSuborkBatchView {
  return { id, createdAt, status: "running", delivery: "waiting", suborks: [] };
}

describe("withSuborkRequestText", () => {
  test("shows the person's own words for a carrier row", () => {
    const shown = withSuborkRequestText(
      row("a", "2026-11-04T00:00:00Z", renderSuborkRequestCarrier("ask codex to look")),
    );
    expect(shown.content).toBe("/subork ask codex to look");
    expect(shown.parts).toEqual([{ type: "text", content: "/subork ask codex to look" }]);
  });

  test("leaves anything else alone", () => {
    const plain = row("a", "2026-11-04T00:00:00Z");
    expect(withSuborkRequestText(plain)).toBe(plain);
    const assistant = {
      ...row("b", "2026-11-04T00:00:00Z", renderSuborkRequestCarrier("x")),
      role: "assistant" as const,
    };
    expect(withSuborkRequestText(assistant)).toBe(assistant);
  });
});

describe("withSuborkGroupRows", () => {
  const messages = [row("a", "2026-11-04T00:00:00Z"), row("b", "2026-11-04T00:02:00Z")];

  test("places each call where it happened, as a client-only row", () => {
    const rows = withSuborkGroupRows(messages, [batch("x", "2026-11-04T00:01:00Z")]);
    expect(rows.map((message) => message.id)).toEqual(["a", "subork-group-x", "b"]);
    expect(isClientOnlyNativeMessage(rows[1]!)).toBe(true);
    expect(rows[1]!.suborkGroup?.id).toBe("x");
  });

  test("a call after the last message goes last, and none changes nothing", () => {
    const rows = withSuborkGroupRows(messages, [batch("x", "2026-11-04T00:03:00Z")]);
    expect(rows.at(-1)!.id).toBe("subork-group-x");
    expect(withSuborkGroupRows(messages, undefined)).toEqual(messages);
  });

  test("a call older than a window that can page back waits for its turn", () => {
    const older = batch("x", "2026-11-03T00:00:00Z");
    expect(withSuborkGroupRows(messages, [older], { canLoadEarlier: true })).toEqual(messages);
    expect(withSuborkGroupRows(messages, [older])[0]!.id).toBe("subork-group-x");
  });
});
