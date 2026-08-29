import type { CreateFeatureBuildResult } from "@orkestrator/protocol/feature-build";
import { getEnvironment } from "@/lib/backend";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { isActiveBuildPhase, useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

interface PendingFeatureBuildActivation {
  projectId: string;
}

const MAX_PENDING_FEATURE_BUILD_ACTIVATIONS = 128;
const pendingActivations = new Map<string, PendingFeatureBuildActivation>();
let unsubscribe: (() => void) | null = null;

function stopListeningWhenIdle(): void {
  if (pendingActivations.size > 0 || !unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
}

function activate(projectId: string, environmentId: string): void {
  const ui = useUIStore.getState();
  ui.setProjectCollapsed(projectId, false);
  ui.selectProjectAndEnvironment(projectId, environmentId);

  // Feature environments are created by the backend pipeline rather than by
  // useEnvironments.createEnvironment(), so they do not pass through the
  // renderer's optimistic add path. Selecting only the ID leaves App on the
  // project board until a separate environment-list announcement happens to
  // arrive. Hydrate the targeted record directly so activation also works
  // while the sidebar is unmounted or after its live event was missed.
  if (useEnvironmentStore.getState().getEnvironmentById(environmentId)) return;
  void getEnvironment(environmentId)
    .then((environment) => {
      if (!environment) {
        console.warn(
          `[feature-build-activation] Environment ${environmentId} was not found after creation`,
        );
        return;
      }
      if (environment.projectId !== projectId) {
        console.warn(
          `[feature-build-activation] Ignoring environment ${environmentId} for an unexpected project`,
        );
        return;
      }
      const store = useEnvironmentStore.getState();
      if (!store.getEnvironmentById(environmentId)) store.addEnvironment(environment);
    })
    .catch((error) => {
      // The selection remains useful: manifest or live resource recovery can
      // still populate the environment store after a transient targeted-read
      // failure.
      console.warn(
        `[feature-build-activation] Failed to hydrate environment ${environmentId}:`,
        error,
      );
    });
}

function reconcilePendingActivation(pipelineId: string): void {
  const pending = pendingActivations.get(pipelineId);
  if (!pending) return;
  const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId);
  if (!pipeline) return;

  if (pipeline.projectId !== pending.projectId) {
    pendingActivations.delete(pipelineId);
    console.warn(
      `[feature-build-activation] Ignoring pipeline ${pipelineId} for an unexpected project`,
    );
  } else if (pipeline.environmentId) {
    pendingActivations.delete(pipelineId);
    activate(pending.projectId, pipeline.environmentId);
  } else if (!isActiveBuildPhase(pipeline.phase)) {
    // A terminal pipeline without an environment can never satisfy this intent.
    pendingActivations.delete(pipelineId);
  }
  stopListeningWhenIdle();
}

function startListening(): void {
  if (unsubscribe) return;
  unsubscribe = useBuildPipelineStore.subscribe((state, previous) => {
    for (const pipelineId of Array.from(pendingActivations.keys())) {
      if (state.pipelines.get(pipelineId) !== previous.pipelines.get(pipelineId)) {
        reconcilePendingActivation(pipelineId);
      }
    }
  });
}

/**
 * Applies the create dialog's one-shot presentation intent.
 *
 * An idempotent retry can be admitted while another backend process is still
 * provisioning, in which case the successful command has a pipeline ID but no
 * environment ID yet. Subscribe before the point read so neither a fast
 * resource announcement nor a missed live event can strand the selection.
 */
export function activateFeatureBuildEnvironment(
  projectId: string,
  result: CreateFeatureBuildResult,
): void {
  if (result.environmentId) {
    pendingActivations.delete(result.pipelineId);
    activate(projectId, result.environmentId);
    stopListeningWhenIdle();
    return;
  }

  pendingActivations.delete(result.pipelineId);
  pendingActivations.set(result.pipelineId, { projectId });
  while (pendingActivations.size > MAX_PENDING_FEATURE_BUILD_ACTIVATIONS) {
    const oldest = pendingActivations.keys().next().value;
    if (oldest === undefined) break;
    pendingActivations.delete(oldest);
  }

  startListening();
  reconcilePendingActivation(result.pipelineId);
  if (!pendingActivations.has(result.pipelineId)) return;

  void hydrateBuildPipeline(result.pipelineId)
    .then(() => reconcilePendingActivation(result.pipelineId))
    .catch((error) => {
      // Live resource synchronization remains subscribed and can still resolve
      // the intent after a transient point-read failure.
      console.warn(
        `[feature-build-activation] Failed to hydrate pipeline ${result.pipelineId}:`,
        error,
      );
    });
}
