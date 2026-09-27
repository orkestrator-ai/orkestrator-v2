/**
 * Capture transfer coordinator (plan step 04, renderer side).
 *
 * The desktop main process owns selection and a bounded pending spool that
 * survives renderer unmounts. This hook starts/cancels selection, follows the
 * capture event plus a status poll while selecting, shows pending captures in
 * the trusted editor, applies redaction to the spool BEFORE upload, and
 * commits with operation ids derived from the capture id (see
 * `capture-commit.ts`).
 *
 * Resume: on mount, activation, gateway reconnect, and a bounded interval,
 * records whose backend receipt is known are re-acknowledged (never committed
 * again), and saves the user already asked for are finished with the same
 * operation ids. A save that failed for a domain reason (conflict, capacity,
 * validation) waits for the user instead of retrying.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_PREVIEW_CAPTURE_EVENT,
  type BrowserPreviewCaptureApi,
  type BrowserPreviewCaptureCapabilities,
  type BrowserPreviewCaptureEvent,
  type BrowserPreviewCaptureMode,
  type BrowserPreviewExpiredCaptureNotice,
  type BrowserPreviewPendingCapture,
  type BrowserPreviewPendingCaptureDescriptor,
  type BrowserPreviewResponsiveSetResult,
  type BrowserPreviewResultCaptureStart,
  type BrowserPreviewSelectionStatus,
} from "@orkestrator/protocol/browser-preview";
import type { WebAnnotationTarget } from "@orkestrator/protocol/web-annotations";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  getBrowserPreviewCaptureApi,
  getBrowserPreviewCaptureCapabilities,
} from "@/lib/native/browser-preview";
import {
  acknowledgeCommittedCapture,
  captureCommitKind,
  commitPendingCapture,
  existingCaptureReceipt,
  type CaptureCommitInput,
} from "@/lib/web-annotations/capture-commit";
import {
  captureIntent,
  forgetCaptureIntent,
  forgetSaveIntent,
  linkRecapture,
  rememberCaptureIntent,
  rememberSaveIntent,
  saveIntent,
  type CaptureIntent,
} from "@/lib/web-annotations/capture-intents";
import {
  describeWebAnnotationError,
  isTransientWebAnnotationError,
} from "@/lib/web-annotations/client";
import { redactPngDataUrl, type RedactionRect } from "@/lib/web-annotations/redaction";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";

const SELECTION_POLL_MS = 400;
/** Bounded background retry for acknowledged-but-uncleared and interrupted saves. */
export const CAPTURE_RESUME_INTERVAL_MS = 15_000;

export type CaptureSaveStatus = "idle" | "saving" | "saved" | "error";

export interface CaptureSaveState {
  status: CaptureSaveStatus;
  error: string | null;
  annotationId: string | null;
  /** Backend committed but the desktop spool acknowledgement failed (retried automatically). */
  ackPending: boolean;
  /** A transport failure: the same save is retried when the connection returns. */
  retrying: boolean;
}

export type CaptureSaveOutcome =
  | { ok: true; annotationId: string; captureId: string }
  | { ok: false; error: string };

export type CaptureSaveInput = CaptureCommitInput;

const IDLE: CaptureSaveState = {
  status: "idle",
  error: null,
  annotationId: null,
  ackPending: false,
  retrying: false,
};

function selectionCaptureId(status: BrowserPreviewSelectionStatus): string | null {
  return status.status === "inactive" ? null : status.captureId;
}

export function isSelecting(status: BrowserPreviewSelectionStatus): boolean {
  return status.status === "selecting" || status.status === "capturing";
}

