import { useCallback, useEffect, useRef, useState } from "react";
import type { RichInteractionViewRecord } from "@orkestrator/protocol/contract/domains/rich-interactions";
import type { RichInteractionReceipt } from "@orkestrator/protocol/rich-interactions";
import {
  richInteractionErrorCode,
  richInteractionErrorMessage,
} from "@/lib/chat/rich-interaction-errors";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/**
 * Renderer state for rich interactions.
 *
 * The backend is authoritative: a card reads the request snapshot when it
 * mounts, re-reads on the environment's `rich-interaction` hint, on a resync
 * and on the view safety check, so a missed event is recovered by the next
 * read. A small module cache restores the last snapshot immediately when a
 * virtualized row remounts; it is display state only and never the source of
 * a decision. Drafts are the user's: kept locally while editing, synced to the
 * backend (revision-checked) after a short pause, and never dispatched.
 */

export type RichInteractionView = RichInteractionViewRecord;

const SNAPSHOT_CACHE = new Map<string, RichInteractionView>();
const SNAPSHOT_CACHE_LIMIT = 200;

function cacheKey(environmentId: string, interactionId: string): string {
  return `${environmentId}\0${interactionId}`;
}

function remember(key: string, view: RichInteractionView): void {
  SNAPSHOT_CACHE.delete(key);
  SNAPSHOT_CACHE.set(key, view);
  while (SNAPSHOT_CACHE.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = SNAPSHOT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    SNAPSHOT_CACHE.delete(oldest);
  }
}

/** Test hook: forget cached snapshots between tests. */
export function resetRichInteractionCache(): void {
  SNAPSHOT_CACHE.clear();
}

export type RichInteractionLoad =
  | { status: "loading"; view: RichInteractionView | null }
  | { status: "ready"; view: RichInteractionView }
  | { status: "missing"; view: null; message: string }
  | { status: "error"; view: RichInteractionView | null; message: string };

/** Reads one interaction and keeps it current. */
export function useRichInteraction(
  environmentId: string | null,
  interactionId: string | null,
): {
  load: RichInteractionLoad;
  refresh: () => Promise<RichInteractionView | null>;
  replace: (view: RichInteractionView) => void;
} {
  const backend = useScopeBackend();
  const key = environmentId && interactionId ? cacheKey(environmentId, interactionId) : "";
  const [state, setState] = useState<{ key: string; load: RichInteractionLoad }>(() => ({
    key,
    load: { status: "loading", view: key ? (SNAPSHOT_CACHE.get(key) ?? null) : null },
  }));
  const sequence = useRef(0);

  // One read path, defined with the subscriptions that trigger it; `refresh`
  // forwards to it so callers (a submit, a retry) can ask for a fresh read.
  const refresh = useCallback((): Promise<RichInteractionView | null> => {
    if (!environmentId || !interactionId) return Promise.resolve(null);
    const request = ++sequence.current;
    const key = cacheKey(environmentId, interactionId);
    return backend.getRichInteraction({ environmentId, interactionId }).then(
      (view) => {
        if (request === sequence.current) {
          remember(key, view);
          setState({ key, load: { status: "ready", view } });
        }
        return view;
      },
      (error: unknown) => {
        if (request === sequence.current) {
          const code = richInteractionErrorCode(error);
          setState((current) => ({
            key,
            load:
              code === "not-found"
                ? {
                    status: "missing",
                    view: null,
                    message: "This interaction is no longer available.",
                  }
                : {
                    status: "error",
                    view: current.load.view,
                    message: richInteractionErrorMessage(error),
                  },
          }));
        }
        return null;
      },
    );
  }, [backend, environmentId, interactionId]);

  useEffect(() => {
    if (!environmentId || !interactionId) return;
    const read = () => void refresh();
    const initial = setTimeout(read, 0);
    const offChange = onResourceChanged("rich-interaction", (change) => {
      if (!change.id || change.id === environmentId) read();
    });
    const offSafety = onViewSafetyCheck(read);
    const offResync = onResourceResync(read);
    return () => {
      clearTimeout(initial);
      sequence.current += 1;
      offChange();
      offSafety();
      offResync();
    };
  }, [environmentId, interactionId, refresh]);

  const replace = useCallback(
    (view: RichInteractionView) => {
      if (!environmentId) return;
      remember(cacheKey(environmentId, view.request.interactionId), view);
      setState({
        key: cacheKey(environmentId, view.request.interactionId),
        load: { status: "ready", view },
      });
    },
    [environmentId],
  );

  const load: RichInteractionLoad =
    state.key === key
      ? state.load
      : { status: "loading", view: key ? (SNAPSHOT_CACHE.get(key) ?? null) : null };
  return { load, refresh, replace };
}

