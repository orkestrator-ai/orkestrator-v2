/**
 * Backend-persisted, unpublished editor draft (plan step 05).
 *
 * Typing autosaves after a short debounce with the last known draft revision,
 * one save at a time, so a delayed save can never overwrite a newer draft.
 * Hydration never replaces text the user has typed; a revision conflict keeps
 * the local text and surfaces the server version for an explicit choice.
 *
 * Unsaved text is also kept in a bounded local copy (`local-drafts.ts`), so
 * text typed while the backend is unreachable survives an unmount or reload
 * and is flushed once the backend answers again (reconnect, bounded retry, or
 * the next mount). The local copy records the revision it was typed against,
 * so a newer server draft becomes a conflict rather than being overwritten.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationDraft,
} from "@orkestrator/protocol/web-annotations";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  describeWebAnnotationError,
  isTransientWebAnnotationError,
  isWebAnnotationConflict,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import {
  clearLocalDraft,
  readLocalDraft,
  writeLocalDraft,
} from "@/lib/web-annotations/local-drafts";

export const DRAFT_AUTOSAVE_MS = 800;
/** Local copies are written at most this often while typing. */
const LOCAL_WRITE_MS = 200;
/** Retry delays after a transport failure (the last one repeats). */
export const DRAFT_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export type DraftStatus = "loading" | "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

export interface DraftConflict {
  local: string;
  server: string;
  serverRevision: number;
}

export interface DraftContext {
  annotationId?: string | null;
  captureId?: string | null;
  pendingCaptureId?: string | null;
}

/**
 * Text typed after `saved` was captured for publishing: the part that was
 * not published. Appended text is kept without the published prefix; any
 * other edit keeps the whole current text.
 */
export function unsavedRemainder(saved: string, current: string): string {
  if (current === saved) return "";
  if (current.startsWith(saved)) return current.slice(saved.length).replace(/^\s+/, "");
  return current;
}

