/**
 * Trusted capture coordination in Electron main.
 *
 * Main assigns the capture id and a per-install nonce, binds the page runtime
 * to the expected web contents and document generation, polls its bounded
 * status, and on selection takes a coherent screenshot: geometry is read
 * before and after `capturePage()`, one bounded retry is allowed for a
 * transient change, and anything still incoherent is spooled as stale. Page
 * output is always untrusted: every field is revalidated and rebuilt, messages
 * shown to the user are chosen here, and page identity comes from the actual
 * web contents URL rather than anything the page reports.
 *
 * Result captures (`purpose: "result"`) additionally wait for a bounded
 * font/layout stability window, report `stable`/`unstable` instead of marking
 * a layout change stale, and repaint the original capture's masks.
 */
import type {
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureCapabilities,
  BrowserPreviewCaptureErrorCode,
  BrowserPreviewCaptureEvent,
  BrowserPreviewCaptureMask,
  BrowserPreviewCaptureMode,
  BrowserPreviewCapturePurpose,
  BrowserPreviewExpiredCaptureNotice,
  BrowserPreviewPendingCapture,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewReplaceImageInput,
  BrowserPreviewResultCaptureMetadata,
  BrowserPreviewSelectionStatus,
  BrowserPreviewStartCaptureInput,
} from "@orkestrator/protocol/browser-preview";
import { BROWSER_PREVIEW_CAPTURE_CONTRACT_VERSION } from "@orkestrator/protocol/browser-preview";
import type {
  WebAnnotationCaptureInput,
  WebAnnotationGeometry,
  WebAnnotationRect,
} from "@orkestrator/protocol/web-annotations";
import { validateWebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations-validation";
import { randomUUID } from "node:crypto";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCapturePrepareScript,
  browserPreviewCaptureProbeScript,
  browserPreviewCaptureSettleScript,
  browserPreviewCaptureStartScript,
} from "./browser-preview-annotation-script.js";
import {
  boundedScreenshotDataUrl,
  clampRect,
  cropPng,
  documentMask,
  maskCaptureImage,
  masksInViewport,
} from "./browser-preview-capture-image.js";
import {
  browserPreviewPageIdentity,
  CAPTURE_ERROR_MESSAGES,
  CaptureFailure,
  finite,
  isRecord,
  parseJson,
  runInPage,
  type CaptureImageLike,
  type CaptureNativeImageApi,
  type CapturePreviewHandle,
  type CaptureWebContents,
} from "./browser-preview-capture-page.js";
import {
  incoherence,
  parseCaptureProbe,
  parseCaptureRuntimeStatus,
  STALE_REASONS,
  type ParsedSelection,
  type Probe,
  type Viewport,
} from "./browser-preview-capture-parse.js";
import {
  BrowserPreviewCaptureSpoolError,
  createBrowserPreviewCaptureId,
  decodePngDataUrl,
  type BrowserPreviewCaptureStore,
} from "./browser-preview-capture-store.js";
import {
  captureAck,
  captureId as validCaptureId,
  captureIdList,
  captureTabId,
  replaceImageInput,
  RESPONSIVE_SET_LIMITS,
  startCaptureInput,
} from "./browser-preview-capture-validation.js";

export {
  BROWSER_PREVIEW_CAPTURE_WORLD_ID,
  browserPreviewPageIdentity,
  browserPreviewRouteUrl,
  runInPage,
  sameBrowserPreviewRoute,
  type CaptureDeviceEmulation,
  type CaptureImageLike,
  type CaptureNativeImageApi,
  type CapturePreviewHandle,
  type CaptureWebContents,
} from "./browser-preview-capture-page.js";
export { parseCaptureProbe, parseCaptureRuntimeStatus } from "./browser-preview-capture-parse.js";
export { boundedScreenshotDataUrl, maskCaptureImage } from "./browser-preview-capture-image.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
/** Result captures: the whole stability window, and the quiet period that ends it early. */
export const RESULT_STABILITY_DEADLINE_MS = 1_500;
export const RESULT_STABILITY_QUIET_MS = 150;
const ERROR_MESSAGES = CAPTURE_ERROR_MESSAGES;

