import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

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

import {
  processClipboardPaste,
  processLocalClipboardPaste,
  useClipboardImagePaste,
} from "../../../apps/web/src/hooks/useClipboardImagePaste";

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
    mockToDataURL.mockImplementation(() => "data:image/png;base64,iVBORw0KGgo=");

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

  test("reports oversized encoded images without writing them", async () => {
    mockToDataURL.mockImplementation(
      () => `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`,
    );
    const onError = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      undefined,
      undefined,
      onError,
    );

    expect(result).toBe(false);
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/^Image too large \(.+MB\)\. Maximum size is 8MB\.$/),
    );
  });

  test("falls back to text when a canvas context cannot be created", async () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const onTextPaste = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      undefined,
      onTextPaste,
    );

    expect(result).toBe(true);
    expect(onTextPaste).toHaveBeenCalledWith("clipboard text");
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("falls back to text when canvas encoding has no payload", async () => {
    mockToDataURL.mockImplementation(() => "data:image/png;base64");
    const onTextPaste = mock(() => {});

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      undefined,
      onTextPaste,
    );

    expect(result).toBe(true);
    expect(onTextPaste).toHaveBeenCalledWith("clipboard text");
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("returns false when reading fallback text fails", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));
    mockReadText.mockImplementation(() => Promise.reject(new Error("denied")));

    await expect(
      processLocalClipboardPaste("/tmp/worktrees/env"),
    ).resolves.toBe(false);
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("reports async onImageSaved callback failures", async () => {
    const onError = mock(() => {});
    const onImageSaved = mock(async () => {
      throw new Error("attachment callback failed");
    });

    const result = await processLocalClipboardPaste(
      "/tmp/worktrees/env",
      onImageSaved,
      undefined,
      onError,
    );

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith("attachment callback failed");
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
    mockToDataURL.mockImplementation(() => "data:image/png;base64,iVBORw0KGgo=");

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

  test("reports container write failures", async () => {
    mockWriteContainerFile.mockImplementation(() =>
      Promise.reject(new Error("container unavailable")),
    );
    const onError = mock(() => {});

    const result = await processClipboardPaste(
      "container-123",
      undefined,
      undefined,
      onError,
    );

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith("container unavailable");
  });

  test("reports oversized encoded images without writing them", async () => {
    mockToDataURL.mockImplementation(
      () => `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`,
    );
    const onError = mock(() => {});

    const result = await processClipboardPaste(
      "container-123",
      undefined,
      undefined,
      onError,
    );

    expect(result).toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Image too large"));
  });

  test("returns false when fallback text reading fails", async () => {
    mockReadImage.mockImplementation(() => Promise.reject(new Error("No image")));
    mockReadText.mockImplementation(() => Promise.reject(new Error("denied")));

    await expect(processClipboardPaste("container-123")).resolves.toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });
});

const originalFileReader = globalThis.FileReader;
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "activeElement",
);

function setActiveElement(element: Element) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => element,
  });
}

function imagePasteEvent(
  image: File,
  source: "items" | "files" = "items",
): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items:
        source === "items"
          ? [{ kind: "file", type: image.type, getAsFile: () => image }]
          : [],
      files: source === "files" ? [image] : [],
    },
  });
  return event;
}

interface HookHarnessProps {
  containerId: string | null;
  worktreePath?: string | null;
  isActive?: boolean;
  onImageSaved?: (path: string) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
}

function HookHarness({
  containerId,
  worktreePath,
  isActive = true,
  onImageSaved,
  onError,
}: HookHarnessProps) {
  useClipboardImagePaste({
    containerId,
    worktreePath,
    isActive,
    onImageSaved,
    onError,
  });
  return null;
}