export function useAnnotationDraft({
  environmentId,
  editorId,
  context,
  enabled,
}: {
  environmentId: string;
  editorId: string;
  context: DraftContext;
  enabled: boolean;
}) {
  const [text, setTextState] = useState("");
  const [status, setStatus] = useState<DraftStatus>(enabled ? "loading" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  /** True while the only copy of the current text is on this computer. */
  const [localOnly, setLocalOnly] = useState(false);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const revisionRef = useRef(0);
  const textRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const saveAgainRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const keyRef = useRef(`${environmentId}\0${editorId}`);
  /**
   * The editor identity `textRef` belongs to. A keystroke can reach `setText`
   * after the editor rendered but before the identity effect below ran (React
   * flushes that pending effect at the start of the keystroke's own render, so
   * a busy renderer widens the window); that text must not be reset.
   */
  const textKeyRef = useRef<string | null>(null);
  /** Updated only when the editor identity changes, never during render. */
  const targetRef = useRef({ environmentId, editorId });
  const contextRef = useRef(context);
  contextRef.current = context;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Keep (or drop) the local copy for the current editor right now. */
  const syncLocalNow = useCallback(() => {
    if (localTimerRef.current) {
      clearTimeout(localTimerRef.current);
      localTimerRef.current = null;
    }
    const { environmentId, editorId } = targetRef.current;
    if (dirtyRef.current) {
      writeLocalDraft(environmentId, editorId, textRef.current, revisionRef.current);
    } else {
      clearLocalDraft(environmentId, editorId);
    }
  }, []);

  const scheduleLocal = useCallback(() => {
    if (localTimerRef.current) clearTimeout(localTimerRef.current);
    localTimerRef.current = setTimeout(() => {
      localTimerRef.current = null;
      syncLocalNow();
    }, LOCAL_WRITE_MS);
  }, [syncLocalNow]);

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const key = `${environmentId}\0${editorId}`;
  useEffect(() => {
    keyRef.current = key;
    targetRef.current = { environmentId, editorId };
    retryAttemptRef.current = 0;
    setConflict(null);
    setDraftId(null);
    setError(null);
    // Text already typed into this editor (see `textKeyRef`) is the newest
    // copy; otherwise unsaved local text from an earlier mount or reload is
    // shown at once.
    const local =
      dirtyRef.current && textKeyRef.current === key
        ? { text: textRef.current, baseRevision: revisionRef.current }
        : readLocalDraft(environmentId, editorId);
    revisionRef.current = local?.baseRevision ?? 0;
    dirtyRef.current = Boolean(local);
    textRef.current = local?.text ?? "";
    textKeyRef.current = key;
    setTextState(textRef.current);
    setLocalOnly(Boolean(local));
    if (!enabled) {
      setStatus(local ? "dirty" : "idle");
      return;
    }
    setStatus(local ? "dirty" : "loading");
    let cancelled = false;
    void webAnnotationCommand(WEB_ANNOTATION_COMMANDS.draftGet, { environmentId, editorId })
      .then((result) => {
        if (cancelled || keyRef.current !== key) return;
        const draft = result?.draft ?? null;
        if (draft) setDraftId(draft.id);
        if (!dirtyRef.current) {
          revisionRef.current = draft?.revision ?? 0;
          if (draft) {
            textRef.current = draft.text;
            setTextState(draft.text);
            setStatus("saved");
          } else setStatus("idle");
          return;
        }
        // Local text exists (restored or typed before hydration finished).
        const serverRevision = draft?.revision ?? 0;
        if (draft && draft.text === textRef.current) {
          revisionRef.current = serverRevision;
          dirtyRef.current = false;
          syncLocalNow();
          setLocalOnly(false);
          setStatus("saved");
          return;
        }
        const base = local?.baseRevision ?? 0;
        if (serverRevision === (local ? base : revisionRef.current) || (!draft && base === 0)) {
          // The server has not moved since this text was typed: flush it.
          revisionRef.current = serverRevision;
          setStatus("dirty");
          void persistRef.current();
          return;
        }
        // Never overwrite a newer draft saved elsewhere.
        revisionRef.current = serverRevision;
        setConflict({ local: textRef.current, server: draft?.text ?? "", serverRevision });
        setStatus("conflict");
      })
      .catch((loadError: unknown) => {
        if (cancelled || keyRef.current !== key) return;
        setError(describeWebAnnotationError(loadError));
        setStatus(dirtyRef.current ? "dirty" : "error");
        if (dirtyRef.current && isTransientWebAnnotationError(loadError))
          scheduleRetryRef.current();
      });
    return () => {
      cancelled = true;
      cancelRetry();
      // Switching editors or unmounting is not "discard": keep the local copy
      // and flush a pending autosave to the editor it was typed in.
      if (localTimerRef.current) syncLocalNow();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        if (!conflictRef.current && dirtyRef.current) void persistRef.current();
      }
    };
  }, [cancelRetry, editorId, enabled, environmentId, key, syncLocalNow]);

  const persist = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const { environmentId, editorId } = targetRef.current;
    if (savingRef.current) {
      saveAgainRef.current = true;
      return savingRef.current;
    }
    cancelRetry();
    const run = async () => {
      do {
        saveAgainRef.current = false;
        const requestKey = keyRef.current;
        const snapshot = textRef.current;
        if (mountedRef.current) setStatus("saving");
        try {
          const { draft } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.draftSave, {
            environmentId,
            editorId,
            expectedRevision: revisionRef.current,
            text: snapshot,
            annotationId: contextRef.current.annotationId ?? null,
            captureId: contextRef.current.captureId ?? null,
            pendingCaptureId: contextRef.current.pendingCaptureId ?? null,
          });
          if (keyRef.current !== requestKey) {
            // The editor switched while this flush was in flight: the text it
            // saved is now on the backend, so its local copy can go.
            if (draft.text === snapshot) clearLocalDraft(environmentId, editorId);
            return;
          }
          revisionRef.current = draft.revision;
          retryAttemptRef.current = 0;
          if (mountedRef.current) setDraftId(draft.id);
          if (textRef.current === snapshot) dirtyRef.current = false;
          syncLocalNow();
          if (mountedRef.current) {
            setLocalOnly(dirtyRef.current);
            setError(null);
            setStatus(dirtyRef.current ? "dirty" : "saved");
          }
        } catch (saveError) {
          if (keyRef.current !== requestKey || !mountedRef.current) return;
          if (isWebAnnotationConflict(saveError)) {
            const server = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.draftGet, {
              environmentId,
              editorId,
            }).catch(() => ({ draft: null as WebAnnotationDraft | null }));
            if (!mountedRef.current || keyRef.current !== requestKey) return;
            setConflict({
              local: textRef.current,
              server: server.draft?.text ?? "",
              serverRevision: server.draft?.revision ?? 0,
            });
            setStatus("conflict");
            return;
          }
          // The text stays in the editor and in the local copy.
          syncLocalNow();
          setLocalOnly(true);
          setError(describeWebAnnotationError(saveError));
          setStatus("error");
          if (isTransientWebAnnotationError(saveError)) scheduleRetryRef.current();
          return;
        }
      } while (saveAgainRef.current && dirtyRef.current);
    };
    const promise = run().finally(() => {
      savingRef.current = null;
    });
    savingRef.current = promise;
    return promise;
  }, [cancelRetry, enabled, syncLocalNow]);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const scheduleRetry = useCallback(() => {
    if (!mountedRef.current || retryTimerRef.current) return;
    const attempt = retryAttemptRef.current;
    retryAttemptRef.current = attempt + 1;
    const delay = DRAFT_RETRY_MS[Math.min(attempt, DRAFT_RETRY_MS.length - 1)]!;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (!conflictRef.current && dirtyRef.current) void persistRef.current();
    }, delay);
  }, []);
  const scheduleRetryRef = useRef(scheduleRetry);
  scheduleRetryRef.current = scheduleRetry;

  // A reconnected gateway flushes text typed while it was away.
  useEffect(() => {
    if (!enabled) return;
    const listen = window.orkestrator?.listen;
    if (typeof listen !== "function") return;
    return listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      if (!conflictRef.current && dirtyRef.current) {
        cancelRetry();
        retryAttemptRef.current = 0;
        void persistRef.current();
      }
    });
  }, [cancelRetry, enabled]);

  const setText = useCallback(
    (value: string) => {
      textRef.current = value;
      textKeyRef.current = key;
      dirtyRef.current = true;
      setTextState(value);
      setStatus((current) => (current === "conflict" ? current : "dirty"));
      scheduleLocal();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!enabled) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!conflictRef.current && dirtyRef.current) void persist();
      }, DRAFT_AUTOSAVE_MS);
    },
    [enabled, key, persist, scheduleLocal],
  );

  /**
   * Flush pending text now (explicit Save). `force` saves even an unchanged
   * (possibly empty) editor, so capture-only context becomes a backend draft.
   */
  const flush = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      syncLocalNow();
      if (conflictRef.current) return;
      if (dirtyRef.current || savingRef.current || options.force) await persist();
    },
    [persist, syncLocalNow],
  );

  const resolveConflict = useCallback(
    (choice: "keep-local" | "use-server") => {
      const current = conflictRef.current;
      if (!current) return;
      // Typing armed an autosave before the conflict; the choice replaces it.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      revisionRef.current = current.serverRevision;
      setConflict(null);
      conflictRef.current = null;
      if (choice === "use-server") {
        textRef.current = current.server;
        dirtyRef.current = false;
        syncLocalNow();
        setLocalOnly(false);
        setTextState(current.server);
        setStatus("saved");
        return;
      }
      textRef.current = current.local;
      dirtyRef.current = true;
      syncLocalNow();
      setTextState(current.local);
      void persist();
    },
    [persist, syncLocalNow],
  );

  /** Remove the unpublished draft after a publish (best effort). */
  const clear = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    cancelRetry();
    const revision = revisionRef.current;
    const { environmentId, editorId } = targetRef.current;
    textRef.current = "";
    dirtyRef.current = false;
    syncLocalNow();
    setLocalOnly(false);
    setTextState("");
    setStatus("idle");
    if (!enabled || revision === 0) return;
    await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.draftDelete, {
      environmentId,
      editorId,
      expectedRevision: revision,
    }).catch(() => undefined);
    // Typing may already have created a newer revision; keep that one.
    if (revisionRef.current === revision) revisionRef.current = 0;
  }, [cancelRetry, enabled, syncLocalNow]);

  /**
   * After publishing `saved`, clear only what was published: text typed while
   * the save was in flight stays in this editor (and its draft). Returns the
   * text that remains.
   */
  const clearSaved = useCallback(
    async (saved: string): Promise<string> => {
      const remainder = unsavedRemainder(saved, textRef.current);
      if (!remainder) {
        await clear();
        return "";
      }
      textRef.current = remainder;
      dirtyRef.current = true;
      setTextState(remainder);
      setStatus("dirty");
      syncLocalNow();
      void persist();
      return remainder;
    },
    [clear, persist, syncLocalNow],
  );

  return {
    text,
    setText,
    /** The latest text, including keystrokes not yet rendered. */
    readText: () => textRef.current,
    status,
    error,
    conflict,
    draftId,
    localOnly,
    dirty: status === "dirty" || status === "conflict" || status === "error",
    flush,
    resolveConflict,
    clear,
    clearSaved,
  };
}

export type AnnotationDraftController = ReturnType<typeof useAnnotationDraft>;
