/**
 * Preview host geometry in **renderer CSS pixels**, as reported by
 * `getBoundingClientRect()`. This is deliberately not the native window's
 * coordinate space: the host applies page zoom, so the main process scales
 * these by the host's zoom factor before handing them to `setBounds`. Senders
 * must not pre-scale, or the factor would be applied twice.
 */
export interface BrowserPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPreviewAttachInput {
  tabId: string;
  url: string;
  bounds: BrowserPreviewBounds;
  visible: boolean;
}

export interface BrowserPreviewState {
  tabId: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface BrowserPreviewOpenLinkEvent {
  tabId: string;
  url: string;
}
