import type { CreateFeatureBuildResult } from "@orkestrator/protocol/feature-build";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { buildPipelineStore, isActiveBuildPhase } from "@/stores/buildPipelineStore";
import { environmentStore } from "@/stores/environmentStore";
import { uiStore } from "@/stores/uiStore";
import { armBuildPipelineTabActivation } from "@/lib/pane-layout-authoritative";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.build-pipeline");

interface PendingFeatureBuildActivation {
  projectId: string;
}

const MAX_PENDING_FEATURE_BUILD_ACTIVATIONS = 128;

/**
 * One node's pending activations, by pipeline, and its pipeline-store
 * subscription while any is pending. A pipeline id belongs to one node, so
 * each scope keeps its own (plan item 3011); every function takes an optional
 * trailing `scope`, the app's command scope when omitted.
 */
interface FeatureBuildActivationState {
  readonly scope: NodeScope;
  readonly pendingActivations: Map<string, PendingFeatureBuildActivation>;
  unsubscribe: (() => void) | null;
}

const activationState = defineScopedSlot<FeatureBuildActivationState>(
  "feature-build-activation",
  (scope) => {
    const state: FeatureBuildActivationState = {
      scope,
      pendingActivations: new Map(),
      unsubscribe: null,
    };
    scope.onDispose("feature-build-activation", () => {
      state.unsubscribe?.();
      state.unsubscribe = null;
      state.pendingActivations.clear();
    });
    return state;
  },
);

function stopListeningWhenIdle(state: FeatureBuildActivationState): void {
  if (state.pendingActivations.size > 0 || !state.unsubscribe) return;
  state.unsubscribe();
  state.unsubscribe = null;
}

function activate(
  scope: NodeScope,
  projectId: string,
  environmentId: string,
  pipelineId: string,
): void {
  armBuildPipelineTabActivation(environmentId, pipelineId, scope);
  const ui = scope.store(uiStore).getState();
  ui.setProjectCollapsed(projectId, false);
  ui.selectProjectAndEnvironment(projectId, environmentId);

  // Pipeline environments are created by the backend pipeline rather than by
  // useEnvironments.createEnvironment(), so they do not pass through the
  // renderer's optimistic add path. Selecting only the ID leaves App on the
  // project board until a separate environment-list announcement happens to
  // arrive. Hydrate the targeted record directly so activation also works
  // while the sidebar is unmounted or after its live event was missed.
  const environments = scope.store(environmentStore);
  if (environments.getState().getEnvironmentById(environmentId)) return;
  void backendApiForScope(scope, createProjectsEnvironmentsApi, {
    getEnvironment: backend.getEnvironment,
  })
    .getEnvironment(environmentId)
    .then((environment) => {
      if (!environment) {
        log.warn("environment.not-found", { environmentId, projectId, pipelineId });
        return;
      }
      if (environment.projectId !== projectId) {
        log.warn("environment.project-mismatch", {
          environmentId,
          pipelineId,
          projectId,
          actualProjectId: environment.projectId,
        });
        return;
      }
      const store = environments.getState();
      if (!store.getEnvironmentById(environmentId)) store.addEnvironment(environment);
    })
    .catch((error) => {
      // The selection remains useful: manifest or live resource recovery can
      // still populate the environment store after a transient targeted-read
      // failure.
      log.warn("environment.hydrate-failed", {
        environmentId,
        projectId,
        pipelineId,
        error: formatLogError(error),
      });
    });
}

function reconcilePendingActivation(state: FeatureBuildActivationState, pipelineId: string): void {
  const { pendingActivations, scope } = state;
  const pending = pendingActivations.get(pipelineId);
  if (!pending) return;
  const pipeline = scope.store(buildPipelineStore).getState().pipelines.get(pipelineId);
  if (!pipeline) return;

  if (pipeline.projectId !== pending.projectId) {
    pendingActivations.delete(pipelineId);
    log.warn("pipeline.project-mismatch", {
      pipelineId,
      projectId: pending.projectId,
      actualProjectId: pipeline.projectId,
    });
  } else if (pipeline.environmentId) {
    pendingActivations.delete(pipelineId);
    activate(scope, pending.projectId, pipeline.environmentId, pipelineId);
  } else if (!isActiveBuildPhase(pipeline.phase)) {
    // A terminal pipeline without an environment can never satisfy this intent.
    pendingActivations.delete(pipelineId);
  }
  stopListeningWhenIdle(state);
}

function startListening(state: FeatureBuildActivationState): void {
  if (state.unsubscribe) return;
  state.unsubscribe = state.scope.store(buildPipelineStore).subscribe((next, previous) => {
    for (const pipelineId of Array.from(state.pendingActivations.keys())) {
      if (next.pipelines.get(pipelineId) !== previous.pipelines.get(pipelineId)) {
        reconcilePendingActivation(state, pipelineId);
      }
    }
  });
}

/**
 * Arms the pipeline tab (and selects its environment) once an environment id
 * exists. An idempotent start can return a pipeline id while a concurrent
 * winner is still provisioning, so subscribe before the point read.
 */
export function scheduleBuildPipelineTabActivation(
  projectId: string,
  pipelineId: string,
  environmentId?: string,
  scope: NodeScope = appCommandScope(),
): void {
  const state = activationState(scope);
  const { pendingActivations } = state;
  if (environmentId) {
    pendingActivations.delete(pipelineId);
    activate(scope, projectId, environmentId, pipelineId);
    stopListeningWhenIdle(state);
    return;
  }

  pendingActivations.delete(pipelineId);
  pendingActivations.set(pipelineId, { projectId });
  while (pendingActivations.size > MAX_PENDING_FEATURE_BUILD_ACTIVATIONS) {
    const oldest = pendingActivations.keys().next().value;
    if (oldest === undefined) break;
    pendingActivations.delete(oldest);
  }

  startListening(state);
  reconcilePendingActivation(state, pipelineId);
  if (!pendingActivations.has(pipelineId)) return;

  void hydrateBuildPipeline(pipelineId, undefined, undefined, scope)
    .then(() => reconcilePendingActivation(state, pipelineId))
    .catch((error) => {
      // Live resource synchronization remains subscribed and can still resolve
      // the intent after a transient point-read failure.
      log.warn("pipeline.hydrate-failed", {
        source: "activation",
        pipelineId,
        projectId,
        error: formatLogError(error),
      });
    });
}

/**
 * Applies the create dialog's one-shot presentation intent.
 *
 * An idempotent retry can be admitted while another backend process is still
 * provisioning, in which case the successful command has a pipeline ID but no
 * environment ID yet.
 */
export function activateFeatureBuildEnvironment(
  projectId: string,
  result: CreateFeatureBuildResult,
  scope: NodeScope = appCommandScope(),
): void {
  scheduleBuildPipelineTabActivation(projectId, result.pipelineId, result.environmentId, scope);
}
