import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { mockReadImage } from "../../mocks/clipboard";
import { mockToastError as toastError } from "../../mocks/sonner";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png");

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
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
      if (data.byteLength !== width * height * 4) {
        throw new DOMException("The input data length is not valid", "InvalidStateError");
      }
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalConsoleError = console.error;
const originalOrkestrator = window.orkestrator;
const originalGateway = window.orkestratorGateway;
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "activeElement",
);
const putImageData = mock(() => {});
const onAttach = mock(() => {});
const consoleError = mock(() => {});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createImage(
  rgba = new Uint8Array([255, 0, 0, 255]),
  width = 1,
  height = 1,
) {
  return {
    rgba: async () => rgba,
    size: async () => ({ width, height }),
  };
}

function setActiveElement(element: Element) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => element,
  });
}

function HookHarness(props: {
  containerId: string | null;
  worktreePath?: string | null;
  onAttach?: typeof onAttach;
  logLabel?: string;
  contentEditable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useNativeComposeBarPaste({
    inputContainerRef: ref,
    containerId: props.containerId,
    worktreePath: props.worktreePath,
    onAttach: props.onAttach ?? onAttach,
    logLabel: props.logLabel ?? "HookHarness",
  });

  return (
    <div ref={ref}>
      {props.contentEditable ? (
        <div contentEditable data-testid="compose-input" />
      ) : (
        <textarea data-testid="compose-input" />
      )}
    </div>
  );
}

type PendingPasteStage = "read" | "rgba" | "size" | "write";
type LifecycleChange = "unmount" | "rerender";

async function expectPendingPasteToFinish(
  stage: PendingPasteStage,
  lifecycleChange: LifecycleChange,
) {
  const read = createDeferred<ReturnType<typeof createImage>>();
  const rgba = createDeferred<Uint8Array>();
  const size = createDeferred<{ width: number; height: number }>();
  const write = createDeferred<void>();
  const rgbaFn = mock(async () =>
    stage === "rgba" ? rgba.promise : new Uint8Array([255, 0, 0, 255]));
  const sizeFn = mock(async () =>
    stage === "size" ? size.promise : { width: 1, height: 1 });
  const image = { rgba: rgbaFn, size: sizeFn };

  mockReadImage.mockImplementation(async () =>
    stage === "read" ? read.promise : image);
  if (stage === "write") {
    mockWriteContainerFile.mockImplementation(async () => write.promise);
  }

  const rendered = render(<HookHarness containerId="container-1" />);
  setActiveElement(rendered.getByTestId("compose-input"));
  document.dispatchEvent(
    new Event("paste", { bubbles: true, cancelable: true }),
  );

  if (stage === "read") {
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));
  } else if (stage === "rgba") {
    await waitFor(() => expect(rgbaFn).toHaveBeenCalledTimes(1));
  } else if (stage === "size") {
    await waitFor(() => expect(sizeFn).toHaveBeenCalledTimes(1));
  } else {
    await waitFor(() => expect(mockWriteContainerFile).toHaveBeenCalledTimes(1));
  }

  if (lifecycleChange === "unmount") {
    rendered.unmount();
  } else {
    rendered.rerender(<HookHarness containerId="container-2" />);
  }

  await act(async () => {
    if (stage === "read") read.resolve(image);
    if (stage === "rgba") rgba.resolve(new Uint8Array([255, 0, 0, 255]));
    if (stage === "size") size.resolve({ width: 1, height: 1 });
    if (stage === "write") write.resolve();
    await Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
  expect(rgbaFn).toHaveBeenCalledTimes(1);
  expect(sizeFn).toHaveBeenCalledTimes(1);
  expect(mockWriteContainerFile).toHaveBeenCalledWith(
    "container-1",
    expect.any(String),
    "QUJD",
  );
  expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
    path: expect.stringContaining("/workspace/.orkestrator/clipboard/"),
  });
}

