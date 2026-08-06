// Hook for managing environment operations with Electron backend
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { toast } from "sonner";
import { createSessionKey, useBuildPipelineStore, useClaudeOptionsStore, useConfigStore, useEnvironmentStore, useErrorDialogStore, useTerminalSessionStore } from "@/stores";
import { useSessionStore } from "@/stores/sessionStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import * as backend from "@/lib/backend";
import { clearStoredPaneSelection } from "@/lib/pane-selection-storage";
import type { Environment, EnvironmentType, NetworkAccessMode, PortMapping, PrState } from "@/types";

/**
 * Extract error message from various error types.
 * Electron errors can come as plain strings, Error objects, or objects with error info.
 */
function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return fallback;
}

/**
 * Truncate a message for display in toast notifications.
 * Full message can be shown via the Details dialog.
 */
function truncateForToast(message: string, maxLength = 50): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

/** Payload emitted when an environment is renamed in the background */
interface EnvironmentRenamedPayload {
  environment_id: string;
  new_name: string;
  new_branch: string;
}

interface EnvironmentSetupStartedPayload {
  environment_id: string;
  session_id: string;
  environment?: Environment;
}

interface EnvironmentSetupCompletePayload {
  environment_id: string;
  success: boolean;
  environment?: Environment;
  error?: string;
}

interface UseEnvironmentsOptions {
  listenForRenameEvents?: boolean;
}

interface LoadEnvironmentsOptions {
  /** Refresh store data without changing user-visible loading or error state. */
  silent?: boolean;
  /** Reconcile persisted container state with Docker before returning the list. */
  reconcileStatus?: boolean;
}

export interface StartEnvironmentOptions {
  /**
   * Suppress the success toast for callers that own the surrounding workflow.
   * Only meaningful without `background`, which never reports success at all.
   */
  silent?: boolean;
  /**
   * Return after the backend accepts the start. Docker provisioning and setup
   * continue in a backend-owned task and publish authoritative state changes.
   *
   * Implies no success toast: acceptance is not completion, so there is nothing
   * truthful to report yet. The outcome reaches the user through the persisted
   * status and `lifecycleError` instead. A rejected *acceptance* still throws
   * and still reports, so a bad request is not silently swallowed.
   */
  background?: boolean;
  /**
   * Suppress the failure toast for callers that report the failure under their
   * own title (restart). The failure is still recorded as reported, so the
   * durable reconciliation below stays quiet either way.
   */
  suppressFailureToast?: boolean;
}

interface EnvironmentCreationState {
  generation: number;
  activeCreations: number;
}

const environmentCreationStateByProject = new Map<string, EnvironmentCreationState>();

function getEnvironmentCreationState(projectId: string): EnvironmentCreationState {
  return environmentCreationStateByProject.get(projectId) ?? {
    generation: 0,
    activeCreations: 0,
  };
}

function beginEnvironmentCreation(projectId: string): void {
  const current = getEnvironmentCreationState(projectId);
  environmentCreationStateByProject.set(projectId, {
    generation: current.generation + 1,
    activeCreations: current.activeCreations + 1,
  });
}

function finishEnvironmentCreation(projectId: string): void {
  const current = getEnvironmentCreationState(projectId);
  environmentCreationStateByProject.set(projectId, {
    generation: current.generation + 1,
    activeCreations: Math.max(0, current.activeCreations - 1),
  });
}

function bindSetupTerminalSession(environment: Environment, sessionId: string): void {
  const key = createSessionKey(environment.containerId ?? null, "default", environment.id);
  const store = useTerminalSessionStore.getState();
  const existing = store.sessions.get(key);
  console.info("[setup-terminal] binding setup session from environment hook", {
    environmentId: environment.id,
    environmentName: environment.name,
    environmentType: environment.environmentType,
    containerId: environment.containerId ?? null,
    key,
    previousSessionId: existing?.sessionId ?? null,
    nextSessionId: sessionId,
    hadSerializedBuffer: !!existing?.serializedBuffer,
    serializedBufferChars: existing?.serializedBuffer?.length ?? 0,
  });
  store.setSession(key, {
    ...existing,
    sessionId,
  });
}

/** Stop store-owned background subscriptions after backend deletion succeeds. */
export function cleanupDeletedEnvironmentSubscriptions(environmentId: string): void {
  useClaudeStore.getState().closeEventSubscription(environmentId);
  useOpenCodeStore.getState().closeEventSubscription(environmentId);
}

