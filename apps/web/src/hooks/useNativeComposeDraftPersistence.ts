import { useEffect } from "react";
import {
  composeDraftKey,
  discardComposeDraft,
  loadComposeDraft,
  persistComposeDraft,
} from "@/lib/compose-draft-persistence";

interface NativeComposeDraftState<TMention, TAttachment> {
  draftText: Map<string, string>;
  draftMentions: Map<string, TMention[]>;
  attachments: Map<string, TAttachment[]>;
  setDraftText: (sessionKey: string, text: string) => void;
  setDraftMentions: (sessionKey: string, mentions: TMention[]) => void;
  clearAttachments: (sessionKey: string) => void;
  addAttachment: (sessionKey: string, attachment: TAttachment) => void;
}

interface NativeComposeDraftStore<TMention, TAttachment> {
  getState: () => NativeComposeDraftState<TMention, TAttachment>;
  subscribe: (
    listener: (
      state: NativeComposeDraftState<TMention, TAttachment>,
      previous: NativeComposeDraftState<TMention, TAttachment>,
    ) => void,
  ) => () => void;
}

interface PersistedNativeComposeDraft {
  text: string;
  mentions: unknown[];
  attachments: unknown[];
}

function readDraft<TMention, TAttachment>(
  state: NativeComposeDraftState<TMention, TAttachment>,
  sessionKey: string,
): PersistedNativeComposeDraft {
  return {
    text: state.draftText.get(sessionKey) ?? "",
    mentions: state.draftMentions.get(sessionKey) ?? [],
    attachments: state.attachments.get(sessionKey) ?? [],
  };
}

function isEmptyDraft(draft: PersistedNativeComposeDraft): boolean {
  return draft.text.length === 0
    && draft.mentions.length === 0
    && draft.attachments.length === 0;
}

/**
 * Mirrors one native chat composer to backend draft storage.
 *
 * Hydration never overwrites input typed while the snapshot request was in
 * flight. Writes are debounced and serialized by the shared persistence helper.
 */
export function useNativeComposeDraftPersistence<TMention, TAttachment>(
  namespace: "claude" | "codex" | "opencode",
  environmentId: string,
  sessionKey: string,
  store: NativeComposeDraftStore<TMention, TAttachment>,
): void {
  useEffect(() => {
    let disposed = false;
    let hydrated = false;
    let readSucceeded = false;
    let locallyChanged = false;
    let applyingHydration = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = composeDraftKey(namespace, environmentId, sessionKey);

    const persist = (
      state: NativeComposeDraftState<TMention, TAttachment>,
    ): Promise<void> => {
      const draft = readDraft(state, sessionKey);
      return isEmptyDraft(draft)
        ? discardComposeDraft(key)
        : persistComposeDraft(key, "environment", environmentId, draft);
    };

    const schedule = (state: NativeComposeDraftState<TMention, TAttachment>) => {
      if (!hydrated || disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void persist(state).catch((error) => {
          console.warn(`[${namespace}] Failed to persist compose draft:`, error);
        });
      }, 400);
    };

    const unsubscribe = store.subscribe((state, previous) => {
      const currentText = state.draftText.get(sessionKey) ?? "";
      const priorText = previous.draftText.get(sessionKey) ?? "";
      const currentMentions = state.draftMentions.get(sessionKey);
      const priorMentions = previous.draftMentions.get(sessionKey);
      const currentAttachments = state.attachments.get(sessionKey);
      const priorAttachments = previous.attachments.get(sessionKey);
      if (
        applyingHydration
        || (
          currentText === priorText
          && currentMentions === priorMentions
          && currentAttachments === priorAttachments
        )
      ) {
        return;
      }
      locallyChanged = true;
      if (!hydrated) hydrated = true;
      schedule(state);
    });

    void loadComposeDraft<PersistedNativeComposeDraft>(key)
      .then((persisted) => {
        readSucceeded = true;
        if (disposed || locallyChanged || !persisted) return;
        const state = store.getState();
        if (!isEmptyDraft(readDraft(state, sessionKey))) return;
        const value = persisted.value;
        if (
          !value
          || typeof value.text !== "string"
          || !Array.isArray(value.mentions)
          || !Array.isArray(value.attachments)
        ) {
          return;
        }
        applyingHydration = true;
        try {
          state.setDraftText(sessionKey, value.text);
          state.setDraftMentions(sessionKey, value.mentions as TMention[]);
          state.clearAttachments(sessionKey);
          for (const attachment of value.attachments) {
            state.addAttachment(sessionKey, attachment as TAttachment);
          }
        } finally {
          applyingHydration = false;
        }
      })
      .catch((error) => {
        console.warn(`[${namespace}] Failed to restore compose draft:`, error);
      })
      .finally(() => {
        if (readSucceeded || locallyChanged) {
          hydrated = true;
          if (!disposed) schedule(store.getState());
        }
      });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      // Store cleanup happens synchronously before a native tab unmounts. An
      // immediate flush therefore deletes closed-tab drafts, while visibility
      // unmounts preserve their latest non-empty value.
      if (hydrated || locallyChanged) {
        void persist(store.getState()).catch((error) => {
          console.warn(`[${namespace}] Failed to persist compose draft during cleanup:`, error);
        });
      }
    };
  }, [environmentId, namespace, sessionKey, store]);
}
