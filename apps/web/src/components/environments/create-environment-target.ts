import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { loadProjectsFromBackend } from "@/hooks/useProjects";
import { hydrateAgentModelCatalogCache } from "@/lib/agent-model-catalog-cache";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createDockerSkillsApi } from "@/lib/backend/docker-skills";
import { holdInTreeScope } from "@/lib/federation/in-tree-scopes";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { configStore } from "@/stores/configStore";
import { projectStore } from "@/stores/projectStore";

const log = createLogger("web.environment");

/**
 * How long a machine has to become a usable target: connecting to it and
 * reading its projects, settings and Docker state.
 */
export const CREATE_ENVIRONMENT_TARGET_TIMEOUT_MS = 30_000;

/**
 * How long a target waits for its saved model list. The list only decides
 * which models the form can offer, so a slow one arrives in the open form.
 */
export const CREATE_ENVIRONMENT_CATALOG_WAIT_MS = 2_000;

/** A machine the New Environment form can create on now. */
export interface CreateEnvironmentTarget {
  readonly scope: NodeScope;
  /** The repository's project on that machine. */
  readonly projectId: string;
  readonly dockerAvailable: boolean;
}

export interface PrepareCreateEnvironmentTargetOptions {
  readonly windowScope: WindowScope;
  /** The machine's node, or `null` for the window's command node. */
  readonly nodeId: BackendId | null;
  readonly projectId: string;
  /** Refuse a machine that can create neither a worktree nor a container. */
  readonly requireUsable?: boolean;
  readonly timeoutMs?: number;
  /** Owns the preparation and retains its scope pin until aborted. */
  readonly signal: AbortSignal;
}

/**
 * Makes a machine ready to be the New Environment form's target, in the
 * background: opens its node scope and loads what the form reads there. It
 * selects nothing and shows nothing, so the window does not move. Rejects with
 * a message for the user when the machine cannot be the target.
 *
 * The caller keeps the pin through the handoff and releases it by aborting
 * its signal when the target is no longer needed.
 */
export async function prepareCreateEnvironmentTarget({
  windowScope,
  nodeId,
  projectId,
  requireUsable = true,
  timeoutMs = CREATE_ENVIRONMENT_TARGET_TIMEOUT_MS,
  signal,
}: PrepareCreateEnvironmentTargetOptions): Promise<CreateEnvironmentTarget> {
  signal.throwIfAborted();
  const readiness = new AbortController();
  const stop = () => readiness.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    readiness.abort(
      new Error("It did not answer in time. It may be unreachable or still loading."),
    );
  }, timeoutMs);
  const ended = readiness.signal;
  let hold: ReturnType<typeof holdInTreeScope> | null = null;
  const release = () => hold?.release();
  let retained = false;
  let stopScopes: (() => void) | undefined;

  const interrupted = new Promise<never>((_, reject) => {
    ended.addEventListener(
      "abort",
      () => {
        if (!retained) release();
        reject(ended.reason);
      },
      { once: true },
    );
  });
  void interrupted.catch(() => undefined);
  try {
    hold = nodeId ? holdInTreeScope(nodeId, { windowScope, pin: true }) : null;
    const scope = hold
      ? await Promise.race([
          hold.scope.catch((error: unknown) => {
            throw new Error(
              `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
          interrupted,
        ])
      : windowScope.commandScope();
    ended.throwIfAborted();
    const checkScope = () => {
      if (scope.disposed) readiness.abort(new Error("Its connection was closed."));
    };
    stopScopes = windowScope.nodeScopes.subscribe(checkScope);
    checkScope();
    ended.throwIfAborted();

    const [docker] = await Promise.race([
      Promise.all([
        readDocker(scope),
        loadProjects(scope, ended),
        whenConfigLoaded(scope, ended),
        waitForCatalog(scope, ended),
      ]),
      interrupted,
    ]);
    ended.throwIfAborted();
    const project = scope
      .store(projectStore)
      .getState()
      .projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("The project is not on that machine any more.");
    if (requireUsable && !project.localPath && !docker) {
      throw new Error("The project has no local checkout and Docker is unavailable.");
    }
    signal.addEventListener("abort", release, { once: true });
    retained = true;
    return { scope, projectId, dockerAvailable: docker };
  } finally {
    stopScopes?.();
    signal.removeEventListener("abort", stop);
    clearTimeout(timer);
    readiness.abort();
    if (!retained) release();
  }
}

/** The node's Docker daemon; a failed read leaves containers unavailable until a later probe. */
function readDocker(scope: NodeScope): Promise<boolean> {
  return backendApiForScope(scope, createDockerSkillsApi, backend)
    .checkDocker()
    .then(
      (result) => result?.available === true,
      () => false,
    );
}

async function loadProjects(scope: NodeScope, ended: AbortSignal): Promise<void> {
  const store = scope.store(projectStore);
  do {
    await loadProjectsFromBackend(scope);
  } while (!ended.aborted && !scope.disposed && store.getState().isLoading);
  const { hasLoaded, error } = store.getState();
  if (error || !hasLoaded) throw new Error(error ?? "Its projects could not be read.");
}

/** Resolves once the node's settings have loaded (the scope's own services read them). */
function whenConfigLoaded(scope: NodeScope, ended: AbortSignal): Promise<void> {
  const store = scope.store(configStore);
  return new Promise((resolve) => {
    if (ended.aborted || store.getState().hasLoaded) {
      resolve();
      return;
    }
    const finish = () => {
      unsubscribe();
      ended.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = store.subscribe((state) => {
      if (state.hasLoaded) finish();
    });
    ended.addEventListener("abort", finish, { once: true });
  });
}

/** The node's saved model lists, so a chosen model is found when the form moves there. */
function waitForCatalog(scope: NodeScope, ended: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      ended.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, CREATE_ENVIRONMENT_CATALOG_WAIT_MS);
    ended.addEventListener("abort", finish, { once: true });
    hydrateAgentModelCatalogCache({ scope }).then(finish, (error: unknown) => {
      log.debug("models.hydrate-failed", { error: formatLogError(error) });
      finish();
    });
  });
}
