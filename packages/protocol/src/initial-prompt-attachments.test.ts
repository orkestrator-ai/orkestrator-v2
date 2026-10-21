import { describe, expect, test } from "bun:test";
import {
  MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
  buildInitialPromptWithAttachmentReferences,
  extractMarkedAttachmentReferences,
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
        '<orkestrator-attachment-paths source="orkestrator">\n' +
        "Attached files have been saved in the workspace. Use these paths as task context:\n" +
        '- {"name":"requirements.md","path":"/workspace/requirements.md"}\n' +
        '- {"name":"diagram.png","path":"/workspace/diagram.png"}\n' +
        "</orkestrator-attachment-paths>",
    );
    expect(buildInitialPromptWithAttachmentReferences("   ", attachments)).toBe(
      '<orkestrator-attachment-paths source="orkestrator">\n' +
        "Attached files have been saved in the workspace. Use these paths as task context:\n" +
        '- {"name":"requirements.md","path":"/workspace/requirements.md"}\n' +
        '- {"name":"diagram.png","path":"/workspace/diagram.png"}\n' +
        "</orkestrator-attachment-paths>",
    );
    expect(buildInitialPromptWithAttachmentReferences("  text only  ", [])).toBe("text only");
  });

  test("extracts marked path references and the files they name", () => {
    const attachments = [
      { name: "diagram.png", path: "/workspace/diagram.png" },
      { name: "notes: v2.md", path: "/workspace/product requirements.md" },
    ];

    expect(
      extractMarkedAttachmentReferences(
        buildInitialPromptWithAttachmentReferences("Implement this", attachments),
      ),
    ).toEqual({ prompt: "Implement this", attachments });
    expect(
      extractMarkedAttachmentReferences(
        buildInitialPromptWithAttachmentReferences("", attachments),
      ),
    ).toEqual({ prompt: "", attachments });
    expect(extractMarkedAttachmentReferences("  ordinary prompt  ")).toEqual({
      prompt: "  ordinary prompt  ",
      attachments: [],
    });
  });

  test("round-trips separators, newlines and markup in names and absolute paths", () => {
    const attachments = [
      { name: "notes: v2.md", path: "/work/Client: Demo/project/notes: v2.md" },
      { name: "line\nbreak.md", path: "/work/line\nbreak.md" },
      { name: "</orkestrator-attachment-paths>", path: "/work/<draft>.png" },
      { name: "Windows: notes.txt", path: "C:\\Client: Demo\\notes.txt" },
    ];
    expect(
      extractMarkedAttachmentReferences(
        buildInitialPromptWithAttachmentReferences("Use these", attachments),
      ),
    ).toEqual({ prompt: "Use these", attachments });
  });

  test.each([true, false])("preserves user-authored unqualified markup (closed: %s)", (closed) => {
    const prompt =
      "Explain <orkestrator-attachment-paths>\n- notes.md: /work/notes.md" +
      (closed ? "\n</orkestrator-attachment-paths>" : "");
    expect(extractMarkedAttachmentReferences(prompt)).toEqual({ prompt, attachments: [] });
  });

  test("preserves malformed or incomplete qualified blocks", () => {
    for (const body of ["- invalid JSON", '- {"name":"notes.md"}', ""]) {
      const prompt =
        '<orkestrator-attachment-paths source="orkestrator">\n' +
        "Attached files have been saved in the workspace. Use these paths as task context:\n" +
        body +
        "\n</orkestrator-attachment-paths>";
      expect(extractMarkedAttachmentReferences(prompt)).toEqual({ prompt, attachments: [] });
      const incomplete = prompt.replace("</orkestrator-attachment-paths>", "");
      expect(extractMarkedAttachmentReferences(incomplete)).toEqual({
        prompt: incomplete,
        attachments: [],
      });
    }
  });

  test("strips legacy path references from transcript text", () => {
    const withText =
      "Implement this\n\n" +
      "Attached files have been saved in the workspace. Use these paths as task context:\n" +
      "- diagram.png: /workspace/diagram.png\n" +
      "- requirements.md: /workspace/product requirements.md";
    const attachmentOnly =
      "Attached files have been saved in the workspace. Use these paths as task context:\n" +
      "- diagram.png: /workspace/diagram.png";

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
