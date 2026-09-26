import {
  isActiveBuildPhase,
  isBuildPipeline,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { PersistedBuildPipeline } from "./models.js";
import type { StorageService } from "./storage.js";
import type { WorkflowDiscoveryResult } from "./workflow-supervisor.js";

/**
 * What a build pipeline still owes the backend (step 08, task 1).
 *
 * | Obligation | Record state | Why it is runnable |
 * | --- | --- | --- |
 * | `result-consumption` | `pendingResultConsumptions` non-empty, **any phase** | Durable consumption outbox for accepted tool results; a terminal pipeline can still owe it (the previous tick skipped these after startup). |
 * | `provision` | `creating-environment`, `starting-environment`, `waiting-for-setup`, or an environment not yet source-linked | Environment creation/start/setup and launch retry. |
 * | `review-fanout` | active with `reviewFanout` | Reviewer panel and consolidation, each with its own structured-output deadline and nested reviewer budget. |
 * | `advance` | any other active phase (`building` … `resolving-conflicts`) | Stage progression, parked dispatch reconciliation, pending interactions, restart requests, structured-result deadlines. |
 * | `terminal-reconciliation` | `complete`/`failed` with a source whose completion comment is neither posted nor failed | Kanban/GitHub completion side effects after the terminal commit. |
 *
 * `paused` owes nothing until the user resumes (a command that advances it).
 */
export type BuildPipelineObligation =
  | "result-consumption"
  | "provision"
  | "review-fanout"
  | "advance"
  | "terminal-reconciliation";

const PROVISIONING_PHASES = new Set([
  "creating-environment",
  "starting-environment",
  "waiting-for-setup",
]);

/** Terminal side effects still owed after `complete`/`failed` committed. */
export function needsBuildTerminalReconciliation(pipeline: BuildPipeline): boolean {
  if (pipeline.phase !== "complete" && pipeline.phase !== "failed") return false;
  return Boolean(
    pipeline.source &&
    pipeline.completionCommentStatus !== "posted" &&
    pipeline.completionCommentStatus !== "failed",
  );
}

export function buildPipelineObligation(snapshot: unknown): BuildPipelineObligation | null {
  if (!isBuildPipeline(snapshot)) return null;
  const pipeline = snapshot;
  if ((pipeline.pendingResultConsumptions?.length ?? 0) > 0) return "result-consumption";
  if (isActiveBuildPhase(pipeline.phase)) {
    if (
      PROVISIONING_PHASES.has(pipeline.phase) ||
      (Boolean(pipeline.environmentId) && !pipeline.sourceLinkedAt)
    ) {
      return "provision";
    }
    return pipeline.reviewFanout ? "review-fanout" : "advance";
  }
  return needsBuildTerminalReconciliation(pipeline) ? "terminal-reconciliation" : null;
}

/** Admission target: the pipeline's environment once it has one. */
export function buildPipelineTarget(snapshot: unknown): string | undefined {
  return isBuildPipeline(snapshot) && snapshot.environmentId ? snapshot.environmentId : undefined;
}

export function classifyPersistedBuildPipeline(record: PersistedBuildPipeline) {
  return {
    obligation: buildPipelineObligation(record.snapshot),
    target: buildPipelineTarget(record.snapshot),
  };
}

/**
 * Authoritative discovery over the build-pipeline store. The store is one
 * file, so an enumeration either completes or throws. An unreadable snapshot
 * is skipped — it has no obligation the service could advance — without
 * hiding any other pipeline.
 */
export async function discoverBuildPipelines(
  storage: Pick<StorageService, "listAllBuildPipelines">,
): Promise<WorkflowDiscoveryResult<BuildPipelineObligation>> {
  const records = await storage.listAllBuildPipelines();
  const entries: WorkflowDiscoveryResult<BuildPipelineObligation>["entries"] = [];
  for (const record of records) {
    const { obligation, target } = classifyPersistedBuildPipeline(record);
    if (!obligation) continue;
    entries.push({ key: record.id, obligation, ...(target ? { target } : {}) });
  }
  return { entries, scanned: records.length, complete: true };
}
