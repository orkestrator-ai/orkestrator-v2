/**
 * App-level hook that monitors agent activity state for ALL environments,
 * regardless of which project or environment is currently selected.
 *
 * This ensures the sidebar environment icons always show the correct
 * color (green=idle, blue=working, amber=waiting) even for environments
 * in non-selected projects.
 *
 * Terminal mode (containers): manages claude-state polling lifecycle
 * Native mode (Claude/OpenCode/Codex): derives activity from session stores
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { listen, type UnlistenFn } from "@/lib/native/events";
import * as backend from "@/lib/backend";
import { useEnvironmentStore, useUIStore } from "@/stores";
import {
  parseUsableAgentActivityTime,
  useAgentActivityStore,
  type AgentActivityState,
} from "@/stores/agentActivityStore";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  getEnvironmentIdFromClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useCodexStore } from "@/stores/codexStore";

interface ClaudeStateEvent {
  container_id: string;
  state: string;
  occurred_at?: string;
}

interface EnvironmentActivityRecordedEvent {
  environment_id: string;
  occurred_at: string;
  activity_kind?: "prompt" | "completed";
}

/**
 * Attempts before terminal-state polling for a container is given up on.
 * The ladder is 0ms, 250ms, 500ms … 8s — about 16 seconds in total, which
 * rides out a backend restart while keeping a permanently broken registration
 * from retrying and warning for the life of the environment.
 */
const MAX_POLL_START_ATTEMPTS = 8;

let pollSubscriptionCounter = 0;

function createPollSubscriptionId(containerId: string): string {
  let randomId: string | undefined;
  try {
    randomId = globalThis.crypto?.randomUUID?.();
  } catch {
    // The monotonic fallback is sufficient for an in-process ownership token.
  }
  return `activity-${containerId}-${randomId ?? ++pollSubscriptionCounter}`;
}

/**
 * Extract environmentId from a session key (format: "env-{uuid}:{tabId}")
 */
function extractEnvironmentId(sessionKey: string): string | undefined {
  const match = sessionKey.match(/^env-([^:]+):/);
  return match?.[1];
}

function mergeActivityState(
  current: AgentActivityState | undefined,
  next: AgentActivityState
): AgentActivityState {
  if (current === "working" || next === "working") return "working";
  if (current === "waiting" || next === "waiting") return "waiting";
  return "idle";
}

type ClaudeTmuxTabs = ReturnType<typeof useClaudeTmuxStore.getState>["tabs"];
type SetContainerState = ReturnType<
  typeof useAgentActivityStore.getState
>["setContainerState"];
type ActivitySource =
  | "claude"
  | "claude-terminal"
  | "claude-tmux"
  | "opencode"
  | "codex";
type ActivitySourcesByEnvironment = Map<
  string,
  Map<ActivitySource, AgentActivityState>
>;

function getEnvironmentSourceActivity(
  activitySources: ActivitySourcesByEnvironment,
  environmentId: string,
): AgentActivityState | undefined {
  const environmentSources = activitySources.get(environmentId);
  if (!environmentSources || environmentSources.size === 0) return undefined;

  let desiredState: AgentActivityState = "idle";
  for (const state of environmentSources.values()) {
    desiredState = mergeActivityState(desiredState, state);
  }
  return desiredState;
}

/**
 * Activity ordering changes when a prompt starts, work finishes, or an agent
 * stops to ask for input. Pure teardown transitions are intentionally ignored.
 */
export function isEnvironmentActivityTransition(
  previousState: AgentActivityState,
  newState: AgentActivityState,
): boolean {
  if (previousState === newState) return false;
  return (
    newState === "working" ||
    newState === "waiting" ||
    (previousState === "working" && newState === "idle")
  );
}

/** A completed turn becomes unread unless its environment is already open. */
export function isEnvironmentCompletionTransition(
  previousState: AgentActivityState,
  newState: AgentActivityState,
): boolean {
  return previousState === "working" && (
    newState === "idle" || newState === "waiting"
  );
}