/**
 * Stop background subscriptions for environments an authoritative project
 * snapshot removed. Other projects are deliberately outside this snapshot's
 * scope and surviving IDs keep their existing long-lived subscriptions.
 */
export function cleanupSubscriptionsRemovedByProjectSnapshot(
  projectId: string,
  nextEnvironments: readonly Environment[],
): void {
  const nextIds = new Set(nextEnvironments.map((environment) => environment.id));
  for (const environment of useEnvironmentStore.getState().environments) {
    if (environment.projectId === projectId && !nextIds.has(environment.id)) {
      cleanupDeletedEnvironmentSubscriptions(environment.id);
    }
  }
}

let setupSnapshotReconciliation: Promise<void> | null = null;
let setupSnapshotReconcileRequested = false;

interface LifecycleAttemptState {
  attempt: number;
  revision: number;
  pending: boolean;
}

interface ForegroundLifecycleErrorReport {
  attempt: number;
  kind: "foreground";
}

const lifecycleAttemptStateByEnvironment = new Map<string, LifecycleAttemptState>();
const reportedLifecycleErrorByEnvironment = new Map<
  string,
  string | ForegroundLifecycleErrorReport
>();

function beginLifecycleAttempt(environmentId: string): number {
  const previous = lifecycleAttemptStateByEnvironment.get(environmentId);
  const attempt = (previous?.attempt ?? 0) + 1;
  lifecycleAttemptStateByEnvironment.set(environmentId, {
    attempt,
    revision: (previous?.revision ?? 0) + 1,
    pending: true,
  });
  // A claim belongs to one specific attempt. In particular, an admission
  // rejection must never suppress the durable failure from a later retry.
  reportedLifecycleErrorByEnvironment.delete(environmentId);
  return attempt;
}

function finishLifecycleAttemptAdmission(environmentId: string, attempt: number): void {
  const current = lifecycleAttemptStateByEnvironment.get(environmentId);
  if (!current || current.attempt !== attempt) return;
  lifecycleAttemptStateByEnvironment.set(environmentId, {
    ...current,
    revision: current.revision + 1,
    pending: false,
  });
}

function lifecycleAttemptRevisions(): Map<string, number> {
  return new Map(
    [...lifecycleAttemptStateByEnvironment].map(([environmentId, state]) => [
      environmentId,
      state.revision,
    ]),
  );
}

/**
 * A snapshot requested before (or while admitting) a retry can still carry the
 * preceding attempt's error. Preserve the retry-owned fields in that case so
 * the old response cannot resolve setup gates or discard a new launch intent.
 */
function preserveLifecycleAttemptState(
  snapshot: Environment,
  revisionAtRequest: number | undefined,
): { environment: Environment; stale: boolean } {
  const attempt = lifecycleAttemptStateByEnvironment.get(snapshot.id);
  const current = useEnvironmentStore.getState().getEnvironmentById(snapshot.id);
  const stale = Boolean(
    attempt
    && current
    && (attempt.pending || attempt.revision !== revisionAtRequest),
  );
  if (!stale || !current) {
    return { environment: snapshot, stale: false };
  }
  return {
    environment: {
      ...snapshot,
      status: current.status,
      lifecycleError: current.lifecycleError ?? null,
      pendingAgentLaunch: current.pendingAgentLaunch,
    },
    stale: true,
  };
}

/**
 * Claim the report for an environment's current failure on behalf of a
 * foreground start. The backend persists a failure for the same start and
 * announces it, which drives a list refetch; without this claim the
 * reconciliation below would toast the identical failure a second time.
 */
function markLifecycleErrorReportedByForeground(
  environmentId: string,
  attempt: number,
): void {
  reportedLifecycleErrorByEnvironment.set(environmentId, {
    attempt,
    kind: "foreground",
  });
}

/**
 * Resolve a full environment snapshot's `lifecycleError` before it is merged.
 * The backend normalizes a cleared failure to `undefined` and JSON.stringify
 * drops undefined keys, so a healthy environment arrives with the key ABSENT.
 * `updateEnvironment` merges only the keys it is handed, so an absent key would
 * preserve a stale failure — and with it a permanent reconciliation target. A
 * full snapshot is authoritative for this field, so make the absence explicit.
 */
