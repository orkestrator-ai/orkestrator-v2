import { describe, expect, test } from "bun:test";
import {
  buildInitialPromptWithAttachmentReferences,
  extractMarkedAttachmentReferences,
} from "@orkestrator/protocol/initial-prompt-attachments";
import {
  queuedPromptAttachments,
  queuedPromptDisplay,
  queuedPromptEditText,
} from "./queued-prompt-text";

const shotPath = "/workspace/.orkestrator/attachments/a/shot.png";
const notesPath = "/workspace/.orkestrator/attachments/b/notes.md";
const withShot = buildInitialPromptWithAttachmentReferences("Compare against this", [
  { name: "shot.png", path: shotPath },
]);

describe("queuedPromptDisplay", () => {
  test("strips the marked block and lists the files it names", () => {
    expect(queuedPromptDisplay(withShot)).toEqual({
      text: "Compare against this",
      attachments: [{ name: "shot.png", path: shotPath }],
    });
  });

  test("prefers the item's structured attachments", () => {
    const attachments = [{ name: "shot.png", path: shotPath, type: "image" as const }];
    expect(queuedPromptDisplay(withShot, attachments)).toEqual({
      text: "Compare against this",
      attachments,
    });
  });

  test("leaves text without a valid marked block alone", () => {
    expect(queuedPromptDisplay("Just text")).toEqual({ text: "Just text", attachments: [] });
    const typed =
      "Attached files have been saved in the workspace. Use these paths as task context:\n" +
      `- shot.png: ${shotPath}`;
    expect(queuedPromptDisplay(typed).text).toBe(typed);
  });
});

describe("queuedPromptAttachments", () => {
  test("reads the queue record defensively", () => {
    expect(queuedPromptAttachments({ attachments: "nope" })).toEqual([]);
    expect(
      queuedPromptAttachments({
        attachments: [
          { type: "image", path: shotPath, filename: "shot.png" },
          { type: "file", path: notesPath },
          null,
          { type: "other" },
        ],
      }),
    ).toEqual([
      { name: "shot.png", path: shotPath, type: "image" },
      { name: "notes.md", path: notesPath, type: "file" },
      { name: "attachment" },
    ]);
  });
});

describe("queuedPromptEditText", () => {
  test("removes the block when it names exactly the restored attachments", () => {
    expect(queuedPromptEditText(withShot, [{ path: shotPath }])).toBe("Compare against this");
  });

  test("sending the edited draft again rebuilds exactly one block", () => {
    const edited = queuedPromptEditText(withShot, [{ path: shotPath }]);
    const resent = buildInitialPromptWithAttachmentReferences(edited, [
      { name: "shot.png", path: shotPath },
    ]);
    expect(resent).toBe(withShot);
    expect(resent.split("<orkestrator-attachment-paths").length - 1).toBe(1);
  });

  test("keeps the text when the block names files the draft would not restore", () => {
    expect(queuedPromptEditText(withShot, [])).toBe(withShot);
    expect(queuedPromptEditText(withShot, [{ path: notesPath }])).toBe(withShot);
    const both = buildInitialPromptWithAttachmentReferences("Two", [
      { name: "shot.png", path: shotPath },
      { name: "notes.md", path: notesPath },
    ]);
    expect(queuedPromptEditText(both, [{ path: shotPath }])).toBe(both);
    expect(queuedPromptEditText("Plain", [{ path: shotPath }])).toBe("Plain");
  });
});

// Inexact sets intentionally retain references that the restored draft cannot
// recreate. Resend may use two transport blocks; neither file may be lost and
// neither block may leak into the queue's visible text.
test.each([
  ["different file", withShot, [{ name: "notes.md", path: notesPath }], [shotPath, notesPath]],
  [
    "subset",
    buildInitialPromptWithAttachmentReferences("Compare against this", [
      { name: "shot.png", path: shotPath },
      { name: "notes.md", path: notesPath },
    ]),
    [{ name: "shot.png", path: shotPath }],
    [shotPath, notesPath],
  ],
  [
    "superset",
    withShot,
    [
      { name: "shot.png", path: shotPath },
      { name: "notes.md", path: notesPath },
    ],
    [shotPath, notesPath],
  ],
] as const)(
  "edit and resend with an inexact path set preserves every reference: %s",
  (_label, original, restored, paths) => {
    const edited = queuedPromptEditText(original, restored);
    expect(edited).toBe(original);
    const resent = buildInitialPromptWithAttachmentReferences(edited, restored);
    const extracted = extractMarkedAttachmentReferences(resent);
    expect([...new Set(extracted.attachments.map(({ path }) => path))].sort()).toEqual(
      [...paths].sort(),
    );
    expect(queuedPromptDisplay(resent).text).toBe("Compare against this");
    expect(resent.split("<orkestrator-attachment-paths").length - 1).toBe(2);
  },
);
