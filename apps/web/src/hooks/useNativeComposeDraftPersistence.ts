import { useEffect } from "react";
import { toast } from "sonner";
import {
  composeDraftKey,
  discardComposeDraft,
  DraftRevisionConflictError,
  loadComposeDraft,
  persistComposeDraft,
  resolveComposeDraftDiscardConflict,
  resolveComposeDraftSaveConflict,
} from "@/lib/compose-draft-persistence";

interface NativeComposeDraftState<TMention, TAttachment> {
  draftText: Map<string, string>;
  draftMentions: Map<string, TMention[]>;
  attachments: Map<string, TAttachment[]>;
  draftMetadata?: Map<string, unknown>;
  setDraftText: (sessionKey: string, text: string) => void;
  setDraftMentions: (sessionKey: string, mentions: TMention[]) => void;
  clearAttachments: (sessionKey: string) => void;
  addAttachment: (sessionKey: string, attachment: TAttachment) => void;
  setDraftMetadata?: (sessionKey: string, metadata: unknown) => void;
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
  metadata?: unknown;
}

type NativeDraftNamespace =
  | "claude"
  | "claude-tmux"
  | "codex"
  | "opencode"
  | "cursor"
  | "grok"
  | "agent-native";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedFileMention(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.filename === "string" &&
    typeof value.relativePath === "string"
  );
}

function isPersistedAttachment(namespace: NativeDraftNamespace, value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    (value.previewUrl !== undefined && typeof value.previewUrl !== "string")
  ) {
    return false;
  }
  if (namespace === "cursor" || namespace === "grok") return false;
  if (namespace === "codex") return value.type === "image";
  return value.type === "file" || value.type === "image";
}

/**
 * Resolve which provider's attachment rules a stored draft must satisfy.
 *
 * The shared `agent-native` record belongs to a tab that has not been assigned
 * yet, so its own namespace says nothing about what the selected agent accepts.
 * The persisted platform does, and restoring an attachment the agent refuses
 * would fail the next send rather than being dropped by the bridge.
 */
function effectiveAttachmentNamespace(
  namespace: NativeDraftNamespace,
  metadata: unknown,
): NativeDraftNamespace {
  if (namespace !== "agent-native") return namespace;
  const platform = isRecord(metadata) ? metadata.platform : undefined;
  return platform === "claude" ||
    platform === "codex" ||
    platform === "opencode" ||
    platform === "cursor" ||
    platform === "grok"
    ? platform
    : namespace;
}

function readDraft<TMention, TAttachment>(
  state: NativeComposeDraftState<TMention, TAttachment>,
  sessionKey: string,
): PersistedNativeComposeDraft {
  return {
    text: state.draftText.get(sessionKey) ?? "",
    mentions: state.draftMentions.get(sessionKey) ?? [],
    attachments: state.attachments.get(sessionKey) ?? [],
    ...(state.draftMetadata?.has(sessionKey)
      ? { metadata: state.draftMetadata.get(sessionKey) }
      : {}),
  };
}

function isEmptyDraft(draft: PersistedNativeComposeDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0 &&
    draft.metadata === undefined
  );
}

/**
 * Mirrors one native chat composer to backend draft storage.
 *
 * Hydration never overwrites input typed while the snapshot request was in
 * flight. Writes are debounced and serialized by the shared persistence helper.
 */
export function useNativeComposeDraftPersistence<TMention, TAttachment>(
  namespace: NativeDraftNamespace,
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

    const reportPersistenceError = (error: unknown): void => {
      if (!(error instanceof DraftRevisionConflictError)) {
        console.warn(`[${namespace}] Failed to persist compose draft:`, error);
        return;
      }
      const discarding = isEmptyDraft(readDraft(store.getState(), sessionKey));
      toast.error("Draft changed in another window", {
        id: `compose-draft-conflict:${key}`,
        description: discarding
          ? "A newer saved draft was preserved. Discard it explicitly to finish closing this input."
          : "Your input is still here. Choose Save mine to replace the other saved draft.",
        action: {
          label: discarding ? "Discard saved draft" : "Save mine",
          onClick: () => {
            const current = readDraft(store.getState(), sessionKey);
            const operation = isEmptyDraft(current)
              ? resolveComposeDraftDiscardConflict(key)
              : resolveComposeDraftSaveConflict(key, "environment", environmentId, current);
            void operation.catch(reportPersistenceError);
          },
        },
      });
    };

    const persist = (state: NativeComposeDraftState<TMention, TAttachment>): Promise<void> => {
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
          reportPersistenceError(error);
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
      const currentMetadata = state.draftMetadata?.get(sessionKey);
      const priorMetadata = previous.draftMetadata?.get(sessionKey);
      if (
        applyingHydration ||
        (currentText === priorText &&
          currentMentions === priorMentions &&
          currentAttachments === priorAttachments &&
          currentMetadata === priorMetadata)
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
          !value ||
          typeof value.text !== "string" ||
          !Array.isArray(value.mentions) ||
          !Array.isArray(value.attachments)
        ) {
          return;
        }
        const mentions = value.mentions.filter(isPersistedFileMention);
        const attachmentNamespace = effectiveAttachmentNamespace(namespace, value.metadata);
        const attachments = value.attachments.filter((attachment) =>
          isPersistedAttachment(attachmentNamespace, attachment),
        );
        applyingHydration = true;
        try {
          state.setDraftText(sessionKey, value.text);
          state.setDraftMentions(sessionKey, mentions as TMention[]);
          state.clearAttachments(sessionKey);
          for (const attachment of attachments) {
            state.addAttachment(sessionKey, attachment as TAttachment);
          }
          if (value.metadata !== undefined) {
            state.setDraftMetadata?.(sessionKey, value.metadata);
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
          reportPersistenceError(error);
        });
      }
    };
  }, [environmentId, namespace, sessionKey, store]);
}
