import {
  BROWSER_PREVIEW_ANNOTATION_EVENT,
  type BrowserPreviewAnnotationEvent,
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
  "emitState" | "emitOpenLink" | "emitAnnotationEvent" | "openExternal" | "writeClipboardText"
>;

export function createBrowserPreviewMainAdapters({
  emitToRenderers,
  openExternal,
  writeClipboardText,
  logError,
}: CreateBrowserPreviewMainAdaptersOptions): BrowserPreviewMainAdapters {
  return {
    emitState: (state: BrowserPreviewState) => emitToRenderers("browser-preview-state", state),
    emitAnnotationEvent: (event: BrowserPreviewAnnotationEvent) =>
      emitToRenderers(BROWSER_PREVIEW_ANNOTATION_EVENT, event),
    emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => {
      emitToRenderers("browser-preview-open-link", event);
    },
    openExternal: (url: string) => {
      void openExternal(url).catch((error: unknown) => {
        logError("[BrowserPreview] Failed to open link externally:", error);
      });
    },
    writeClipboardText,
  };
}
