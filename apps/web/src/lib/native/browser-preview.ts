import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";

function api() {
  return window.orkestrator?.browserPreview;
}

export function hasNativeBrowserPreview(): boolean {
  return Boolean(api());
}

export function attachBrowserPreview(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState> {
  const nativeApi = api();
  if (!nativeApi) return Promise.reject(new Error("Native browser previews are unavailable"));
  return nativeApi.attach(input);
}

export function setBrowserPreviewBounds(tabId: string, bounds: BrowserPreviewBounds): Promise<BrowserPreviewState | null> {
  return api()?.setBounds(tabId, bounds) ?? Promise.resolve(null);
}

export function setBrowserPreviewVisible(tabId: string, visible: boolean): Promise<BrowserPreviewState | null> {
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

export function destroyBrowserPreview(tabId: string): Promise<void> {
  return api()?.destroy(tabId) ?? Promise.resolve();
}
