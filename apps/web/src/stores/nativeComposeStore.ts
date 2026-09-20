import { create } from "zustand";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";
import type { FileMention } from "@/types";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import { getEnvironmentIdFromSessionKey } from "@/lib/utils";

export interface NativeComposeDraft {
  text: string;
  mentions: FileMention[];
  attachments: WorkspaceAttachment[];
  annotations: TranscriptAnnotation[];
  platform?: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  /** Stable while one prompt may be between rename and provider acknowledgement. */
  requestId?: string;
  /** In-flight first submission survives tab unmount; never persisted across a restart. */
  submissionPending?: boolean;
  submissionError?: string;
  /**
   * Renderer correlation for a dispatch whose acknowledgement may be lost.
   *
   * This belongs with the draft instead of a mounted tab: environments can
   * unmount while their provider keeps running, and the next mount still has
   * to recognize the authoritative transcript row that owns this draft.
   */
  pendingTranscriptConfirmation?: {
    requestId: string;
    sessionId: string;
    priorMessageIds: readonly string[];
  };
  fastMode: boolean;
  mode: AgentConversationMode;
  /**
   * Provider primary-agent name, so it is not a closed set: OpenCode users can
   * rename or add agents. Bounded like the other free-form ids rather than
   * narrowed to the two the launcher offers by default.
   */
  executionProfileId?: string;
}

const EMPTY_DRAFT: NativeComposeDraft = {
  text: "",
  mentions: [],
  attachments: [],
  annotations: [],
  fastMode: false,
  mode: "build",
};

interface NativeComposeState {
  drafts: Map<string, NativeComposeDraft>;
  updateDraft: (sessionKey: string, update: Partial<NativeComposeDraft>) => void;
  clearDraft: (sessionKey: string) => void;
  consumeBrowserAnnotations: (environmentId: string, annotationIds: readonly string[]) => void;
}

interface NativeComposePersistenceState {
  draftText: Map<string, string>;
  draftMentions: Map<string, FileMention[]>;
  attachments: Map<string, WorkspaceAttachment[]>;
  annotations?: Map<string, TranscriptAnnotation[]>;
  setDraftText: (sessionKey: string, text: string) => void;
  setDraftMentions: (sessionKey: string, mentions: FileMention[]) => void;
  clearAttachments: (sessionKey: string) => void;
  addAttachment: (sessionKey: string, attachment: WorkspaceAttachment) => void;
  setAnnotations?: (sessionKey: string, annotations: TranscriptAnnotation[]) => void;
  draftMetadata?: Map<string, unknown>;
  setDraftMetadata?: (sessionKey: string, metadata: unknown) => void;
}

const VALID_AGENT_PLATFORMS = new Set<AgentPlatform>([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "grok",
]);

const DRAFT_METADATA_CACHE = new WeakMap<NativeComposeDraft, Readonly<Record<string, unknown>>>();

function restorePendingTranscriptConfirmation(
  value: unknown,
): NativeComposeDraft["pendingTranscriptConfirmation"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    record.requestId.length > 200
  ) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length > 200) return undefined;
  if (
    !Array.isArray(record.priorMessageIds) ||
    record.priorMessageIds.some((id) => typeof id !== "string" || id.length > 200)
  ) {
    return undefined;
  }
  return {
    requestId: record.requestId,
    sessionId: record.sessionId,
    priorMessageIds: record.priorMessageIds as string[],
  };
}

function persistedDraftMetadata(draft: NativeComposeDraft): Readonly<Record<string, unknown>> {
  const cached = DRAFT_METADATA_CACHE.get(draft);
  if (cached) return cached;
  const metadata = Object.freeze({
    ...(draft.platform ? { platform: draft.platform } : {}),
    ...(draft.modelId ? { modelId: draft.modelId } : {}),
    ...(draft.reasoningId ? { reasoningId: draft.reasoningId } : {}),
    ...(draft.requestId ? { requestId: draft.requestId } : {}),
    ...(draft.pendingTranscriptConfirmation
      ? { pendingTranscriptConfirmation: draft.pendingTranscriptConfirmation }
      : {}),
    fastMode: draft.fastMode,
    mode: draft.mode,
    ...(draft.executionProfileId ? { executionProfileId: draft.executionProfileId } : {}),
  });
  DRAFT_METADATA_CACHE.set(draft, metadata);
  return metadata;
}

function hasPersistableDraftMetadata(draft: NativeComposeDraft): boolean {
  return Boolean(
    draft.platform ||
    draft.modelId ||
    draft.reasoningId ||
    draft.requestId ||
    draft.pendingTranscriptConfirmation ||
    draft.executionProfileId,
  );
}

