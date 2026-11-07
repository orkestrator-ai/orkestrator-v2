import {
  getAgentMailSummary,
  getConfig,
  getEnvironmentSnapshots,
  getPaneLayout,
  getProjects,
} from "@/lib/backend";
import {
  onResourceChanged,
  onResourceResync,
  type ResourceResyncRequest,
} from "@/lib/resource-sync";
import { listen, type UnlistenFn } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedService } from "@/lib/node-scope/scoped-service";
import { appCommandScope, isAppCommandScope, listenInScope } from "@/lib/node-scope-slots";
import type { ResourceKind } from "@orkestrator/protocol/resource-events";
import { scopeBackendClient } from "@/lib/backend/client";
import {
  configTargetsFor,
  runConfigCommand,
  settingsParent,
} from "@/lib/portal/command-node-config";
import { adoptPersistedPaneLayout, onPaneLayoutWriteSettled } from "@/lib/pane-layout-persistence";
import {
  commitBuildPipelineSetupHandoff,
  commitStartupAgentSetupHandoff,
  flushPaneTabActivation,
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
} from "@/lib/pane-layout-authoritative";
import {
  hydrateMultiReviewWorkflow,
  hydrateMultiReviewWorkflowsForEnvironment,
} from "@/lib/multi-review-persistence";
import {
  buildPipelineChangeReadOptions,
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
} from "@/lib/build-pipeline-persistence";
import { hydratePromptQueuesForEnvironment } from "@/lib/prompt-queue-persistence";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { configStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  applyProjectSnapshot,
  getProjectMutationVersion,
  useProjectStore,
} from "@/stores/projectStore";
import { useSessionStore } from "@/stores/sessionStore";
import { refreshObservedAgentMailMailboxes, useAgentMailStore } from "@/stores/agentMailStore";
import type { ResourceManifestKind } from "@orkestrator/protocol/resource-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { AppConfig } from "@/types";

const log = createLogger("web.resource-sync");

/**
 * Most workflow ids a hidden window remembers to re-read. Past it the window
 * forgets the ids and reconciles both collections once it is shown again.
 */
export const MAX_DEFERRED_WORKFLOW_READS = 512;

/** Delay between attempts to hydrate acknowledged hidden-window changes. */
export const DEFERRED_WORKFLOW_RETRY_MS = 1_000;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Binds a node's backend change feed to the stores that are read-through
 * caches of it.
 *
 * Each binding refetches only when this client is actually showing the affected
 * scope — a kanban change for a project nobody has open costs nothing.
 * Build pipelines and Multi Reviews feed views across every environment (the
 * sidebar, boards, badges), so their changes are read in every visible window;
 * a hidden window only remembers which ids changed and reads them when it is
 * shown again, instead of re-reading on every save while nobody looks.
 * Pane/tab existence is backend-owned too, while active pane/tab selection is
 * preserved locally whenever an authoritative snapshot is installed.
 *
 * Live project/environment changes are also consumed by their UI hooks for
 * low-latency updates. Manifest/full reconciliation owns those collections
 * here as well so convergence never depends on the sidebar being mounted.
 *
 * ## Per-store handler registrations (plan item 3014)
 *
 * The bindings are split by store into `StoreResourceHandlers` registrations
 * (`defineStoreResourceHandlers`), listed in `STORE_RESOURCE_HANDLERS`. Each
 * runs inside one node scope's sync (`storeResourceSyncService`) and gets a
 * `StoreResourceSyncContext`: the scope, the feed's change and resync
 * subscriptions (stopped for it), the scope's events, and a phase in the one
 * serialized authoritative resync:
 *
 * 1. `projects`, then 2. `environments`, one participant after another, so
 *    every later read sees the new collections;
 * 3. `dependents`, all at once (each read settles on its own);
 * 4. `layouts`, after every dependent read.
 *
 * A participant that refuses a stale snapshot calls `pass.requeue(resource)`
 * so the same loop reads it again before the manifest handler resolves (and
 * acknowledges its revision).
 *
 * A registration says where it may run. `command-scope` ones write stores that
 * are still command-scope singletons, so they run only for the command scope:
 * started for another node they would write that node's data into the command
 * node's stores. A store item that scopes its store moves its registration into
 * the store's module, reads `context.scope.store(def)` instead of the hook, and
 * marks it `every-scope`.
 */
