import { describe, expect, test } from "bun:test";
import { buildPromptWithTranscriptAnnotations } from "@orkestrator/protocol/transcript-annotations";
import { titleFromTranscriptHead } from "./tmux-hooks.js";

function userLine(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

describe("titleFromTranscriptHead", () => {
  test("titles a tmux session from the request, not the annotation block after it", () => {
    const request = "Explain why the reconnect banner flickers after a resume in the web app";
    const prompt = buildPromptWithTranscriptAnnotations(request, [
      { id: "excerpt-1", text: "The banner re-renders on every poll", comment: "this part" },
    ]);
    const head = `${JSON.stringify({ type: "summary" })}\n${userLine(prompt)}\n`;

    expect(titleFromTranscriptHead(head, false)).toBe(request);
  });

  test("skips a first message that is only an annotation block", () => {
    const annotationsOnly = buildPromptWithTranscriptAnnotations("", [
      { id: "excerpt-1", text: "Quoted output", comment: "" },
    ]);
    const head = `${userLine(annotationsOnly)}\n${userLine("Follow-up request")}\n`;

    expect(titleFromTranscriptHead(head, false)).toBe("Follow-up request");
  });

  test("keeps a malformed block visible, as the transcript does", () => {
    const text =
      "<orkestrator_transcript_annotations>not json</orkestrator_transcript_annotations>";

    expect(titleFromTranscriptHead(`${userLine(text)}\n`, false)).toBe(text.slice(0, 80) + "...");
  });
});
