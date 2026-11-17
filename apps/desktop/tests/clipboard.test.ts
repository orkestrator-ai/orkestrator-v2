import { describe, expect, mock, test } from "bun:test";
import {
  createClipboardTextWriter,
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
    const webp = Buffer.from("RIFF....WEBP").toString("base64");
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
    expect(Buffer.from(await bytesOf(written[0]![format])).toString("latin1")).toBe("RIFF....WEBP");
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
});
