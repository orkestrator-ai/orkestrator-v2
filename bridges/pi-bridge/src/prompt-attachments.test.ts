/**
 * The attachment reader is a trust boundary: the paths it takes arrive over
 * HTTP, and everything it returns is either read into the prompt or handed to
 * the model to open. These tests exercise the refusals rather than the happy
 * path, because a refusal that quietly stops refusing is the failure that
 * matters here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  assertStableRead,
  MAX_PROMPT_ATTACHMENTS,
  parsePromptAttachments,
  promptFileReferences,
  PromptAttachmentError,
  readPromptImages,
  resolvePromptFiles,
  type ReadIdentity,
} from "./prompt-attachments.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** A solid grey `size`×`size` 8-bit greyscale PNG. */
function squarePng(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc(size * (size + 1), 0x80);
  for (let row = 0; row < size; row += 1) rows[row * (size + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Width of a PNG or baseline/progressive JPEG, read from its header. */
function imageWidth(base64: string): number {
  const bytes = Buffer.from(base64, "base64");
  if (bytes[0] === 0x89) return bytes.readUInt32BE(16);
  for (let offset = 2; offset < bytes.length;) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xc0 || marker === 0xc2) return bytes.readUInt16BE(offset + 7);
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("no image header");
}

let workspace: string;
let outside: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-attachments-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(join(workspace, ".."), { recursive: true, force: true });
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "no-error";
  } catch (error) {
    return error instanceof PromptAttachmentError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe("parsePromptAttachments", () => {
  test("treats an absent list as no attachments", () => {
    expect(parsePromptAttachments(undefined)).toEqual([]);
    expect(parsePromptAttachments(null)).toEqual([]);
  });

  test("refuses a non-array, a non-object entry, and an unknown type", () => {
    expect(() => parsePromptAttachments({})).toThrow(PromptAttachmentError);
    expect(() => parsePromptAttachments(["a.png"])).toThrow(PromptAttachmentError);
    expect(() => parsePromptAttachments([{ type: "video", path: "a.mp4" }])).toThrow(
      PromptAttachmentError,
    );
  });

  test("refuses more attachments than the cap admits", () => {
    const one = { type: "image", path: "a.png" };
    expect(parsePromptAttachments(Array(MAX_PROMPT_ATTACHMENTS).fill(one))).toHaveLength(
      MAX_PROMPT_ATTACHMENTS,
    );
    expect(() => parsePromptAttachments(Array(MAX_PROMPT_ATTACHMENTS + 1).fill(one))).toThrow(
      PromptAttachmentError,
    );
  });

  test("refuses a missing, oversized, or null-byte path", () => {
    expect(() => parsePromptAttachments([{ type: "file", path: "   " }])).toThrow(
      PromptAttachmentError,
    );
    expect(() => parsePromptAttachments([{ type: "file", path: "a".repeat(4097) }])).toThrow(
      PromptAttachmentError,
    );
    // A null byte truncates the path at the syscall boundary, so a name that
    // passed containment could open a different file entirely.
    expect(() => parsePromptAttachments([{ type: "file", path: "a.png\0.txt" }])).toThrow(
      PromptAttachmentError,
    );
  });

  test("drops an oversized filename rather than refusing the attachment", () => {
    // The filename is a display label; the path is the thing that matters.
    expect(
      parsePromptAttachments([{ type: "image", path: "a.png", filename: "b".repeat(1025) }]),
    ).toEqual([{ type: "image", path: "a.png" }]);
  });
});

describe("readPromptImages", () => {
  test("reads a workspace image and types it from its bytes", async () => {
    await writeFile(join(workspace, "shot.png"), PNG);

    const images = await readPromptImages(
      [{ type: "image", path: "shot.png", filename: "Screenshot.png" }],
      workspace,
    );
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      mimeType: "image/png",
      path: "shot.png",
      filename: "Screenshot.png",
      data: PNG.toString("base64"),
    });
  });

  test("applies a model's resize profile when one is passed", async () => {
    // Pi 0.87 resizes `prompt()` images per model, but queues steer and
    // follow-up images untouched, so those callers hand the profile in here.
    await writeFile(join(workspace, "wide.png"), squarePng(64));
    const attachment = [{ type: "image" as const, path: "wide.png" }];

    const [unbounded] = await readPromptImages(attachment, workspace);
    const [bounded] = await readPromptImages(attachment, workspace, {
      maxWidth: 16,
      maxHeight: 16,
    });
    expect(imageWidth(unbounded!.data)).toBe(64);
    expect(imageWidth(bounded!.data)).toBe(16);
  });

  test("ignores file attachments and an empty list", async () => {
    await writeFile(join(workspace, "notes.md"), "hello");
    expect(await readPromptImages([{ type: "file", path: "notes.md" }], workspace)).toEqual([]);
    expect(await readPromptImages([], workspace)).toEqual([]);
  });

  test("refuses a format Pi's SDK cannot name rather than guessing from its extension", async () => {
    await writeFile(join(workspace, "not-really.png"), "<svg/>");
    expect(
      await codeOf(readPromptImages([{ type: "image", path: "not-really.png" }], workspace)),
    ).toBe("attachment_unsupported_format");
  });

  test("refuses a path that escapes the workspace", async () => {
    await writeFile(join(outside, "secret.png"), PNG);
    expect(
      await codeOf(readPromptImages([{ type: "image", path: "../outside/secret.png" }], workspace)),
    ).toBe("attachment_outside_workspace");
    // An absolute path outside the workspace is the same refusal.
    expect(
      await codeOf(
        readPromptImages([{ type: "image", path: join(outside, "secret.png") }], workspace),
      ),
    ).toBe("attachment_outside_workspace");
  });

  test("refuses a symlink even when it lands inside the workspace", async () => {
    await writeFile(join(workspace, "real.png"), PNG);
    await symlink(join(workspace, "real.png"), join(workspace, "link.png"));
    expect(await codeOf(readPromptImages([{ type: "image", path: "link.png" }], workspace))).toBe(
      "attachment_symlink_not_allowed",
    );
  });

  test("refuses a symlinked directory component", async () => {
    await mkdir(join(outside, "images"), { recursive: true });
    await writeFile(join(outside, "images", "secret.png"), PNG);
    await symlink(join(outside, "images"), join(workspace, "images"));
    expect(
      await codeOf(readPromptImages([{ type: "image", path: "images/secret.png" }], workspace)),
    ).toBe("attachment_symlink_not_allowed");
  });

  test("refuses a directory and a missing file", async () => {
    await mkdir(join(workspace, "folder"), { recursive: true });
    expect(await codeOf(readPromptImages([{ type: "image", path: "folder" }], workspace))).toBe(
      "attachment_not_regular_file",
    );
    expect(await codeOf(readPromptImages([{ type: "image", path: "gone.png" }], workspace))).toBe(
      "attachment_read_failed",
    );
  });

  test("refuses one image over the per-file cap", async () => {
    // Signature-valid but far past 8MB, so the size check is what rejects it.
    await writeFile(
      join(workspace, "huge.png"),
      Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]),
    );
    expect(await codeOf(readPromptImages([{ type: "image", path: "huge.png" }], workspace))).toBe(
      "attachment_too_large",
    );
  });

  test("refuses a set of images over the total cap", async () => {
    // Each is under the per-file cap; together they are over the 32MB total,
    // so only the running sum can catch this.
    const chunk = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]);
    const attachments = [];
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(workspace, `image-${index}.png`), chunk);
      attachments.push({ type: "image" as const, path: `image-${index}.png` });
    }
    expect(await codeOf(readPromptImages(attachments, workspace))).toBe("attachment_too_large");
  });
});

