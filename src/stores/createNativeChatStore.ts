import type { StateCreator } from "zustand";
import {
  reconcileTimedSession,
  updateTimedSessionLoading,
} from "@/lib/session-timer";
import type { FileMention } from "@/types";

/**
 * Shared server status shape across the native chat stores (Claude, Codex,
 * OpenCode). All three agents expose the same pair of fields.
 */
export interface NativeServerStatus {
  running: boolean;
  hostPort: number | null;
}

/**
 * Shared session state shape. Each agent's message type plugs into `TMessage`.
 * `title` is optional because OpenCode does not populate it; Claude/Codex do.
 */
export interface NativeSessionState<TMessage> {
  sessionId: string;
  messages: TMessage[];
  isLoading: boolean;
  loadingStartedAt?: number;
  lastCompletedElapsedSeconds?: number | null;
  error?: string;
  title?: string;
}

/**
 * Merge strategy for `setMessages`. Claude uses a simple timestamp-based
 * merge; Codex/OpenCode use `mergeNativeMessagesPreservingClientOnly`. When
 * not provided, incoming messages fully replace existing ones.
 */
type MergeMessages<TMessage> = (
  existing: TMessage[],
  incoming: TMessage[],
) => TMessage[];

/**
 * Shape of the slice returned by `createNativeChatStoreSlice`. Agent-specific
 * stores extend this with extra maps and actions (effort, plan mode, pending
 * questions, etc.) that don't make sense to share.
 */
export interface NativeChatStoreSlice<TClient, TMessage, TAttachment, TQueued> {
  // State keyed by environmentId (server/client registries)
  serverStatus: Map<string, NativeServerStatus>;
  clients: Map<string, TClient>;

  // State keyed by sessionKey (format: "env-{environmentId}:{tabId}")
  sessions: Map<string, NativeSessionState<TMessage>>;
  attachments: Map<string, TAttachment[]>;
  draftText: Map<string, string>;
  draftMentions: Map<string, FileMention[]>;
  messageQueue: Map<string, TQueued[]>;

  // Actions — environment-keyed
  setServerStatus: (environmentId: string, status: NativeServerStatus) => void;
  getServerStatus: (environmentId: string) => NativeServerStatus | undefined;
  setClient: (environmentId: string, client: TClient | null) => void;
  getClient: (environmentId: string) => TClient | undefined;

  // Actions — session-keyed
  setSession: (
    sessionKey: string,
    session: NativeSessionState<TMessage> | null,
  ) => void;
  getSession: (sessionKey: string) => NativeSessionState<TMessage> | undefined;
  addMessage: (sessionKey: string, message: TMessage) => void;
  removeMessage: (sessionKey: string, messageId: string) => void;
  setMessages: (sessionKey: string, messages: TMessage[]) => void;
  setSessionLoading: (sessionKey: string, isLoading: boolean) => void;
  setSessionError: (sessionKey: string, error: string | undefined) => void;
  setSessionTitle: (sessionKey: string, title: string | undefined) => void;

  addAttachment: (sessionKey: string, attachment: TAttachment) => void;
  removeAttachment: (sessionKey: string, attachmentId: string) => void;
  clearAttachments: (sessionKey: string) => void;
  getAttachments: (sessionKey: string) => TAttachment[];

  setDraftText: (sessionKey: string, text: string) => void;
  getDraftText: (sessionKey: string) => string;
  setDraftMentions: (sessionKey: string, mentions: FileMention[]) => void;
  getDraftMentions: (sessionKey: string) => FileMention[];

