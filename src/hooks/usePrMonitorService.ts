/**
 * PR Monitor Service Hook
 *
 * This is a singleton-like hook that should be mounted once at the app root level.
 * It manages centralized PR monitoring with mode-based polling intervals.
 *
 * Key responsibilities:
 * - Runs a 1-second tick loop to check if environments need polling
 * - Only polls the active environment (non-active environments are "idle")
 * - Subscribes to environment switches and agent idle events
 * - Performs PR detection and updates the environment store
 */

import { useEffect, useRef, useCallback } from "react";
import {
  usePrMonitorStore,
  PR_MONITOR_TIMEOUTS,
  getEffectiveInterval,
} from "@/stores/prMonitorStore";
import { useEnvironmentStore, useUIStore, useAgentActivityStore } from "@/stores";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import * as tauri from "@/lib/tauri";
import type { PrDetectionResult } from "@/lib/tauri";
import type { PrState } from "@/types";

/** How often the tick loop runs (1 second) */
const TICK_INTERVAL_MS = 1000;

/**
 * Result of a PR detection attempt.
 * Discriminated union to distinguish between:
 * - success: PR was found
 * - not-found: No PR exists for this branch (not an error)
 * - error: An actual error occurred during detection
 */
type DetectionResult =
  | { status: "success"; data: PrDetectionResult }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

/**
 * Perform a PR detection for an environment.
 * Returns a discriminated union to distinguish between no PR and actual errors.
 */
async function detectPR(
  environmentId: string,
  containerId: string | null,
  isLocal: boolean,
  branch: string
): Promise<DetectionResult> {
  if (!environmentId) return { status: "not-found" };
  if (!isLocal && !containerId) return { status: "not-found" };

  try {
    const result = isLocal
      ? await tauri.detectPrLocal(environmentId, branch)
      : await tauri.detectPr(containerId!, branch);

    if (result) {
      return { status: "success", data: result };
    }
    return { status: "not-found" };
  } catch (error) {
    // Log actual errors at warn level, not debug
    console.warn("[PrMonitorService] Detection error:", error);
    return { status: "error", error };
  }
}

/**
 * Save PR state to both backend (Tauri) and frontend (Zustand) stores.
 * Only updates state on successful detection or when clearing a previously stored PR.
 */
async function savePRState(
  environmentId: string,
  detectionResult: DetectionResult,
  currentPrUrl: string | null,
  currentPrState: PrState | null,
  setEnvironmentPR: (
    id: string,
    url: string | null,
    state: PrState | null,
    conflicts: boolean | null
  ) => void
): Promise<void> {
  if (detectionResult.status === "success") {
    const { data } = detectionResult;
    // Save to backend
    await tauri.setEnvironmentPr(
      environmentId,
      data.url,
      data.state,
      data.hasMergeConflicts
    );
    // Update frontend store
    setEnvironmentPR(
      environmentId,
      data.url,
      data.state,
      data.hasMergeConflicts
    );
  } else if (detectionResult.status === "not-found" && currentPrUrl) {
    // No PR found but we had one stored.
    // IMPORTANT: Don't clear if the PR is in a "finished" state (merged/closed).
    // After a PR is merged with --delete-branch, the container checks out the base branch
    // (e.g., main), causing subsequent `gh pr view` calls to fail. We preserve the
    // merged/closed state that was saved immediately after the merge command succeeded.
    if (currentPrState === "merged" || currentPrState === "closed") {
      console.log(
        `[PrMonitorService] Detection returned not-found but PR state is ${currentPrState}, preserving state`
      );
      return;
    }
    // Only clear for open PRs - this handles cases where the PR was deleted/removed
    await tauri.clearEnvironmentPr(environmentId);
    setEnvironmentPR(environmentId, null, null, null);
  }
  // On error, keep existing state - don't update
}

/**
 * Service hook that manages the PR monitoring polling loop.
 * Should be mounted once at the app root level.
 */
