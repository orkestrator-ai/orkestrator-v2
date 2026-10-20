import { memo, useMemo } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock3,
  HelpCircle,
  PlayCircle,
  Square,
} from "lucide-react";
import {
  layoutWorkflowSnapshot,
  type WorkflowSnapshotEdgeV1,
  type WorkflowSnapshotNodeV1,
  type WorkflowStatusV1,
} from "@orkestrator/protocol/workflow-snapshot";
import { flowEdgePath, type FlowRect } from "@/components/review/multi-review-flow";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import {
  openWorkflowLinkTarget,
  parseWorkflowTargetRef,
  type CreateWorkflowTab,
} from "@/lib/chat/artifact-workflow-links";
import { cn } from "@/lib/utils";

/**
 * Shared presentation for workflow snapshots (historical card and live
 * inspector): a deterministic graph using the review-flow visual language,
 * an equivalent table, and node details with link navigation. Nothing here
 * edits, drags, schedules or traverses the graph; status changes are a
 * static highlight, never a continuous animation.
 */

const COLUMN_WIDTH = 200;
const ROW_HEIGHT = 72;
const NODE_WIDTH = 168;
const NODE_HEIGHT = 52;
const PAD = 16;

export const WORKFLOW_STATUS_WORD: Record<WorkflowStatusV1, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  blocked: "Blocked",
  canceled: "Canceled",
  unknown: "Unknown",
};

const STATUS_CLASS: Record<WorkflowStatusV1, string> = {
  pending: "border-dashed border-border bg-sidebar text-muted-foreground",
  running: "border-cyan-400 bg-flow-node",
  succeeded: "border-success/55 bg-flow-node",
  failed: "border-failure/70 bg-flow-node",
  blocked: "border-amber-400/60 bg-flow-node",
  canceled: "border-border bg-sidebar text-muted-foreground",
  unknown: "border-dashed border-amber-300/70 bg-flow-node",
};

export function WorkflowStatusIcon({
  status,
  className,
}: {
  status: WorkflowStatusV1;
  className?: string;
}) {
  const iconClass = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "running":
      // Deliberately static: a historical or live status is not an animation.
      return <PlayCircle aria-hidden="true" className={cn(iconClass, "text-cyan-300")} />;
    case "succeeded":
      return <CheckCircle2 aria-hidden="true" className={cn(iconClass, "text-success")} />;
    case "failed":
      return <AlertCircle aria-hidden="true" className={cn(iconClass, "text-failure")} />;
    case "blocked":
      return <Ban aria-hidden="true" className={cn(iconClass, "text-amber-400")} />;
    case "canceled":
      return <Square aria-hidden="true" className={cn(iconClass, "text-muted-foreground")} />;
    case "pending":
      return <Clock3 aria-hidden="true" className={cn(iconClass, "text-muted-foreground/70")} />;
    default:
      return <HelpCircle aria-hidden="true" className={cn(iconClass, "text-amber-300")} />;
  }
}

/** Visible status text; an unmapped status stays visibly unknown with its raw value. */
export function workflowStatusText(status: WorkflowStatusV1, rawStatus?: string): string {
  if (status === "unknown") return rawStatus ? `Unknown (reported "${rawStatus}")` : "Unknown";
  return WORKFLOW_STATUS_WORD[status] ?? "Unknown";
}

