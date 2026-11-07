import { drainProjectHomeEnsures } from "@/hooks/useFilesPanel";
// Hook for managing environment operations with Electron backend
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  environmentRenamedEvent,
  environmentSetupCompleteEvent,
  environmentSetupStartedEvent,
  nativeAgentAsyncQuestionEvent,
} from "@orkestrator/protocol/contract/domains/events";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { toast } from "sonner";
import type { StoreApi } from "zustand";
import {
  buildPipelineStore,
  createSessionKey,
  environmentStore,
  projectStore,
  useEnvironmentStore,
  formatErrorContext,
  useErrorDialogStore,
  terminalSessionStore,
  paneLayoutStore,
  getAllLeaves,
} from "@/stores";
import { createSessionKey as createNativeSessionKey } from "@/lib/utils";
import { getNativeAgentData } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { uiStore } from "@/stores/uiStore";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { appCommandScope, defineScopedSlot, listenInScope } from "@/lib/node-scope-slots";
import { clearStoredPaneSelection } from "@/lib/pane-selection-storage";
import type { ErrorContext } from "@/stores";
import type { EnvironmentState } from "@/stores/environmentStore";
import type { ProjectState } from "@/stores/projectStore";
import type {
  Environment,
  EnvironmentType,
  NetworkAccessMode,
  PortMapping,
  PrState,
} from "@/types";
import {
  clearBuildPipelineHandoffResolutions,
  clearBuildPipelineTabActivation,
  clearStartupAgentTabActivation,
} from "@/lib/pane-layout-authoritative";
import {
  activateProjectForEnvironmentCleanup,
  startEnvironmentCleanupSelectionSync,
} from "@/lib/environment-cleanup-selection";
import { classifyReadError } from "@/lib/read-coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.environment");
const setupLog = createLogger("terminal.setup");

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

/**
 * Name the project and environment an error belongs to, so a generic lifecycle
 * message says which of many environments it is about.
 */
function describeEnvironment(node: EnvironmentNode, environmentId: string): ErrorContext {
  const environment = node.environments.getState().getEnvironmentById(environmentId);
  const project = environment
    ? node.projects.getState().getProjectById(environment.projectId)
    : undefined;
  return { project: project?.name, environment: environment?.name ?? environmentId };
}

/** Toast description that leads with the environment's identity. */
function describeForToast(context: ErrorContext, message: string): string {
  return `${formatErrorContext(context)}: ${truncateForToast(message)}`;
}

/** Payload emitted when an environment is renamed in the background */
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
  /** Let readiness-sensitive callers distinguish a failed snapshot from an empty one. */
  throwOnError?: boolean;
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

interface LifecycleAttemptState {
  attempt: number;
  revision: number;
  pending: boolean;
}

interface ForegroundLifecycleErrorReport {
  attempt: number;
  kind: "foreground";
}

/**
 * One node's environment bookkeeping (plan item 3004). Environment and
 * project ids are node-local, so creations, start attempts and reported
 * failures are kept per node scope, next to that scope's stores. Hold the
 * instance, not the scope, across an await: the slot of a disposed scope can
 * no longer be read.
 */
interface EnvironmentNode {
  readonly scope: NodeScope;
  readonly environments: StoreApi<EnvironmentState>;
  readonly projects: StoreApi<ProjectState>;
  readonly creationByProject: Map<string, EnvironmentCreationState>;
  readonly lifecycleAttempts: Map<string, LifecycleAttemptState>;
  readonly reportedLifecycleErrors: Map<string, string | ForegroundLifecycleErrorReport>;
  setupSnapshotReconciliation: Promise<void> | null;
  setupSnapshotReconcileRequested: boolean;
}

const environmentNode = defineScopedSlot<EnvironmentNode>("environment-lifecycle", (scope) => ({
  scope,
  environments: scope.store(environmentStore),
  projects: scope.store(projectStore),
  creationByProject: new Map(),
  lifecycleAttempts: new Map(),
  reportedLifecycleErrors: new Map(),
  setupSnapshotReconciliation: null,
  setupSnapshotReconcileRequested: false,
}));

/** `scope`'s environment commands; the command scope keeps the mocked named exports. */
function environmentsApi(scope: NodeScope) {
  return backendApiForScope<
    ReturnType<typeof createProjectsEnvironmentsApi>,
    | "createEnvironment"
    | "deleteEnvironment"
    | "forkEnvironment"
    | "getEnvironment"
    | "getEnvironmentSnapshot"
    | "getEnvironmentSnapshots"
    | "getEnvironments"
    | "reorderEnvironments"
    | "startEnvironment"
    | "startEnvironmentInBackground"
    | "stopEnvironment"
    | "syncEnvironmentStatus"
  >(scope, createProjectsEnvironmentsApi, backend);
}

