import { useMemo, useState } from "react";
import { Link2, Repeat, Trash2 } from "lucide-react";
import type { GraphCompileDiagnostic } from "@orkestrator/protocol/graphs/compile";
import { isGraphId } from "@orkestrator/protocol/graphs/grammar";
import type { GraphAgentNode, GraphNodeSpec } from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { GRAPH_NODE_KIND_ICONS } from "./GraphCanvasNodes";
import { GraphDiagnosticRow } from "./GraphCompilePanel";
import { GraphCapabilitiesEditor } from "./GraphCapabilitiesEditor";
import { GraphExecutionEditor } from "./GraphExecutionEditor";
import {
  GraphGateEditor,
  GraphHumanEditor,
  GraphMergeEditor,
  GraphNodeExecutionFields,
  GraphSystemEditor,
} from "./GraphKindEditors";
import { GraphMockPinsEditor } from "./GraphMockPinsEditor";
import { GraphPredicateEditor } from "./GraphPredicateEditor";
import { GraphInputsEditor, GraphOutputsEditor } from "./GraphPortsEditor";
import { GraphPromptEditor } from "./GraphPromptEditor";
import { GraphSubgraphEditor } from "./GraphSubgraphEditor";
import { graphLoopOf, removeGraphNode, renameGraphNode } from "./graph-designer-edits";
import { GRAPH_NODE_KIND_LABELS, graphNodeTitle } from "./graph-designer-model";
import { graphNodePredicateScopeFor } from "./graph-designer-scopes";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import { CommitField, EditorTabs, FormSection, TextField } from "./graph-form-controls";

/**
 * The editable inspector of one node (report §7.2): its id, label and
 * description, then the form of its kind. An agent node's form has five tabs
 * (Prompt, Inputs/Outputs, Capabilities, Execution, Mock run); system and
 * human nodes end with their mock-run pins (item 213). The header's buttons are
 * the keyboard equivalents of drawing on the canvas: "Connect to…" and
 * "Loop…" (also C and L on a focused node), and Delete.
 */

type AgentTab = "prompt" | "ports" | "capabilities" | "execution" | "mock";

const AGENT_TABS: ReadonlyArray<{ value: AgentTab; label: string }> = [
  { value: "prompt", label: "Prompt" },
  { value: "ports", label: "Inputs/Outputs" },
  { value: "capabilities", label: "Capabilities" },
  { value: "execution", label: "Execution" },
  { value: "mock", label: "Mock run" },
];

function AgentEditor({ node }: { node: GraphAgentNode }) {
  const [tab, setTab] = useState<AgentTab>("prompt");
  return (
    <div className="flex flex-col gap-3">
      <EditorTabs label={`${node.id} sections`} tabs={AGENT_TABS} value={tab} onChange={setTab} />
      {tab === "prompt" ? <GraphPromptEditor node={node} /> : null}
      {tab === "ports" ? (
        <>
          <GraphInputsEditor node={node} />
          <GraphOutputsEditor node={node} />
        </>
      ) : null}
      {tab === "capabilities" ? <GraphCapabilitiesEditor node={node} /> : null}
      {tab === "execution" ? <GraphExecutionEditor node={node} /> : null}
      {tab === "mock" ? <GraphMockPinsEditor node={node} /> : null}
    </div>
  );
}

/** `when` for the non-agent kinds (agents have it under Execution). */
function WhenEditor({ node }: { node: GraphNodeSpec }) {
  const { template, library, plan } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const scope = useMemo(
    () => graphNodePredicateScopeFor(template, library, node, plan),
    [template, library, node, plan],
  );
  return (
    <FormSection title="Runs when">
      <GraphPredicateEditor
        label="Condition"
        value={node.when}
        scope={scope}
        optional
        onChange={(when) =>
          editNode(when ? "Edit condition" : "Remove condition", (current) => {
            const next = { ...current };
            if (when) next.when = when;
            else delete next.when;
            return next;
          })
        }
      />
    </FormSection>
  );
}

