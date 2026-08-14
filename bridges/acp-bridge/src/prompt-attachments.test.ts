import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  parsePromptAttachments,
  PromptAttachmentError,
  readPromptImages,
} from "./prompt-attachments.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(resolve(os.tmpdir(), "acp-attachments-"));
  directories.add(directory);
  // The workspace root is compared against canonical paths, and macOS resolves
  // /var to /private/var, so an uncanonicalized root would reject every file.
  return await fs.realpath(directory);
}

function image(path: string): ReturnType<typeof parsePromptAttachments>[number] {
  return { type: "image", path };
}

describe("parsePromptAttachments", () => {
  test("accepts an absent list and a well-formed image", () => {
    expect(parsePromptAttachments(undefined)).toEqual([]);
    expect(parsePromptAttachments(null)).toEqual([]);
    expect(parsePromptAttachments([{ type: "image", path: " a.png ", filename: "a.png" }]))
      .toEqual([{ type: "image", path: "a.png", filename: "a.png" }]);
  });

  test("refuses anything it cannot faithfully forward", () => {
    // Dropping an entry would leave a prompt whose text names an image the
    // agent was never shown, so every one of these has to reject the request.
    expect(() => parsePromptAttachments("nope")).toThrow(PromptAttachmentError);
    expect(() => parsePromptAttachments([null])).toThrow(PromptAttachmentError);
    expect(() => parsePromptAttachments([{ type: "file", path: "a.txt" }]))
      .toThrow("Cursor and Grok accept image attachments only");
    expect(() => parsePromptAttachments([{ type: "image" }]))
      .toThrow("Each attachment needs a workspace path");
    expect(() => parsePromptAttachments([{ type: "image", path: "a\0.png" }]))
      .toThrow("null bytes");
    expect(() => parsePromptAttachments(
      Array.from({ length: MAX_PROMPT_ATTACHMENTS + 1 }, () => ({ type: "image", path: "a.png" })),
    )).toThrow(`at most ${MAX_PROMPT_ATTACHMENTS}`);
  });
});

describe("readPromptImages", () => {
  test("reads a workspace image and identifies its format from the bytes", async () => {
    const root = await workspace();
    await fs.writeFile(resolve(root, "shot.png"), ONE_PIXEL_PNG);
    await fs.mkdir(resolve(root, "nested"));
    // Named .png but actually a JPEG: the model is shown bytes, so the
    // signature has to win over the caller-supplied extension.
    await fs.writeFile(resolve(root, "nested/mislabelled.png"), JPEG_HEADER);

    expect(await readPromptImages(
      [image("shot.png"), image(resolve(root, "nested/mislabelled.png"))],
      root,
    )).toEqual([
      {
        data: ONE_PIXEL_PNG.toString("base64"),
        mimeType: "image/png",
        path: "shot.png",
        // A relative request still yields an absolute path, so the transcript's
        // `file://` URL is well formed rather than `file://shot.png`.
        absolutePath: resolve(root, "shot.png"),
      },
      {
        data: JPEG_HEADER.toString("base64"),
        mimeType: "image/jpeg",
        path: resolve(root, "nested/mislabelled.png"),
        absolutePath: resolve(root, "nested/mislabelled.png"),
      },
    ]);
  });

  test("refuses a path that escapes the workspace, directly or through a symlink", async () => {
    const root = await workspace();
    const outside = await workspace();
    await fs.writeFile(resolve(outside, "secret.png"), ONE_PIXEL_PNG);
    await fs.symlink(resolve(outside, "secret.png"), resolve(root, "link.png"));
    await fs.symlink(outside, resolve(root, "escape"));

    for (const path of [
      resolve(outside, "secret.png"),
      "../secret.png",
      "link.png",
      "escape/secret.png",
    ]) {
      await expect(readPromptImages([image(path)], root)).rejects.toThrow(PromptAttachmentError);
    }
  });

  test("refuses unreadable, empty, oversized, and non-image files", async () => {
    const root = await workspace();
    await fs.writeFile(resolve(root, "empty.png"), "");
    await fs.writeFile(resolve(root, "notes.txt"), "plain text");
    await fs.writeFile(resolve(root, "huge.png"), Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1));
    await fs.mkdir(resolve(root, "directory.png"));

    await expect(readPromptImages([image("missing.png")], root))
      .rejects.toThrow("could not be read");
    await expect(readPromptImages([image("empty.png")], root)).rejects.toThrow("empty");
    await expect(readPromptImages([image("notes.txt")], root))
      .rejects.toThrow("PNG, JPEG, GIF, or WebP");
    await expect(readPromptImages([image("huge.png")], root)).rejects.toThrow("8MB");
    await expect(readPromptImages([image("directory.png")], root))
      .rejects.toThrow(PromptAttachmentError);
  });

  test("bounds the total bytes one prompt can carry", async () => {
    const root = await workspace();
    const large = Buffer.concat([
      ONE_PIXEL_PNG,
      Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES - ONE_PIXEL_PNG.length),
    ]);
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(resolve(root, `large-${index}.png`), large);
    }
    await expect(readPromptImages(
      Array.from({ length: 5 }, (_, index) => image(`large-${index}.png`)),
      root,
    )).rejects.toThrow("32MB");
  });
});
