import { expect, test } from "bun:test";
import {
  boundAdoptedTranscript,
  MAX_ADOPTED_BYTES,
  MAX_ADOPTED_MESSAGES,
  MAX_ADOPTED_STRING_CHARS,
} from "./auto-pipeline-transcript.js";

const message = (index: number, content = `message ${index}`) => ({
  id: `m${index}`,
  role: index % 2 ? "assistant" : "user",
  content,
  parts: [{ type: "text", content }],
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("a transcript inside every limit is kept whole and in order", () => {
  const messages = Array.from({ length: 50 }, (_, index) => message(index));
  expect(boundAdoptedTranscript(messages)).toEqual(messages);
});

test("does not modify its input", () => {
  const messages = [message(0, "x".repeat(MAX_ADOPTED_STRING_CHARS * 2))];
  const before = JSON.stringify(messages);
  boundAdoptedTranscript(messages);
  expect(JSON.stringify(messages)).toBe(before);
});

test("a long string keeps its start and says how much was left out", () => {
  const [kept] = boundAdoptedTranscript([
    message(0, `${"a".repeat(MAX_ADOPTED_STRING_CHARS)}${"b".repeat(100)}`),
  ]) as ReturnType<typeof message>[];
  expect(kept?.content.startsWith("a".repeat(MAX_ADOPTED_STRING_CHARS))).toBe(true);
  expect(kept?.content).toContain("100 characters omitted");
  expect(kept?.parts[0]?.content).toContain("100 characters omitted");
});

test("one huge tool result cannot take the budget of the messages around it", () => {
  const messages = [
    message(0),
    { ...message(1), parts: [{ type: "tool", output: "z".repeat(50 * 1024 * 1024) }] },
    message(2),
  ];
  const bounded = boundAdoptedTranscript(messages);
  expect(bounded).toHaveLength(3);
  expect(bytes(bounded)).toBeLessThan(MAX_ADOPTED_BYTES);
});

test("keeps the first message and the newest ones that fit when there are too many", () => {
  const messages = Array.from({ length: MAX_ADOPTED_MESSAGES * 3 }, (_, index) => message(index));
  const bounded = boundAdoptedTranscript(messages) as ReturnType<typeof message>[];
  expect(bounded).toHaveLength(MAX_ADOPTED_MESSAGES);
  expect(bounded[0]?.id).toBe("m0");
  expect(bounded.at(-1)?.id).toBe(`m${messages.length - 1}`);
  // The tail is contiguous: nothing newer is dropped to keep something older.
  const ids = bounded.slice(1).map((entry) => Number(entry.id.slice(1)));
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => ids[0]! + i));
});

test("stays inside the byte budget however many large messages there are", () => {
  const messages = Array.from({ length: 2_000 }, (_, index) =>
    message(index, "y".repeat(MAX_ADOPTED_STRING_CHARS)),
  );
  const bounded = boundAdoptedTranscript(messages) as ReturnType<typeof message>[];
  expect(bytes(bounded)).toBeLessThanOrEqual(MAX_ADOPTED_BYTES);
  expect(bounded.at(-1)?.id).toBe("m1999");
});

test("a message too large even after capping is replaced, not dropped or fatal", () => {
  const wide = {
    id: "wide",
    role: "assistant",
    parts: Array.from({ length: 200_000 }, () => "p".repeat(40)),
  };
  const bounded = boundAdoptedTranscript([message(0), wide, message(2)]) as Record<
    string,
    unknown
  >[];
  expect(bounded).toHaveLength(3);
  expect(bounded[1]).toMatchObject({
    role: "assistant",
    content: expect.stringContaining("omitted"),
  });
});

test("deeply nested content is cut rather than followed without limit", () => {
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 5_000; depth++) nested = { child: nested };
  const bounded = boundAdoptedTranscript([{ role: "assistant", parts: [nested] }]);
  expect(bytes(bounded)).toBeLessThan(10_000);
});

test("an empty transcript stays empty", () => {
  expect(boundAdoptedTranscript([])).toEqual([]);
});
