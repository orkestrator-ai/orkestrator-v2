import type { StateCreator } from "zustand";
import { preserveMessageIdentities } from "@/lib/chat/message-identity";
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
 * `title` is optional because it is only known once the agent reports one — all
 * three agents populate it, but not until the session has been titled, so tab
 * labels (`DraggableTab`) must tolerate its absence.
 */
export interface NativeSessionState<TMessage> {
  sessionId: string;
  messages: TMessage[];
  isLoading: boolean;
  /** Bridge-issued generation for the active turn (Codex; absent elsewhere). */
  turnId?: string;
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
  /**
   * Monotonic revision for loading/lifecycle writes.
   *
   * Session objects also change for transcript and metadata updates, while a
   * repeated authoritative lifecycle edge can deliberately preserve the same
   * object. Consumers reconciling an asynchronous status snapshot therefore
   * use this revision instead of treating session identity as a lifecycle
   * token.
   */
  sessionLoadingRevisions: Map<string, number>;
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
  upsertMessage: (sessionKey: string, message: TMessage) => void;
  removeMessage: (sessionKey: string, messageId: string) => void;
  setMessages: (sessionKey: string, messages: TMessage[]) => void;
  setSessionLoading: (
    sessionKey: string,
    isLoading: boolean,
    /** Backend-authoritative epoch milliseconds for the active turn. */
    startedAt?: number,
    /** Bridge-issued generation token for discard-late-response guards. */
    turnId?: string,
  ) => void;
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

  /**
   * Overwrite this session's local view of the backend-owned queue.
   *
   * `messageQueue` is a projection, not the queue. Every real mutation is an
   * atomic backend command in `@/lib/prompt-queue-sources`, which installs the
   * authoritative snapshot through here. Writing a queue change straight into
   * the projection would look right until the next hydrate silently reverted
   * it, so the append/remove/reorder helpers this store used to expose are
   * deliberately gone.
   */
  setQueueProjection: (sessionKey: string, messages: TQueued[]) => void;
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
  /**
   * Optional ordering guard for live full-message updates.
   *
   * A snapshot may land before frames that were already buffered by the event
   * transport. Agent stores with per-message revisions can reject those older
   * frames here instead of briefly rolling the authoritative snapshot back.
   */
  shouldReplaceMessage?: (existing: TMessage, incoming: TMessage) => boolean;
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
    sessionLoadingRevisions: new Map(),
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
        const revisions = new Map(state.sessionLoadingRevisions);
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
        revisions.set(
          sessionKey,
          (state.sessionLoadingRevisions.get(sessionKey) ?? 0) + 1,
        );
        return {
          sessions: next,
          sessionLoadingRevisions: revisions,
        };
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

    upsertMessage: (sessionKey, message) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const existingIndex = session.messages.findIndex((m) => m.id === message.id);
        const existing = existingIndex === -1
          ? undefined
          : session.messages[existingIndex];
        if (
          existing !== undefined
          && options.shouldReplaceMessage
          && !options.shouldReplaceMessage(existing, message)
        ) {
          return state;
        }
        const messages =
          existingIndex === -1
            ? [...session.messages, message]
            : session.messages.map((existing, index) =>
                index === existingIndex ? message : existing
              );
        const next = new Map(state.sessions);
        next.set(sessionKey, {
          ...session,
          messages,
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
        // Snapshot objects are always freshly allocated even when nothing
        // changed. Re-point unchanged entries at the store's existing objects
        // so memoized rows keep their identity, and skip the write entirely
        // when the merged transcript is element-for-element identical.
        const merged = preserveMessageIdentities(
          session.messages,
          merge(session.messages, messages),
        );
        if (merged === session.messages) return state;
        const next = new Map(state.sessions);
        next.set(sessionKey, {
          ...session,
          messages: merged,
        });
        return { sessions: next };
      }),

