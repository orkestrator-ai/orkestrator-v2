import {
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { canonicalMultiReview } from "@orkestrator/protocol/workflow-vocabulary";
import type { StoreApi } from "zustand/vanilla";
import type { PersistedWorkflowRecord } from "@/types";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createWorkflowsApi } from "@/lib/backend/workflows";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { multiReviewStore, type MultiReviewState } from "@/stores/multiReviewStore";

/**
 * Every function here acts on one node's workflows: the `scope` it is given,
 * or the app's command scope when it is given none (callers with no scope yet:
 * the store resource sync and boot hydration). Workflow ids belong to one
 * node, so the unavailable markers and the reads in flight are held per scope
 * (plan item 3003).
 */

/** `scope`'s Multi Review reads: the suites' mocked named exports on the app's command scope. */
function workflowReadsApi(scope: NodeScope) {
  return backendApiForScope(scope, createWorkflowsApi, {
    getMultiReviewWorkflow: backend.getMultiReviewWorkflow,
    getMultiReviewWorkflowConditional: backend.getMultiReviewWorkflowConditional,
    listMultiReviewWorkflows: backend.listMultiReviewWorkflows,
  });
}

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
interface MultiReviewPersistenceState {
  readonly unavailableWorkflows: Set<string>;
  /** Point reads in flight, by workflow. */
  readonly workflowReads: Map<string, WorkflowRead>;
}

const persistenceState = defineScopedSlot<MultiReviewPersistenceState>(
  "multi-review-persistence",
  () => ({ unavailableWorkflows: new Set(), workflowReads: new Map() }),
);

function markUnavailable(unavailableWorkflows: Set<string>, workflowId: string): void {
  unavailableWorkflows.delete(workflowId);
  unavailableWorkflows.add(workflowId);
  while (unavailableWorkflows.size > MAX_UNAVAILABLE_MULTI_REVIEW_MARKERS) {
    const oldest = unavailableWorkflows.values().next().value;
    if (oldest === undefined) break;
    unavailableWorkflows.delete(oldest);
  }
}

/** Whether the last point read of `workflowId` on `scope`'s node found no usable record. */
export function isMultiReviewWorkflowKnownUnavailable(
  workflowId: string,
  scope: NodeScope = appCommandScope(),
): boolean {
  return persistenceState(scope).unavailableWorkflows.has(workflowId);
}

/** Test seam: forget every unavailable marker and read in flight of `scope`. */
export function resetMultiReviewPersistenceForTests(scope: NodeScope = appCommandScope()): void {
  const state = persistenceState(scope);
  state.unavailableWorkflows.clear();
  state.workflowReads.clear();
}

type WorkflowRead = {
  /** Settles when the read in flight does. */
  settled: Promise<void>;
  /** The one follow-up read every caller that arrived meanwhile shares. */
  queued: Promise<MultiReviewWorkflow | null> | null;
};

function startWorkflowRead(
  scope: NodeScope,
  workflowId: string,
  read: WorkflowRead,
): Promise<MultiReviewWorkflow | null> {
  const { workflowReads } = persistenceState(scope);
  const result = hydrateMultiReviewWorkflowOnce(scope, workflowId);
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
  scope: NodeScope = appCommandScope(),
): Promise<MultiReviewWorkflow | null> {
  const read = persistenceState(scope).workflowReads.get(workflowId);
  if (!read) {
    return startWorkflowRead(scope, workflowId, { settled: Promise.resolve(), queued: null });
  }
  if (read.queued) return read.queued;
  const queued = read.settled.then(() => {
    read.queued = null;
    return startWorkflowRead(scope, workflowId, read);
  });
  read.queued = queued;
  return queued;
}

async function hydrateMultiReviewWorkflowOnce(
  scope: NodeScope,
  workflowId: string,
): Promise<MultiReviewWorkflow | null> {
  // Held across the await: the scope may be disposed by the time it answers.
  const store = scope.store(multiReviewStore);
  const { unavailableWorkflows } = persistenceState(scope);
  const api = workflowReadsApi(scope);
  const held = store.getState().workflows.get(workflowId);
  const entry =
    held === undefined
      ? await api.getMultiReviewWorkflow(workflowId)
      : await api.getMultiReviewWorkflowConditional(workflowId, held.backendRevision);
  if (entry && "unchanged" in entry) {
    unavailableWorkflows.delete(workflowId);
    return store.getState().workflows.get(workflowId) ?? null;
  }
  if (!entry) {
    markUnavailable(unavailableWorkflows, workflowId);
    store.getState().removeWorkflow(workflowId);
    return null;
  }
  const workflow = snapshot(entry);
  if (!workflow) {
    markUnavailable(unavailableWorkflows, workflowId);
    return null;
  }
  unavailableWorkflows.delete(workflowId);
  store.getState().replaceWorkflow(workflow);
  return workflow;
}

export async function hydrateMultiReviewWorkflowsForEnvironment(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): Promise<MultiReviewWorkflow[]> {
  const store = scope.store(multiReviewStore);
  const { unavailableWorkflows } = persistenceState(scope);
  const entries = await workflowReadsApi(scope).listMultiReviewWorkflows(environmentId);
  return installEnvironmentWorkflows(store, unavailableWorkflows, environmentId, entries);
}

/**
 * Install one environment's listed workflows, however they were read: the
 * list is authoritative, so workflows of that environment it omits are removed.
 */
export function applyMultiReviewWorkflowsForEnvironment(
  environmentId: string,
  entries: ReadonlyArray<PersistedWorkflowRecord<unknown>>,
  scope: NodeScope = appCommandScope(),
): MultiReviewWorkflow[] {
  return installEnvironmentWorkflows(
    scope.store(multiReviewStore),
    persistenceState(scope).unavailableWorkflows,
    environmentId,
    entries,
  );
}

function installEnvironmentWorkflows(
  store: StoreApi<MultiReviewState>,
  unavailableWorkflows: Set<string>,
  environmentId: string,
  entries: ReadonlyArray<PersistedWorkflowRecord<unknown>>,
): MultiReviewWorkflow[] {
  const workflows = entries.flatMap((entry) => {
    const workflow = snapshot(entry);
    return workflow ? [workflow] : [];
  });
  const ids = new Set(workflows.map((workflow) => workflow.id));
  for (const [id, workflow] of store.getState().workflows) {
    if (workflow.environmentId === environmentId && !ids.has(id)) {
      store.getState().removeWorkflow(id);
    }
  }
  for (const workflow of workflows) {
    unavailableWorkflows.delete(workflow.id);
    store.getState().replaceWorkflow(workflow);
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
  scope: NodeScope = appCommandScope(),
): Promise<MultiReviewWorkflow | null> {
  const workflows = await hydrateMultiReviewWorkflowsForEnvironment(environmentId, scope);
  return workflows.find((workflow) => !isMultiReviewTerminalPhase(workflow.phase)) ?? null;
}
