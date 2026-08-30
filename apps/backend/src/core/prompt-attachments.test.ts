import { describe, expect, mock, test } from "bun:test";
import type { Environment } from "./models.js";
import {
  DEFAULT_STAGING_DIRECTORY,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  assertValidPromptAttachments,
  assertValidPromptImages,
  mimeTypeForFilename,
  mimeTypeForImageData,
  promptAttachmentUrl,
  stagePromptImages,
} from "./prompt-attachments.js";

function environment(updates: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/env-1",
    ...updates,
  };
}

/** Base64 whose decoded length is `bytes`, reused by reference to stay cheap. */
function base64OfSize(bytes: number): string {
  return "A".repeat(Math.ceil((bytes * 4) / 3));
}

describe("mimeTypeForFilename", () => {
  test.each([
    ["photo.jpg", "image/jpeg"],
    ["photo.JPEG", "image/jpeg"],
    ["motion.gif", "image/gif"],
    ["modern.WebP", "image/webp"],
    ["shot.png", "image/png"],
    // Anything else is declared PNG: both bridges want a concrete image mime,
    // and a wrong-but-valid one is better than none.
    ["notes.txt", "image/png"],
    ["noextension", "image/png"],
  ])("maps %s to %s", (filename, expected) => {
    expect(mimeTypeForFilename(filename)).toBe(expected);
  });
});

describe("mimeTypeForImageData", () => {
  test.each([
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/gif", Buffer.from("GIF89a", "latin1")],
    ["image/webp", Buffer.from("RIFF0000WEBP", "latin1")],
  ])("detects %s from bytes even when the filename says PNG", (expected, bytes) => {
    expect(mimeTypeForImageData("pasted.png", bytes.toString("base64"))).toBe(expected);
  });

  test("falls back to the filename for an unrecognized payload", () => {
    expect(mimeTypeForImageData("pasted.jpeg", "AAAA")).toBe("image/jpeg");
  });

  test.each([
    ["an empty payload", "fallback.jpeg", Buffer.alloc(0), "image/jpeg"],
    [
      "a truncated PNG signature",
      "fallback.gif",
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "image/gif",
    ],
    ["a truncated JPEG signature", "fallback.webp", Buffer.from([0xff, 0xd8]), "image/webp"],
    ["a truncated GIF signature", "fallback.jpg", Buffer.from("GIF89", "latin1"), "image/jpeg"],
    [
      "a truncated WebP signature",
      "fallback.png",
      Buffer.from("RIFF0000WEB", "latin1"),
      "image/png",
    ],
  ])("falls back for %s", (_label, filename, bytes, expected) => {
    expect(mimeTypeForImageData(filename, bytes.toString("base64"))).toBe(expected);
  });
});

describe("assertValidPromptImages", () => {
  test("returns only the filename and data of each accepted image", () => {
    expect(
      assertValidPromptImages([{ filename: "a.png", data: "cG5n", extra: "dropped" }]),
    ).toEqual([{ filename: "a.png", data: "cG5n" }]);
    expect(assertValidPromptImages([])).toEqual([]);
  });

  test("refuses more than twenty images", () => {
    const images = Array.from({ length: 21 }, (_, index) => ({
      filename: `a${index}.png`,
      data: "cG5n",
    }));
    expect(() => assertValidPromptImages(images)).toThrow("At most 20 prompt images are allowed");
    expect(() => assertValidPromptImages(images.slice(0, 20))).not.toThrow();
  });

  test.each([
    ["a non-object entry", ["a.png"], "must be an object"],
    ["a null entry", [null], "must be an object"],
    ["an array entry", [[]], "must be an object"],
    ["a missing filename", [{ data: "cG5n" }], "filename must be a non-empty string"],
    ["a blank filename", [{ filename: "  ", data: "cG5n" }], "filename must be a non-empty string"],
    ["a missing payload", [{ filename: "a.png" }], "data must be a non-empty base64 string"],
    [
      "a blank payload",
      [{ filename: "a.png", data: " " }],
      "data must be a non-empty base64 string",
    ],
    ["a non-base64 payload", [{ filename: "a.png", data: "not base64!" }], "must be valid base64"],
    ["a padded-mid payload", [{ filename: "a.png", data: "cG5=n" }], "must be valid base64"],
  ])("refuses %s", (_label, images, message) => {
    expect(() => assertValidPromptImages(images)).toThrow(message);
  });

  test("refuses an image over the per-payload limit", () => {
    // 8MB + 1 byte decoded: the same ceiling the write-file commands enforce.
    expect(() =>
      assertValidPromptImages([{ filename: "big.png", data: base64OfSize(8 * 1024 * 1024 + 1) }]),
    ).toThrow("exceeds the 8MB limit");
  });

  test("refuses a set over the total limit even when each image fits", () => {
    const data = base64OfSize(7 * 1024 * 1024);
    const images = Array.from({ length: 5 }, (_, index) => ({
      filename: `a${index}.png`,
      data,
    }));
    expect(() => assertValidPromptImages(images)).toThrow("exceed the 32MB total limit");
    expect(() => assertValidPromptImages(images.slice(0, 4))).not.toThrow();
  });
});