  addToQueue: (sessionKey: string, message: TQueued) => void;
  removeFromQueue: (sessionKey: string) => TQueued | undefined;
  removeQueueItem: (sessionKey: string, messageId: string) => void;
  moveQueueItem: (
    sessionKey: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  clearQueue: (sessionKey: string) => void;
  getQueueLength: (sessionKey: string) => number;
  getQueuedMessages: (sessionKey: string) => TQueued[];
}

export interface NativeChatStoreOptions<TMessage> {
  /**
   * Custom merge strategy for `setMessages`. When omitted, incoming messages
   * replace existing ones. Claude passes its ERROR/SYSTEM-preserving merge;
   * Codex and OpenCode pass `mergeNativeMessagesPreservingClientOnly`.
   */
  mergeMessages?: MergeMessages<TMessage>;
}

/**
 * Builds the shared slice of a native chat store. Agent-specific stores
 * compose this with their own state/actions using Zustand's slicing pattern:
 *
 *   create<FullState>()((set, get, api) => ({
 *     ...createNativeChatStoreSlice<...>(options)(set, get, api),
 *     // agent-specific state/actions
 *   }))
 */
export function createNativeChatStoreSlice<
  TClient,
  TMessage extends { id: string },
  TAttachment extends { id: string },
  TQueued extends { id: string },
>(
  options: NativeChatStoreOptions<TMessage> = {},
): StateCreator<
  NativeChatStoreSlice<TClient, TMessage, TAttachment, TQueued>,
  [],
  [],
  NativeChatStoreSlice<TClient, TMessage, TAttachment, TQueued>
> {
  const merge: MergeMessages<TMessage> =
    options.mergeMessages ?? ((_existing, incoming) => incoming);

  // Stable empty arrays per-store to avoid creating a new reference on every
  // `get()` selector call. React 19 + useSyncExternalStore detects unstable
  // snapshots and triggers an infinite render loop otherwise.
  const EMPTY_ATTACHMENTS: TAttachment[] = [];
  const EMPTY_MENTIONS: FileMention[] = [];
  const EMPTY_QUEUE: TQueued[] = [];

  return (set, get) => ({
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),

    setServerStatus: (environmentId, status) =>
      set((state) => {
        const next = new Map(state.serverStatus);
        next.set(environmentId, status);
        return { serverStatus: next };
      }),

    getServerStatus: (environmentId) => get().serverStatus.get(environmentId),

    setClient: (environmentId, client) =>
      set((state) => {
        const next = new Map(state.clients);
        if (client) {
          next.set(environmentId, client);
        } else {
          next.delete(environmentId);
        }
        return { clients: next };
      }),

    getClient: (environmentId) => get().clients.get(environmentId),

    setSession: (sessionKey, session) =>
      set((state) => {
        const next = new Map(state.sessions);
        if (session) {
          const previous = state.sessions.get(sessionKey);
          next.set(
            sessionKey,
            reconcileTimedSession(
              previous?.sessionId === session.sessionId ? previous : undefined,
              session,
            ),
          );
        } else {
          next.delete(sessionKey);
        }
        return { sessions: next };
      }),

    getSession: (sessionKey) => get().sessions.get(sessionKey),

    addMessage: (sessionKey, message) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, {
          ...session,
          messages: [...session.messages, message],
        });
        return { sessions: next };
      }),

    removeMessage: (sessionKey, messageId) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const filtered = session.messages.filter((m) => m.id !== messageId);
        if (filtered.length === session.messages.length) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, { ...session, messages: filtered });
        return { sessions: next };
      }),

    setMessages: (sessionKey, messages) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, {
          ...session,
          messages: merge(session.messages, messages),
        });
        return { sessions: next };
      }),

    setSessionLoading: (sessionKey, isLoading) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, updateTimedSessionLoading(session, isLoading));
        return { sessions: next };
      }),

    setSessionError: (sessionKey, error) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, { ...session, error });
        return { sessions: next };
      }),

    setSessionTitle: (sessionKey, title) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, { ...session, title });
        return { sessions: next };
      }),

    addAttachment: (sessionKey, attachment) =>
      set((state) => {
        const current = state.attachments.get(sessionKey) ?? [];
        const next = new Map(state.attachments);
        next.set(sessionKey, [...current, attachment]);
        return { attachments: next };
      }),

    removeAttachment: (sessionKey, attachmentId) =>
      set((state) => {
        const current = state.attachments.get(sessionKey) ?? [];
        const filtered = current.filter((a) => a.id !== attachmentId);
        if (filtered.length === current.length) return state;
        const next = new Map(state.attachments);
        next.set(sessionKey, filtered);
        return { attachments: next };
      }),

    clearAttachments: (sessionKey) =>
      set((state) => {
        const next = new Map(state.attachments);
        next.set(sessionKey, []);
        return { attachments: next };
      }),

    getAttachments: (sessionKey) =>
      get().attachments.get(sessionKey) ?? EMPTY_ATTACHMENTS,

    setDraftText: (sessionKey, text) =>
      set((state) => {
        const next = new Map(state.draftText);
        if (text.length > 0) {
          next.set(sessionKey, text);
        } else {
          next.delete(sessionKey);
        }
        return { draftText: next };
      }),

    getDraftText: (sessionKey) => get().draftText.get(sessionKey) ?? "",

    setDraftMentions: (sessionKey, mentions) =>
      set((state) => {
        const next = new Map(state.draftMentions);
        if (mentions.length > 0) {
          next.set(sessionKey, mentions);
        } else {
          next.delete(sessionKey);
        }
        return { draftMentions: next };
      }),

    getDraftMentions: (sessionKey) =>
      get().draftMentions.get(sessionKey) ?? EMPTY_MENTIONS,

    addToQueue: (sessionKey, message) =>
      set((state) => {
        const current = state.messageQueue.get(sessionKey) ?? [];
        const next = new Map(state.messageQueue);
        next.set(sessionKey, [...current, message]);
        return { messageQueue: next };
      }),

    removeFromQueue: (sessionKey) => {
      let removed: TQueued | undefined;
      set((state) => {
        const current = state.messageQueue.get(sessionKey) ?? [];
        if (current.length === 0) return state;
        const [first, ...rest] = current;
        removed = first;
        const next = new Map(state.messageQueue);
        next.set(sessionKey, rest);
        return { messageQueue: next };
      });
      return removed;
    },

    removeQueueItem: (sessionKey, messageId) =>
      set((state) => {
        const current = state.messageQueue.get(sessionKey) ?? [];
        const filtered = current.filter((m) => m.id !== messageId);
        if (filtered.length === current.length) return state;
        const next = new Map(state.messageQueue);
        next.set(sessionKey, filtered);
        return { messageQueue: next };
      }),

    moveQueueItem: (sessionKey, fromIndex, toIndex) =>
      set((state) => {
        const current = state.messageQueue.get(sessionKey) ?? [];
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= current.length ||
          toIndex >= current.length ||
          fromIndex === toIndex
        ) {
          return state;
        }
        const reordered = [...current];
        const [moved] = reordered.splice(fromIndex, 1);
        if (!moved) return state;
        reordered.splice(toIndex, 0, moved);
        const next = new Map(state.messageQueue);
        next.set(sessionKey, reordered);
        return { messageQueue: next };
      }),

    clearQueue: (sessionKey) =>
      set((state) => {
        const next = new Map(state.messageQueue);
        next.set(sessionKey, []);
        return { messageQueue: next };
      }),

    getQueueLength: (sessionKey) =>
      get().messageQueue.get(sessionKey)?.length ?? 0,

    getQueuedMessages: (sessionKey) =>
      get().messageQueue.get(sessionKey) ?? EMPTY_QUEUE,
  });
}

/**
 * Helper used by each agent's `clearEnvironment` to drop all entries whose
 * keys start with the session-key prefix for an environment. Returns a new
 * Map with the matching entries removed.
 */
export function pruneSessionKeyedMap<V>(
  map: Map<string, V>,
  sessionKeyPrefix: string,
): Map<string, V> {
  const next = new Map(map);
  for (const key of next.keys()) {
    if (key.startsWith(sessionKeyPrefix)) {
      next.delete(key);
    }
  }
  return next;
}
