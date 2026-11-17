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
  // Linear's own board order. The backend already lists issues by it; sorting
  // here too lets a card moved on the board (a new `sortOrder`) take its place
  // at once. Issues without one keep the order they arrived in.
  if (order === "manual") {
    if (a.sortOrder !== undefined && b.sortOrder !== undefined) return a.sortOrder - b.sortOrder;
    if (a.sortOrder !== undefined) return -1;
    if (b.sortOrder !== undefined) return 1;
    return 0;
  }

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

/**
 * Where a drop lands in a lane: before or after one of its cards, or (`null`)
 * after its last card.
 */
export type LinearDropAnchor = { issueId: string; before: boolean } | null;

/**
 * The Linear `sortOrder` each dropped issue takes so the issues sit together,
 * in the order given, at `anchor` in `lane` under the "Linear board" order:
 * spread evenly between the neighbouring cards' orders, or stepped one unit
 * past the only neighbour that has one (cards without an order sort last).
 *
 * Returns `null` when the drop changes nothing (the issues are already there,
 * or the anchor is one of the dropped cards). Empty lanes get fresh positions.
 * If interpolation cannot produce strict finite positions, the result includes
 * fresh positions for the destination lane too, preserving its intended order.
 */
export function planLinearDrop(
  lane: LinearLane,
  dropped: readonly LinearIssueListItem[],
  anchor: LinearDropAnchor,
): Map<string, number> | null {
  const droppedIds = new Set(dropped.map((issue) => issue.id));
  if (anchor && droppedIds.has(anchor.issueId)) return null;
  const rest = lane.issues.filter((issue) => !droppedIds.has(issue.id));
  let index = rest.length;
  if (anchor) {
    const at = rest.findIndex((issue) => issue.id === anchor.issueId);
    if (at === -1) return null;
    index = anchor.before ? at : at + 1;
  }
  const result = [...rest.slice(0, index), ...dropped, ...rest.slice(index)];
  const unchanged =
    result.length === lane.issues.length &&
    result.every((issue, position) => issue.id === lane.issues[position]?.id);
  if (unchanged) return null;

  const sortOrders = new Map<string, number>();
  const low = rest[index - 1]?.sortOrder;
  const high = rest[index]?.sortOrder;
  const count = dropped.length;
  dropped.forEach((issue, position) => {
    if (low !== undefined && high !== undefined) {
      sortOrders.set(issue.id, low + ((high - low) * (position + 1)) / (count + 1));
    } else if (low !== undefined) {
      // Cards without an order sort last, so nothing ordered follows `low`.
      sortOrders.set(issue.id, low + position + 1);
    } else if (high !== undefined) {
      sortOrders.set(issue.id, high - (count - position));
    } else {
      sortOrders.set(issue.id, position + 1);
    }
  });
  // Verify the complete sequence: ties, exhausted float gaps and unordered
  // neighbours can all make an apparently valid interpolation sort incorrectly.
  let previous = -Infinity;
  const valid = result.every((issue) => {
    const value = sortOrders.get(issue.id) ?? issue.sortOrder;
    if (value === undefined || !Number.isFinite(value) || value <= previous) return false;
    previous = value;
    return true;
  });
  if (!valid) {
    sortOrders.clear();
    result.forEach((issue, position) => sortOrders.set(issue.id, position + 1));
  }
  return sortOrders;
}
