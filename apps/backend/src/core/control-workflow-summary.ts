/** Bounded control response; never include provider configuration or controller fences. */
export function workflowSummary(workflow: Record<string, unknown>): Record<string, unknown> {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    environmentId: workflow.environmentId,
    taskId: workflow.taskId,
    phase: workflow.phase,
    error: workflow.error,
    presentationError: workflow.presentationError,
    addressPromptPending: workflow.addressPromptPending,
    fixTabId: workflow.fixTabId,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    revision: workflow.revision ?? workflow.backendRevision,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizedWorkflow(value: unknown): Record<string, unknown> | null {
  const transported = isRecord(value) && isRecord(value.record) ? value.record : value;
  if (!isRecord(transported)) return null;
  if (!isRecord(transported.snapshot)) return transported;
  const snapshot = transported.snapshot;
  return {
    ...snapshot,
    id: snapshot.id ?? transported.id,
    projectId: snapshot.projectId ?? transported.projectId,
    environmentId: snapshot.environmentId ?? transported.environmentId,
    updatedAt: transported.updatedAt ?? snapshot.updatedAt,
    revision: transported.revision ?? snapshot.revision ?? snapshot.backendRevision,
  };
}