function getEnvironmentCreationState(
  node: EnvironmentNode,
  projectId: string,
): EnvironmentCreationState {
  return (
    node.creationByProject.get(projectId) ?? {
      generation: 0,
      activeCreations: 0,
    }
  );
}

function beginEnvironmentCreation(node: EnvironmentNode, projectId: string): void {
  const current = getEnvironmentCreationState(node, projectId);
  node.creationByProject.set(projectId, {
    generation: current.generation + 1,
    activeCreations: current.activeCreations + 1,
  });
}

function finishEnvironmentCreation(node: EnvironmentNode, projectId: string): void {
  const current = getEnvironmentCreationState(node, projectId);
  node.creationByProject.set(projectId, {
    generation: current.generation + 1,
    activeCreations: Math.max(0, current.activeCreations - 1),
  });
}

function bindSetupTerminalSession(
  environment: Environment,
  sessionId: string,
  scope: NodeScope,
): void {
  const key = createSessionKey(environment.containerId ?? null, "default", environment.id);
  const store = scope.store(terminalSessionStore).getState();
  const existing = store.sessions.get(key);
  setupLog.info("session.bind-from-environment", {
    environmentId: environment.id,
    environmentType: environment.environmentType,
    containerId: environment.containerId ?? null,
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

/**
 * Stop store-owned background state after authoritative deletion, on the
 * environment's node (the app's command scope when omitted).
 */
export function cleanupDeletedEnvironmentSubscriptions(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  clearBuildPipelineTabActivation(environmentId, scope);
  clearBuildPipelineHandoffResolutions(environmentId, scope);
  clearStartupAgentTabActivation(environmentId, scope);
}

/**
 * Stop background subscriptions for environments an authoritative project
 * snapshot removed. Other projects are deliberately outside this snapshot's
 * scope and surviving IDs keep their existing long-lived subscriptions.
 */
export function cleanupSubscriptionsRemovedByProjectSnapshot(
  projectId: string,
  nextEnvironments: readonly Environment[],
  scope: NodeScope,
): void {
  const nextIds = new Set(nextEnvironments.map((environment) => environment.id));
  for (const environment of scope.store(environmentStore).getState().environments) {
    if (environment.projectId === projectId && !nextIds.has(environment.id)) {
      cleanupDeletedEnvironmentSubscriptions(environment.id, scope);
    }
  }
}

/**
 * Installs one environment's authoritative snapshot, for a change announcement
 * that named only it. Resolves `false` when the backend predates the read, so
 * the caller reads the project's list instead.
 */
export async function refreshEnvironmentSnapshot(
  projectId: string,
  environmentId: string,
  scope: NodeScope,
): Promise<boolean> {
  const node = environmentNode(scope);
  const creationGeneration = getEnvironmentCreationState(node, projectId).generation;
  const attemptRevisions = lifecycleAttemptRevisions(node);
  let snapshot: Environment | null;
  try {
    snapshot = await environmentsApi(scope).getEnvironmentSnapshot(environmentId);
  } catch (error) {
    if (classifyReadError(error) === "unsupported") return false;
    throw error;
  }
  const store = node.environments.getState();
  const creation = getEnvironmentCreationState(node, projectId);
  // Not held yet, so it may be a creation this client is still waiting on: its
  // own response adds it, and adding it here as well would list it twice.
  if (
    !store.getEnvironmentById(environmentId) &&
    (creation.activeCreations > 0 || creation.generation !== creationGeneration)
  ) {
    return true;
  }
  if (!snapshot) cleanupDeletedEnvironmentSubscriptions(environmentId, scope);
  store.applyEnvironmentSnapshot(
    environmentId,
    snapshot &&
      preserveLifecycleAttemptState(node, snapshot, attemptRevisions.get(environmentId))
        .environment,
  );
  reconcileNodeLifecycleErrors(node);
  return true;
}

function beginLifecycleAttempt(node: EnvironmentNode, environmentId: string): number {
  const previous = node.lifecycleAttempts.get(environmentId);
  const attempt = (previous?.attempt ?? 0) + 1;
  node.lifecycleAttempts.set(environmentId, {
    attempt,
    revision: (previous?.revision ?? 0) + 1,
    pending: true,
  });
  // A claim belongs to one specific attempt. In particular, an admission
  // rejection must never suppress the durable failure from a later retry.
  node.reportedLifecycleErrors.delete(environmentId);
  return attempt;
}

function finishLifecycleAttemptAdmission(
  node: EnvironmentNode,
  environmentId: string,
  attempt: number,
): void {
  const current = node.lifecycleAttempts.get(environmentId);
  if (!current || current.attempt !== attempt) return;
  node.lifecycleAttempts.set(environmentId, {
    ...current,
    revision: current.revision + 1,
    pending: false,
  });
}

function lifecycleAttemptRevisions(node: EnvironmentNode): Map<string, number> {
  return new Map(
    [...node.lifecycleAttempts].map(([environmentId, state]) => [environmentId, state.revision]),
  );
}

/**
 * A snapshot requested before (or while admitting) a retry can still carry the
 * preceding attempt's error. Preserve the retry-owned fields in that case so
 * the old response cannot resolve setup gates or discard a new launch intent.
 */
function preserveLifecycleAttemptState(
  node: EnvironmentNode,
  snapshot: Environment,
  revisionAtRequest: number | undefined,
): { environment: Environment; stale: boolean } {
  const attempt = node.lifecycleAttempts.get(snapshot.id);
  const current = node.environments.getState().getEnvironmentById(snapshot.id);
  const stale = Boolean(
    attempt && current && (attempt.pending || attempt.revision !== revisionAtRequest),
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
  node: EnvironmentNode,
  environmentId: string,
  attempt: number,
): void {
  node.reportedLifecycleErrors.set(environmentId, {
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
  return snapshot.lifecycleError === undefined ? { ...snapshot, lifecycleError: null } : snapshot;
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
export function reconcileEnvironmentLifecycleErrors(scope: NodeScope): void {
  reconcileNodeLifecycleErrors(environmentNode(scope));
}

function reconcileNodeLifecycleErrors(node: EnvironmentNode): void {
  const store = node.environments.getState();
  const liveEnvironmentIds = new Set(store.environments.map((environment) => environment.id));
  for (const environmentId of node.reportedLifecycleErrors.keys()) {
    if (!liveEnvironmentIds.has(environmentId)) {
      node.reportedLifecycleErrors.delete(environmentId);
    }
  }
  for (const environmentId of node.lifecycleAttempts.keys()) {
    if (!liveEnvironmentIds.has(environmentId)) {
      node.lifecycleAttempts.delete(environmentId);
    }
  }

  for (const environment of store.environments) {
    const message = environment.lifecycleError?.trim();
    if (!message) {
      node.reportedLifecycleErrors.delete(environment.id);
      continue;
    }

    // The backend drops the durable launch intent when a start fails; mirror it,
    // or a launch that can never happen auto-dispatches the original prompt the
    // next time this env is started.
    store.updateEnvironment(environment.id, { pendingAgentLaunch: false });
    clearBuildPipelineTabActivation(environment.id, node.scope);
    clearStartupAgentTabActivation(environment.id, node.scope);

    const reported = node.reportedLifecycleErrors.get(environment.id);
    if (reported === message) {
      continue;
    }
    // Record before reporting: the toast action re-enters these stores.
    node.reportedLifecycleErrors.set(environment.id, message);
    if (
      typeof reported !== "string" &&
      reported?.kind === "foreground" &&
      reported.attempt === node.lifecycleAttempts.get(environment.id)?.attempt
    ) {
      // Same failure the foreground start already toasted, wearing the
      // backend's sanitized wording. Consume the claim instead of repeating it.
      continue;
    }
    store.setError(message);
    const context = describeEnvironment(node, environment.id);
    toast.error("Failed to start environment", {
      description: describeForToast(context, message),
      action: {
        label: "Details",
        onClick: () =>
          useErrorDialogStore
            .getState()
            .showError("Failed to start environment", message, undefined, context),
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
export function reconcileEnvironmentSetupSnapshots(scope: NodeScope): Promise<void> {
  return reconcileNodeSetupSnapshots(environmentNode(scope));
}

function reconcileNodeSetupSnapshots(node: EnvironmentNode): Promise<void> {
  // Coalesce, but never drop. A trigger that arrives after the in-flight reads
  // were issued would otherwise be answered by a snapshot older than the event
  // it is reacting to, so remember it and run one more pass on completion. On
  // mobile resume four triggers fire in a burst, which makes this the norm.
  if (node.setupSnapshotReconciliation) {
    node.setupSnapshotReconcileRequested = true;
    return node.setupSnapshotReconciliation;
  }

  const targets = node.environments
    .getState()
    .environments.filter(
      (environment) =>
        environment.status === "creating" ||
        Boolean(environment.lifecycleError) ||
        (environment.status === "running" &&
          (environment.setupPhase === "running" ||
            environment.pendingAgentLaunch ||
            environment.startupAgentSession !== undefined)),
    );

  if (targets.length === 0) return Promise.resolve();
  const attemptRevisions = lifecycleAttemptRevisions(node);
  const api = environmentsApi(node.scope);

  const reconciliation = Promise.all(
    targets.map(async (environment) => {
      try {
        const snapshot = await api.getEnvironment(environment.id);
        if (!snapshot) return;

        const store = node.environments.getState();
        const protectedSnapshot = preserveLifecycleAttemptState(
          node,
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
        log.warn("setup-snapshot.reconcile-failed", {
          environmentId: environment.id,
          error: formatLogError(error),
        });
      }
    }),
  )
    .then(() => {
      // Once, after every snapshot has been merged. The reconciliation scans the
      // whole store, so calling it per target was O(targets x environments) work
      // — and that many store notifications — for one pass.
      reconcileNodeLifecycleErrors(node);
    })
    .finally(() => {
      node.setupSnapshotReconciliation = null;
      if (node.setupSnapshotReconcileRequested) {
        node.setupSnapshotReconcileRequested = false;
        void reconcileNodeSetupSnapshots(node);
      }
    });
  node.setupSnapshotReconciliation = reconciliation;
  return reconciliation;
}

/** Apply one incremental setup-completion event to the authoritative stores. */
export function applyEnvironmentSetupComplete(
  payload: EnvironmentSetupCompletePayload,
  scope: NodeScope,
): void {
  const { environment_id, success, environment } = payload;
  setupLog.info("setup.complete-received", {
    environmentId: environment_id,
    success,
    hasEnvironment: !!environment,
    setupScriptsComplete: environment?.setupScriptsComplete ?? null,
    error: payload.error ? formatLogError(payload.error) : null,
  });
  const node = environmentNode(scope);
  const store = node.environments.getState();
  if (environment) {
    store.updateEnvironment(environment_id, withAuthoritativeLifecycleError(environment));
    reconcileNodeLifecycleErrors(node);
  }
  if (!success) {
    // The backend clears the durable launch intent on failure and normally
    // sends the updated environment above. Mirror it locally even when the
    // payload omitted the environment, so a failed setup cannot leave this
    // renderer holding a launch it will never be able to perform.
    store.updateEnvironment(environment_id, { pendingAgentLaunch: false });
    clearBuildPipelineTabActivation(environment_id, scope);
    clearStartupAgentTabActivation(environment_id, scope);
  }
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
  // The node this service keeps current: the nearest node scope (the command
  // scope where App mounts it).
  const scope = useShimNodeScope("environment");
  useEffect(() => startEnvironmentCleanupSelectionSync(scope), [scope]);

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
      // The definitions pin the ids (plan item 7011); the environment in a
      // setup payload is the web's model, delivered as sent.
      const stopStarted = await listenInScope(scope, environmentSetupStartedEvent, (payload) => {
        const { environment_id, session_id, environment } =
          payload as EnvironmentSetupStartedPayload;
        setupLog.info("setup.started-received", {
          environmentId: environment_id,
          sessionId: session_id,
          hasEnvironment: !!environment,
          environmentType: environment?.environmentType ?? null,
          containerId: environment?.containerId ?? null,
        });
        const node = environmentNode(scope);
        if (environment) {
          node.environments
            .getState()
            .updateEnvironment(environment_id, withAuthoritativeLifecycleError(environment));
          reconcileNodeLifecycleErrors(node);
          bindSetupTerminalSession(environment, session_id, scope);
        }
      });
      if (disposed) stopStarted();
      else unlistenStarted = stopStarted;

      const stopComplete = await listenInScope(scope, environmentSetupCompleteEvent, (payload) =>
        applyEnvironmentSetupComplete(payload as EnvironmentSetupCompletePayload, scope),
      );
      if (disposed) stopComplete();
      else unlistenComplete = stopComplete;
    };

    setupListeners();

    return () => {
      disposed = true;
      unlistenStarted?.();
      unlistenComplete?.();
    };
  }, [scope]);

  // The durable unread bit is authoritative. This root-mounted listener adds
  // only a transient hint when the question arrived outside the active
  // environment; no prompt content crosses the global event channel.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listenInScope(scope, nativeAgentAsyncQuestionEvent, (payload) => {
      const selectedEnvironmentId = scope.store(uiStore).getState().selectedEnvironmentId;
      if (selectedEnvironmentId === payload.environment_id) {
        const root = scope.store(paneLayoutStore).getState().getRoot(selectedEnvironmentId);
        const owningTabIsVisible = getAllLeaves(root).some((pane) => {
          const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
          const data = activeTab ? getNativeAgentData(activeTab) : null;
          return (
            data?.platform === "codex" &&
            createNativeSessionKey(selectedEnvironmentId, activeTab!.id) === payload.session_key
          );
        });
        if (owningTabIsVisible) return;
      }
      const environment = environmentNode(scope)
        .environments.getState()
        .getEnvironmentById(payload.environment_id);
      toast.info("Codex has a question", {
        description: environment
          ? `Open ${environment.name} to answer it.`
          : "Open the agent session to answer it.",
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [scope]);

  // Mobile browsers routinely suspend network streams while backgrounded.
  // Reconcile from authoritative backend snapshots whenever the gateway
  // reconnects or the document becomes usable again.
  useEffect(() => {
    let unlistenConnected: UnlistenFn | null = null;
    let disposed = false;
    const reconcile = () => {
      void reconcileEnvironmentSetupSnapshots(scope);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };

    void listenInScope(scope, NATIVE_EVENT_STREAM_CONNECTED_EVENT, reconcile).then((unlisten) => {
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
  }, [scope]);
}

const EMPTY_ENVIRONMENTS: Environment[] = [];

export function useEnvironments(projectId: string | null, options: UseEnvironmentsOptions = {}) {
  const { listenForRenameEvents = true } = options;
  // The node whose environments this reads: the nearest node scope, which is
  // also the one `useEnvironmentStore` reads below.
  const scope = useShimNodeScope("environment");

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
    })),
  );

  const disconnectEnvironmentSessions = useSessionStore(
    (state) => state.disconnectEnvironmentSessions,
  );
  const deleteSessionsByEnvironment = useSessionStore((state) => state.deleteSessionsByEnvironment);

  const showError = useErrorDialogStore((state) => state.showError);

  // Listen for background environment rename events
  useEffect(() => {
    if (!listenForRenameEvents) {
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const setupListener = async () => {
      const stop = await listenInScope(scope, environmentRenamedEvent, (payload) => {
        log.debug("rename.received", () => ({ environmentId: payload.environment_id }));
        const { environment_id, new_name, new_branch } = payload;

        // The backend clears prUrl/prState/hasMergeConflicts in the same
        // write that advances the branch, so this only mirrors that into the
        // local store. Never clear it on the backend from here: every
        // connected client receives this event, and a late clear could wipe a
        // PR the monitor has just found for the new branch.
        const currentEnv = scope
          .store(environmentStore)
          .getState()
          .getEnvironmentById(environment_id);
        if (currentEnv && currentEnv.branch !== new_branch && currentEnv.prUrl) {
          log.debug("rename.pr-state-cleared", () => ({ environmentId: environment_id }));
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
  }, [listenForRenameEvents, scope, updateEnvironmentInStore, setPRInStore]);

  const loadEnvironments = useCallback(
    async (pid: string, options: LoadEnvironmentsOptions = {}) => {
      const { silent = false, reconcileStatus = true } = options;
      const node = environmentNode(scope);
      const api = environmentsApi(scope);
      const creationGeneration = getEnvironmentCreationState(node, pid).generation;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const attemptRevisions = lifecycleAttemptRevisions(node);
        const envs = reconcileStatus
          ? await api.getEnvironments(pid)
          : await api.getEnvironmentSnapshots(pid);
        const currentCreationState = getEnvironmentCreationState(node, pid);
        const snapshotIsCurrent =
          currentCreationState.activeCreations === 0 &&
          currentCreationState.generation === creationGeneration;
        // A snapshot requested before or during creation may omit the newly
        // created environment. Do not let it replace newer local state.
        if (snapshotIsCurrent) {
          cleanupSubscriptionsRemovedByProjectSnapshot(pid, envs, scope);
          mergeEnvironmentsForProject(
            pid,
            envs.map(
              (environment) =>
                preserveLifecycleAttemptState(
                  node,
                  environment,
                  attemptRevisions.get(environment.id),
                ).environment,
            ),
          );
          reconcileNodeLifecycleErrors(node);
        }
      } catch (err) {
        const message = getErrorMessage(err, "Failed to load environments");
        if (silent) {
          log.warn("list.refresh-failed", { projectId: pid, error: formatLogError(err) });
        } else {
          setError(message);
        }
        if (options.throwOnError) throw err;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [scope, mergeEnvironmentsForProject, setLoading, setError],
  );

  // Declared after loadEnvironments so the callback can be a real dependency;
  // referencing it above would read the const before initialisation.
  useEffect(() => {
    if (projectId) {
      loadEnvironments(projectId);
    }
  }, [projectId, loadEnvironments]);

  const createEnvironment = useCallback(
    async (
      pid: string,
      name?: string,
      networkAccessMode?: NetworkAccessMode,
      initialPrompt?: string,
      portMappings?: PortMapping[],
      environmentType?: EnvironmentType,
      namingPrompt?: string,
      buildPipelineId?: string,
      worktreeBaseDir?: string,
    ) => {
      const node = environmentNode(scope);
      beginEnvironmentCreation(node, pid);
      setLoading(true);
      setError(null);
      try {
        const environment = await environmentsApi(scope).createEnvironment(
          pid,
          name,
          networkAccessMode,
          initialPrompt,
          portMappings,
          environmentType,
          namingPrompt,
          buildPipelineId,
          ...(worktreeBaseDir ? [worktreeBaseDir] : []),
        );
        // The backend records lastEnvironmentType in the same command and
        // announces a config change, which store-resource-sync refetches.
        addEnvironmentToStore(environment);
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
        finishEnvironmentCreation(node, pid);
        setLoading(false);
      }
    },
    [scope, addEnvironmentToStore, setLoading, setError, showError],
  );

  const forkEnvironment = useCallback(
    async (environmentId: string, environmentType: EnvironmentType) => {
      const node = environmentNode(scope);
      const source = node.environments.getState().getEnvironmentById(environmentId);
      const projectId = source?.projectId;
      if (projectId) beginEnvironmentCreation(node, projectId);
      setLoading(true);
      setError(null);
      try {
        const environment = await environmentsApi(scope).forkEnvironment(
          environmentId,
          environmentType,
        );
        // The backend records lastEnvironmentType in the same command and
        // announces a config change, which store-resource-sync refetches.
        addEnvironmentToStore(environment);
        toast.success(
          environmentType === "local" ? "Local environment forked" : "Container environment forked",
        );
        return environment;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to fork environment");
        setError(message);
        toast.error("Failed to fork environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to fork environment", message),
          },
        });
        throw new Error(message);
      } finally {
        if (projectId) finishEnvironmentCreation(node, projectId);
        setLoading(false);
      }
    },
    [scope, addEnvironmentToStore, setLoading, setError, showError],
  );

  const deleteEnvironment = useCallback(
    async (environmentId: string) => {
      const node = environmentNode(scope);
      // Held across the awaits below: the scope may be disposed by then.
      const ui = scope.store(uiStore);
      const projectId =
        node.environments.getState().getEnvironmentById(environmentId)?.projectId ??
        ui.getState().selectedProjectId;
      setDeleting(environmentId, true);
      const didActivate = activateProjectForEnvironmentCleanup(environmentId, scope);
      setError(null);
      try {
        if (
          node.environments.getState().getEnvironmentById(environmentId)?.projectHome &&
          projectId
        ) {
          await drainProjectHomeEnsures(projectId, scope);
        }
        // Delete all sessions for this environment first (cleans up buffer files too)
        await deleteSessionsByEnvironment(environmentId);

        await environmentsApi(scope).deleteEnvironment(environmentId);
        // The native chat subscriptions are deliberately owned by their stores
        // rather than by a mounted tab, so nothing else stops them. Their
        // desynced probe re-arms itself on every failure, which would otherwise
        // reach for a bridge that no longer exists once a minute forever.
        cleanupDeletedEnvironmentSubscriptions(environmentId, scope);
        scope.store(buildPipelineStore).getState().removePipelinesForEnvironment(environmentId);
        removeEnvironmentFromStore(environmentId);
        // The backend drops this environment's pane layout with the
        // environment, so the remembered selection has nothing left to point
        // at. The bounded store would evict it eventually; dropping it now
        // keeps that budget for environments the user still has.
        clearStoredPaneSelection(environmentId, scope);
        // The unread marker lives on the environment record, so deleting the
        // environment takes it with it — nothing to prune here any more.
        toast.success("Environment deleted");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to delete environment");
        setError(message);
        const context = describeEnvironment(node, environmentId);
        toast.error("Failed to delete environment", {
          description: describeForToast(context, message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to delete environment", message, undefined, context),
          },
        });
        throw new Error(message);
      } finally {
        setDeleting(environmentId, false);
        if (
          didActivate &&
          projectId &&
          node.environments.getState().getEnvironmentById(environmentId)
        ) {
          ui.getState().selectProjectAndEnvironment(projectId, environmentId);
        }
      }
    },
    [
      scope,
      removeEnvironmentFromStore,
      setError,
      deleteSessionsByEnvironment,
      setDeleting,
      showError,
    ],
  );

  const startEnvironment = useCallback(
    async (environmentId: string, initialPrompt?: string, options?: StartEnvironmentOptions) => {
      log.debug("start.called", () => ({ environmentId }));
      // Read from store directly to avoid stale closure over `environments`.
      // When called from handleCreateEnvironment, the useCallback closure may
      // capture an older environments array that doesn't include the new env.
      const node = environmentNode(scope);
      const api = environmentsApi(scope);
      const existingEnv = node.environments
        .getState()
        .environments.find((env) => env.id === environmentId);
      if (!existingEnv) {
        log.warn("start.unknown-environment", { environmentId });
      }
      if (existingEnv) {
        log.info("start.snapshot-read", {
          environmentId,
          environmentType: existingEnv.environmentType,
          status: existingEnv.status,
          hasWorktree: !!existingEnv.worktreePath,
          projectId: existingEnv.projectId,
        });
      }
      setError(null);
      const lifecycleAttempt = beginLifecycleAttempt(node, environmentId);
      let lifecycleAttemptFinished = false;
      const finishAttemptAdmission = () => {
        if (lifecycleAttemptFinished) return;
        lifecycleAttemptFinished = true;
        finishLifecycleAttemptAdmission(node, environmentId, lifecycleAttempt);
      };

      // A retry owns fresh setup and launch state. Clear the preceding attempt's
      // durable error locally before installing the new setup gate; an older
      // in-flight snapshot is guarded by the attempt revision above.
      updateEnvironmentInStore(environmentId, { lifecycleError: null });

      try {
        log.debug("start.status-set", () => ({ environmentId, status: "creating" }));
        updateStatusInStore(environmentId, "creating");
        if (options?.background) {
          log.debug("start.background-requested", () => ({ environmentId }));
          await api.startEnvironmentInBackground(environmentId);
          finishAttemptAdmission();
          return [];
        }

        log.debug("start.backend-requested", () => ({ environmentId }));
        const result = await api.startEnvironment(environmentId);
        finishAttemptAdmission();
        log.debug("start.backend-completed", () => ({
          environmentId,
          setupStarted: result.setupStarted,
          setupSessionId: result.setupSessionId,
        }));

        // Refresh the full environment data (including containerId / worktreePath)
        const updatedEnv = await api.getEnvironment(environmentId);
        if (updatedEnv) {
          log.debug("start.environment-refreshed", () => ({
            environmentId,
            status: updatedEnv.status,
            environmentType: updatedEnv.environmentType,
            containerId: updatedEnv.containerId,
            hasWorktree: !!updatedEnv.worktreePath,
          }));
          if (updatedEnv.environmentType === "local" && !updatedEnv.worktreePath) {
            log.warn("start.worktree-missing", { environmentId, status: updatedEnv.status });
          }
          updateEnvironmentInStore(environmentId, updatedEnv);
          if (result.setupSessionId) {
            bindSetupTerminalSession(updatedEnv, result.setupSessionId, scope);
          }
        }

        if (!options?.silent) {
          toast.success("Environment started");
        }
        return [];
      } catch (err) {
        finishAttemptAdmission();
        log.error("start.failed", { environmentId, error: formatLogError(err) });
        const message = getErrorMessage(err, "Failed to start environment");
        // Foreground provisioning failures are also persisted by the backend,
        // so claim that attempt's eventual snapshot to avoid a duplicate toast.
        // Background rejection is only an admission failure and persists no
        // lifecycle outcome; claiming it would suppress a later retry's result.
        if (!options?.background) {
          markLifecycleErrorReportedByForeground(node, environmentId, lifecycleAttempt);
        }
        setError(message);
        updateStatusInStore(environmentId, "error");
        if (!options?.suppressFailureToast) {
          const context = describeEnvironment(node, environmentId);
          toast.error("Failed to start environment", {
            description: describeForToast(context, message),
            action: {
              label: "Details",
              onClick: () =>
                showError("Failed to start environment", message, initialPrompt, context),
            },
          });
        }
        throw new Error(message);
      }
    },
    [scope, updateStatusInStore, updateEnvironmentInStore, setError, showError],
  );

  const stopEnvironment = useCallback(
    async (environmentId: string) => {
      log.debug("stop.called", () => ({ environmentId }));
      setError(null);
      try {
        // Immediately set status to stopping for user feedback
        log.debug("stop.status-set", () => ({ environmentId, status: "stopping" }));
        updateStatusInStore(environmentId, "stopping");
        log.debug("stop.backend-requested", () => ({ environmentId }));
        await environmentsApi(scope).stopEnvironment(environmentId);
        log.debug("stop.backend-completed", () => ({ environmentId }));
        updateStatusInStore(environmentId, "stopped");
        log.debug("stop.status-set", () => ({ environmentId, status: "stopped" }));

        // Disconnect all sessions for this environment since container is stopped
        log.debug("stop.sessions-disconnecting", () => ({ environmentId }));
        await disconnectEnvironmentSessions(environmentId);
        log.debug("stop.sessions-disconnected", () => ({ environmentId }));
        toast.success("Environment stopped");
      } catch (err) {
        log.error("stop.failed", { environmentId, error: formatLogError(err) });
        const message = getErrorMessage(err, "Failed to stop environment");
        setError(message);
        // Revert to running if stop failed
        updateStatusInStore(environmentId, "running");
        const context = describeEnvironment(environmentNode(scope), environmentId);
        toast.error("Failed to stop environment", {
          description: describeForToast(context, message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to stop environment", message, undefined, context),
          },
        });
        throw new Error(message);
      }
    },
    [scope, updateStatusInStore, setError, disconnectEnvironmentSessions, showError],
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
    [setPRInStore, setError, showError],
  );

  const syncEnvironmentStatus = useCallback(
    async (environmentId: string) => {
      try {
        const updatedEnv = await environmentsApi(scope).syncEnvironmentStatus(environmentId);
        updateEnvironmentInStore(environmentId, updatedEnv);
        return updatedEnv;
      } catch (err) {
        log.error("status-sync.failed", { environmentId, error: formatLogError(err) });
        // Don't throw - just log the error
      }
    },
    [scope, updateEnvironmentInStore],
  );

  const reorderEnvironments = useCallback(
    async (pid: string, environmentIds: string[]) => {
      // Optimistically update the store
      reorderEnvironmentsInStore(pid, environmentIds);
      try {
        // Persist to backend
        const reorderedEnvs = await environmentsApi(scope).reorderEnvironments(pid, environmentIds);
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
    [
      scope,
      reorderEnvironmentsInStore,
      mergeEnvironmentsForProject,
      setError,
      loadEnvironments,
      showError,
    ],
  );

  const updatePortMappings = useCallback(
    async (environmentId: string, portMappings: PortMapping[]) => {
      try {
        const updated = await backendApiForScope(scope, createFilesSessionsApi, {
          updatePortMappings: backend.updatePortMappings,
        }).updatePortMappings(environmentId, portMappings);
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
    [scope, updateEnvironmentInStore, setError, showError],
  );

  const restartEnvironment = useCallback(
    async (environmentId: string) => {
      setError(null);
      try {
        // Stop the environment
        updateStatusInStore(environmentId, "stopping");
        await environmentsApi(scope).stopEnvironment(environmentId);

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
        log.error("restart.failed", { environmentId, error: formatLogError(err) });
        const message = getErrorMessage(err, "Failed to restart environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        const context = describeEnvironment(environmentNode(scope), environmentId);
        toast.error("Failed to restart environment", {
          description: describeForToast(context, message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to restart environment", message, undefined, context),
          },
        });
        throw new Error(message);
      }
    },
    [
      scope,
      updateStatusInStore,
      setError,
      disconnectEnvironmentSessions,
      startEnvironment,
      showError,
    ],
  );

  // Get environments for the current project. Memoized so consumers do not
  // receive a new array identity on renders where nothing changed.
  const refreshSnapshot = useCallback(
    (pid: string, environmentId: string) => refreshEnvironmentSnapshot(pid, environmentId, scope),
    [scope],
  );

  const projectEnvironments = useMemo(
    () =>
      projectId
        ? environments.filter((e) => e.projectId === projectId).sort((a, b) => a.order - b.order)
        : EMPTY_ENVIRONMENTS,
    [environments, projectId],
  );

  return {
    environments: projectEnvironments,
    allEnvironments: environments,
    isLoading,
    error,
    loadEnvironments,
    refreshEnvironmentSnapshot: refreshSnapshot,
    createEnvironment,
    forkEnvironment,
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
