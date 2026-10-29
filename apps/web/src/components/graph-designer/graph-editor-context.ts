import { createContext, useContext } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import type {
  CompiledGraphPlan,
  GraphPlanAcknowledgementRef,
} from "@orkestrator/protocol/graphs/compile";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import type { GraphDesignerCompile, GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { updateGraphNode } from "./graph-designer-edits";

/**
 * What the editable inspector's forms share (item 212): the draft, its type
 * library and last compile, and one way to change it. Every change goes
 * through `edit`, which the store records as an undo step.
 */

export type GraphEditFn = (
  label: string,
  recipe: (template: GraphTemplateV1) => GraphTemplateV1,
  options?: { coalesce?: string },
) => void;

export type GraphEditorCommand = "connect" | "loop";

export interface GraphEditorContextValue {
  template: GraphTemplateV1;
  library: GraphTypeLibrary;
  plan: CompiledGraphPlan | null;
  compile: GraphDesignerCompile | null;
  providers: readonly AgentPlatform[];
  ceiling?: GraphCapabilityCeiling;
  edit: GraphEditFn;
  select: (selection: GraphDesignerSelection) => void;
  acknowledge: (ref: GraphPlanAcknowledgementRef) => void;
  /** Opens the keyboard "Connect to…" or "Move into loop" dialog for a node. */
  command: (command: GraphEditorCommand, nodeId: string) => void;
  /** The project whose templates a sub-graph node may inline (item 402). */
  projectId?: string | null;
}

export const GraphEditorContext = createContext<GraphEditorContextValue | null>(null);

export function useGraphEditor(): GraphEditorContextValue {
  const value = useContext(GraphEditorContext);
  if (!value) throw new Error("useGraphEditor outside the editable designer");
  return value;
}

/** Edits one node as an undo step (coalesced per node and field when `field` is given). */
export function useGraphNodeEdit(nodeId: string) {
  const { edit } = useGraphEditor();
  return <N extends GraphNodeSpec>(
    label: string,
    recipe: (node: N) => GraphNodeSpec,
    field?: string,
  ) =>
    edit(
      label,
      (template) => updateGraphNode(template, nodeId, (node) => recipe(node as N)),
      field ? { coalesce: `node:${nodeId}:${field}` } : {},
    );
}
