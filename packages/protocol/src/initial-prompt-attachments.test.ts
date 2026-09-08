import { describe, expect, test } from "bun:test";
import {
  MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
  buildInitialPromptWithAttachmentReferences,
  serializedInitialPromptAttachmentBytes,
  stripInitialPromptAttachmentReferences,
  toDurableInitialPromptAttachments,
} from "./initial-prompt-attachments";

describe("initial prompt attachment protocol", () => {
  test("formats text and paths consistently for every launch mode", () => {
    const attachments = [
      { name: "requirements.md", path: "/workspace/requirements.md" },
      { name: "diagram.png", path: "/workspace/diagram.png" },
    ];

    expect(buildInitialPromptWithAttachmentReferences("  Implement this  ", attachments)).toBe(
      "Implement this\n\n" +
        "Attached files have been saved in the workspace. Use these paths as task context:\n" +
        "- requirements.md: /workspace/requirements.md\n" +
        "- diagram.png: /workspace/diagram.png",
    );
    expect(buildInitialPromptWithAttachmentReferences("   ", attachments)).toBe(
      "Attached files have been saved in the workspace. Use these paths as task context:\n" +
        "- requirements.md: /workspace/requirements.md\n" +
        "- diagram.png: /workspace/diagram.png",
    );
    expect(buildInitialPromptWithAttachmentReferences("  text only  ", [])).toBe("text only");
  });

  test("strips generated path references from transcript text", () => {
    const withText = buildInitialPromptWithAttachmentReferences("Implement this", [
      { name: "diagram.png", path: "/workspace/diagram.png" },
      { name: "requirements.md", path: "/workspace/product requirements.md" },
    ]);
    const attachmentOnly = buildInitialPromptWithAttachmentReferences("", [
      { name: "diagram.png", path: "/workspace/diagram.png" },
    ]);

    expect(
      stripInitialPromptAttachmentReferences(withText, [
        { name: "diagram.png", path: "/workspace/diagram.png" },
        { name: "requirements.md", path: "/workspace/product requirements.md" },
      ]),
    ).toBe("Implement this");
    expect(
      stripInitialPromptAttachmentReferences(attachmentOnly, [
        { name: "diagram.png", path: "/workspace/diagram.png" },
      ]),
    ).toBe("");
  });

  test("preserves no-op input byte-for-byte", () => {
    expect(stripInitialPromptAttachmentReferences("  ordinary prompt  ", [])).toBe(
      "  ordinary prompt  ",
    );
    expect(stripInitialPromptAttachmentReferences("  \n\t ", [])).toBe("  \n\t ");
    expect(
      stripInitialPromptAttachmentReferences("  ordinary prompt  ", [
        { name: "diagram.png", path: "/workspace/diagram.png" },
      ]),
    ).toBe("  ordinary prompt  ");
  });

  test("preserves reference-shaped prose without matching attachment metadata", () => {
    const userAuthored =
      "Document this format:\n\n" +
      "Attached files have been saved in the workspace. Use these paths as task context:\n" +
      "- name: value";

    expect(stripInitialPromptAttachmentReferences(userAuthored, [])).toBe(userAuthored);
    expect(
      stripInitialPromptAttachmentReferences(userAuthored, [{ name: "other", path: "value" }]),
    ).toBe(userAuthored);
  });

  test("handles only supported separators before a matching reference block", () => {
    const attachment = { name: "diagram.png", path: "/workspace/diagram.png" };
    const heading =
      "Attached files have been saved in the workspace. Use these paths as task context:";
    const extraBlankLines = `Implement this\n\n\n${heading}\n- diagram.png: /workspace/diagram.png`;
    const loneNewline = `Implement this\n${heading}\n- diagram.png: /workspace/diagram.png`;

    expect(stripInitialPromptAttachmentReferences(extraBlankLines, [attachment])).toBe(
      "Implement this",
    );
    expect(stripInitialPromptAttachmentReferences(loneNewline, [attachment])).toBe(loneNewline);
  });

  test("measures only the durable representation and preserves attachment kinds", () => {
    const attachments = [
      {
        id: "legacy-image",
        name: "legacy.png",
        previewUrl: `data:image/png;base64,${"A".repeat(10_000)}`,
        base64Data: "QUJD",
      },
      {
        id: "file",
        name: "requirements.md",
        type: "file" as const,
        base64Data: "UkVRVUlSRU1FTlRT",
      },
    ];
    const durable = toDurableInitialPromptAttachments(attachments);

    expect(durable).toEqual([
      { id: "legacy-image", name: "legacy.png", base64Data: "QUJD" },
      {
        id: "file",
        name: "requirements.md",
        type: "file",
        base64Data: "UkVRVUlSRU1FTlRT",
      },
    ]);
    expect(serializedInitialPromptAttachmentBytes(attachments)).toBe(
      new TextEncoder().encode(JSON.stringify(durable)).byteLength,
    );
  });

  test("accounts for base64 inflation at the three-file boundary", () => {
    const eightMegabyteBase64Length = Math.ceil((8 * 1024 * 1024) / 3) * 4;
    const attachments = Array.from({ length: 3 }, (_, index) => ({
      id: `file-${index}`,
      name: `file-${index}.bin`,
      type: "file" as const,
      base64Data: "A".repeat(eightMegabyteBase64Length),
    }));

    expect(serializedInitialPromptAttachmentBytes(attachments)).toBeGreaterThan(
      MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
    );
  });
});
