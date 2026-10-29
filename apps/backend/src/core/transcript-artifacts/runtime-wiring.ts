/**
 * Backend wiring for transcript artifacts: constructs the service from the
 * StorageService readers and attaches the preview infrastructure built by
 * `createTranscriptArtifactRuntime` (runtime.ts).
 *
 * The runtime is attached after construction so a slow or failing content
 * listener or browser probe never blocks backend startup; until it attaches,
 * chart and workflow artifacts work and HTML/Mermaid report
 * `renderer_unavailable`.
 */
import type { StorageService } from "../storage.js";
import { logArtifactEvent } from "./metrics.js";
import {
  createTranscriptArtifactRuntime,
  type TranscriptArtifactRuntime,
  type TranscriptArtifactRuntimeOptions,
} from "./runtime.js";
import { TranscriptArtifactService, type TranscriptArtifactServiceOptions } from "./service.js";

export function createTranscriptArtifactService(
  storage: Pick<StorageService, "getMultiReviewWorkflow" | "getBuildPipeline" | "getEnvironment">,
  options: Omit<TranscriptArtifactServiceOptions, "workflows" | "environmentProject">,
): TranscriptArtifactService {
  return new TranscriptArtifactService({
    ...options,
    workflows: {
      getMultiReviewWorkflow: (id) => storage.getMultiReviewWorkflow(id),
      getBuildPipeline: (id) => storage.getBuildPipeline(id),
    },
    environmentProject: async (environmentId) =>
      (await storage.getEnvironment(environmentId))?.projectId ?? null,
  });
}

/**
 * Builds the preview runner, interactive preparer and content server and
 * attaches them. Failures leave the service usable without them.
 */
export async function attachTranscriptArtifactRuntime(
  service: TranscriptArtifactService,
  options: TranscriptArtifactRuntimeOptions,
  create: (
    options: TranscriptArtifactRuntimeOptions,
  ) => Promise<TranscriptArtifactRuntime> = createTranscriptArtifactRuntime,
): Promise<TranscriptArtifactRuntime | null> {
  try {
    const runtime = await create(options);
    service.attachRuntime({
      runner: runtime.runner,
      preparer: runtime.preparer,
      contentServer: runtime.contentServer,
    });
    // Worker preparation can switch isolation without a restart: new jobs go
    // to the replacement runner; the old one finishes what it admitted.
    runtime.onRunnerChange?.((runner) =>
      service.attachRuntime({
        runner,
        preparer: runtime.preparer,
        contentServer: runtime.contentServer,
      }),
    );
    if (runtime.workerPreparation && runtime.prepareWorker)
      service.attachWorkerPreparation({
        status: () => runtime.workerPreparation(),
        prepare: () => runtime.prepareWorker(),
      });
    void runtime.runner.probe().catch(() => undefined);
    return runtime;
  } catch (error) {
    logArtifactEvent("runtime-unavailable", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
