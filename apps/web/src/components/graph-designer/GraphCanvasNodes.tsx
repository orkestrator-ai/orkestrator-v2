import { createContext, memo, useContext, useMemo } from "react";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import { Bot, Boxes, Cog, GitMerge, type LucideIcon, Split, UserRound } from "lucide-react";
import type { GraphEnforcementTier, GraphNodeKind } from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import type { GraphConnectEnd, GraphConnectionVerdict } from "./graph-designer-connect";
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
import { SideEffectBadge } from "./graph-form-controls";

/**
 * Node faces of the Graphs designer canvas (report §7.2): the title, then
 * `{role} · {profile}`, then the enforcement, replication and side-effect
 * badges (a system action that changes something outside the run), then the
 * typed ports. Port handles carry their type family's colour. A replicated
 * node draws as a stacked card with its "×N" badge (D9).
 *
 * Read-only (item 110) no handle is connectable. On the editable canvas
 * (item 212) the faces read the connection being dragged (`useConnection`)
 * and ask the canvas which of their handles could take it: compatible
 * handles stay connectable and light up, the rest dim and refuse the drop.
 */

/** Set by the editable canvas; null on the read-only one. */
export interface GraphCanvasConnectContextValue {
  verdict: (from: GraphConnectEnd, to: GraphConnectEnd) => GraphConnectionVerdict;
}

export const GraphCanvasConnectContext = createContext<GraphCanvasConnectContextValue | null>(null);

interface DragOrigin {
  node: string;
  handle: string;
  type: "source" | "target";
}

/** The handle a connection drag started from, or null; stable while the pointer moves. */
function useDragOrigin(enabled: boolean): DragOrigin | null {
  const origin = useConnection((connection) =>
    enabled && connection.inProgress && connection.fromHandle
      ? {
          node: connection.fromNode.id,
          handle: connection.fromHandle.id ?? "",
          type: connection.fromHandle.type,
        }
      : null,
  );
  return origin && "node" in origin ? (origin as DragOrigin) : null;
}

type HandleState = "idle" | "origin" | "compatible" | "incompatible";

/** Per own handle: can the connection in progress end here? */
function useHandleStates(
  nodeId: string,
  handles: ReadonlyArray<{ id: string; type: "source" | "target" }>,
) {
  const connect = useContext(GraphCanvasConnectContext);
  const origin = useDragOrigin(connect !== null);
  return useMemo(() => {
    const states = new Map<string, { state: HandleState; reason?: string }>();
    for (const handle of handles) {
      if (!connect || !origin) {
        states.set(handle.id, { state: "idle" });
      } else if (origin.node === nodeId && origin.handle === handle.id) {
        states.set(handle.id, { state: "origin" });
      } else if (origin.type === handle.type) {
        states.set(handle.id, { state: "incompatible" });
      } else {
        const verdict = connect.verdict(
          { node: origin.node, handle: origin.handle },
          { node: nodeId, handle: handle.id },
        );
        states.set(
          handle.id,
          verdict.ok ? { state: "compatible" } : { state: "incompatible", reason: verdict.reason },
        );
      }
    }
    return { editable: connect !== null, states };
  }, [connect, origin, nodeId, handles]);
}

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

function connectAttributes(state: HandleState | undefined) {
  return state && state !== "idle" ? { "data-graph-connect": state } : {};
}

function rowTone(state: HandleState | undefined) {
  return cn(state === "incompatible" && "opacity-30", state === "compatible" && "text-foreground");
}

function handleRing(state: HandleState | undefined) {
  return state === "compatible"
    ? { boxShadow: "0 0 0 3px rgba(129, 140, 248, 0.55)" }
    : state === "incompatible"
      ? { opacity: 0.4 }
      : {};
}

function PortRow({
  port,
  side,
  editable = false,
  state,
  reason,
}: {
  port: GraphDesignerPortView;
  side: "in" | "out";
  editable?: boolean;
  state?: HandleState;
  reason?: string;
}) {
  return (
    <div
      data-graph-port={port.handleId}
      data-graph-type-family={port.family}
      {...connectAttributes(state)}
      className={cn(
        "relative flex h-5 min-w-0 items-center text-[11px] text-muted-foreground transition-opacity",
        side === "in" ? "pl-3" : "justify-end pr-3",
        rowTone(state),
      )}
      title={reason ?? `${port.name}: ${port.type}${port.required ? "" : " (optional)"}`}
    >
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={port.handleId}
        isConnectable={editable}
        isConnectableStart={editable}
        isConnectableEnd={editable && state !== "incompatible"}
        style={{ ...handleStyle(port), ...handleRing(state) }}
      />
      <span className="truncate">{port.label ?? port.name}</span>
    </div>
  );
}

