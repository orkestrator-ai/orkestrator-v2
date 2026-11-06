import {
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { canonicalMultiReview } from "@orkestrator/protocol/workflow-vocabulary";
import type { PersistedWorkflowRecord } from "@/types";
import * as backend from "@/lib/backend";
import { useMultiReviewStore } from "@/stores/multiReviewStore";

function snapshot(entry: PersistedWorkflowRecord<unknown>): MultiReviewWorkflow | null {
  const workflow = canonicalMultiReview(entry.snapshot);
  if (
    !isMultiReviewWorkflow(workflow) ||
    workflow.id !== entry.id ||
    workflow.environmentId !== entry.environmentId
  )
    return null;
  return { ...workflow, backendRevision: entry.revision };
}

export async function hydrateMultiReviewWorkflow(
  workflowId: string,
): Promise<MultiReviewWorkflow | null> {
  const entry = await backend.getMultiReviewWorkflow(workflowId);
  if (!entry) {
    useMultiReviewStore.getState().removeWorkflow(workflowId);
    return null;
  }
  const workflow = snapshot(entry);
  if (workflow) useMultiReviewStore.getState().replaceWorkflow(workflow);
  return workflow;
}

export async function hydrateMultiReviewWorkflowsForEnvironment(
  environmentId: string,
): Promise<MultiReviewWorkflow[]> {
  return applyMultiReviewWorkflowsForEnvironment(
    environmentId,
    await backend.listMultiReviewWorkflows(environmentId),
  );
}

/**
 * Install one environment's listed workflows, however they were read: the
 * list is authoritative, so workflows of that environment it omits are removed.
 */
export function applyMultiReviewWorkflowsForEnvironment(
  environmentId: string,
  entries: ReadonlyArray<PersistedWorkflowRecord<unknown>>,
): MultiReviewWorkflow[] {
  const workflows = entries.flatMap((entry) => {
    const workflow = snapshot(entry);
    return workflow ? [workflow] : [];
  });
  const ids = new Set(workflows.map((workflow) => workflow.id));
  for (const [id, workflow] of useMultiReviewStore.getState().workflows) {
    if (workflow.environmentId === environmentId && !ids.has(id)) {
      useMultiReviewStore.getState().removeWorkflow(id);
    }
  }
  for (const workflow of workflows) useMultiReviewStore.getState().replaceWorkflow(workflow);
  return workflows;
}

/**
 * The single non-terminal workflow an environment is allowed to hold, if any.
 *
 * Read from the backend rather than the store because the store is a projection
 * that a closed tab, a reload, or an event missed while the environment was
 * inactive can leave behind — and this answer decides whether a launch may
 * proceed. The backend enforces the same rule on write, so a second client
 * racing this check is still refused there.
 */
export async function findActiveMultiReviewWorkflow(
  environmentId: string,
): Promise<MultiReviewWorkflow | null> {
  const workflows = await hydrateMultiReviewWorkflowsForEnvironment(environmentId);
  return workflows.find((workflow) => !isMultiReviewTerminalPhase(workflow.phase)) ?? null;
}
