import { describe, expect, mock, test } from "bun:test";
import {
  createClipboardTextWriter,
  MAX_CLIPBOARD_IMAGE_BYTES,
  webpClipboardFormat,
  writeClipboardImage,
  type ClipboardItemLike,
  type ClipboardNativeImageLike,
} from "../electron/clipboard";

describe("createClipboardTextWriter", () => {
  test("writes the text and returns synchronously", async () => {
    const writeText = mock(async (_text: string) => undefined);
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    expect(write("copied")).toBeUndefined();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("copied");
    expect(logError).not.toHaveBeenCalled();
  });

  test("observes a rejected write instead of leaving it unhandled", async () => {
    const failure = new Error("clipboard unavailable");
    const writeText = mock(async (_text: string) => {
      throw failure;
    });
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    write("copied");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logError).toHaveBeenCalledWith(failure);
  });

  test("logs a synchronous throw from the clipboard module", () => {
    const failure = new Error("not ready");
    const writeText = mock((_text: string): Promise<void> => {
      throw failure;
    });
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    expect(() => write("copied")).not.toThrow();
    expect(logError).toHaveBeenCalledWith(failure);
  });
});

describe("writeClipboardImage", () => {
  // A real 1x1 transparent image encoded by Chromium's canvas.toDataURL.
  const webp =
    "UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA";
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const nativeImageApi = {
    createFromDataURL: (dataUrl: string) =>
      ({
        isEmpty: () => !dataUrl.startsWith("data:image/png"),
        toPNG: () => pngBytes,
      }) as unknown as ClipboardNativeImageLike,
  };
  function harness() {
    const written: Array<Record<string, Blob>> = [];
    const write = mock(async (_items: ClipboardItemLike[]) => undefined);
    const createClipboardItem = (items: Record<string, Blob>) => {
      written.push(items);
      return { types: Object.keys(items), getType: async (type: string) => items[type] };
    };
    return { written, write, createClipboardItem };
  }
  const bytesOf = async (blob: Blob | undefined) =>
    Array.from(new Uint8Array(await blob!.arrayBuffer()));

  test("writes a PNG alone by default", async () => {
    const { written, write, createClipboardItem } = harness();
    await writeClipboardImage(
      { write },
      nativeImageApi,
      createClipboardItem,
      "data:image/png;base64,AA==",
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(written[0]!)).toEqual(["image/png"]);
    expect(await bytesOf(written[0]!["image/png"])).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("adds the WebP under the platform's raw format beside the PNG", async () => {
    const { written, write, createClipboardItem } = harness();
    await writeClipboardImage(
      { write },
      nativeImageApi,
      createClipboardItem,
      "data:image/png;base64,AA==",
      {
        webpDataUrl: `data:image/webp;base64,${webp}`,
        platform: "darwin",
      },
    );
    const format = 'electron application/osclipboard;format="org.webmproject.webp"';
    expect(Object.keys(written[0]!)).toEqual(["image/png", format]);
    expect(Buffer.from(await bytesOf(written[0]![format])).toString("base64")).toBe(webp);
  });

  test("names WebP by MIME type outside macOS", () => {
    expect(webpClipboardFormat("linux")).toBe(
      'electron application/osclipboard;format="image/webp"',
    );
    expect(webpClipboardFormat("win32")).toBe(
      'electron application/osclipboard;format="image/webp"',
    );
  });

  test("refuses a WebP payload that is not a WebP data URL, writing nothing", async () => {
    const { write, createClipboardItem } = harness();
    for (const webpDataUrl of ["data:image/png;base64,AA==", "data:image/webp;base64,"]) {
      await expect(
        writeClipboardImage(
          { write },
          nativeImageApi,
          createClipboardItem,
          "data:image/png;base64,AA==",
          {
            webpDataUrl,
          },
        ),
      ).rejects.toThrow("Expected a WebP data URL");
    }
    expect(write).not.toHaveBeenCalled();
  });

  test("rejects malformed base64 and incomplete containers before creating an entry", async () => {
    const valid = Buffer.from(webp, "base64");
    const truncated = valid.subarray(0, valid.length - 2);
    const truncatedChunk = Buffer.from(truncated);
    truncatedChunk.writeUInt32LE(truncatedChunk.length - 8, 4);
    const headerOnly = Buffer.from("RIFF\x04\x00\x00\x00WEBP", "latin1");
    for (const encoded of [
      "AA==!!!",
      "aGVsbG8=",
      `${webp}!!!!`,
      webp.slice(0, -1),
      "AB==",
      truncated.toString("base64"),
      truncatedChunk.toString("base64"),
      headerOnly.toString("base64"),
    ]) {
      const { written, write, createClipboardItem } = harness();
      await expect(
        writeClipboardImage(
          { write },
          nativeImageApi,
          createClipboardItem,
          "data:image/png;base64,AA==",
          { webpDataUrl: `data:image/webp;base64,${encoded}` },
        ),
      ).rejects.toThrow("Expected a WebP data URL");
      expect(write).not.toHaveBeenCalled();
      expect(written).toHaveLength(0);
    }
  });

  test("rejects oversized WebP before creating or writing an entry", async () => {
    const { written, write, createClipboardItem } = harness();
    const encoded = "A".repeat(Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4 + 4);
    await expect(
      writeClipboardImage(
        { write },
        nativeImageApi,
        createClipboardItem,
        "data:image/png;base64,AA==",
        { webpDataUrl: `data:image/webp;base64,${encoded}` },
      ),
    ).rejects.toThrow("Clipboard image is too large to transfer");
    expect(write).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });
});
