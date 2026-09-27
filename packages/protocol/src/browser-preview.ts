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

export type BrowserPreviewAnnotationStatus =
  | { status: "inactive" | "active" | "cancelled" }
  | { status: "error"; message: string }
  | {
      status: "submitted";
      comment: string;
      element: BrowserPreviewElementDetails;
      /** PNG data URL captured from the browser frame while the element highlight is visible. */
      screenshotDataUrl: string;
    };

// ---------------------------------------------------------------------------
// Web page annotation capture transport.
//
// The page runtime only selects a target and reports bounded, untrusted
// evidence. Comments are typed in Orkestrator's own UI. Electron main owns a
// bounded pending spool so a capture survives renderer unmounts until the
// backend acknowledges it.

type WebAnnotationRect = import("./web-annotations.js").WebAnnotationRect;
type WebAnnotationAnchorResolution = import("./web-annotations.js").WebAnnotationAnchorResolution;
type WebAnnotationAnchorState = import("./web-annotations.js").WebAnnotationAnchorState;
type WebAnnotationAnchorRule = import("./web-annotations.js").WebAnnotationAnchorRule;

/**
 * Version of the desktop capture transport. Version 2 added capabilities,
 * receipts, recapture, result stability/masks, region crops, responsive sets,
 * live pins, Show on page, and expired-capture notices.
 */
export const BROWSER_PREVIEW_CAPTURE_CONTRACT_VERSION = 2;

export type BrowserPreviewCaptureMode = "element" | "text" | "region" | "page";

export type BrowserPreviewSelectionStatus =
  | { status: "inactive" }
  | { status: "selecting"; captureId: string; mode: BrowserPreviewCaptureMode }
  | { status: "capturing"; captureId: string }
  | { status: "captured"; captureId: string; pending: BrowserPreviewPendingCaptureDescriptor }
  | { status: "cancelled"; captureId: string }
  | {
      status: "error";
      captureId: string | null;
      code: BrowserPreviewCaptureErrorCode;
      message: string;
    };

export type BrowserPreviewCaptureErrorCode =
  | "stale-session"
  | "navigation"
  | "target-removed"
  | "too-large"
  | "spool-full"
  | "unsupported"
  | "capture-failed";

/** Why a capture is taken. `result` captures run a stability window and reapply masks. */
export type BrowserPreviewCapturePurpose = "note" | "result";

/**
 * A rectangle painted opaque in a stored image, in CSS pixels of the
 * **document** (viewport rectangle plus scroll offset at capture time), so it
 * can be reapplied to a later capture of the same page at a different scroll.
 * Geometry only; the covered content is never recorded.
 */
export interface BrowserPreviewCaptureMask {
  source: "sensitive-field" | "manual";
  rect: WebAnnotationRect;
}

export interface BrowserPreviewResultCaptureStart {
  requestId: string;
  /**
   * Masks of the original capture to reapply to the after-image. When absent,
   * main uses the masks it remembered for `originalCaptureId` (the backend
   * capture id acknowledged earlier on this desktop), if any.
   */
  masks?: BrowserPreviewCaptureMask[];
  originalCaptureId?: string;
}

export interface BrowserPreviewStartCaptureInput {
  tabId: string;
  mode: BrowserPreviewCaptureMode;
  /** Recapture/reselect for an existing annotation (a new capture revision). */
  annotationId?: string;
  /** Environment that will own the capture once committed. */
  environmentId: string;
  /**
   * Recapture a pending (typically stale) capture: the selection starts on
   * the same target, and once the new capture is spooled the old pending
   * record is discarded. Mode, environment, and annotation come from the old
   * record. The new descriptor's `recaptureOf` names the replaced capture.
   */
  recaptureCaptureId?: string;
  /** Default `note`. */
  purpose?: BrowserPreviewCapturePurpose;
  /** Required when `purpose` is `result`. */
  result?: BrowserPreviewResultCaptureStart;
}

/** Recorded when the backend commit is known but the spool record is not yet cleared. */
export interface BrowserPreviewCaptureReceipt {
  annotationId: string;
  backendCaptureId: string;
}