function selectionErrorMessage(
  status: Extract<BrowserPreviewSelectionStatus, { status: "error" }>,
) {
  switch (status.code) {
    case "spool-full":
      return "Too many unsaved captures. Save or discard one before capturing another.";
    case "navigation":
      return "The page changed during selection. Select the target again.";
    case "target-removed":
      return "The selected element disappeared before it could be captured.";
    case "too-large":
      return "That selection is too large to capture. Choose a smaller target.";
    case "stale-session":
      return "The preview reloaded. Start selecting again.";
    case "unsupported":
      return "This page does not support that selection mode.";
    default:
      return status.message || "The capture failed.";
  }
}

/** A descriptor whose backend commit is already known: only re-acknowledge it. */
function committedDescriptor(descriptor: BrowserPreviewPendingCaptureDescriptor): boolean {
  return Boolean(descriptor.receipt) || descriptor.acknowledged;
}

export interface CommittedCapture {
  captureId: string;
  annotationId: string;
  /** Finished by the background resume rather than the user's own click. */
  automatic: boolean;
  sequence: number;
}

export interface StartCaptureOptions {
  annotationId?: string;
  intent?: CaptureIntent;
  /** `result` captures run the desktop stability window and reapply masks. */
  result?: BrowserPreviewResultCaptureStart;
}

