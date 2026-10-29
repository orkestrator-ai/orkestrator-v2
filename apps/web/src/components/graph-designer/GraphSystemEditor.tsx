import { Plus } from "lucide-react";
import {
  GRAPH_SYSTEM_ACTION_SPECS,
  type GraphSystemActionPort,
} from "@orkestrator/protocol/graphs/system-actions";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphInputPortSpec,
  type GraphOutputPortSpec,
  type GraphSystemAction,
  type GraphSystemNode,
} from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { GraphNodeExecutionFields } from "./GraphNodeExecutionFields";
import { GraphSystemParamsEditor } from "./GraphSystemParamsEditor";
import {
  removeGraphInputPort,
  removeGraphOutputPort,
  uniqueGraphKey,
  updateGraphNode,
} from "./graph-designer-edits";
import { graphSystemDefaultPorts, graphSystemPortName } from "./graph-designer-system-actions";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import { FormSection, SelectField, SideEffectBadge } from "./graph-form-controls";

/**
 * A system node's form (items 207, 212). Everything about the action comes
 * from its spec (`GRAPH_SYSTEM_ACTION_SPECS`): its label and description,
 * whether it has a side effect (a mock run records it as "would have run"),
 * what a retry will not repeat, the types it reads and produces, and its
 * parameters. Ports bind by type, so the form lists the spec's types with
 * the port carrying each and offers the missing ones; when the compiler
 * reports a port the action cannot read or an input it lacks, the form shows
 * the compiler's messages and offers the action's default ports.
 */

const PORT_CODES = new Set(["system-port-unsupported", "system-input-missing"]);

function SpecPorts({
  node,
  side,
  ports,
}: {
  node: GraphSystemNode;
  side: "input" | "output";
  ports: readonly GraphSystemActionPort[];
}) {
  const editNode = useGraphNodeEdit(node.id);
  const present: ReadonlyArray<GraphInputPortSpec | GraphOutputPortSpec> =
    (side === "input" ? node.inputs : node.outputs) ?? [];
  if (ports.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {side === "input" ? "Reads nothing." : "Produces nothing."}
      </p>
    );
  }
  const add = (type: string) =>
    editNode<GraphSystemNode>(`Add ${side} ${type}`, (current) => {
      const existing = (side === "input" ? current.inputs : current.outputs) ?? [];
      const port = {
        name: uniqueGraphKey(
          graphSystemPortName(type),
          existing.map((entry) => entry.name),
        ),
        type,
      };
      return side === "input"
        ? { ...current, inputs: [...(current.inputs ?? []), port] }
        : { ...current, outputs: [...(current.outputs ?? []), port] };
    });
  return (
    <ul className="flex flex-col gap-1">
      {ports.map((port) => {
        const carrier = present.find((entry) => entry.type === port.type);
        return (
          <li
            key={port.type}
            data-graph-system-port={`${side}:${port.type}`}
            className="flex items-start gap-2 text-[11px]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="font-mono text-foreground">{port.type}</code>
                {side === "input" ? (
                  <span className="text-muted-foreground">
                    {port.required ? "required" : "optional"}
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground">{port.description}</p>
            </div>
            {carrier ? (
              <span className="shrink-0 text-muted-foreground">
                on <code className="font-mono text-foreground">{carrier.name}</code>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-1.5 text-[11px]"
                aria-label={`Add ${side} ${port.type}`}
                onClick={() => add(port.type)}
              >
                <Plus className="size-3" />
                Add
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function GraphSystemEditor({ node }: { node: GraphSystemNode }) {
  const { edit, library, compile } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const spec = GRAPH_SYSTEM_ACTION_SPECS[node.action];
  const portIssues = (compile?.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.nodeId === node.id && PORT_CODES.has(diagnostic.code),
  );
  const useDefaultPorts = () =>
    edit(`Use the default ports of ${spec.label}`, (template) => {
      const defaults = graphSystemDefaultPorts(node.action, library);
      let next = template;
      const keepIn = new Set(defaults.inputs.map((port) => port.name));
      const keepOut = new Set(defaults.outputs.map((port) => port.name));
      for (const port of node.inputs ?? []) {
        if (!keepIn.has(port.name)) next = removeGraphInputPort(next, node.id, port.name);
      }
      for (const port of node.outputs ?? []) {
        if (!keepOut.has(port.name)) next = removeGraphOutputPort(next, node.id, port.name);
      }
      return updateGraphNode(next, node.id, (current) => ({ ...current, ...defaults }));
    });
  const changeAction = (action: GraphSystemAction) =>
    editNode<GraphSystemNode>("Change action", (current) => {
      // Parameters the new action does not take would only be errors.
      const taken = GRAPH_SYSTEM_ACTION_SPECS[action].params;
      const params = Object.fromEntries(
        Object.entries(current.params ?? {}).filter(([key]) => key in taken),
      );
      const next: GraphSystemNode = { ...current, action };
      if (Object.keys(params).length > 0) next.params = params;
      else delete next.params;
      return next;
    });
  return (
    <div data-graph-system-editor="" className="flex flex-col gap-3">
      <FormSection title="System action" actions={spec.sideEffect ? <SideEffectBadge /> : null}>
        <SelectField
          label="Action"
          value={node.action}
          options={GRAPH_SYSTEM_ACTIONS.map((action) => ({
            value: action,
            label: GRAPH_SYSTEM_ACTION_SPECS[action].label,
          }))}
          hint={spec.description}
          onChange={(value) => changeAction(value as GraphSystemAction)}
        />
        <p data-graph-system-idempotency="" className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">On retry or restart: </span>
          {spec.idempotency}
          {spec.sideEffect ? " A mock run records this node as would-have-run." : ""}
        </p>
        {portIssues.length === 0 ? null : (
          <div
            data-graph-system-port-issues=""
            className="flex flex-col gap-1 rounded-md border border-failure/40 p-2"
          >
            <ul className="flex flex-col gap-0.5 text-[11px] text-failure">
              {portIssues.map((issue, index) => (
                <li key={index} data-graph-diagnostic-code={issue.code}>
                  {issue.message}
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="h-6 self-start px-2 text-[11px]"
              onClick={useDefaultPorts}
            >
              Use default ports
            </Button>
          </div>
        )}
      </FormSection>
      <FormSection title="Reads">
        <SpecPorts node={node} side="input" ports={spec.inputs} />
      </FormSection>
      <FormSection title="Produces">
        <SpecPorts node={node} side="output" ports={spec.outputs} />
        <p className="text-[11px] text-muted-foreground">
          An <code className="font-mono">error</code> output (<code>error@1</code>) is always
          allowed, for routing failures.
        </p>
      </FormSection>
      <GraphSystemParamsEditor node={node} />
      <GraphNodeExecutionFields node={node} />
    </div>
  );
}