describe("useClipboardImagePaste", () => {
  beforeEach(() => {
    cleanup();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    mockWriteContainerFile.mockImplementation(async () =>
      "/workspace/.orkestrator/clipboard/test.png"
    );
    mockWriteLocalFile.mockImplementation(async () =>
      "/tmp/worktrees/env/.orkestrator/clipboard/test.png"
    );
    globalThis.FileReader = originalFileReader;
    setActiveElement(document.body);
  });

  afterEach(() => {
    cleanup();
    globalThis.FileReader = originalFileReader;
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
  });

  test("claims an image paste and saves it to the container", async () => {
    const onImageSaved = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onImageSaved,
      }),
    );
    const event = imagePasteEvent(
      new File(["png"], "shot.png", { type: "image/png" }),
    );
    const stopPropagation = mock(() => {});
    event.stopPropagation = stopPropagation;

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockWriteContainerFile).toHaveBeenCalledTimes(1));
    expect(mockWriteContainerFile).toHaveBeenCalledWith(
      "container-1",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      expect.any(String),
    );
    expect(onImageSaved).toHaveBeenCalledWith(
      "/workspace/.orkestrator/clipboard/test.png",
    );
  });

  test("uses WebKit file-list payloads and saves them to a local worktree", async () => {
    const onImageSaved = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: null,
        worktreePath: "/tmp/worktrees/env",
        onImageSaved,
      }),
    );
    const event = imagePasteEvent(
      new File(["jpeg"], "photo.jpg", { type: "image/jpeg" }),
      "files",
    );

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(mockWriteLocalFile).toHaveBeenCalledTimes(1));
    expect(mockWriteLocalFile).toHaveBeenCalledWith(
      "/tmp/worktrees/env",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      expect.any(String),
    );
    expect(onImageSaved).toHaveBeenCalledWith(
      "/tmp/worktrees/env/.orkestrator/clipboard/test.png",
    );
  });

  test("ignores events while inactive or without a configured target", async () => {
    const inactive = render(
      createElement(HookHarness, {
        containerId: "container-1",
        isActive: false,
      }),
    );
    const inactiveEvent = imagePasteEvent(
      new File(["png"], "inactive.png", { type: "image/png" }),
    );
    document.dispatchEvent(inactiveEvent);
    inactive.unmount();

    render(createElement(HookHarness, { containerId: null }));
    const noTargetEvent = imagePasteEvent(
      new File(["png"], "no-target.png", { type: "image/png" }),
    );
    document.dispatchEvent(noTargetEvent);
    await Promise.resolve();

    expect(inactiveEvent.defaultPrevented).toBe(false);
    expect(noTargetEvent.defaultPrevented).toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("leaves compose-bar and dialog paste events to their local handlers", async () => {
    render(createElement(HookHarness, { containerId: "container-1" }));
    const composeInput = document.createElement("textarea");
    const compose = document.createElement("div");
    compose.dataset.composeBar = "true";
    compose.append(composeInput);
    document.body.append(compose);
    setActiveElement(composeInput);
    const composeEvent = imagePasteEvent(
      new File(["png"], "compose.png", { type: "image/png" }),
    );
    document.dispatchEvent(composeEvent);

    const dialogInput = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.append(dialogInput);
    document.body.append(dialog);
    setActiveElement(dialogInput);
    const dialogEvent = imagePasteEvent(
      new File(["png"], "dialog.png", { type: "image/png" }),
    );
    document.dispatchEvent(dialogEvent);
    await Promise.resolve();

    expect(composeEvent.defaultPrevented).toBe(false);
    expect(dialogEvent.defaultPrevented).toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    compose.remove();
    dialog.remove();
  });

  test("allows non-image clipboard data to continue normally", async () => {
    render(createElement(HookHarness, { containerId: "container-1" }));
    const event = new Event("paste", {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
        files: [],
      },
    });

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });

  test("rejects oversized files before reading or writing them", async () => {
    const onError = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onError,
      }),
    );
    const event = imagePasteEvent(
      new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.png", {
        type: "image/png",
      }),
    );

    document.dispatchEvent(event);

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Image too large")),
    );
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });

  test("reports invalid FileReader output", async () => {
    class InvalidDataUrlReader {
      result: string | ArrayBuffer | null = "not-a-data-url";
      onloadend: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onloadend?.(new ProgressEvent("loadend") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = InvalidDataUrlReader as unknown as typeof FileReader;
    const onError = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onError,
      }),
    );

    document.dispatchEvent(
      imagePasteEvent(new File(["png"], "bad.png", { type: "image/png" })),
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Invalid data URL format"),
    );
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });

  test("reports FileReader failures and remains usable for the next paste", async () => {
    class FailingReader {
      result: string | ArrayBuffer | null = null;
      onloadend: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;
    const onError = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onError,
      }),
    );
    const file = new File(["png"], "failed.png", { type: "image/png" });

    document.dispatchEvent(imagePasteEvent(file));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Failed to save image"),
    );

    globalThis.FileReader = originalFileReader;
    document.dispatchEvent(imagePasteEvent(file));
    await waitFor(() => expect(mockWriteContainerFile).toHaveBeenCalledTimes(1));
  });

  test("prevents duplicate writes while an image is already being saved", async () => {
    let finishWrite: ((path: string) => void) | undefined;
    mockWriteContainerFile.mockImplementation(
      () => new Promise<string>((resolve) => {
        finishWrite = resolve;
      }),
    );
    const onImageSaved = mock(() => {});
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onImageSaved,
      }),
    );
    const file = new File(["png"], "shot.png", { type: "image/png" });

    document.dispatchEvent(imagePasteEvent(file));
    await waitFor(() => expect(mockWriteContainerFile).toHaveBeenCalledTimes(1));
    const duplicateEvent = imagePasteEvent(file);
    document.dispatchEvent(duplicateEvent);

    expect(duplicateEvent.defaultPrevented).toBe(true);
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
    finishWrite?.("/workspace/.orkestrator/clipboard/test.png");
    await waitFor(() => expect(onImageSaved).toHaveBeenCalledTimes(1));
  });

  test("reports save and attachment callback failures", async () => {
    const onError = mock(() => {});
    const onImageSaved = mock(async () => {
      throw new Error("attachment rejected");
    });
    render(
      createElement(HookHarness, {
        containerId: "container-1",
        onImageSaved,
        onError,
      }),
    );

    document.dispatchEvent(
      imagePasteEvent(new File(["png"], "shot.png", { type: "image/png" })),
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith("attachment rejected"));
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  globalThis.FileReader = originalFileReader;
});