export function useAnnotationCapture({
  tabId,
  environmentId,
  isActive,
  enabled,
}: {
  tabId: string;
  environmentId: string;
  isActive: boolean;
  enabled: boolean;
}) {
  const api: BrowserPreviewCaptureApi | null = enabled ? getBrowserPreviewCaptureApi() : null;
  const apiRef = useRef(api);
  apiRef.current = api;
  const [selection, setSelection] = useState<BrowserPreviewSelectionStatus>({ status: "inactive" });
  const [pending, setPending] = useState<BrowserPreviewPendingCaptureDescriptor[]>([]);
  /** Committed records whose spool acknowledgement has not cleared yet. */
  const [unacknowledged, setUnacknowledged] = useState(0);
  const [loaded, setLoaded] = useState<Map<string, BrowserPreviewPendingCapture>>(new Map());
  const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Map<string, CaptureSaveState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<BrowserPreviewExpiredCaptureNotice[]>([]);
  const [desktopCapabilities, setDesktopCapabilities] =
    useState<BrowserPreviewCaptureCapabilities | null>(null);
  /** Increments when main asks the renderer to focus the capture editor. */
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const [lastCommitted, setLastCommitted] = useState<CommittedCapture | null>(null);
  const redactionsRef = useRef(
    new Map<string, { manualRegions: number; imageExcluded: boolean }>(),
  );
  const savingRef = useRef(new Set<string>());
  // In-flight redaction/exclusion per capture. Save waits for these and then
  // re-reads the spool, so it can never upload pixels the user chose to hide.
  const imageChangesRef = useRef(new Map<string, Promise<unknown>>());
  const [imageChanging, setImageChanging] = useState<ReadonlySet<string>>(new Set());
  const openedCaptureRef = useRef<string | null>(null);
  const resumingRef = useRef(false);
  const committedSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) {
      setDesktopCapabilities(null);
      return;
    }
    let cancelled = false;
    void getBrowserPreviewCaptureCapabilities()
      .then((capabilities) => {
        if (!cancelled) setDesktopCapabilities(capabilities);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setSaveState = useCallback((captureId: string, next: Partial<CaptureSaveState>) => {
    if (!mountedRef.current) return;
    setSaveStates((current) => {
      const map = new Map(current);
      map.set(captureId, { ...(current.get(captureId) ?? IDLE), ...next });
      return map;
    });
  }, []);

  const loadCapture = useCallback(async (captureId: string) => {
    const capture = apiRef.current;
    if (!capture) return null;
    const record = await capture.readPendingCapture(captureId);
    if (!mountedRef.current) return record;
    setLoaded((current) => {
      const map = new Map(current);
      if (record) map.set(captureId, record);
      else map.delete(captureId);
      return map;
    });
    return record;
  }, []);

  const refreshExpired = useCallback(async () => {
    const capture = apiRef.current;
    if (!capture?.listExpiredCaptureNotices) return;
    try {
      const notices = await capture.listExpiredCaptureNotices();
      if (!mountedRef.current) return;
      setExpired(notices.filter((notice) => notice.environmentId === environmentId));
    } catch {
      // Notices are informational; a failed read leaves the last list.
    }
  }, [environmentId]);

  /** List the spool; returns every record of this environment (including committed ones). */
  const refreshPending = useCallback(async (): Promise<
    BrowserPreviewPendingCaptureDescriptor[]
  > => {
    const capture = apiRef.current;
    if (!capture) return [];
    try {
      const all = await capture.listPendingCaptures();
      const mine = all.filter((descriptor) => descriptor.environmentId === environmentId);
      for (const descriptor of mine) {
        if (descriptor.recaptureOf) linkRecapture(descriptor.captureId, descriptor.recaptureOf);
      }
      if (!mountedRef.current) return mine;
      const visible = mine.filter((descriptor) => !committedDescriptor(descriptor));
      setPending(visible);
      setUnacknowledged(mine.length - visible.length);
      setLoaded((current) => {
        const ids = new Set(visible.map((descriptor) => descriptor.captureId));
        const map = new Map(Array.from(current).filter(([id]) => ids.has(id)));
        return map.size === current.size ? current : map;
      });
      return mine;
    } catch (listError) {
      if (mountedRef.current) setError(describeWebAnnotationError(listError));
      return [];
    }
  }, [environmentId]);

  const finishCommitted = useCallback(
    (captureId: string, annotationId: string, ackPending: boolean, automatic: boolean) => {
      forgetSaveIntent(captureId);
      if (!ackPending) forgetCaptureIntent(captureId);
      redactionsRef.current.delete(captureId);
      if (annotationId) refreshWebAnnotations(environmentId, { annotationIds: [annotationId] });
      setSaveState(captureId, {
        status: "saved",
        error: null,
        annotationId: annotationId || null,
        ackPending,
        retrying: false,
      });
      if (!mountedRef.current) return;
      if (!ackPending) {
        setActiveCaptureId((current) => (current === captureId ? null : current));
      }
      if (annotationId) {
        committedSeqRef.current += 1;
        setLastCommitted({
          captureId,
          annotationId,
          automatic,
          sequence: committedSeqRef.current,
        });
      }
    },
    [environmentId, setSaveState],
  );

  const runSave = useCallback(
    async (
      captureId: string,
      input: CaptureSaveInput,
      automatic: boolean,
    ): Promise<CaptureSaveOutcome> => {
      const capture = apiRef.current;
      if (!capture) return { ok: false, error: "Capture is unavailable in this client." };
      // Disable duplicate creation while one attempt is in flight.
      if (savingRef.current.has(captureId)) return { ok: false, error: "Already saving." };
      savingRef.current.add(captureId);
      setSaveState(captureId, { status: "saving", error: null, retrying: false });
      try {
        // Let a redaction or exclusion finish, then read the spool itself:
        // the render-time copy may still hold the original pixels.
        await imageChangesRef.current.get(captureId)?.catch(() => undefined);
        const record = await loadCapture(captureId);
        if (!record) throw new Error("This capture expired or was discarded.");
        const committed = await commitPendingCapture({
          api: capture,
          environmentId,
          captureId,
          record,
          input,
          localRedaction: redactionsRef.current.get(captureId),
        });
        finishCommitted(captureId, committed.annotationId, committed.ackPending, automatic);
        void refreshPending();
        return {
          ok: true,
          annotationId: committed.annotationId,
          captureId: committed.backendCaptureId,
        };
      } catch (saveError) {
        const message = describeWebAnnotationError(saveError);
        const retrying = isTransientWebAnnotationError(saveError);
        // Only a transport failure is retried in the background; anything
        // else needs the user (and keeps the text and capture).
        if (!retrying) forgetSaveIntent(captureId);
        setSaveState(captureId, { status: "error", error: message, retrying });
        return { ok: false, error: message };
      } finally {
        savingRef.current.delete(captureId);
      }
    },
    [environmentId, finishCommitted, loadCapture, refreshPending, setSaveState],
  );

  /**
   * Finish what the spool and the backend already agree on: re-acknowledge
   * committed records, finish interrupted saves, and (on `checkReceipts`)
   * look up receipts of records whose save intent was lost.
   */
  const resume = useCallback(
    async ({ checkReceipts }: { checkReceipts: boolean }) => {
      const capture = apiRef.current;
      if (!capture || resumingRef.current) return;
      resumingRef.current = true;
      try {
        const mine = await refreshPending();
        for (const descriptor of mine) {
          const captureId = descriptor.captureId;
          if (savingRef.current.has(captureId)) continue;
          if (descriptor.receipt) {
            const ok = await acknowledgeCommittedCapture(capture, {
              captureId,
              annotationId: descriptor.receipt.annotationId,
              backendCaptureId: descriptor.receipt.backendCaptureId,
            });
            finishCommitted(captureId, descriptor.receipt.annotationId, !ok, true);
            continue;
          }
          const interrupted = saveIntent(captureId);
          if (interrupted) {
            await runSave(captureId, interrupted, true);
            continue;
          }
          if (!checkReceipts && !descriptor.acknowledged) continue;
          try {
            const kind = captureCommitKind({ descriptor }, captureIntent(captureId));
            const receipt = await existingCaptureReceipt(environmentId, captureId, kind);
            if (!receipt) continue;
            const ack = {
              captureId,
              annotationId: receipt.annotationId,
              backendCaptureId: receipt.captureId ?? "",
            };
            const ok = await acknowledgeCommittedCapture(capture, ack);
            finishCommitted(captureId, receipt.annotationId, !ok, true);
          } catch {
            // Offline: the next trigger checks again.
          }
        }
        await refreshPending();
        await refreshExpired();
      } finally {
        resumingRef.current = false;
      }
    },
    [environmentId, finishCommitted, refreshExpired, refreshPending, runSave],
  );
  const resumeRef = useRef(resume);
  resumeRef.current = resume;

  const applyStatus = useCallback(
    (status: BrowserPreviewSelectionStatus) => {
      if (!mountedRef.current) return;
      setSelection(status);
      if (status.status === "captured") {
        const replaced = status.pending?.recaptureOf;
        if (replaced) linkRecapture(status.captureId, replaced);
        // Open a fresh capture once; an explicit close is not undone by polls.
        if (openedCaptureRef.current !== status.captureId) {
          openedCaptureRef.current = status.captureId;
          setActiveCaptureId(status.captureId);
          void loadCapture(status.captureId);
        }
        void refreshPending();
      } else if (status.status === "error") {
        setError(selectionErrorMessage(status));
        if (status.code === "spool-full") void refreshPending();
      }
    },
    [loadCapture, refreshPending],
  );

  const refreshStatus = useCallback(async () => {
    const capture = apiRef.current;
    if (!capture) return;
    try {
      applyStatus(await capture.getCaptureStatus(tabId));
    } catch (statusError) {
      if (mountedRef.current) {
        setSelection({ status: "inactive" });
        setError(describeWebAnnotationError(statusError));
      }
    }
  }, [applyStatus, tabId]);

  // Resume pending captures on mount/activation: they outlive the renderer.
  useEffect(() => {
    if (!api || !isActive) return;
    void resumeRef.current({ checkReceipts: true });
    void refreshStatus();
  }, [api, isActive, refreshStatus]);

  // Bounded background retry while visible and something is still pending,
  // including committed records whose acknowledgement failed (re-acked from
  // their receipt; they are hidden from the pending list).
  const hasPending = pending.length > 0 || unacknowledged > 0;
  useEffect(() => {
    if (!api || !isActive || !hasPending) return;
    const timer = window.setInterval(
      () => void resumeRef.current({ checkReceipts: false }),
      CAPTURE_RESUME_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [api, hasPending, isActive]);

  useEffect(() => {
    if (!api) return;
    const listen = window.orkestrator?.listen;
    if (typeof listen !== "function") return;
    const unlistenCapture = listen<BrowserPreviewCaptureEvent>(
      BROWSER_PREVIEW_CAPTURE_EVENT,
      (event) => {
        if (!event) return;
        if (event.status === "spool-changed") {
          void refreshPending();
          if (event.reason === "expired") void refreshExpired();
          return;
        }
        if (event.status === "pins-invalidated" || event.status === "pins-changed") return;
        if (event.tabId !== tabId) return;
        if (event.focus === "editor") setEditorFocusRequest((current) => current + 1);
        void refreshStatus();
      },
    );
    // A reconnected gateway is the moment interrupted uploads can finish.
    const unlistenReconnect = listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      void resumeRef.current({ checkReceipts: true });
    });
    return () => {
      unlistenCapture?.();
      unlistenReconnect?.();
    };
  }, [api, refreshExpired, refreshPending, refreshStatus, tabId]);

  const selecting = isSelecting(selection);
  useEffect(() => {
    if (!api || !selecting) return;
    const timer = window.setInterval(() => void refreshStatus(), SELECTION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [api, refreshStatus, selecting]);

  const cancel = useCallback(async () => {
    const capture = apiRef.current;
    setSelection({ status: "inactive" });
    if (!capture) return;
    await capture.cancelCapture(tabId).catch(() => undefined);
  }, [tabId]);

  // Selection is transient inspection UI: hiding the tab or unmounting ends
  // it. Pending captures, drafts, and committed threads are untouched.
  useEffect(() => {
    if (isActive || !selecting) return;
    void cancel();
  }, [cancel, isActive, selecting]);
  useEffect(
    () => () => {
      const capture = apiRef.current;
      if (capture) void capture.cancelCapture(tabId).catch(() => undefined);
    },
    [tabId],
  );

  const start = useCallback(
    async (mode: BrowserPreviewCaptureMode, options: StartCaptureOptions = {}) => {
      const capture = apiRef.current;
      if (!capture) {
        setError("Capture is available in the Orkestrator desktop app.");
        return false;
      }
      setError(null);
      try {
        const status = await capture.startCapture({
          tabId,
          mode,
          environmentId,
          ...(options.annotationId ? { annotationId: options.annotationId } : {}),
          ...(options.result ? { purpose: "result" as const, result: options.result } : {}),
        });
        const captureId = selectionCaptureId(status);
        if (captureId && options.intent) rememberCaptureIntent(captureId, options.intent);
        applyStatus(status);
        return status.status !== "error";
      } catch (startError) {
        if (mountedRef.current) setError(describeWebAnnotationError(startError));
        return false;
      }
    },
    [applyStatus, environmentId, tabId],
  );

  /** Select the same target again for a stale pending capture (desktop contract 2). */
  const recapture = useCallback(
    async (captureId: string) => {
      const capture = apiRef.current;
      const descriptor =
        pending.find((item) => item.captureId === captureId) ??
        loaded.get(captureId)?.descriptor ??
        null;
      if (!capture || !descriptor) return false;
      setError(null);
      // A failed save of the old capture must not be finished automatically
      // once it is being replaced.
      forgetSaveIntent(captureId);
      try {
        const status = await capture.startCapture({
          tabId,
          mode: descriptor.mode,
          environmentId,
          recaptureCaptureId: captureId,
        });
        const newId = selectionCaptureId(status);
        if (newId && newId !== captureId) linkRecapture(newId, captureId);
        applyStatus(status);
        return status.status !== "error";
      } catch (startError) {
        if (mountedRef.current) setError(describeWebAnnotationError(startError));
        return false;
      }
    },
    [applyStatus, environmentId, loaded, pending, tabId],
  );

  const captureResponsive = useCallback(
    async (
      widths: number[],
      options: { annotationId?: string; target?: WebAnnotationTarget } = {},
    ): Promise<BrowserPreviewResponsiveSetResult | null> => {
      const capture = apiRef.current;
      if (!capture?.captureResponsiveSet) {
        setError("Responsive capture needs a newer Orkestrator desktop app.");
        return null;
      }
      setError(null);
      try {
        const result = await capture.captureResponsiveSet({
          tabId,
          environmentId,
          widths,
          ...(options.annotationId ? { annotationId: options.annotationId } : {}),
          ...(options.target ? { target: options.target } : {}),
        });
        await refreshPending();
        const first = result.captures[0];
        if (first && mountedRef.current) {
          openedCaptureRef.current = first.captureId;
          setActiveCaptureId(first.captureId);
          void loadCapture(first.captureId);
        }
        return result;
      } catch (captureError) {
        if (mountedRef.current) setError(describeWebAnnotationError(captureError));
        return null;
      }
    },
    [environmentId, loadCapture, refreshPending, tabId],
  );

  const openPending = useCallback(
    (captureId: string | null) => {
      setActiveCaptureId(captureId);
      if (captureId && !loaded.has(captureId)) void loadCapture(captureId);
    },
    [loadCapture, loaded],
  );

  /** Run one image change at a time per capture, and never during a save. */
  const trackImageChange = useCallback(
    async (captureId: string, change: () => Promise<boolean>): Promise<boolean> => {
      if (savingRef.current.has(captureId) || imageChangesRef.current.has(captureId)) {
        return false;
      }
      const task = change();
      imageChangesRef.current.set(captureId, task);
      if (mountedRef.current) setImageChanging((current) => new Set(current).add(captureId));
      try {
        return await task;
      } finally {
        imageChangesRef.current.delete(captureId);
        if (mountedRef.current) {
          setImageChanging((current) => {
            const next = new Set(current);
            next.delete(captureId);
            return next;
          });
        }
      }
    },
    [],
  );

  const applyRedaction = useCallback(
    (captureId: string, regions: readonly RedactionRect[]) =>
      trackImageChange(captureId, async () => {
        const capture = apiRef.current;
        // Redact the spool's current bytes, not a possibly stale render copy.
        const record = await loadCapture(captureId);
        if (!capture || !record?.imageDataUrl) return false;
        try {
          const redacted = await redactPngDataUrl(record.imageDataUrl, regions);
          // The spool replaces its working copy before anything is uploaded;
          // the unredacted image cannot be restored afterwards. `manualRegions`
          // is this pass only: the spool accumulates the total itself.
          await capture.replacePendingCaptureImage(captureId, {
            imageDataUrl: redacted,
            manualRegions: regions.length,
            regions: regions.map((region) => ({ ...region })),
          });
          const previous = redactionsRef.current.get(captureId);
          redactionsRef.current.set(captureId, {
            manualRegions: (previous?.manualRegions ?? 0) + regions.length,
            imageExcluded: previous?.imageExcluded ?? false,
          });
          await loadCapture(captureId);
          return true;
        } catch (redactError) {
          if (mountedRef.current) setError(describeWebAnnotationError(redactError));
          return false;
        }
      }),
    [loadCapture, trackImageChange],
  );

  const excludeImage = useCallback(
    (captureId: string) =>
      trackImageChange(captureId, async () => {
        const capture = apiRef.current;
        if (!capture) return false;
        try {
          await capture.replacePendingCaptureImage(captureId, {
            imageDataUrl: null,
            manualRegions: 0,
          });
          const previous = redactionsRef.current.get(captureId);
          redactionsRef.current.set(captureId, {
            manualRegions: previous?.manualRegions ?? 0,
            imageExcluded: true,
          });
          await loadCapture(captureId);
          return true;
        } catch (excludeError) {
          if (mountedRef.current) setError(describeWebAnnotationError(excludeError));
          return false;
        }
      }),
    [loadCapture, trackImageChange],
  );

  const discard = useCallback(
    async (captureId: string) => {
      const capture = apiRef.current;
      if (!capture) return;
      try {
        await capture.discardPendingCapture(captureId);
        forgetCaptureIntent(captureId);
        forgetSaveIntent(captureId);
        redactionsRef.current.delete(captureId);
        if (mountedRef.current) {
          setActiveCaptureId((current) => (current === captureId ? null : current));
          setSaveStates((current) => {
            const map = new Map(current);
            map.delete(captureId);
            return map;
          });
        }
        await refreshPending();
      } catch (discardError) {
        if (mountedRef.current) setError(describeWebAnnotationError(discardError));
      }
    },
    [refreshPending],
  );

  const save = useCallback(
    (captureId: string, input: CaptureSaveInput): Promise<CaptureSaveOutcome> => {
      if (savingRef.current.has(captureId)) {
        return Promise.resolve({ ok: false, error: "Already saving." });
      }
      // Written before the commit: an interrupted save is finished later
      // with the same operation ids instead of being forgotten.
      rememberSaveIntent(captureId, { ...input, createdAt: Date.now() });
      return runSave(captureId, input, false);
    },
    [runSave],
  );

  /**
   * Save every member of a responsive set: the first creates the note (or
   * replaces an existing note's capture), later widths are attached to the
   * same thread as separate, separately-timed capture revisions.
   */
  const saveResponsiveSet = useCallback(
    async (setId: string, input: CaptureSaveInput): Promise<CaptureSaveOutcome> => {
      const members = pending
        .filter((descriptor) => descriptor.responsive?.setId === setId)
        .sort((a, b) => (a.responsive?.index ?? 0) - (b.responsive?.index ?? 0));
      const [first, ...rest] = members;
      if (!first) return { ok: false, error: "This responsive set is no longer pending." };
      const created = await save(first.captureId, input);
      if (!created.ok) return created;
      for (const member of rest) {
        const outcome = await save(member.captureId, {
          body: "",
          annotationId: created.annotationId,
        });
        if (!outcome.ok) return outcome;
      }
      return created;
    },
    [pending, save],
  );

  const dismissExpired = useCallback(
    async (captureIds?: string[]) => {
      const capture = apiRef.current;
      if (!capture?.dismissExpiredCaptureNotices) return;
      const ids = captureIds ?? expired.map((notice) => notice.captureId);
      try {
        await capture.dismissExpiredCaptureNotices(ids);
      } finally {
        await refreshExpired();
      }
    },
    [expired, refreshExpired],
  );

  const activeCapture = activeCaptureId ? (loaded.get(activeCaptureId) ?? null) : null;
  const activeDescriptor = useMemo(
    () =>
      activeCaptureId
        ? (pending.find((descriptor) => descriptor.captureId === activeCaptureId) ??
          activeCapture?.descriptor ??
          null)
        : null,
    [activeCapture?.descriptor, activeCaptureId, pending],
  );

  return {
    available: Boolean(api),
    desktopCapabilities,
    selection,
    selecting,
    error,
    clearError: () => setError(null),
    start,
    recapture,
    captureResponsive,
    cancel,
    pending,
    activeCaptureId,
    activeCapture,
    activeDescriptor,
    openPending,
    saveState: (captureId: string) => saveStates.get(captureId) ?? IDLE,
    /** A redaction or image exclusion is still being written to the spool. */
    imageChanging: (captureId: string) => imageChanging.has(captureId),
    save,
    saveResponsiveSet,
    applyRedaction,
    excludeImage,
    discard,
    refreshPending,
    resume,
    expired,
    dismissExpired,
    editorFocusRequest,
    lastCommitted,
  };
}

export type AnnotationCaptureController = ReturnType<typeof useAnnotationCapture>;
