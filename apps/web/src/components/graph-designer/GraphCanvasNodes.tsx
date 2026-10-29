import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Boxes, Cog, GitMerge, type LucideIcon, Split, UserRound } from "lucide-react";
import type { GraphEnforcementTier, GraphNodeKind } from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import {
  GRAPH_ENFORCEMENT_LABELS,
  GRAPH_TYPE_FAMILY_COLORS,
  GRAPH_TYPE_FAMILY_LABELS,
  type GraphCanvasIoNode,
  type GraphCanvasLoopNode,
  type GraphCanvasTemplateNode,
  type GraphDesignerPortView,
  type GraphDiagnosticCounts,
} from "./graph-designer-model";

/**
 * Node faces of the Graphs designer canvas (report §7.2): the title, then
 * `{role} · {profile}`, then the enforcement and replication badges, then the
 * typed ports. Port handles carry their type family's colour. Read-only in
 * Phase 1: no handle is connectable.
 */

export const GRAPH_NODE_KIND_ICONS: Readonly<Record<GraphNodeKind, LucideIcon>> = Object.freeze({
  agent: Bot,
  system: Cog,
  gate: Split,
  merge: GitMerge,
  human: UserRound,
  subgraph: Boxes,
});

const ENFORCEMENT_TONE: Readonly<Record<GraphEnforcementTier, string>> = Object.freeze({
  enforced: "border-emerald-500/40 text-emerald-300",
  "provider-configured": "border-sky-500/40 text-sky-300",
  advisory: "border-amber-500/40 text-amber-300",
});

export function DiagnosticChips({ counts }: { counts: GraphDiagnosticCounts }) {
  if (counts.errors === 0 && counts.warnings === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums">
      {counts.errors > 0 ? (
        <span
          data-graph-chip="errors"
          className="rounded-full bg-failure/20 px-1.5 py-px text-failure"
          title={`${counts.errors} error${counts.errors === 1 ? "" : "s"}`}
        >
          {counts.errors}
        </span>
      ) : null}
      {counts.warnings > 0 ? (
        <span
          data-graph-chip="warnings"
          className="rounded-full bg-amber-500/20 px-1.5 py-px text-amber-300"
          title={`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`}
        >
          {counts.warnings}
        </span>
      ) : null}
    </span>
  );
}

export function TypeFamilyDot({ port }: { port: Pick<GraphDesignerPortView, "family" | "type"> }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: GRAPH_TYPE_FAMILY_COLORS[port.family] }}
      title={`${GRAPH_TYPE_FAMILY_LABELS[port.family]}: ${port.type}`}
    />
  );
}

function handleStyle(port: Pick<GraphDesignerPortView, "family" | "required">) {
  const color = GRAPH_TYPE_FAMILY_COLORS[port.family];
  return {
    width: 10,
    height: 10,
    background: port.required ? color : "var(--color-flow-node)",
    border: `2px solid ${color}`,
  };
}

function PortRow({ port, side }: { port: GraphDesignerPortView; side: "in" | "out" }) {
  return (
    <div
      data-graph-port={port.handleId}
      data-graph-type-family={port.family}
      className={cn(
        "relative flex h-5 min-w-0 items-center text-[11px] text-muted-foreground",
        side === "in" ? "pl-3" : "justify-end pr-3",
      )}
      title={`${port.name}: ${port.type}${port.required ? "" : " (optional)"}`}
    >
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={port.handleId}
        isConnectable={false}
        style={handleStyle(port)}
      />
      <span className="truncate">{port.label ?? port.name}</span>
    </div>
  );
}