/** Every interaction of one conversation (the Interactions/Deliverables panels). */
export function useRichInteractionList(
  environmentId: string | null,
  logicalSessionKey: string | null,
): {
  views: RichInteractionView[];
  status: "loading" | "ready" | "error";
  refresh: () => void;
} {
  const backend = useScopeBackend();
  const [state, setState] = useState<{
    key: string;
    views: RichInteractionView[];
    status: "loading" | "ready" | "error";
  }>({ key: "", views: [], status: "loading" });
  const key = environmentId && logicalSessionKey ? `${environmentId}\0${logicalSessionKey}` : "";
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!environmentId || !logicalSessionKey) return;
    const request = ++sequence.current;
    void backend
      .listRichInteractions({ environmentId, logicalSessionKey })
      .then((views) => {
        if (request === sequence.current)
          setState({ key: `${environmentId}\0${logicalSessionKey}`, views, status: "ready" });
      })
      .catch(() => {
        if (request === sequence.current)
          setState((current) => ({
            key,
            views: current.key === key ? current.views : [],
            status: "error",
          }));
      });
  }, [backend, environmentId, key, logicalSessionKey]);
  useEffect(() => {
    if (!key) return;
    refresh();
    const offChange = onResourceChanged("rich-interaction", (change) => {
      if (!change.id || change.id === environmentId) refresh();
    });
    const offResync = onResourceResync(() => refresh());
    return () => {
      sequence.current += 1;
      offChange();
      offResync();
    };
  }, [environmentId, key, refresh]);
  return state.key === key
    ? { views: state.views, status: state.status, refresh }
    : { views: [], status: "loading", refresh };
}

