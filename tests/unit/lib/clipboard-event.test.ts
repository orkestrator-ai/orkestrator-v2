import { describe, expect, test } from "bun:test";
import { getPastedImageBlob } from "../../../apps/web/src/lib/clipboard-event";

function pasteEventWith(clipboardData: Partial<DataTransfer>): ClipboardEvent {
  return { clipboardData } as ClipboardEvent;
}

describe("getPastedImageBlob", () => {
  test("reads an image from DataTransfer items", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    const event = pasteEventWith({
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => image },
      ] as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
    });

    expect(getPastedImageBlob(event)).toBe(image);
  });

  test("falls back to DataTransfer files for WebKit", () => {
    const image = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    const event = pasteEventWith({
      items: [] as unknown as DataTransferItemList,
      files: [image] as unknown as FileList,
    });

    expect(getPastedImageBlob(event)).toBe(image);
  });

  test("ignores ordinary text and non-image files", () => {
    const event = pasteEventWith({
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
      ] as unknown as DataTransferItemList,
      files: [new File(["text"], "notes.txt", { type: "text/plain" })] as unknown as FileList,
    });

    expect(getPastedImageBlob(event)).toBeNull();
  });
});
