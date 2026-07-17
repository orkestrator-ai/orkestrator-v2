import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { mockReadImage } from "../../mocks/clipboard";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
}));

import { ComposeBar } from "../../../apps/web/src/components/terminal/ComposeBar";
import { useTerminalSessionStore } from "../../../apps/web/src/stores/terminalSessionStore";

const SESSION_KEY = "container-1:tab-1";
const ONE_PIXEL_DATA_URL = "data:image/png;base64,QUJD";

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

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const mockPutImageData = mock(() => {});
const mockDrawImage = mock(() => {});

type DraftImage = {
  id: string;
  dataUrl: string;
  base64Data: string;
  width: number;
  height: number;
};

function image(id: string, base64Data = "QUJD"): DraftImage {
  return {
    id,
    dataUrl: `data:image/png;base64,${base64Data}`,
    base64Data,
    width: 1,
    height: 1,
  };
}

function seedDraft(text = "", images: DraftImage[] = [], sessionKey = SESSION_KEY) {
  useTerminalSessionStore.setState({
    composeDraftText: text ? new Map([[sessionKey, text]]) : new Map(),
    composeDraftImages: images.length
      ? new Map([[sessionKey, images]])
      : new Map(),
  });
}

function renderComposeBar(
  overrides: Partial<Parameters<typeof ComposeBar>[0]> = {},
) {
  const onClose = mock(() => {});
  const onSend = mock(() => {});
  const onAddressAll = mock(() => {});

  const result = render(
    <ComposeBar
      sessionKey={SESSION_KEY}
      isOpen
      onClose={onClose}
      onSend={onSend}
      containerId="container-1"
      worktreePath={null}
      onAddressAll={onAddressAll}
      {...overrides}
    />,
  );

  return { ...result, onClose, onSend, onAddressAll };
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(
    "Type a message (newlines become spaces)...",
  ) as HTMLTextAreaElement;
}

