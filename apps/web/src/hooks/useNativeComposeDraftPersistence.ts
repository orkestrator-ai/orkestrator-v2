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
import {
  isTranscriptAnnotation,
  MAX_TRANSCRIPT_ANNOTATIONS,
  normalizeTranscriptAnnotationComment,
  type TranscriptAnnotation,
} from "@/lib/chat/transcript-annotations";
import type { WebAnnotationMigratedReference } from "@orkestrator/protocol/web-annotations";
import { getComposeDraft } from "@/lib/backend";
import { describeWebAnnotationError, webAnnotationErrorDetail } from "@/lib/web-annotations/client";
import {
  applyMigratedReferences,
  hasUnmigratedBrowserNotes,
  reconcileComposeDraftValue,
  savedMigrationReferences,
} from "@/lib/web-annotations/compose-migration";

interface NativeComposeDraftState<TMention, TAttachment> {
  draftText: Map<string, string>;
  draftMentions: Map<string, TMention[]>;
  attachments: Map<string, TAttachment[]>;
  annotations?: Map<string, TranscriptAnnotation[]>;
  draftMetadata?: Map<string, unknown>;
  setDraftText: (sessionKey: string, text: string) => void;
  setDraftMentions: (sessionKey: string, mentions: TMention[]) => void;
  clearAttachments: (sessionKey: string) => void;
  addAttachment: (sessionKey: string, attachment: TAttachment) => void;
  setAnnotations?: (sessionKey: string, annotations: TranscriptAnnotation[]) => void;
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
  annotations?: unknown[];
  metadata?: unknown;
}

