import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BrowserPreviewAttachInput, BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
import {
  attachBrowserPreview,
  destroyBrowserPreview,
  goBackBrowserPreview,
  goForwardBrowserPreview,
  hasNativeBrowserPreview,
  navigateBrowserPreview,
  openBrowserPreviewDevTools,
  reloadBrowserPreview,
  setBrowserPreviewBounds,
  setBrowserPreviewVisible,
} from "./browser-preview";

const originalOrkestrator = window.orkestrator;

function state(url = "http://localhost:3000/"): BrowserPreviewState {
  return {
    tabId: "browser-1",
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
}

afterEach(() => {
  window.orkestrator = originalOrkestrator;
});

describe("native browser preview wrapper", () => {
  test("forwards every typed browser-preview operation", async () => {
    const current = state();
    const browserPreview: NonNullable<NonNullable<Window["orkestrator"]>["browserPreview"]> = {
      attach: mock(async (_input: BrowserPreviewAttachInput) => current),
      setBounds: mock(async () => current),
      setVisible: mock(async () => current),
      navigate: mock(async (_tabId: string, url: string) => state(url)),
      goBack: mock(async () => current),
      goForward: mock(async () => current),
      reload: mock(async () => current),
      openDevTools: mock(async () => current),
      destroy: mock(async () => {}),
    };
    window.orkestrator = { browserPreview } as Window["orkestrator"];
    const bounds = { x: 1, y: 2, width: 300, height: 200 };
    const input = { tabId: "browser-1", url: current.url, bounds, visible: true };

    expect(hasNativeBrowserPreview()).toBe(true);
    await expect(attachBrowserPreview(input)).resolves.toEqual(current);
    await expect(setBrowserPreviewBounds("browser-1", bounds)).resolves.toEqual(current);
    await expect(setBrowserPreviewVisible("browser-1", false)).resolves.toEqual(current);
    await expect(navigateBrowserPreview("browser-1", "http://localhost:4000/")).resolves.toMatchObject({
      url: "http://localhost:4000/",
    });
    await goBackBrowserPreview("browser-1");
    await goForwardBrowserPreview("browser-1");
    await reloadBrowserPreview("browser-1");
    await openBrowserPreviewDevTools("browser-1");
    await destroyBrowserPreview("browser-1");

    expect(browserPreview.attach).toHaveBeenCalledWith(input);
    expect(browserPreview.setBounds).toHaveBeenCalledWith("browser-1", bounds);
    expect(browserPreview.setVisible).toHaveBeenCalledWith("browser-1", false);
    expect(browserPreview.navigate).toHaveBeenCalledWith("browser-1", "http://localhost:4000/");
    expect(browserPreview.goBack).toHaveBeenCalledWith("browser-1");
    expect(browserPreview.goForward).toHaveBeenCalledWith("browser-1");
    expect(browserPreview.reload).toHaveBeenCalledWith("browser-1");
    expect(browserPreview.openDevTools).toHaveBeenCalledWith("browser-1");
    expect(browserPreview.destroy).toHaveBeenCalledWith("browser-1");
  });

  test("returns benign defaults for optional updates when the API is missing", async () => {
    window.orkestrator = undefined;
    expect(hasNativeBrowserPreview()).toBe(false);
    await expect(setBrowserPreviewBounds("browser-1", { x: 0, y: 0, width: 0, height: 0 })).resolves.toBeNull();
    await expect(setBrowserPreviewVisible("browser-1", false)).resolves.toBeNull();
    await expect(destroyBrowserPreview("browser-1")).resolves.toBeUndefined();
  });

  test("rejects required operations when the API is missing", async () => {
    window.orkestrator = undefined;
    const unavailable = "Native browser previews are unavailable";
    await expect(attachBrowserPreview({
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      visible: true,
    })).rejects.toThrow(unavailable);
    await expect(navigateBrowserPreview("browser-1", "http://localhost:3000/")).rejects.toThrow(unavailable);
    await expect(goBackBrowserPreview("browser-1")).rejects.toThrow(unavailable);
    await expect(goForwardBrowserPreview("browser-1")).rejects.toThrow(unavailable);
    await expect(reloadBrowserPreview("browser-1")).rejects.toThrow(unavailable);
    await expect(openBrowserPreviewDevTools("browser-1")).rejects.toThrow(unavailable);
  });
});
