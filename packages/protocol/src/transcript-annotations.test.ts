import { describe, expect, test } from "bun:test";
import {
  buildPromptWithTranscriptAnnotations,
  parsePromptTranscriptReferences,
  stripTranscriptAnnotations,
} from "./transcript-annotations.js";

describe("stripTranscriptAnnotations", () => {
  test("leaves only the request text in front of an annotation block", () => {
    const prompt = buildPromptWithTranscriptAnnotations("  Review the hero frame  ", [
      { id: "design-1", text: "Frame Hero at revision 3", comment: "", source: "design" },
      { id: "excerpt-1", text: "Earlier answer", comment: "this one" },
    ]);

    expect(stripTranscriptAnnotations(prompt)).toBe("Review the hero frame");
  });

  test("returns an empty string for a prompt that is only annotations", () => {
    const prompt = buildPromptWithTranscriptAnnotations("", [
      { id: "browser-1", text: "Buy now", comment: "", source: "browser" },
    ]);

    expect(stripTranscriptAnnotations(prompt)).toBe("");
  });

  test("returns a prompt without annotations unchanged", () => {
    expect(stripTranscriptAnnotations("  Plain request\n")).toBe("  Plain request\n");
  });

  test("matches the text the transcript renders, including a malformed block", () => {
    const malformed =
      "Keep this\n\n<orkestrator_transcript_annotations>\nnot the envelope\n</orkestrator_transcript_annotations>";

    expect(stripTranscriptAnnotations(malformed)).toBe(
      parsePromptTranscriptReferences(malformed).cleanPrompt,
    );
    expect(stripTranscriptAnnotations(malformed)).toBe(malformed);
  });
});