export interface NativeComposeDraftPersistValue {
  text: string;
  mentions: FileMention[];
  attachments: WorkspaceAttachment[];
  annotations: TranscriptAnnotation[];
  metadata: Readonly<Record<string, unknown>>;
}

export function nativeComposeDraftPersistValue(
  draft: NativeComposeDraft,
): NativeComposeDraftPersistValue {
  return {
    text: draft.text,
    mentions: draft.mentions,
    attachments: draft.attachments,
    annotations: draft.annotations,
    metadata: persistedDraftMetadata(draft),
  };
}

function restoreDraftMetadata(value: unknown): Partial<NativeComposeDraft> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const platform =
    typeof metadata.platform === "string" &&
    VALID_AGENT_PLATFORMS.has(metadata.platform as AgentPlatform)
      ? (metadata.platform as AgentPlatform)
      : undefined;
  const modelId =
    typeof metadata.modelId === "string" && metadata.modelId.length <= 1_024
      ? metadata.modelId
      : undefined;
  const reasoningId =
    typeof metadata.reasoningId === "string" && metadata.reasoningId.length <= 256
      ? metadata.reasoningId
      : undefined;
  const requestId =
    typeof metadata.requestId === "string" && metadata.requestId.length <= 200
      ? metadata.requestId
      : undefined;
  const fastMode = typeof metadata.fastMode === "boolean" ? metadata.fastMode : undefined;
  const mode = metadata.mode === "build" || metadata.mode === "plan" ? metadata.mode : undefined;
  const executionProfileId =
    typeof metadata.executionProfileId === "string" &&
    metadata.executionProfileId.trim().length > 0 &&
    metadata.executionProfileId.length <= 256
      ? metadata.executionProfileId
      : undefined;
  const pendingTranscriptConfirmation = restorePendingTranscriptConfirmation(
    metadata.pendingTranscriptConfirmation,
  );
  if (
    !platform &&
    !modelId &&
    !reasoningId &&
    !requestId &&
    !pendingTranscriptConfirmation &&
    fastMode === undefined &&
    !mode &&
    !executionProfileId
  )
    return undefined;
  return {
    platform,
    modelId,
    reasoningId,
    requestId,
    ...(pendingTranscriptConfirmation ? { pendingTranscriptConfirmation } : {}),
    fastMode,
    mode,
    executionProfileId,
  };
}

export function nativeComposeDraft(
  state: NativeComposeState,
  sessionKey: string,
): NativeComposeDraft {
  return state.drafts.get(sessionKey) ?? EMPTY_DRAFT;
}

export const useNativeComposeStore = create<NativeComposeState>()((set) => ({
  drafts: new Map(),
  updateDraft: (sessionKey, update) =>
    set((state) => {
      const drafts = new Map(state.drafts);
      const existing = drafts.get(sessionKey);
      const contentChanged =
        update.text !== undefined ||
        update.mentions !== undefined ||
        update.attachments !== undefined;
      const annotationContentChanged = update.annotations !== undefined;
      const next = { ...EMPTY_DRAFT, ...existing, ...update };
      // Content edits drop dispatch ownership so a late transcript echo cannot
      // delete the next prompt. An in-flight first submission is the exception:
      // clearing requestId there strands settlement and leaves submissionPending
      // stuck after the backend answers.
      if (
        (contentChanged || annotationContentChanged) &&
        update.requestId === undefined &&
        !next.submissionPending
      ) {
        delete next.requestId;
        delete next.pendingTranscriptConfirmation;
      }
      drafts.set(sessionKey, next);
      return { drafts };
    }),
  clearDraft: (sessionKey) =>
    set((state) => {
      if (!state.drafts.has(sessionKey)) return state;
      const drafts = new Map(state.drafts);
      drafts.delete(sessionKey);
      return { drafts };
    }),
  consumeBrowserAnnotations: (environmentId, annotationIds) =>
    set((state) => {
      if (annotationIds.length === 0) return state;
      const ids = new Set(annotationIds);
      let changed = false;
      const drafts = new Map(state.drafts);
      for (const [sessionKey, draft] of Array.from(drafts)) {
        if (getEnvironmentIdFromSessionKey(sessionKey) !== environmentId) continue;
        const annotations = draft.annotations.filter(
          (annotation) => annotation.source !== "browser" || !ids.has(annotation.id),
        );
        const attachments = draft.attachments.filter(
          (attachment) => !attachment.annotationId || !ids.has(attachment.annotationId),
        );
        if (
          annotations.length === draft.annotations.length &&
          attachments.length === draft.attachments.length
        ) {
          continue;
        }
        changed = true;
        drafts.set(sessionKey, { ...draft, annotations, attachments });
      }
      return changed ? { drafts } : state;
    }),
}));