export interface StoreResourceSyncOptions {
  getConfig?: typeof getConfig;
  getProjects?: typeof getProjects;
  getEnvironmentSnapshots?: typeof getEnvironmentSnapshots;
  getPaneLayout?: typeof getPaneLayout;
  getAgentMailSummary?: typeof getAgentMailSummary;
  adoptPaneLayout?: typeof adoptPersistedPaneLayout;
  onPaneLayoutWriteSettled?: typeof onPaneLayoutWriteSettled;
  listen?: typeof listen;
}

/** The authoritative resync's phases, in the order they run. */
export type StoreResyncPhase = "projects" | "environments" | "dependents" | "layouts";

const RESYNC_PHASES: readonly StoreResyncPhase[] = [
  "projects",
  "environments",
  "dependents",
  "layouts",
];

/** The failure each phase logs, as before the split. */
const RESYNC_PHASE_FAILURE = {
  projects: "resync.project-failed",
  environments: "resync.environment-failed",
  dependents: "resync.read-failed",
  layouts: "resync.pane-failed",
} as const;

/** One pass of the serialized resync loop. */
export interface StoreResyncPass {
  /** Whether this pass covers `resource`; a full pass covers every one. */
  includes(resource: ResourceManifestKind): boolean;
  /** A snapshot was refused as stale: read `resource` again in this loop. */
  requeue(resource: ResourceManifestKind): void;
}

/**
 * What a participant returns: nothing (it does not apply to this pass), one
 * read, or several reads that each settle on their own.
 */
export type StoreResyncWork = void | Promise<unknown> | ReadonlyArray<Promise<unknown>>;

export type StoreResyncParticipant = (pass: StoreResyncPass) => StoreResyncWork;

export interface StoreResourceSyncContext {
  readonly scope: NodeScope;
  /** Aborts when the sync stops; every consumer handles the rejection it causes. */
  readonly signal: AbortSignal;
  readonly options: StoreResourceSyncOptions;
  /** True once the sync stopped. Check it after every await before writing. */
  disposed(): boolean;
  /** `onResourceChanged` on this scope's feed, unsubscribed when the sync stops. */
  onResourceChanged(resource: ResourceKind, handler: Parameters<typeof onResourceChanged>[1]): void;
  /** Joins the authoritative resync in `phase`. */
  onResync(phase: StoreResyncPhase, participant: StoreResyncParticipant): void;
  /**
   * Listens for `event` on this scope's node (through `options.listen` when a
   * test passes one), stopped when the sync stops. A failed subscribe is
   * passed to `onError`.
   */
  listen<T>(event: string, handler: (payload: T) => void, onError?: (error: unknown) => void): void;
  /** Runs `stop` when the sync stops, before the subscriptions are dropped. */
  onStop(stop: () => void): void;
  /** Queues a resync in the serialized loop; resolves when the loop is idle. */
  requestResync(request: ResourceResyncRequest): Promise<void>;
}

export type StoreResourceHandlersScope = "command-scope" | "every-scope";

export interface StoreResourceHandlers {
  /** Bounded and stable: the store (or stores) it binds. */
  readonly name: string;
  readonly runsOn: StoreResourceHandlersScope;
  register(context: StoreResourceSyncContext): void;
}

export function defineStoreResourceHandlers(
  name: string,
  runsOn: StoreResourceHandlersScope,
  register: (context: StoreResourceSyncContext) => void,
): StoreResourceHandlers {
  return Object.freeze({ name, runsOn, register });
}

/** Only the identity is needed here; the environment body is read authoritatively. */
interface EnvironmentSetupCompletePayload {
  environment_id: string;
}

