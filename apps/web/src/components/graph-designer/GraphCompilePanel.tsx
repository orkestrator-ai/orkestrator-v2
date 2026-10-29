import { AlertCircle, AlertTriangle, Info, Loader2, ShieldCheck } from "lucide-react";
import type {
  GraphCompileDiagnostic,
  GraphPlanAcknowledgementRef,
} from "@orkestrator/protocol/graphs/compile";
import { Button } from "@/components/ui/button";
import type {
  GraphDesignerCompile,
  GraphDesignerLoadStatus,
  GraphDesignerSelection,
} from "@/stores/graphDesignerStore";
import { cn } from "@/lib/utils";
import { graphDiagnosticCounts } from "./graph-designer-model";
import { graphDesignerNodeOf } from "./graph-designer-subgraphs";

/**
 * The compile panel (report §7.4): every diagnostic, pinned to the node, edge
 * or loop it names (clicking selects it and brings it into view), and the
 * cost estimate: best- and worst-case agent sessions and peak parallelism.
 * While a template is edited (item 212) it is live (the draft compiles in the
 * browser as it changes) and lists the warnings waiting for the user's
 * acknowledgement (§5.13 taint, D4 lowered floor), each with an Acknowledge
 * action that records it in the template against the warning's digest.
 */

const SEVERITY_ICON = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_TONE = {
  error: "text-failure",
  warning: "text-amber-300",
  info: "text-sky-300",
} as const;

/** Where a diagnostic points, as a selection; null when it names no node, edge or loop. */
export function graphDiagnosticTarget(diagnostic: GraphCompileDiagnostic): GraphDesignerSelection {
  // Inlined from a sub-graph (item 402): select the sub-graph node.
  const inlined = [diagnostic.nodeId, diagnostic.edgeId, diagnostic.loopId].find(
    (id) => id !== undefined && id.includes("/"),
  );
  if (inlined !== undefined) return { kind: "node", id: graphDesignerNodeOf(inlined) };
  if (diagnostic.edgeId) return { kind: "edge", id: diagnostic.edgeId };
  if (diagnostic.nodeId) return { kind: "node", id: diagnostic.nodeId };
  if (diagnostic.loopId) return { kind: "loop", id: diagnostic.loopId };
  return null;
}

function locationLabel(diagnostic: GraphCompileDiagnostic): string | null {
  if (diagnostic.edgeId) return `edge ${diagnostic.edgeId}`;
  if (diagnostic.nodeId) {
    return diagnostic.port ? `${diagnostic.nodeId}.${diagnostic.port}` : diagnostic.nodeId;
  }
  if (diagnostic.loopId) return `loop ${diagnostic.loopId}`;
  return diagnostic.path ?? null;
}

export function GraphDiagnosticRow({
  diagnostic,
  onSelect,
}: {
  diagnostic: GraphCompileDiagnostic;
  onSelect: (selection: GraphDesignerSelection, focus?: boolean) => void;
}) {
  const Icon = SEVERITY_ICON[diagnostic.severity];
  const target = graphDiagnosticTarget(diagnostic);
  const location = locationLabel(diagnostic);
  const body = (
    <>
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-3.5 shrink-0", SEVERITY_TONE[diagnostic.severity])}
      />
      <span className="min-w-0 flex-1">
        <span className="font-mono text-[11px] text-muted-foreground">{diagnostic.code}</span>
        {location ? (
          <span className="ml-1.5 font-mono text-[11px] text-foreground/80">{location}</span>
        ) : null}
        {diagnostic.acknowledgement ? (
          <span className="ml-1.5 text-[11px] text-muted-foreground">
            {diagnostic.acknowledgement.accepted ? "acknowledged" : "needs acknowledgement"}
          </span>
        ) : null}
        <span className="block break-words text-foreground">{diagnostic.message}</span>
      </span>
    </>
  );
  return (
    <li data-graph-diagnostic={diagnostic.code} data-graph-severity={diagnostic.severity}>
      {target ? (
        <button
          type="button"
          className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
          onClick={() => onSelect(target, true)}
          aria-label={`${diagnostic.severity}: ${diagnostic.message}${location ? ` (${location})` : ""}`}
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-2 py-1 text-xs">{body}</div>
      )}
    </li>
  );
}

