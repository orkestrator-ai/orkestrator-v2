import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  collectTranscriptPrompts,
  promptLineEmphasis,
  replyPreviewFor,
} from "./transcript-prompts";

function row(
  id: string,
  role: NativeMessage["role"],
  content: string,
  parts: NativeMessage["parts"] = [{ type: "text", content }],
): NativeMessage {
  return { id, role, content, parts, createdAt: "2026-11-05T00:00:00.000Z" };
}

describe("collectTranscriptPrompts", () => {
  test("lists what the user typed, in order, flattened to plain text", () => {
    const prompts = collectTranscriptPrompts(
      [
        row("a", "user", "Explain **this** [pull request](https://example.com).\n\nThanks"),
        row("b", "assistant", "Sure"),
        row("c", "system", "Compacted"),
        row("d", "user", "And then?"),
      ],
      [],
    );
    expect(prompts.map(({ id, text }) => [id, text])).toEqual([
      ["a", "Explain this pull request. Thanks"],
      ["d", "And then?"],
    ]);
  });

  test("agent mail and goal-loop turns carry the user role but are not prompts", () => {
    const prompts = collectTranscriptPrompts(
      [
        row("peer-mail-1", "user", "From a worker"),
        row("goal-turn-1", "user", "Keep going"),
        row("optimistic-1", "user", "Just sent"),
      ],
      [],
    );
    expect(prompts.map((prompt) => prompt.id)).toEqual(["optimistic-1"]);
  });

  test("an attachment-only prompt is named by its attachment", () => {
    const [prompt] = collectTranscriptPrompts(
      [row("a", "user", "", [{ type: "image", content: "screenshot.png" }])],
      [],
    );
    expect(prompt?.text).toBe("screenshot.png");
  });

  test("a long prompt is bounded", () => {
    const [prompt] = collectTranscriptPrompts([row("a", "user", "word ".repeat(10_000))], []);
    expect(prompt!.text.length).toBeLessThanOrEqual(300);
  });

  test("a streaming transcript keeps the same list, and each unchanged prompt", () => {
    const first = row("a", "user", "First");
    const previous = collectTranscriptPrompts([first, row("b", "assistant", "Str")], []);
    const streamed = [{ ...first }, row("b", "assistant", "Streaming more")];
    expect(collectTranscriptPrompts(streamed, previous)).toBe(previous);

    const next = collectTranscriptPrompts([...streamed, row("c", "user", "Second")], previous);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
  });

  test("losing the last prompt is a change", () => {
    const previous = collectTranscriptPrompts(
      [row("a", "user", "One"), row("b", "user", "Two")],
      [],
    );
    const next = collectTranscriptPrompts([row("a", "user", "One")], previous);
    expect(next.map((prompt) => prompt.id)).toEqual(["a"]);
  });
});

describe("replyPreviewFor", () => {
  const messages = [
    row("a", "user", "Question"),
    row("tools", "assistant", "", [{ type: "tool-invocation", content: "" }]),
    row("b", "assistant", "## What it is\n\nAn answer"),
    row("c", "user", "Unanswered"),
    row("mail", "user", "not a prompt", []),
  ];

  test("skips rows with no text and flattens the first that has some", () => {
    expect(replyPreviewFor(messages, "a")).toBe("What it is An answer");
  });

  test("is empty for a prompt not yet answered, or one that is gone", () => {
    expect(replyPreviewFor(messages.slice(0, 2), "a")).toBe("");
    expect(replyPreviewFor(messages, "c")).toBe("");
    expect(replyPreviewFor(messages, "missing")).toBe("");
  });
});

describe("promptLineEmphasis", () => {
  test("peaks under the pointer and falls away within a few lines", () => {
    expect(promptLineEmphasis(0)).toBe(1);
    expect(promptLineEmphasis(1)).toBeLessThan(1);
    expect(promptLineEmphasis(2)).toBeLessThan(promptLineEmphasis(1));
    expect(promptLineEmphasis(3)).toBe(0);
    expect(promptLineEmphasis(40)).toBe(0);
  });
});
