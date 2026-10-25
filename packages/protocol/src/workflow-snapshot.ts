/**
 * WorkflowSnapshotV1: a normalized, immutable read model of one existing
 * workflow run, captured by the backend from its authoritative service.
 *
 * An agent can ask for a snapshot of a run it is authorized to read; it can
 * never author nodes, statuses, validation results or timestamps. A snapshot
 * describes what the backend observed at `capturedAt`/`sourceRevision`; it is
 * not evidence that a current run has the same state, and rendering it grants
 * no operational authority.
 */
import {
  FieldErrorCollector,
  checkArray,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  checkString,
  joinPath,
  type FieldValidation,
} from "./field-validation.js";
import { WORKFLOW_SNAPSHOT_POLICY } from "./rich-content-policy.js";

export const WORKFLOW_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "canceled",
  "unknown",
] as const;
export type WorkflowStatusV1 = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_NODE_ROLES = [
  "input",
  "agent",
  "review",
  "validation",
  "output",
  "group",
  "unknown",
] as const;
export type WorkflowNodeRole = (typeof WORKFLOW_NODE_ROLES)[number];

export const WORKFLOW_VALIDATION_STATES = [
  "pending",
  "rejected",
  "accepted",
  "not-applicable",
  "unknown",
] as const;

export const WORKFLOW_LINK_RELATIONS = [
  "transcript",
  "findings",
  "validation",
  "tool-output",
  "diff",
] as const;

export const WORKFLOW_EDGE_RELATIONS = [
  "dependency",
  "handoff",
  "review",
  "retry",
  "unknown",
] as const;

export interface WorkflowSnapshotNodeV1 {
  id: string;
  label: string;
  role: WorkflowNodeRole;
  status: WorkflowStatusV1;
  /** Preserves an existing status the adapter could not map. */
  rawStatus?: string;
  attemptId?: string;
  startedAt?: string;
  finishedAt?: string;
  validation?: {
    state: (typeof WORKFLOW_VALIDATION_STATES)[number];
    findingCount?: number;
    errorCount?: number;
  };
  links: Array<{
    relation: (typeof WORKFLOW_LINK_RELATIONS)[number];
    /** Opaque scoped backend reference, never a URL or path. */
    targetRef: string;
    label: string;
  }>;
}

export interface WorkflowSnapshotEdgeV1 {
  id: string;
  from: string;
  to: string;
  relation: (typeof WORKFLOW_EDGE_RELATIONS)[number];
  label?: string;
}

export interface WorkflowSnapshotV1 {
  schemaVersion: 1;
  workflowId: string;
  runId: string;
  sourceRevision: string;
  /** Backend-issued RFC 3339 UTC timestamp. */
  capturedAt: string;
  title: string;
  description: string;
  status: WorkflowStatusV1;
  completeness: {
    mode: "complete" | "summary";
    totalNodes: number;
    totalEdges: number;
    omittedNodes: number;
    omittedEdges: number;
    reason?: "size-limit";
  };
  nodes: WorkflowSnapshotNodeV1[];
  edges: WorkflowSnapshotEdgeV1[];
}

