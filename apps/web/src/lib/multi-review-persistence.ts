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

/** Upper bound on remembered unavailable workflow ids; the oldest is forgotten first. */
export const MAX_UNAVAILABLE_MULTI_REVIEW_MARKERS = 512;

/**
 * Workflows whose last point read found no usable record: the backend has
 * none, or what it holds fails validation in this client. Pane-layout restore
 * skips them, so a tab left pointing at a deleted review is not fetched again
 * on every layout change (each window, every time). A change event for the id
 * still reads it, and any read that finds a record clears the marker.
 */
const unavailableWorkflows = new Set<string>();

function markUnavailable(workflowId: string): void {
  unavailableWorkflows.delete(workflowId);
  unavailableWorkflows.add(workflowId);
  while (unavailableWorkflows.size > MAX_UNAVAILABLE_MULTI_REVIEW_MARKERS) {
    const oldest = unavailableWorkflows.values().next().value;
    if (oldest === undefined) break;
    unavailableWorkflows.delete(oldest);
  }
}

/** Whether the last point read of `workflowId` found no usable record. */
export function isMultiReviewWorkflowKnownUnavailable(workflowId: string): boolean {
  return unavailableWorkflows.has(workflowId);
}

/** Test seam: forget every unavailable marker and read in flight. */
export function resetMultiReviewPersistenceForTests(): void {
  unavailableWorkflows.clear();
  workflowReads.clear();
}

type WorkflowRead = {
  /** Settles when the read in flight does. */
  settled: Promise<void>;
  /** The one follow-up read every caller that arrived meanwhile shares. */
  queued: Promise<MultiReviewWorkflow | null> | null;
};

/** Point reads in flight, by workflow. */
const workflowReads = new Map<string, WorkflowRead>();

function startWorkflowRead(
  workflowId: string,
  read: WorkflowRead,
): Promise<MultiReviewWorkflow | null> {
  const result = hydrateMultiReviewWorkflowOnce(workflowId);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  read.settled = settled;
  workflowReads.set(workflowId, read);
  void settled.then(() => {
    if (workflowReads.get(workflowId) === read && read.settled === settled && !read.queued) {
      workflowReads.delete(workflowId);
    }
  });
  return result;
}

/**
 * Installs the backend's record of one workflow into the store.
 *
 * At most one read per workflow is in flight. A call made while one runs
 * cannot know whether that read saw its change, so it waits for one follow-up
 * read shared by every caller that arrives in the meantime: a burst of change
 * events costs two reads, not one each. A held record is read conditionally,
 * so an unchanged workflow costs a revision check rather than the record.
 */
export function hydrateMultiReviewWorkflow(
  workflowId: string,
): Promise<MultiReviewWorkflow | null> {
  const read = workflowReads.get(workflowId);
  if (!read) return startWorkflowRead(workflowId, { settled: Promise.resolve(), queued: null });
  if (read.queued) return read.queued;
  const queued = read.settled.then(() => {
    read.queued = null;
    return startWorkflowRead(workflowId, read);
  });
  read.queued = queued;
  return queued;
}

async function hydrateMultiReviewWorkflowOnce(
  workflowId: string,
): Promise<MultiReviewWorkflow | null> {
  const held = useMultiReviewStore.getState().workflows.get(workflowId);
  const entry =
    held === undefined
      ? await backend.getMultiReviewWorkflow(workflowId)
      : await backend.getMultiReviewWorkflowConditional(workflowId, held.backendRevision);
  if (entry && "unchanged" in entry) {
    unavailableWorkflows.delete(workflowId);
    return useMultiReviewStore.getState().workflows.get(workflowId) ?? null;
  }
  if (!entry) {
    markUnavailable(workflowId);
    useMultiReviewStore.getState().removeWorkflow(workflowId);
    return null;
  }
  const workflow = snapshot(entry);
  if (!workflow) {
    markUnavailable(workflowId);
    return null;
  }
  unavailableWorkflows.delete(workflowId);
  useMultiReviewStore.getState().replaceWorkflow(workflow);
  return workflow;
}

export async function hydrateMultiReviewWorkflowsForEnvironment(
  environmentId: string,
): Promise<MultiReviewWorkflow[]> {
  const entries = await backend.listMultiReviewWorkflows(environmentId);
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
  for (const workflow of workflows) {
    unavailableWorkflows.delete(workflow.id);
    useMultiReviewStore.getState().replaceWorkflow(workflow);
  }
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
