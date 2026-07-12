import { describe, test, expect, mock, beforeEach } from "bun:test";

// Use shared clipboard mocks registered centrally in tests/setup.ts.
// Do NOT call mock.module() for @/lib/native/clipboard here.
import { mockReadImage, mockReadText } from "../../mocks/clipboard";

// Mock image data
const mockRgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // 2 pixels
const mockImageSize = { width: 2, height: 1 };

const mockWriteContainerFile = mock<
  (containerId: string, filePath: string, base64Data: string) => Promise<string>
>(() => Promise.resolve("/workspace/.orkestrator/clipboard/test.png"));
const mockWriteLocalFile = mock<
  (worktreePath: string, filePath: string, base64Data: string) => Promise<string>
>(() => Promise.resolve("/tmp/worktrees/env/.orkestrator/clipboard/test.png"));

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
}));

mock.module("@/lib/canvas-utils", () => ({
  resizeCanvasIfNeeded: (canvas: HTMLCanvasElement) => canvas,
}));

// Ensure ImageData is available (happy-dom may not provide it)
if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// Mock canvas toDataURL and getContext at the prototype level
const mockToDataURL = mock(() => "data:image/png;base64,iVBORw0KGgo=");
const mockPutImageData = mock(() => {});

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

import { processClipboardPaste, processLocalClipboardPaste } from "../../../apps/web/src/hooks/useClipboardImagePaste";

describe("processLocalClipboardPaste", () => {
  beforeEach(() => {
    mockReadImage.mockClear();
    mockReadText.mockClear();
    mockWriteLocalFile.mockClear();
    mockWriteContainerFile.mockClear();
    mockToDataURL.mockClear();
    mockPutImageData.mockClear();

    // Reset default implementations
    mockReadImage.mockImplementation(() =>
      Promise.resolve({
        rgba: () => Promise.resolve(mockRgba),
        size: () => Promise.resolve(mockImageSize),
      })
    );
    mockReadText.mockImplementation(() => Promise.resolve("clipboard text"));
    mockWriteLocalFile.mockImplementation(() =>
      Promise.resolve("/tmp/worktrees/env/.orkestrator/clipboard/test.png")
    );
    mockWriteContainerFile.mockImplementation(() =>
      Promise.resolve("/workspace/.orkestrator/clipboard/test.png")
    );

    // Mock canvas methods at prototype level so all new canvases get them
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: mockPutImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = mockToDataURL as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  test("saves clipboard image to local worktree and calls onImageSaved", async () => {
    const onImageSaved = mock(() => {});
    const onTextPaste = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      onImageSaved,
      onTextPaste
    );

    expect(result).toBe(true);
    expect(mockWriteLocalFile).toHaveBeenCalledTimes(1);
    expect(mockWriteLocalFile.mock.calls[0][0]).toBe("/tmp/worktrees/env");
    expect(mockWriteLocalFile.mock.calls[0][1]).toMatch(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/);
    expect(onImageSaved).toHaveBeenCalledWith("/tmp/worktrees/env/.orkestrator/clipboard/test.png");
    expect(onTextPaste).not.toHaveBeenCalled();
  });

  test("waits for async onImageSaved callbacks before resolving", async () => {
    let resolveCallback: (() => void) | null = null;
    let pasteFinished = false;

    const resultPromise = processLocalClipboardPaste(
      "/tmp/worktrees/env",
      () => new Promise<void>((resolve) => {
        resolveCallback = resolve;
      })
    ).then((result) => {
      pasteFinished = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasteFinished).toBe(false);
    expect(resolveCallback).not.toBeNull();

    resolveCallback!();
    await expect(resultPromise).resolves.toBe(true);
    expect(pasteFinished).toBe(true);
  });

  test("falls back to text paste when no image in clipboard", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));

    const onImageSaved = mock(() => {});
    const onTextPaste = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      onImageSaved,
      onTextPaste
    );

    expect(result).toBe(true);
    expect(onTextPaste).toHaveBeenCalledWith("clipboard text");
    expect(onImageSaved).not.toHaveBeenCalled();
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("returns false when clipboard is empty (no image or text)", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));
    mockReadText.mockImplementation(() => Promise.resolve(""));

    const onImageSaved = mock(() => {});
    const onTextPaste = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      onImageSaved,
      onTextPaste
    );

    expect(result).toBe(false);
    expect(onImageSaved).not.toHaveBeenCalled();
    expect(onTextPaste).not.toHaveBeenCalled();
  });

  test("calls onError when writeLocalFile fails", async () => {
    mockWriteLocalFile.mockImplementation(() => Promise.reject(new Error("disk full")));

    const onError = mock(() => {});
    const onImageSaved = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      onImageSaved,
      undefined,
      onError
    );

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith("disk full");
    expect(onImageSaved).not.toHaveBeenCalled();
  });

  test("does not call writeContainerFile (uses writeLocalFile only)", async () => {
    await processLocalClipboardPaste("/tmp/worktrees/env");

    expect(mockWriteLocalFile).toHaveBeenCalled();
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });
});

describe("processClipboardPaste", () => {
  beforeEach(() => {
    mockReadImage.mockClear();
    mockReadText.mockClear();
    mockWriteContainerFile.mockClear();
    mockWriteLocalFile.mockClear();
    mockToDataURL.mockClear();
    mockPutImageData.mockClear();

    mockReadImage.mockImplementation(() =>
      Promise.resolve({
        rgba: () => Promise.resolve(mockRgba),
        size: () => Promise.resolve(mockImageSize),
      })
    );
    mockReadText.mockImplementation(() => Promise.resolve("clipboard text"));
    mockWriteContainerFile.mockImplementation(() =>
      Promise.resolve("/workspace/.orkestrator/clipboard/test.png")
    );

    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: mockPutImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = mockToDataURL as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  test("saves clipboard image to container and calls onImageSaved", async () => {
    const onImageSaved = mock(() => {});

    const result = await processClipboardPaste("container-123", onImageSaved);

    expect(result).toBe(true);
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
    expect(mockWriteContainerFile.mock.calls[0][0]).toBe("container-123");
    expect(onImageSaved).toHaveBeenCalledWith("/workspace/.orkestrator/clipboard/test.png");
  });

  test("waits for async container text paste callbacks before resolving", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));

    let resolveCallback: (() => void) | null = null;
    let pasteFinished = false;

    const resultPromise = processClipboardPaste(
      "container-123",
      undefined,
      () => new Promise<void>((resolve) => {
        resolveCallback = resolve;
      })
    ).then((result) => {
      pasteFinished = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasteFinished).toBe(false);
    expect(resolveCallback).not.toBeNull();

    resolveCallback!();
    await expect(resultPromise).resolves.toBe(true);
    expect(pasteFinished).toBe(true);
  });

  test("falls back to text when no image in clipboard", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));

    const onTextPaste = mock(() => {});
    const result = await processClipboardPaste("container-123", undefined, onTextPaste);

    expect(result).toBe(true);
    expect(onTextPaste).toHaveBeenCalledWith("clipboard text");
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });

  test("does not call writeLocalFile (uses writeContainerFile only)", async () => {
    await processClipboardPaste("container-123");

    expect(mockWriteContainerFile).toHaveBeenCalled();
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });
});