function PendingAcknowledgements({
  compile,
  onAcknowledge,
  onSelect,
}: {
  compile: GraphDesignerCompile;
  onAcknowledge: (ref: GraphPlanAcknowledgementRef) => void;
  onSelect: (selection: GraphDesignerSelection, focus?: boolean) => void;
}) {
  if (compile.pendingAcknowledgements.length === 0) return null;
  return (
    <section
      aria-label="Needs your acknowledgement"
      data-graph-pending-acknowledgements={compile.pendingAcknowledgements.length}
      className="border-b border-border/60 bg-amber-500/5 px-2 py-1.5"
    >
      <h4 className="px-1 pb-1 text-[11px] font-semibold text-amber-200">
        Needs your acknowledgement ({compile.pendingAcknowledgements.length})
      </h4>
      <ul className="flex flex-col gap-1">
        {compile.pendingAcknowledgements.map((ref) => {
          const diagnostic = compile.diagnostics.find(
            (entry) => entry.acknowledgement?.digest === ref.digest,
          );
          return (
            <li
              key={`${ref.kind}:${ref.digest}`}
              data-graph-pending-acknowledgement={ref.code}
              className="flex items-start gap-2 text-xs"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
              <button
                type="button"
                className="min-w-0 flex-1 text-left hover:underline"
                onClick={() =>
                  onSelect({ kind: "node", id: graphDesignerNodeOf(ref.nodeId) }, true)
                }
              >
                <span className="font-mono text-[11px] text-muted-foreground">
                  {ref.code} · {ref.nodeId}
                </span>
                <span className="block break-words text-foreground">
                  {diagnostic?.message ?? `A ${ref.kind} warning on ${ref.nodeId}`}
                </span>
              </button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-[11px]"
                aria-label={`Acknowledge ${ref.code} on ${ref.nodeId}`}
                onClick={() => onAcknowledge(ref)}
              >
                <ShieldCheck className="size-3" />
                Acknowledge
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function GraphCompilePanel({
  compile,
  status,
  error,
  onSelect,
  onAcknowledge,
  className,
}: {
  compile: GraphDesignerCompile | null;
  status: GraphDesignerLoadStatus;
  error: string | null;
  onSelect: (selection: GraphDesignerSelection, focus?: boolean) => void;
  /** The editor's: records an acknowledgement in the draft. */
  onAcknowledge?: (ref: GraphPlanAcknowledgementRef) => void;
  className?: string;
}) {
  const counts = compile ? graphDiagnosticCounts(compile.diagnostics) : null;
  const cost = compile?.cost;
  return (
    <section
      aria-label="Compile results"
      data-graph-compile-panel=""
      data-graph-compile-source={compile?.source}
      className={cn("flex min-h-0 flex-col border-t border-border", className)}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 px-3 py-1.5 text-xs">
        <span className="font-semibold text-foreground">Compile</span>
        {status === "loading" && !compile ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2 aria-hidden className="size-3 animate-spin" /> Compiling…
          </span>
        ) : null}
        {counts ? (
          <span data-graph-compile-counts="" className="flex items-center gap-2 tabular-nums">
            <span className={counts.errors > 0 ? "text-failure" : "text-muted-foreground"}>
              {counts.errors} error{counts.errors === 1 ? "" : "s"}
            </span>
            <span className={counts.warnings > 0 ? "text-amber-300" : "text-muted-foreground"}>
              {counts.warnings} warning{counts.warnings === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground">{counts.infos} info</span>
          </span>
        ) : null}
        {cost ? (
          <span
            data-graph-cost=""
            className="flex items-center gap-3 text-muted-foreground tabular-nums"
          >
            <span title="Agent sessions in the best and worst case">
              Sessions{" "}
              <span className="text-foreground">
                {cost.agentSessions.best}–{cost.agentSessions.worst}
              </span>
            </span>
            <span title="Activations (agent and other nodes) in the best and worst case">
              Activations{" "}
              <span className="text-foreground">
                {cost.activations.best}–{cost.activations.worst}
              </span>
            </span>
            <span title="Most agents that can run at once (an upper bound)">
              Peak parallelism <span className="text-foreground">{cost.peakParallelism}</span>
            </span>
            {cost.incomplete ? <span>(sub-graphs not counted)</span> : null}
          </span>
        ) : null}
        {compile ? (
          <span className="ml-auto text-muted-foreground">
            {compile.source === "browser"
              ? "Draft, compiled in the browser"
              : "Compiled by the backend under the project's ceiling"}
            {compile.blockedBy
              ? ` · launch blocked: template ${compile.blockedBy === "changed" ? "changed since approval" : "not trusted"}`
              : compile.ok && !compile.launchable
                ? " · needs acknowledgements"
                : ""}
          </span>
        ) : null}
      </header>
      {error ? <p className="px-3 py-2 text-xs text-failure">Could not compile: {error}</p> : null}
      {compile && onAcknowledge ? (
        <PendingAcknowledgements
          compile={compile}
          onAcknowledge={onAcknowledge}
          onSelect={onSelect}
        />
      ) : null}
      {compile ? (
        compile.diagnostics.length === 0 ? (
          <p data-graph-compile-clean="" className="px-3 py-2 text-xs text-muted-foreground">
            No diagnostics: the template compiles cleanly.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {compile.diagnostics.map((diagnostic, index) => (
              <GraphDiagnosticRow
                key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}
                diagnostic={diagnostic}
                onSelect={onSelect}
              />
            ))}
            {compile.omittedDiagnostics > 0 ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {compile.omittedDiagnostics} more not shown.
              </li>
            ) : null}
          </ul>
        )
      ) : null}
    </section>
  );
}