function setEnvironmentSourceActivity(
  activitySources: MutableRefObject<ActivitySourcesByEnvironment>,
  environmentId: string,
  source: ActivitySource,
  sourceState: AgentActivityState,
  setContainerState: SetContainerState,
  occurredAt?: string,
  notifyCallbacks = true,
): void {
  let environmentSources = activitySources.current.get(environmentId);
  if (!environmentSources) {
    environmentSources = new Map();
    activitySources.current.set(environmentId, environmentSources);
  }
  const previousSourceState = environmentSources.get(source);
  environmentSources.set(source, sourceState);

  const desiredState =
    getEnvironmentSourceActivity(activitySources.current, environmentId)
    ?? "idle";

  const currentState =
    useAgentActivityStore.getState().containerStates[environmentId];
  if (currentState === desiredState) return;

  if (setContainerState(environmentId, desiredState, occurredAt, notifyCallbacks)) {
    return;
  }
  // The store rejected the observation as older than the one it holds. Undo the
  // per-source record too: leaving it applied would make this map and the store
  // disagree, and the next call would compute its aggregate from a state that
  // was never adopted.
  if (previousSourceState === undefined) environmentSources.delete(source);
  else environmentSources.set(source, previousSourceState);
}

function getSessionEnvironmentIds(
  sessions: Map<string, unknown>,
  previousSessions?: Map<string, unknown>,
): Set<string> {
  const environmentIds = new Set<string>();
  for (const sourceSessions of previousSessions
    ? [previousSessions, sessions]
    : [sessions]) {
    for (const sessionKey of sourceSessions.keys()) {
      const environmentId = extractEnvironmentId(sessionKey);
      if (environmentId) environmentIds.add(environmentId);
    }
  }
  return environmentIds;
}

function getEnvironmentTransitionIds<T>(
  currentItems: Map<string, T>,
  previousItems: Map<string, T>,
  getEnvironmentId: (
    key: string,
    currentItem: T | undefined,
    previousItem: T | undefined,
  ) => string | null | undefined,
  // The key is passed through because "waiting" can live in a map keyed by
  // sessionKey rather than on the session object itself, as Codex's approvals
  // are.
  getCurrentState: (item: T | undefined, key: string) => AgentActivityState,
  getPreviousState: (item: T | undefined, key: string) => AgentActivityState,
  isTeardown: (
    currentItem: T | undefined,
    previousItem: T | undefined,
  ) => boolean = (currentItem, previousItem) =>
    previousItem !== undefined && currentItem === undefined,
): {
  activityEnvironmentIds: Set<string>;
  completedEnvironmentIds: Set<string>;
} {
  const activityEnvironmentIds = new Set<string>();
  const completedEnvironmentIds = new Set<string>();
  const keys = new Set([...previousItems.keys(), ...currentItems.keys()]);
  for (const key of keys) {
    const previousItem = previousItems.get(key);
    const currentItem = currentItems.get(key);
    const environmentId = getEnvironmentId(key, currentItem, previousItem);
    if (!environmentId) continue;

    // Removing a session/tab is teardown, not a completed turn. The aggregate
    // source state still needs to fall back to idle below, but recording
    // activity or unread here would make closing a working tab look like a
    // successful agent completion.
    if (isTeardown(currentItem, previousItem)) continue;

    const previousState = getPreviousState(previousItem, key);
    const currentState = getCurrentState(currentItem, key);
    if (isEnvironmentActivityTransition(previousState, currentState)) {
      activityEnvironmentIds.add(environmentId);
    }
    if (isEnvironmentCompletionTransition(previousState, currentState)) {
      completedEnvironmentIds.add(environmentId);
    }
  }
  return { activityEnvironmentIds, completedEnvironmentIds };
}

/**
 * Route one batch of transitions to the persistence callbacks. An environment
 * that both worked and completed in the same batch persists as a completion —
 * the completion write records the activity timestamp too, and issuing both
 * would race two backend mutations for one event.
 */
function persistEnvironmentTransitions(
  transitions: ReturnType<typeof getEnvironmentTransitionIds>,
  recordActivity: (environmentId: string) => void,
  markCompleted: (environmentId: string) => void,
): void {
  for (const environmentId of transitions.activityEnvironmentIds) {
    if (transitions.completedEnvironmentIds.has(environmentId)) {
      markCompleted(environmentId);
    } else {
      recordActivity(environmentId);
    }
  }
}

/** Minimal session shape the shared derivation needs. */
interface ActivitySession {
  sessionId: string;
  isLoading: boolean;
}

/** Minimal store shape the shared derivation needs. */
interface NativeActivityState {
  sessions: Map<string, ActivitySession>;
  clients: Map<string, unknown>;
}

interface NativeActivityStore<TState extends NativeActivityState> {
  getState: () => TState;
  subscribe: (listener: (state: TState, prevState: TState) => void) => () => void;
}