interface DeferredPaneLayoutRefresh {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const projectHandlers = defineStoreResourceHandlers("projects", "command-scope", (context) => {
  context.onResync("projects", async (pass) => {
    if (!pass.includes("project")) return;
    const projectsAtRequest = useProjectStore.getState().projects;
    const mutationVersion = getProjectMutationVersion();
    const projects = await (context.options.getProjects ?? getProjects)();
    // A live refresh, local mutation, or newer manifest read may have
    // installed a newer collection while this request was in flight. Both
    // guards are needed: the mutation version covers optimistic writes,
    // while array identity orders concurrent authoritative reads.
    const accepted =
      !context.disposed() &&
      useProjectStore.getState().projects === projectsAtRequest &&
      applyProjectSnapshot(projects, mutationVersion);
    if (!context.disposed() && !accepted) pass.requeue("project");
  });
});

const environmentHandlers = defineStoreResourceHandlers(
  "environments",
  "command-scope",
  (context) => {
    context.onResync("environments", async (pass) => {
      if (!pass.includes("environment")) return;
      const environmentsAtRequest = useEnvironmentStore.getState().environments;
      // This phase runs after the project phase, so it sees projects added or
      // removed while the renderer was inactive. Install all project scopes
      // atomically: one failed read must not leave a half-new environment set.
      const projectIds = useProjectStore.getState().projects.map(({ id }) => id);
      const snapshots = await Promise.all(
        projectIds.map((projectId) =>
          (context.options.getEnvironmentSnapshots ?? getEnvironmentSnapshots)(projectId),
        ),
      );
      const accepted =
        !context.disposed() &&
        useEnvironmentStore.getState().environments === environmentsAtRequest;
      if (accepted) {
        useEnvironmentStore.getState().setEnvironments(snapshots.flat());
      } else if (!context.disposed()) {
        pass.requeue("environment");
      }
    });
  },
);

/**
 * The scope's config store (plan item 3005), and clearing agent mail when
 * messaging is turned off.
 *
 * Every scope reads its own node's config. Under a parent scope (an in-tree
 * leaf) the store lays the parent's preferences over it itself, and the
 * parent's own sync keeps that layer current. Under a parent with no scope
 * here (a realm document's portal) the read is the effective one, and the
 * parent's config changes are followed too. Agent mail is still a
 * command-scope store, so only a command scope clears it.
 */
const configHandlers = defineStoreResourceHandlers("config", "every-scope", (context) => {
  const store = context.scope.store(configStore);
  const parent = settingsParent(context.scope);
  const readConfig = (): Promise<AppConfig> => {
    if (context.options.getConfig) return context.options.getConfig();
    // The app's command scope keeps the `@/lib/backend` read, which suites mock.
    if (isAppCommandScope(context.scope)) return getConfig();
    return runConfigCommand(
      parent?.scope
        ? { commandNode: scopeBackendClient(context.scope), node: null }
        : configTargetsFor(context.scope),
      "get_config",
    );
  };
  let configRequestGeneration = 0;
  const refreshConfig = async (): Promise<void> => {
    const generation = ++configRequestGeneration;
    try {
      const config = await readConfig();
      if (!context.disposed() && generation === configRequestGeneration) {
        store.getState().setConfig(config);
        const messagingEnabled = (config as { global?: { agentMessaging?: { enabled?: boolean } } })
          ?.global?.agentMessaging?.enabled;
        if (messagingEnabled === false && context.scope.role === "command") {
          useAgentMailStore.getState().clear();
        }
      }
    } catch (error) {
      log.warn("config.refresh-failed", { error: formatLogError(error) });
      throw error;
    }
  };

  context.onResync("dependents", (pass) => (pass.includes("config") ? refreshConfig() : undefined));
  context.onResourceChanged("config", () => refreshConfig());

  // A parent with no scope here has no sync of its own in this window:
  // follow its config changes too.
  if (parent?.onConfigChanged) {
    let stopParentConfig: (() => void) | null = null;
    void parent
      .onConfigChanged(() => {
        if (!context.disposed()) void refreshConfig().catch(() => undefined);
      })
      .then((stop) => {
        if (context.disposed()) stop();
        else stopParentConfig = stop;
      })
      .catch(() => undefined);
    context.onStop(() => stopParentConfig?.());
  }
});

const agentMailHandlers = defineStoreResourceHandlers("agent-mail", "command-scope", (context) => {
  const refreshAgentMailSummary = async (): Promise<void> => {
    const enabled = context.scope.store(configStore).getState().config?.global
      ?.agentMessaging?.enabled;
    if (enabled === false) {
      useAgentMailStore.getState().clear();
      return;
    }
    if (enabled !== true) return;
    const snapshot = await (context.options.getAgentMailSummary ?? getAgentMailSummary)();
    if (!context.disposed()) {
      const store = useAgentMailStore.getState();
      store.setSummary(snapshot);
      await refreshObservedAgentMailMailboxes();
    }
  };

  context.onResync("dependents", (pass) =>
    pass.includes("agent-mail-summary") ? refreshAgentMailSummary() : undefined,
  );

  context.onResourceChanged("agent-mail-summary", () => {
    return refreshAgentMailSummary().catch((error) => {
      log.warn("agent-mail.summary-refresh-failed", { error: formatLogError(error) });
      throw error;
    });
  });

  context.onResourceChanged("agent-mail", ({ id: mailboxId }) => {
    const existing = useAgentMailStore.getState().mailboxes.get(mailboxId);
    if (!existing) return;
    return useAgentMailStore
      .getState()
      .refreshMailbox(existing.descriptor.environmentId, existing.descriptor.tabId)
      .catch((error) => {
        log.warn("agent-mail.mailbox-refresh-failed", {
          environmentId: existing.descriptor.environmentId,
          tabId: existing.descriptor.tabId,
          error: formatLogError(error),
        });
        throw error;
      });
  });
});

const promptQueueHandlers = defineStoreResourceHandlers(
  "prompt-queues",
  "command-scope",
  (context) => {
    const promptQueueSources = createPromptQueueSources();
    context.onResync("dependents", (pass) =>
      pass.includes("prompt-queue")
        ? useEnvironmentStore
            .getState()
            .environments.map(({ id }) => hydratePromptQueuesForEnvironment(id, promptQueueSources))
        : undefined,
    );
    context.onResourceChanged("prompt-queue", ({ id: environmentId }) => {
      // Queues announce against their environment rather than their tab, so this
      // refetches every queue the environment owns. That is deliberate: a client
      // that has never opened a tab still needs its queue if it opens one next.
      if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
      return hydratePromptQueuesForEnvironment(environmentId, promptQueueSources).catch((error) => {
        log.warn("prompt-queues.refresh-failed", {
          environmentId,
          error: formatLogError(error),
        });
        throw error;
      });
    });
  },
);

const sessionHandlers = defineStoreResourceHandlers("sessions", "command-scope", (context) => {
  context.onResync("dependents", (pass) =>
    pass.includes("session")
      ? useEnvironmentStore
          .getState()
          .environments.map(({ id }) => useSessionStore.getState().loadSessionsForEnvironment(id))
      : undefined,
  );
  context.onResourceChanged("session", ({ id: environmentId }) => {
    // Sessions are only meaningful for environments this client has loaded.
    if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
    return useSessionStore.getState().loadSessionsForEnvironment(environmentId);
  });
});

/**
 * Build pipelines and Multi Reviews, which share the hidden-window deferral:
 * a hidden window remembers the ids that changed and reads them once shown.
 */
const workflowHandlers = defineStoreResourceHandlers("workflows", "command-scope", (context) => {
  const deferredPipelineReads = new Set<string>();
  const deferredMultiReviewReads = new Set<string>();
  let deferredWorkflowReadsOverflowed = false;
  let deferredWorkflowGeneration = 0;
  let workflowFlushRunning = false;
  let workflowRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Remembers a change a hidden window will read when shown; true when deferred. */
  const deferWhileHidden = (reads: Set<string>, id: string): boolean => {
    if (!documentHidden()) return false;
    deferredWorkflowGeneration += 1;
    if (deferredWorkflowReadsOverflowed) return true;
    reads.add(id);
    if (deferredPipelineReads.size + deferredMultiReviewReads.size > MAX_DEFERRED_WORKFLOW_READS) {
      deferredPipelineReads.clear();
      deferredMultiReviewReads.clear();
      deferredWorkflowReadsOverflowed = true;
    }
    return true;
  };

  const refreshBuildPipelinesForProject = async (projectId: string): Promise<void> => {
    const authoritative = await hydrateBuildPipelinesForProject(projectId);
    if (context.disposed()) return;
    const authoritativeIds = new Set(authoritative.map(({ id }) => id));
    const store = useBuildPipelineStore.getState();
    for (const [pipelineId, pipeline] of store.pipelines) {
      if (
        pipeline.projectId === projectId &&
        pipeline.backendRevision > 0 &&
        !authoritativeIds.has(pipelineId)
      ) {
        store.removePipeline(pipelineId);
      }
    }
  };

  context.onResync("dependents", (pass) => {
    const work: Promise<unknown>[] = [];
    if (pass.includes("multi-review")) {
      for (const { id } of useEnvironmentStore.getState().environments) {
        work.push(hydrateMultiReviewWorkflowsForEnvironment(id));
      }
    }
    if (pass.includes("build-pipeline")) {
      for (const { id } of useProjectStore.getState().projects) {
        work.push(refreshBuildPipelinesForProject(id));
      }
    }
    return work;
  });

  const refreshPipeline = (pipelineId: string): Promise<void> =>
    // A missing record means another client finished or deleted this build.
    // Dropping it locally is what stops a stale tab from resuming a dead
    // pipeline, so treat "not found" as authoritative rather than as an error.
    // Bodies only while a transcript of this pipeline is on screen.
    hydrateBuildPipeline(pipelineId, undefined, buildPipelineChangeReadOptions(pipelineId))
      .then((pipeline) => {
        if (pipeline) return;
        const local = useBuildPipelineStore.getState().pipelines.get(pipelineId);
        if (local?.backendRevision) {
          useBuildPipelineStore.getState().removePipeline(pipelineId);
        }
      })
      .catch((error) => {
        log.warn("build-pipeline.refresh-failed", { pipelineId, error: formatLogError(error) });
        throw error;
      });

  const refreshMultiReview = (workflowId: string): Promise<void> =>
    hydrateMultiReviewWorkflow(workflowId)
      .then(() => undefined)
      .catch((error) => {
        log.warn("multi-review.refresh-failed", { workflowId, error: formatLogError(error) });
        throw error;
      });

  context.onResourceChanged("build-pipeline", ({ id: pipelineId }) => {
    if (deferWhileHidden(deferredPipelineReads, pipelineId)) return;
    return refreshPipeline(pipelineId);
  });

  context.onResourceChanged("multi-review", ({ id: workflowId }) => {
    if (deferWhileHidden(deferredMultiReviewReads, workflowId)) return;
    return refreshMultiReview(workflowId);
  });

  const flushDeferredWorkflowReads = (): void => {
    if (context.disposed() || documentHidden() || workflowFlushRunning) return;
    if (workflowRetryTimer) clearTimeout(workflowRetryTimer);
    workflowRetryTimer = null;
    const generation = deferredWorkflowGeneration;
    workflowFlushRunning = true;
    const flush = async (): Promise<void> => {
      if (deferredWorkflowReadsOverflowed) {
        await context.requestResync({
          resources: new Set<ResourceManifestKind>(["build-pipeline", "multi-review"]),
          reason: "explicit",
        });
        if (generation === deferredWorkflowGeneration) deferredWorkflowReadsOverflowed = false;
        return;
      }
      const refresh = async (ids: Set<string>, read: (id: string) => Promise<void>) => {
        await Promise.allSettled(
          Array.from(ids, async (id) => {
            await read(id);
            // A hidden-window change arriving during the read still needs replay.
            if (generation === deferredWorkflowGeneration) ids.delete(id);
          }),
        );
      };
      await Promise.all([
        refresh(deferredPipelineReads, refreshPipeline),
        refresh(deferredMultiReviewReads, refreshMultiReview),
      ]);
    };
    void flush()
      .catch(() => undefined)
      .finally(() => {
        workflowFlushRunning = false;
        if (
          !context.disposed() &&
          !documentHidden() &&
          (deferredWorkflowReadsOverflowed ||
            deferredPipelineReads.size ||
            deferredMultiReviewReads.size)
        ) {
          // Manifest delivery already acknowledged these changes. Retry independently
          // with one bounded timer, even when every subsequent manifest is unchanged.
          workflowRetryTimer = setTimeout(() => {
            workflowRetryTimer = null;
            flushDeferredWorkflowReads();
          }, DEFERRED_WORKFLOW_RETRY_MS);
        }
      });
  };
  // The document's own visibility, as before the split; the read policy's
  // host-hidden override (plan item 0003) is not consulted here yet.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", flushDeferredWorkflowReads);
    context.onStop(() =>
      document.removeEventListener("visibilitychange", flushDeferredWorkflowReads),
    );
  }

  context.onStop(() => {
    if (workflowRetryTimer) clearTimeout(workflowRetryTimer);
    workflowRetryTimer = null;
    deferredPipelineReads.clear();
    deferredMultiReviewReads.clear();
  });
});

