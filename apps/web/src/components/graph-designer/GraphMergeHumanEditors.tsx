import { useMemo } from "react";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes } from "@orkestrator/protocol/graphs/grammar";
import { graphSchemaAtPath, graphSchemaNonNull } from "@orkestrator/protocol/graphs/schema-subset";
import {
  GRAPH_HUMAN_FORMS,
  GRAPH_MERGE_STRATEGIES,
  GRAPH_VOTE_TIE_POLICIES,
  type GraphHumanForm,
  type GraphHumanFormKind,
  type GraphHumanNode,
  type GraphMergeNode,
  type GraphMergeStrategy,
  type GraphMergeStrategyKind,
  type GraphVoteTiePolicy,
} from "@orkestrator/protocol/graphs/template";
import type { GraphValueType } from "@orkestrator/protocol/graphs/types";
import { cn } from "@/lib/utils";
import { GraphNodeExecutionFields, graphWithoutField } from "./GraphNodeExecutionFields";
import { defaultGraphDedupeKey } from "./graph-designer-connect";
import { uniqueGraphKey, updateGraphNode } from "./graph-designer-edits";
import {
  graphPredicatePathSuggestions,
  pruneGraphOutletReferences,
  graphOutletValidator,
  renameGraphOutlet,
} from "./graph-designer-scopes";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import {
  AddButton,
  CommitField,
  EntryCard,
  FIELD_CLASS,
  FormSection,
  RemoveButton,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * Editable forms for merge and human nodes (item 212). A merge's strategy
 * (D11: `dedupe` is the deterministic default fan-in merge) with its key or
 * score paths; a human node's form (approve, edit, choose), instructions and
 * options. Changing a form drops the edges that read outlets it no longer has.
 */

const B = GRAPH_TEMPLATE_BOUNDS;

// ---------------------------------------------------------------- merge

function elementOf(
  node: GraphMergeNode,
  resolve: (ref: string) => GraphValueType | null,
): GraphValueType | null {
  const ref = node.inputs?.[0]?.type;
  if (!ref) return null;
  const type = resolve(ref);
  return type?.kind === "list" ? type.element : type;
}

function schemaOf(type: GraphValueType | null): Record<string, unknown> | null {
  if (!type) return null;
  if (type.kind === "named") return type.definition.schema;
  if (type.kind === "shape") return type.schema;
  return null;
}

function itemSchemaOf(type: GraphValueType | null): Record<string, unknown> | null {
  if (type?.kind !== "named" || !type.definition.items) return null;
  const field = graphSchemaAtPath(type.definition.schema, type.definition.items.path);
  const items = field ? graphSchemaNonNull(field.schema).schema.items : undefined;
  return items && typeof items === "object" && !Array.isArray(items)
    ? (items as Record<string, unknown>)
    : null;
}

function fieldSuggestions(schema: Record<string, unknown> | null): string[] {
  if (!schema) return [];
  return graphPredicatePathSuggestions({ kind: "element", schema, label: "" }).map(
    (entry) => entry.path,
  );
}

function freshStrategy(
  kind: GraphMergeStrategyKind,
  element: GraphValueType | null,
): GraphMergeStrategy {
  switch (kind) {
    case "dedupe":
      return { kind, key: defaultGraphDedupeKey(element) };
    case "vote":
      return { kind, tie: "fail" };
    case "best": {
      const numeric = graphPredicatePathSuggestions({
        kind: "element",
        schema: schemaOf(element) ?? {},
        label: "",
      }).find((entry) => entry.type.startsWith("number") || entry.type.startsWith("integer"));
      return { kind, score: numeric?.path ?? "score" };
    }
    default:
      return { kind };
  }
}

const STRATEGY_HINTS: Readonly<Record<GraphMergeStrategyKind, string>> = {
  concat: "One value with every branch's items, source ids kept.",
  dedupe:
    "Items with the same key fold together, keeping every source id. The deterministic default for a fan-in (D11); add an agent consolidator node after it when model judgement is wanted.",
  vote: "The majority choice of the branches' decisions.",
  best: "The branch value with the best score.",
  collect: "The list unchanged.",
};

export function GraphMergeEditor({ node }: { node: GraphMergeNode }) {
  const { library } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const element = useMemo(
    () =>
      elementOf(node, (ref) => {
        const resolved = library.resolve(ref);
        return resolved.ok ? resolved.type : null;
      }),
    [node, library],
  );
  const strategy = node.strategy;
  const setStrategy = (label: string, next: GraphMergeStrategy, coalesce?: string) =>
    editNode<GraphMergeNode>(label, (current) => ({ ...current, strategy: next }), coalesce);
  const keySuggestions = fieldSuggestions(itemSchemaOf(element));
  const elementFields = fieldSuggestions(schemaOf(element));
  return (
    <div data-graph-merge-editor="" className="flex flex-col gap-3">
      <FormSection title="Merge">
        <SelectField
          label="Strategy"
          value={strategy.kind}
          options={GRAPH_MERGE_STRATEGIES.map((kind) => ({ value: kind, label: kind }))}
          hint={STRATEGY_HINTS[strategy.kind]}
          onChange={(value) =>
            setStrategy(
              "Change merge strategy",
              freshStrategy(value as GraphMergeStrategyKind, element),
            )
          }
        />
        <datalist id={`merge-fields-${node.id}`}>
          {(strategy.kind === "dedupe" ? keySuggestions : elementFields).map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
        {strategy.kind === "dedupe" ? (
          <div role="group" aria-label="Dedupe key" className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Key fields (of each item)</span>
            {strategy.key.map((path, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  aria-label={`Key field ${index + 1}`}
                  value={path}
                  list={`merge-fields-${node.id}`}
                  onChange={(event) =>
                    setStrategy(
                      "Edit dedupe key",
                      {
                        ...strategy,
                        key: strategy.key.map((entry, at) =>
                          at === index ? event.target.value : entry,
                        ),
                      },
                      `key:${index}`,
                    )
                  }
                  className={cn(FIELD_CLASS, "font-mono text-[11px]")}
                />
                {strategy.key.length > 1 ? (
                  <RemoveButton
                    label={`Remove key field ${path}`}
                    onClick={() =>
                      setStrategy("Remove dedupe key field", {
                        ...strategy,
                        key: strategy.key.filter((_, at) => at !== index),
                      })
                    }
                  />
                ) : null}
              </div>
            ))}
            <AddButton
              label="Key field"
              disabled={strategy.key.length >= B.maxMergeKeyPaths}
              onClick={() =>
                setStrategy("Add dedupe key field", {
                  ...strategy,
                  key: [
                    ...strategy.key,
                    keySuggestions.find((entry) => !strategy.key.includes(entry)) ?? "id",
                  ],
                })
              }
            />
          </div>
        ) : null}
        {strategy.kind === "vote" ? (
          <>
            <SelectField
              label="On a tie"
              value={strategy.tie}
              options={GRAPH_VOTE_TIE_POLICIES.map((tie) => ({
                value: tie,
                label: tie === "fail" ? "Fail the merge" : "Take the first",
              }))}
              onChange={(tie) =>
                setStrategy("Set tie policy", { ...strategy, tie: tie as GraphVoteTiePolicy })
              }
            />
            <TextField
              label="Choice field"
              mono
              value={strategy.path ?? ""}
              placeholder="choice"
              onChange={(path) =>
                setStrategy(
                  "Edit vote field",
                  path ? { ...strategy, path } : graphWithoutField(strategy, "path"),
                  "vote-path",
                )
              }
            />
          </>
        ) : null}
        {strategy.kind === "best" ? (
          <>
            <TextField
              label="Score field"
              mono
              value={strategy.score}
              onChange={(score) => setStrategy("Edit score field", { ...strategy, score }, "score")}
            />
            <SelectField
              label="Prefer"
              value={strategy.prefer ?? "highest"}
              options={[
                { value: "highest", label: "Highest score" },
                { value: "lowest", label: "Lowest score" },
              ]}
              onChange={(prefer) =>
                setStrategy(
                  "Set preference",
                  prefer === "lowest"
                    ? { ...strategy, prefer: "lowest" }
                    : graphWithoutField(strategy, "prefer"),
                )
              }
            />
          </>
        ) : null}
      </FormSection>
      <GraphNodeExecutionFields node={node} />
    </div>
  );
}

// ---------------------------------------------------------------- human

function freshForm(kind: GraphHumanFormKind, node: GraphHumanNode): GraphHumanForm {
  const instructions = node.form.instructions ? { instructions: node.form.instructions } : {};
  switch (kind) {
    case "approve":
      return { kind, ...instructions };
    case "edit":
      return { kind, edit: node.inputs?.[0]?.name ?? "value", ...instructions };
    case "choose":
      return {
        kind,
        options: [
          { to: "option1", label: "Option 1" },
          { to: "option2", label: "Option 2" },
        ],
        ...instructions,
      };
  }
}

const FORM_LABELS: Readonly<Record<GraphHumanFormKind, string>> = {
  approve: "Approve or reject",
  edit: "Edit an input, then approve",
  choose: "Choose one of several outlets",
};

export function GraphHumanEditor({ node }: { node: GraphHumanNode }) {
  const { edit } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const form = node.form;
  const setForm = (label: string, next: GraphHumanForm, coalesce?: string) =>
    edit(
      label,
      (current) =>
        pruneGraphOutletReferences(
          updateGraphNode(
            current,
            node.id,
            (entry) => ({ ...entry, form: next }) as GraphHumanNode,
          ),
          node.id,
        ),
      coalesce ? { coalesce: `node:${node.id}:${coalesce}` } : {},
    );
  return (
    <div data-graph-human-editor="" className="flex flex-col gap-3">
      <FormSection title="Human step">
        <SelectField
          label="Form"
          value={form.kind}
          options={GRAPH_HUMAN_FORMS.map((kind) => ({ value: kind, label: FORM_LABELS[kind] }))}
          hint={
            form.kind === "choose"
              ? "Each option takes its own outlet."
              : "Outlets: approved and rejected."
          }
          onChange={(kind) => setForm("Change form", freshForm(kind as GraphHumanFormKind, node))}
        />
        <TextField
          label="Instructions for the person"
          multiline
          value={form.instructions ?? ""}
          onChange={(text) => {
            if (graphUtf8Bytes(text) > B.maxHumanInstructionsBytes) return;
            setForm(
              "Edit instructions",
              text ? { ...form, instructions: text } : graphWithoutField(form, "instructions"),
              "instructions",
            );
          }}
        />
        {form.kind === "edit" ? (
          <SelectField
            label="Input the person may edit"
            value={form.edit}
            options={(node.inputs ?? []).map((port) => ({
              value: port.name,
              label: `${port.name} (${port.type})`,
            }))}
            hint="The approved outlet carries the edited value."
            onChange={(name) =>
              editNode<GraphHumanNode>("Choose edited input", (current) => ({
                ...current,
                form: { ...form, edit: name },
              }))
            }
          />
        ) : null}
      </FormSection>
      {form.kind === "choose" ? (
        <FormSection
          title="Options"
          actions={
            <AddButton
              label="Option"
              disabled={form.options.length >= B.maxChooseOptions}
              onClick={() => {
                const to = uniqueGraphKey(
                  "option",
                  form.options.map((option) => option.to),
                );
                setForm("Add option", { ...form, options: [...form.options, { to, label: to }] });
              }}
            />
          }
        >
          {form.options.map((option, index) => (
            <EntryCard key={`${index}:${option.to}`}>
              <div data-graph-human-option={option.to} className="flex items-end gap-1">
                <div className="min-w-0 flex-1">
                  <CommitField
                    label="Outlet"
                    value={option.to}
                    validate={graphOutletValidator(node, option.to)}
                    onCommit={(to) =>
                      edit(`Rename outlet ${option.to}`, (current) =>
                        renameGraphOutlet(current, node.id, option.to, to),
                      )
                    }
                  />
                </div>
                {form.options.length > 2 ? (
                  <RemoveButton
                    label={`Remove option ${option.to}`}
                    onClick={() =>
                      setForm(`Remove option ${option.to}`, {
                        ...form,
                        options: form.options.filter((_, at) => at !== index),
                      })
                    }
                  />
                ) : null}
              </div>
              <TextField
                label="Label"
                value={option.label}
                onChange={(label) =>
                  setForm(
                    "Edit option label",
                    {
                      ...form,
                      options: form.options.map((entry, at) =>
                        at === index ? { ...entry, label } : entry,
                      ),
                    },
                    `option:${index}:label`,
                  )
                }
              />
              <TextField
                label="Description"
                value={option.description ?? ""}
                onChange={(description) =>
                  setForm(
                    "Edit option description",
                    {
                      ...form,
                      options: form.options.map((entry, at) =>
                        at === index
                          ? description
                            ? { ...entry, description }
                            : graphWithoutField(entry, "description")
                          : entry,
                      ),
                    },
                    `option:${index}:description`,
                  )
                }
              />
            </EntryCard>
          ))}
        </FormSection>
      ) : null}
      <GraphNodeExecutionFields node={node} />
    </div>
  );
}
