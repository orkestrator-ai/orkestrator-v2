import { create } from "zustand";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";
import { parseNativeAgentCommandIntent } from "@orkestrator/protocol/agent-command-catalogue";
import { parseCommandToken } from "@orkestrator/protocol/agent-slash-commands";
import type { FileMention } from "@/types";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import { getEnvironmentIdFromSessionKey } from "@/lib/utils";

/**
 * The command a user picked from the `/` menu for this draft.
 *
 * Identity, not a hint: while the leading token is exactly the one inserted,
 * the draft executes this descriptor (argument edits keep it). Editing the
 * token, choosing literal text, or a provider/session change drops it. Only
 * opaque lookup keys are stored, never a binding.
 */
export interface NativeCommandSelection {
  commandId: string;
  bindingRevision?: string;
  /** The leading token exactly as inserted, sigil included. */
  token: string;
  platform?: AgentPlatform;
  /** Provider session the selection was made against, when one was known. */
  sessionId?: string;
}

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
  commandSelection?: NativeCommandSelection;
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
  "pi",
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

const COMMAND_TOKEN_SIGILS = ["/", "$"] as const;
const MAX_COMMAND_TOKEN_LENGTH = 256;

/** True while `text` still leads with exactly the token that was selected. */
export function commandSelectionMatchesText(
  selection: NativeCommandSelection,
  text: string,
): boolean {
  return parseCommandToken(text, [...COMMAND_TOKEN_SIGILS])?.token === selection.token;
}

function restoreCommandSelection(value: unknown): NativeCommandSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const intent = parseNativeAgentCommandIntent({
    kind: "selected",
    commandId: record.commandId,
    ...(record.bindingRevision === undefined ? {} : { bindingRevision: record.bindingRevision }),
  });
  if (intent?.kind !== "selected") return undefined;
  const token = record.token;
  if (
    typeof token !== "string" ||
    token.length < 2 ||
    token.length > MAX_COMMAND_TOKEN_LENGTH ||
    /\s/.test(token) ||
    !COMMAND_TOKEN_SIGILS.includes(token[0] as "/" | "$")
  ) {
    return undefined;
  }
  const platform =
    typeof record.platform === "string" &&
    VALID_AGENT_PLATFORMS.has(record.platform as AgentPlatform)
      ? (record.platform as AgentPlatform)
      : undefined;
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.length <= 200
      ? record.sessionId
      : undefined;
  return {
    commandId: intent.commandId,
    ...(intent.bindingRevision ? { bindingRevision: intent.bindingRevision } : {}),
    token,
    ...(platform ? { platform } : {}),
    ...(sessionId ? { sessionId } : {}),
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
    ...(draft.commandSelection ? { commandSelection: draft.commandSelection } : {}),
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
    draft.executionProfileId ||
    draft.commandSelection,
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
  const commandSelection = restoreCommandSelection(metadata.commandSelection);
  if (
    !platform &&
    !modelId &&
    !reasoningId &&
    !requestId &&
    !pendingTranscriptConfirmation &&
    fastMode === undefined &&
    !mode &&
    !executionProfileId &&
    !commandSelection
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
    ...(commandSelection ? { commandSelection } : {}),
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
      // A selection lasts exactly as long as its token: argument edits keep
      // it, any edit to the token itself makes the text a different command.
      if (
        update.text !== undefined &&
        !("commandSelection" in update) &&
        next.commandSelection &&
        !commandSelectionMatchesText(next.commandSelection, next.text)
      ) {
        delete next.commandSelection;
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
        // Only genuinely unmigrated legacy copies are consumed. A note the
        // backend imported into a durable thread (`migratedTo`) and anything
        // it owns stay put; new web annotations never enter drafts at all.
        const consumed = new Set(
          draft.annotations
            .filter(
              (annotation) =>
                annotation.source === "browser" && !annotation.migratedTo && ids.has(annotation.id),
            )
            .map((annotation) => annotation.id),
        );
        if (consumed.size === 0) continue;
        const annotations = draft.annotations.filter(
          (annotation) => annotation.source !== "browser" || !consumed.has(annotation.id),
        );
        const attachments = draft.attachments.filter(
          (attachment) => !attachment.annotationId || !consumed.has(attachment.annotationId),
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