/** Position of a capture in a responsive set; see `captureResponsiveSet`. */
export interface BrowserPreviewResponsiveMember {
  setId: string;
  index: number;
  count: number;
  viewportWidth: number;
}

/** Content-free descriptor; reading it never consumes the spool record. */
export interface BrowserPreviewPendingCaptureDescriptor {
  captureId: string;
  tabId: string;
  environmentId: string;
  annotationId: string | null;
  mode: BrowserPreviewCaptureMode;
  createdAt: string;
  expiresAt: string;
  targetLabel: string;
  pageTitle: string;
  displayUrl: string;
  stale: boolean;
  staleReason: string | null;
  image: { width: number; height: number; bytes: number; reduced: boolean } | null;
  /** Set once the backend receipt was recorded but before the record is cleared. */
  acknowledged: boolean;
  /**
   * Backend receipt recorded with `recordPendingCaptureReceipt` (or by an
   * acknowledgement that could not clear the files). A resuming renderer
   * re-acknowledges a record with a receipt instead of committing it again.
   */
  receipt?: BrowserPreviewCaptureReceipt | null;
  /** The pending capture this one replaced (`recaptureCaptureId`). */
  recaptureOf?: string | null;
  purpose?: BrowserPreviewCapturePurpose;
  responsive?: BrowserPreviewResponsiveMember | null;
}

/**
 * Metadata of an after-image for `web_annotation_result_capture`. Field names
 * match the optional result-capture input fields in the backend contract.
 */
export interface BrowserPreviewResultCaptureMetadata {
  zoomFactor: number;
  deviceScaleFactor: number;
  scroll: { x: number; y: number };
  /** `unstable` when fonts or layout did not settle within the bounded window. */
  stability: "stable" | "unstable";
  /** Every mask painted into the after-image, including reapplied originals. */
  masks: BrowserPreviewCaptureMask[];
}

/** A region crop derived from the (possibly redacted) spooled source image at read time. */
export interface BrowserPreviewRegionCrop {
  imageDataUrl: string;
  width: number;
  height: number;
  /** Crop rectangle in pixels of the source image (the capture's `imageDataUrl`). */
  sourceRect: WebAnnotationRect;
}

export interface BrowserPreviewPendingCapture {
  descriptor: BrowserPreviewPendingCaptureDescriptor;
  /** Capture metadata ready for `web_annotation_create` (asset ids filled in by the renderer). */
  capture: import("./web-annotations.js").WebAnnotationCaptureInput;
  /** PNG data URL, already masked for detectable sensitive fields. */
  imageDataUrl: string | null;
  /** Masks painted into `imageDataUrl` (automatic and manual). */
  masks?: BrowserPreviewCaptureMask[];
  /** Present for `purpose: "result"` captures. */
  result?: BrowserPreviewResultCaptureMetadata;
  /**
   * Region captures: the crop of the source screenshot. The source image is
   * the parent context; `sourceRect` equals `capture.target.imageRect`.
   */
  regionCrop?: BrowserPreviewRegionCrop | null;
}

export interface BrowserPreviewCaptureAck {
  captureId: string;
  annotationId: string;
  backendCaptureId: string;
}

/**
 * Content-free notice for a pending capture that expired before it was saved.
 * `whileClosed` is true when it expired while the desktop app was not running.
 */
export interface BrowserPreviewExpiredCaptureNotice {
  captureId: string;
  tabId: string;
  environmentId: string;
  annotationId: string | null;
  mode: BrowserPreviewCaptureMode;
  /** Sanitized page address (credentials and token-like parameters removed). */
  displayUrl: string;
  createdAt: string;
  expiredAt: string;
  whileClosed: boolean;
}

export interface BrowserPreviewReplaceImageInput {
  imageDataUrl: string | null;
  /**
   * Regions redacted in THIS pass (not a running total); the spool
   * accumulates them into `capture.redaction.manualRegions`, clamped to
   * `WEB_ANNOTATION_LIMITS.redactionRegions`. Ignored when `regions` is given.
   */
  manualRegions: number;
  /** Optional rectangles of this pass in pixels of the replaced image, recorded as masks. */
  regions?: WebAnnotationRect[];
}

