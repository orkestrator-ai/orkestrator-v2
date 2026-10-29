import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import {
  graphPlanValueTypeLabel,
  type GraphCompileDiagnostic,
} from "@orkestrator/protocol/graphs/compile";
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import {
  isGraphRunInputRef,
  type GraphEdgeSource,
  type GraphEdgeSpec,
  type GraphEdgeTransform,
  type GraphLoopRegion,
} from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { GraphDiagnosticRow } from "./GraphCompilePanel";
import { GraphPredicateEditor } from "./GraphPredicateEditor";
import {
  removeGraphCarry,
  removeGraphEdge,
  removeGraphLoop,
  removeGraphNodeFromLoop,
  updateGraphLoop,
} from "./graph-designer-edits";
import { graphLoopPredicateScopeFor } from "./graph-designer-scopes";
import { useGraphEditor } from "./graph-editor-context";
import {
  CheckboxField,
  FormSection,
  JsonField,
  NumberField,
  RemoveButton,
  TextField,
} from "./graph-form-controls";

/**
 * Editable inspectors for an edge and a loop region (item 212). An edge can
 * be zipped (branch k feeds branch k), given declarative transforms (D14, as
 * JSON) or deleted. A loop region has its bound, its exit condition, its
 * members and its carries; deleting it keeps its members.
 */

function sourceLabel(source: GraphEdgeSource): string {
  if (isGraphRunInputRef(source)) return `run input ${source.input}`;
  return source.outlet !== undefined
    ? `${source.node} → ${source.outlet} (${source.port})`
    : `${source.node}.${source.port}`;
}

function Diagnostics({ list }: { list: readonly GraphCompileDiagnostic[] | undefined }) {
  const { select } = useGraphEditor();
  if (!list || list.length === 0) return null;
  return (
    <FormSection title="Diagnostics">
      <ul className="flex flex-col gap-1">
        {list.map((diagnostic, index) => (
          <GraphDiagnosticRow
            key={`${diagnostic.code}:${index}`}
            diagnostic={diagnostic}
            onSelect={(selection) => select(selection)}
          />
        ))}
      </ul>
    </FormSection>
  );
}

function isTransformList(value: unknown): string | null {
  if (!Array.isArray(value)) return "Transforms are a JSON list";
  if (value.length > GRAPH_TEMPLATE_BOUNDS.maxTransformsPerEdge) {
    return `At most ${GRAPH_TEMPLATE_BOUNDS.maxTransformsPerEdge} transforms`;
  }
  return value.every((entry) => entry && typeof entry === "object" && typeof entry.op === "string")
    ? null
    : 'Each transform is an object with an "op": pick, filter, limit, flatten or adapt';
}

export function GraphEdgeEditor({
  edgeId,
  diagnostics,
}: {
  edgeId: string;
  diagnostics: readonly GraphCompileDiagnostic[] | undefined;
}) {
  const { template, plan, edit, select } = useGraphEditor();
  const edge = template.edges.find((candidate) => candidate.id === edgeId);
  if (!edge)
    return <p className="text-muted-foreground">This edge is not in the template any more.</p>;
  const planEdge = plan?.edges.find((candidate) => candidate.id === edgeId);
  const patch = (label: string, change: (current: GraphEdgeSpec) => GraphEdgeSpec) =>
    edit(label, (current) => ({
      ...current,
      edges: current.edges.map((entry) => (entry.id === edgeId ? change(entry) : entry)),
    }));
  return (
    <div className="flex flex-col gap-3" data-graph-edge-editor={edgeId}>
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">Edge {edge.id}</h3>
        <p className="text-muted-foreground">
          {sourceLabel(edge.from)} → {edge.to.node}.{edge.to.port}
        </p>
        <div className="flex flex-wrap gap-1">
          {!isGraphRunInputRef(edge.from) ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => select({ kind: "node", id: (edge.from as { node: string }).node })}
            >
              Show {(edge.from as { node: string }).node}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => select({ kind: "node", id: edge.to.node })}
          >
            Show {edge.to.node}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] hover:text-failure"
            aria-keyshortcuts="Delete"
            onClick={() => {
              edit(`Delete edge ${edge.id}`, (current) => removeGraphEdge(current, edge.id));
              select(null);
            }}
          >
            <Trash2 className="size-3" /> Delete edge
          </Button>
        </div>
      </header>
      <Diagnostics list={diagnostics} />
      <FormSection title="Delivery">
        <p className="text-[11px] text-muted-foreground">
          {planEdge?.deliveredType
            ? `Delivers ${graphPlanValueTypeLabel(planEdge.deliveredType)}${planEdge.fanIn ? " (fan-in)" : ""}.`
            : "Compile the template without errors to see what this edge delivers."}
        </p>
        <CheckboxField
          label="Zip: branch k feeds branch k"
          checked={edge.zip === true}
          hint="Between two nodes replicated the same way; otherwise a replicated producer fans in as a list."
          onChange={(zip) =>
            patch(zip ? "Zip edge" : "Unzip edge", (current) => {
              const next = { ...current };
              if (zip) next.zip = true;
              else delete next.zip;
              return next;
            })
          }
        />
        <JsonField
          label="Transforms (pick, filter, limit, flatten, adapt)"
          value={edge.transform ?? []}
          rows={4}
          validate={isTransformList}
          onCommit={(value) =>
            patch("Edit transforms", (current) => {
              const list = value as GraphEdgeTransform[];
              const next = { ...current };
              if (list.length > 0) next.transform = list;
              else delete next.transform;
              return next;
            })
          }
        />
      </FormSection>
    </div>
  );
}

