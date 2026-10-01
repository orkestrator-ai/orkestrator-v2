import { act, fireEvent } from "@testing-library/react";
// Registered once in tests/setup.ts; this module only varies its behavior.
import { mockReadImage } from "../../../../../tests/mocks/clipboard";

/**
 * Test support: lets a real paste event run through the shared composer paste
 * pipeline. Happy DOM has no canvas backend, so the canvas calls the pipeline
 * makes are answered with a 1×1 PNG.
 */
export function installImagePasteSupport(): () => void {
  const prototype = HTMLCanvasElement.prototype;
  const getContext = prototype.getContext;
  const toDataURL = prototype.toDataURL;
  const hadImageData = "ImageData" in globalThis;
  const imageData = (globalThis as { ImageData?: unknown }).ImageData;

  prototype.getContext = function () {
    return { putImageData() {}, drawImage() {} } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof prototype.getContext;
  prototype.toDataURL = () => "data:image/png;base64,cG5n";
  (globalThis as { ImageData?: unknown }).ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  mockReadImage.mockImplementation(async () => ({
    rgba: async () => new Uint8Array(4),
    size: async () => ({ width: 1, height: 1 }),
  }));

  return () => {
    prototype.getContext = getContext;
    prototype.toDataURL = toDataURL;
    if (hadImageData) (globalThis as { ImageData?: unknown }).ImageData = imageData;
    else delete (globalThis as { ImageData?: unknown }).ImageData;
    mockReadImage.mockImplementation(() => Promise.reject(new Error("no image")));
  };
}

/** Dispatches without waiting for decoding or writing to finish. */
export function dispatchImagePaste(target: HTMLElement): void {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  target.focus();
  fireEvent.paste(target, {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      files: [file],
      getData: () => "",
    },
  });
}

export async function settlePaste(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Focuses `target` and pastes an image file into it, then lets the paste settle. */
export async function pasteImage(target: HTMLElement): Promise<void> {
  act(() => dispatchImagePaste(target));
  await settlePaste();
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
