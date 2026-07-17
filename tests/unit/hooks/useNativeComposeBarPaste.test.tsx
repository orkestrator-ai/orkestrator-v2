import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { mockReadImage } from "../../mocks/clipboard";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png");
const toastError = mock(() => {});

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
}));

mock.module("sonner", () => ({
  toast: {
    error: toastError,
  },
}));

const { useNativeComposeBarPaste } = await import(
  "../../../apps/web/src/hooks/useNativeComposeBarPaste"
);

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
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "activeElement",
);
const putImageData = mock(() => {});
const onAttach = mock(() => {});

function setActiveElement(element: Element) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => element,
  });
}

function HookHarness(props: {
  containerId: string | null;
  worktreePath?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useNativeComposeBarPaste({
    inputContainerRef: ref,
    containerId: props.containerId,
    worktreePath: props.worktreePath,
    onAttach,
    logLabel: "HookHarness",
  });

  return (
    <div ref={ref}>
      <textarea data-testid="compose-input" />
    </div>
  );
}

describe("useNativeComposeBarPaste", () => {
  beforeEach(() => {
    cleanup();
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    toastError.mockReset();
    onAttach.mockReset();
    putImageData.mockReset();

    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    mockWriteContainerFile.mockImplementation(async () => {});
    mockWriteLocalFile.mockImplementation(
      async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png",
    );

    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
  });

  test("writes pasted images to the container and emits an attachment", async () => {
    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    const pasteEvent = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(pasteEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
    expect(mockWriteContainerFile.mock.calls[0]?.[0]).toBe("container-1");
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
      type: "image",
        path: expect.stringContaining("/workspace/.orkestrator/clipboard/"),
      previewUrl: "data:image/png;base64,QUJD",
      }),
    );
  });

  test("claims browser clipboard image items synchronously", async () => {
    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    const imageFile = new File(["image"], "screenshot.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => imageFile }],
        files: [],
      },
    });

    document.dispatchEvent(pasteEvent);

    // This must happen before any FileReader/canvas work; otherwise the
    // contenteditable target also handles the same image as a text paste.
    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
  });

  test("reads WebKit file-list image payloads and claims the paste synchronously", async () => {
    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    const imageFile = new File(["image"], "webkit-shot.png", {
      type: "image/png",
    });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [],
        files: [imageFile],
      },
    });

    document.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledWith(imageFile));
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  test("writes pasted images to the local worktree when no container id is present", async () => {
    const { getByTestId } = render(
      <HookHarness
        containerId={null}
        worktreePath="/tmp/worktrees/env"
      />,
    );
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWriteLocalFile).toHaveBeenCalledWith(
      "/tmp/worktrees/env",
      expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
      "QUJD",
    );
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      path: "/tmp/worktrees/env/.orkestrator/clipboard/test.png",
    });
  });

  test("ignores paste events when focus is outside the compose bar", async () => {
    render(
      <>
        <HookHarness containerId="container-1" />
        <textarea data-testid="outside-input" />
      </>,
    );

    const outside = document.querySelector('[data-testid="outside-input"]') as HTMLTextAreaElement;
    setActiveElement(outside);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(mockReadImage).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("does not write or attach when the canvas context is unavailable", async () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    setActiveElement(getByTestId("compose-input"));

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("shows a configuration error when there is no save target", async () => {
    const { getByTestId } = render(
      <HookHarness containerId={null} worktreePath={null} />,
    );
    setActiveElement(getByTestId("compose-input"));

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Cannot save image",
        expect.objectContaining({
          description: "Environment not properly configured for attachments",
        }),
      );
    });
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("shows an error toast when the encoded image exceeds the size limit", async () => {
    const oversizedToDataURL = mock(() =>
      `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`);
    HTMLCanvasElement.prototype.toDataURL = oversizedToDataURL as typeof HTMLCanvasElement.prototype.toDataURL;

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oversizedToDataURL).toHaveBeenCalledTimes(1);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Image too large",
        expect.objectContaining({
          description: expect.stringContaining("Maximum is 8MB."),
        }),
      );
    });
  });

  test("logs unexpected write failures without emitting an attachment", async () => {
    mockWriteContainerFile.mockImplementation(async () => {
      throw new Error("disk full");
    });

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAttach).not.toHaveBeenCalled();
  });

  test("falls through to the browser when the clipboard has no image", async () => {
    mockReadImage.mockImplementation(async () => {
      throw new Error("No image");
    });

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    const pasteEvent = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(pasteEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(mockWriteContainerFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
