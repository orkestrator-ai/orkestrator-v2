import { useEffect } from "react";
import { getComposeDraft } from "@/lib/backend";
import {
  composeDraftKey,
  discardComposeDraft,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = composeDraftKey(namespace, environmentId, sessionKey);

    const schedule = (state: NativeComposeDraftState<TMention, TAttachment>) => {
      if (!hydrated || disposed) return;
      if (timer) clearTimeout(timer);
      const draft = readDraft(state, sessionKey);
      timer = setTimeout(() => {
        const operation = isEmptyDraft(draft)
          ? discardComposeDraft(key)
          : persistComposeDraft(key, "environment", environmentId, draft);
        void operation.catch((error) => {
          console.warn(`[${namespace}] Failed to persist compose draft:`, error);
        });
      }, 400);
    };

    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.draftText === previous.draftText
        && state.draftMentions === previous.draftMentions
        && state.attachments === previous.attachments
      ) {
        return;
      }
      schedule(state);
    });

    void getComposeDraft<PersistedNativeComposeDraft>(key)
      .then((persisted) => {
        if (disposed || !persisted) return;
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
        state.setDraftText(sessionKey, value.text);
        state.setDraftMentions(sessionKey, value.mentions as TMention[]);
        state.clearAttachments(sessionKey);
        for (const attachment of value.attachments) {
          state.addAttachment(sessionKey, attachment as TAttachment);
        }
      })
      .catch((error) => {
        console.warn(`[${namespace}] Failed to restore compose draft:`, error);
      })
      .finally(() => {
        hydrated = true;
        if (!disposed) schedule(store.getState());
      });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [environmentId, namespace, sessionKey, store]);
}