export function GraphLoopEditor({
  loopId,
  diagnostics,
}: {
  loopId: string;
  diagnostics: readonly GraphCompileDiagnostic[] | undefined;
}) {
  const { template, library, edit, select } = useGraphEditor();
  const loop = template.loops?.find((candidate) => candidate.id === loopId);
  const scope = useMemo(
    () => (loop ? graphLoopPredicateScopeFor(template, library, loop) : null),
    [template, library, loop],
  );
  if (!loop || !scope)
    return <p className="text-muted-foreground">This loop is not in the template any more.</p>;
  const patch = (
    label: string,
    change: (current: GraphLoopRegion) => GraphLoopRegion,
    coalesce?: string,
  ) =>
    edit(
      label,
      (current) => updateGraphLoop(current, loopId, change),
      coalesce ? { coalesce } : {},
    );
  return (
    <div className="flex flex-col gap-3" data-graph-loop-editor={loopId}>
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">↻ {loop.label ?? loop.id}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">Loop · {loop.id}</p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 self-start px-2 text-[11px] hover:text-failure"
          onClick={() => {
            edit(`Delete loop ${loop.id}`, (current) => removeGraphLoop(current, loop.id));
            select(null);
          }}
        >
          <Trash2 className="size-3" /> Delete loop (keep its nodes)
        </Button>
      </header>
      <Diagnostics list={diagnostics} />
      <FormSection title="Loop">
        <TextField
          label="Label"
          value={loop.label ?? ""}
          placeholder={loop.id}
          onChange={(label) =>
            patch(
              "Loop label",
              (current) => {
                const next = { ...current };
                if (label) next.label = label;
                else delete next.label;
                return next;
              },
              `loop:${loopId}:label`,
            )
          }
        />
        <NumberField
          label="At most iterations"
          value={loop.maxIterations}
          min={1}
          max={GRAPH_TEMPLATE_BOUNDS.maxLoopIterations}
          hint="Every loop is bounded (invariant 6)."
          onCommit={(maxIterations) =>
            patch(`At most ${maxIterations} iterations`, (current) => ({
              ...current,
              maxIterations: maxIterations ?? 1,
            }))
          }
        />
      </FormSection>
      <FormSection title="Until">
        <GraphPredicateEditor
          label="Stop when"
          value={loop.until}
          scope={scope}
          onChange={(until) => {
            if (until) patch("Edit loop condition", (current) => ({ ...current, until }));
          }}
        />
      </FormSection>
      <FormSection title="Members">
        <ul className="flex flex-col gap-1">
          {loop.nodes.map((member) => (
            <li key={member} className="flex items-center gap-1.5">
              <button
                type="button"
                className="font-mono text-[11px] text-primary hover:underline"
                onClick={() => select({ kind: "node", id: member })}
              >
                {member}
              </button>
              {loop.nodes.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-1.5 text-[11px]"
                  onClick={() =>
                    edit(`Take ${member} out of ${loop.id}`, (current) =>
                      removeGraphNodeFromLoop(current, member),
                    )
                  }
                >
                  Take out
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Drag a node onto the frame, or use “Loop…” on a node (L), to add it.
        </p>
      </FormSection>
      <FormSection title="Carries">
        {loop.carry.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            None. Draw an edge from a member back to an earlier member to carry a value into the
            next iteration.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {loop.carry.map((carry, index) => (
              <li
                key={`${carry.from.node}.${carry.from.port}:${index}`}
                className="flex items-center gap-1.5 font-mono text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate">
                  {carry.from.node}.{carry.from.port} → {carry.to.node}.{carry.to.port}
                </span>
                <RemoveButton
                  label={`Remove carry to ${carry.to.node}.${carry.to.port}`}
                  onClick={() =>
                    edit("Remove carry", (current) => removeGraphCarry(current, loop.id, index))
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </FormSection>
    </div>
  );
}
