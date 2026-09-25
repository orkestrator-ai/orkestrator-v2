import type {
  BrowserPreviewAttachInput,
  BrowserPreviewCaptureApi,
  BrowserPreviewCaptureCapabilities,
  BrowserPreviewBounds,
  BrowserPreviewServiceTarget,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";

function api() {
  return window.orkestrator?.browserPreview;
}

export function hasNativeBrowserPreview(): boolean {
  return Boolean(api());
}

export function attachBrowserPreview(
  input: BrowserPreviewAttachInput,
): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.attach(input);
}

export function setBrowserPreviewBounds(
  tabId: string,
  bounds: BrowserPreviewBounds,
): Promise<BrowserPreviewState | null> {
  return api()?.setBounds(tabId, bounds) ?? Promise.resolve(null);
}

export function setBrowserPreviewVisible(
  tabId: string,
  visible: boolean,
): Promise<BrowserPreviewState | null> {
  return api()?.setVisible(tabId, visible) ?? Promise.resolve(null);
}

export function navigateBrowserPreview(tabId: string, url: string): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.navigate(tabId, url);
}

export function goBackBrowserPreview(tabId: string): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.goBack(tabId);
}

export function goForwardBrowserPreview(tabId: string): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.goForward(tabId);
}

export function reloadBrowserPreview(tabId: string): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.reload(tabId);
}

export function openBrowserPreviewDevTools(tabId: string): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.openDevTools(tabId);
}

/**
 * Trusted capture surface (pending spool, selection, pins). Present only on
 * desktop builds that implement it; every caller feature-detects.
 */
export function getBrowserPreviewCaptureApi(): BrowserPreviewCaptureApi | null {
  return api()?.capture ?? null;
}

export function hasBrowserPreviewCapture(): boolean {
  return getBrowserPreviewCaptureApi() !== null;
}

/**
 * What this desktop build can capture (contract version 2+). Null on clients
 * without native capture; a capture API without the method is a version 1
 * desktop, reported as element/text/region/page with no version 2 features.
 * Intersect `modes` with the backend's advertised capture targets.
 */
export async function getBrowserPreviewCaptureCapabilities(): Promise<BrowserPreviewCaptureCapabilities | null> {
  const capture = getBrowserPreviewCaptureApi();
  if (!capture) return null;
  if (capture.getCaptureCapabilities) return capture.getCaptureCapabilities();
  return {
    contractVersion: 1,
    modes: ["element", "text", "region", "page"],
    features: {
      keyboardSelection: false,
      recapture: false,
      receipts: false,
      resultCapture: { stability: false, masks: false },
      regionCrop: false,
      responsiveSets: null,
      livePins: false,
      showOnPage: false,
      expiredNotices: false,
    },
  };
}

export function destroyBrowserPreview(tabId: string): Promise<void> {
  return api()?.destroy(tabId) ?? Promise.resolve();
}

/** Clear one service preview's cookies and storage (its own partition only). */
export function resetBrowserPreviewServiceSiteData(
  target: BrowserPreviewServiceTarget,
): Promise<void> {
  const reset = api()?.resetServiceSiteData;
  if (!reset) return Promise.reject(new Error("Resetting preview site data needs the desktop app"));
  return reset(target);
}
