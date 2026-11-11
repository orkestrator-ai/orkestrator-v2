/**
 * How the Linear tab orders workflow states (the list's sections and the
 * board's lanes) and the issues inside them. Browser-safe and pure.
 */
import type { LinearIssueListItem, LinearWorkflowState } from "@/types/linear";

export type IssueOrder = "manual" | "priority" | "createdAt" | "updatedAt";

const PRIORITY_BY_LABEL: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  normal: 3,
  low: 4,
};

export const STATUS_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

export type StatusOrderKey = { typeOrder: number; position?: number };

// Workflow states belong to a team, so the same status name can arrive with a
// different type or position per team. Collapse each name to its lowest key so
// section order depends only on the loaded issues and the board's states, never
// on which issue happens to sort first under the current ticket order or
// status filter.
export function buildStatusOrder(
  issues: readonly LinearIssueListItem[],
  states: readonly LinearWorkflowState[] = [],
): Map<string, StatusOrderKey> {
  const statusOrder = new Map<string, StatusOrderKey>();
  const entries = [
    ...states
      .filter((state) => state.name)
      .map((state) => ({ status: state.name!, type: state.type, position: state.position })),
    ...issues.map((issue) => ({
      status: issue.status,
      type: issue.statusType,
      position: issue.statusPosition,
    })),
  ];
  for (const { status, type, position } of entries) {
    const typeOrder = STATUS_TYPE_ORDER[type ?? ""] ?? Number.MAX_SAFE_INTEGER;
    const current = statusOrder.get(status);
    if (!current || typeOrder < current.typeOrder) {
      statusOrder.set(status, { typeOrder, position });
      continue;
    }
    if (typeOrder !== current.typeOrder || position === undefined) continue;
    if (current.position === undefined || position < current.position) {
      statusOrder.set(status, { typeOrder, position });
    }
  }
  return statusOrder;
}

/** One lane of the board view: a workflow state and its issues, in order. */
export interface LinearLane {
  status: string;
  /** Linear's state type (`backlog`, `unstarted`, `started`, `completed`, `canceled`, …). */
  type?: string;
  position?: number;
  /**
   * The workflow state's id, which a card dropped here is moved to. Absent for
   * a lane known only from its issues (the board's states were not read).
   */
  stateId?: string;
  issues: LinearIssueListItem[];
}

/**
 * The board view's lanes: every workflow state of the board (empty ones too)
 * and any state an issue is in that the board did not list, in Linear's
 * order, each with its issues sorted by `order`.
 */
export function buildLinearLanes(
  issues: readonly LinearIssueListItem[],
  states: readonly LinearWorkflowState[],
  order: IssueOrder,
): LinearLane[] {
  const statusOrder = buildStatusOrder(issues, states);
  const lanes = new Map<string, LinearLane>();
  for (const state of states) {
    if (!state.name || lanes.has(state.name)) continue;
    lanes.set(state.name, {
      status: state.name,
      type: state.type,
      position: state.position,
      stateId: state.id,
      issues: [],
    });
  }
  for (const issue of issues) {
    const lane = lanes.get(issue.status) ?? {
      status: issue.status,
      type: issue.statusType,
      position: issue.statusPosition,
      issues: [],
    };
    lane.issues.push(issue);
    lanes.set(issue.status, lane);
  }
  for (const lane of lanes.values()) {
    lane.issues.sort((a, b) => compareIssueOrder(a, b, order));
  }
  return [...lanes.values()].sort((a, b) => compareStatusOrder(a.status, b.status, statusOrder));
}

export function compareStatusOrder(
  aStatus: string,
  bStatus: string,
  statusOrder: Map<string, StatusOrderKey>,
): number {
  const a = statusOrder.get(aStatus);
  const b = statusOrder.get(bStatus);
  const aTypeOrder = a?.typeOrder ?? Number.MAX_SAFE_INTEGER;
  const bTypeOrder = b?.typeOrder ?? Number.MAX_SAFE_INTEGER;
  if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder;

  const aPosition = a?.position;
  const bPosition = b?.position;
  if (aPosition !== undefined && bPosition !== undefined && aPosition !== bPosition) {
    return aPosition - bPosition;
  }
  if (aPosition !== undefined && bPosition === undefined) return -1;
  if (aPosition === undefined && bPosition !== undefined) return 1;
  return aStatus.localeCompare(bStatus);
}

export function compareIssueOrder(
  a: LinearIssueListItem,
  b: LinearIssueListItem,
  order: IssueOrder,
): number {
  if (order === "manual") return 0;

  if (order === "priority") {
    const aPriority =
      a.priority && a.priority > 0
        ? a.priority
        : (PRIORITY_BY_LABEL[a.priorityLabel?.toLowerCase() ?? ""] ?? 5);
    const bPriority =
      b.priority && b.priority > 0
        ? b.priority
        : (PRIORITY_BY_LABEL[b.priorityLabel?.toLowerCase() ?? ""] ?? 5);
    if (aPriority !== bPriority) return aPriority - bPriority;
    if (
      a.prioritySortOrder !== undefined &&
      b.prioritySortOrder !== undefined &&
      a.prioritySortOrder !== b.prioritySortOrder
    ) {
      return a.prioritySortOrder - b.prioritySortOrder;
    }
    if (a.prioritySortOrder !== undefined && b.prioritySortOrder === undefined) return -1;
    if (a.prioritySortOrder === undefined && b.prioritySortOrder !== undefined) return 1;
    return 0;
  }

  const aDate = a[order];
  const bDate = b[order];
  if (aDate && bDate) return bDate.localeCompare(aDate);
  if (aDate) return -1;
  if (bDate) return 1;
  return 0;
}
