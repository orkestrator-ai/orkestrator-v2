import { useMemo } from "react";
import {
  graphMockPinKind,
  type GraphMockPin,
  type GraphMockPinKind,
} from "@orkestrator/protocol/graphs/mock";
import { graphNodeOutlets, type GraphNodeSpec } from "@orkestrator/protocol/graphs/template";
import { GRAPH_ERROR_CAUSES, type GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import { useGraphEditor } from "./graph-editor-context";
import {
  AddButton,
  EntryCard,
  FormSection,
  JsonField,
  RemoveButton,
  SelectField,
} from "./graph-form-controls";
import {
  graphMockPinIssuesFor,
  graphMockPinsOf,
  graphMockPreview,
  isGraphMockPinnable,
  setGraphMockPins,
} from "./graph-designer-mock";

/**
 * The pinned-sequence editor of one node (item 213, report §7.5): what a
 * mock run answers on the node's first, second, … activation ("Verify: fail,
 * fail, pass"); past the end the last entry repeats, and a node without pins
 * answers with its types' examples. Each entry is a choice: the example, a
 * value generated from the schema, custom JSON per output port, or a pinned
 * failure; a human node takes an outlet (with an edited value for an `edit`
 * form), or pauses for a person. Saved with the template (`mockPins`, outside
 * its digest); the designer's "Mock run" uses them.
 */

const MAX_PREVIEW_CHARS = 4_000;

function preview(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text;
}

function choicesFor(node: GraphNodeSpec): Array<{ value: GraphMockPinKind; label: string }> {
  if (node.kind === "human") {
    return [
      { value: "example", label: "Answer by itself (approve, first choice)" },
      { value: "outlet", label: "Take an outlet" },
      { value: "pause", label: "Pause for a person" },
      { value: "fail", label: "Fail" },
    ];
  }
  return [
    { value: "example", label: "Example" },
    { value: "generated", label: "Generated from the schema" },
    { value: "custom", label: "Custom JSON" },
    { value: "fail", label: "Fail" },
  ];
}

export function GraphMockPinsEditor({ node }: { node: GraphNodeSpec }) {
  const { template, library, edit } = useGraphEditor();
  const sequence = graphMockPinsOf(template, node.id);
  const issues = useMemo(() => graphMockPinIssuesFor(template, node.id), [template, node.id]);
  const outlets = graphNodeOutlets(node) ?? [];
  if (!isGraphMockPinnable(node)) return null;

  const write = (label: string, next: GraphMockPin[], coalesce?: string) =>
    edit(
      label,
      (current) => setGraphMockPins(current, node.id, next),
      coalesce ? { coalesce: `mock:${node.id}:${coalesce}` } : {},
    );
  const replace = (index: number, pin: GraphMockPin, coalesce?: string) =>
    write(
      "Edit mock pin",
      sequence.map((entry, at) => (at === index ? pin : entry)),
      coalesce,
    );
  const fresh = (kind: GraphMockPinKind): GraphMockPin => {
    switch (kind) {
      case "custom":
        return { outputs: graphMockPreview(node, library, "example") };
      case "fail":
        return { fail: "provider-error" };
      case "outlet":
        return { outlet: outlets[0] ?? "approved" };
      default:
        return kind;
    }
  };

  return (
    <FormSection
      title="Mock run"
      actions={
        <AddButton
          label="Add run"
          onClick={() => write("Add mock pin", [...sequence, sequence.at(-1) ?? "example"])}
        />
      }
    >
      <p className="text-[11px] text-muted-foreground" data-graph-mock-pins-hint="">
        {sequence.length === 0
          ? node.kind === "human"
            ? "A mock run answers this node by itself. Add runs to choose outlets per run."
            : "A mock run answers with each output type's example. Add runs to pin answers, such as fail, fail, pass."
          : "Run n takes entry n; after the last entry, the last one repeats."}
      </p>
      {sequence.map((pin, index) => {
        const kind = graphMockPinKind(pin);
        const entryIssues = issues.filter((issue) => issue.index === index);
        return (
          <EntryCard key={index}>
            <div className="flex items-end gap-1" data-graph-mock-pin={index}>
              <div className="min-w-0 flex-1">
                <SelectField
                  label={`Run ${index + 1}${index === sequence.length - 1 && index > 0 ? " and later" : ""}`}
                  value={kind}
                  options={choicesFor(node)}
                  onChange={(value) => replace(index, fresh(value as GraphMockPinKind))}
                />
              </div>
              <RemoveButton
                label={`Remove run ${index + 1}`}
                onClick={() =>
                  write(
                    "Remove mock pin",
                    sequence.filter((_, at) => at !== index),
                  )
                }
              />
            </div>
            {typeof pin !== "string" && "fail" in pin ? (
              <SelectField
                label="Cause"
                value={pin.fail}
                options={GRAPH_ERROR_CAUSES.map((cause) => ({ value: cause, label: cause }))}
                onChange={(cause) => replace(index, { ...pin, fail: cause as GraphErrorCause })}
              />
            ) : null}
            {typeof pin !== "string" && "outlet" in pin ? (
              <>
                <SelectField
                  label="Outlet"
                  value={pin.outlet}
                  options={outlets.map((outlet) => ({ value: outlet, label: outlet }))}
                  onChange={(outlet) => replace(index, { ...pin, outlet })}
                />
                {node.kind === "human" && node.form.kind === "edit" && pin.outlet === "approved" ? (
                  <JsonField
                    label={`Edited ${node.form.edit} (optional)`}
                    value={pin.outputs ?? {}}
                    rows={4}
                    hint="Leave {} to forward the value unedited."
                    validate={(value) =>
                      typeof value === "object" && value !== null && !Array.isArray(value)
                        ? null
                        : "An object of values by input name"
                    }
                    onCommit={(value) => {
                      const outputs = value as Record<string, unknown>;
                      replace(
                        index,
                        Object.keys(outputs).length > 0
                          ? { outlet: pin.outlet, outputs }
                          : { outlet: pin.outlet },
                        `edit-${index}`,
                      );
                    }}
                  />
                ) : null}
              </>
            ) : null}
            {typeof pin !== "string" && "outputs" in pin && !("outlet" in pin) ? (
              <JsonField
                label="Outputs by port"
                value={pin.outputs}
                rows={8}
                hint="Ports left out take the example; null leaves an optional port unproduced."
                validate={(value) =>
                  typeof value === "object" && value !== null && !Array.isArray(value)
                    ? null
                    : "An object of values by output port"
                }
                onCommit={(value) =>
                  replace(index, { outputs: value as Record<string, unknown> }, `custom-${index}`)
                }
              />
            ) : null}
            {node.kind !== "human" && (pin === "example" || pin === "generated") ? (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">Preview</summary>
                <pre
                  className="mt-1 max-h-48 overflow-auto rounded bg-flow-canvas p-1.5 font-mono text-[10px] leading-4"
                  data-graph-mock-preview={pin}
                >
                  {preview(graphMockPreview(node, library, pin))}
                </pre>
              </details>
            ) : null}
            {entryIssues.map((issue, at) => (
              <p
                key={`${issue.code}:${at}`}
                role="alert"
                className="text-[11px] text-failure"
                data-graph-mock-pin-issue={issue.code}
              >
                {issue.message}
              </p>
            ))}
          </EntryCard>
        );
      })}
    </FormSection>
  );
}