function GraphNodeFaceImpl({ data, selected }: NodeProps<GraphCanvasTemplateNode>) {
  const Icon = GRAPH_NODE_KIND_ICONS[data.kind];
  const { errors, warnings } = data.diagnostics;
  const rows = Math.max(data.inputs.length, data.outputs.length + data.outlets.length);
  return (
    <div
      data-graph-node={data.kind}
      data-graph-node-id={data.nodeId}
      data-graph-diagnostics={errors > 0 ? "error" : warnings > 0 ? "warning" : undefined}
      data-graph-selected={selected ? "" : undefined}
      className={cn(
        "w-60 rounded-xl border bg-flow-node text-left shadow-sm transition-[box-shadow,border-color]",
        errors > 0
          ? "border-failure/80 shadow-[0_0_0_1px_var(--color-failure)]"
          : warnings > 0
            ? "border-amber-500/60"
            : "border-border",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-flow-canvas",
      )}
    >
      <div className="px-3 pt-2.5 pb-1.5">
        {/* Row 1: the title, whole, then the diagnostic counts. */}
        <div className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            data-graph-node-title=""
            className="min-w-0 truncate text-[13px] font-semibold text-foreground"
          >
            {data.title}
          </span>
          <DiagnosticChips counts={data.diagnostics} />
        </div>
        {/* Row 2: `{role} · {profile}`, or what the node does. */}
        <div
          data-graph-node-detail=""
          className="mt-0.5 truncate text-xs text-muted-foreground"
          title={data.detail}
        >
          {data.detail}
        </div>
        {/* Row 3: the enforcement floor and replication badges. */}
        <div className="mt-1 flex min-h-4 items-center gap-1.5">
          {data.enforcement ? (
            <span
              data-graph-badge="enforcement"
              className={cn(
                "rounded border px-1 text-[10px] leading-4",
                ENFORCEMENT_TONE[data.enforcement],
              )}
              title={`Minimum enforcement: ${GRAPH_ENFORCEMENT_LABELS[data.enforcement]}`}
            >
              ≥ {GRAPH_ENFORCEMENT_LABELS[data.enforcement]}
            </span>
          ) : null}
          {data.replication ? (
            <span
              data-graph-badge="replication"
              className="rounded border border-indigo-400/40 px-1 text-[10px] leading-4 text-indigo-300"
              title="Replicated: one branch per panel member, lens, sample or item"
            >
              {data.replication}
            </span>
          ) : null}
        </div>
      </div>
      {rows > 0 ? (
        <div className="grid grid-cols-2 border-t border-border/60 py-1">
          <div className="min-w-0">
            {data.inputs.map((port) => (
              <PortRow key={port.handleId} port={port} side="in" />
            ))}
          </div>
          <div className="min-w-0">
            {data.outputs.map((port) => (
              <PortRow key={port.handleId} port={port} side="out" />
            ))}
            {data.outlets.map((outlet) => (
              <div
                key={outlet.handleId}
                data-graph-port={outlet.handleId}
                className="relative flex h-5 min-w-0 items-center justify-end pr-3 text-[11px] text-muted-foreground italic"
                title={`Outlet ${outlet.name}: forwards this node's inputs when taken`}
              >
                <Handle
                  type="source"
                  position={Position.Right}
                  id={outlet.handleId}
                  isConnectable={false}
                  style={{
                    width: 10,
                    height: 10,
                    background: "var(--color-flow-node)",
                    border: "2px solid #a1a1aa",
                  }}
                />
                <span className="truncate">→ {outlet.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const GraphNodeFace = memo(GraphNodeFaceImpl);

function GraphIoFaceImpl({ data }: NodeProps<GraphCanvasIoNode>) {
  const side = data.direction === "inputs" ? "out" : "in";
  return (
    <div
      data-graph-io={data.direction}
      className="w-45 rounded-lg border border-dashed border-border bg-flow-node/70 py-1.5"
    >
      <div className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {data.direction === "inputs" ? "Run inputs" : "Run outputs"}
      </div>
      {data.ports.map((port) => (
        <PortRow key={port.handleId} port={port} side={side} />
      ))}
    </div>
  );
}

export const GraphIoFace = memo(GraphIoFaceImpl);

function GraphLoopFaceImpl({ data, selected }: NodeProps<GraphCanvasLoopNode>) {
  return (
    <div
      data-graph-loop={data.loopId}
      data-graph-diagnostics={
        data.diagnostics.errors > 0
          ? "error"
          : data.diagnostics.warnings > 0
            ? "warning"
            : undefined
      }
      className={cn(
        "h-full w-full rounded-2xl border border-dashed bg-indigo-500/5",
        data.diagnostics.errors > 0 ? "border-failure/70" : "border-indigo-400/50",
        selected && "border-solid border-primary",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px] text-indigo-200">
        <span
          data-graph-badge="loop"
          className="rounded border border-indigo-400/40 px-1 font-medium"
          title={`Loop: at most ${data.maxIterations} iteration${data.maxIterations === 1 ? "" : "s"}`}
        >
          ↻ ≤ {data.maxIterations}
        </span>
        <span className="truncate">{data.label}</span>
        <DiagnosticChips counts={data.diagnostics} />
      </div>
    </div>
  );
}

export const GraphLoopFace = memo(GraphLoopFaceImpl);

/** Stable for React Flow (a new object each render would remount every node). */
export const GRAPH_CANVAS_NODE_TYPES = {
  "graph-node": GraphNodeFace,
  "graph-io": GraphIoFace,
  "graph-loop": GraphLoopFace,
};
