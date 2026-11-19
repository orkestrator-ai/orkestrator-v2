import { describe, expect, test } from "bun:test";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import {
  queuedPromptEditCommit,
  queuedPromptEditEmpty,
  queuedPromptEditSource,
  queuedPromptEditStates,
} from "./prompt-queue-edit";

const file = { type: "file" as const, path: "/workspace/a.txt", filename: "a.txt" };
const image = { type: "image" as const, path: "/workspace/b.png", filename: "b.png" };

describe("queued prompt edit text", () => {
  test("hides a path-reference block that names exactly the attachments, and rebuilds it", () => {
    const stored = {
      id: "m",
      text: buildInitialPromptWithAttachmentReferences("Look at these", [
        { name: "a.txt", path: file.path },
        { name: "b.png", path: image.path },
      ]),
      attachments: [file, image],
    };
    const source = queuedPromptEditSource(stored);
    expect(source).toEqual({
      text: "Look at these",
      attachments: [file, image],
      referencesStripped: true,
    });

    const commit = queuedPromptEditCommit(source, "Look at this one", [image]);
    expect(commit).toEqual({
      text: buildInitialPromptWithAttachmentReferences("Look at this one", [
        { name: "b.png", path: image.path },
      ]),
      attachments: [image],
    });
    // Removing the last file removes the block with it.
    expect(queuedPromptEditCommit(source, "Just text", [])).toEqual({
      text: "Just text",
      attachments: [],
    });
  });

  test("leaves text alone when there is no block to hide", () => {
    const source = queuedPromptEditSource({ id: "m", text: "plain", attachments: [image] });
    expect(source.referencesStripped).toBe(false);
    expect(queuedPromptEditCommit(source, "plain, edited", [image])).toEqual({
      text: "plain, edited",
      attachments: [image],
    });
  });

  test("drops malformed stored attachments", () => {
    expect(
      queuedPromptEditSource({
        id: "m",
        text: "x",
        attachments: [file, { type: "file" }, { type: "video", path: "/v" }, null],
      }).attachments,
    ).toEqual([file]);
  });

  test("a prompt with no text and no files is empty", () => {
    expect(queuedPromptEditEmpty("  ", [])).toBe(true);
    expect(queuedPromptEditEmpty("", [file])).toBe(false);
    expect(queuedPromptEditEmpty("x", [])).toBe(false);
  });
});

describe("queued prompt edit states", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const live = new Date(now + 30_000).toISOString();
  const expired = new Date(now - 1).toISOString();

  test("tells this client's edit from another's, and a live one from an unfinished one", () => {
    const states = queuedPromptEditStates(
      [
        { messageId: "mine", leaseId: "lease-mine", expiresAt: live },
        { messageId: "theirs", leaseId: "lease-theirs", expiresAt: live },
        { messageId: "left", leaseId: "lease-left", expiresAt: expired },
      ],
      "lease-mine",
      now,
    );
    expect(Object.fromEntries(states)).toEqual({
      mine: "local",
      theirs: "elsewhere",
      left: "review",
    });
  });

  test("no editing list means no states", () => {
    expect(queuedPromptEditStates(undefined, undefined, now).size).toBe(0);
  });
});
