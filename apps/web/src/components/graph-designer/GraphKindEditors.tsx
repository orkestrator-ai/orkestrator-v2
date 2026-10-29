import { useMemo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import type { GraphPredicate } from "@orkestrator/protocol/graphs/predicates";
import { graphNodeOutlets, type GraphGateNode } from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { GraphMergeEditor, GraphHumanEditor } from "./GraphMergeHumanEditors";
import { graphWithoutField } from "./GraphNodeExecutionFields";
import { GraphPredicateEditor } from "./GraphPredicateEditor";
import { GraphSystemEditor } from "./GraphSystemEditor";
import { graphNodeById, uniqueGraphKey, updateGraphNode } from "./graph-designer-edits";
import {
  graphNodePredicateScopeFor,
  pruneGraphOutletReferences,
  graphOutletValidator,
  renameGraphOutlet,
} from "./graph-designer-scopes";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import {
  AddButton,
  CheckboxField,
  CommitField,
  EntryCard,
  FormSection,
  RemoveButton,
  TextField,
} from "./graph-form-controls";
export { GraphMergeEditor, GraphHumanEditor } from "./GraphMergeHumanEditors";
export { GraphSystemEditor } from "./GraphSystemEditor";
export { GraphNodeExecutionFields } from "./GraphNodeExecutionFields";

/**
 * Editable forms for gate, merge and human nodes (item 212; system nodes are
 * in `GraphSystemEditor`), plus the execution fields (retry, timeout, failure
 * policy) every kind that has them shares. Each change is one undo step; renaming or removing an outlet
 * rewrites or drops the edges that read it.
 */

const B = GRAPH_TEMPLATE_BOUNDS;

// ---------------------------------------------------------------- gate

export function GraphGateEditor({ node }: { node: GraphGateNode }) {
  const { edit, template, library, plan } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const scope = useMemo(
    () => graphNodePredicateScopeFor(template, library, node, plan),
    [template, library, node, plan],
  );
  const outlets = graphNodeOutlets(node) ?? [];
  const setBranches = (label: string, branches: GraphGateNode["branches"]) =>
    edit(label, (current) =>
      pruneGraphOutletReferences(
        updateGraphNode(current, node.id, (entry) => ({ ...entry, branches }) as GraphGateNode),
        node.id,
      ),
    );
  const move = (index: number, by: -1 | 1) => {
    const branches = [...node.branches];
    const [entry] = branches.splice(index, 1);
    branches.splice(index + by, 0, entry!);
    setBranches("Reorder branches", branches);
  };
  return (
    <div data-graph-gate-editor="" className="flex flex-col gap-3">
      <FormSection
        title="Branches"
        actions={
          <AddButton
            label="Branch"
            disabled={node.branches.length >= B.maxGateBranches}
            onClick={() =>
              setBranches("Add branch", [
                ...node.branches,
                {
                  to: uniqueGraphKey("branch", outlets),
                  when: { path: "run.iteration", op: "gte", value: 1 },
                },
              ])
            }
          />
        }
      >
        <p className="text-[11px] text-muted-foreground">
          Tried in order; the first that holds takes its outlet, which forwards every input of the
          gate.
        </p>
        {node.branches.map((branch, index) => (
          <EntryCard key={`${index}:${branch.to}`}>
            <div data-graph-gate-branch={branch.to} className="flex items-end gap-1">
              <div className="min-w-0 flex-1">
                <CommitField
                  label="Outlet"
                  value={branch.to}
                  validate={graphOutletValidator(node, branch.to)}
                  onCommit={(to) =>
                    edit(`Rename outlet ${branch.to}`, (current) =>
                      renameGraphOutlet(current, node.id, branch.to, to),
                    )
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${branch.to} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${branch.to} down`}
                disabled={index === node.branches.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-3" />
              </Button>
              {node.branches.length > 1 ? (
                <RemoveButton
                  label={`Remove branch ${branch.to}`}
                  onClick={() =>
                    setBranches(
                      `Remove branch ${branch.to}`,
                      node.branches.filter((_, at) => at !== index),
                    )
                  }
                />
              ) : null}
            </div>
            <TextField
              label="Label"
              value={branch.label ?? ""}
              onChange={(label) =>
                editNode<GraphGateNode>(
                  "Edit branch label",
                  (current) => ({
                    ...current,
                    branches: current.branches.map((entry, at) =>
                      at === index
                        ? label
                          ? { ...entry, label }
                          : graphWithoutField(entry, "label")
                        : entry,
                    ),
                  }),
                  `branch:${index}:label`,
                )
              }
            />
            <GraphPredicateEditor
              label="When"
              value={branch.when}
              scope={scope}
              onChange={(when) =>
                editNode<GraphGateNode>(
                  "Edit branch condition",
                  (current) => ({
                    ...current,
                    branches: current.branches.map((entry, at) =>
                      at === index ? { ...entry, when: when as GraphPredicate } : entry,
                    ),
                  }),
                  `branch:${index}:when`,
                )
              }
            />
          </EntryCard>
        ))}
      </FormSection>
      <FormSection title="Otherwise">
        <CheckboxField
          label="An outlet when no branch holds"
          checked={node.otherwise !== undefined}
          hint="Without one, the gate's consumers are skipped when no branch holds."
          onChange={(checked) =>
            edit(checked ? "Add otherwise outlet" : "Remove otherwise outlet", (current) =>
              pruneGraphOutletReferences(
                updateGraphNode(current, node.id, (entry) =>
                  checked
                    ? ({
                        ...entry,
                        otherwise: uniqueGraphKey("otherwise", outlets),
                      } as GraphGateNode)
                    : graphWithoutField(entry as GraphGateNode, "otherwise"),
                ),
                node.id,
              ),
            )
          }
        />
        {node.otherwise !== undefined ? (
          <CommitField
            label="Otherwise outlet"
            value={node.otherwise}
            validate={graphOutletValidator(node, node.otherwise)}
            onCommit={(to) =>
              edit(`Rename outlet ${node.otherwise}`, (current) =>
                renameGraphOutlet(current, node.id, node.otherwise!, to),
              )
            }
          />
        ) : null}
      </FormSection>
    </div>
  );
}

/** For callers that hold only an id: the node's kind editor, or null for kinds without one here. */
export function GraphKindEditor({ nodeId }: { nodeId: string }) {
  const { template } = useGraphEditor();
  const node = graphNodeById(template, nodeId);
  if (!node) return null;
  switch (node.kind) {
    case "system":
      return <GraphSystemEditor node={node} />;
    case "gate":
      return <GraphGateEditor node={node} />;
    case "merge":
      return <GraphMergeEditor node={node} />;
    case "human":
      return <GraphHumanEditor node={node} />;
    default:
      return null;
  }
}