function applyRestoredDraftMetadata(sessionKey: string, metadata: unknown): void {
  const restored = restoreDraftMetadata(metadata);
  if (restored) useNativeComposeStore.getState().updateDraft(sessionKey, restored);
}

function persistableDraftMetadataMap(state: NativeComposeState): Map<string, unknown> {
  return new Map(
    [...state.drafts]
      .filter(([, draft]) => hasPersistableDraftMetadata(draft))
      .map(([key, draft]) => [key, persistedDraftMetadata(draft)]),
  );
}

function persistenceState(state: NativeComposeState): NativeComposePersistenceState {
  return {
    draftText: new Map([...state.drafts].map(([key, draft]) => [key, draft.text])),
    draftMentions: new Map([...state.drafts].map(([key, draft]) => [key, draft.mentions])),
    attachments: new Map([...state.drafts].map(([key, draft]) => [key, draft.attachments])),
    annotations: new Map([...state.drafts].map(([key, draft]) => [key, draft.annotations])),
    setDraftText: (sessionKey, text) =>
      useNativeComposeStore.getState().updateDraft(sessionKey, { text }),
    setDraftMentions: (sessionKey, mentions) =>
      useNativeComposeStore.getState().updateDraft(sessionKey, { mentions }),
    clearAttachments: (sessionKey) =>
      useNativeComposeStore.getState().updateDraft(sessionKey, { attachments: [] }),
    addAttachment: (sessionKey, attachment) => {
      const current = nativeComposeDraft(useNativeComposeStore.getState(), sessionKey);
      useNativeComposeStore.getState().updateDraft(sessionKey, {
        attachments: [...current.attachments, attachment],
      });
    },
    setAnnotations: (sessionKey, annotations) =>
      useNativeComposeStore.getState().updateDraft(sessionKey, { annotations }),
  };
}

function lockedPersistenceState(state: NativeComposeState): NativeComposePersistenceState {
  return {
    ...persistenceState(state),
    draftMetadata: persistableDraftMetadataMap(state),
    setDraftMetadata: applyRestoredDraftMetadata,
  };
}

/**
 * Compatibility surface for the existing backend-backed compose-draft hook.
 *
 * The consolidated store deliberately keeps all draft fields in one record so
 * provider lock-in is atomic. The persistence hook predates that store and
 * consumes field maps; this adapter exposes those maps without creating a
 * second source of truth.
 */
export const nativeComposePersistenceStore = {
  getState: () => lockedPersistenceState(useNativeComposeStore.getState()),
  subscribe: (
    listener: (
      state: NativeComposePersistenceState,
      previous: NativeComposePersistenceState,
    ) => void,
  ) =>
    useNativeComposeStore.subscribe((state, previous) => {
      listener(lockedPersistenceState(state), lockedPersistenceState(previous));
    }),
};

/**
 * Stable persistence for a provider-neutral tab before its first send locks
 * the pane. Provider choice and composer options live alongside the draft so a
 * reload cannot accidentally look under the default provider's namespace.
 */
export const unassignedNativeComposePersistenceStore = {
  getState: (): NativeComposePersistenceState => {
    const state = useNativeComposeStore.getState();
    return {
      ...persistenceState(state),
      draftMetadata: new Map(
        [...state.drafts].map(([key, draft]) => [key, persistedDraftMetadata(draft)]),
      ),
      setDraftMetadata: applyRestoredDraftMetadata,
    };
  },
  subscribe: (
    listener: (
      state: NativeComposePersistenceState,
      previous: NativeComposePersistenceState,
    ) => void,
  ) =>
    useNativeComposeStore.subscribe((state, previous) => {
      listener(
        {
          ...persistenceState(state),
          draftMetadata: new Map(
            [...state.drafts].map(([key, draft]) => [key, persistedDraftMetadata(draft)]),
          ),
          setDraftMetadata: (sessionKey, metadata) => {
            const restored = restoreDraftMetadata(metadata);
            if (restored) useNativeComposeStore.getState().updateDraft(sessionKey, restored);
          },
        },
        {
          ...persistenceState(previous),
          draftMetadata: new Map(
            [...previous.drafts].map(([key, draft]) => [key, persistedDraftMetadata(draft)]),
          ),
          setDraftMetadata: (sessionKey, metadata) => {
            const restored = restoreDraftMetadata(metadata);
            if (restored) useNativeComposeStore.getState().updateDraft(sessionKey, restored);
          },
        },
      );
    }),
};
