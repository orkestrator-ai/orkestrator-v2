import { describe, expect, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import { PreviewFillAnswers, previewFillToken } from "./native-agent-preview-fill.js";

const liveWindow = { messages: 100, targetBytes: 4_096 } as const;

/** A row that counts how often it is serialized; spreading it drops the counter. */
function countedRow(id: string, bytes: number, counter: { count: number }) {
  const row = { id, role: "assistant", content: "x".repeat(bytes), parts: [] as unknown[] };
  Object.defineProperty(row, "toJSON", {
    enumerable: false,
    value: () => {
      counter.count += 1;
      return { ...row };
    },
  });
  return row;
}

function snapshot(
  messages: unknown[],
  fields: Partial<ProviderTranscriptSnapshot> = {},
): ProviderTranscriptSnapshot {
  return { messages, complete: false, freshness: "current", ...fields };
}

describe("preview fill answers", () => {
  test("answers exactly as measuring the whole raw window", () => {
    const answers = new PreviewFillAnswers();
    for (const bytes of [100, 2_000, 4_000, 4_050, 4_060, 5_000]) {
      const counter = { count: 0 };
      const messages = [countedRow("a", bytes, counter)];
      const expected = Buffer.byteLength(JSON.stringify(messages)) >= liveWindow.targetBytes;
      expect(answers.fills(`view-${bytes}`, snapshot(messages), liveWindow)).toBe(expected);
    }
    // Multi-byte text counts in UTF-8 bytes, not characters.
    const wide = [{ id: "w", content: "é".repeat(2_100) }];
    expect(JSON.stringify(wide).length).toBeLessThan(liveWindow.targetBytes);
    expect(answers.fills("wide", snapshot(wide), liveWindow)).toBe(true);
  });

  test("a full count fills the window without measuring", () => {
    const counter = { count: 0 };
    const rows = Array.from({ length: 100 }, (_, index) => countedRow(`m${index}`, 1, counter));
    expect(new PreviewFillAnswers().fills("view", snapshot(rows), liveWindow)).toBe(true);
    expect(counter.count).toBe(0);
  });

  test("measures once per source token and again when the token moves", () => {
    const answers = new PreviewFillAnswers();
    const counter = { count: 0 };
    const read = (token: string, bytes: number) =>
      answers.fills(
        "view",
        snapshot([countedRow("a", bytes, counter)], { sourceToken: token }),
        liveWindow,
      );
    expect(read("t1", 100)).toBe(false);
    expect(read("t1", 100)).toBe(false);
    expect(counter.count).toBe(1);
    expect(read("t2", 5_000)).toBe(true);
    expect(read("t2", 5_000)).toBe(true);
    expect(counter.count).toBe(2);
    expect(answers.size).toBe(1);
  });

  test("trusts a derived token only when it carries the provider's revision", () => {
    const answers = new PreviewFillAnswers();
    const counter = { count: 0 };
    const read = (fields: Partial<ProviderTranscriptSnapshot>, bytes = 100) =>
      answers.fills("view", snapshot([countedRow("a", bytes, counter)], fields), liveWindow);
    read({ revision: 3 });
    read({ revision: 3 });
    expect(counter.count).toBe(1);
    read({ revision: 4 });
    expect(counter.count).toBe(2);
    // Same count and edge ids, no revision: a streaming tail keeps that token
    // while it grows past the target, so the answer is never reused.
    expect(read({})).toBe(false);
    expect(read({}, 5_000)).toBe(true);
    expect(counter.count).toBe(4);
    expect(answers.size).toBe(0);
  });

  test("keys the answer by view and live-window target", () => {
    const answers = new PreviewFillAnswers();
    const counter = { count: 0 };
    const messages = [countedRow("a", 3_000, counter)];
    expect(answers.fills("left", snapshot(messages, { sourceToken: "t" }), liveWindow)).toBe(false);
    expect(answers.fills("right", snapshot(messages, { sourceToken: "t" }), liveWindow)).toBe(
      false,
    );
    expect(
      answers.fills("left", snapshot(messages, { sourceToken: "t" }), {
        messages: 100,
        targetBytes: 1_024,
      }),
    ).toBe(true);
    expect(counter.count).toBe(3);
    expect(previewFillToken(snapshot([], { sourceToken: "t" }), 1)).not.toBe(
      previewFillToken(snapshot([], { sourceToken: "t" }), 2),
    );
  });

  test("forgets a session's views and stays within its bound", () => {
    const answers = new PreviewFillAnswers(2);
    const fill = (key: string) =>
      answers.fills(key, snapshot([{ id: key }], { sourceToken: key }), liveWindow);
    fill("session-a\0view-1");
    fill("session-a\0view-2");
    fill("session-b\0view-1");
    expect(answers.size).toBe(2);
    answers.forgetPrefix("session-a\0");
    expect(answers.size).toBe(1);
    answers.clear();
    expect(answers.size).toBe(0);
  });

  test("drops the least recently asked view first", () => {
    const answers = new PreviewFillAnswers(2);
    const counter = { count: 0 };
    const fill = (key: string) =>
      answers.fills(
        key,
        snapshot([countedRow(key, 10, counter)], { sourceToken: key }),
        liveWindow,
      );
    fill("a");
    fill("b");
    fill("a"); // reused, and now the most recent
    fill("c"); // evicts b
    expect(counter.count).toBe(3);
    fill("a");
    expect(counter.count).toBe(3);
    fill("b");
    expect(counter.count).toBe(4);
  });
});