function withAuthoritativeLifecycleError(snapshot: Environment): Environment {
  return snapshot.lifecycleError === undefined
    ? { ...snapshot, lifecycleError: null }
    : snapshot;
}

/**
 * Apply durable lifecycle failures from the environment store. Snapshot reads
 * are the authority because the renderer may have been suspended while a
 * backend-owned start failed. A given persisted error is reported once, then a
 * cleared value rearms reporting so a later retry can surface the same reason.
 *
 * Every path that writes environments into the store calls this: the project
 * list load, both setup lifecycle events, and the snapshot reconciliation.
 */
function reconcileEnvironmentLifecycleErrors(): void {
  const store = useEnvironmentStore.getState();
  const liveEnvironmentIds = new Set(
    store.environments.map((environment) => environment.id),
  );
  for (const environmentId of reportedLifecycleErrorByEnvironment.keys()) {
    if (!liveEnvironmentIds.has(environmentId)) {
      reportedLifecycleErrorByEnvironment.delete(environmentId);
    }
  }
  for (const environmentId of lifecycleAttemptStateByEnvironment.keys()) {
    if (!liveEnvironmentIds.has(environmentId)) {
      lifecycleAttemptStateByEnvironment.delete(environmentId);
    }
  }

  for (const environment of store.environments) {
    const message = environment.lifecycleError?.trim();
    if (!message) {
      reportedLifecycleErrorByEnvironment.delete(environment.id);
      continue;
    }

    // The backend drops the durable launch intent when a start fails; mirror it
    // and the transient renderer-side one, or a launch that can never happen
    // auto-dispatches the original prompt the next time this env is started.
    store.updateEnvironment(environment.id, { pendingAgentLaunch: false });
    const claudeOptions = useClaudeOptionsStore.getState();
    if (claudeOptions.pendingNativeLaunches[environment.id]) {
      claudeOptions.clearPendingNativeLaunch(environment.id);
    }

    const reported = reportedLifecycleErrorByEnvironment.get(environment.id);
    if (reported === message) {
      continue;
    }
    // Record before reporting: the toast action re-enters these stores.
    reportedLifecycleErrorByEnvironment.set(environment.id, message);
    if (
      typeof reported !== "string"
      && reported?.kind === "foreground"
      && reported.attempt
        === lifecycleAttemptStateByEnvironment.get(environment.id)?.attempt
    ) {
      // Same failure the foreground start already toasted, wearing the
      // backend's sanitized wording. Consume the claim instead of repeating it.
      continue;
    }
    store.setError(message);
    toast.error("Failed to start environment", {
      description: truncateForToast(message),
      action: {
        label: "Details",
        onClick: () =>
          useErrorDialogStore
            .getState()
            .showError("Failed to start environment", message),
      },
    });
  }
}

/**
 * Reconcile setup gates from backend snapshots after a mobile browser resumes
 * or its gateway event stream reconnects. Live setup events are intentionally
 * treated as incremental updates: this snapshot is the catch-up path when a
 * suspended browser missed the one-shot completion frame.
 */
export function reconcileEnvironmentSetupSnapshots(): Promise<void> {
  // Coalesce, but never drop. A trigger that arrives after the in-flight reads
  // were issued would otherwise be answered by a snapshot older than the event
  // it is reacting to, so remember it and run one more pass on completion. On
  // mobile resume four triggers fire in a burst, which makes this the norm.
  if (setupSnapshotReconciliation) {
    setupSnapshotReconcileRequested = true;
    return setupSnapshotReconciliation;
  }

  const environmentStore = useEnvironmentStore.getState();
  const targets = environmentStore.environments.filter((environment) =>
    environment.status === "creating"
    || Boolean(environment.lifecycleError)
    || (
      environment.status === "running"
      && (
        environment.setupPhase === "running"
        || environment.pendingAgentLaunch
        || environment.startupAgentSession !== undefined
      )
    )
  );

  if (targets.length === 0) return Promise.resolve();
  const attemptRevisions = lifecycleAttemptRevisions();

  setupSnapshotReconciliation = Promise.all(targets.map(async (environment) => {
    try {
      const snapshot = await backend.getEnvironment(environment.id);
      if (!snapshot) return;

      const store = useEnvironmentStore.getState();
      const protectedSnapshot = preserveLifecycleAttemptState(
        snapshot,
        attemptRevisions.get(environment.id),
      );
      const safeSnapshot = withAuthoritativeLifecycleError(protectedSnapshot.environment);
      store.updateEnvironment(environment.id, safeSnapshot);
      if (protectedSnapshot.stale) return;

      // A failed start has no setup plan to read; the reconciliation below
      // resolves its gates once every snapshot has been merged.
      if (safeSnapshot.lifecycleError) {
        return;
      }

    } catch (error) {
      console.warn(
        `[useEnvironments] Failed to reconcile setup snapshot for ${environment.id}:`,
        error,
      );
    }
  })).then(() => {
    // Once, after every snapshot has been merged. The reconciliation scans the
    // whole store, so calling it per target was O(targets x environments) work
    // — and that many store notifications — for one pass.
    reconcileEnvironmentLifecycleErrors();
  }).finally(() => {
    setupSnapshotReconciliation = null;
    if (setupSnapshotReconcileRequested) {
      setupSnapshotReconcileRequested = false;
      void reconcileEnvironmentSetupSnapshots();
    }
  });

  return setupSnapshotReconciliation;
}

