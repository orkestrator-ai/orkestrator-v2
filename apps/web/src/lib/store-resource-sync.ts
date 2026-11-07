import {
  getAgentMailSummary,
  getConfig,
  getEnvironmentSnapshots,
  getPaneLayout,
  getProjects,
  listPromptQueues,
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
import { createAgentMailApi } from "@/lib/backend/agent-mail";
import { backendApiForScope, scopeBackendClient } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import { createWorkflowsApi } from "@/lib/backend/workflows";
import { runConfigCommand } from "@/lib/portal/command-node-config";
import { adoptPersistedPaneLayout, onPaneLayoutWriteSettled } from "@/lib/pane-layout-persistence";
import {
  commitBuildPipelineSetupHandoff,
  commitStartupAgentSetupHandoff,
  flushPaneTabActivation,
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
} from "@/lib/pane-layout-authoritative";
import {
  hydratePromptQueuesForEnvironment,
  type PromptQueueListLoader,
} from "@/lib/prompt-queue-persistence";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { configStore } from "@/stores/configStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { environmentStore } from "@/stores/environmentStore";
import {
  environmentResourceHandlers,
  projectResourceHandlers,
} from "@/lib/project-environment-resource-handlers";
import {
  featurePlanResourceHandlers,
  kanbanResourceHandlers,
  workflowResourceHandlers,
} from "@/lib/workflow-resource-handlers";
import { sessionStore } from "@/stores/sessionStore";
import { agentMailStore } from "@/stores/agentMailStore";
import type { ResourceManifestKind } from "@orkestrator/protocol/resource-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { AppConfig } from "@/types";

const log = createLogger("web.resource-sync");

export {
  DEFERRED_WORKFLOW_RETRY_MS,
  MAX_DEFERRED_WORKFLOW_READS,
} from "@/lib/workflow-resource-handlers";

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

/**
 * The scope's config store (plan item 3005), and clearing agent mail when
 * messaging is turned off.
 *
 * Every scope reads its own node's config. Under a parent scope (an in-tree
 * leaf) the store lays the parent's preferences over it itself, and the
 * parent's own sync keeps that layer current. Turning messaging off clears
 * this node's agent mail (plan item 3010).
 */
const configHandlers = defineStoreResourceHandlers("config", "every-scope", (context) => {
  const store = context.scope.store(configStore);
  const readConfig = (): Promise<AppConfig> => {
    if (context.options.getConfig) return context.options.getConfig();
    // The app's command scope keeps the `@/lib/backend` read, which suites mock.
    if (isAppCommandScope(context.scope)) return getConfig();
    return runConfigCommand(
      { commandNode: scopeBackendClient(context.scope), node: null },
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
        if (messagingEnabled === false) {
          context.scope.store(agentMailStore).getState().clear();
        }
      }
    } catch (error) {
      log.warn("config.refresh-failed", { error: formatLogError(error) });
      throw error;
    }
  };

  context.onResync("dependents", (pass) => (pass.includes("config") ? refreshConfig() : undefined));
  context.onResourceChanged("config", () => refreshConfig());
});