export function GraphNodeEditor({
  node,
  diagnostics,
}: {
  node: GraphNodeSpec;
  diagnostics: readonly GraphCompileDiagnostic[] | undefined;
}) {
  const { template, edit, select, command, projectId } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const Icon = GRAPH_NODE_KIND_ICONS[node.kind];
  const loop = graphLoopOf(template, node.id);
  return (
    <div className="flex flex-col gap-3" data-graph-node-editor={node.id}>
      <header className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
            {graphNodeTitle(node)}
          </h3>
        </span>
        <p className="font-mono text-[11px] text-muted-foreground">
          {GRAPH_NODE_KIND_LABELS[node.kind]} · {node.id}
          {loop ? ` · in loop ${loop.id}` : ""}
        </p>
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            aria-keyshortcuts="C"
            onClick={() => command("connect", node.id)}
          >
            <Link2 className="size-3" /> Connect to…
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            aria-keyshortcuts="L"
            onClick={() => command("loop", node.id)}
          >
            <Repeat className="size-3" /> Loop…
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] hover:text-failure"
            aria-keyshortcuts="Delete"
            onClick={() => {
              edit(`Delete ${node.id}`, (current) => removeGraphNode(current, node.id));
              select(null);
            }}
          >
            <Trash2 className="size-3" /> Delete
          </Button>
        </div>
      </header>
      {diagnostics && diagnostics.length > 0 ? (
        <FormSection title="Diagnostics">
          <ul className="flex flex-col gap-1">
            {diagnostics.map((diagnostic, index) => (
              <GraphDiagnosticRow
                key={`${diagnostic.code}:${index}`}
                diagnostic={diagnostic}
                onSelect={(selection) => select(selection)}
              />
            ))}
          </ul>
        </FormSection>
      ) : null}
      <FormSection title="Node">
        <CommitField
          label="Id"
          value={node.id}
          hint="Edges, loops and conditions follow a rename."
          validate={(id) =>
            !isGraphId(id)
              ? "Lower-case letters, digits and single dashes, starting with a letter"
              : template.nodes.some((other) => other.id === id)
                ? "Another node has this id"
                : null
          }
          onCommit={(id) => {
            edit(`Rename ${node.id} to ${id}`, (current) => renameGraphNode(current, node.id, id));
            select({ kind: "node", id });
          }}
        />
        <TextField
          label="Label"
          value={node.label ?? ""}
          placeholder={node.id}
          onChange={(label) =>
            editNode(
              "Edit label",
              (current) => {
                const next = { ...current };
                if (label) next.label = label;
                else delete next.label;
                return next;
              },
              "label",
            )
          }
        />
        <TextField
          label="Description"
          value={node.description ?? ""}
          multiline
          rows={2}
          onChange={(description) =>
            editNode(
              "Edit description",
              (current) => {
                const next = { ...current };
                if (description) next.description = description;
                else delete next.description;
                return next;
              },
              "description",
            )
          }
        />
      </FormSection>
      {node.kind === "agent" ? <AgentEditor node={node} /> : null}
      {node.kind === "system" ? (
        <>
          <GraphSystemEditor node={node} />
          <GraphInputsEditor node={node} />
          <GraphOutputsEditor node={node} />
          <GraphNodeExecutionFields node={node} />
          <WhenEditor node={node} />
          <GraphMockPinsEditor node={node} />
        </>
      ) : null}
      {node.kind === "gate" ? (
        <>
          <GraphInputsEditor node={node} title="Inputs (forwarded by every outlet)" />
          <GraphGateEditor node={node} />
          <WhenEditor node={node} />
        </>
      ) : null}
      {node.kind === "merge" ? (
        <>
          <GraphMergeEditor node={node} />
          <GraphInputsEditor node={node} title="Input (one list)" />
          <GraphOutputsEditor node={node} />
          <GraphNodeExecutionFields node={node} />
        </>
      ) : null}
      {node.kind === "human" ? (
        <>
          <GraphHumanEditor node={node} />
          <GraphInputsEditor
            node={node}
            title="Inputs (shown to the person, forwarded by outlets)"
          />
          <GraphNodeExecutionFields node={node} />
          <WhenEditor node={node} />
          <GraphMockPinsEditor node={node} />
        </>
      ) : null}
      {node.kind === "subgraph" ? (
        <GraphSubgraphEditor node={node} projectId={projectId ?? null} />
      ) : null}
    </div>
  );
}