interface NativeActivityConfig<TState extends NativeActivityState> {
  source: ActivitySource;
  /**
   * Everything the derivation reads. If every entry is reference-equal to the
   * previous state the sync bails out — this is the hot path, it runs on every
   * store write.
   *
   * Anything `isWaiting` consults MUST be listed here, or a change to it will
   * be silently skipped.
   */
  watched: (state: TState) => readonly unknown[];
  /**
   * True when this session is blocked on the user, which shows amber rather
   * than green in the sidebar.
   */
  isWaiting: (state: TState, sessionKey: string, session: ActivitySession) => boolean;
}

/**
 * Derive one agent's sidebar activity from its session store.
 *
 * Claude, OpenCode and Codex each had their own ~110-line copy of this
 * algorithm, and they had drifted: Codex never consulted its pending approvals,
 * so an environment blocked on a command approval showed idle/green — exactly
 * the state the amber icon exists to signal. Sharing the derivation makes that
 * class of omission a missing config field instead of missing code.
 *
 * Returns the store unsubscribe function.
 */
function subscribeNativeActivity<TState extends NativeActivityState>(
  store: NativeActivityStore<TState>,
  config: NativeActivityConfig<TState>,
  activitySources: MutableRefObject<ActivitySourcesByEnvironment>,
  setContainerState: SetContainerState,
  recordActivity: (environmentId: string) => void,
  markCompleted: (environmentId: string) => void,
): () => void {
  const activityStateFor = (
    state: TState,
    sessionKey: string,
    session: ActivitySession | undefined,
  ): AgentActivityState => {
    if (!session) return "idle";
    /**
     * Blocked-on-the-user beats still-running. A turn parked on an approval is
     * *also* loading — Codex holds `isLoading` for every non-terminal phase — so
     * checking `isLoading` first showed the environment as busy and left the
     * user with no signal that it was their input the turn was waiting on.
     * Amber exists for exactly this state, so it wins.
     */
    if (config.isWaiting(state, sessionKey, session)) return "waiting";
    return session.isLoading ? "working" : "idle";
  };

  const syncActivity = (state: TState, prevState?: TState) => {
    if (prevState) {
      const current = config.watched(state);
      const previous = config.watched(prevState);
      if (current.every((value, index) => value === previous[index])) {
        return;
      }
    }

    const environmentIds = getSessionEnvironmentIds(
      state.sessions,
      prevState?.sessions,
    );

    if (prevState) {
      const transitions = getEnvironmentTransitionIds(
        state.sessions,
        prevState.sessions,
        (sessionKey) => {
          const envId = extractEnvironmentId(sessionKey);
          return envId && state.clients.has(envId) ? envId : undefined;
        },
        (session, key) => activityStateFor(state, key, session),
        (session, key) => activityStateFor(prevState, key, session),
      );
      persistEnvironmentTransitions(transitions, recordActivity, markCompleted);
    }

    for (const envId of environmentIds) {
      const hasCurrentSessions = Array.from(state.sessions.keys()).some(
        (sessionKey) => extractEnvironmentId(sessionKey) === envId,
      );

      // Only derive state while connected. With no client the SSE connection is
      // down, so preserve the last-known activity rather than flashing idle. A
      // removed session is authoritative, though, so clear that source.
      if (!state.clients.has(envId)) {
        if (!hasCurrentSessions) {
          setEnvironmentSourceActivity(
            activitySources,
            envId,
            config.source,
            "idle",
            setContainerState,
          );
        }
        continue;
      }

      let desiredState: AgentActivityState = "idle";
      for (const [sessionKey, session] of state.sessions) {
        if (extractEnvironmentId(sessionKey) !== envId) continue;
        desiredState = mergeActivityState(
          desiredState,
          activityStateFor(state, sessionKey, session),
        );
      }

      setEnvironmentSourceActivity(
        activitySources,
        envId,
        config.source,
        desiredState,
        setContainerState,
      );
    }
  };

  syncActivity(store.getState());
  return store.subscribe(syncActivity);
}

function getClaudeTmuxTabEnvironmentId(
  stateKey: string,
  tab: ClaudeTmuxTabs extends Map<string, infer Tab> ? Tab : never,
): string | null {
  return tab.environmentId ?? getEnvironmentIdFromClaudeTmuxStateKey(stateKey);
}

function getClaudeTmuxTabActivityState(
  tab: ClaudeTmuxTabs extends Map<string, infer Tab> ? Tab : never,
): AgentActivityState {
  const hasPendingHooks =
    tab.pendingApprovals.length > 0 ||
    tab.pendingQuestions.length > 0 ||
    tab.pendingPlans.length > 0 ||
    tab.pendingPermissions.length > 0 ||
    tab.pendingElicitations.length > 0;

  if (hasPendingHooks) return "waiting";
  if (tab.busy) return "working";
  return "idle";
}