/** The `+` handle: dropping a connection here adds a port of the delivered type. */
function NewPortRow({
  label,
  state,
  reason,
}: {
  label: string;
  state?: HandleState;
  reason?: string;
}) {
  return (
    <div
      data-graph-port="in:+"
      {...connectAttributes(state)}
      className={cn(
        "relative flex h-5 min-w-0 items-center pl-3 text-[11px] text-muted-foreground/80 italic transition-opacity",
        rowTone(state),
      )}
      title={reason ?? "Drop a connection here to add a port of its type"}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in:+"
        isConnectable
        isConnectableStart={false}
        isConnectableEnd={state !== "incompatible"}
        style={{
          width: 10,
          height: 10,
          background: "var(--color-flow-node)",
          border: "2px dashed #a1a1aa",
          ...handleRing(state),
        }}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}

function faceHandles(data: GraphCanvasTemplateNode["data"]) {
  return [
    ...data.inputs.map((port) => ({ id: port.handleId, type: "target" as const })),
    ...(data.newInput ? [{ id: "in:+", type: "target" as const }] : []),
    ...data.outputs.map((port) => ({ id: port.handleId, type: "source" as const })),
    ...data.outlets.map((outlet) => ({ id: outlet.handleId, type: "source" as const })),
  ];
}

function GraphNodeFaceImpl({ data, selected }: NodeProps<GraphCanvasTemplateNode>) {
  const Icon = GRAPH_NODE_KIND_ICONS[data.kind];
  const { errors, warnings } = data.diagnostics;
  const rows = Math.max(
    data.inputs.length + (data.newInput ? 1 : 0),
    data.outputs.length + data.outlets.length,
  );
  const handles = useMemo(() => faceHandles(data), [data]);
  const { editable, states } = useHandleStates(data.nodeId, handles);
  const face = (
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
        {/* Row 3: the enforcement floor, replication and side-effect badges. */}
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
          {data.sideEffect ? <SideEffectBadge /> : null}
        </div>
      </div>
      {rows > 0 ? (
        <div className="grid grid-cols-2 border-t border-border/60 py-1">
          <div className="min-w-0">
            {data.inputs.map((port) => (
              <PortRow
                key={port.handleId}
                port={port}
                side="in"
                editable={editable}
                state={states.get(port.handleId)?.state}
                reason={states.get(port.handleId)?.reason}
              />
            ))}
            {data.newInput ? (
              <NewPortRow
                label="+ input"
                state={states.get("in:+")?.state}
                reason={states.get("in:+")?.reason}
              />
            ) : null}
          </div>
          <div className="min-w-0">
            {data.outputs.map((port) => (
              <PortRow
                key={port.handleId}
                port={port}
                side="out"
                editable={editable}
                state={states.get(port.handleId)?.state}
                reason={states.get(port.handleId)?.reason}
              />
            ))}
            {data.outlets.map((outlet) => {
              const state = states.get(outlet.handleId)?.state;
              return (
                <div
                  key={outlet.handleId}
                  data-graph-port={outlet.handleId}
                  {...connectAttributes(state)}
                  className={cn(
                    "relative flex h-5 min-w-0 items-center justify-end pr-3 text-[11px] text-muted-foreground italic",
                    rowTone(state),
                  )}
                  title={
                    states.get(outlet.handleId)?.reason ??
                    `Outlet ${outlet.name}: forwards this node's inputs when taken`
                  }
                >
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={outlet.handleId}
                    isConnectable={editable}
                    isConnectableStart={editable}
                    isConnectableEnd={false}
                    style={{
                      width: 10,
                      height: 10,
                      background: "var(--color-flow-node)",
                      border: "2px solid #a1a1aa",
                      ...handleRing(state),
                    }}
                  />
                  <span className="truncate">→ {outlet.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
  if (!data.replication) return face;
  // D9: a replicated node is one card drawn as a stack, its badge saying how many.
  return (
    <div data-graph-stack="" className="relative">
      <div
        aria-hidden
        className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-indigo-400/30 bg-flow-node/60"
      />
      <div
        aria-hidden
        className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl border border-indigo-400/40 bg-flow-node/80"
      />
      <div className="relative">{face}</div>
    </div>
  );
}

export const GraphNodeFace = memo(GraphNodeFaceImpl);

function GraphIoFaceImpl({ id, data }: NodeProps<GraphCanvasIoNode>) {
  const side = data.direction === "inputs" ? "out" : "in";
  const handles = useMemo(
    () => [
      ...data.ports.map((port) => ({
        id: port.handleId,
        type: side === "in" ? ("target" as const) : ("source" as const),
      })),
      ...(data.newPort ? [{ id: "in:+", type: "target" as const }] : []),
    ],
    [data, side],
  );
  const { editable, states } = useHandleStates(id, handles);
  return (
    <div
      data-graph-io={data.direction}
      className="w-45 rounded-lg border border-dashed border-border bg-flow-node/70 py-1.5"
    >
      <div className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {data.direction === "inputs" ? "Run inputs" : "Run outputs"}
      </div>
      {data.ports.map((port) => (
        <PortRow
          key={port.handleId}
          port={port}
          side={side}
          editable={editable}
          state={states.get(port.handleId)?.state}
          reason={states.get(port.handleId)?.reason}
        />
      ))}
      {data.newPort ? (
        <NewPortRow
          label="+ output"
          state={states.get("in:+")?.state}
          reason={states.get("in:+")?.reason}
        />
      ) : null}
      {editable && data.ports.length === 0 && data.direction === "inputs" ? (
        <p className="px-3 text-[11px] text-muted-foreground/80">
          Add run inputs in the template panel.
        </p>
      ) : null}
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
