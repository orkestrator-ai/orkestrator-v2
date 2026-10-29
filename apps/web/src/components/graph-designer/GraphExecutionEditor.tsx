import { useMemo } from "react";
import { GRAPH_TEMPLATE_BOUNDS, isGraphId } from "@orkestrator/protocol/graphs/grammar";
import type {
  GraphAgentNode,
  GraphLens,
  GraphReplicate,
  GraphSessionSpec,
} from "@orkestrator/protocol/graphs/template";
import { resolveReviewLensPresets } from "@orkestrator/protocol/review-lens";
import { useConfigStore } from "@/stores/configStore";
import { GraphNodeExecutionFields } from "./GraphKindEditors";
import { GraphPredicateEditor } from "./GraphPredicateEditor";
import { graphIdFrom, uniqueGraphId } from "./graph-designer-edits";
import { graphNodePredicateScopeFor } from "./graph-designer-scopes";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import {
  AddButton,
  CheckboxField,
  CommitField,
  EntryCard,
  FormSection,
  JsonField,
  NumberField,
  RemoveButton,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * The execution form of an agent node (report §7.2 "Execution"): its role
 * (the model slot chosen at launch), replication (D9: over a panel, lenses
 * or samples; the node draws as a stacked "×N" card and its outputs become
 * lists), retry, timeout, failure policy, session mode, the `ask_human` opt-in
 * (D15) and the condition it runs under.
 */

type ReplicateMode = "none" | "panel" | "lenses" | "samples" | "items" | "cross";

const MODE_LABELS: Readonly<Record<ReplicateMode, string>> = {
  none: "Not replicated",
  panel: "Over a panel of models",
  lenses: "Over lenses",
  samples: "Samples of one model",
  items: "Over list items (Phase 4)",
  cross: "Combined (JSON)",
};

function freshLens(taken: readonly GraphLens[], label = "Focus", instruction = ""): GraphLens {
  return {
    key: uniqueGraphId(
      graphIdFrom(label, "lens"),
      taken.map((lens) => lens.key),
    ),
    label: label.slice(0, GRAPH_TEMPLATE_BOUNDS.maxLensLabelChars),
    instruction: instruction || "Describe what this branch should focus on.",
  };
}

function LensesEditor({ node }: { node: GraphAgentNode & { replicate: { over: "lenses" } } }) {
  const { template } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const stored = useConfigStore((state) => state.config.global.reviewLensPresets);
  const presets = useMemo(() => resolveReviewLensPresets(stored), [stored]);
  const lenses = node.replicate.lenses;
  const setLenses = (label: string, next: GraphLens[], field?: string) =>
    editNode<GraphAgentNode>(
      label,
      (current) => ({ ...current, replicate: { over: "lenses", lenses: next } }),
      field,
    );
  const patch = (index: number, change: Partial<GraphLens>, label: string, field?: string) =>
    setLenses(
      label,
      lenses.map((lens, position) => (position === index ? { ...lens, ...change } : lens)),
      field ? `lens:${index}:${field}` : undefined,
    );
  const full = lenses.length >= GRAPH_TEMPLATE_BOUNDS.maxBranches;
  return (
    <div className="flex flex-col gap-1.5" data-graph-lens-editor="">
      {lenses.map((lens, index) => (
        <EntryCard key={`${lens.key}:${index}`}>
          <div className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <CommitField
                label="Key"
                value={lens.key}
                hint="Branch keys and a judge's choices use it."
                validate={(key) =>
                  !isGraphId(key)
                    ? "Lower-case letters, digits and single dashes"
                    : lenses.some((other, position) => position !== index && other.key === key)
                      ? "Another lens has this key"
                      : null
                }
                onCommit={(key) => patch(index, { key }, `Lens key ${key}`)}
              />
            </div>
            <RemoveButton
              label={`Remove lens ${lens.label}`}
              onClick={() =>
                setLenses(
                  `Remove lens ${lens.key}`,
                  lenses.filter((_, position) => position !== index),
                )
              }
            />
          </div>
          <TextField
            label="Label"
            value={lens.label}
            onChange={(label) =>
              patch(
                index,
                { label: label.slice(0, GRAPH_TEMPLATE_BOUNDS.maxLensLabelChars) },
                "Lens label",
                "label",
              )
            }
          />
          <TextField
            label="Instruction"
            value={lens.instruction}
            multiline
            rows={2}
            onChange={(instruction) =>
              patch(index, { instruction }, "Lens instruction", "instruction")
            }
          />
          <SelectField
            label="Role"
            value={lens.role ?? ""}
            options={[
              { value: "", label: `The node's role (${node.role})` },
              ...template.roles.map((role) => ({ value: role.key, label: role.label ?? role.key })),
            ]}
            onChange={(role) => {
              const next = { ...lens };
              if (role) next.role = role;
              else delete next.role;
              setLenses(
                "Lens role",
                lenses.map((entry, position) => (position === index ? next : entry)),
              );
            }}
          />
        </EntryCard>
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <AddButton
          label="Add lens"
          disabled={full}
          onClick={() => setLenses("Add a lens", [...lenses, freshLens(lenses)])}
        />
        {presets.length > 0 ? (
          <select
            aria-label="Add a preset lens"
            value=""
            disabled={full}
            onChange={(event) => {
              const preset = presets.find((entry) => entry.id === event.target.value);
              if (preset) {
                setLenses(`Add lens ${preset.label}`, [
                  ...lenses,
                  freshLens(lenses, preset.label, preset.instruction),
                ]);
              }
            }}
            className="h-6 rounded border border-border/70 bg-input-surface px-1 text-[11px]"
          >
            <option value="">Add a preset…</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

function replicateMode(replicate: GraphReplicate | undefined): ReplicateMode {
  if (!replicate) return "none";
  return replicate.over;
}

export function GraphReplicateEditor({ node }: { node: GraphAgentNode }) {
  const { template } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const mode = replicateMode(node.replicate);
  const panelRoles = template.roles.filter((role) => role.multiplicity === "panel");
  const setReplicate = (label: string, replicate: GraphReplicate | undefined) =>
    editNode<GraphAgentNode>(label, (current) => {
      const next = { ...current };
      if (replicate) next.replicate = replicate;
      else delete next.replicate;
      return next;
    });
  return (
    <FormSection title="Replicate">
      <SelectField
        label="Run as"
        value={mode}
        hint="A replicated node draws as a stack; its outputs reach consumers as lists (D9)."
        options={(Object.keys(MODE_LABELS) as ReplicateMode[]).map((value) => ({
          value,
          label: MODE_LABELS[value],
          // `items` fan-out is item 401; a combined fan-out is edited as JSON.
          disabled: value === "items" || (value === "cross" && mode !== "cross"),
        }))}
        onChange={(value) => {
          switch (value as ReplicateMode) {
            case "none":
              setReplicate("Stop replicating", undefined);
              break;
            case "panel":
              setReplicate("Replicate over a panel", {
                over: "panel",
                role: panelRoles[0]?.key ?? node.role,
              });
              break;
            case "lenses":
              setReplicate("Replicate over lenses", { over: "lenses", lenses: [freshLens([])] });
              break;
            case "samples":
              setReplicate("Replicate as samples", { over: "samples", count: 3 });
              break;
            default:
              break;
          }
        }}
      />
      {node.replicate?.over === "panel" ? (
        <SelectField
          label="Panel role"
          value={node.replicate.role}
          hint={
            panelRoles.length === 0
              ? "No role is a panel yet: make one a panel in the template's roles."
              : "One branch per model the launcher picks for this role."
          }
          options={panelRoles.map((role) => ({ value: role.key, label: role.label ?? role.key }))}
          onChange={(role) => setReplicate(`Panel role ${role}`, { over: "panel", role })}
        />
      ) : null}
      {node.replicate?.over === "lenses" ? (
        <LensesEditor node={node as GraphAgentNode & { replicate: { over: "lenses" } }} />
      ) : null}
      {node.replicate?.over === "samples" ? (
        <NumberField
          label="Samples"
          value={node.replicate.count}
          min={1}
          max={GRAPH_TEMPLATE_BOUNDS.maxBranches}
          onCommit={(count) =>
            setReplicate(`Samples ${count}`, { over: "samples", count: count ?? 1 })
          }
        />
      ) : null}
      {node.replicate?.over === "cross" || node.replicate?.over === "items" ? (
        <JsonField
          label="Replicate as JSON"
          value={node.replicate}
          onCommit={(value) => setReplicate("Edit replicate JSON", value as GraphReplicate)}
        />
      ) : null}
    </FormSection>
  );
}

export function GraphExecutionEditor({ node }: { node: GraphAgentNode }) {
  const { template, library, plan, edit } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const role = template.roles.find((candidate) => candidate.key === node.role);
  const others = template.nodes.filter(
    (candidate) => candidate.kind === "agent" && candidate.id !== node.id,
  );
  const scope = useMemo(
    () => graphNodePredicateScopeFor(template, library, node, plan),
    [template, library, node, plan],
  );
  const session: GraphSessionSpec = node.session ?? { mode: "fresh" };
  return (
    <div className="flex flex-col gap-3" data-graph-execution-editor="">
      <FormSection title="Role">
        <SelectField
          label="Role (model slot)"
          value={node.role}
          hint={
            role
              ? `${role.multiplicity === "panel" ? "A panel" : "One model"}, chosen when the graph is launched.`
              : "This role is not declared."
          }
          options={[
            ...template.roles.map((entry) => ({
              value: entry.key,
              label: `${entry.label ?? entry.key} (${entry.multiplicity})`,
            })),
            { value: "+new", label: "New role…" },
          ]}
          onChange={(value) => {
            if (value === "+new") {
              edit(`New role for ${node.id}`, (current) => {
                const key = uniqueGraphId(
                  node.id,
                  current.roles.map((entry) => entry.key),
                );
                return {
                  ...current,
                  roles: [...current.roles, { key, multiplicity: "one" }],
                  nodes: current.nodes.map((entry) =>
                    entry.id === node.id && entry.kind === "agent"
                      ? { ...entry, role: key }
                      : entry,
                  ),
                };
              });
            } else {
              editNode<GraphAgentNode>(`Role ${value}`, (current) => ({ ...current, role: value }));
            }
          }}
        />
      </FormSection>
      <GraphReplicateEditor node={node} />
      <FormSection title="Session">
        <SelectField
          label="Session"
          value={session.mode === "continue" ? `continue:${session.from}` : "fresh"}
          hint="Continuing another node's session keeps its agent, model and context."
          options={[
            { value: "fresh", label: "A fresh session" },
            ...others.map((other) => ({
              value: `continue:${other.id}`,
              label: `Continue ${other.id}`,
            })),
          ]}
          onChange={(value) =>
            editNode<GraphAgentNode>("Session", (current) => {
              const next = { ...current };
              if (value === "fresh") delete next.session;
              else next.session = { mode: "continue", from: value.slice("continue:".length) };
              return next;
            })
          }
        />
        <CheckboxField
          label="May ask a person (ask_human)"
          checked={node.askHuman === true}
          hint="Off: the node runs unattended. On: it may pause the run until someone answers (D15)."
          onChange={(askHuman) =>
            editNode<GraphAgentNode>(askHuman ? "Allow ask_human" : "Run unattended", (current) => {
              const next = { ...current };
              if (askHuman) next.askHuman = true;
              else delete next.askHuman;
              return next;
            })
          }
        />
      </FormSection>
      <GraphNodeExecutionFields node={node} />
      <FormSection title="Runs when">
        <GraphPredicateEditor
          label="Condition"
          value={node.when}
          scope={scope}
          optional
          onChange={(when) =>
            editNode<GraphAgentNode>(when ? "Edit condition" : "Remove condition", (current) => {
              const next = { ...current };
              if (when) next.when = when;
              else delete next.when;
              return next;
            })
          }
        />
      </FormSection>
    </div>
  );
}