describe("assertStableRead", () => {
  const identity: ReadIdentity = { dev: 1, ino: 2, size: 10, mtimeMs: 100, ctimeMs: 100 };

  test("accepts a file that did not move under the read", () => {
    expect(() => assertStableRead(identity, { ...identity }, 10)).not.toThrow();
  });

  test("rejects every way the file could have changed", () => {
    for (const changed of [
      { ...identity, dev: 9 },
      { ...identity, ino: 9 },
      { ...identity, size: 11 },
      { ...identity, mtimeMs: 101 },
      { ...identity, ctimeMs: 101 },
    ]) {
      expect(() => assertStableRead(identity, changed, 10)).toThrow(PromptAttachmentError);
    }
  });

  test("rejects a short read even when the identity held", () => {
    // A truncated image reads to the user as the model misunderstanding the
    // attachment, which is worse than refusing it outright.
    expect(() => assertStableRead(identity, { ...identity }, 9)).toThrow(PromptAttachmentError);
  });
});

describe("resolvePromptFiles", () => {
  test("resolves a workspace file to its absolute path without reading it", async () => {
    await writeFile(join(workspace, "notes.md"), "hello");
    const files = await resolvePromptFiles(
      [{ type: "file", path: "notes.md", filename: "Notes" }],
      workspace,
    );
    expect(files).toEqual([
      { path: "notes.md", absolutePath: join(workspace, "notes.md"), filename: "Notes" },
    ]);
  });

  test("applies the same containment and symlink rules as the image reader", async () => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));
    expect(
      await codeOf(
        resolvePromptFiles([{ type: "file", path: "../outside/secret.txt" }], workspace),
      ),
    ).toBe("attachment_outside_workspace");
    expect(await codeOf(resolvePromptFiles([{ type: "file", path: "link.txt" }], workspace))).toBe(
      "attachment_symlink_not_allowed",
    );
  });

  test("refuses a directory", async () => {
    await mkdir(join(workspace, "folder"), { recursive: true });
    expect(await codeOf(resolvePromptFiles([{ type: "file", path: "folder" }], workspace))).toBe(
      "attachment_not_regular_file",
    );
  });
});

