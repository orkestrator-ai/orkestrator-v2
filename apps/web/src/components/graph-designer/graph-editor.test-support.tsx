import { useMemo, useState, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { compile } from "@orkestrator/protocol/graphs/compile";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { acknowledgeGraphWarning } from "./graph-designer-edits";
import { graphTemplateTypeLibrary } from "./graph-designer-model";
import {
  GraphEditorContext,
  type GraphEditorCommand,
  type GraphEditorContextValue,
} from "./graph-editor-context";

/**
 * Renders an editable-inspector form against a live template, as the
 * designer does: every `edit` applies at once (and is recorded), and the
 * context carries the template's compile result. `current()` is the template
 * after the edits so far.
 */

export interface GraphEditorHarness {
  current: () => GraphTemplateV1;
  edits: Array<{ label: string; coalesce?: string }>;
  selections: GraphDesignerSelection[];
  commands: Array<{ command: GraphEditorCommand; nodeId: string }>;
}

export function renderWithGraphEditor(
  template: GraphTemplateV1,
  ui: (template: GraphTemplateV1) => ReactNode,
) {
  const harness: GraphEditorHarness = {
    current: () => template,
    edits: [],
    selections: [],
    commands: [],
  };
  function Host() {
    const [draft, setDraft] = useState(template);
    const value = useMemo<GraphEditorContextValue>(() => {
      const result = compile(draft);
      return {
        template: draft,
        library: graphTemplateTypeLibrary(draft),
        plan: result.plan,
        compile: {
          source: "browser",
          ok: result.ok,
          launchable: result.launchable,
          diagnostics: result.diagnostics,
          omittedDiagnostics: result.omittedDiagnostics,
          cost: result.cost,
          pendingAcknowledgements: result.pendingAcknowledgements,
          plan: result.plan,
        },
        providers: AGENT_PLATFORMS,
        edit: (label, recipe, options) => {
          harness.edits.push({
            label,
            ...(options?.coalesce ? { coalesce: options.coalesce } : {}),
          });
          setDraft((current) => {
            const next = recipe(current);
            harness.current = () => next;
            return next;
          });
        },
        select: (selection) => harness.selections.push(selection),
        acknowledge: (ref) =>
          setDraft((current) => {
            const next = acknowledgeGraphWarning(current, ref);
            harness.current = () => next;
            return next;
          }),
        command: (command, nodeId) => harness.commands.push({ command, nodeId }),
      };
    }, [draft]);
    return <GraphEditorContext.Provider value={value}>{ui(draft)}</GraphEditorContext.Provider>;
  }
  const view = render(<Host />);
  return { ...view, harness };
}