function syncClaudeTmuxActivityState(
  tabs: ClaudeTmuxTabs,
  previousTabs: ClaudeTmuxTabs | undefined,
  activitySources: MutableRefObject<ActivitySourcesByEnvironment>,
  setContainerState: SetContainerState,
  recordActivity?: (environmentId: string) => void,
  markCompleted?: (environmentId: string) => void,
): void {
  const desiredByEnvironment = new Map<string, AgentActivityState>();
  const seenEnvironmentIds = new Set<string>();

  if (previousTabs && recordActivity) {
    const transitions = getEnvironmentTransitionIds(
      tabs,
      previousTabs,
      (stateKey, currentTab, previousTab) => currentTab
        ? getClaudeTmuxTabEnvironmentId(stateKey, currentTab)
        : previousTab
          ? getClaudeTmuxTabEnvironmentId(stateKey, previousTab)
          : null,
      (tab) => tab ? getClaudeTmuxTabActivityState(tab) : "idle",
      (tab) => tab ? getClaudeTmuxTabActivityState(tab) : "idle",
      (currentTab, previousTab) =>
        previousTab !== undefined
        && (
          currentTab === undefined
          || (
            currentTab.environmentId === null
            && currentTab.sessionId === null
            && !currentTab.running
          )
        ),
    );
    if (markCompleted) {
      persistEnvironmentTransitions(transitions, recordActivity, markCompleted);
    } else {
      for (const environmentId of transitions.activityEnvironmentIds) {
        recordActivity(environmentId);
      }
    }
  }

  for (const sourceTabs of previousTabs ? [previousTabs, tabs] : [tabs]) {
    for (const [stateKey, tab] of sourceTabs) {
      const envId = getClaudeTmuxTabEnvironmentId(stateKey, tab);
      if (envId) {
        seenEnvironmentIds.add(envId);
      }
    }
  }

  for (const [stateKey, tab] of tabs) {
    const envId = getClaudeTmuxTabEnvironmentId(stateKey, tab);
    if (!envId) continue;

    desiredByEnvironment.set(
      envId,
      mergeActivityState(
        desiredByEnvironment.get(envId),
        getClaudeTmuxTabActivityState(tab),
      ),
    );
  }

  for (const envId of seenEnvironmentIds) {
    const desiredState = desiredByEnvironment.get(envId) ?? "idle";
    setEnvironmentSourceActivity(
      activitySources,
      envId,
      "claude-tmux",
      desiredState,
      setContainerState,
    );
  }
}