/** Each node's agent mail follows that node's feed (plan item 3010). */
const agentMailHandlers = defineStoreResourceHandlers("agent-mail", "every-scope", (context) => {
  const mail = context.scope.store(agentMailStore);
  // The app's command scope keeps the `@/lib/backend` read, which suites mock.
  const readSummary = () =>
    context.options.getAgentMailSummary
      ? context.options.getAgentMailSummary()
      : backendApiForScope(context.scope, createAgentMailApi, {
          getAgentMailSummary,
        }).getAgentMailSummary();
  const refreshAgentMailSummary = async (): Promise<void> => {
    const enabled = context.scope.store(configStore).getState().config?.global
      ?.agentMessaging?.enabled;
    if (enabled === false) {
      mail.getState().clear();
      return;
    }
    if (enabled !== true) return;
    const snapshot = await readSummary();
    if (!context.disposed()) {
      mail.getState().setSummary(snapshot);
      await mail.getState().refreshObservedMailboxes();
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
    const existing = mail.getState().mailboxes.get(mailboxId);
    if (!existing) return;
    return mail
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

/** Each node's prompt queues follow that node's feed (plan item 4007). */
const promptQueueHandlers = defineStoreResourceHandlers(
  "prompt-queues",
  "every-scope",
  (context) => {
    const promptQueueSources = createPromptQueueSources(context.scope);
    // The app's command scope keeps the `@/lib/backend` read, which suites mock.
    const readPromptQueues: PromptQueueListLoader = (environmentId) =>
      backendApiForScope(context.scope, createWorkflowsApi, { listPromptQueues }).listPromptQueues(
        environmentId,
      );
    context.onResync("dependents", (pass) =>
      pass.includes("prompt-queue")
        ? context.scope
            .store(environmentStore)
            .getState()
            .environments.map(({ id }) =>
              hydratePromptQueuesForEnvironment(id, promptQueueSources, readPromptQueues),
            )
        : undefined,
    );
    context.onResourceChanged("prompt-queue", ({ id: environmentId }) => {
      // Queues announce against their environment rather than their tab, so this
      // refetches every queue the environment owns. That is deliberate: a client
      // that has never opened a tab still needs its queue if it opens one next.
      if (!context.scope.store(environmentStore).getState().getEnvironmentById(environmentId))
        return;
      return hydratePromptQueuesForEnvironment(
        environmentId,
        promptQueueSources,
        readPromptQueues,
      ).catch((error) => {
        log.warn("prompt-queues.refresh-failed", {
          environmentId,
          error: formatLogError(error),
        });
        throw error;
      });
    });
  },
);

/** Each node's sessions follow that node's feed (plan item 3010). */
const sessionHandlers = defineStoreResourceHandlers("sessions", "every-scope", (context) => {
  const sessions = context.scope.store(sessionStore);
  context.onResync("dependents", (pass) =>
    pass.includes("session")
      ? context.scope
          .store(environmentStore)
          .getState()
          .environments.map(({ id }) => sessions.getState().loadSessionsForEnvironment(id))
      : undefined,
  );
  context.onResourceChanged("session", ({ id: environmentId }) => {
    // Sessions are only meaningful for environments this client has loaded.
    if (!context.scope.store(environmentStore).getState().getEnvironmentById(environmentId)) return;
    return sessions.getState().loadSessionsForEnvironment(environmentId);
  });
});

const paneLayoutHandlers = defineStoreResourceHandlers("pane-layout", "every-scope", (context) => {
  const { options, scope } = context;
  // This node's pane layouts (plan item 3013), held for the registration's
  // life: the scope outlives it.
  const panes = scope.store(paneLayoutStore);
  const loadPaneLayout = (environmentId: string) =>
    (
      options.getPaneLayout ??
      backendApiForScope(scope, createFilesSessionsApi, { getPaneLayout }).getPaneLayout
    )(environmentId);
  const paneLayoutRequestGenerations = new Map<string, number>();
  const deferredPaneLayoutRefreshes = new Map<string, DeferredPaneLayoutRefresh>();
  const declinedPaneLayoutRefreshes = new Set<string>();

  const refreshPaneLayout = async (environmentId: string): Promise<void> => {
    const paneStore = panes.getState();
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

    const environment = context.scope
      .store(environmentStore)
      .getState()
      .getEnvironmentById(environmentId);
    if (!environment) return;
    const requestedContainerId =
      environment.environmentType === "local" ? null : environment.containerId;
    const requestedEnvironmentType = environment.environmentType;
    const requestedWorktreePath = environment.worktreePath;

    const generation = (paneLayoutRequestGenerations.get(environmentId) ?? 0) + 1;
    paneLayoutRequestGenerations.set(environmentId, generation);
    const saved = await loadPaneLayout(environmentId);
    if (context.disposed() || paneLayoutRequestGenerations.get(environmentId) !== generation) {
      return;
    }

    if (saved) {
      await hydratePaneLayoutDependencies(saved.root, scope);
      if (context.disposed() || paneLayoutRequestGenerations.get(environmentId) !== generation) {
        return;
      }
    }

    const latestPaneStore = panes.getState();
    const current = latestPaneStore.environments.get(environmentId);
    const latestEnvironment = context.scope
      .store(environmentStore)
      .getState()
      .getEnvironmentById(environmentId);
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
      scope,
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
    flushPaneTabActivation(environmentId, scope);
    commitBuildPipelineSetupHandoff(environmentId, selected, scope);
    commitStartupAgentSetupHandoff(environmentId, selected, scope);
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

  const stopPaneStore = panes.subscribe((state, previous) => {
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
      ? context.scope
          .store(environmentStore)
          .getState()
          .environments.map(({ id }) => id)
      : [];
  });
  context.onResync("layouts", () => {
    const ids = layoutEnvironmentIds;
    layoutEnvironmentIds = [];
    return ids.map(refreshPaneLayout);
  });

  context.onResourceChanged("pane-layout", ({ id: environmentId }) => {
    if (!context.scope.store(environmentStore).getState().getEnvironmentById(environmentId)) return;
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
});

/**
 * Every registration, in the order they bind and their resync reads start.
 * Projects and environments come first: later phases read those collections.
 */
export const STORE_RESOURCE_HANDLERS: readonly StoreResourceHandlers[] = [
  projectResourceHandlers,
  environmentResourceHandlers,
  configHandlers,
  agentMailHandlers,
  promptQueueHandlers,
  sessionHandlers,
  workflowResourceHandlers,
  kanbanResourceHandlers,
  featurePlanResourceHandlers,
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