const P = WORKFLOW_SNAPSHOT_POLICY;
const ID = { min: 1, max: P.maxIdCharacters, pattern: /^[^\u0000-\u001f\u007f]+$/ };
const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** Snapshot text must not smuggle filesystem paths or URLs into opaque references. */
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Parse an RFC 3339 UTC timestamp that round-trips through `Date#toISOString`. */
export function parseUtcTimestamp(value: string): number | null {
  if (!UTC_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms).toISOString();
  const withMillis = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, f: string) => `.${f.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  return normalized === withMillis ? ms : null;
}

function checkTimestamp(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  optional: boolean,
): number | null {
  if (value === undefined && optional) return null;
  if (typeof value !== "string" || parseUtcTimestamp(value) === null) {
    errors.add(
      path,
      "timestamp",
      "Expected an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z)",
    );
    return null;
  }
  return parseUtcTimestamp(value);
}

function checkCount(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  optional = false,
): boolean {
  if (value === undefined && optional) return true;
  return checkFiniteNumber(value, path, errors, { integer: true, min: 0 });
}

export function validateWorkflowSnapshot(value: unknown): FieldValidation<WorkflowSnapshotV1> {
  const errors = new FieldErrorCollector();
  const fail = () => errors.result(value as WorkflowSnapshotV1);
  if (
    !checkObject(
      value,
      "",
      [
        "schemaVersion",
        "workflowId",
        "runId",
        "sourceRevision",
        "capturedAt",
        "title",
        "description",
        "status",
        "completeness",
        "nodes",
        "edges",
      ],
      errors,
    )
  ) {
    return fail();
  }
  if (value.schemaVersion !== 1) {
    errors.add("schemaVersion", "unsupported_version", "Only schemaVersion 1 is supported");
    return fail();
  }
  checkString(value.workflowId, "workflowId", errors, ID);
  checkString(value.runId, "runId", errors, ID);
  checkString(value.sourceRevision, "sourceRevision", errors, ID);
  checkTimestamp(value.capturedAt, "capturedAt", errors, false);
  checkString(value.title, "title", errors, { max: P.maxLabelCharacters, pattern: TEXT });
  checkString(value.description, "description", errors, {
    max: P.maxDescriptionCharacters,
    pattern: TEXT,
  });
  checkEnum(value.status, "status", errors, WORKFLOW_STATUSES);

  const nodeIds = new Set<string>();
  let nodeCount = 0;
  if (checkArray(value.nodes, "nodes", errors, { max: P.maxNodes })) {
    nodeCount = value.nodes.length;
    value.nodes.forEach((node, index) => {
      const path = joinPath("nodes", index);
      if (
        !checkObject(
          node,
          path,
          [
            "id",
            "label",
            "role",
            "status",
            "rawStatus",
            "attemptId",
            "startedAt",
            "finishedAt",
            "validation",
            "links",
          ],
          errors,
        )
      ) {
        return;
      }
      if (checkString(node.id, joinPath(path, "id"), errors, ID)) {
        if (nodeIds.has(node.id))
          errors.add(joinPath(path, "id"), "duplicate_id", "Duplicate node id");
        nodeIds.add(node.id);
      }
      checkString(node.label, joinPath(path, "label"), errors, {
        max: P.maxLabelCharacters,
        pattern: TEXT,
      });
      checkEnum(node.role, joinPath(path, "role"), errors, WORKFLOW_NODE_ROLES);
      checkEnum(node.status, joinPath(path, "status"), errors, WORKFLOW_STATUSES);
      checkString(node.rawStatus, joinPath(path, "rawStatus"), errors, {
        max: P.maxRawStatusCharacters,
        pattern: TEXT,
        optional: true,
      });
      checkString(node.attemptId, joinPath(path, "attemptId"), errors, { ...ID, optional: true });
      const started = checkTimestamp(node.startedAt, joinPath(path, "startedAt"), errors, true);
      const finished = checkTimestamp(node.finishedAt, joinPath(path, "finishedAt"), errors, true);
      if (started !== null && finished !== null && finished < started) {
        errors.add(joinPath(path, "finishedAt"), "before_start", "finishedAt precedes startedAt");
      }
      if (node.validation !== undefined) {
        const vPath = joinPath(path, "validation");
        if (checkObject(node.validation, vPath, ["state", "findingCount", "errorCount"], errors)) {
          checkEnum(
            node.validation.state,
            joinPath(vPath, "state"),
            errors,
            WORKFLOW_VALIDATION_STATES,
          );
          checkCount(node.validation.findingCount, joinPath(vPath, "findingCount"), errors, true);
          checkCount(node.validation.errorCount, joinPath(vPath, "errorCount"), errors, true);
        }
      }
      const linksPath = joinPath(path, "links");
      if (checkArray(node.links, linksPath, errors, { max: P.maxLinksPerNode })) {
        node.links.forEach((link, linkIndex) => {
          const lPath = joinPath(linksPath, linkIndex);
          if (!checkObject(link, lPath, ["relation", "targetRef", "label"], errors)) return;
          checkEnum(link.relation, joinPath(lPath, "relation"), errors, WORKFLOW_LINK_RELATIONS);
          checkString(link.targetRef, joinPath(lPath, "targetRef"), errors, {
            min: 1,
            max: P.maxIdCharacters,
            pattern: OPAQUE_REF,
          });
          checkString(link.label, joinPath(lPath, "label"), errors, {
            max: P.maxLabelCharacters,
            pattern: TEXT,
          });
        });
      }
    });
  }

  let edgeCount = 0;
  if (checkArray(value.edges, "edges", errors, { max: P.maxEdges })) {
    edgeCount = value.edges.length;
    const edgeIds = new Set<string>();
    value.edges.forEach((edge, index) => {
      const path = joinPath("edges", index);
      if (!checkObject(edge, path, ["id", "from", "to", "relation", "label"], errors)) return;
      if (checkString(edge.id, joinPath(path, "id"), errors, ID)) {
        if (edgeIds.has(edge.id))
          errors.add(joinPath(path, "id"), "duplicate_id", "Duplicate edge id");
        edgeIds.add(edge.id);
      }
      for (const end of ["from", "to"] as const) {
        if (
          checkString(edge[end], joinPath(path, end), errors, ID) &&
          !nodeIds.has(edge[end] as string)
        ) {
          errors.add(joinPath(path, end), "dangling_edge", "Edge endpoint is not an included node");
        }
      }
      checkEnum(edge.relation, joinPath(path, "relation"), errors, WORKFLOW_EDGE_RELATIONS);
      checkString(edge.label, joinPath(path, "label"), errors, {
        max: P.maxLabelCharacters,
        pattern: TEXT,
        optional: true,
      });
    });
  }

  const c = value.completeness;
  if (
    checkObject(
      c,
      "completeness",
      ["mode", "totalNodes", "totalEdges", "omittedNodes", "omittedEdges", "reason"],
      errors,
    ) &&
    checkEnum(c.mode, "completeness.mode", errors, ["complete", "summary"] as const) &&
    checkCount(c.totalNodes, "completeness.totalNodes", errors) &&
    checkCount(c.totalEdges, "completeness.totalEdges", errors) &&
    checkCount(c.omittedNodes, "completeness.omittedNodes", errors) &&
    checkCount(c.omittedEdges, "completeness.omittedEdges", errors)
  ) {
    if (c.reason !== undefined)
      checkEnum(c.reason, "completeness.reason", errors, ["size-limit"] as const);
    const totals = c as {
      totalNodes: number;
      totalEdges: number;
      omittedNodes: number;
      omittedEdges: number;
    };
    if (c.mode === "complete") {
      if (totals.omittedNodes !== 0 || totals.omittedEdges !== 0) {
        errors.add(
          "completeness",
          "inconsistent",
          "A complete snapshot cannot omit nodes or edges",
        );
      }
      if (totals.totalNodes !== nodeCount || totals.totalEdges !== edgeCount) {
        errors.add(
          "completeness",
          "inconsistent",
          "Totals must equal the included node and edge counts",
        );
      }
    } else if (
      totals.totalNodes - totals.omittedNodes !== nodeCount ||
      totals.totalEdges - totals.omittedEdges !== edgeCount
    ) {
      errors.add(
        "completeness",
        "inconsistent",
        "Totals minus omitted counts must equal included counts",
      );
    }
  }
  return errors.result(value as unknown as WorkflowSnapshotV1);
}

export interface WorkflowLayoutNode {
  id: string;
  x: number;
  y: number;
  column: number;
  row: number;
}

const ROLE_ORDER: Record<WorkflowNodeRole, number> = {
  input: 0,
  agent: 1,
  group: 2,
  review: 3,
  validation: 4,
  output: 5,
  unknown: 6,
};

/**
 * Deterministic layout: columns by captured role, rows by stable id order.
 * Never traverses the graph, so cycles (explicit retry edges) cannot recurse.
 */
export function layoutWorkflowSnapshot(
  snapshot: Pick<WorkflowSnapshotV1, "nodes">,
  options: { columnWidth?: number; rowHeight?: number } = {},
): { nodes: WorkflowLayoutNode[]; width: number; height: number } {
  const columnWidth = options.columnWidth ?? 200;
  const rowHeight = options.rowHeight ?? 72;
  const columns = new Map<number, WorkflowSnapshotNodeV1[]>();
  for (const node of snapshot.nodes) {
    const column = ROLE_ORDER[node.role] ?? ROLE_ORDER.unknown;
    const list = columns.get(column) ?? [];
    list.push(node);
    columns.set(column, list);
  }
  const usedColumns = Array.from(columns.keys()).sort((a, b) => a - b);
  const nodes: WorkflowLayoutNode[] = [];
  let maxRows = 0;
  usedColumns.forEach((column, columnIndex) => {
    const list = columns
      .get(column)!
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    maxRows = Math.max(maxRows, list.length);
    list.forEach((node, row) => {
      nodes.push({
        id: node.id,
        column: columnIndex,
        row,
        x: columnIndex * columnWidth,
        y: row * rowHeight,
      });
    });
  });
  return {
    nodes,
    width: Math.max(1, usedColumns.length) * columnWidth,
    height: Math.max(1, maxRows) * rowHeight,
  };
}
