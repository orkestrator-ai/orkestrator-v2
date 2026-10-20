import { describe, expect, test } from "bun:test";
import {
  base64Prefix,
  bytesMatchPreviewKind,
  declaredMime,
  imageDimensionsFromBytes,
  previewKindForMime,
  sniffFamily,
} from "./media-types";
import { canResolveMedia, getSafeContainerRelativePath } from "./media-resolver";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("media types", () => {
  test("routes MIME types to the documented preview kinds", () => {
    expect(previewKindForMime(declaredMime("a/shot.png"))).toBe("image");
    expect(previewKindForMime(declaredMime("logo.svg"))).toBe("svg");
    expect(previewKindForMime(declaredMime("clip.mp4"))).toBe("video");
    expect(previewKindForMime(declaredMime("voice.mp3"))).toBe("audio");
    expect(previewKindForMime(declaredMime("report.pdf"))).toBe("pdf");
    expect(previewKindForMime(declaredMime("notes.md"))).toBe("markdown");
    expect(previewKindForMime(declaredMime("data.json"))).toBe("json");
    expect(previewKindForMime(declaredMime("rows.csv"))).toBe("csv");
    expect(previewKindForMime(declaredMime("rows.tsv"))).toBe("tsv");
    expect(previewKindForMime(declaredMime("page.html"))).toBe("html");
    expect(previewKindForMime(declaredMime("main.rs"))).toBe("text");
    expect(previewKindForMime(declaredMime("archive.zip"))).toBe("other");
    expect(previewKindForMime(declaredMime("deck.pptx"))).toBe("other");
    // A data URL's declared type wins over the extension.
    expect(declaredMime("file.txt", "data:image/png;base64,AAAA")).toBe("image/png");
  });

  test("sniffs leading bytes and detects mismatches", () => {
    const png = base64Prefix(PNG_1x1, 64);
    expect(sniffFamily(png)).toBe("image");
    expect(sniffFamily(new TextEncoder().encode("%PDF-1.7"))).toBe("pdf");
    expect(sniffFamily(new TextEncoder().encode("hello"))).toBe("text");
    expect(bytesMatchPreviewKind("pdf", new TextEncoder().encode("<html>"))).toBe(false);
    expect(bytesMatchPreviewKind("text", png)).toBe(false);
    expect(bytesMatchPreviewKind("image", png)).toBe(true);
  });

  test("reads intrinsic image dimensions without decoding pixels", () => {
    expect(imageDimensionsFromBytes(base64Prefix(PNG_1x1, 64))).toEqual({ width: 1, height: 1 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
    expect(imageDimensionsFromBytes(gif)).toEqual({ width: 16, height: 32 });
  });

  test("local media resolution never escapes the container workspace", () => {
    expect(getSafeContainerRelativePath("/workspace/img/a.png")).toBe("img/a.png");
    expect(getSafeContainerRelativePath("img/a.png")).toBe("img/a.png");
    for (const unsafe of ["/etc/passwd", "../a.png", "~/a.png", "C:\\a.png", "/workspace/"]) {
      expect(getSafeContainerRelativePath(unsafe)).toBeNull();
    }
    expect(canResolveMedia({ path: "relative.png" })).toBe(false);
    expect(canResolveMedia({ path: "/abs/a.png" })).toBe(true);
    expect(canResolveMedia({ path: "x", fileUrl: "https://example.com/a.png" })).toBe(true);
  });
});
