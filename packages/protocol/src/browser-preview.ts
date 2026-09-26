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

/**
 * A registered preview service, resolved to a transport by Electron main.
 * The renderer never supplies a transport URL for a service preview.
 */
export interface BrowserPreviewServiceTarget {
  backendInstanceId: string;
  environmentId: string;
  serviceId: string;
  /** App-relative path, query, and fragment. */
  path: string;
}

export interface BrowserPreviewAttachInput {
  tabId: string;
  /** Legacy/manual previews: a loopback or gateway-preview URL. */
  url?: string;
  /** Service previews: resolved and authorized in the main process. */
  service?: BrowserPreviewServiceTarget;
  bounds: BrowserPreviewBounds;
  visible: boolean;
}

/** Effective transport for a service preview, separate from page loading. */
export interface BrowserPreviewTransportState {
  mode: "desktop-tunnel" | "legacy";
  state: "connecting" | "ready" | "reconnecting" | "unavailable";
  /** Stable failure category (`PreviewErrorCategory`) when unavailable. */
  failure?: string;
  message?: string;
}

export interface BrowserPreviewState {
  tabId: string;
  /** Actual view URL. For service previews this is a runtime transport URL; never persist it. */
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  /** Present for service previews: the durable identity and app-relative path. */
  service?: { serviceId: string; path: string; displayUrl: string };
  transport?: BrowserPreviewTransportState;
}

export interface BrowserPreviewOpenLinkEvent {
  tabId: string;
  url: string;
  /** Same-service link from a service preview: open as a service tab. */
  service?: BrowserPreviewServiceTarget;
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

export type BrowserPreviewAnnotationStatus = (
  | { status: "inactive" | "active" | "cancelled" }
  | { status: "error"; message: string }
  | {
      status: "submitted";
      comment: string;
      element: BrowserPreviewElementDetails;
      /** PNG data URL captured from the browser frame while the element highlight is visible. */
      screenshotDataUrl: string;
    }
) & {
  /**
   * Additive (step 09): the annotation operation this status belongs to. A
   * desktop that returns it from `startAnnotation` also emits
   * {@link BROWSER_PREVIEW_ANNOTATION_EVENT} when the operation ends.
   */
  operationId?: string;
};

/** Renderer event (via the generic `listen` bus) announcing a terminal annotation state. */
export const BROWSER_PREVIEW_ANNOTATION_EVENT = "browser-preview-annotation";

/**
 * A hint only: the renderer answers it with an authoritative status read,
 * which is also where a submission's screenshot is captured.
 */
export interface BrowserPreviewAnnotationEvent {
  tabId: string;
  operationId: string;
  status: "submitted" | "cancelled" | "error";
}

export function isBrowserPreviewAnnotationEvent(
  value: unknown,
): value is BrowserPreviewAnnotationEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tabId === "string" &&
    typeof candidate.operationId === "string" &&
    candidate.operationId.length > 0 &&
    candidate.operationId.length <= 128 &&
    (candidate.status === "submitted" ||
      candidate.status === "cancelled" ||
      candidate.status === "error")
  );
}
