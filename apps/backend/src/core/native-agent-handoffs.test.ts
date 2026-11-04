import { describe, expect, test } from "bun:test";

import { extractMarkedAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";

import { coordinatorPromptWithAttachmentPaths } from "./native-agent-handoffs.js";

const IMAGE = { type: "image", path: "/data/coordinator-attachments/c/conv/1.png" };

describe("coordinatorPromptWithAttachmentPaths", () => {
  test("names a pasted image's path for a coordinator, in the block transcripts remove", () => {
    const prompt = coordinatorPromptWithAttachmentPaths("Pass this on.", "coordinator:c:conv", [
      { ...IMAGE, filename: "clipboard.png" },
    ]);
    expect(prompt).toContain(IMAGE.path);
    // What the transcript shows the user is what they typed, plus the file.
    expect(extractMarkedAttachmentReferences(prompt)).toEqual({
      prompt: "Pass this on.",
      attachments: [{ name: "clipboard.png", path: IMAGE.path }],
    });
  });

  test("falls back to the stored name, and works for an image with no words", () => {
    const prompt = coordinatorPromptWithAttachmentPaths("", "coordinator:c:conv", [IMAGE]);
    expect(extractMarkedAttachmentReferences(prompt).attachments).toEqual([
      { name: "1.png", path: IMAGE.path },
    ]);
  });

  test("leaves everything else exactly as written", () => {
    expect(coordinatorPromptWithAttachmentPaths("Hi", "environment-1", [IMAGE])).toBe("Hi");
    expect(coordinatorPromptWithAttachmentPaths("Hi", "coordinator:c:conv", undefined)).toBe("Hi");
    expect(
      coordinatorPromptWithAttachmentPaths("Hi", "coordinator:c:conv", [
        { type: "file", path: "/data/notes.txt" },
      ]),
    ).toBe("Hi");
  });
});
