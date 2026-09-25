import {
  BROWSER_PREVIEW_CAPTURE_EVENT,
  type BrowserPreviewCaptureEvent,
  type BrowserPreviewOpenLinkEvent,
  type BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import type { InitializeBrowserPreviewsOptions } from "./browser-preview-startup.js";

export interface CreateBrowserPreviewMainAdaptersOptions {
  emitToRenderers: (event: string, payload: unknown) => void;
  openExternal: (url: string) => Promise<void>;
  writeClipboardText: (text: string) => void;
  logError: (message: string, error: unknown) => void;
}

export type BrowserPreviewMainAdapters = Pick<
  InitializeBrowserPreviewsOptions,
  "emitState" | "emitOpenLink" | "openExternal" | "writeClipboardText" | "emitCaptureEvent"
>;

export function createBrowserPreviewMainAdapters({
  emitToRenderers,
  openExternal,
  writeClipboardText,
  logError,
}: CreateBrowserPreviewMainAdaptersOptions): BrowserPreviewMainAdapters {
  return {
    emitState: (state: BrowserPreviewState) => emitToRenderers("browser-preview-state", state),
    emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => {
      emitToRenderers("browser-preview-open-link", event);
    },
    // Content-free hint; the renderer reads status and the spool for content.
    emitCaptureEvent: (event: BrowserPreviewCaptureEvent) =>
      emitToRenderers(BROWSER_PREVIEW_CAPTURE_EVENT, event),
    openExternal: (url: string) => {
      void openExternal(url).catch((error: unknown) => {
        logError("[BrowserPreview] Failed to open link externally:", error);
      });
    },
    writeClipboardText,
  };
}