export type CaptureStoreLike = Pick<
  BrowserPreviewCaptureStore,
  | "hasCapacity"
  | "create"
  | "list"
  | "read"
  | "replaceImage"
  | "acknowledge"
  | "discard"
  | "recordReceipt"
  | "masksFor"
  | "listExpiredNotices"
  | "dismissExpiredNotices"
>;

export interface BrowserPreviewCaptureOptions {
  preview: (tabId: string) => CapturePreviewHandle | null;
  store?: CaptureStoreLike;
  emit?: (event: BrowserPreviewCaptureEvent) => void;
  nativeImage?: CaptureNativeImageApi;
  /** Background runtime polling while selecting; 0 disables it (status reads still poll). */
  pollIntervalMs?: number;
  now?: () => number;
  /**
   * Return keyboard focus to the app window's renderer (after a capture ends
   * with a spooled capture or a host-side error) so its editor can take focus.
   */
  focusHost?: () => void;
  /** Result-capture stability window (tests shorten it). */
  stability?: { deadlineMs: number; quietMs: number };
}

// ---------------------------------------------------------------------------
// Sessions

interface CaptureSession {
  tabId: string;
  captureId: string;
  nonce: string;
  mode: BrowserPreviewCaptureMode;
  environmentId: string;
  annotationId: string | null;
  contents: CaptureWebContents;
  generation: number;
  state: "selecting" | "capturing" | "done";
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  purpose: BrowserPreviewCapturePurpose;
  /** Result captures: masks of the original capture, in document CSS pixels. */
  resultMasks: BrowserPreviewCaptureMask[];
  /** Pending capture this session replaces once it is spooled. */
  recaptureOf: string | null;
}

/** The part of a stored target that lets the runtime start on it again. */
function initialTargetFor(
  target: WebAnnotationCaptureInput["target"],
): Record<string, unknown> | null {
  switch (target.kind) {
    case "element":
      return { kind: "element", anchor: target.anchor };
    case "text-range":
      return { kind: "text-range", quote: target.quote, container: target.container };
    case "region":
      return { kind: "region", rect: target.rect };
    default:
      return null;
  }
}

function parseSettle(
  encoded: unknown,
  expected: { captureId: string; nonce: string },
): { stable: boolean; fontsReady: boolean } | null {
  const parsed = parseJson(encoded, 1_024);
  if (
    !isRecord(parsed) ||
    parsed.captureId !== expected.captureId ||
    parsed.nonce !== expected.nonce ||
    typeof parsed.stable !== "boolean" ||
    typeof parsed.fontsReady !== "boolean"
  ) {
    return null;
  }
  return { stable: parsed.stable, fontsReady: parsed.fontsReady };
}