describe("useNativeComposeBarPaste", () => {
  beforeEach(() => {
    cleanup();
    mockReadImage.mockReset();
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    toastError.mockReset();
    onAttach.mockReset();
    consoleError.mockReset();
    putImageData.mockReset();
    console.error = consoleError;
    delete window.orkestrator;
    delete window.orkestratorGateway;

    mockReadImage.mockImplementation(async () => createImage());
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
    console.error = originalConsoleError;
    window.orkestrator = originalOrkestrator;
    window.orkestratorGateway = originalGateway;
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

  test("claims an Electron image paste synchronously", async () => {
    const imageRead = createDeferred<ReturnType<typeof createImage>>();
    mockReadImage.mockImplementation(async () => imageRead.promise);
    const stopPropagation = mock(() => {});
    window.orkestratorGateway = { enabled: true, desktop: true };

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    setActiveElement(getByTestId("compose-input"));

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "stopPropagation", {
      configurable: true,
      value: stopPropagation,
    });
    document.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    imageRead.resolve(createImage());
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
  });

  test("restores ordinary Electron text when the native clipboard has no image", async () => {
    window.orkestratorGateway = { enabled: true, desktop: true };
    mockReadImage.mockImplementation(async () => {
      throw new Error("No image in clipboard");
    });
    const inputEvent = mock(() => {});

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    input.value = "helloworld";
    input.setSelectionRange(5, 5);
    input.addEventListener("input", inputEvent);
    setActiveElement(input);

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [],
        files: [],
        getData: (type: string) => type === "text/plain" ? " pasted " : "",
      },
    });
    document.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(input.value).toBe("hello pasted world"));
    expect(inputEvent).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("restores ordinary Electron text into a contenteditable compose input", async () => {
    window.orkestratorGateway = { enabled: true, desktop: true };
    mockReadImage.mockImplementation(async () => {
      throw new Error("No image in clipboard");
    });

    const { getByTestId } = render(
      <HookHarness containerId="container-1" contentEditable />,
    );
    const input = getByTestId("compose-input") as HTMLDivElement;
    input.textContent = "helloworld";
    const textNode = input.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    setActiveElement(input);

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [],
        files: [],
        getData: (type: string) => type === "text/plain" ? " pasted " : "",
      },
    });
    document.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(input.textContent).toBe("hello pasted world"));
    expect(consoleError).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
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

  test("does not block a later paste when an earlier write never resolves", async () => {
    const firstWrite = createDeferred<string>();
    let writeCount = 0;
    mockWriteLocalFile.mockImplementation(async () => {
      writeCount += 1;
      return writeCount === 1
        ? firstWrite.promise
        : "/tmp/worktrees/env/.orkestrator/clipboard/second.png";
    });

    const { getByTestId } = render(
      <HookHarness containerId={null} worktreePath="/tmp/worktrees/env" />,
    );
    setActiveElement(getByTestId("compose-input"));

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(mockWriteLocalFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onAttach.mock.calls[0]?.[0].path).toBe(
      "/tmp/worktrees/env/.orkestrator/clipboard/second.png",
    );
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

  test("removes its document paste listener after unmount", async () => {
    const { getByTestId, unmount } = render(
      <HookHarness containerId="container-1" />,
    );
    const input = getByTestId("compose-input");
    setActiveElement(input);
    unmount();

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(mockReadImage).not.toHaveBeenCalled();
  });

  for (const stage of ["read", "rgba", "size", "write"] as const) {
    for (const lifecycleChange of ["unmount", "rerender"] as const) {
      test(`finishes a pending ${stage} after ${lifecycleChange}`, async () => {
        await expectPendingPasteToFinish(stage, lifecycleChange);
      });
    }
  }

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

  for (const [description, savedPath] of [
    ["null", null],
    ["empty", ""],
  ] as const) {
    test(`shows a configuration error when a local write returns ${description}`, async () => {
      mockWriteLocalFile.mockImplementation(
        async () => savedPath as unknown as string,
      );

      const { getByTestId } = render(
        <HookHarness containerId={null} worktreePath="/tmp/worktrees/env" />,
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
      expect(onAttach).not.toHaveBeenCalled();
    });
  }

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
          description: expect.stringContaining("could not be resized below the 8MB"),
        }),
      );
    });
  });

  test("downscales an oversized encoded image and still attaches it", async () => {
    const drawImage = mock(() => {});
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array(2000 * 1000 * 4),
      size: async () => ({ width: 2000, height: 1000 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
      drawImage,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = function () {
      return this.width === 2000
        ? `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`
        : "data:image/png;base64,QUJD";
    };

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    setActiveElement(getByTestId("compose-input"));

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(drawImage).toHaveBeenCalled();
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      previewUrl: "data:image/png;base64,QUJD",
    });
    expect(mockWriteContainerFile).toHaveBeenCalledWith(
      "container-1",
      expect.any(String),
      "QUJD",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  test("logs unexpected write failures without emitting an attachment", async () => {
    const writeError = new Error("disk full");
    mockWriteContainerFile.mockImplementation(async () => {
      throw writeError;
    });

    const { getByTestId } = render(
      <HookHarness containerId="container-1" logLabel="CustomPaste" />,
    );
    const input = getByTestId("compose-input") as HTMLTextAreaElement;
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));

    expect(consoleError).toHaveBeenCalledWith(
      "[CustomPaste] Unexpected paste error:",
      writeError,
    );
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("logs non-Error clipboard failures as unexpected", async () => {
    mockReadImage.mockImplementation(async () => {
      throw "native clipboard failure";
    });

    const { getByTestId } = render(<HookHarness containerId="container-1" />);
    setActiveElement(getByTestId("compose-input"));
    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(consoleError).toHaveBeenCalledWith(
      "[HookHarness] Unexpected paste error:",
      "native clipboard failure",
    );
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("logs local write rejections without emitting an attachment", async () => {
    const writeError = new Error(
      "EACCES: permission denied, open '/tmp/worktrees/env/.orkestrator/clipboard/image.png'",
    );
    mockWriteLocalFile.mockImplementation(async () => {
      throw writeError;
    });

    const { getByTestId } = render(
      <HookHarness containerId={null} worktreePath="/tmp/worktrees/env" />,
    );
    setActiveElement(getByTestId("compose-input"));
    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(consoleError).toHaveBeenCalledWith(
      "[HookHarness] Unexpected paste error:",
      writeError,
    );
    expect(onAttach).not.toHaveBeenCalled();
  });

  for (const [description, expectedError] of [
    ["clipboard message", new Error("Clipboard read failed")],
    ["no-image message", new Error("No image available")],
    ["not-found message", new Error("Image not found")],
    ["empty message", new Error("Clipboard is empty")],
    ["unavailable message", new Error("Clipboard unavailable")],
    [
      "clipboard error name",
      Object.assign(new Error("opaque native failure"), {
        name: "ClipboardError",
      }),
    ],
    [
      "not-found error name",
      Object.assign(new Error("opaque native failure"), {
        name: "NotFoundError",
      }),
    ],
  ] as const) {
    test(`does not log an expected ${description}`, async () => {
      mockReadImage.mockImplementation(async () => {
        throw expectedError;
      });

      const { getByTestId } = render(<HookHarness containerId="container-1" />);
      setActiveElement(getByTestId("compose-input"));
      document.dispatchEvent(
        new Event("paste", { bubbles: true, cancelable: true }),
      );

      await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(consoleError).not.toHaveBeenCalled();
      expect(onAttach).not.toHaveBeenCalled();
    });
  }

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