/** Page-side anchor resolution for pins (bounded, visible page only). */
export interface BrowserPreviewAnchorQuery {
  annotationId: string;
  number: number;
  target: import("./web-annotations.js").WebAnnotationTarget;
  route: string;
  /**
   * Geometry of the capture the target came from. Region notes use it to
   * decide whether the layout changed (`historical`).
   */
  capture?: {
    documentGeneration: number | null;
    viewport: { width: number; height: number };
  };
}

export interface BrowserPreviewAnchorResult {
  annotationId: string;
  resolution: WebAnnotationAnchorResolution;
}

export interface BrowserPreviewPinsInput {
  tabId: string;
  pins: BrowserPreviewAnchorQuery[];
  /** Annotation whose pin should be emphasized, e.g. the open thread. */
  focusedAnnotationId?: string | null;
  scrollIntoView?: boolean;
}

/** Content-free resolver counters for diagnostics; never selectors or text. */
export interface BrowserPreviewPinDiagnostics {
  pins: number;
  byState: Partial<Record<WebAnnotationAnchorState, number>>;
  byRule: Partial<Record<WebAnnotationAnchorRule, number>>;
  /** Resolution passes, including the initial one. */
  passes: number;
  /** Coalesced mutation batches observed. */
  mutationBatches: number;
  /** Batches deferred by the throttle or skipped while the page was hidden. */
  throttledBatches: number;
  budgetExhausted: number;
  /** True once the re-resolution allowance for this document is spent. */
  paused: boolean;
}

/** Current live pin state; `revision` advances whenever a result changes. */
export interface BrowserPreviewPinSnapshot {
  tabId: string;
  documentGeneration: number;
  revision: number;
  results: BrowserPreviewAnchorResult[];
  diagnostics: BrowserPreviewPinDiagnostics | null;
}

export interface BrowserPreviewShowOnPageInput {
  tabId: string;
  /** The annotation to show; its route is navigated to when it differs. */
  pin: BrowserPreviewAnchorQuery;
  /** Other visible pins to redraw on the destination page (≤ 49). */
  pins?: BrowserPreviewAnchorQuery[];
  /** Bounded wait for the document and target; default 10 s, at most 20 s. */
  timeoutMs?: number;
}

export interface BrowserPreviewShowOnPageResult {
  /**
   * `shown`: matched, scrolled into view and highlighted. `not-found`: the
   * page loaded but the anchor did not match (see `resolution.state`).
   * `navigation-required`: the preview cannot address the stored route; ask
   * the user to navigate and reselect. `timeout`: the page did not load in
   * time. `navigation-failed`: the load failed or left the preview scope.
   */
  outcome: "shown" | "not-found" | "navigation-required" | "timeout" | "navigation-failed";
  navigated: boolean;
  resolution: WebAnnotationAnchorResolution;
  documentGeneration: number;
}

export interface BrowserPreviewResponsiveSetInput {
  tabId: string;
  environmentId: string;
  annotationId?: string;
  /** 1–4 distinct CSS widths in [320, 2560]; captured in ascending order. */
  widths: number[];
  /** Optional element/text target to resolve and record at each width. */
  target?: import("./web-annotations.js").WebAnnotationTarget;
}

export interface BrowserPreviewResponsiveSetResult {
  setId: string;
  /** One pending capture per width that succeeded, ascending by width. */
  captures: BrowserPreviewPendingCaptureDescriptor[];
  failures: Array<{ viewportWidth: number; code: BrowserPreviewCaptureErrorCode }>;
}

export interface BrowserPreviewCaptureCapabilities {
  contractVersion: number;
  /** Modes this desktop build can capture. Intersect with backend capabilities. */
  modes: BrowserPreviewCaptureMode[];
  features: {
    keyboardSelection: boolean;
    recapture: boolean;
    receipts: boolean;
    resultCapture: { stability: boolean; masks: boolean };
    regionCrop: boolean;
    responsiveSets: { maxWidths: number; minWidth: number; maxWidth: number } | null;
    livePins: boolean;
    showOnPage: boolean;
    expiredNotices: boolean;
  };
}