export function useGlobalActivityMonitor(): void {
  const environments = useEnvironmentStore((s) => s.environments);
  const setContainerState = useAgentActivityStore((s) => s.setContainerState);
  const registerStateCallback = useAgentActivityStore((s) => s.registerStateCallback);
  const unregisterStateCallback = useAgentActivityStore((s) => s.unregisterStateCallback);
  const activitySources = useRef<ActivitySourcesByEnvironment>(new Map());
  /**
   * A successful write can still return a different, newer aggregate when
   * another renderer won the ordering race. Reassert the state still derived
   * from this renderer's live sessions once; without that retry the response
   * replaces the runtime store and no later session mutation exists to turn a
   * completed environment green. The per-state latch bounds a genuinely
   * conflicting pair of renderers instead of letting them hot-loop.
   */
  const reassertedAgentActivity = useRef(
    new Map<string, AgentActivityState>(),
  );
  const lastIssuedActivityTime = useRef(0);

  // Track active pollers and listeners for container environments
  const activePollers = useRef(new Map<string, string>());
  const activeListeners = useRef(new Map<string, UnlistenFn>());
  const pollRetryTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  const persistActivity = useCallback((
    environmentId: string,
    completed: boolean,
  ) => {
    const environmentStore = useEnvironmentStore.getState();
    const environment = environmentStore.environments.find(
      (candidate) => candidate.id === environmentId,
    );
    if (!environment) return;

    const previousActivityAt = environment.lastActivityAt;
    const previousUnreadWork = environment.hasUnreadWork === true;
    const previousActivityTime = previousActivityAt
      ? Date.parse(previousActivityAt)
      : Number.NEGATIVE_INFINITY;
    const occurredTime = Math.max(
      Date.now(),
      lastIssuedActivityTime.current + 1,
      Number.isFinite(previousActivityTime)
        ? previousActivityTime + 1
        : Number.NEGATIVE_INFINITY,
    );
    lastIssuedActivityTime.current = occurredTime;
    const occurredAt = new Date(occurredTime).toISOString();
    const shouldMarkUnread =
      completed &&
      useUIStore.getState().selectedEnvironmentId !== environmentId;
    environmentStore.updateEnvironment(environment.id, {
      lastActivityAt: occurredAt,
      ...(shouldMarkUnread ? { hasUnreadWork: true } : {}),
    });
    const persist = shouldMarkUnread
      ? backend.recordEnvironmentCompletion(environment.id, occurredAt)
      : backend.recordEnvironmentActivity(environment.id, occurredAt);
    persist
      .then((updatedEnvironment) => {
        const persistedAt = updatedEnvironment.lastActivityAt;
        if (!persistedAt) return;
        const currentEnvironment = useEnvironmentStore
          .getState()
          .environments.find((candidate) => candidate.id === updatedEnvironment.id);
        const currentTime = currentEnvironment?.lastActivityAt
          ? Date.parse(currentEnvironment.lastActivityAt)
          : Number.NEGATIVE_INFINITY;
        const persistedTime = Date.parse(persistedAt);
        if (Number.isFinite(persistedTime) && persistedTime >= currentTime) {
          useEnvironmentStore.getState().updateEnvironment(
            updatedEnvironment.id,
            {
              lastActivityAt: persistedAt,
              ...(shouldMarkUnread
                ? { hasUnreadWork: updatedEnvironment.hasUnreadWork === true }
                : {}),
            },
          );
        }
      })
      .catch(async (error) => {
        const currentEnvironment = useEnvironmentStore
          .getState()
          .environments.find((candidate) => candidate.id === environment.id);
        if (currentEnvironment?.lastActivityAt === occurredAt) {
          try {
            const snapshots = await backend.getEnvironmentSnapshots(environment.projectId);
            const persistedEnvironment = snapshots.find(
              (candidate) => candidate.id === environment.id,
            );
            const latestEnvironment = useEnvironmentStore
              .getState()
              .environments.find((candidate) => candidate.id === environment.id);
            if (latestEnvironment?.lastActivityAt === occurredAt) {
              useEnvironmentStore.getState().updateEnvironment(
                environment.id,
                {
                  lastActivityAt: persistedEnvironment?.lastActivityAt,
                  ...(shouldMarkUnread
                    ? { hasUnreadWork: persistedEnvironment?.hasUnreadWork === true }
                    : {}),
                },
              );
            }
          } catch (snapshotError) {
            const latestEnvironment = useEnvironmentStore
              .getState()
              .environments.find((candidate) => candidate.id === environment.id);
            if (latestEnvironment?.lastActivityAt === occurredAt) {
              useEnvironmentStore.getState().updateEnvironment(
                environment.id,
                {
                  lastActivityAt: previousActivityAt,
                  ...(shouldMarkUnread
                    ? { hasUnreadWork: previousUnreadWork }
                    : {}),
                },
              );
            }
            console.warn(
              "[GlobalActivityMonitor] Failed to refresh environment activity:",
              snapshotError,
            );
          }
        }
        console.warn(
          completed
            ? "[GlobalActivityMonitor] Failed to persist environment completion:"
            : "[GlobalActivityMonitor] Failed to persist environment activity:",
          error,
        );
      });
  }, []);

  const recordActivity = useCallback((environmentId: string) => {
    persistActivity(environmentId, false);
  }, [persistActivity]);

  const markCompleted = useCallback((environmentId: string) => {
    // Completion persistence owns both the activity token and unread bit in one
    // backend mutation. An open environment records the activity without
    // setting a badge because that client has already seen the result.
    persistActivity(environmentId, true);
  }, [persistActivity]);

  // Persist activity independently of whichever sidebar/chat is mounted. The
  // backend timestamp is the source of truth; the optimistic store update
  // keeps an activity-sorted sidebar responsive while the write completes.
  useEffect(() => {
    const callbackId = registerStateCallback((
      activityKey,
      _previousState,
      newState,
      occurredAt,
    ) => {
      let observedAt = occurredAt ?? new Date().toISOString();
      const environmentStore = useEnvironmentStore.getState();
      const environment = environmentStore.environments.find(
        (candidate) =>
          candidate.id === activityKey
          || candidate.containerId === activityKey,
      );
      if (!environment) return;
      const persistedTime = parseUsableAgentActivityTime(
        environment.agentActivityUpdatedAt,
      );
      const observedTime = parseUsableAgentActivityTime(observedAt);
      if (
        Number.isFinite(persistedTime)
        && Number.isFinite(observedTime)
        && observedTime <= persistedTime
      ) {
        // `parseUsableAgentActivityTime` already caps this at now + 5 minutes,
        // so the bump can never reach the maximum representable date.
        observedAt = new Date(persistedTime + 1).toISOString();
      }

      // The environment record is the cross-client authority. Apply the local
      // observation immediately for a responsive sidebar, then commit it. The
      // backend rejects reports older than agentActivityUpdatedAt.
      const previousState = environment.agentActivityState;
      const previousUpdatedAt = environment.agentActivityUpdatedAt;
      const reconcileAgentActivity = (
        state: AgentActivityState | undefined,
        updatedAt: string | undefined,
      ) => {
        useEnvironmentStore.getState().updateEnvironment(environment.id, {
          agentActivityState: state,
          agentActivityUpdatedAt: updatedAt,
        });
        useAgentActivityStore.getState().reconcileContainerState(
          activityKey,
          state,
          updatedAt,
        );
      };
      environmentStore.updateEnvironment(environment.id, {
        agentActivityState: newState,
        agentActivityUpdatedAt: observedAt,
      });
      void backend.setEnvironmentAgentActivity(
        environment.id,
        newState,
        observedAt,
      )
        .then((updatedEnvironment) => {
          if (!updatedEnvironment) return;
          const currentEnvironment = useEnvironmentStore
            .getState()
            .getEnvironmentById(environment.id);
          if (currentEnvironment?.agentActivityUpdatedAt !== observedAt) return;
          reconcileAgentActivity(
            updatedEnvironment.agentActivityState,
            updatedEnvironment.agentActivityUpdatedAt,
          );

          const desiredState = getEnvironmentSourceActivity(
            activitySources.current,
            environment.id,
          );
          if (!desiredState) return;
          if (updatedEnvironment.agentActivityState === desiredState) {
            reassertedAgentActivity.current.delete(environment.id);
            return;
          }
          if (
            reassertedAgentActivity.current.get(environment.id)
            === desiredState
          ) {
            return;
          }

          reassertedAgentActivity.current.set(environment.id, desiredState);
          // `reconcileContainerState` just installed the divergent backend
          // value, so this is a real state transition and reaches the normal
          // persistence callback with a fresh ordering token.
          setContainerState(environment.id, desiredState);
        })
        .catch(async (error) => {
          const currentEnvironment = useEnvironmentStore
            .getState()
            .getEnvironmentById(environment.id);
          if (currentEnvironment?.agentActivityUpdatedAt === observedAt) {
            try {
              const snapshots = await backend.getEnvironmentSnapshots(
                environment.projectId,
              );
              const persistedEnvironment = snapshots.find(
                (candidate) => candidate.id === environment.id,
              );
              const latestEnvironment = useEnvironmentStore
                .getState()
                .getEnvironmentById(environment.id);
              if (latestEnvironment?.agentActivityUpdatedAt === observedAt) {
                reconcileAgentActivity(
                  persistedEnvironment?.agentActivityState ?? previousState,
                  persistedEnvironment?.agentActivityUpdatedAt
                    ?? previousUpdatedAt,
                );
              }
            } catch (snapshotError) {
              const latestEnvironment = useEnvironmentStore
                .getState()
                .getEnvironmentById(environment.id);
              if (latestEnvironment?.agentActivityUpdatedAt === observedAt) {
                reconcileAgentActivity(previousState, previousUpdatedAt);
              }
              console.warn(
                "[GlobalActivityMonitor] Failed to refresh agent activity:",
                snapshotError,
              );
            }
          }
          console.warn(
            "[GlobalActivityMonitor] Failed to persist agent activity state:",
            error,
          );
        });

    });

    return () => unregisterStateCallback(callbackId);
  }, [
    registerStateCallback,
    setContainerState,
    unregisterStateCallback,
  ]);

  // ── Terminal mode: poll ALL running container environments ──────────
  useEffect(() => {
    const runningContainers = environments.filter(
      (e) =>
        e.environmentType !== "local" &&
        e.status === "running" &&
        e.containerId
    );
    const currentContainerIds = new Set(
      runningContainers.map((e) => e.containerId!)
    );

    // Start polling for newly running containers
    for (const env of runningContainers) {
      const cid = env.containerId!;
      if (activePollers.current.has(cid)) continue;

      const registration = createPollSubscriptionId(cid);
      activePollers.current.set(cid, registration);
      const eventName = `claude-state-${cid}`;

      listen<ClaudeStateEvent>(eventName, (event) => {
        const state = event.payload.state as AgentActivityState;
        const occurredAt = event.payload.occurred_at;
        if (
          occurredAt !== undefined
          && !Number.isFinite(parseUsableAgentActivityTime(occurredAt))
        ) {
          return;
        }
        if (state === "working" || state === "waiting" || state === "idle") {
          const previousState = useAgentActivityStore
            .getState()
            .getContainerState(env.id);
          setEnvironmentSourceActivity(
            activitySources,
            env.id,
            "claude-terminal",
            state,
            setContainerState,
            occurredAt,
            // Terminal polling commits its own `claude-terminal` source before
            // emitting. Re-persisting this event as `frontend` would leave a
            // duplicate working source behind if a later terminal event were
            // missed while this renderer was inactive.
            false,
          );
          const newState = useAgentActivityStore
            .getState()
            .getContainerState(env.id);
          if (isEnvironmentCompletionTransition(previousState, newState)) {
            markCompleted(env.id);
          } else if (isEnvironmentActivityTransition(previousState, newState)) {
            recordActivity(env.id);
          }
        }
      })
        .then((unlisten) => {
          if (activePollers.current.get(cid) !== registration) {
            unlisten();
            return;
          }
          activeListeners.current.set(cid, unlisten);
          const releaseRegistration = () => {
            void backend.stopClaudeStatePolling(cid, registration).catch(
              () => undefined,
            );
          };
          const startPolling = (attempt: number) => {
            if (activePollers.current.get(cid) !== registration) return;
            void backend.startClaudeStatePolling(cid, registration)
              .then(() => {
                if (activePollers.current.get(cid) !== registration) {
                  // The environment stopped while the start request was in
                  // flight. Release again so a late backend start cannot leak.
                  releaseRegistration();
                }
              })
              .catch((e) => {
                console.warn(
                  "[GlobalActivityMonitor] Failed to start polling for",
                  cid,
                  e
                );
                if (activePollers.current.get(cid) !== registration) {
                  // A transport failure can be ambiguous: the backend may
                  // already have accepted the idempotent registration.
                  releaseRegistration();
                  return;
                }
                if (attempt + 1 >= MAX_POLL_START_ATTEMPTS) {
                  // Retrying forever would warn every 30s for the life of the
                  // environment without ever recovering. Say so once and stop.
                  console.error(
                    "[GlobalActivityMonitor] Giving up on terminal state polling for",
                    cid,
                    `after ${MAX_POLL_START_ATTEMPTS} attempts; agent activity for this environment will not update.`,
                  );
                  return;
                }
                const retryTimer = setTimeout(() => {
                  pollRetryTimers.current.delete(cid);
                  startPolling(attempt + 1);
                }, attempt === 0 ? 0 : 250 * (2 ** (attempt - 1)));
                pollRetryTimers.current.set(cid, retryTimer);
              });
          };
          startPolling(0);
        })
        .catch((e) => {
          console.error(
            "[GlobalActivityMonitor] Failed to listen for",
            eventName,
            e
          );
          if (activePollers.current.get(cid) === registration) {
            activePollers.current.delete(cid);
          }
        });
    }

    // Stop polling for containers that are no longer running
    for (const cid of activePollers.current.keys()) {
      if (!currentContainerIds.has(cid)) {
        const registration = activePollers.current.get(cid);
        activePollers.current.delete(cid);
        const retryTimer = pollRetryTimers.current.get(cid);
        if (retryTimer) {
          clearTimeout(retryTimer);
          pollRetryTimers.current.delete(cid);
        }
        const unlisten = activeListeners.current.get(cid);
        if (unlisten) {
          unlisten();
          activeListeners.current.delete(cid);
        }
        if (!registration) continue;
        backend.stopClaudeStatePolling(cid, registration).catch((e) => {
          console.warn(
            "[GlobalActivityMonitor] Failed to stop polling for",
            cid,
            e
          );
        });
      }
    }
  }, [environments, markCompleted, recordActivity, setContainerState]);

  // Cleanup all polling on unmount (app shutdown)
  useEffect(() => {
    return () => {
      for (const [cid, registration] of activePollers.current) {
        activeListeners.current.get(cid)?.();
        backend.stopClaudeStatePolling(cid, registration).catch(() => {});
      }
      for (const timer of pollRetryTimers.current.values()) {
        clearTimeout(timer);
      }
      activePollers.current.clear();
      activeListeners.current.clear();
      pollRetryTimers.current.clear();
    };
  }, []);

  // ── Native Claude mode: derive activity from session store ─────────
  // The SSE subscriptions persist when components unmount, so the session
  // store keeps receiving updates. We subscribe here to reactively derive
  // the activity state for the sidebar.
  useEffect(
    () =>
      subscribeNativeActivity(
        useClaudeStore,
        {
          source: "claude",
          watched: (state) => [
            state.sessions,
            state.clients,
            state.pendingQuestions,
            state.pendingPlanApprovals,
          ],
          isWaiting: (state, _sessionKey, session) =>
            Array.from(state.pendingQuestions.values()).some(
              (question) => question.sessionId === session.sessionId,
            )
            || Array.from(state.pendingPlanApprovals.values()).some(
              (approval) => approval.sessionId === session.sessionId,
            ),
        },
        activitySources,
        setContainerState,
        recordActivity,
        markCompleted,
      ),
    [markCompleted, recordActivity, setContainerState],
  );

  // ── Claude tmux mode: derive activity from hydrated tmux tab state ──
  // Tmux mode has its own backend lifecycle (`running`) and turn lifecycle
  // (`busy`). The sidebar icon should match native mode: blue while Claude is
  // mid-turn, amber when a hook card is waiting for input, green when idle.
  useEffect(() => {
    syncClaudeTmuxActivityState(
      useClaudeTmuxStore.getState().tabs,
      undefined,
      activitySources,
      setContainerState,
    );

    const unsubscribe = useClaudeTmuxStore.subscribe((state, prevState) => {
      if (state.tabs === prevState.tabs) {
        return;
      }

      syncClaudeTmuxActivityState(
        state.tabs,
        prevState.tabs,
        activitySources,
        setContainerState,
        recordActivity,
        markCompleted,
      );
    });

    return unsubscribe;
  }, [markCompleted, recordActivity, setContainerState]);

  // ── Native OpenCode mode: derive activity from session store ───────
  useEffect(
    () =>
      subscribeNativeActivity(
        useOpenCodeStore,
        {
          source: "opencode",
          watched: (state) => [
            state.sessions,
            state.clients,
            state.pendingQuestions,
            state.pendingPermissions,
          ],
          isWaiting: (state, _sessionKey, session) =>
            Array.from(state.pendingQuestions.values()).some(
              (question) => question.sessionId === session.sessionId,
            )
            || Array.from(state.pendingPermissions.values()).some(
              (permission) => permission.sessionId === session.sessionId,
            ),
        },
        activitySources,
        setContainerState,
        recordActivity,
        markCompleted,
      ),
    [markCompleted, recordActivity, setContainerState],
  );
  // ── Native Codex mode: derive activity from session store ──────────
  // Codex SSE streams close on unmount, so state may go stale for background
  // environments. The last-known state is preserved until the component
  // remounts and reconnects.
  useEffect(
    () =>
      subscribeNativeActivity(
        useCodexStore,
        {
          source: "codex",
          watched: (state) => [
            state.sessions,
            state.clients,
            state.pendingApprovals,
          ],
          // Approvals are keyed by sessionKey rather than looked up by session
          // id, so this reads the key rather than the session.
          isWaiting: (state, sessionKey) =>
            (state.pendingApprovals.get(sessionKey)?.length ?? 0) > 0,
        },
        activitySources,
        setContainerState,
        recordActivity,
        markCompleted,
      ),
    [markCompleted, recordActivity, setContainerState],
  );
  // Terminal-mode activity is detected by the backend PTY so it continues to
  // work while an environment's React tree is inactive. Apply the persisted
  // timestamp event as an incremental update; environment snapshots remain the
  // source of truth when this listener was not mounted.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<EnvironmentActivityRecordedEvent>(
      "environment-activity-recorded",
      (event) => {
        const {
          environment_id: environmentId,
          occurred_at: occurredAt,
          activity_kind: activityKind,
        } = event.payload;
        const occurredTime = Date.parse(occurredAt);
        if (!Number.isFinite(occurredTime)) return;

        const environment = useEnvironmentStore
          .getState()
          .getEnvironmentById(environmentId);
        if (!environment) return;
        const currentTime = environment.lastActivityAt
          ? Date.parse(environment.lastActivityAt)
          : Number.NEGATIVE_INFINITY;
        if (Number.isFinite(currentTime) && currentTime >= occurredTime) return;

        useEnvironmentStore.getState().updateEnvironment(environmentId, {
          lastActivityAt: new Date(occurredTime).toISOString(),
          ...(activityKind === "completed" ? { hasUnreadWork: true } : {}),
        });
      },
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => {
      console.warn(
        "[GlobalActivityMonitor] Failed to listen for terminal activity:",
        error,
      );
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