export function formatSnapshotTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("Z", " UTC")}`;
}

function nodeAccessibleName(node: WorkflowSnapshotNodeV1, changed: boolean): string {
  return [
    node.label || node.id,
    node.role,
    `status ${workflowStatusText(node.status, node.rawStatus)}`,
    node.attemptId ? `attempt ${node.attemptId}` : null,
    changed ? "changed since the previous update" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function edgePath(from: FlowRect, to: FlowRect, forward: boolean): string {
  if (forward) return flowEdgePath(from, to);
  // Same column or a backward (retry) relation: arc over the top of both nodes.
  const fx = from.x + from.width / 2;
  const tx = to.x + to.width / 2;
  const lift = Math.min(from.y, to.y) - 18;
  return `M${fx} ${from.y} C${fx} ${lift} ${tx} ${lift} ${tx} ${to.y}`;
}

export interface WorkflowGraphProps {
  nodes: readonly WorkflowSnapshotNodeV1[];
  edges: readonly WorkflowSnapshotEdgeV1[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  changedIds?: ReadonlySet<string>;
  label: string;
}

export const WorkflowSnapshotGraph = memo(function WorkflowSnapshotGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
  changedIds,
  label,
}: WorkflowGraphProps) {
  const layout = useMemo(
    () =>
      layoutWorkflowSnapshot(
        { nodes: nodes as WorkflowSnapshotNodeV1[] },
        { columnWidth: COLUMN_WIDTH, rowHeight: ROW_HEIGHT },
      ),
    [nodes],
  );
  const rects = useMemo(() => {
    const map = new Map<string, FlowRect & { column: number }>();
    for (const node of layout.nodes) {
      map.set(node.id, {
        x: node.x + PAD,
        y: node.y + PAD + 12,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        column: node.column,
      });
    }
    return map;
  }, [layout]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const width = layout.width + PAD * 2;
  const height = layout.height + PAD * 2 + 12;

  return (
    <div
      className="max-h-[60vh] overflow-auto rounded border border-border/60 bg-flow-canvas"
      data-workflow-graph="true"
    >
      <div role="group" aria-label={label} className="relative" style={{ width, height }}>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
        >
          {edges.map((edge) => {
            const from = rects.get(edge.from);
            const to = rects.get(edge.to);
            if (!from || !to) return null;
            const forward = from.column < to.column;
            return (
              <path
                key={edge.id}
                data-workflow-edge={edge.id}
                d={edgePath(from, to, forward)}
                fill="none"
                strokeWidth={2}
                className={edge.relation === "retry" ? "stroke-amber-400/70" : "stroke-flow-edge"}
                strokeDasharray={
                  edge.relation === "retry"
                    ? "4 4"
                    : edge.relation === "unknown"
                      ? "1 4"
                      : undefined
                }
              />
            );
          })}
        </svg>
        {layout.nodes.map((position) => {
          const node = byId.get(position.id)!;
          const rect = rects.get(position.id)!;
          const changed = changedIds?.has(node.id) ?? false;
          return (
            <button
              key={node.id}
              type="button"
              data-workflow-node={node.id}
              data-workflow-status={node.status}
              aria-label={nodeAccessibleName(node, changed)}
              aria-pressed={selectedId === node.id}
              onClick={() => onSelect(node.id)}
              className={cn(
                "absolute flex flex-col justify-center rounded-xl border px-2.5 py-1.5 text-left outline-2 outline-offset-2 outline-transparent focus-visible:outline-primary",
                STATUS_CLASS[node.status] ?? STATUS_CLASS.unknown,
                selectedId === node.id && "outline-primary/60",
                changed && "ring-2 ring-primary/70",
              )}
              style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <WorkflowStatusIcon status={node.status} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                  {node.label || node.id}
                </span>
              </span>
              <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {workflowStatusText(node.status, node.rawStatus)}
                {changed ? " · changed" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

export function WorkflowSnapshotTable({
  nodes,
  caption,
}: {
  nodes: readonly WorkflowSnapshotNodeV1[];
  caption: string;
}) {
  return (
    <div className="max-h-[60vh] overflow-auto" data-workflow-table="true">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="px-2 py-1 text-left text-[11px] text-muted-foreground">
          {caption}
        </caption>
        <thead className="sticky top-0 bg-muted">
          <tr>
            {["Node", "Role", "Status", "Attempt", "Validation", "Started", "Finished"].map(
              (column) => (
                <th
                  key={column}
                  scope="col"
                  className="border-b border-border px-2 py-1 font-medium"
                >
                  {column}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id}>
              <th scope="row" className="border-b border-border/50 px-2 py-0.5 font-normal">
                {node.label || node.id}
              </th>
              <td className="border-b border-border/50 px-2 py-0.5">{node.role}</td>
              <td className="border-b border-border/50 px-2 py-0.5">
                {workflowStatusText(node.status, node.rawStatus)}
              </td>
              <td className="border-b border-border/50 px-2 py-0.5">{node.attemptId ?? ""}</td>
              <td className="border-b border-border/50 px-2 py-0.5">{validationText(node)}</td>
              <td className="border-b border-border/50 px-2 py-0.5">
                {formatSnapshotTime(node.startedAt)}
              </td>
              <td className="border-b border-border/50 px-2 py-0.5">
                {formatSnapshotTime(node.finishedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function validationText(node: WorkflowSnapshotNodeV1): string {
  // Only what the backend reported; no state is inferred from colour or output.
  if (!node.validation) return "";
  const counts = [
    node.validation.findingCount !== undefined ? `${node.validation.findingCount} findings` : null,
    node.validation.errorCount !== undefined ? `${node.validation.errorCount} errors` : null,
  ].filter(Boolean);
  return counts.length > 0
    ? `${node.validation.state} (${counts.join(", ")})`
    : node.validation.state;
}

const RELATION_LABEL: Record<WorkflowSnapshotNodeV1["links"][number]["relation"], string> = {
  transcript: "Open transcript",
  findings: "Open findings",
  validation: "Open validation",
  "tool-output": "Open tool output",
  diff: "Open diff",
};

export function WorkflowNodeDetails({
  node,
  workflowTitle,
}: {
  node: WorkflowSnapshotNodeV1;
  workflowTitle: string;
}) {
  const createTab = useOptionalTerminalContext()?.createTab ?? null;
  return (
    <div
      className="mt-2 rounded border border-border/60 p-2 text-xs"
      data-workflow-node-details={node.id}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <WorkflowStatusIcon status={node.status} />
        <span>{node.label || node.id}</span>
        <span className="font-normal text-muted-foreground">
          · {workflowStatusText(node.status, node.rawStatus)}
        </span>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">Role</dt>
        <dd>{node.role}</dd>
        {node.attemptId ? (
          <>
            <dt className="text-muted-foreground">Attempt</dt>
            <dd>{node.attemptId}</dd>
          </>
        ) : null}
        {node.validation ? (
          <>
            <dt className="text-muted-foreground">Validation</dt>
            <dd>{validationText(node)}</dd>
          </>
        ) : null}
        {node.startedAt ? (
          <>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{formatSnapshotTime(node.startedAt)}</dd>
          </>
        ) : null}
        {node.finishedAt ? (
          <>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>{formatSnapshotTime(node.finishedAt)}</dd>
          </>
        ) : null}
      </dl>
      {node.links.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {node.links.map((link, index) => {
            const target = parseWorkflowTargetRef(link.targetRef);
            const usable = target !== null && createTab !== null;
            return (
              <button
                key={`${link.relation}-${index}`}
                type="button"
                disabled={!usable}
                title={usable ? undefined : "No viewer for this reference is available here"}
                onClick={() => {
                  if (!target || !createTab) return;
                  openWorkflowLinkTarget(
                    target,
                    createTab as CreateWorkflowTab,
                    `${workflowTitle} · ${node.label || node.id}`,
                  );
                }}
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {link.label || RELATION_LABEL[link.relation]}
                {usable ? "" : " (not available here)"}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
