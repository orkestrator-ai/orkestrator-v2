/**
 * Authoritative WorkflowSnapshotV1 collection from existing workflow records.
 *
 * The agent names a workflow type and run; the backend reads the record,
 * checks it belongs to the caller's environment and project, normalizes it
 * through a tested per-type adapter, then re-reads the record and fails with
 * a retryable `revision_conflict` if the revision moved, rather than joining
 * two inconsistent reads. `sourceRevision` is the record's storage revision.
 *
 * Over 200 nodes / 400 edges the snapshot switches to a documented summary
 * mode: nodes ordered by role then id, edges kept only when both endpoints
 * are included, exact totals preserved.
 */
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import {
  WORKFLOW_SNAPSHOT_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFailure, artifactError } from "@orkestrator/protocol/transcript-artifacts";
import {
  validateWorkflowSnapshot,
  type WorkflowSnapshotNodeV1,
  type WorkflowSnapshotV1,
} from "@orkestrator/protocol/workflow-snapshot";
import {
  WORKFLOW_SNAPSHOT_KINDS,
  adaptBuildPipeline,
  adaptLoopedReview,
  adaptMultiReview,
  type AdaptedWorkflow,
  type WorkflowSnapshotKind,
} from "./workflow-collector-adapters.js";

/** The subset of StorageService the collector reads. */
export interface WorkflowRecordReader {
  getMultiReviewWorkflow(id: string): Promise<WorkflowRecord | null>;
  getLoopedReviewWorkflow(id: string): Promise<WorkflowRecord | null>;
  getBuildPipeline(id: string): Promise<(WorkflowRecord & { projectId: string }) | null>;
}

export interface WorkflowRecord {
  id: string;
  environmentId: string;
  snapshot: unknown;
  revision: number;
}

export interface WorkflowCollectRequest {
  workflowId: string;
  runId: string;
  expectedWorkflowRevision?: string;
}

const ROLE_ORDER: Record<WorkflowSnapshotNodeV1["role"], number> = {
  input: 0,
  agent: 1,
  group: 2,
  review: 3,
  validation: 4,
  output: 5,
  unknown: 6,
};

function notFound(): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("not_found", "Workflow run not found", {
      suggestion: "Check workflowId (multi-review, looped-review or build-pipeline) and runId.",
    }),
  );
}

function isWorkflowKind(value: string): value is WorkflowSnapshotKind {
  return (WORKFLOW_SNAPSHOT_KINDS as readonly string[]).includes(value);
}

