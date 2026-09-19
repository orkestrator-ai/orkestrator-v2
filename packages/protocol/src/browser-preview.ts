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

export interface BrowserPreviewElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BrowserPreviewElementAncestor {
  tagName: string;
  selector: string;
  id: string | null;
  classNames: string[];
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
}

export interface BrowserPreviewElementDetails {
  pageUrl: string;
  pageTitle: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  tagName: string;
  selector: string;
  cssPath: string;
  xpath: string;
  id: string | null;
  classNames: string[];
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  text: string;
  outerHtml: string;
  attributes: Record<string, string>;
  rect: BrowserPreviewElementRect;
  styles: Record<string, string>;
  hierarchy: BrowserPreviewElementAncestor[];
}

export type BrowserPreviewAnnotationStatus =
  | { status: "inactive" | "active" | "cancelled" }
  | {
      status: "submitted";
      comment: string;
      element: BrowserPreviewElementDetails;
      /** PNG data URL captured from the browser frame while the element highlight is visible. */
      screenshotDataUrl: string;
    };