function getSendButton(): HTMLButtonElement {
  const composeBar = document.querySelector("[data-compose-bar]");
  const buttons = composeBar?.querySelectorAll("button");
  if (!buttons?.length) throw new Error("Send button not found");
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

function dispatchPaste(clipboardData?: unknown): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  if (clipboardData) {
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
  }
  document.dispatchEvent(event);
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Terminal ComposeBar", () => {
  beforeEach(() => {
    cleanup();
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    mockPutImageData.mockReset();
    mockDrawImage.mockReset();
    mockWriteContainerFile.mockImplementation(async () => {});
    mockWriteLocalFile.mockImplementation(async () => "/tmp/file.png");
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: mockPutImageData,
      drawImage: mockDrawImage,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      ONE_PIXEL_DATA_URL) as typeof HTMLCanvasElement.prototype.toDataURL;
    seedDraft();
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  });

  test("does not render while closed", () => {
    const { onSend } = renderComposeBar({ isOpen: false });

    expect(document.querySelector("[data-compose-bar]")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  test("focuses the textarea when opened and persists typed drafts", () => {
    const { unmount } = renderComposeBar();
    const textarea = getTextarea();

    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: "remember me" } });
    expect(useTerminalSessionStore.getState().getComposeDraftText(SESSION_KEY)).toBe(
      "remember me",
    );

    unmount();
    renderComposeBar();
    expect(getTextarea().value).toBe("remember me");
  });

  test("keeps drafts isolated by terminal session and caps textarea rows", () => {
    const manyLines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    seedDraft(manyLines);

    const { rerender } = renderComposeBar();
    expect(Number(getTextarea().getAttribute("rows"))).toBe(10);

    rerender(
      <ComposeBar
        sessionKey="container-2:tab-1"
        isOpen
        onClose={() => {}}
        onSend={() => {}}
        containerId="container-2"
      />,
    );
    expect(getTextarea().value).toBe("");
    expect(Number(getTextarea().getAttribute("rows"))).toBe(1);
  });

  test("hides Address all by default", () => {
    renderComposeBar();

    expect(screen.queryByRole("button", { name: "Address all" })).toBeNull();
  });

  test("delegates Address all to the review follow-up handler", () => {
    const { onAddressAll, onSend } = renderComposeBar({ showAddressAll: true });

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    expect(onAddressAll).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("claims a browser image paste synchronously and appends its preview", async () => {
    renderComposeBar();
    getTextarea().focus();
    const file = new File(["image"], "screenshot.png", { type: "image/png" });

    const pasteEvent = dispatchPaste({
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      files: [],
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByAltText("Attachment preview")).toBeTruthy());
    expect(mockReadImage).toHaveBeenCalledWith(file);
    expect(mockPutImageData).toHaveBeenCalledTimes(1);
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)[0]).toMatchObject({
      dataUrl: ONE_PIXEL_DATA_URL,
      base64Data: "QUJD",
      width: 1,
      height: 1,
    });
  });

  test("uses clipboard files as the WebKit browser-image fallback", async () => {
    renderComposeBar();
    getTextarea().focus();
    const textFile = new File(["text"], "note.txt", { type: "text/plain" });
    const imageFile = new File(["image"], "screenshot.png", { type: "image/png" });

    const pasteEvent = dispatchPaste({ items: [], files: [textFile, imageFile] });

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledWith(imageFile));
  });

  test("uses the Electron clipboard fallback and claims the paste after decoding", async () => {
    renderComposeBar();
    getTextarea().focus();

    const pasteEvent = dispatchPaste();

    expect(pasteEvent.defaultPrevented).toBe(false);
    await waitFor(() => expect(pasteEvent.defaultPrevented).toBe(true));
    expect(mockReadImage).toHaveBeenCalledWith(null);
    expect(screen.getByAltText("Attachment preview")).toBeTruthy();
  });

  test("leaves text paste untouched when no clipboard image is available", async () => {
    mockReadImage.mockImplementation(async () => {
      throw new Error("no image");
    });
    renderComposeBar();
    getTextarea().focus();

    const pasteEvent = dispatchPaste({
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      files: [],
    });
    await Promise.resolve();

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
  });

  test("ignores paste when closed or when another element has focus", async () => {
    const { rerender } = renderComposeBar({ isOpen: false });
    dispatchPaste();
    expect(mockReadImage).not.toHaveBeenCalled();

    rerender(
      <>
        <ComposeBar
          sessionKey={SESSION_KEY}
          isOpen
          onClose={() => {}}
          onSend={() => {}}
          containerId="container-1"
        />
        <input aria-label="outside" />
      </>,
    );
    screen.getByLabelText("outside").focus();
    dispatchPaste();
    await Promise.resolve();
    expect(mockReadImage).not.toHaveBeenCalled();
  });

  test("does not attach an image when canvas context creation fails", async () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    renderComposeBar();
    getTextarea().focus();

    dispatchPaste();
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    expect(mockPutImageData).not.toHaveBeenCalled();
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
  });

  test("rejects encoded images over 8MB without adding an attachment", async () => {
    HTMLCanvasElement.prototype.toDataURL = (() =>
      `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`) as typeof HTMLCanvasElement.prototype.toDataURL;
    renderComposeBar();
    getTextarea().focus();

    dispatchPaste();
    await waitFor(() => expect(mockPutImageData).toHaveBeenCalledTimes(1));

    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
  });

  test("resizes large RGBA images and records the final dimensions", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 4000, height: 4000 }),
    }));
    renderComposeBar();
    getTextarea().focus();

    dispatchPaste();

    await waitFor(() => {
      const attached = useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)[0];
      expect(attached).toMatchObject({ width: 2896, height: 2896 });
    });
    expect(mockDrawImage).toHaveBeenCalledTimes(1);
  });

  test("supports previewing, closing, and removing draft images", () => {
    seedDraft("", [image("one")]);
    renderComposeBar();

    const thumbnail = screen.getByAltText("Attachment preview");
    fireEvent.click(thumbnail);
    const fullPreview = screen.getByAltText("Full preview");
    expect(fullPreview.getAttribute("src")).toBe(image("one").dataUrl);

    fireEvent.click(fullPreview);
    expect(screen.getByAltText("Full preview")).toBeTruthy();
    fireEvent.click(fullPreview.parentElement!.parentElement!);
    expect(screen.queryByAltText("Full preview")).toBeNull();

    const removeButton = thumbnail.parentElement!.querySelector("button")!;
    fireEvent.click(removeButton);
    expect(screen.queryByAltText("Attachment preview")).toBeNull();
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
  });

  test("closes the preview with its close button", () => {
    seedDraft("", [image("one")]);
    renderComposeBar();
    fireEvent.click(screen.getByAltText("Attachment preview"));

    const fullPreview = screen.getByAltText("Full preview");
    const closeButton = fullPreview.parentElement!.querySelector("button")!;
    fireEvent.click(closeButton);

    expect(screen.queryByAltText("Full preview")).toBeNull();
  });

  test("sends trimmed text with container-backed images and clears the draft", async () => {
    seedDraft("  explain this  ", [image("one", "AAAA")]);
    const { onSend } = renderComposeBar();

    fireEvent.click(getSendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(mockWriteContainerFile).toHaveBeenCalledWith(
      "container-1",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      "AAAA",
    );
    expect(onSend.mock.calls[0]).toEqual([
      [expect.objectContaining({ id: expect.stringMatching(/^\/workspace\/\.orkestrator\/clipboard\//) })],
      "explain this",
    ]);
    expect(useTerminalSessionStore.getState().getComposeDraftText(SESSION_KEY)).toBe("");
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
  });

  test("writes images to a local worktree when no container is present", async () => {
    seedDraft("", [image("one", "BBBB")]);
    mockWriteLocalFile.mockImplementation(async () =>
      "/tmp/local repo/.orkestrator/clipboard/image.png");
    const { onSend } = renderComposeBar({
      containerId: null,
      worktreePath: "/tmp/local repo",
    });

    fireEvent.click(getSendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(mockWriteLocalFile).toHaveBeenCalledWith(
      "/tmp/local repo",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      "BBBB",
    );
    expect(onSend.mock.calls[0]?.[0]?.[0]?.id).toBe(
      "/tmp/local repo/.orkestrator/clipboard/image.png",
    );
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
  });

  test("continues after one image save fails and sends the remaining image", async () => {
    seedDraft("caption", [image("one", "AAAA"), image("two", "BBBB")]);
    mockWriteContainerFile
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async () => {});
    const { onSend } = renderComposeBar();

    fireEvent.click(getSendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0]?.[0]).toHaveLength(1);
    expect(onSend.mock.calls[0]?.[0]?.[0]?.base64Data).toBe("BBBB");
    expect(onSend.mock.calls[0]?.[1]).toBe("caption");
  });

  test("does not send unsaved image-only drafts without a persistence target", async () => {
    seedDraft("", [image("one")]);
    const { onSend } = renderComposeBar({ containerId: null, worktreePath: null });

    fireEvent.click(getSendButton());
    await waitFor(() => {
      expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toEqual([]);
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
  });

  test("does not send empty or whitespace-only drafts", () => {
    const { onSend } = renderComposeBar();
    expect(getSendButton().disabled).toBe(true);
    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(getTextarea(), { target: { value: "   " } });
    expect(getSendButton().disabled).toBe(true);
    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("guards against a second send while image persistence is pending", async () => {
    seedDraft("caption", [image("one")]);
    const write = deferred<void>();
    mockWriteContainerFile.mockImplementation(() => write.promise);
    const { onSend } = renderComposeBar();

    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    await waitFor(() => expect(getTextarea().disabled).toBe(true));
    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);

    write.resolve();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  test("preserves the draft when the send callback throws", async () => {
    seedDraft("keep me", [image("one")]);
    const onSend = mock(() => {
      throw new Error("terminal unavailable");
    });
    renderComposeBar({ onSend });

    fireEvent.click(getSendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    expect(useTerminalSessionStore.getState().getComposeDraftText(SESSION_KEY)).toBe("keep me");
    expect(useTerminalSessionStore.getState().getComposeDraftImages(SESSION_KEY)).toHaveLength(1);
    await waitFor(() => expect(getTextarea().disabled).toBe(false));
  });

  test("sends on Enter, but Shift+Enter does not send", async () => {
    seedDraft("hello");
    const { onSend } = renderComposeBar();

    fireEvent.keyDown(getTextarea(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(getTextarea(), { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith([], "hello"));
  });

  test("closes on Escape, Ctrl+I, and Cmd+I", () => {
    const { onClose } = renderComposeBar();

    fireEvent.keyDown(getTextarea(), { key: "Escape" });
    fireEvent.keyDown(getTextarea(), { key: "i", ctrlKey: true });
    fireEvent.keyDown(getTextarea(), { key: "I", metaKey: true });

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