type NativeDraftNamespace =
  | "claude"
  | "claude-tmux"
  | "codex"
  | "opencode"
  | "cursor"
  | "grok"
  | "pi"
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
    (value.previewUrl !== undefined && typeof value.previewUrl !== "string") ||
    (value.annotationId !== undefined && typeof value.annotationId !== "string")
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
    platform === "grok" ||
    platform === "pi"
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
    ...(state.annotations?.has(sessionKey)
      ? { annotations: state.annotations.get(sessionKey) ?? [] }
      : {}),
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
    (draft.annotations?.length ?? 0) === 0 &&
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
  fallbackNamespace?: NativeDraftNamespace,
): void {
  useEffect(() => {
    let disposed = false;
    let hydrated = false;
    let readSucceeded = false;
    let locallyChanged = false;
    let applyingHydration = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = composeDraftKey(namespace, environmentId, sessionKey);
    const fallbackKey = fallbackNamespace
      ? composeDraftKey(fallbackNamespace, environmentId, sessionKey)
      : undefined;

    const reportPersistenceError = (error: unknown): void => {
      if (!(error instanceof DraftRevisionConflictError)) {
        const typed = webAnnotationErrorDetail(error).detail;
        if (typed?.code === "upgrade-required" || typed?.code === "conflict") {
          // An older copy of a migrated browser note: reconcile, then retry
          // once. The user's text is never dropped.
          void reconcile()
            .then(() => persist(store.getState()))
            .catch((retryError) => {
              toast.error("Draft not saved", {
                id: `compose-draft-migration:${key}`,
                description: describeWebAnnotationError(retryError),
              });
            });
          return;
        }
        console.warn(`[${namespace}] Failed to persist compose draft:`, error);
        return;
      }
      const draftAnnotations = readDraft(store.getState(), sessionKey).annotations;
      if (!hasUnmigratedBrowserNotes(draftAnnotations as TranscriptAnnotation[] | undefined)) {
        showConflictToast();
        return;
      }
      void resolveMigrationConflict()
        .catch(() => false)
        .then((resolved) => {
          if (!resolved) showConflictToast();
        });
    };

    const showConflictToast = (): void => {
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

    /** Replace legacy browser notes the backend now holds in threads (in memory only). */
    const applyReferences = (references: WebAnnotationMigratedReference[]): void => {
      if (references.length === 0 || disposed) return;
      const state = store.getState();
      if (!state.setAnnotations) return;
      const attachments = (state.attachments.get(sessionKey) ?? []) as Array<
        TAttachment & { annotationId?: string }
      >;
      const next = applyMigratedReferences(
        state.annotations?.get(sessionKey) ?? [],
        attachments,
        references,
      );
      if (!next) return;
      state.setAnnotations(sessionKey, next.annotations);
      if (next.attachments.length !== attachments.length) {
        state.clearAttachments(sessionKey);
        for (const attachment of next.attachments) state.addAttachment(sessionKey, attachment);
      }
    };

    /**
     * A dirty in-memory draft holding legacy browser notes goes through the
     * backend's idempotent import, keeping the user's text; the next save
     * then persists lightweight references instead of fanning notes out.
     */
    let reconciling: Promise<void> | null = null;
    const reconcile = (): Promise<void> => {
      if (reconciling) return reconciling;
      const draft = readDraft(store.getState(), sessionKey);
      if (!hasUnmigratedBrowserNotes(draft.annotations as TranscriptAnnotation[] | undefined)) {
        return Promise.resolve();
      }
      reconciling = reconcileComposeDraftValue(environmentId, { ...draft })
        .then((result) => {
          if (result) applyReferences(result.references);
        })
        .finally(() => {
          reconciling = null;
        });
      return reconciling;
    };

    const persist = (state: NativeComposeDraftState<TMention, TAttachment>): Promise<void> => {
      const draft = readDraft(state, sessionKey);
      return isEmptyDraft(draft)
        ? discardComposeDraft(key)
        : persistComposeDraft(key, "environment", environmentId, draft).then((saved) => {
            applyReferences(savedMigrationReferences(saved));
          });
    };

    /**
     * A conflict caused only by server-side migration (the persisted draft
     * lost its legacy notes, nothing else changed) is saved through the
     * normal conflict path after reconciling; anything else asks the user.
     */
    const resolveMigrationConflict = async (): Promise<boolean> => {
      if (
        !hasUnmigratedBrowserNotes(
          readDraft(store.getState(), sessionKey).annotations as TranscriptAnnotation[] | undefined,
        )
      ) {
        return false;
      }
      await reconcile();
      const current = readDraft(store.getState(), sessionKey);
      const server = await loadServerValue();
      if (!server || server.text !== current.text) return false;
      if (hasUnmigratedBrowserNotes(server.annotations as TranscriptAnnotation[] | undefined)) {
        return false;
      }
      await resolveComposeDraftSaveConflict(key, "environment", environmentId, current);
      return true;
    };
    const loadServerValue = async (): Promise<PersistedNativeComposeDraft | null> => {
      try {
        const persisted = await getComposeDraft<PersistedNativeComposeDraft>(key);
        return persisted?.value ?? null;
      } catch {
        return null;
      }
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
      const currentAnnotations = state.annotations?.get(sessionKey);
      const priorAnnotations = previous.annotations?.get(sessionKey);
      const currentMetadata = state.draftMetadata?.get(sessionKey);
      const priorMetadata = previous.draftMetadata?.get(sessionKey);
      if (
        applyingHydration ||
        (currentText === priorText &&
          currentMentions === priorMentions &&
          currentAttachments === priorAttachments &&
          currentAnnotations === priorAnnotations &&
          currentMetadata === priorMetadata)
      ) {
        return;
      }
      locallyChanged = true;
      if (!hydrated) hydrated = true;
      schedule(state);
    });

    void loadComposeDraft<PersistedNativeComposeDraft>(key)
      .then(async (primary) => {
        let persisted = primary;
        if (!persisted && fallbackKey) {
          persisted = await loadComposeDraft<PersistedNativeComposeDraft>(fallbackKey);
        }
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
        const annotations = Array.isArray(value.annotations)
          ? value.annotations
              .filter(isTranscriptAnnotation)
              .slice(0, MAX_TRANSCRIPT_ANNOTATIONS)
              .map((annotation) => ({
                ...annotation,
                comment: normalizeTranscriptAnnotationComment(annotation.comment),
              }))
          : [];
        applyingHydration = true;
        try {
          state.setDraftText(sessionKey, value.text);
          state.setDraftMentions(sessionKey, mentions as TMention[]);
          state.clearAttachments(sessionKey);
          for (const attachment of attachments) {
            state.addAttachment(sessionKey, attachment as TAttachment);
          }
          state.setAnnotations?.(sessionKey, annotations);
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
          // Persistence resumed with a draft that may still hold legacy
          // browser notes typed before migration: reconcile them in memory.
          if (!disposed) void reconcile().catch(() => undefined);
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
  }, [environmentId, fallbackNamespace, namespace, sessionKey, store]);
}