    setSessionLoading: (sessionKey, isLoading, startedAt, turnId) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        const next = new Map(state.sessions);
        const timed = updateTimedSessionLoading(session, isLoading, Date.now(), startedAt);
        const nextTurnId = isLoading ? turnId ?? session.turnId : undefined;
        if (
          timed.isLoading === session.isLoading
          && timed.loadingStartedAt === session.loadingStartedAt
          && timed.lastCompletedElapsedSeconds
            === session.lastCompletedElapsedSeconds
          && nextTurnId === session.turnId
        ) {
          // A repeated lifecycle edge is still an ordering event even when it
          // carries no new session fields. Preserve the session/map identity
          // used by render guards, but advance the dedicated generation token
          // so an older in-flight snapshot cannot land after this edge.
          const revisions = new Map(state.sessionLoadingRevisions);
          revisions.set(
            sessionKey,
            (state.sessionLoadingRevisions.get(sessionKey) ?? 0) + 1,
          );
          return { sessionLoadingRevisions: revisions };
        }
        const revisions = new Map(state.sessionLoadingRevisions);
        next.set(
          sessionKey,
          {
            ...timed,
            turnId: nextTurnId,
          },
        );
        revisions.set(
          sessionKey,
          (state.sessionLoadingRevisions.get(sessionKey) ?? 0) + 1,
        );
        return {
          sessions: next,
          sessionLoadingRevisions: revisions,
        };
      }),

    setSessionError: (sessionKey, error) =>
      set((state) => {
        const session = state.sessions.get(sessionKey);
        if (!session) return state;
        if (session.error === error) return state;
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

    setQueueProjection: (sessionKey, messages) =>
      set((state) => {
        const next = new Map(state.messageQueue);
        next.set(sessionKey, messages);
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

/** The session-key prefix owned by one environment. */
export function sessionKeyPrefixFor(environmentId: string): string {
  return `env-${environmentId}:`;
}

/**
 * Build the state patch that drops every trace of one environment.
 *
 * Each store used to hand-maintain this list, which made adding a new Map a
 * silent leak waiting to happen — and the three had already drifted apart on
 * what they cleaned up. Naming the maps declaratively keeps the sweep honest:
 * a new Map is added to one of these two arrays or it is obviously missing.
 *
 * `environmentKeyed` maps are keyed by environmentId; `sessionKeyed` maps are
 * keyed by sessionKey and pruned by prefix.
 */
export function buildClearEnvironmentPatch<TState extends object>(
  state: TState,
  environmentId: string,
  keys: {
    environmentKeyed: ReadonlyArray<KeysOfMaps<TState>>;
    sessionKeyed: ReadonlyArray<KeysOfMaps<TState>>;
  },
): Partial<TState> {
  const prefix = sessionKeyPrefixFor(environmentId);
  const patch: Record<string, unknown> = {};

  for (const key of keys.environmentKeyed) {
    const map = state[key] as unknown as Map<string, unknown>;
    const next = new Map(map);
    next.delete(environmentId);
    patch[key as string] = next;
  }

  for (const key of keys.sessionKeyed) {
    const map = state[key] as unknown as Map<string, unknown>;
    const next = pruneSessionKeyedMap(map, prefix);
    // Older builds scoped some of these by environmentId. Drop that key too so
    // a stale entry cannot outlive the environment it belonged to.
    next.delete(environmentId);
    patch[key as string] = next;
  }

  return patch as Partial<TState>;
}

/**
 * Build the state patch that drops every trace of one *tab*.
 *
 * Closing a tab used to clear only its session and queue, so its draft, model,
 * attachments and the rest were orphaned for the life of the process. Tab ids
 * are UUIDs, so nothing ever reclaims them. Takes the same `sessionKeyed` list
 * as `buildClearEnvironmentPatch` so the two sweeps cannot drift.
 */
export function buildClearSessionPatch<TState extends object>(
  state: TState,
  sessionKey: string,
  sessionKeyed: ReadonlyArray<KeysOfMaps<TState>>,
): Partial<TState> {
  const patch: Record<string, unknown> = {};

  for (const key of sessionKeyed) {
    const map = state[key] as unknown as Map<string, unknown>;
    if (!map.has(sessionKey)) continue;
    const next = new Map(map);
    next.delete(sessionKey);
    patch[key as string] = next;
  }

  return patch as Partial<TState>;
}

/** Keys of `TState` whose value is a string-keyed Map. */
type KeysOfMaps<TState> = {
  [K in keyof TState]: TState[K] extends Map<string, unknown> ? K : never;
}[keyof TState];

/**
 * Per-environment SSE subscription state.
 *
 * The subscription deliberately outlives the React component: the tab may be
 * unmounted while a turn is still running, and the store must keep receiving
 * updates so the sidebar and a later remount both see the truth.
 */
export interface NativeEventSubscriptionState<TEvent> {
  abortController: AbortController;
  stream: AsyncIterable<TEvent> | null;
  isActive: boolean;
  /** Consecutive reconnects since the last healthy frame. */
  reconnectAttempts: number;
  /** Store-owned so a tab unmount cannot lose or duplicate the retry timer. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** The reconnect budget was exhausted and a full snapshot is required. */
  desynced: boolean;
}

export interface NativeEventSubscriptionSlice<TEvent> {
  eventSubscriptions: Map<string, NativeEventSubscriptionState<TEvent>>;
  getOrCreateEventSubscription: (
    environmentId: string,
  ) => NativeEventSubscriptionState<TEvent>;
  /**
   * Publish (or clear) the stream for an environment's subscription.
   *
   * `owner` is the `abortController` of the subscription making the call. When
   * supplied, a subscription that has already been superseded or closed cannot
   * clobber whichever entry currently holds the environment: a dropped loop
   * runs its teardown asynchronously, so without the check its trailing
   * `setEventStream(id, null)` would mark a healthy *replacement* inactive and
   * strand it — reading as "no subscription" while its loop is still running.
   */
  setEventStream: (
    environmentId: string,
    stream: AsyncIterable<TEvent> | null,
    owner?: AbortController,
  ) => void;
  closeEventSubscription: (environmentId: string) => void;
  hasActiveEventSubscription: (environmentId: string) => boolean;
  setEventReconnectState: (
    environmentId: string,
    update: Partial<Pick<
      NativeEventSubscriptionState<TEvent>,
      "reconnectAttempts" | "reconnectTimer" | "desynced"
    >>,
    owner?: AbortController,
  ) => void;
  markEventSubscriptionHealthy: (
    environmentId: string,
    owner: AbortController,
  ) => void;
  markEventSubscriptionResynced: (
    environmentId: string,
    owner: AbortController,
  ) => void;
}

/**
 * Decides whether a dropped subscription's reconnect timer may still act.
 *
 * Shared because Claude and OpenCode run byte-identical reconnect loops, and
 * the three conditions are each load-bearing:
 *
 * - **missing** — `closeEventSubscription`/`clearEnvironment` deleted the
 *   entry, so the app explicitly stopped listening. Reconnecting would
 *   resurrect a subscription the user closed.
 * - **not ours** — a remount already created a replacement with its own
 *   controller. Reconnecting would run two loops against one environment.
 * - **still active** — nothing has torn this stream down, so there is nothing
 *   to reconnect.
 */
export function shouldReconnectEventSubscription<TEvent>(
  subscription: NativeEventSubscriptionState<TEvent> | undefined,
  owner: AbortController,
): boolean {
  if (!subscription) return false;
  if (subscription.abortController !== owner) return false;
  return !subscription.isActive;
}

/**
 * Abort a subscription and drain its iterator.
 *
 * Exported because `clearEnvironment` has to do this too, before it drops the
 * map entry — aborting without returning the iterator leaks the generator.
 */
export function teardownEventSubscription<TEvent>(
  subscription: NativeEventSubscriptionState<TEvent> | undefined,
): void {
  if (!subscription) return;
  if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer);
  subscription.abortController.abort();
  if (subscription.stream && Symbol.asyncIterator in subscription.stream) {
    const iterator = subscription.stream[Symbol.asyncIterator]();
    if (iterator.return) {
      iterator.return().catch(() => {});
    }
  }
}

/**
 * Builds the shared event-subscription slice.
 *
 * Claude and OpenCode had byte-identical copies of these four actions; Codex
 * drives its SSE through the bridge client instead and does not use this.
 */
export function createEventSubscriptionSlice<TEvent>(
  logPrefix: string,
): StateCreator<
  NativeEventSubscriptionSlice<TEvent>,
  [],
  [],
  NativeEventSubscriptionSlice<TEvent>
> {
  return (set, get) => ({
    eventSubscriptions: new Map(),

    getOrCreateEventSubscription: (environmentId) => {
      const state = get();
      const existing = state.eventSubscriptions.get(environmentId);

      if (existing && existing.isActive) {
        console.log(
          `[${logPrefix}] Reusing existing event subscription for environment:`,
          environmentId,
        );
        return existing;
      }

      console.log(
        `[${logPrefix}] Creating new event subscription for environment:`,
        environmentId,
      );
      const newSubscription: NativeEventSubscriptionState<TEvent> = {
        abortController: new AbortController(),
        stream: null,
        isActive: true,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
        reconnectTimer: null,
        desynced: existing?.desynced ?? false,
      };

      if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);

      const next = new Map(state.eventSubscriptions);
      next.set(environmentId, newSubscription);
      set({ eventSubscriptions: next });

      return newSubscription;
    },

    setEventStream: (environmentId, stream, owner) =>
      set((state) => {
        const subscription = state.eventSubscriptions.get(environmentId);
        if (!subscription) return state;
        if (owner && subscription.abortController !== owner) return state;
        const next = new Map(state.eventSubscriptions);
        next.set(environmentId, {
          ...subscription,
          stream,
          isActive: stream !== null,
        });
        return { eventSubscriptions: next };
      }),

    closeEventSubscription: (environmentId) => {
      const state = get();
      const subscription = state.eventSubscriptions.get(environmentId);
      if (!subscription) return;

      console.log(
        `[${logPrefix}] Closing event subscription for environment:`,
        environmentId,
      );
      teardownEventSubscription(subscription);

      const next = new Map(state.eventSubscriptions);
      next.delete(environmentId);
      set({ eventSubscriptions: next });
    },

    hasActiveEventSubscription: (environmentId) =>
      get().eventSubscriptions.get(environmentId)?.isActive ?? false,

    setEventReconnectState: (environmentId, update, owner) =>
      set((state) => {
        const subscription = state.eventSubscriptions.get(environmentId);
        if (!subscription) return state;
        if (owner && subscription.abortController !== owner) return state;
        if (
          update.reconnectTimer !== undefined
          && subscription.reconnectTimer
          && subscription.reconnectTimer !== update.reconnectTimer
        ) {
          clearTimeout(subscription.reconnectTimer);
        }
        const next = new Map(state.eventSubscriptions);
        next.set(environmentId, { ...subscription, ...update });
        return { eventSubscriptions: next };
      }),

    markEventSubscriptionHealthy: (environmentId, owner) =>
      set((state) => {
        const subscription = state.eventSubscriptions.get(environmentId);
        if (!subscription || subscription.abortController !== owner) return state;
        /*
         * A live frame proves the stream is healthy, but it does not repair an
         * authoritative snapshot that failed during a full resync. In that
         * state `reconnectTimer` belongs to the snapshot retry, so keep it
         * armed until `markEventSubscriptionResynced` clears the desync flag.
         */
        if (!subscription.desynced && subscription.reconnectTimer) {
          clearTimeout(subscription.reconnectTimer);
        }
        const next = new Map(state.eventSubscriptions);
        next.set(environmentId, {
          ...subscription,
          reconnectAttempts: 0,
          reconnectTimer: subscription.desynced
            ? subscription.reconnectTimer
            : null,
        });
        return { eventSubscriptions: next };
      }),

    markEventSubscriptionResynced: (environmentId, owner) =>
      set((state) => {
        const subscription = state.eventSubscriptions.get(environmentId);
        if (
          !subscription
          || subscription.abortController !== owner
          || !subscription.desynced
        ) return state;
        if (subscription.reconnectTimer) {
          clearTimeout(subscription.reconnectTimer);
        }
        const next = new Map(state.eventSubscriptions);
        /*
         * Reset the ladder as well as the flag.
         *
         * `getOrCreateEventSubscription` deliberately carries
         * `reconnectAttempts` forward, and only an inbound frame clears it
         * (`markEventSubscriptionHealthy`). A quiet-but-healthy session
         * therefore stayed pinned at the ceiling after resyncing, so the next
         * transient drop skipped the whole backoff and went straight to the
         * 60s desynced state.
         *
         * This does not defeat the ceiling: reaching here means the stream was
         * re-established *and* a full authoritative snapshot came back over
         * HTTP, which a bridge that is actually down never manages. A bridge
         * that flaps between those two states pays one full ladder — ~2.5
         * minutes of capped, exponentially spaced attempts — per successful
         * rehydrate, which is still bounded and still ends at the cap.
         */
        next.set(environmentId, {
          ...subscription,
          desynced: false,
          reconnectAttempts: 0,
          reconnectTimer: null,
        });
        return { eventSubscriptions: next };
      }),
  });
}
