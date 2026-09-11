import { describe, expect, test } from "bun:test";

import { imageReadFromToolPart, isImageFilePath } from "./image-read";

describe("isImageFilePath", () => {
  test("accepts the extensions FilePart can preview", () => {
    expect(isImageFilePath("/workspace/shot.PNG")).toBe(true);
    expect(isImageFilePath("diagram.avif")).toBe(true);
    expect(isImageFilePath("C:\\Users\\Ada\\pic.jpeg")).toBe(true);
  });

  test("rejects non-images and extension-looking decoys", () => {
    expect(isImageFilePath("/workspace/notes.txt")).toBe(false);
    expect(isImageFilePath("notes.png.bak")).toBe(false);
    expect(isImageFilePath(".png")).toBe(false);
    expect(isImageFilePath("")).toBe(false);
  });
});

describe("imageReadFromToolPart", () => {
  test("recovers Claude, Cursor, OpenCode and ACP path arguments", () => {
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toEqual({ path: "/workspace/a.png", filename: "a.png", fileUrl: "/workspace/a.png" });
    expect(
      imageReadFromToolPart({
        toolName: "read",
        toolState: "success",
        toolArgs: { path: "/tmp/screen shots/b.jpg" },
      }),
    ).toEqual({
      path: "/tmp/screen shots/b.jpg",
      filename: "b.jpg",
      fileUrl: "/tmp/screen shots/b.jpg",
    });
    expect(
      imageReadFromToolPart({
        toolName: "ReadFile",
        toolState: "success",
        toolArgs: { filePath: "assets/c.webp" },
      }),
    ).toEqual({ path: "assets/c.webp", filename: "c.webp", fileUrl: "assets/c.webp" });
    expect(
      imageReadFromToolPart({
        toolName: "cursor_read",
        toolState: "success",
        toolTitle: "/workspace/d.gif",
      }),
    ).toEqual({ path: "/workspace/d.gif", filename: "d.gif", fileUrl: "/workspace/d.gif" });
  });

  test("does not treat a display title as a path", () => {
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "success",
        toolTitle: "Read screenshot.png",
      }),
    ).toBeNull();
  });

  test("accepts a bare image basename from a stripped tool title", () => {
    expect(
      imageReadFromToolPart({
        toolName: "cursor_read",
        toolState: "success",
        toolTitle: "shot.png",
      }),
    ).toEqual({ path: "shot.png", filename: "shot.png", fileUrl: "shot.png" });
  });

  test("preserves file and remote image URLs", () => {
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "file:///workspace/screens/shot.png" },
      }),
    ).toEqual({
      path: "file:///workspace/screens/shot.png",
      filename: "shot.png",
      fileUrl: "file:///workspace/screens/shot.png",
    });
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "success",
        toolArgs: { path: "https://example.test/screens/shot.webp?rev=2" },
      }),
    ).toEqual({
      path: "https://example.test/screens/shot.webp?rev=2",
      filename: "shot.webp",
      fileUrl: "https://example.test/screens/shot.webp?rev=2",
    });
  });

  test("waits for a pending image read to settle", () => {
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "pending",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toBeNull();
  });

  test("treats an unknown tool state as unsettled rather than as success", () => {
    // `asToolState` in the build-pipeline transcript and the OpenCode mapper
    // both yield `undefined` when the stored state is absent or unrecognised.
    // Reading the file anyway would preview a call whose outcome nobody knows.
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toBeNull();
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "cancelled",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toBeNull();
  });

  test("ignores writes, searches, failed reads and non-image files", () => {
    expect(
      imageReadFromToolPart({
        toolName: "Write",
        toolState: "success",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toBeNull();
    expect(
      imageReadFromToolPart({
        toolName: "Grep",
        toolState: "success",
        toolArgs: { path: "/workspace/a.png", pattern: "x" },
      }),
    ).toBeNull();
    expect(
      imageReadFromToolPart({
        toolName: "readLints",
        toolState: "success",
        toolArgs: { paths: ["/workspace/a.png"] },
      }),
    ).toBeNull();
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "failure",
        toolArgs: { file_path: "/workspace/a.png" },
      }),
    ).toBeNull();
    expect(
      imageReadFromToolPart({
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "/workspace/a.ts" },
      }),
    ).toBeNull();
  });
});