export class BrowserPreviewCaptureSessions {
  private readonly sessions = new Map<string, CaptureSession>();
  private readonly statuses = new Map<string, BrowserPreviewSelectionStatus>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: BrowserPreviewCaptureOptions) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private store(): CaptureStoreLike {
    if (!this.options.store) throw new Error("Trusted capture is unavailable in this build");
    return this.options.store;
  }

  private handle(tabId: string): CapturePreviewHandle {
    const handle = this.options.preview(tabId);
    if (!handle) throw new Error(`Browser preview ${tabId} is not attached`);
    return handle;
  }

  /** True while a selection or capture is in progress for the tab. */
  isBusy(tabId: string): boolean {
    const session = this.sessions.get(tabId);
    return Boolean(session && session.state !== "done");
  }

  capabilities(): BrowserPreviewCaptureCapabilities {
    const available = Boolean(this.options.store);
    const crop = Boolean(this.options.nativeImage?.createFromBuffer);
    return {
      contractVersion: BROWSER_PREVIEW_CAPTURE_CONTRACT_VERSION,
      modes: available ? ["element", "text", "region", "page"] : [],
      features: {
        keyboardSelection: available,
        recapture: available,
        receipts: available,
        resultCapture: { stability: available, masks: available },
        regionCrop: available && crop,
        responsiveSets: available ? { ...RESPONSIVE_SET_LIMITS } : null,
        livePins: true,
        showOnPage: true,
        expiredNotices: available,
      },
    };
  }

  private setStatus(
    tabId: string,
    status: BrowserPreviewSelectionStatus,
    extra: Pick<BrowserPreviewCaptureEvent, "focus"> = {},
  ): BrowserPreviewSelectionStatus {
    this.statuses.set(tabId, status);
    this.emit({
      tabId,
      captureId: "captureId" in status ? status.captureId : null,
      status: status.status,
      ...extra,
    });
    return status;
  }

  private emit(event: BrowserPreviewCaptureEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // Events are hints; status and spool reads remain authoritative.
    }
  }

  private error(
    tabId: string,
    captureId: string | null,
    code: BrowserPreviewCaptureErrorCode,
    message?: string,
  ) {
    return this.setStatus(tabId, {
      status: "error",
      captureId,
      code,
      message: message ?? ERROR_MESSAGES[code],
    });
  }

  private isCurrent(session: CaptureSession): boolean {
    return this.sessions.get(session.tabId) === session && session.state !== "done";
  }

  private end(
    session: CaptureSession,
    status: BrowserPreviewSelectionStatus,
    removeRuntime = true,
  ): BrowserPreviewSelectionStatus {
    if (this.sessions.get(session.tabId) === session) this.sessions.delete(session.tabId);
    const wasCapturing = session.state === "capturing";
    session.state = "done";
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (removeRuntime && !session.contents.isDestroyed()) {
      void runInPage(session.contents, BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT).catch(
        () => undefined,
      );
    }
    // Selection focused the native preview; hand focus back so the trusted
    // editor (or the error it shows) can take it.
    const handOff = status.status === "captured" || (status.status === "error" && wasCapturing);
    if (handOff) {
      try {
        this.options.focusHost?.();
      } catch {
        // Focus is a convenience; the event still asks the renderer to focus.
      }
    }
    return this.setStatus(session.tabId, status, handOff ? { focus: "editor" } : {});
  }

  async start(value: BrowserPreviewStartCaptureInput): Promise<BrowserPreviewSelectionStatus> {
    const input = startCaptureInput(value);
    const handle = this.handle(input.tabId);
    const store = this.store();
    const existing = this.sessions.get(input.tabId);
    if (existing) this.end(existing, { status: "cancelled", captureId: existing.captureId });

    let mode = input.mode;
    let environmentId = input.environmentId;
    let annotationId = input.annotationId ?? null;
    let initialTarget: Record<string, unknown> | null = null;
    let recaptureOf: string | null = null;
    if (input.recaptureCaptureId) {
      const previous = await store.read(input.recaptureCaptureId);
      if (!previous) {
        return this.error(
          input.tabId,
          null,
          "stale-session",
          "That capture is no longer pending. Start a new capture.",
        );
      }
      recaptureOf = previous.descriptor.captureId;
      mode = previous.descriptor.mode;
      environmentId = previous.descriptor.environmentId;
      annotationId = previous.descriptor.annotationId;
      initialTarget = initialTargetFor(previous.capture.target);
    }
    if (!(await store.hasCapacity(input.tabId, recaptureOf ? { excluding: recaptureOf } : {}))) {
      return this.error(input.tabId, null, "spool-full");
    }
    const purpose = input.purpose ?? "note";
    let resultMasks: BrowserPreviewCaptureMask[] = [];
    if (purpose === "result") {
      resultMasks =
        input.result?.masks ??
        (input.result?.originalCaptureId
          ? ((await store.masksFor(input.result.originalCaptureId)) ?? [])
          : []);
    }
    const session: CaptureSession = {
      tabId: input.tabId,
      captureId: createBrowserPreviewCaptureId(),
      nonce: randomUUID(),
      mode,
      environmentId,
      annotationId,
      contents: handle.contents,
      generation: handle.generation,
      state: "selecting",
      inFlight: null,
      timer: null,
      purpose,
      resultMasks,
      recaptureOf,
    };
    this.sessions.set(input.tabId, session);
    let encoded: unknown;
    try {
      encoded = await runInPage(
        session.contents,
        browserPreviewCaptureStartScript({
          captureId: session.captureId,
          nonce: session.nonce,
          mode: session.mode,
          initialTarget,
        }),
      );
    } catch {
      if (!this.isCurrent(session)) return this.statuses.get(input.tabId) ?? { status: "inactive" };
      return this.end(session, {
        status: "error",
        captureId: session.captureId,
        code: "capture-failed",
        message: ERROR_MESSAGES["capture-failed"],
      });
    }
    if (!this.isCurrent(session)) return this.statuses.get(input.tabId) ?? { status: "inactive" };
    await this.handleRuntimeStatus(session, encoded);
    if (session.state === "selecting") {
      if (handle.visible) session.contents.focus?.();
      this.schedulePoll(session);
    }
    return this.statuses.get(input.tabId) ?? { status: "inactive" };
  }

  async status(tabId: string): Promise<BrowserPreviewSelectionStatus> {
    captureTabId(tabId);
    const session = this.sessions.get(tabId);
    if (session?.inFlight) await session.inFlight;
    else if (session?.state === "selecting") await this.poll(session);
    return this.statuses.get(tabId) ?? { status: "inactive" };
  }

  async cancel(tabId: string): Promise<void> {
    captureTabId(tabId);
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.end(session, { status: "cancelled", captureId: session.captureId }, false);
    if (!session.contents.isDestroyed()) {
      await runInPage(session.contents, BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT).catch(
        () => undefined,
      );
    }
  }

  private schedulePoll(session: CaptureSession): void {
    if (this.pollIntervalMs <= 0 || session.timer || !this.isCurrent(session)) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.poll(session).catch(() => undefined);
    }, this.pollIntervalMs);
    (session.timer as { unref?: () => void }).unref?.();
  }

  private poll(session: CaptureSession): Promise<void> {
    if (session.inFlight) return session.inFlight;
    const run = this.pollOnce(session).finally(() => {
      session.inFlight = null;
      if (session.state === "selecting") this.schedulePoll(session);
    });
    session.inFlight = run;
    return run;
  }

  private async pollOnce(session: CaptureSession): Promise<void> {
    if (!this.isCurrent(session) || session.state !== "selecting") return;
    const handle = this.options.preview(session.tabId);
    if (!handle || handle.contents !== session.contents || session.contents.isDestroyed()) {
      this.end(session, this.errorStatus(session, "stale-session"), false);
      return;
    }
    if (handle.generation !== session.generation) {
      this.end(session, this.errorStatus(session, "navigation"));
      return;
    }
    let encoded: unknown;
    try {
      encoded = await runInPage(session.contents, BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT);
    } catch {
      if (this.isCurrent(session)) this.end(session, this.errorStatus(session, "capture-failed"));
      return;
    }
    await this.handleRuntimeStatus(session, encoded);
  }

  private errorStatus(
    session: CaptureSession,
    code: BrowserPreviewCaptureErrorCode,
  ): BrowserPreviewSelectionStatus {
    return { status: "error", captureId: session.captureId, code, message: ERROR_MESSAGES[code] };
  }

  private async handleRuntimeStatus(session: CaptureSession, encoded: unknown): Promise<void> {
    if (!this.isCurrent(session)) return;
    const handle = this.options.preview(session.tabId);
    if (
      !handle ||
      handle.contents !== session.contents ||
      handle.generation !== session.generation
    ) {
      this.end(session, this.errorStatus(session, "navigation"));
      return;
    }
    const parsed = parseCaptureRuntimeStatus(encoded, session);
    switch (parsed.kind) {
      case "selecting": {
        const current = this.statuses.get(session.tabId);
        if (!(current?.status === "selecting" && current.captureId === session.captureId)) {
          this.setStatus(session.tabId, {
            status: "selecting",
            captureId: session.captureId,
            mode: session.mode,
          });
        }
        return;
      }
      case "cancelled":
        this.end(session, { status: "cancelled", captureId: session.captureId });
        return;
      case "error":
        this.end(session, this.errorStatus(session, parsed.code));
        return;
      case "selected":
        await this.captureSelected(session, parsed.selection);
        return;
      default:
        // Missing, unbound, or malformed output: a page echoing a valid id still supplies untrusted data.
        this.end(session, this.errorStatus(session, "stale-session"));
    }
  }

  /** Result captures: bounded font/layout quiet window; `unstable` when it never settles. */
  private async settle(session: CaptureSession): Promise<"stable" | "unstable"> {
    const window = this.options.stability ?? {
      deadlineMs: RESULT_STABILITY_DEADLINE_MS,
      quietMs: RESULT_STABILITY_QUIET_MS,
    };
    const settled = parseSettle(
      await runInPage(
        session.contents,
        browserPreviewCaptureSettleScript(session.captureId, window),
      ).catch(() => null),
      session,
    );
    return settled?.stable ? "stable" : "unstable";
  }

  private async captureSelected(
    session: CaptureSession,
    selection: ParsedSelection,
  ): Promise<void> {
    session.state = "capturing";
    this.setStatus(session.tabId, { status: "capturing", captureId: session.captureId });
    try {
      const store = this.store();
      const contents = session.contents;
      // Page identity is the page the user selected on. Read it before any
      // probe: a navigation during capture marks the capture stale, but the
      // target and evidence still belong to this page, not the next one.
      const url = contents.isDestroyed() ? "" : contents.getURL();
      const title =
        typeof contents.getTitle === "function" && !contents.isDestroyed()
          ? contents.getTitle()
          : selection.title;
      const describeService = this.options.preview(session.tabId)?.describeService;
      const isResult = session.purpose === "result";
      const settled = isResult ? await this.settle(session) : "stable";
      if (this.sessions.get(session.tabId) !== session) return;
      const outcome = await this.coherentCapture(session);
      if (this.sessions.get(session.tabId) !== session) return;
      const identity = browserPreviewPageIdentity(
        url,
        typeof title === "string" ? title : "",
        describeService,
      );
      const view: Viewport = outcome.probe ?? selection;
      const zoom = contents.isDestroyed() ? 1 : contents.getZoomFactor?.();
      const zoomFactor = finite(zoom, 0.05, 20) ? zoom : 1;
      // A layout that keeps moving is reported as unstable for a result capture
      // (the comparison is labelled), not as stale evidence.
      const layoutOnly = outcome.staleReason === STALE_REASONS.layout;
      const stability: "stable" | "unstable" =
        settled === "stable" && !outcome.staleReason ? "stable" : "unstable";
      const staleReason = isResult && layoutOnly ? null : outcome.staleReason;

      let png: { png: Buffer; width: number; height: number; reduced: boolean } | null = null;
      let unmaskable = false;
      const painted: BrowserPreviewCaptureMask[] = [];
      let sensitiveCount = 0;
      if (outcome.image) {
        const nativeSize = outcome.image.getSize();
        if (nativeSize.width < 1 || nativeSize.height < 1)
          throw new CaptureFailure("capture-failed");
        const sensitive = outcome.probe?.sensitive ?? [];
        const reapplied = masksInViewport(session.resultMasks, view.scroll, view.viewport);
        const rects: WebAnnotationRect[] = [...sensitive, ...reapplied.map((entry) => entry.rect)];
        const maskedImage = maskCaptureImage(
          outcome.image,
          rects,
          view.viewport,
          this.options.nativeImage,
        );
        if (rects.length > 0 && !maskedImage.masked) {
          // Sensitive fields (or redactions to reapply) are on screen and could
          // not be painted over: keep text evidence only rather than spool pixels.
          unmaskable = true;
        } else {
          sensitiveCount = sensitive.length;
          for (const rect of sensitive) {
            painted.push(documentMask(rect, view.scroll, "sensitive-field"));
          }
          for (const entry of reapplied) painted.push(entry.mask);
          const decoded = decodePngDataUrl(boundedScreenshotDataUrl(maskedImage.image));
          png = {
            png: decoded.bytes,
            width: decoded.width,
            height: decoded.height,
            reduced: decoded.width < nativeSize.width || decoded.height < nativeSize.height,
          };
        }
      }
      const scale = png ? png.width / view.viewport.width : null;
      const geometry: WebAnnotationGeometry = {
        viewport: { ...view.viewport },
        scroll: { ...view.scroll },
        zoomFactor,
        devicePixelRatio: view.devicePixelRatio,
        image:
          png && scale !== null
            ? { width: png.width, height: png.height, scale, reduced: png.reduced }
            : null,
      };
      const target = this.coherentTarget(selection.target, outcome.probe, png, scale);
      const capture: WebAnnotationCaptureInput = {
        producer: isResult ? "result-capture" : "desktop-native",
        capturedAt: new Date(this.now()).toISOString(),
        documentGeneration: session.generation,
        page: identity.page,
        target,
        geometry,
        evidence: selection.evidence,
        assetIds: [],
        redaction: {
          attributesRemoved: selection.redaction.attributesRemoved,
          valuesMasked: selection.redaction.valuesMasked,
          urlParametersRemoved: Math.min(
            10_000,
            selection.redaction.urlParametersRemoved + identity.removedParameters,
          ),
          sensitiveRegionsMasked: png ? sensitiveCount : 0,
          manualRegions: 0,
          imageExcluded: unmaskable,
        },
        ...(staleReason ? { stale: { reason: staleReason } } : {}),
      };
      const validation = validateWebAnnotationCaptureInput(capture);
      if (!validation.ok) {
        throw new CaptureFailure(
          validation.error.includes("64 KiB") ? "too-large" : "capture-failed",
        );
      }
      const result: BrowserPreviewResultCaptureMetadata | undefined = isResult
        ? {
            zoomFactor,
            deviceScaleFactor: view.devicePixelRatio,
            scroll: { ...view.scroll },
            stability,
            masks: painted,
          }
        : undefined;
      if (this.sessions.get(session.tabId) !== session) return;
      const descriptor = await store.create({
        captureId: session.captureId,
        tabId: session.tabId,
        environmentId: session.environmentId,
        annotationId: session.annotationId,
        mode: session.mode,
        capture,
        image: png,
        purpose: session.purpose,
        ...(painted.length > 0 && png ? { masks: painted } : {}),
        ...(result ? { result } : {}),
        ...(session.recaptureOf ? { replaces: session.recaptureOf } : {}),
      });
      if (this.sessions.get(session.tabId) !== session) {
        // Cancelled while writing: the user asked to drop this capture.
        await store.discard(descriptor.captureId).catch(() => undefined);
        return;
      }
      this.end(session, { status: "captured", captureId: session.captureId, pending: descriptor });
    } catch (error) {
      if (this.sessions.get(session.tabId) !== session) return;
      if (error instanceof BrowserPreviewCaptureSpoolError) {
        const code =
          error.code === "spool-full" || error.code === "too-large" ? error.code : "capture-failed";
        this.end(session, {
          status: "error",
          captureId: session.captureId,
          code,
          message: code === "spool-full" ? error.message : ERROR_MESSAGES[code],
        });
        return;
      }
      const code = error instanceof CaptureFailure ? error.code : "capture-failed";
      this.end(session, this.errorStatus(session, code));
    }
  }

  /** Align the target with the pixels: use the pre-capture rect and derive region image coordinates. */
  private coherentTarget(
    target: WebAnnotationCaptureInput["target"],
    probe: Probe | null,
    png: { width: number; height: number } | null,
    scale: number | null,
  ): WebAnnotationCaptureInput["target"] {
    if (target.kind === "element" && probe?.rect) return { ...target, rect: probe.rect };
    if (target.kind === "text-range" && probe?.rect) {
      const dx = probe.rect.x - target.rect.x;
      const dy = probe.rect.y - target.rect.y;
      return {
        ...target,
        rect: probe.rect,
        rects: target.rects.map((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy })),
      };
    }
    if (target.kind === "region") {
      const imageRect =
        png && scale !== null
          ? clampRect(
              {
                x: Math.round(target.rect.x * scale),
                y: Math.round(target.rect.y * scale),
                width: Math.round(target.rect.width * scale),
                height: Math.round(target.rect.height * scale),
              },
              png.width,
              png.height,
            )
          : null;
      return { ...target, imageRect };
    }
    return target;
  }

  /**
   * Read geometry before and after `capturePage()`. One retry for a transient
   * change; never a loop. Navigation drops the pixels, which may show another page.
   */
  private async coherentCapture(
    session: CaptureSession,
  ): Promise<{ image: CaptureImageLike | null; probe: Probe | null; staleReason: string | null }> {
    let reason: string | null = null;
    let image: CaptureImageLike | null = null;
    let probe: Probe | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = this.options.preview(session.tabId);
      if (!handle || handle.contents !== session.contents || session.contents.isDestroyed()) {
        throw new CaptureFailure("stale-session");
      }
      if (handle.generation !== session.generation) {
        reason = STALE_REASONS.navigation;
        continue;
      }
      const urlBefore = session.contents.getURL();
      const before = parseCaptureProbe(
        await runInPage(
          session.contents,
          browserPreviewCapturePrepareScript(session.captureId),
        ).catch(() => null),
        session,
      );
      if (!before) {
        const current = this.options.preview(session.tabId);
        reason =
          current?.generation !== session.generation
            ? STALE_REASONS.navigation
            : STALE_REASONS.runtimeLost;
        continue;
      }
      probe = before;
      if (!before.connected) {
        reason = STALE_REASONS.targetRemoved;
        continue;
      }
      let captured: CaptureImageLike;
      try {
        captured = await session.contents.capturePage();
      } catch {
        throw new CaptureFailure("capture-failed");
      }
      const after = parseCaptureProbe(
        await runInPage(
          session.contents,
          browserPreviewCaptureProbeScript(session.captureId),
        ).catch(() => null),
        session,
      );
      image = captured;
      const current = this.options.preview(session.tabId);
      if (
        !current ||
        current.generation !== session.generation ||
        session.contents.isDestroyed() ||
        session.contents.getURL() !== urlBefore
      ) {
        reason = STALE_REASONS.navigation;
        continue;
      }
      reason = incoherence(before, after);
      if (!reason) break;
    }
    if (reason === STALE_REASONS.navigation) image = null;
    return { image, probe, staleReason: reason };
  }

  // -- Spool ----------------------------------------------------------------

  async listPending(): Promise<BrowserPreviewPendingCaptureDescriptor[]> {
    return this.store().list();
  }

  /** Non-consuming read; region captures include a crop derived from the current image. */
  async readPending(captureId: string): Promise<BrowserPreviewPendingCapture | null> {
    const pending = await this.store().read(validCaptureId(captureId));
    if (!pending) return null;
    const target = pending.capture.target;
    if (target.kind !== "region") return pending;
    let regionCrop: BrowserPreviewPendingCapture["regionCrop"] = null;
    if (pending.imageDataUrl && target.imageRect) {
      try {
        const source = decodePngDataUrl(pending.imageDataUrl);
        const cropped = cropPng(source.bytes, target.imageRect, this.options.nativeImage);
        if (cropped) {
          regionCrop = {
            imageDataUrl: cropped.dataUrl,
            width: cropped.width,
            height: cropped.height,
            sourceRect: { ...target.imageRect },
          };
        }
      } catch {
        regionCrop = null;
      }
    }
    return { ...pending, regionCrop };
  }

  async replacePendingImage(
    captureId: string,
    input: BrowserPreviewReplaceImageInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor> {
    return this.store().replaceImage(validCaptureId(captureId), replaceImageInput(input));
  }

  async acknowledgePending(ack: BrowserPreviewCaptureAck): Promise<void> {
    return this.store().acknowledge(captureAck(ack));
  }

  async recordPendingReceipt(
    ack: BrowserPreviewCaptureAck,
  ): Promise<BrowserPreviewPendingCaptureDescriptor | null> {
    return this.store().recordReceipt(captureAck(ack));
  }

  async discardPending(captureId: string): Promise<void> {
    return this.store().discard(validCaptureId(captureId));
  }

  async listExpiredNotices(): Promise<BrowserPreviewExpiredCaptureNotice[]> {
    return this.store().listExpiredNotices();
  }

  async dismissExpiredNotices(captureIds?: unknown): Promise<void> {
    return this.store().dismissExpiredNotices(captureIdList(captureIds));
  }

  // -- Preview lifecycle ----------------------------------------------------

  /** Document generation changed: end a selection in progress. */
  onDocumentChanged(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session?.state === "selecting") this.end(session, this.errorStatus(session, "navigation"));
  }

  /** Hiding ends a selection in progress; captures already spooled are untouched. */
  onHidden(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session?.state === "selecting")
      this.end(session, { status: "cancelled", captureId: session.captureId });
  }

  /** The view is going away. Only transient state is dropped; the spool is not touched. */
  onRemoved(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session) this.end(session, { status: "cancelled", captureId: session.captureId }, false);
    this.statuses.delete(tabId);
  }
}
