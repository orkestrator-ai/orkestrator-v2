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
import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@/lib/native/events";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores";
import {
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
  if (current === "waiting" || next === "waiting") return "waiting";
  if (current === "working" || next === "working") return "working";
  return "idle";
}

type ClaudeTmuxTabs = ReturnType<typeof useClaudeTmuxStore.getState>["tabs"];
type SetContainerState = ReturnType<
  typeof useAgentActivityStore.getState
>["setContainerState"];

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
  setContainerState: SetContainerState,
): void {
  const desiredByEnvironment = new Map<string, AgentActivityState>();
  const seenEnvironmentIds = new Set<string>();

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
    const currentState =
      useAgentActivityStore.getState().containerStates[envId];
    if (currentState !== desiredState) {
      setContainerState(envId, desiredState);
    }
  }
}

export function useGlobalActivityMonitor(): void {
  const environments = useEnvironmentStore((s) => s.environments);
  const setContainerState = useAgentActivityStore((s) => s.setContainerState);

  // Track active pollers and listeners for container environments
  const activePollers = useRef(new Set<string>());
  const activeListeners = useRef(new Map<string, UnlistenFn>());

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

      activePollers.current.add(cid);
      const eventName = `claude-state-${cid}`;

      listen<ClaudeStateEvent>(eventName, (event) => {
        const state = event.payload.state as AgentActivityState;
        if (state === "working" || state === "waiting" || state === "idle") {
          setContainerState(event.payload.container_id, state);
        }
      })
        .then((unlisten) => {
          activeListeners.current.set(cid, unlisten);
          backend.startClaudeStatePolling(cid).catch((e) => {
            console.warn(
              "[GlobalActivityMonitor] Failed to start polling for",
              cid,
              e
            );
          });
        })
        .catch((e) => {
          console.error(
            "[GlobalActivityMonitor] Failed to listen for",
            eventName,
            e
          );
          activePollers.current.delete(cid);
        });
    }

    // Stop polling for containers that are no longer running
    for (const cid of activePollers.current) {
      if (!currentContainerIds.has(cid)) {
        activePollers.current.delete(cid);
        const unlisten = activeListeners.current.get(cid);
        if (unlisten) {
          unlisten();
          activeListeners.current.delete(cid);
        }
        backend.stopClaudeStatePolling(cid).catch((e) => {
          console.warn(
            "[GlobalActivityMonitor] Failed to stop polling for",
            cid,
            e
          );
        });
      }
    }
  }, [environments, setContainerState]);

  // Cleanup all polling on unmount (app shutdown)
  useEffect(() => {
    return () => {
      for (const [cid, unlisten] of activeListeners.current) {
        unlisten();
        backend.stopClaudeStatePolling(cid).catch(() => {});
      }
      activePollers.current.clear();
      activeListeners.current.clear();
    };
  }, []);

  // ── Native Claude mode: derive activity from session store ─────────
  // The SSE subscriptions persist when components unmount, so the session
  // store keeps receiving updates. We subscribe here to reactively derive
  // the activity state for the sidebar.
  // Only update when a client exists for the environment (i.e. connected).
  // When disconnected, preserve the last-known state to avoid flashing
  // the sidebar icon to idle during transient SSE reconnections.
  useEffect(() => {
    const unsubscribe = useClaudeStore.subscribe((state, prevState) => {
      // Quick bailout: skip if nothing relevant changed
      if (
        state.sessions === prevState.sessions &&
        state.pendingQuestions === prevState.pendingQuestions
      ) {
        return;
      }

      for (const [sessionKey, session] of state.sessions) {
        const envId = extractEnvironmentId(sessionKey);
        if (!envId) continue;

        // Only derive state when connected (client exists). When the
        // client is absent the SSE connection is down — preserve the
        // last-known activity state to avoid flashing idle.
        if (!state.clients.has(envId)) continue;

        let desiredState: AgentActivityState;
        if (session.isLoading) {
          desiredState = "working";
        } else {
          // Check for pending questions for this specific session
          const hasPendingQuestions = Array.from(
            state.pendingQuestions.values()
          ).some((q) => q.sessionId === session.sessionId);
          desiredState = hasPendingQuestions ? "waiting" : "idle";
        }

        const currentState =
          useAgentActivityStore.getState().containerStates[envId];
        if (currentState !== desiredState) {
          setContainerState(envId, desiredState);
        }
      }
    });

    return unsubscribe;
  }, [setContainerState]);

  // ── Claude tmux mode: derive activity from hydrated tmux tab state ──
  // Tmux mode has its own backend lifecycle (`running`) and turn lifecycle
  // (`busy`). The sidebar icon should match native mode: blue while Claude is
  // mid-turn, amber when a hook card is waiting for input, green when idle.
  useEffect(() => {
    syncClaudeTmuxActivityState(
      useClaudeTmuxStore.getState().tabs,
      undefined,
      setContainerState,
    );

    const unsubscribe = useClaudeTmuxStore.subscribe((state, prevState) => {
      if (state.tabs === prevState.tabs) {
        return;
      }

      syncClaudeTmuxActivityState(
        state.tabs,
        prevState.tabs,
        setContainerState,
      );
    });

    return unsubscribe;
  }, [setContainerState]);

  // ── Native OpenCode mode: derive activity from session store ───────
  useEffect(() => {
    const unsubscribe = useOpenCodeStore.subscribe((state, prevState) => {
      if (
        state.sessions === prevState.sessions &&
        state.pendingQuestions === prevState.pendingQuestions &&
        state.pendingPermissions === prevState.pendingPermissions
      ) {
        return;
      }

      for (const [sessionKey, session] of state.sessions) {
        const envId = extractEnvironmentId(sessionKey);
        if (!envId) continue;

        if (!state.clients.has(envId)) continue;

        let desiredState: AgentActivityState;
        if (session.isLoading) {
          desiredState = "working";
        } else {
          const hasPendingQuestions = Array.from(
            state.pendingQuestions.values()
          ).some((q) => q.sessionID === session.sessionId);
          const hasPendingPermissions = Array.from(
            state.pendingPermissions.values()
          ).some((p) => p.sessionID === session.sessionId);
          desiredState =
            hasPendingQuestions || hasPendingPermissions ? "waiting" : "idle";
        }

        const currentState =
          useAgentActivityStore.getState().containerStates[envId];
        if (currentState !== desiredState) {
          setContainerState(envId, desiredState);
        }
      }
    });

    return unsubscribe;
  }, [setContainerState]);

  // ── Native Codex mode: derive activity from session store ──────────
  // Codex SSE streams close on unmount, so state may go stale for
  // background environments. The last-known state is preserved until
  // the component remounts and reconnects.
  useEffect(() => {
    const unsubscribe = useCodexStore.subscribe((state, prevState) => {
      if (state.sessions === prevState.sessions) {
        return;
      }

      for (const [sessionKey, session] of state.sessions) {
        const envId = extractEnvironmentId(sessionKey);
        if (!envId) continue;

        if (!state.clients.has(envId)) continue;

        const desiredState: AgentActivityState = session.isLoading
          ? "working"
          : "idle";

        const currentState =
          useAgentActivityStore.getState().containerStates[envId];
        if (currentState !== desiredState) {
          setContainerState(envId, desiredState);
        }
      }
    });

    return unsubscribe;
  }, [setContainerState]);
}
