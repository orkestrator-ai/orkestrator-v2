import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import {
  useGraphDesignerStore,
  type GraphDesignerCompile,
  type GraphDesignerSelection,
} from "@/stores/graphDesignerStore";
import type { GraphCanvasEditor } from "./GraphCanvas";
import type { GraphLoopChoice } from "./GraphCommandDialogs";
import {
  applyGraphConnection,
  graphConnectionVerdict,
  type GraphConnectionVerdict,
} from "./graph-designer-connect";
import {
  addGraphNode,
  addGraphNodeToLoop,
  createGraphLoop,
  moveGraphNodes,
  removeGraphEdge,
  removeGraphLoop,
  removeGraphNode,
  removeGraphNodeFromLoop,
} from "./graph-designer-edits";
import type { GraphEditorCommand, GraphEditorContextValue } from "./graph-editor-context";
import { GRAPH_NODE_KIND_LABELS } from "./graph-designer-model";

/**
 * The editable designer's wiring (item 212): the canvas editor (connect,
 * move, add, delete, loops), the inspector forms' context, and the keyboard
 * command dialogs, all turned into undoable store edits on one tab's draft.
 */
export function useGraphDesignerEditing(options: {
  tabId: string;
  draft: GraphTemplateV1 | null;
  library: GraphTypeLibrary;
  compile: GraphDesignerCompile | null;
  providers: readonly AgentPlatform[];
  ceiling?: GraphCapabilityCeiling;
  onSelect: (selection: GraphDesignerSelection, focus?: boolean) => void;
}) {
  const { tabId, draft, library, compile, providers, ceiling, onSelect } = options;
  const edit = useGraphDesignerStore((state) => state.edit);
  const acknowledge = useGraphDesignerStore((state) => state.acknowledge);
  const [dialog, setDialog] = useState<{ command: GraphEditorCommand; nodeId: string } | null>(
    null,
  );

  const editDraft = useCallback(
    (
      label: string,
      recipe: (template: GraphTemplateV1) => GraphTemplateV1,
      editOptions?: { coalesce?: string },
    ) => edit(tabId, label, recipe, editOptions),
    [edit, tabId],
  );

  const connect = useCallback(
    (verdict: Extract<GraphConnectionVerdict, { ok: true }>) => {
      if (!draft) return;
      const result = applyGraphConnection(draft, library, verdict);
      editDraft(verdict.plan.kind === "carry" ? "Add carry" : "Connect", () => result.template);
      if (result.createdNodeId) {
        onSelect({ kind: "node", id: result.createdNodeId });
        toast.message("Fan-in: dedupe merge inserted", { description: result.message });
      } else if (verdict.plan.kind === "fan-in-list" || verdict.plan.kind === "carry") {
        toast.message(result.message);
      }
    },
    [draft, library, editDraft, onSelect],
  );

  const canvasEditor = useMemo<GraphCanvasEditor | undefined>(() => {
    if (!draft) return undefined;
    return {
      verdict: (from, to) => graphConnectionVerdict(draft, library, from, to),
      connect,
      refuse: (reason) => toast.error("Not connected", { description: reason }),
      move: (positions, loops, moveOptions) => {
        const ids = Object.keys(positions);
        editDraft(
          ids.length === 1 ? `Move ${ids[0]}` : `Move ${ids.length} nodes`,
          (template) => {
            let next = moveGraphNodes(template, positions);
            for (const [nodeId, loopId] of Object.entries(loops)) {
              next =
                loopId === null
                  ? removeGraphNodeFromLoop(next, nodeId)
                  : addGraphNodeToLoop(next, nodeId, loopId);
            }
            return next;
          },
          moveOptions,
        );
      },
      remove: (selection) => {
        if (selection.kind === "node") {
          editDraft(`Delete ${selection.id}`, (template) =>
            removeGraphNode(template, selection.id),
          );
        } else if (selection.kind === "edge") {
          editDraft(`Delete edge ${selection.id}`, (template) =>
            removeGraphEdge(template, selection.id),
          );
        } else {
          editDraft(`Delete loop ${selection.id}`, (template) =>
            removeGraphLoop(template, selection.id),
          );
        }
        onSelect(null);
      },
      add: (item, position) => {
        const result = addGraphNode(draft, item, position);
        editDraft(
          `Add ${GRAPH_NODE_KIND_LABELS[item.kind].toLowerCase()} node`,
          () => result.template,
        );
        onSelect({ kind: "node", id: result.nodeId }, true);
      },
      wrapInLoop: (nodeId) => {
        const result = createGraphLoop(draft, [nodeId]);
        editDraft(`Wrap ${nodeId} in a loop`, () => result.template);
        onSelect({ kind: "loop", id: result.loopId });
      },
      command: (command, nodeId) => setDialog({ command, nodeId }),
    };
  }, [draft, library, connect, editDraft, onSelect]);

  const context = useMemo<GraphEditorContextValue | null>(
    () =>
      draft
        ? {
            template: draft,
            library,
            plan: compile?.plan ?? null,
            compile,
            providers,
            ...(ceiling ? { ceiling } : {}),
            edit: editDraft,
            select: (selection) => onSelect(selection, true),
            acknowledge: (ref) => acknowledge(tabId, ref),
            command: (command, nodeId) => setDialog({ command, nodeId }),
          }
        : null,
    [draft, library, compile, providers, ceiling, editDraft, onSelect, acknowledge, tabId],
  );

  const chooseLoop = useCallback(
    (nodeId: string, choice: GraphLoopChoice) => {
      if (!draft) return;
      if (choice.kind === "join") {
        editDraft(`Move ${nodeId} into ${choice.loopId}`, (template) =>
          addGraphNodeToLoop(template, nodeId, choice.loopId),
        );
      } else if (choice.kind === "leave") {
        editDraft(`Take ${nodeId} out of its loop`, (template) =>
          removeGraphNodeFromLoop(template, nodeId),
        );
      } else {
        const result = createGraphLoop(draft, [nodeId]);
        editDraft(`Wrap ${nodeId} in a loop`, () => result.template);
        onSelect({ kind: "loop", id: result.loopId });
      }
    },
    [draft, editDraft, onSelect],
  );

  return { canvasEditor, context, dialog, setDialog, connect, chooseLoop };
}