describe("assertValidPromptAttachments", () => {
  test("keeps inline data for an image and drops it for a file", () => {
    expect(
      assertValidPromptAttachments([
        {
          type: "image",
          path: "/workspace/a.png",
          dataUrl: "data:image/png;base64,cG5n",
          filename: "a.png",
        },
        {
          type: "file",
          path: "/workspace/notes.md",
          dataUrl: "data:text/markdown;base64,bWQ=",
          filename: "notes.md",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        path: "/workspace/a.png",
        dataUrl: "data:image/png;base64,cG5n",
        filename: "a.png",
      },
      // Neither bridge accepts inline data for a file part, so carrying it
      // would only inflate the request.
      { type: "file", path: "/workspace/notes.md", filename: "notes.md" },
    ]);
  });

  test("treats an unrecognised type as an image and normalises blank fields", () => {
    expect(
      assertValidPromptAttachments([
        { type: "video", path: "/workspace/a.png", dataUrl: "  ", filename: " " },
        { path: "/workspace/b.png" },
      ]),
    ).toEqual([
      { type: "image", path: "/workspace/a.png", dataUrl: undefined, filename: undefined },
      { type: "image", path: "/workspace/b.png", dataUrl: undefined, filename: undefined },
    ]);
  });

  test("drops an inline payload a bridge would reject anyway", () => {
    const [attachment] = assertValidPromptAttachments([
      { type: "image", path: "/workspace/a.png", dataUrl: "d".repeat(16 * 1024 * 1024 + 1) },
    ]);
    expect(attachment).toEqual({
      type: "image",
      path: "/workspace/a.png",
      filename: undefined,
    });
    expect(attachment).not.toHaveProperty("dataUrl");
  });

  test("refuses more than twenty attachments", () => {
    const attachments = Array.from({ length: 21 }, (_, index) => ({
      type: "image",
      path: `/workspace/a${index}.png`,
    }));
    expect(() => assertValidPromptAttachments(attachments)).toThrow(
      "At most 20 prompt attachments are allowed",
    );
  });

  test.each([
    ["a non-object entry", ["/workspace/a.png"], "must be an object"],
    ["a null entry", [null], "must be an object"],
    ["a missing path", [{ type: "image" }], "path must be a non-empty string"],
    ["a blank path", [{ type: "image", path: "   " }], "path must be a non-empty string"],
    ["a non-string path", [{ type: "image", path: 7 }], "path must be a non-empty string"],
  ])("refuses %s", (_label, attachments, message) => {
    expect(() => assertValidPromptAttachments(attachments)).toThrow(message);
  });
});

describe("promptAttachmentUrl", () => {
  test("prefers inline data over the workspace path", () => {
    expect(
      promptAttachmentUrl({
        type: "image",
        path: "../../etc/passwd",
        dataUrl: "data:image/png;base64,cG5n",
      }),
    ).toBe("data:image/png;base64,cG5n");
  });

  test("encodes a relative path with three slashes and an absolute one with two", () => {
    expect(
      promptAttachmentUrl({
        type: "image",
        path: ".orkestrator/prompt-attachments/a b.png",
      }),
    ).toBe("file:///.orkestrator/prompt-attachments/a%20b.png");
    expect(
      promptAttachmentUrl({
        type: "image",
        path: "/workspace/a b.png",
      }),
    ).toBe("file:///workspace/a%20b.png");
  });

  test.each([
    ["a null byte", "/workspace/a\u0000.png", "must not contain null bytes"],
    ["a parent segment", "/workspace/../etc/passwd", "must not contain traversal segments"],
    ["a current segment", "/workspace/./a.png", "must not contain traversal segments"],
    ["a backslash parent segment", "workspace\\..\\a.png", "must not contain traversal segments"],
  ])("refuses %s rather than encoding it", (_label, attachmentPath, message) => {
    expect(() => promptAttachmentUrl({ type: "image", path: attachmentPath })).toThrow(message);
  });
});

describe("stagePromptImages", () => {
  test("writes into the local worktree and returns the resolved path", async () => {
    const invoke = mock(
      async (_command: string, args?: Record<string, unknown>) =>
        `/tmp/env-1/${(args as { filePath: string }).filePath}` as never,
    );

    expect(
      await stagePromptImages(invoke, environment(), [{ filename: "shot.jpg", data: "anBn" }]),
    ).toEqual([
      {
        type: "image",
        path: `/tmp/env-1/${DEFAULT_STAGING_DIRECTORY}/shot.jpg`,
        filename: "shot.jpg",
        dataUrl: "data:image/jpeg;base64,anBn",
      },
    ]);
    expect(invoke).toHaveBeenCalledWith("write_local_file", {
      worktreePath: "/tmp/env-1",
      filePath: `${DEFAULT_STAGING_DIRECTORY}/shot.jpg`,
      base64Data: "anBn",
    });
  });

  test("writes into the container and returns the workspace path", async () => {
    const invoke = mock(async () => undefined as never);

    expect(
      await stagePromptImages(
        invoke,
        environment({ environmentType: "containerized", containerId: "container-1" }),
        [{ filename: "shot.png", data: "cG5n" }],
        INITIAL_PROMPT_STAGING_DIRECTORY,
      ),
    ).toEqual([
      {
        type: "image",
        path: `/workspace/${INITIAL_PROMPT_STAGING_DIRECTORY}/shot.png`,
        filename: "shot.png",
        dataUrl: "data:image/png;base64,cG5n",
      },
    ]);
    expect(invoke).toHaveBeenCalledWith("write_container_file", {
      containerId: "container-1",
      filePath: `${INITIAL_PROMPT_STAGING_DIRECTORY}/shot.png`,
      base64Data: "cG5n",
    });
  });

  test("declares normalized WebP bytes as WebP even when the original name is PNG", async () => {
    const invoke = mock(
      async (_command: string, args?: Record<string, unknown>) =>
        (args as { filePath: string }).filePath as never,
    );
    const webp = Buffer.from("RIFF0000WEBP", "latin1").toString("base64");

    const [staged] = await stagePromptImages(invoke, environment(), [
      { filename: "clipboard.png", data: webp },
    ]);

    expect(staged).toMatchObject({
      filename: "clipboard.webp",
      path: `${DEFAULT_STAGING_DIRECTORY}/clipboard.webp`,
      dataUrl: `data:image/webp;base64,${webp}`,
    });
    expect(invoke).toHaveBeenCalledWith(
      "write_local_file",
      expect.objectContaining({ filePath: `${DEFAULT_STAGING_DIRECTORY}/clipboard.webp` }),
    );
  });

  test.each([
    ["strips a traversal prefix", "../../etc/passwd", "passwd"],
    ["strips a windows traversal prefix", "..\\..\\windows\\system32", "system32"],
    ["strips a leading dot", ".hidden.png", "hidden.png"],
    ["replaces unsafe characters", "my report (final)!.png", "my-report--final--.png"],
    ["falls back when nothing survives", "..", "attachment-1.png"],
    ["falls back for a separator-only name", "/", "attachment-1.png"],
  ])("%s", async (_label, filename, expected) => {
    const invoke = mock(
      async (_command: string, args?: Record<string, unknown>) =>
        (args as { filePath: string }).filePath as never,
    );

    const [staged] = await stagePromptImages(invoke, environment(), [{ filename, data: "cG5n" }]);
    expect(staged?.filename).toBe(expected);
    expect(staged?.path).toBe(`${DEFAULT_STAGING_DIRECTORY}/${expected}`);
  });

  test("truncates an over-long filename to 128 characters", async () => {
    const invoke = mock(async () => "written" as never);
    const [staged] = await stagePromptImages(invoke, environment(), [
      { filename: `${"a".repeat(200)}.png`, data: "cG5n" },
    ]);
    expect(staged?.filename).toHaveLength(128);
    expect(staged?.filename).toBe("a".repeat(128));
  });

  test("gives duplicate names distinct workspace paths", async () => {
    const invoke = mock(
      async (_command: string, args?: Record<string, unknown>) =>
        (args as { filePath: string }).filePath as never,
    );

    // Two pasted screenshots often share a name. Reusing the path would leave
    // the prompt referencing one file twice and lose the other image.
    const staged = await stagePromptImages(invoke, environment(), [
      { filename: "shot.png", data: "cG5n" },
      { filename: "shot.png", data: "anBn" },
      { filename: "shot.png", data: "Z2lm" },
      { filename: "../shot.png", data: "d2VicA==" },
    ]);
    expect(staged.map((attachment) => attachment.filename)).toEqual([
      "shot.png",
      "shot-2.png",
      "shot-3.png",
      "shot-4.png",
    ]);
    expect(new Set(staged.map((attachment) => attachment.path)).size).toBe(4);
  });

  test("returns nothing and touches no command for an empty image list", async () => {
    const invoke = mock(async () => undefined as never);
    expect(await stagePromptImages(invoke, environment({ worktreePath: undefined }), [])).toEqual(
      [],
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a local environment without a worktree",
      environment({ worktreePath: undefined }),
      "without a worktree path",
    ],
    [
      "a container environment without a container",
      environment({ environmentType: "containerized", containerId: null }),
      "without a container",
    ],
  ])("refuses to stage into %s", async (_label, env, message) => {
    const invoke = mock(async () => undefined as never);
    await expect(
      stagePromptImages(invoke, env, [{ filename: "a.png", data: "cG5n" }]),
    ).rejects.toThrow(message);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("validates before writing anything", async () => {
    const invoke = mock(async () => "written" as never);
    await expect(
      stagePromptImages(invoke, environment(), [
        { filename: "a.png", data: "cG5n" },
        { filename: "b.png", data: "not base64!" },
      ]),
    ).rejects.toThrow("must be valid base64");
    expect(invoke).not.toHaveBeenCalled();
  });
});