/**
 * Global environment lifecycle listeners.
 *
 * Mounted ONCE at the app root (see App.tsx, alongside the other service hooks
 * such as `usePrMonitorService`). These used to live inside `useEnvironments`,
 * which is mounted at ~5 call sites — every setup event and every
 * pageshow/online/visibility/stream-connected trigger therefore ran five
 * duplicate handlers. All handlers write to global Zustand stores, so a single
 * registration serves every consumer.
 */
export function useEnvironmentLifecycleService(): void {
  // No mount-time lifecycle-error pass on purpose: the environment store has no
  // persisted state, so at mount it is still the empty initial array. The first
  // failure this renderer can see arrives with the first authoritative read,
  // and every one of those reconciles after its own merge.

  // Listen for backend-owned setup lifecycle events. Setup can run while the
  // terminal UI is unmounted, so these events are only incremental updates; the
  // persisted environment remains the source of truth on reload.
  useEffect(() => {
    let unlistenStarted: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;
    let disposed = false;

    const setupListeners = async () => {
      const stopStarted = await listen<EnvironmentSetupStartedPayload>("environment-setup-started", (event) => {
        const { environment_id, session_id, environment } = event.payload;
        console.info("[setup-terminal] received environment-setup-started", {
          environmentId: environment_id,
          sessionId: session_id,
          hasEnvironment: !!environment,
          environmentType: environment?.environmentType ?? null,
          containerId: environment?.containerId ?? null,
        });
        const store = useEnvironmentStore.getState();
        if (environment) {
          store.updateEnvironment(
            environment_id,
            withAuthoritativeLifecycleError(environment),
          );
          reconcileEnvironmentLifecycleErrors();
          bindSetupTerminalSession(environment, session_id);
        }
      });
      if (disposed) stopStarted();
      else unlistenStarted = stopStarted;

      const stopComplete = await listen<EnvironmentSetupCompletePayload>("environment-setup-complete", (event) => {
        const { environment_id, success, environment } = event.payload;
        console.info("[setup-terminal] received environment-setup-complete", {
          environmentId: environment_id,
          success,
          hasEnvironment: !!environment,
          setupScriptsComplete: environment?.setupScriptsComplete ?? null,
          error: event.payload.error ?? null,
        });
        const store = useEnvironmentStore.getState();
        if (environment) {
          store.updateEnvironment(
            environment_id,
            withAuthoritativeLifecycleError(environment),
          );
          reconcileEnvironmentLifecycleErrors();
        }
        if (!success) {
          // The backend clears the durable launch intent on failure and sends the
          // updated environment above. Mirror it locally even when the payload
          // omitted the environment, so a failed setup cannot leave this renderer
          // holding a launch it will never be able to perform.
          store.updateEnvironment(environment_id, { pendingAgentLaunch: false });
        }
      });
      if (disposed) stopComplete();
      else unlistenComplete = stopComplete;
    };

    setupListeners();

    return () => {
      disposed = true;
      unlistenStarted?.();
      unlistenComplete?.();
    };
  }, []);

  // Mobile browsers routinely suspend network streams while backgrounded.
  // Reconcile from authoritative backend snapshots whenever the gateway
  // reconnects or the document becomes usable again.
  useEffect(() => {
    let unlistenConnected: UnlistenFn | null = null;
    let disposed = false;
    const reconcile = () => {
      void reconcileEnvironmentSetupSnapshots();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };

    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, reconcile).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenConnected = unlisten;
    });
    window.addEventListener("pageshow", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      unlistenConnected?.();
      window.removeEventListener("pageshow", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}

const EMPTY_ENVIRONMENTS: Environment[] = [];

export function useEnvironments(
  projectId: string | null,
  options: UseEnvironmentsOptions = {}
) {
  const { listenForRenameEvents = true } = options;

  // Data via narrow selectors: this hook is mounted at several call sites, and
  // a selector-less subscription rerendered all of them on every store write.
  const environments = useEnvironmentStore((state) => state.environments);
  const isLoading = useEnvironmentStore((state) => state.isLoading);
  const error = useEnvironmentStore((state) => state.error);

  // Actions are stable references on the store, so one shallow-compared bundle
  // subscribes without ever retriggering.
  const {
    mergeEnvironmentsForProject,
    addEnvironment: addEnvironmentToStore,
    removeEnvironment: removeEnvironmentFromStore,
    updateEnvironment: updateEnvironmentInStore,
    updateEnvironmentStatus: updateStatusInStore,
    setEnvironmentPR: setPRInStore,
    reorderEnvironments: reorderEnvironmentsInStore,
    setLoading,
    setError,
    getEnvironmentsByProjectId,
    setDeleting,
  } = useEnvironmentStore(
    useShallow((state) => ({
      mergeEnvironmentsForProject: state.mergeEnvironmentsForProject,
      addEnvironment: state.addEnvironment,
      removeEnvironment: state.removeEnvironment,
      updateEnvironment: state.updateEnvironment,
      updateEnvironmentStatus: state.updateEnvironmentStatus,
      setEnvironmentPR: state.setEnvironmentPR,
      reorderEnvironments: state.reorderEnvironments,
      setLoading: state.setLoading,
      setError: state.setError,
      getEnvironmentsByProjectId: state.getEnvironmentsByProjectId,
      setDeleting: state.setDeleting,
    }))
  );

  const disconnectEnvironmentSessions = useSessionStore(
    (state) => state.disconnectEnvironmentSessions
  );
  const deleteSessionsByEnvironment = useSessionStore(
    (state) => state.deleteSessionsByEnvironment
  );

  const showError = useErrorDialogStore((state) => state.showError);

  // Load environments when projectId changes
  useEffect(() => {
    if (projectId) {
      loadEnvironments(projectId);
    }
  }, [projectId]);

  // Listen for background environment rename events
  useEffect(() => {
    if (!listenForRenameEvents) {
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const setupListener = async () => {
      const stop = await listen<EnvironmentRenamedPayload>("environment-renamed", (event) => {
        console.log("[useEnvironments] Received environment-renamed event:", event.payload);
        const { environment_id, new_name, new_branch } = event.payload;

        // If the branch changed, clear stale PR state so monitoring starts
        // fresh for the new branch. Without this, a merged/closed PR from
        // the old branch would be preserved indefinitely.
        const currentEnv = useEnvironmentStore.getState().getEnvironmentById(environment_id);
        if (currentEnv && currentEnv.branch !== new_branch && currentEnv.prUrl) {
          console.log(
            `[useEnvironments] Branch changed (${currentEnv.branch} -> ${new_branch}), clearing stale PR state`
          );
          backend.clearEnvironmentPr(environment_id).catch((err) => {
            console.warn("[useEnvironments] Failed to clear PR state after branch rename:", err);
          });
          setPRInStore(environment_id, null, null, null);
        }

        // Update the environment in the store with the new name and branch
        updateEnvironmentInStore(environment_id, {
          name: new_name,
          branch: new_branch,
        });
      });
      if (disposed) stop();
      else unlisten = stop;
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [listenForRenameEvents, updateEnvironmentInStore, setPRInStore]);

  const loadEnvironments = useCallback(
    async (pid: string, options: LoadEnvironmentsOptions = {}) => {
      const {
        silent = false,
        reconcileStatus = true,
      } = options;
      const creationGeneration = getEnvironmentCreationState(pid).generation;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const attemptRevisions = lifecycleAttemptRevisions();
        const envs = reconcileStatus
          ? await backend.getEnvironments(pid)
          : await backend.getEnvironmentSnapshots(pid);
        const currentCreationState = getEnvironmentCreationState(pid);
        const snapshotIsCurrent =
          currentCreationState.activeCreations === 0
          && currentCreationState.generation === creationGeneration;
        // A snapshot requested before or during creation may omit the newly
        // created environment. Do not let it replace newer local state.
        if (snapshotIsCurrent) {
          cleanupSubscriptionsRemovedByProjectSnapshot(pid, envs);
          mergeEnvironmentsForProject(
            pid,
            envs.map((environment) =>
              preserveLifecycleAttemptState(
                environment,
                attemptRevisions.get(environment.id),
              ).environment
            ),
          );
          reconcileEnvironmentLifecycleErrors();
        }
      } catch (err) {
        const message = getErrorMessage(err, "Failed to load environments");
        if (silent) {
          console.warn(`[useEnvironments] Failed to refresh environments for project ${pid}:`, message);
        } else {
          setError(message);
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [mergeEnvironmentsForProject, setLoading, setError]
  );

  const createEnvironment = useCallback(
    async (pid: string, name?: string, networkAccessMode?: NetworkAccessMode, initialPrompt?: string, portMappings?: PortMapping[], environmentType?: EnvironmentType, namingPrompt?: string, buildPipelineId?: string) => {
      beginEnvironmentCreation(pid);
      setLoading(true);
      setError(null);
      try {
        const environment = await backend.createEnvironment(pid, name, networkAccessMode, initialPrompt, portMappings, environmentType, namingPrompt, buildPipelineId);
        addEnvironmentToStore(environment);
        useConfigStore.getState().setRepositoryLastEnvironmentType(pid, environment.environmentType);
        toast.success("Environment created");
        return environment;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to create environment");
        setError(message);
        toast.error("Failed to create environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to create environment", message),
          },
        });
        throw new Error(message);
      } finally {
        finishEnvironmentCreation(pid);
        setLoading(false);
      }
    },
    [addEnvironmentToStore, setLoading, setError, showError]
  );

  const deleteEnvironment = useCallback(
    async (environmentId: string) => {
      setDeleting(environmentId, true);
      setError(null);
      try {
        // Delete all sessions for this environment first (cleans up buffer files too)
        await deleteSessionsByEnvironment(environmentId);

        await backend.deleteEnvironment(environmentId);
        // The native chat subscriptions are deliberately owned by their stores
        // rather than by a mounted tab, so nothing else stops them. Their
        // desynced probe re-arms itself on every failure, which would otherwise
        // reach for a bridge that no longer exists once a minute forever.
        cleanupDeletedEnvironmentSubscriptions(environmentId);
        useBuildPipelineStore.getState().removePipelinesForEnvironment(environmentId);
        const loopedReviewState = useLoopedReviewStore.getState();
        for (const [workflowId, workflow] of loopedReviewState.workflows) {
          if (workflow.environmentId === environmentId) {
            loopedReviewState.removeWorkflow(workflowId);
          }
        }
        removeEnvironmentFromStore(environmentId);
        // The backend drops this environment's pane layout with the
        // environment, so the remembered selection has nothing left to point
        // at. The bounded store would evict it eventually; dropping it now
        // keeps that budget for environments the user still has.
        clearStoredPaneSelection(environmentId);
        // The unread marker lives on the environment record, so deleting the
        // environment takes it with it — nothing to prune here any more.
        toast.success("Environment deleted");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to delete environment");
        setError(message);
        toast.error("Failed to delete environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to delete environment", message),
          },
        });
        throw new Error(message);
      } finally {
        setDeleting(environmentId, false);
      }
    },
    [removeEnvironmentFromStore, setError, deleteSessionsByEnvironment, setDeleting, showError]
  );

  const startEnvironment = useCallback(
    async (environmentId: string, initialPrompt?: string, options?: StartEnvironmentOptions) => {
      console.log("[useEnvironments] startEnvironment called:", environmentId);
      // Read from store directly to avoid stale closure over `environments`.
      // When called from handleCreateEnvironment, the useCallback closure may
      // capture an older environments array that doesn't include the new env.
      const existingEnv = useEnvironmentStore.getState().environments.find((env) => env.id === environmentId);
      if (!existingEnv) {
        console.warn("[useEnvironments] startEnvironment called for unknown environment:", environmentId);
      }
      if (existingEnv) {
        console.info("[useEnvironments] startEnvironment snapshot:", {
          environmentId,
          environmentType: existingEnv.environmentType,
          status: existingEnv.status,
          branch: existingEnv.branch,
          worktreePath: existingEnv.worktreePath,
          projectId: existingEnv.projectId,
        });
      }
      setError(null);
      const lifecycleAttempt = beginLifecycleAttempt(environmentId);
      let lifecycleAttemptFinished = false;
      const finishAttemptAdmission = () => {
        if (lifecycleAttemptFinished) return;
        lifecycleAttemptFinished = true;
        finishLifecycleAttemptAdmission(environmentId, lifecycleAttempt);
      };

      // A retry owns fresh setup and launch state. Clear the preceding attempt's
      // durable error locally before installing the new setup gate; an older
      // in-flight snapshot is guarded by the attempt revision above.
      updateEnvironmentInStore(environmentId, { lifecycleError: null });

      try {
        console.log("[useEnvironments] Setting status to creating...");
        updateStatusInStore(environmentId, "creating");
        if (options?.background) {
          console.log("[useEnvironments] Handing environment start to backend...");
          await backend.startEnvironmentInBackground(environmentId);
          finishAttemptAdmission();
          return [];
        }

        console.log("[useEnvironments] Calling backend.startEnvironment...");
        const result = await backend.startEnvironment(environmentId);
        finishAttemptAdmission();
        console.log("[useEnvironments] backend.startEnvironment completed, refreshing environment...", {
          setupStarted: result.setupStarted,
          setupSessionId: result.setupSessionId,
        });

        // Refresh the full environment data (including containerId / worktreePath)
        const updatedEnv = await backend.getEnvironment(environmentId);
        if (updatedEnv) {
          console.log("[useEnvironments] Got updated environment:", updatedEnv);
          if (updatedEnv.environmentType === "local" && !updatedEnv.worktreePath) {
            console.warn("[useEnvironments] Local environment started without worktreePath:", {
              environmentId,
              status: updatedEnv.status,
              branch: updatedEnv.branch,
            });
          }
          updateEnvironmentInStore(environmentId, updatedEnv);
          if (result.setupSessionId) {
            bindSetupTerminalSession(updatedEnv, result.setupSessionId);
          }
        }

        if (!options?.silent) {
          toast.success("Environment started");
        }
        return [];
      } catch (err) {
        finishAttemptAdmission();
        console.error("[useEnvironments] Error starting environment:", err);
        const message = getErrorMessage(err, "Failed to start environment");
        // Foreground provisioning failures are also persisted by the backend,
        // so claim that attempt's eventual snapshot to avoid a duplicate toast.
        // Background rejection is only an admission failure and persists no
        // lifecycle outcome; claiming it would suppress a later retry's result.
        if (!options?.background) {
          markLifecycleErrorReportedByForeground(environmentId, lifecycleAttempt);
        }
        setError(message);
        updateStatusInStore(environmentId, "error");
        if (!options?.suppressFailureToast) {
          toast.error("Failed to start environment", {
            description: truncateForToast(message),
            action: {
              label: "Details",
              onClick: () => showError("Failed to start environment", message, initialPrompt),
            },
          });
        }
        throw new Error(message);
      }
    },
    [updateStatusInStore, updateEnvironmentInStore, setError, showError]
  );

  const stopEnvironment = useCallback(
    async (environmentId: string) => {
      console.log("[useEnvironments] stopEnvironment called:", environmentId);
      setError(null);
      try {
        // Immediately set status to stopping for user feedback
        console.log("[useEnvironments] Setting status to stopping...");
        updateStatusInStore(environmentId, "stopping");
        console.log("[useEnvironments] Calling backend.stopEnvironment...");
        await backend.stopEnvironment(environmentId);
        console.log("[useEnvironments] backend.stopEnvironment completed, updating status...");
        updateStatusInStore(environmentId, "stopped");
        console.log("[useEnvironments] Status updated to stopped");

        // Disconnect all sessions for this environment since container is stopped
        console.log("[useEnvironments] Disconnecting sessions for environment...");
        await disconnectEnvironmentSessions(environmentId);
        console.log("[useEnvironments] Sessions disconnected");
        toast.success("Environment stopped");
      } catch (err) {
        console.error("[useEnvironments] Error stopping environment:", err);
        const message = getErrorMessage(err, "Failed to stop environment");
        setError(message);
        // Revert to running if stop failed
        updateStatusInStore(environmentId, "running");
        toast.error("Failed to stop environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to stop environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, setError, disconnectEnvironmentSessions, showError]
  );

  const setEnvironmentPR = useCallback(
    async (environmentId: string, prUrl: string | null, prState: PrState | null) => {
      try {
        await setPRInStore(environmentId, prUrl, prState);
      } catch (err) {
        const message = getErrorMessage(err, "Failed to set PR URL");
        setError(message);
        toast.error("Failed to set PR URL", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to set PR URL", message),
          },
        });
        throw new Error(message);
      }
    },
    [setPRInStore, setError, showError]
  );

  const syncEnvironmentStatus = useCallback(
    async (environmentId: string) => {
      try {
        const updatedEnv = await backend.syncEnvironmentStatus(environmentId);
        updateEnvironmentInStore(environmentId, updatedEnv);
        return updatedEnv;
      } catch (err) {
        console.error("[useEnvironments] Error syncing environment status:", err);
        // Don't throw - just log the error
      }
    },
    [updateEnvironmentInStore]
  );

  const reorderEnvironments = useCallback(
    async (pid: string, environmentIds: string[]) => {
      // Optimistically update the store
      reorderEnvironmentsInStore(pid, environmentIds);
      try {
        // Persist to backend
        const reorderedEnvs = await backend.reorderEnvironments(pid, environmentIds);
        // Update with the server response (uses current store state, not stale closure)
        mergeEnvironmentsForProject(pid, reorderedEnvs);
      } catch (err) {
        // Reload from backend on error to restore correct state
        const message = getErrorMessage(err, "Failed to reorder environments");
        setError(message);
        toast.error("Failed to reorder environments", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to reorder environments", message),
          },
        });
        if (pid) {
          await loadEnvironments(pid);
        }
        throw new Error(message);
      }
    },
    [reorderEnvironmentsInStore, mergeEnvironmentsForProject, setError, loadEnvironments, showError]
  );

  const updatePortMappings = useCallback(
    async (environmentId: string, portMappings: PortMapping[]) => {
      try {
        const updated = await backend.updatePortMappings(environmentId, portMappings);
        updateEnvironmentInStore(environmentId, updated);
        return updated;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to update port mappings");
        setError(message);
        toast.error("Failed to update port mappings", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to update port mappings", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateEnvironmentInStore, setError, showError]
  );

  const restartEnvironment = useCallback(
    async (environmentId: string) => {
      setError(null);
      try {
        // Stop the environment
        updateStatusInStore(environmentId, "stopping");
        await backend.stopEnvironment(environmentId);

        // Disconnect all sessions since container is stopped
        await disconnectEnvironmentSessions(environmentId);

        // Re-use startEnvironment which handles setup commands centrally. Both
        // of its toasts are suppressed: this caller owns the user-visible
        // outcome under the "restarted" wording, either way.
        await startEnvironment(environmentId, undefined, {
          silent: true,
          suppressFailureToast: true,
        });
        toast.success("Environment restarted");
      } catch (err) {
        console.error("[useEnvironments] Error restarting environment:", err);
        const message = getErrorMessage(err, "Failed to restart environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        toast.error("Failed to restart environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to restart environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, setError, disconnectEnvironmentSessions, startEnvironment, showError]
  );

  // Get environments for the current project. Memoized so consumers do not
  // receive a new array identity on renders where nothing changed.
  const projectEnvironments = useMemo(
    () =>
      projectId
        ? environments
            .filter((e) => e.projectId === projectId)
            .sort((a, b) => a.order - b.order)
        : EMPTY_ENVIRONMENTS,
    [environments, projectId]
  );

  return {
    environments: projectEnvironments,
    allEnvironments: environments,
    isLoading,
    error,
    loadEnvironments,
    createEnvironment,
    deleteEnvironment,
    startEnvironment,
    stopEnvironment,
    restartEnvironment,
    setEnvironmentPR,
    syncEnvironmentStatus,
    reorderEnvironments,
    updateEnvironment: updateEnvironmentInStore,
    getEnvironmentsByProjectId,
    updatePortMappings,
  };
}