export class WorkflowSnapshotCollector {
  constructor(
    private readonly reader: WorkflowRecordReader,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(
    kind: WorkflowSnapshotKind,
    runId: string,
  ): Promise<{ record: WorkflowRecord; projectId: unknown } | null> {
    try {
      switch (kind) {
        case "multi-review": {
          const record = await this.reader.getMultiReviewWorkflow(runId);
          return record
            ? { record, projectId: (record.snapshot as { projectId?: unknown } | null)?.projectId }
            : null;
        }
        case "looped-review": {
          const record = await this.reader.getLoopedReviewWorkflow(runId);
          return record
            ? { record, projectId: (record.snapshot as { projectId?: unknown } | null)?.projectId }
            : null;
        }
        case "build-pipeline": {
          const record = await this.reader.getBuildPipeline(runId);
          return record ? { record, projectId: record.projectId } : null;
        }
      }
    } catch {
      throw new ArtifactFailure(
        artifactError("storage_unavailable", "The workflow record could not be read"),
      );
    }
  }

  /**
   * Collect a coherent snapshot of one run owned by `scope`. Missing runs and
   * runs of another environment/project are the same `not_found`.
   */
  async collect(
    scope: { environmentId: string; projectId: string },
    request: WorkflowCollectRequest,
  ): Promise<WorkflowSnapshotV1> {
    if (!isWorkflowKind(request.workflowId)) {
      throw new ArtifactFailure(
        artifactError("invalid_input", "Unsupported workflowId", {
          fieldErrors: [
            {
              path: "draft.payload.workflowId",
              code: "enum",
              message: `Expected one of: ${WORKFLOW_SNAPSHOT_KINDS.join(", ")}`,
            },
          ],
        }),
      );
    }
    const kind = request.workflowId;
    const first = await this.read(kind, request.runId);
    if (
      !first ||
      first.record.id !== request.runId ||
      first.record.environmentId !== scope.environmentId ||
      first.projectId !== scope.projectId ||
      typeof first.record.snapshot !== "object" ||
      first.record.snapshot === null
    ) {
      throw notFound();
    }
    const sourceRevision = String(first.record.revision);
    if (
      request.expectedWorkflowRevision !== undefined &&
      request.expectedWorkflowRevision !== sourceRevision
    ) {
      throw new ArtifactFailure(
        artifactError("revision_conflict", "The workflow run is at a different revision", {
          retryClass: "transient",
          suggestion: `Retry with expectedWorkflowRevision "${sourceRevision}" or omit it.`,
        }),
      );
    }
    const adapted = adapt(kind, request.runId, first.record.snapshot as Record<string, unknown>);
    const second = await this.read(kind, request.runId);
    if (!second || String(second.record.revision) !== sourceRevision) {
      throw new ArtifactFailure(
        artifactError("revision_conflict", "The workflow run changed while it was being captured", {
          retryClass: "transient",
          suggestion: "Retry the request; the backend captures one coherent revision.",
        }),
      );
    }
    const snapshot = bound({
      schemaVersion: 1,
      workflowId: kind,
      runId: request.runId,
      sourceRevision,
      capturedAt: new Date(this.now()).toISOString(),
      title: adapted.title,
      description: adapted.description,
      status: adapted.status,
      completeness: {
        mode: "complete",
        totalNodes: adapted.nodes.length,
        totalEdges: adapted.edges.length,
        omittedNodes: 0,
        omittedEdges: 0,
      },
      nodes: adapted.nodes,
      edges: adapted.edges,
    });
    const validation = validateWorkflowSnapshot(snapshot);
    if (!validation.ok) {
      throw new ArtifactFailure(
        artifactError("validation_failed", "The captured workflow did not form a valid snapshot", {
          fieldErrors: validation.errors.slice(0, 20),
          retryClass: "never",
        }),
      );
    }
    if (utf8ByteLength(canonicalJson(snapshot)) > WORKFLOW_SNAPSHOT_POLICY.maxNormalizedBytes) {
      throw new ArtifactFailure(
        artifactError(
          "validation_failed",
          "The workflow snapshot exceeds 256 KiB even in summary mode",
          {
            resource: "workflow-snapshot-bytes",
            retryClass: "never",
            suggestion: "Link to the live workflow instead of publishing a snapshot.",
          },
        ),
      );
    }
    return snapshot;
  }
}

function adapt(
  kind: WorkflowSnapshotKind,
  runId: string,
  snapshot: Record<string, unknown>,
): AdaptedWorkflow {
  switch (kind) {
    case "multi-review":
      return adaptMultiReview(runId, snapshot);
    case "looped-review":
      return adaptLoopedReview(runId, snapshot);
    case "build-pipeline":
      return adaptBuildPipeline(runId, snapshot);
  }
}

/** Summary mode when the run exceeds the node/edge ceilings. Totals stay exact. */
export function bound(snapshot: WorkflowSnapshotV1): WorkflowSnapshotV1 {
  const { maxNodes, maxEdges } = WORKFLOW_SNAPSHOT_POLICY;
  if (snapshot.nodes.length <= maxNodes && snapshot.edges.length <= maxEdges) return snapshot;
  const totalNodes = snapshot.nodes.length;
  const totalEdges = snapshot.edges.length;
  const nodes = [...snapshot.nodes]
    .sort(
      (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, maxNodes);
  const included = new Set(nodes.map((entry) => entry.id));
  const edges = snapshot.edges
    .filter((entry) => included.has(entry.from) && included.has(entry.to))
    .slice(0, maxEdges);
  return {
    ...snapshot,
    completeness: {
      mode: "summary",
      totalNodes,
      totalEdges,
      omittedNodes: totalNodes - nodes.length,
      omittedEdges: totalEdges - edges.length,
      reason: "size-limit",
    },
    nodes,
    edges,
  };
}

export function isTerminalWorkflowStatus(status: WorkflowSnapshotV1["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
