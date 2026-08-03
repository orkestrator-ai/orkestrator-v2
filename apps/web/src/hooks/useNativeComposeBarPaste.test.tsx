import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { PastedImageAttachment } from "./useNativeComposeBarPaste";
import { useNativeComposeBarPaste } from "./useNativeComposeBarPaste";
import { mockReadImage } from "../../../../tests/mocks/clipboard";

// happy-dom's canvas has no 2d context, so the hook's `ctx` guard would bail
// before the paste can be processed. Patch the context with a minimal stub.
HTMLCanvasElement.prototype.getContext = (() => ({
  putImageData: () => {},
  fillRect: () => {},
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// happy-dom does not surface ImageData in the Bun test worker; provide the
// minimal shape the hook's paste pipeline needs.
class FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
(globalThis as { ImageData?: unknown }).ImageData = FakeImageData;

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async (_worktreePath: string, filePath: string) => `/tmp/env/${filePath}`);
const mockGetPastedImageBlob = mock(() => ({}) as unknown as Blob);

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
}));

mock.module("@/lib/canvas-utils", () => ({
  MAX_IMAGE_DIMENSION: 4000,
  resizeCanvasToMaxDimension: (canvas: HTMLCanvasElement) => canvas,
  resizeCanvasIfNeeded: (canvas: HTMLCanvasElement) => canvas,
  encodeCanvasAsPngWithinSize: (canvas: HTMLCanvasElement) => ({
    canvas,
    dataUrl: "data:image/png;base64,QUJD",
    base64Data: "QUJD",
  }),
}));

mock.module("@/lib/clipboard-event", () => ({
  getPastedImageBlob: mockGetPastedImageBlob,
}));

function pasteInto(harness: HTMLElement): void {
  const target = harness.querySelector<HTMLElement>("input");
  if (!target) throw new Error("no paste target");
  target.focus();
  document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
}

function renderHarness(options: {
  containerId?: string;
  worktreePath?: string;
  canAttachImage?: (attachment: PastedImageAttachment) => boolean;
  onImageRejected?: () => void;
  onAttach?: (attachment: PastedImageAttachment) => void;
}) {
  const onImageRejected = mock(options.onImageRejected ?? (() => {}));
  const onAttach = mock(options.onAttach ?? ((_attachment: PastedImageAttachment) => {}));
  const result = render(
    <PasteHarness
      containerId={options.containerId}
      worktreePath={options.worktreePath}
      canAttachImage={options.canAttachImage}
      onImageRejected={onImageRejected}
      onAttach={onAttach}
    />,
  );
  return {
    onImageRejected,
    onAttach,
    harness: result.container as HTMLElement,
  };
}

function PasteHarness({
  containerId,
  worktreePath,
  canAttachImage,
  onImageRejected,
  onAttach,
}: {
  containerId?: string;
  worktreePath?: string;
  canAttachImage?: (attachment: PastedImageAttachment) => boolean;
  onImageRejected?: () => void;
  onAttach?: (attachment: PastedImageAttachment) => void;
}) {
  const inputContainerRef = useRef<HTMLDivElement>(null);
  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    canAttachImage,
    onImageRejected,
    onAttach: onAttach ?? (() => {}),
    logLabel: "TestComposeBar",
  });
  return (
    <div ref={inputContainerRef}>
      <input />
    </div>
  );
}

beforeEach(() => {
  mockWriteContainerFile.mockClear();
  mockWriteLocalFile.mockClear();
  mockGetPastedImageBlob.mockClear();
  mockReadImage.mockImplementation(async () => ({
    rgba: async () => new Uint8Array(4 * 4),
    size: async () => ({ width: 2, height: 2 }),
  }));
});

afterEach(cleanup);

describe("useNativeComposeBarPaste canAttachImage gate", () => {
  test("refuses the paste before writing the file when the gate returns false", async () => {
    const { onImageRejected, onAttach, harness } = renderHarness({
      worktreePath: "/tmp/env",
      canAttachImage: () => false,
    });

    pasteInto(harness);

    await waitFor(() => expect(onImageRejected).toHaveBeenCalled());
    expect(mockWriteLocalFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  test("writes and attaches when the gate returns true", async () => {
    const { onImageRejected, onAttach, harness } = renderHarness({
      worktreePath: "/tmp/env",
      canAttachImage: () => true,
    });

    pasteInto(harness);

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(mockWriteLocalFile).toHaveBeenCalledTimes(1);
    const attachment = onAttach.mock.calls[0]?.[0]!;
    const name: string = attachment.name;
    expect(attachment.path).toBe(`/tmp/env/.orkestrator/clipboard/${name}`);
    expect(attachment).toMatchObject({
      type: "image",
      name: expect.stringMatching(/^clipboard-.*\.png$/),
      previewUrl: "data:image/png;base64,QUJD",
    });
    expect(onImageRejected).not.toHaveBeenCalled();
  });

  test("writes into the container when containerized", async () => {
    const { onAttach, harness } = renderHarness({ containerId: "container-1" });

    pasteInto(harness);

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(mockWriteContainerFile).toHaveBeenCalledTimes(1);
    const attachment = onAttach.mock.calls[0]?.[0]!;
    expect(attachment.path).toBe("/workspace/.orkestrator/clipboard/" + attachment.name);
  });

  test("behaves as before when no gate is provided", async () => {
    const { onImageRejected, onAttach, harness } = renderHarness({
      worktreePath: "/tmp/env",
    });

    pasteInto(harness);

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(mockWriteLocalFile).toHaveBeenCalledTimes(1);
    expect(onImageRejected).not.toHaveBeenCalled();
  });
});