export function usePrMonitorService(): void {
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isInitializedRef = useRef(false);

  // Get store actions (these are stable references)
  const {
    startMonitoring,
    setMonitoringMode,
    setActiveEnvironment,
    getMonitoringState,
    _setCheckInProgress,
    _updateLastCheckTime,
    _resetErrors,
    _incrementErrors,
  } = usePrMonitorStore();

  const { registerStateCallback, unregisterStateCallback } = useAgentActivityStore();

  /**
   * Perform a single PR check for an environment.
   * Handles concurrency guards, error tracking, and mode transitions.
   */
  const performCheck = useCallback(
    async (environmentId: string) => {
      const monitorState = usePrMonitorStore.getState().getMonitoringState(environmentId);
      if (!monitorState) {
        console.debug(`[PrMonitorService] No monitor state for ${environmentId}`);
        return;
      }

      if (monitorState.checkInProgress) {
        console.debug(`[PrMonitorService] Check already in progress for ${environmentId}`);
        return;
      }

      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (!environment) {
        console.debug(`[PrMonitorService] Environment not found: ${environmentId}`);
        return;
      }

      const isLocal = environment.environmentType === "local";
      const isRunning = isLocal
        ? !!environment.worktreePath
        : environment.status === "running";
      const workspaceReady = useEnvironmentStore.getState().isWorkspaceReady(environmentId);

      if (!isRunning || !workspaceReady) {
        console.debug(
          `[PrMonitorService] Skipping check for ${environmentId} - not ready (running: ${isRunning}, workspace: ${workspaceReady})`
        );
        return;
      }

      console.log(`[PrMonitorService] Performing PR check for ${environmentId} (mode: ${monitorState.mode})`);
      _setCheckInProgress(environmentId, true);

      try {
        const detectionResult = await detectPR(environmentId, environment.containerId ?? null, isLocal, environment.branch);

        // Only increment errors on actual errors, not on "not found"
        if (detectionResult.status === "error") {
          _incrementErrors(environmentId);
        } else {
          _resetErrors(environmentId);
        }

        await savePRState(
          environmentId,
          detectionResult,
          environment.prUrl ?? null,
          environment.prState ?? null,
          useEnvironmentStore.getState().setEnvironmentPR
        );

        // When a PR transitions to "merged", move the associated kanban task to "review"
        if (
          detectionResult.status === "success" &&
          detectionResult.data.state === "merged" &&
          environment.prState !== "merged"
        ) {
          try {
            // Find the task via kanban store (by environmentId) or build pipeline store
            const kanbanState = useKanbanStore.getState();
            const taskInStore = kanbanState.tasks.find((t) => t.environmentId === environmentId);
            let taskId = taskInStore?.id;

            if (!taskId) {
              const pipeline = Array.from(useBuildPipelineStore.getState().pipelines.values())
                .find((p) => p.environmentId === environmentId);
              taskId = pipeline?.taskId;
            }

            if (taskId) {
              // Only advance tasks that are currently in-progress to avoid
              // regressing tasks that have already moved to "done".
              const currentStatus = taskInStore?.status;
              if (currentStatus === "in-progress") {
                await kanbanState.moveTask(taskId, "review");
                console.log(`[PrMonitorService] PR merged, moved task ${taskId} to review`);
              } else if (!taskInStore) {
                // Task not loaded in store (found via pipeline); update backend directly
                await kanbanState.updateTask(taskId, { status: "review" });
                console.log(`[PrMonitorService] PR merged, moved task ${taskId} to review (via pipeline)`);
              }
            }
          } catch (error) {
            console.warn("[PrMonitorService] Failed to move task to review after PR merge:", error);
          }
        }

        // Handle mode transitions based on result
        const currentMode = usePrMonitorStore.getState().getMonitoringState(environmentId)?.mode;

        // create-pending → normal: When PR is detected
        if (currentMode === "create-pending" && detectionResult.status === "success") {
          console.log(`[PrMonitorService] PR detected, transitioning ${environmentId} from create-pending to normal`);
          setMonitoringMode(environmentId, "normal");
        }

        // merge-pending → normal: When PR state becomes merged/closed
        if (currentMode === "merge-pending" && detectionResult.status === "success") {
          const prState = detectionResult.data.state;
          if (prState === "merged" || prState === "closed") {
            console.log(
              `[PrMonitorService] PR ${prState}, transitioning ${environmentId} from merge-pending to normal`
            );
            setMonitoringMode(environmentId, "normal");
          }
        }
      } catch (error) {
        // This catch is for unexpected errors in savePRState or mode transitions
        console.error(`[PrMonitorService] Unexpected error for ${environmentId}:`, error);
        _incrementErrors(environmentId);
      } finally {
        _setCheckInProgress(environmentId, false);
        _updateLastCheckTime(environmentId);
      }
    },
    [_setCheckInProgress, _updateLastCheckTime, _resetErrors, _incrementErrors, setMonitoringMode]
  );

  /**
   * Main tick function - runs every second to check if any environment needs polling.
   *
   * Note: This callback uses getState() to access fresh store state on each tick,
   * avoiding stale closure issues. The setInterval in the mount effect captures this
   * callback, but since we read state dynamically, it remains current.
   */
  const tick = useCallback(() => {
    const now = Date.now();
    const state = usePrMonitorStore.getState();
    const activeEnvId = state.activeEnvironmentId;

    if (!activeEnvId) return;

    const monitorState = state.monitoredEnvironments[activeEnvId];
    if (!monitorState) return;

    const { mode, consecutiveErrors } = monitorState;

    // Calculate effective interval with exponential backoff for errors
    const interval = getEffectiveInterval(mode, consecutiveErrors);

    // Skip if idle mode (interval is Infinity)
    if (interval === Infinity) return;

    // Check mode timeout (e.g., merge-pending should revert to normal after 20s)
    const modeTimeout = PR_MONITOR_TIMEOUTS[mode];
    if (modeTimeout && now - monitorState.modeStartTime > modeTimeout) {
      console.log(`[PrMonitorService] Mode timeout for ${activeEnvId}, reverting to normal`);
      usePrMonitorStore.getState().setMonitoringMode(activeEnvId, "normal");
      // Trigger immediate check after mode timeout to ensure we have fresh state
      performCheck(activeEnvId);
      return;
    }

    // Check if enough time has passed since last check
    const timeSinceLastCheck = now - monitorState.lastCheckTime;
    if (timeSinceLastCheck >= interval) {
      performCheck(activeEnvId);
    }
  }, [performCheck]);

  // Start the tick loop on mount
  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;

    console.log("[PrMonitorService] Starting tick loop");
    tickIntervalRef.current = setInterval(tick, TICK_INTERVAL_MS);

    return () => {
      if (tickIntervalRef.current) {
        console.log("[PrMonitorService] Stopping tick loop");
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      isInitializedRef.current = false;
    };
  }, [tick]);

  // Track previous selectedEnvironmentId for change detection
  const prevSelectedEnvIdRef = useRef<string | null>(null);

  // Subscribe to active environment changes (selectedEnvironmentId in uiStore)
  useEffect(() => {
    // Handle initial environment if one is already selected
    const initialEnvId = useUIStore.getState().selectedEnvironmentId;
    prevSelectedEnvIdRef.current = initialEnvId;

    if (initialEnvId) {
      console.log(`[PrMonitorService] Initial environment: ${initialEnvId}`);
      setActiveEnvironment(initialEnvId);
      const existingState = getMonitoringState(initialEnvId);
      if (!existingState) {
        startMonitoring(initialEnvId, "normal");
      } else {
        setMonitoringMode(initialEnvId, "normal");
      }
      // Trigger immediate check
      performCheck(initialEnvId);
    }

    // Subscribe to changes
    const unsub = useUIStore.subscribe((state) => {
      const newId = state.selectedEnvironmentId;
      const prevId = prevSelectedEnvIdRef.current;

      // Only process if there's an actual change
      if (newId === prevId) return;

      console.log(`[PrMonitorService] Environment switched: ${prevId} -> ${newId}`);
      prevSelectedEnvIdRef.current = newId;

      // Set previous environment to idle
      if (prevId) {
        const prevMonitorState = usePrMonitorStore.getState().getMonitoringState(prevId);
        if (prevMonitorState) {
          // If it was in create-pending, it loses focus so revert to idle
          // (create-pending stops when environment loses focus)
          setMonitoringMode(prevId, "idle");
        }
      }

      // Start monitoring new environment
      if (newId) {
        setActiveEnvironment(newId);
        const existingState = usePrMonitorStore.getState().getMonitoringState(newId);
        if (!existingState) {
          startMonitoring(newId, "normal");
        } else {
          setMonitoringMode(newId, "normal");
        }
        // Trigger immediate check on environment switch
        performCheck(newId);
      } else {
        setActiveEnvironment(null);
      }
    });

    return unsub;
  }, [
    setActiveEnvironment,
    startMonitoring,
    setMonitoringMode,
    getMonitoringState,
    performCheck,
  ]);

  // Subscribe to Claude/Agent idle transitions
  useEffect(() => {
    const callbackId = registerStateCallback((containerId, prevState, newState) => {
      if (newState === "idle" && prevState !== "idle") {
        // Find environment by containerId or environmentId (for local envs)
        const envs = useEnvironmentStore.getState().environments;
        const env = envs.find(
          (e) => e.containerId === containerId || e.id === containerId
        );

        if (env) {
          const activeEnvId = usePrMonitorStore.getState().activeEnvironmentId;
          // Only trigger check if this is the active environment
          if (env.id === activeEnvId) {
            console.log(
              `[PrMonitorService] Agent became idle for active environment ${env.id}, triggering check`
            );
            performCheck(env.id);
          }
        }
      }
    });

    return () => {
      unregisterStateCallback(callbackId);
    };
  }, [registerStateCallback, unregisterStateCallback, performCheck]);

  // Track previous workspace ready set for change detection
  const prevWorkspaceReadyRef = useRef<Set<string>>(new Set());

  // Subscribe to workspace ready changes - trigger check when workspace becomes ready
  useEffect(() => {
    // Initialize with current state
    prevWorkspaceReadyRef.current = new Set(useEnvironmentStore.getState().workspaceReadyEnvironments);

    const unsub = useEnvironmentStore.subscribe((state) => {
      const newSet = state.workspaceReadyEnvironments;
      const prevSet = prevWorkspaceReadyRef.current;

      // Find environments that just became ready
      const activeEnvId = usePrMonitorStore.getState().activeEnvironmentId;
      if (!activeEnvId) {
        prevWorkspaceReadyRef.current = new Set(newSet);
        return;
      }

      const wasReady = prevSet.has(activeEnvId);
      const isNowReady = newSet.has(activeEnvId);

      if (!wasReady && isNowReady) {
        console.log(`[PrMonitorService] Workspace became ready for ${activeEnvId}, triggering check`);
        performCheck(activeEnvId);
      }

      // Update previous state
      prevWorkspaceReadyRef.current = new Set(newSet);
    });

    return unsub;
  }, [performCheck]);
}
