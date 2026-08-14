import { describe, expect, test } from "bun:test";
import {
  MAX_PROMPT_ATTACHMENTS,
  resolveWorkspaceAttachment,
  retainSupportedAttachments,
} from "./workspace-attachments";
import type { FileCandidate } from "@/types";

const textFile: FileCandidate = {
  filename: "notes.md",
  relativePath: "docs/notes.md",
  extension: ".md",
};
const imageFile: FileCandidate = {
  filename: "shot.png",
  relativePath: "docs/shot.png",
  extension: ".png",
};

const local = { worktreePath: "/work/tree", allowFiles: true, allowImages: true };

describe("resolveWorkspaceAttachment", () => {
  test("resolves a workspace-relative path for a local environment", () => {
    const resolved = resolveWorkspaceAttachment(textFile, local);
    expect(resolved).toEqual({
      attachment: expect.objectContaining({
        type: "file",
        path: "/work/tree/docs/notes.md",
        name: "notes.md",
      }),
    });
  });

  test("resolves against the container root when containerised", () => {
    const resolved = resolveWorkspaceAttachment(imageFile, {
      ...local,
      containerId: "container-1",
    });
    expect(resolved).toEqual({
      attachment: expect.objectContaining({ type: "image", path: "/workspace/docs/shot.png" }),
    });
  });

  test("refuses an image when the selected model cannot read images", () => {
    const resolved = resolveWorkspaceAttachment(imageFile, {
      ...local,
      modelSupportsImages: false,
      modelLabel: "Text Only 1",
    });
    expect(resolved).toMatchObject({ error: "Model cannot read images" });
    expect("attachment" in resolved).toBe(false);
  });

  test("treats an unreported image capability as capable", () => {
    expect(resolveWorkspaceAttachment(imageFile, local)).toHaveProperty("attachment");
  });

  test("refuses an image for an agent with no image capability", () => {
    expect(resolveWorkspaceAttachment(imageFile, { ...local, allowImages: false }))
      .toMatchObject({ error: "Cannot attach image" });
  });

  test("refuses a file for an agent with no file capability", () => {
    expect(resolveWorkspaceAttachment(textFile, { ...local, allowFiles: false }))
      .toMatchObject({ error: "Cannot attach file" });
  });

  test("refuses when the environment cannot resolve a root path", () => {
    expect(resolveWorkspaceAttachment(textFile, { allowFiles: true, allowImages: true }))
      .toMatchObject({ error: "Cannot attach file" });
  });

  test("enforces the shared per-prompt attachment ceiling", () => {
    expect(resolveWorkspaceAttachment(textFile, {
      ...local,
      attachedCount: MAX_PROMPT_ATTACHMENTS,
    })).toMatchObject({ error: "Cannot attach file" });
  });
});

describe("retainSupportedAttachments", () => {
  const file = { id: "a", type: "file" as const, path: "/work/tree/notes.md", name: "notes.md" };
  const image = { id: "b", type: "image" as const, path: "/work/tree/shot.png", name: "shot.png" };

  test("keeps images and drops files for an image-only agent", () => {
    expect(retainSupportedAttachments([file, image], { files: false, images: true }))
      .toEqual([image]);
  });

  test("keeps files and drops images for a file-only agent", () => {
    expect(retainSupportedAttachments([file, image], { files: true, images: false }))
      .toEqual([file]);
  });

  test("keeps both when the agent accepts both", () => {
    expect(retainSupportedAttachments([file, image], { files: true, images: true }))
      .toEqual([file, image]);
  });

  test("drops everything for an agent that accepts no attachments", () => {
    expect(retainSupportedAttachments([file, image], { files: false, images: false }))
      .toEqual([]);
  });

  test("drops everything when no capability is known rather than guessing", () => {
    expect(retainSupportedAttachments([file, image], undefined)).toEqual([]);
  });

  test("returns an empty list unchanged", () => {
    expect(retainSupportedAttachments([], { files: true, images: true })).toEqual([]);
  });
});
