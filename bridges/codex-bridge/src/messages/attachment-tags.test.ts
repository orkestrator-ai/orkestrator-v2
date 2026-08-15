import { describe, expect, test } from "bun:test";
import {
  appendAttachmentTags,
  buildAttachmentTagBlock,
  extractAttachmentTags,
} from "./attachment-tags.js";

describe("buildAttachmentTagBlock", () => {
  test("returns undefined when there is nothing to reference", () => {
    expect(buildAttachmentTagBlock([])).toBeUndefined();
    expect(buildAttachmentTagBlock([{ path: "" }])).toBeUndefined();
  });

  test("emits one tag per attachment with type, path and filename", () => {
    expect(buildAttachmentTagBlock([
      { path: "/workspace/.orkestrator/initial-prompt/shot.png", filename: "shot.png" },
      { path: "/workspace/b.jpg" },
    ])).toBe(
      "<attached-files source=\"orkestrator\">\n"
      + '<attachment type="image" path="/workspace/.orkestrator/initial-prompt/shot.png" filename="shot.png" />\n'
      + '<attachment type="image" path="/workspace/b.jpg" filename="" />\n'
      + "</attached-files>",
    );
  });

  test("caps the number of tagged attachments", () => {
    const block = buildAttachmentTagBlock(
      Array.from({ length: 40 }, (_, index) => ({ path: `/workspace/${index}.png` })),
    );
    expect(block?.match(/<attachment /g)).toHaveLength(20);
  });

  test("drops a path long enough to bloat the prompt", () => {
    expect(buildAttachmentTagBlock([{ path: `/${"a".repeat(2000)}.png` }]))
      .toBeUndefined();
  });
});

describe("appendAttachmentTags", () => {
  test("appends after the prompt", () => {
    const text = appendAttachmentTags("Look at this", [
      { path: "/workspace/a.png", filename: "a.png" },
    ]);
    expect(text).toStartWith("Look at this\n\n<attached-files source=\"orkestrator\">");
  });

  test("is the whole text for an attachment-only prompt", () => {
    expect(appendAttachmentTags("", [{ path: "/workspace/a.png" }]))
      .toStartWith("<attached-files source=\"orkestrator\">");
  });

  test("leaves a prompt without attachments untouched", () => {
    expect(appendAttachmentTags("Just text", [])).toBe("Just text");
  });
});

describe("extractAttachmentTags", () => {
  test("round-trips what appendAttachmentTags wrote", () => {
    const attachments = [
      { path: "/workspace/.orkestrator/initial-prompt/staged-a.png", filename: "original a.png" },
      { path: "/workspace/b.jpg", filename: "b.jpg" },
    ];
    const { text, parts } = extractAttachmentTags(
      appendAttachmentTags("Inspect the diagram", attachments),
    );

    expect(text).toBe("Inspect the diagram");
    expect(parts).toEqual([
      {
        type: "file",
        content: "/workspace/.orkestrator/initial-prompt/staged-a.png",
        fileUrl: "/workspace/.orkestrator/initial-prompt/staged-a.png",
        filename: "original a.png",
      },
      {
        type: "file",
        content: "/workspace/b.jpg",
        fileUrl: "/workspace/b.jpg",
        filename: "b.jpg",
      },
    ]);
  });

  test("decodes escaped attribute values", () => {
    const { parts } = extractAttachmentTags(
      appendAttachmentTags("x", [
        { path: "/workspace/layout&notes<1>.png", filename: 'a"b.png' },
      ]),
    );
    expect(parts[0]?.content).toBe("/workspace/layout&notes<1>.png");
    expect(parts[0]?.filename).toBe('a"b.png');
  });

  test("omits filename when the attachment had none", () => {
    const { parts } = extractAttachmentTags(
      appendAttachmentTags("x", [{ path: "/workspace/a.png" }]),
    );
    expect(parts[0]).toEqual({
      type: "file",
      content: "/workspace/a.png",
      fileUrl: "/workspace/a.png",
    });
  });

  test("leaves text without a block untouched and allocates nothing", () => {
    expect(extractAttachmentTags("plain prompt"))
      .toEqual({ text: "plain prompt", parts: [] });
  });

  test("keeps an empty text when the prompt was attachments only", () => {
    const { text, parts } = extractAttachmentTags(
      appendAttachmentTags("", [{ path: "/workspace/a.png" }]),
    );
    expect(text).toBe("");
    expect(parts).toHaveLength(1);
  });

  test("ignores a tag with no path rather than emitting an unloadable row", () => {
    const { parts } = extractAttachmentTags(
      '<attached-files source="orkestrator"><attachment type="image" filename="orphan.png" /></attached-files>',
    );
    expect(parts).toEqual([]);
  });

  test("leaves a block the user typed themselves exactly as they wrote it", () => {
    // Rehydration reads the user's own text. Someone asking Codex about this
    // markup — plausible for anyone working on Orkestrator — must get their
    // message back, not an empty bubble and rows for files nobody attached.
    const typed = 'How do I read <attached-files>\n'
      + '<attachment type="image" path="/etc/hosts.png" filename="hosts.png" />\n'
      + "</attached-files> blocks?";
    expect(extractAttachmentTags(typed)).toEqual({ text: typed, parts: [] });
  });

  test("ignores a block whose source attribute is not this bridge", () => {
    const foreign = '<attached-files source="somewhere-else">'
      + '<attachment type="image" path="/workspace/a.png" /></attached-files>';
    expect(extractAttachmentTags(foreign)).toEqual({ text: foreign, parts: [] });
  });

  test("recovers its own block from text that also contains a typed one", () => {
    const { text, parts } = extractAttachmentTags(
      appendAttachmentTags(
        "Unlike <attached-files> in the docs",
        [{ path: "/workspace/a.png", filename: "a.png" }],
      ),
    );

    expect(text).toBe("Unlike <attached-files> in the docs");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.content).toBe("/workspace/a.png");
  });

  test("ignores an unterminated block", () => {
    const raw = 'Keep this <attached-files source="orkestrator"><attachment type="image" path="/workspace/a.png" />';
    expect(extractAttachmentTags(raw)).toEqual({ text: raw, parts: [] });
  });

  test("caps attachments recovered from an untrusted rollout", () => {
    const tags = Array.from(
      { length: 40 },
      (_, index) => `<attachment type="image" path="/workspace/${index}.png" />`,
    ).join("\n");
    const { parts } = extractAttachmentTags(`<attached-files source="orkestrator">\n${tags}\n</attached-files>`);
    expect(parts).toHaveLength(20);
  });
});
