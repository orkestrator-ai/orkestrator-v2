import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { create } from "zustand";

/**
 * In-progress user input for blocking agent prompts: multi-question form
 * answers, plan-rejection feedback, MCP form/elicitation values.
 *
 * The cards rendering these prompts live inside chat tabs that unmount when
 * the user switches environments, while the prompt itself rehydrates from the
 * authoritative pending-request state (bridge snapshot via the agent stores).
 * A draft kept in component state therefore silently vanished mid-answer. The
 * drafts live here instead — same pattern as `messagePartExpansionStore` —
 * keyed by stable session and request identities, and the store that owns the
 * pending request clears them when the request resolves (submitted, rejected,
 * or withdrawn), so a stale draft can never reappear on a reused request id.
 *
 * Renderer-only state: none of this needs to survive an app restart.
 */

type DraftRecord = Record<string, unknown>;

/**
 * Safety net for paths that drop a pending request without reaching its
 * store's remove action. Map preserves insertion order and writes re-insert,
 * so trimming from the front drops the least recently edited drafts.
 */
const MAX_DRAFTS = 100;

interface PromptDraftState {
  drafts: ReadonlyMap<string, DraftRecord>;
  setDraftValue: (draftKey: string, field: string, value: unknown) => void;
  clearDraft: (draftKey: string) => void;
  clearDrafts: (draftKeys: Iterable<string>) => void;
  reset: () => void;
}

export const usePromptDraftStore = create<PromptDraftState>((set) => ({
  drafts: new Map(),

  setDraftValue: (draftKey, field, value) =>
    set((state) => {
      const next = new Map(state.drafts);
      const record = { ...next.get(draftKey), [field]: value };
      // Delete-then-set keeps actively edited drafts at the back so the cap
      // trims the stalest ones first.
      next.delete(draftKey);
      next.set(draftKey, record);
      while (next.size > MAX_DRAFTS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return { drafts: next };
    }),

  clearDraft: (draftKey) =>
    set((state) => {
      if (!state.drafts.has(draftKey)) return state;
      const next = new Map(state.drafts);
      next.delete(draftKey);
      return { drafts: next };
    }),

  clearDrafts: (draftKeys) =>
    set((state) => {
      let next: Map<string, DraftRecord> | null = null;
      for (const draftKey of draftKeys) {
        if (!state.drafts.has(draftKey)) continue;
        next ??= new Map(state.drafts);
        next.delete(draftKey);
      }
      return next ? { drafts: next } : state;
    }),

  reset: () => set({ drafts: new Map() }),
}));

/**
 * Key builders shared by the cards and by the stores that clear drafts on
 * resolution. Namespaced so ids from different agents can never collide.
 */
function scopedDraftKey(
  provider: string,
  sessionId: string,
  requestId: string,
): string {
  return `${provider}:${encodeURIComponent(sessionId)}:${encodeURIComponent(requestId)}`;
}

export const claudeQuestionDraftKey = (sessionId: string, requestId: string) =>
  scopedDraftKey("claude-question", sessionId, requestId);
export const claudePlanApprovalDraftKey = (sessionId: string, requestId: string) =>
  scopedDraftKey("claude-plan-approval", sessionId, requestId);
export const openCodeQuestionDraftKey = (sessionId: string, requestId: string) =>
  scopedDraftKey("opencode-question", sessionId, requestId);
export const codexInteractionDraftKey = (sessionKey: string, interactionId: string) =>
  scopedDraftKey("codex-interaction", sessionKey, interactionId);
export const tmuxQuestionDraftKey = (sessionKey: string, eventId: string) =>
  scopedDraftKey("tmux-question", sessionKey, eventId);
export const tmuxPlanDraftKey = (sessionKey: string, eventId: string) =>
  scopedDraftKey("tmux-plan", sessionKey, eventId);
export const tmuxElicitationDraftKey = (sessionKey: string, eventId: string) =>
  scopedDraftKey("tmux-elicitation", sessionKey, eventId);

/**
 * `useState` drop-in whose value survives unmount by living in the draft
 * store under `draftKey`/`field`. With an `undefined` key it degrades to
 * plain component state, for callers rendering a card that is not backed by a
 * durable pending request (e.g. the tmux TUI selection prompt, whose identity
 * is derived from screen content).
 *
 * Draft values are never `undefined`: an unset field falls back to the
 * initial value, so storing `undefined` would read back as "unset".
 */
export function usePromptDraftField<T>(
  draftKey: string | undefined,
  field: string,
  initial: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  type FieldIdentity = {
    draftKey: string | undefined;
    field: string;
    value: T;
  };

  // Keep one initializer result per key/field identity. Components can be
  // reused in-place for a different authoritative request, so carrying the old
  // identity's fallback into the new request would leak its initial answer or
  // navigation index.
  const identityRef = useRef<FieldIdentity | null>(null);
  if (
    identityRef.current === null
    || identityRef.current.draftKey !== draftKey
    || identityRef.current.field !== field
  ) {
    identityRef.current = { draftKey, field, value: initial() };
  }
  const fallbackValue = identityRef.current.value;
  const [localField, setLocalField] = useState<FieldIdentity>(() => ({
    draftKey,
    field,
    value: fallbackValue,
  }));

  const stored = usePromptDraftStore((state) =>
    draftKey === undefined ? undefined : state.drafts.get(draftKey)?.[field],
  );

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (draftKey === undefined) {
        setLocalField((previousField) => {
          const previous = previousField.draftKey === draftKey
            && previousField.field === field
            ? previousField.value
            : identityRef.current!.value;
          const value = typeof action === "function"
            ? (action as (prev: T) => T)(previous)
            : action;
          return { draftKey, field, value };
        });
        return;
      }
      const store = usePromptDraftStore.getState();
      const current = store.drafts.get(draftKey)?.[field];
      const previous =
        current === undefined ? identityRef.current!.value : (current as T);
      const next =
        typeof action === "function"
          ? (action as (prev: T) => T)(previous)
          : action;
      store.setDraftValue(draftKey, field, next);
    },
    [draftKey, field],
  );

  if (draftKey === undefined) {
    return [
      localField.draftKey === draftKey && localField.field === field
        ? localField.value
        : fallbackValue,
      setValue,
    ];
  }
  return [stored === undefined ? fallbackValue : (stored as T), setValue];
}
