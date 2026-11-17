import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { canWriteImage, canWriteWebpImage, writeImage } from "./clipboard-image-write";

const png = () => Promise.resolve(new Blob([new Uint8Array([1, 2])], { type: "image/png" }));
const webp = () => Promise.resolve(new Blob([new Uint8Array([3])], { type: "image/webp" }));

class FakeClipboardItem {
  static supports = (_type: string) => false;
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

describe("clipboard image writes", () => {
  let saved: {
    orkestrator: typeof window.orkestrator;
    gateway: typeof window.orkestratorGateway;
    clipboard: PropertyDescriptor | undefined;
    item: unknown;
  };
  beforeEach(() => {
    saved = {
      orkestrator: window.orkestrator,
      gateway: window.orkestratorGateway,
      clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"),
      item: (globalThis as { ClipboardItem?: unknown }).ClipboardItem,
    };
  });
  afterEach(() => {
    window.orkestrator = saved.orkestrator;
    window.orkestratorGateway = saved.gateway;
    if (saved.clipboard) Object.defineProperty(navigator, "clipboard", saved.clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = saved.item;
  });

  function desktop() {
    const write = mock(async (_png: string, _options?: { webpDataUrl?: string }) => undefined);
    window.orkestrator = {
      clipboard: { writeImage: write },
    } as unknown as typeof window.orkestrator;
    window.orkestratorGateway = undefined;
    return write;
  }
  function browser() {
    const write = mock(async (_items: FakeClipboardItem[]) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    return write;
  }

  test("the desktop app sends the PNG and the WebP as data URLs", async () => {
    const write = desktop();
    expect(canWriteImage()).toBe(true);
    expect(canWriteWebpImage()).toBe(true);
    await writeImage({ png: png(), webp: webp() });
    expect(write).toHaveBeenCalledWith("data:image/png;base64,AQI=", {
      webpDataUrl: "data:image/webp;base64,Aw==",
    });
    await writeImage({ png: png() });
    expect(write.mock.calls[1]).toEqual(["data:image/png;base64,AQI=", undefined]);
  });

  test("a browser gateway client writes through navigator.clipboard, not the gateway's no-op", async () => {
    const gatewayWrite = desktop();
    window.orkestratorGateway = { enabled: true };
    const write = browser();
    expect(canWriteImage()).toBe(true);
    // No browser clipboard takes image/webp, so Copy WEBP is not offered.
    expect(canWriteWebpImage()).toBe(false);
    const images = { png: png() };
    // Synchronous: the write must start inside the click.
    void writeImage(images);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0][0]!.items).toEqual({ "image/png": images.png });
    expect(gatewayWrite).not.toHaveBeenCalled();
  });

  test("a browser that accepts image/webp gets both images in one entry", async () => {
    window.orkestrator = undefined;
    const write = browser();
    FakeClipboardItem.supports = (type) => type === "image/webp";
    try {
      expect(canWriteWebpImage()).toBe(true);
      const images = { png: png(), webp: webp() };
      await writeImage(images);
      expect(Object.keys(write.mock.calls[0]![0][0]!.items)).toEqual(["image/png", "image/webp"]);
    } finally {
      FakeClipboardItem.supports = () => false;
    }
  });

  test("a browser without an image clipboard refuses", async () => {
    window.orkestrator = undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = undefined;
    expect(canWriteImage()).toBe(false);
    expect(canWriteWebpImage()).toBe(false);
    await expect(writeImage({ png: png() })).rejects.toThrow(
      "This browser cannot copy images to the clipboard",
    );
  });
});
