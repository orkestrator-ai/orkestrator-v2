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