const kanbanHandlers = defineStoreResourceHandlers("kanban", "command-scope", (context) => {
  context.onResync("dependents", (pass) => {
    const kanban = useKanbanStore.getState();
    const work: Promise<unknown>[] = [];
    if (pass.includes("kanban") && kanban.currentProjectId) {
      work.push(kanban.loadTasks(kanban.currentProjectId));
    }
    if (pass.includes("project-notes") && kanban.currentNotesProjectId) {
      work.push(kanban.loadNotes(kanban.currentNotesProjectId));
    }
    return work;
  });

  context.onResourceChanged("kanban", ({ id: projectId }) => {
    // Reloading a project the user has since navigated away from would race the
    // store's own currentProjectId guard and show the wrong board.
    if (useKanbanStore.getState().currentProjectId !== projectId) return;
    return useKanbanStore.getState().loadTasks(projectId);
  });

  context.onResourceChanged("project-notes", ({ id: projectId }) => {
    if (useKanbanStore.getState().currentNotesProjectId !== projectId) return;
    return useKanbanStore.getState().loadNotes(projectId);
  });
});

const featurePlanHandlers = defineStoreResourceHandlers(
  "feature-plan",
  "command-scope",
  (context) => {
    context.onResync("dependents", (pass) => {
      const featurePlan = useFeaturePlanStore.getState();
      return pass.includes("feature-plan") && featurePlan.currentProjectId
        ? featurePlan.loadFeatures(featurePlan.currentProjectId)
        : undefined;
    });
    context.onResourceChanged("feature-plan", ({ id: projectId }) => {
      if (useFeaturePlanStore.getState().currentProjectId !== projectId) return;
      return useFeaturePlanStore.getState().loadFeatures(projectId);
    });
  },
);

