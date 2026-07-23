import { describe, expect, mock, test } from "bun:test";
import { createBrowserPreviewMainAdapters } from "../../../apps/desktop/electron/browser-preview-main-adapters";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("browser preview main adapters", () => {
  test("emits state and open-link events and delegates clipboard writes", () => {
    const emitToRenderers = mock(() => undefined);
    const writeClipboardText = mock(() => undefined);
    const adapters = createBrowserPreviewMainAdapters({
      emitToRenderers,
      openExternal: mock(async () => undefined),
      writeClipboardText,
      logError: mock(() => undefined),
    });
    const state = {
      tabId: "browser-1",
      url: "http://localhost:3000/",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };
    const event = { tabId: "browser-1", url: "http://localhost:3000/docs" };

    adapters.emitState(state);
    adapters.emitOpenLink(event);
    adapters.writeClipboardText("copied text");

    expect(emitToRenderers).toHaveBeenNthCalledWith(1, "browser-preview-state", state);
    expect(emitToRenderers).toHaveBeenNthCalledWith(2, "browser-preview-open-link", event);
    expect(writeClipboardText).toHaveBeenCalledWith("copied text");
  });

  test("opens external links and logs rejected shell calls", async () => {
    const failure = new Error("browser unavailable");
    const openExternal = mock(async (_url: string) => undefined);
    const logError = mock(() => undefined);
    const adapters = createBrowserPreviewMainAdapters({
      emitToRenderers: mock(() => undefined),
      openExternal,
      writeClipboardText: mock(() => undefined),
      logError,
    });

    adapters.openExternal("https://example.com/success");
    await flushPromises();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/success");
    expect(logError).not.toHaveBeenCalled();

    openExternal.mockImplementationOnce(async () => {
      throw failure;
    });
    adapters.openExternal("https://example.com/failure");
    await flushPromises();
    expect(logError).toHaveBeenCalledWith(
      "[BrowserPreview] Failed to open link externally:",
      failure,
    );
  });
});
