import { create } from "zustand";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";
import type { FileMention } from "@/types";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";

export interface NativeComposeDraft {
  text: string;
  mentions: FileMention[];
  attachments: WorkspaceAttachment[];
  platform?: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  /** Stable while one prompt may be between rename and provider acknowledgement. */
  requestId?: string;
  fastMode: boolean;
  mode: AgentConversationMode;
  executionProfileId?: "build" | "plan";
}

const EMPTY_DRAFT: NativeComposeDraft = {
  text: "",
  mentions: [],
  attachments: [],
  fastMode: false,
  mode: "build",
};

interface NativeComposeState {
  drafts: Map<string, NativeComposeDraft>;
  updateDraft: (sessionKey: string, update: Partial<NativeComposeDraft>) => void;
  clearDraft: (sessionKey: string) => void;
}

interface NativeComposePersistenceState {
  draftText: Map<string, string>;
  draftMentions: Map<string, FileMention[]>;
  attachments: Map<string, WorkspaceAttachment[]>;
  setDraftText: (sessionKey: string, text: string) => void;
  setDraftMentions: (sessionKey: string, mentions: FileMention[]) => void;
  clearAttachments: (sessionKey: string) => void;
  addAttachment: (sessionKey: string, attachment: WorkspaceAttachment) => void;
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

function persistedDraftMetadata(draft: NativeComposeDraft): Readonly<Record<string, unknown>> {
  const cached = DRAFT_METADATA_CACHE.get(draft);
  if (cached) return cached;
  const metadata = Object.freeze({
    ...(draft.platform ? { platform: draft.platform } : {}),
    ...(draft.modelId ? { modelId: draft.modelId } : {}),
    ...(draft.reasoningId ? { reasoningId: draft.reasoningId } : {}),
    ...(draft.requestId ? { requestId: draft.requestId } : {}),
    fastMode: draft.fastMode,
    mode: draft.mode,
    ...(draft.executionProfileId
      ? { executionProfileId: draft.executionProfileId }
      : {}),
  });
  DRAFT_METADATA_CACHE.set(draft, metadata);
  return metadata;
}

function restoreDraftMetadata(value: unknown): Partial<NativeComposeDraft> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const platform = typeof metadata.platform === "string"
    && VALID_AGENT_PLATFORMS.has(metadata.platform as AgentPlatform)
    ? metadata.platform as AgentPlatform
    : undefined;
  const modelId = typeof metadata.modelId === "string" && metadata.modelId.length <= 1_024
    ? metadata.modelId
    : undefined;
  const reasoningId = typeof metadata.reasoningId === "string" && metadata.reasoningId.length <= 256
    ? metadata.reasoningId
    : undefined;
  const requestId = typeof metadata.requestId === "string" && metadata.requestId.length <= 200
    ? metadata.requestId
    : undefined;
  const fastMode = typeof metadata.fastMode === "boolean" ? metadata.fastMode : undefined;
  const mode = metadata.mode === "build" || metadata.mode === "plan" ? metadata.mode : undefined;
  const executionProfileId = metadata.executionProfileId === "build"
    || metadata.executionProfileId === "plan"
    ? metadata.executionProfileId
    : undefined;
  if (
    !platform
    && !modelId
    && !reasoningId
    && fastMode === undefined
    && !mode
    && !executionProfileId
  ) return undefined;
  return {
    platform,
    modelId,
    reasoningId,
    requestId,
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
  updateDraft: (sessionKey, update) => set((state) => {
    const drafts = new Map(state.drafts);
    const existing = drafts.get(sessionKey);
    const contentChanged = update.text !== undefined
      || update.mentions !== undefined
      || update.attachments !== undefined;
    const next = { ...EMPTY_DRAFT, ...existing, ...update };
    if (contentChanged && update.requestId === undefined) delete next.requestId;
    drafts.set(sessionKey, next);
    return { drafts };
  }),
  clearDraft: (sessionKey) => set((state) => {
    if (!state.drafts.has(sessionKey)) return state;
    const drafts = new Map(state.drafts);
    drafts.delete(sessionKey);
    return { drafts };
  }),
}));

function persistenceState(state: NativeComposeState): NativeComposePersistenceState {
  return {
    draftText: new Map(
      [...state.drafts].map(([key, draft]) => [key, draft.text]),
    ),
    draftMentions: new Map(
      [...state.drafts].map(([key, draft]) => [key, draft.mentions]),
    ),
    attachments: new Map(
      [...state.drafts].map(([key, draft]) => [key, draft.attachments]),
    ),
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
  getState: () => persistenceState(useNativeComposeStore.getState()),
  subscribe: (
    listener: (
      state: NativeComposePersistenceState,
      previous: NativeComposePersistenceState,
    ) => void,
  ) => useNativeComposeStore.subscribe((state, previous) => {
    listener(persistenceState(state), persistenceState(previous));
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
      setDraftMetadata: (sessionKey: string, metadata: unknown) => {
        const restored = restoreDraftMetadata(metadata);
        if (restored) useNativeComposeStore.getState().updateDraft(sessionKey, restored);
      },
    };
  },
  subscribe: (
    listener: (
      state: NativeComposePersistenceState,
      previous: NativeComposePersistenceState,
    ) => void,
  ) => useNativeComposeStore.subscribe((state, previous) => {
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