describe("promptFileReferences", () => {
  test("names nothing when there are no files", () => {
    expect(promptFileReferences([])).toBe("");
  });

  test("lists absolute paths, labelling only a filename that differs", () => {
    expect(
      promptFileReferences([
        { path: "a.ts", absolutePath: "/w/a.ts" },
        { path: "b.ts", absolutePath: "/w/b.ts", filename: "b.ts" },
        { path: "c.ts", absolutePath: "/w/c.ts", filename: "Report.ts" },
      ]),
    ).toBe("\n\nAttached files:\n- /w/a.ts\n- /w/b.ts\n- /w/c.ts (Report.ts)");
  });
});

describe("the launcher's coordinator attachment root", () => {
  // A read-only coordinator's workspace is the user's own checkout, so its
  // attachments are staged under application data instead. That directory is
  // named by the process environment, never by a request.
  const previous = process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT;

  afterEach(() => {
    if (previous === undefined) delete process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT;
    else process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT = previous;
  });

  test("reads an image and resolves a file staged outside the workspace", async () => {
    const attachments = join(outside, "coordinator-attachments");
    await mkdir(attachments, { recursive: true });
    await writeFile(join(attachments, "pasted.png"), PNG);
    await writeFile(join(attachments, "notes.txt"), "notes");
    process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT = attachments;

    const images = await readPromptImages(
      [{ type: "image", path: join(attachments, "pasted.png") }],
      workspace,
    );
    expect(images[0]?.data).toBe(PNG.toString("base64"));
    await expect(
      resolvePromptFiles([{ type: "file", path: join(attachments, "notes.txt") }], workspace),
    ).resolves.toMatchObject([{ absolutePath: join(attachments, "notes.txt") }]);
  });

  test("still refuses a path outside both roots", async () => {
    const attachments = join(outside, "coordinator-attachments");
    await mkdir(attachments, { recursive: true });
    await writeFile(join(outside, "secret.png"), PNG);
    await writeFile(join(outside, "secret.txt"), "secret");
    process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT = attachments;

    expect(
      await codeOf(
        readPromptImages([{ type: "image", path: join(outside, "secret.png") }], workspace),
      ),
    ).toBe("attachment_outside_workspace");
    expect(
      await codeOf(
        resolvePromptFiles([{ type: "file", path: join(outside, "secret.txt") }], workspace),
      ),
    ).toBe("attachment_outside_workspace");
  });

  test("refuses image and file symlinks that escape the coordinator attachment root", async () => {
    const attachments = join(outside, "coordinator-attachments");
    const secrets = join(outside, "secrets");
    await mkdir(attachments, { recursive: true });
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "secret.png"), PNG);
    await writeFile(join(secrets, "secret.txt"), "secret");
    await symlink(join(secrets, "secret.png"), join(attachments, "linked.png"));
    await symlink(join(secrets, "secret.txt"), join(attachments, "linked.txt"));
    process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT = attachments;

    expect(
      await codeOf(
        readPromptImages([{ type: "image", path: join(attachments, "linked.png") }], workspace),
      ),
    ).toBe("attachment_symlink_not_allowed");
    expect(
      await codeOf(
        resolvePromptFiles([{ type: "file", path: join(attachments, "linked.txt") }], workspace),
      ),
    ).toBe("attachment_symlink_not_allowed");
  });
});