export function newIdempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ui-${random}`;
}

export type SubmitOutcome =
  | { ok: true; receipt: RichInteractionReceipt }
  | { ok: false; code: string | null; message: string; retryable: boolean };

/**
 * The submit and draft lifecycle of one card.
 *
 * Submission: the idempotency key is minted for the person's deliberate
 * action and kept until its outcome is known, so a retry after a lost
 * response, a double click or a reconnect reuses it and the backend answers
 * with the original receipt. A new deliberate action (after an outcome) gets a
 * new key.
 *
 * Drafts: local first; synced after a pause with the expected draft revision.
 * A conflict keeps the local draft and reports it; nothing is overwritten.
 */
export function useInteractionController(
  environmentId: string | null,
  view: RichInteractionView | null,
  onView: (view: RichInteractionView) => void,
  refresh: () => Promise<RichInteractionView | null>,
) {
  const backend = useScopeBackend();
  const request = view?.request ?? null;
  const serverDraft =
    view?.draft && request && view.draft.requestRevision === request.revision ? view.draft : null;
  const [local, setLocal] = useState<{
    interactionId: string;
    revision: number;
    value: unknown;
  } | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const pendingKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const draftRevision = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    draftRevision.current = view?.draft?.revision ?? 0;
  }, [view?.draft?.revision]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const draft =
    local &&
    request &&
    local.interactionId === request.interactionId &&
    local.revision === request.revision
      ? local.value
      : (serverDraft?.value ?? undefined);
  const staleDraft = Boolean(
    view?.draft && request && view.draft.requestRevision !== request.revision,
  );

  const setDraft = useCallback(
    (value: unknown) => {
      if (!request || !environmentId) return;
      setLocal({ interactionId: request.interactionId, revision: request.revision, value });
      setOutcome(null);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const interactionId = request.interactionId;
      const requestRevision = request.revision;
      saveTimer.current = setTimeout(() => {
        void backend
          .saveRichInteractionDraft({
            environmentId,
            interactionId,
            expectedDraftRevision: draftRevision.current,
            requestRevision,
            value,
          })
          .then((saved) => {
            draftRevision.current = saved.revision;
            setDraftConflict(false);
          })
          .catch((error: unknown) => {
            // The local draft stays; a conflict is shown, other failures retry on the next edit.
            if (richInteractionErrorCode(error) === "conflict") setDraftConflict(true);
          });
      }, 600);
    },
    [backend, environmentId, request],
  );

  const submit = useCallback(
    async (
      actionId: string,
      result: unknown,
      options: { keepDraft?: boolean } = {},
    ): Promise<SubmitOutcome> => {
      if (!request || !environmentId)
        return { ok: false, code: "invalid", message: "Not ready.", retryable: false };
      const fingerprint = JSON.stringify([
        request.interactionId,
        request.revision,
        actionId,
        result,
      ]);
      if (!pendingKey.current || pendingKey.current.fingerprint !== fingerprint) {
        pendingKey.current = { fingerprint, key: newIdempotencyKey() };
      }
      setSubmitting(true);
      setOutcome(null);
      try {
        const receipt = await backend.submitRichInteraction({
          environmentId,
          interactionId: request.interactionId,
          expectedRevision: request.revision,
          ...(!options.keepDraft ? { expectedDraftRevision: draftRevision.current } : {}),
          actionId,
          idempotencyKey: pendingKey.current.key,
          result,
        });
        pendingKey.current = null;
        if (options.keepDraft) {
          // A progress save (e.g. a walkthrough step): the rest of the draft carries on
          // against the revision this submission produced.
          const resulting = receipt.resultingRevision;
          if (resulting !== undefined)
            setLocal((current) => (current ? { ...current, revision: resulting } : current));
        } else {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          setLocal(null);
        }
        const next: SubmitOutcome = { ok: true, receipt };
        setOutcome(next);
        const fresh = await refresh();
        if (fresh) {
          draftRevision.current = fresh.draft?.revision ?? 0;
          onView(fresh);
        }
        return next;
      } catch (error) {
        const code = richInteractionErrorCode(error);
        // A definite refusal ends this attempt; anything else may have committed,
        // so the same key is kept for the retry.
        const definite = code !== null && code !== "unavailable";
        if (definite) pendingKey.current = null;
        const next: SubmitOutcome = {
          ok: false,
          code,
          message: richInteractionErrorMessage(error),
          retryable: !definite,
        };
        setOutcome(next);
        if (code === "stale" || code === "closed") void refresh();
        return next;
      } finally {
        setSubmitting(false);
      }
    },
    [backend, environmentId, onView, refresh, request],
  );

  const dismiss = useCallback(async () => {
    if (!request || !environmentId) return;
    try {
      await backend.dismissRichInteraction({
        environmentId,
        interactionId: request.interactionId,
        expectedRevision: request.revision,
      });
    } finally {
      await refresh();
    }
  }, [backend, environmentId, refresh, request]);

  const retryDelivery = useCallback(
    async (receiptId: string) => {
      if (!environmentId) return;
      try {
        await backend.retryRichInteractionDelivery({ environmentId, receiptId });
      } finally {
        await refresh();
      }
    },
    [backend, environmentId, refresh],
  );

  return {
    draft,
    setDraft,
    draftConflict,
    staleDraft,
    submitting,
    outcome,
    submit,
    dismiss,
    retryDelivery,
  };
}

export type InteractionController = ReturnType<typeof useInteractionController>;

/** Display text of a delivery state. Queue acceptance, delivery and application stay distinct. */
export function deliveryLabel(state: RichInteractionReceipt["delivery"]): string {
  switch (state) {
    case "recorded":
      return "Saved";
    case "pending":
      return "Sending…";
    case "queued":
      return "Queued for the agent";
    case "delivered":
      return "Delivered to the agent";
    case "applied":
      return "Applied";
    case "failed":
      return "Not delivered";
    case "unknown":
      return "Outcome unknown";
  }
}