const paneLayoutHandlers = defineStoreResourceHandlers(
  "pane-layout",
  "command-scope",
  (context) => {
    const { options } = context;
    const paneLayoutRequestGenerations = new Map<string, number>();
    const deferredPaneLayoutRefreshes = new Map<string, DeferredPaneLayoutRefresh>();
    const declinedPaneLayoutRefreshes = new Set<string>();

    const refreshPaneLayout = async (environmentId: string): Promise<void> => {
      const paneStore = usePaneLayoutStore.getState();
      const hydration = paneStore.hydration.get(environmentId);
      if (hydration === "pending") {
        const existing = deferredPaneLayoutRefreshes.get(environmentId);
        if (existing) return existing.promise;

        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        deferredPaneLayoutRefreshes.set(environmentId, {
          promise,
          resolve,
          reject,
        });
        return promise;
      }
      if (hydration !== "done") return;

      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (!environment) return;
      const requestedContainerId =
        environment.environmentType === "local" ? null : environment.containerId;
      const requestedEnvironmentType = environment.environmentType;
      const requestedWorktreePath = environment.worktreePath;

      const generation = (paneLayoutRequestGenerations.get(environmentId) ?? 0) + 1;
      paneLayoutRequestGenerations.set(environmentId, generation);
      const saved = await (options.getPaneLayout ?? getPaneLayout)(environmentId);
      if (context.disposed() || paneLayoutRequestGenerations.get(environmentId) !== generation) {
        return;
      }

      if (saved) {
        await hydratePaneLayoutDependencies(saved.root);
        if (context.disposed() || paneLayoutRequestGenerations.get(environmentId) !== generation) {
          return;
        }
      }

      const latestPaneStore = usePaneLayoutStore.getState();
      const current = latestPaneStore.environments.get(environmentId);
      const latestEnvironment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (latestPaneStore.hydration.get(environmentId) !== "done" || !latestEnvironment) {
        return;
      }
      const latestContainerId =
        latestEnvironment.environmentType === "local" ? null : latestEnvironment.containerId;
      if (
        latestEnvironment.environmentType !== requestedEnvironmentType ||
        latestContainerId !== requestedContainerId ||
        latestEnvironment.worktreePath !== requestedWorktreePath ||
        (current != null && current.containerId !== latestContainerId)
      ) {
        return;
      }

      if (!saved) return;
      const selected = reconcileAuthoritativePaneLayout(
        environmentId,
        saved,
        current ?? {
          root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
          activePaneId: "default",
          containerId: latestContainerId,
        },
      );
      if (!selected) return;

      // Prime the persistence mirror before publishing the store update so this
      // read-through snapshot does not become a redundant write-back.
      const adopt = options.adoptPaneLayout ?? adoptPersistedPaneLayout;
      if (!adopt(environmentId, selected, context.scope)) {
        // The layout we just fetched is dropped in favour of a local write that
        // has not landed yet. That write announces its own revision on success —
        // but if it fails, nothing else would ever come back for this snapshot.
        declinedPaneLayoutRefreshes.add(environmentId);
        return;
      }
      declinedPaneLayoutRefreshes.delete(environmentId);
      latestPaneStore.applyAuthoritativeLayout(environmentId, selected);
      flushPaneTabActivation(environmentId);
      commitBuildPipelineSetupHandoff(environmentId, selected);
      commitStartupAgentSetupHandoff(environmentId, selected);
    };

    const requestPaneLayoutRefresh = (environmentId: string): void => {
      void refreshPaneLayout(environmentId).catch((error) => {
        log.warn("pane-layout.refresh-failed", { environmentId, error: formatLogError(error) });
      });
    };

    const stopWriteSettled = (options.onPaneLayoutWriteSettled ?? onPaneLayoutWriteSettled)(
      (environmentId) => {
        if (context.disposed() || !declinedPaneLayoutRefreshes.has(environmentId)) return;
        declinedPaneLayoutRefreshes.delete(environmentId);
        requestPaneLayoutRefresh(environmentId);
      },
      context.scope,
    );

    // Setup completion is the one moment the backend deliberately moves the
    // authoritative selection off the setup terminal and onto the build surface
    // (build-pipeline-service `waiting-for-setup` -> `ensureBuildPipelineTab`).
    // That handoff is published as an ordinary `pane-layout` announcement, so a
    // client that was mid-write, mid-hydration or briefly disconnected can miss
    // the single frame that carries it and sit on the setup tab while the agent
    // works out of sight. Re-read the authoritative layout on the completion
    // event itself so the handoff never depends on one frame surviving.
    context.listen<EnvironmentSetupCompletePayload>(
      "environment-setup-complete",
      (payload) => {
        if (context.disposed()) return;
        requestPaneLayoutRefresh(payload.environment_id);
      },
      (error) => {
        log.warn("setup-completion.observe-failed", { error: formatLogError(error) });
      },
    );

    const stopPaneStore = usePaneLayoutStore.subscribe((state, previous) => {
      for (const [environmentId, deferred] of Array.from(deferredPaneLayoutRefreshes)) {
        if (
          previous.hydration.get(environmentId) === "pending" &&
          state.hydration.get(environmentId) === "done"
        ) {
          void refreshPaneLayout(environmentId)
            .then(
              () => deferred.resolve(),
              (error) => deferred.reject(error),
            )
            .finally(() => {
              if (deferredPaneLayoutRefreshes.get(environmentId) === deferred) {
                deferredPaneLayoutRefreshes.delete(environmentId);
              }
            });
        }
      }
      // An environment that left the pane store will never settle a write or
      // finish hydrating, so its queued replays would be retained forever.
      for (const [environmentId, deferred] of Array.from(deferredPaneLayoutRefreshes)) {
        if (!state.hydration.has(environmentId)) {
          deferredPaneLayoutRefreshes.delete(environmentId);
          deferred.resolve();
        }
      }
      for (const environmentId of Array.from(declinedPaneLayoutRefreshes)) {
        if (!state.environments.has(environmentId)) {
          declinedPaneLayoutRefreshes.delete(environmentId);
          paneLayoutRequestGenerations.delete(environmentId);
        }
      }
    });

    // The layouts phase reads the environments as the dependents phase saw
    // them, right after the collection phases.
    let layoutEnvironmentIds: string[] = [];
    context.onResync("dependents", (pass) => {
      layoutEnvironmentIds = pass.includes("pane-layout")
        ? useEnvironmentStore.getState().environments.map(({ id }) => id)
        : [];
    });
    context.onResync("layouts", () => {
      const ids = layoutEnvironmentIds;
      layoutEnvironmentIds = [];
      return ids.map(refreshPaneLayout);
    });

    context.onResourceChanged("pane-layout", ({ id: environmentId }) => {
      if (!useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
      return refreshPaneLayout(environmentId).catch((error) => {
        log.warn("pane-layout.refresh-failed", { environmentId, error: formatLogError(error) });
        throw error;
      });
    });

    context.onStop(() => {
      for (const deferred of deferredPaneLayoutRefreshes.values()) {
        deferred.resolve();
      }
      deferredPaneLayoutRefreshes.clear();
      declinedPaneLayoutRefreshes.clear();
      paneLayoutRequestGenerations.clear();
      stopWriteSettled();
      stopPaneStore();
    });
  },
);

/**
 * Every registration, in the order they bind and their resync reads start.
 * Projects and environments come first: later phases read those collections.
 */
export const STORE_RESOURCE_HANDLERS: readonly StoreResourceHandlers[] = [
  projectHandlers,
  environmentHandlers,
  configHandlers,
  agentMailHandlers,
  promptQueueHandlers,
  sessionHandlers,
  workflowHandlers,
  kanbanHandlers,
  featurePlanHandlers,
  paneLayoutHandlers,
];

/** The registrations that may run on `scope` (see `StoreResourceHandlers.runsOn`). */
export function storeResourceHandlersFor(
  scope: NodeScope,
  handlers: readonly StoreResourceHandlers[] = STORE_RESOURCE_HANDLERS,
): StoreResourceHandlers[] {
  return handlers.filter((entry) => entry.runsOn === "every-scope" || scope.role === "command");
}

export interface StartStoreResourceSyncInit {
  /** Defaults to the command scope. */
  scope?: NodeScope;
  /** Defaults to the ones `scope` may run (`storeResourceHandlersFor`). */
  handlers?: readonly StoreResourceHandlers[];
  /** The service's signal; without one the sync owns an internal one. */
  signal?: AbortSignal;
}

/**
 * Starts the registrations for one scope (the command scope by default) and
 * returns the stop. Production starts it through `storeResourceSyncService`.
 */
export function startStoreResourceSync(
  options: StoreResourceSyncOptions = {},
  init: StartStoreResourceSyncInit = {},
): () => void {
  const scope = init.scope ?? appCommandScope();
  const handlers = init.handlers ?? storeResourceHandlersFor(scope);
  const ownController = init.signal ? null : new AbortController();
  const signal = init.signal ?? ownController!.signal;
  const unsubscribes: Array<() => void> = [];
  const stops: Array<() => void> = [];
  const participants = new Map<StoreResyncPhase, StoreResyncParticipant[]>(
    RESYNC_PHASES.map((phase) => [phase, []]),
  );
  let disposed = false;
  let pendingResyncResources: Set<ResourceManifestKind> | null | undefined;
  let resyncPromise: Promise<void> | null = null;

  const queueSelectiveResync = (resource: ResourceManifestKind): void => {
    // A full request already subsumes this retry. Otherwise keep it in the
    // same serialized resync loop so the manifest handler does not resolve —
    // and acknowledge its revision — until a non-stale snapshot is applied.
    if (pendingResyncResources === null) return;
    pendingResyncResources ??= new Set();
    pendingResyncResources.add(resource);
  };

  const resyncAll = async (resources: ReadonlySet<ResourceManifestKind> | null): Promise<void> => {
    const pass: StoreResyncPass = {
      includes: (resource) => resources === null || resources.has(resource),
      requeue: queueSelectiveResync,
    };
    let failed = false;
    const reportFailure = (phase: StoreResyncPhase, error: unknown) => {
      failed = true;
      log.warn(RESYNC_PHASE_FAILURE[phase], { error: formatLogError(error) });
    };
    for (const phase of RESYNC_PHASES) {
      if (phase === "projects" || phase === "environments") {
        // One participant after another: each later read sees this one's result.
        for (const participant of participants.get(phase)!) {
          try {
            await participant(pass);
          } catch (error) {
            reportFailure(phase, error);
          }
        }
        continue;
      }
      const work: Promise<unknown>[] = [];
      for (const participant of participants.get(phase)!) {
        try {
          const result = participant(pass);
          if (Array.isArray(result)) work.push(...(result as ReadonlyArray<Promise<unknown>>));
          else if (result) work.push(result as Promise<unknown>);
        } catch (error) {
          work.push(Promise.reject(error));
        }
      }
      for (const result of await Promise.allSettled(work)) {
        if (result.status === "rejected") reportFailure(phase, result.reason);
      }
    }
    if (failed) throw new Error("One or more authoritative resync reads failed");
  };

  const requestStoreResync = (request: ResourceResyncRequest): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (request.resources === null) {
      pendingResyncResources = null;
    } else if (pendingResyncResources !== null) {
      pendingResyncResources ??= new Set();
      for (const resource of request.resources) {
        pendingResyncResources.add(resource);
      }
    }
    if (resyncPromise) return resyncPromise;
    resyncPromise = (async () => {
      try {
        while (!disposed && pendingResyncResources !== undefined) {
          const resources = pendingResyncResources;
          pendingResyncResources = undefined;
          await resyncAll(resources);
        }
      } finally {
        resyncPromise = null;
      }
    })();
    return resyncPromise;
  };

  const context: StoreResourceSyncContext = {
    scope,
    signal,
    options,
    disposed: () => disposed,
    onResourceChanged(resource, handler) {
      unsubscribes.push(onResourceChanged(resource, handler, scope));
    },
    onResync(phase, participant) {
      participants.get(phase)!.push(participant);
    },
    listen<T>(event: string, handler: (payload: T) => void, onError?: (error: unknown) => void) {
      let unlisten: UnlistenFn | null = null;
      const subscribed = options.listen
        ? options.listen<T>(event, (message) => handler(message.payload))
        : listenInScope<T>(scope, event, handler);
      void subscribed
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((error: unknown) => onError?.(error));
      unsubscribes.push(() => unlisten?.());
    },
    onStop(stop) {
      stops.push(stop);
    },
    requestResync: requestStoreResync,
  };

  for (const entry of handlers) entry.register(context);
  unsubscribes.push(onResourceResync(requestStoreResync, scope));

  return () => {
    if (disposed) return;
    disposed = true;
    for (const stop of stops) stop();
    for (const unsubscribe of unsubscribes) unsubscribe();
    ownController?.abort();
  };
}

/**
 * The store bindings for one node scope: the registrations that may run on it
 * (`storeResourceHandlersFor`). Started after `resourceSyncService`, which owns
 * the feed they subscribe to.
 */
export const storeResourceSyncService = defineScopedService(
  "store-resource-sync",
  (scope, signal) => ({ stop: startStoreResourceSync({}, { scope, signal }) }),
);