/** Content-free push hint; the renderer reads status/spool for content. */
export interface BrowserPreviewCaptureEvent {
  tabId: string;
  captureId: string | null;
  status:
    | BrowserPreviewSelectionStatus["status"]
    | "spool-changed"
    /** Pins were cleared for a new document (reload, navigation); re-send them. */
    | "pins-invalidated"
    /** Live pin results changed; read them with `getPinResults`. */
    | "pins-changed";
  /** `spool-changed`: which spool change happened. */
  reason?: "created" | "replaced" | "receipt" | "acknowledged" | "discarded" | "expired";
  /** `spool-changed` with reason `expired`. */
  expired?: BrowserPreviewExpiredCaptureNotice;
  /**
   * Set on `captured`, and on an `error` after the user selected a target:
   * main has returned keyboard focus to the app window; the renderer should
   * focus the capture editor.
   */
  focus?: "editor";
  /** `pins-invalidated` / `pins-changed`. */
  documentGeneration?: number;
}

export const BROWSER_PREVIEW_CAPTURE_EVENT = "browser-preview-capture";

/**
 * Preload surface for trusted capture. Exposed as
 * `window.orkestrator.browserPreview.capture` only by desktop builds that
 * implement the pending spool; clients feature-detect it. Methods added in
 * contract version 2 are optional so callers feature-detect them too.
 */
export interface BrowserPreviewCaptureApi {
  startCapture(input: BrowserPreviewStartCaptureInput): Promise<BrowserPreviewSelectionStatus>;
  getCaptureStatus(tabId: string): Promise<BrowserPreviewSelectionStatus>;
  cancelCapture(tabId: string): Promise<void>;
  /** Pending (unacknowledged) captures across all previews, newest first. */
  listPendingCaptures(): Promise<BrowserPreviewPendingCaptureDescriptor[]>;
  /** Non-consuming read of one pending capture, including its image. */
  readPendingCapture(captureId: string): Promise<BrowserPreviewPendingCapture | null>;
  /**
   * Replace the spooled image with the user's redacted version (or drop it).
   * The unredacted working copy is discarded; there is no way to restore it.
   */
  replacePendingCaptureImage(
    captureId: string,
    input: BrowserPreviewReplaceImageInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor>;
  /** Idempotent: a duplicate ack for a cleared capture is harmless. */
  acknowledgePendingCapture(ack: BrowserPreviewCaptureAck): Promise<void>;
  discardPendingCapture(captureId: string): Promise<void>;
  /** Resolve and draw pins for the visible page; bounded to `visiblePins`. */
  showPins(input: BrowserPreviewPinsInput): Promise<BrowserPreviewAnchorResult[]>;
  clearPins(tabId: string): Promise<void>;
  // -- Contract version 2 ----------------------------------------------------
  getCaptureCapabilities?(): Promise<BrowserPreviewCaptureCapabilities>;
  /**
   * Durably record the backend receipt without clearing the record (a cheap
   * local write right after commit). Idempotent; null when not pending.
   */
  recordPendingCaptureReceipt?(
    ack: BrowserPreviewCaptureAck,
  ): Promise<BrowserPreviewPendingCaptureDescriptor | null>;
  /** Expired-capture notices, newest first (bounded; persisted across restarts). */
  listExpiredCaptureNotices?(): Promise<BrowserPreviewExpiredCaptureNotice[]>;
  /** Dismiss the given notices, or all of them when `captureIds` is omitted. */
  dismissExpiredCaptureNotices?(captureIds?: string[]): Promise<void>;
  /** Current live pin results after mutation-driven re-resolution. */
  getPinResults?(tabId: string): Promise<BrowserPreviewPinSnapshot | null>;
  /** Navigate if needed, wait for the document, resolve, scroll and highlight. */
  showOnPage?(input: BrowserPreviewShowOnPageInput): Promise<BrowserPreviewShowOnPageResult>;
  /** Capture the current page at several emulated widths (explicit user action only). */
  captureResponsiveSet?(
    input: BrowserPreviewResponsiveSetInput,
  ): Promise<BrowserPreviewResponsiveSetResult>;
}
