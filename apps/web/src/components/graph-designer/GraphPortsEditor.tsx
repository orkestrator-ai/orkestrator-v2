import { useMemo } from "react";
import { GRAPH_DEFAULT_COLLECT_POLICY } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_TEMPLATE_BOUNDS,
  isGraphKey,
  parseGraphTypeRef,
} from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_COLLECT_WAITS,
  GRAPH_PROVENANCE_MODES,
  GRAPH_RENDER_MODES,
  isGraphRunInputRef,
  type GraphCollectPolicy,
  type GraphCollectWait,
  type GraphEdgeSource,
  type GraphInputPortSpec,
  type GraphNodeSpec,
  type GraphOutputPortSpec,
  type GraphProvenanceMode,
  type GraphRenderMode,
} from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import {
  addGraphInputPort,
  graphLoopOf,
  removeGraphInputPort,
  removeGraphOutputPort,
  renameGraphInputPort,
  renameGraphOutputPort,
  uniqueGraphKey,
  updateGraphNode,
} from "./graph-designer-edits";
import { useGraphEditor } from "./graph-editor-context";
import {
  AddButton,
  CheckboxField,
  CommitField,
  EntryCard,
  FormSection,
  NumberField,
  RemoveButton,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * Port forms (report §7.2 "Inputs/Outputs"): names, types from the template's
 * type library (built-in and custom), render modes, collect policies on list
 * inputs, `firstIterationFrom` inside loops, and provenance and choices on
 * outputs. Renaming a port rewrites the edges, carries and conditions that
 * name it; removing one drops its edges.
 */

const RENDER_LABELS: Readonly<Record<GraphRenderMode, string>> = {
  "json-frame": "JSON frame",
  markdown: "Markdown",
  summary: "Summary",
  file: "File in the workspace",
  "on-demand": "On demand (read tool)",
};

const WAIT_LABELS: Readonly<Record<GraphCollectWait, string>> = {
  "all-settled": "All settled",
  quorum: "Quorum",
  first: "First to succeed",
};

/** A type reference picker: a library type and how many list levels wrap it. */
export function TypeRefField({
  label,
  value,
  library,
  onChange,
  allowList = true,
}: {
  label: string;
  value: string;
  library: GraphTypeLibrary;
  onChange: (ref: string) => void;
  allowList?: boolean;
}) {
  const parts = parseGraphTypeRef(value);
  const base = parts ? `${parts.name}@${parts.version}` : value;
  const depth = parts?.listDepth ?? 0;
  const options = useMemo(
    () =>
      library.definitions().map((definition) => ({
        value: definition.ref,
        label: definition.builtIn ? definition.ref : `${definition.ref} (custom)`,
      })),
    [library],
  );
  const wrap = (ref: string, levels: number) => {
    let next = ref;
    for (let level = 0; level < levels; level++) next = `list<${next}>`;
    return next;
  };
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-1.5">
      <SelectField
        label={label}
        value={base}
        options={options}
        onChange={(ref) => onChange(wrap(ref, depth))}
      />
      {allowList ? (
        <SelectField
          label="Shape"
          value={String(depth)}
          options={[
            { value: "0", label: "One" },
            { value: "1", label: "List" },
            { value: "2", label: "List of lists" },
          ]}
          onChange={(levels) => onChange(wrap(base, Number(levels)))}
        />
      ) : null}
    </div>
  );
}

function sourceKey(source: GraphEdgeSource): string {
  if (isGraphRunInputRef(source)) return `input:${source.input}`;
  return `${source.node}:${source.outlet ?? ""}:${source.port}`;
}

function sourceLabel(source: GraphEdgeSource): string {
  if (isGraphRunInputRef(source)) return `run input ${source.input}`;
  return source.outlet
    ? `${source.node} → ${source.outlet} (${source.port})`
    : `${source.node}.${source.port}`;
}

function CollectFields({
  policy,
  onChange,
}: {
  policy: GraphCollectPolicy | undefined;
  onChange: (policy: GraphCollectPolicy | undefined) => void;
}) {
  const current = policy ?? GRAPH_DEFAULT_COLLECT_POLICY;
  return (
    <div className="flex flex-col gap-1.5 rounded border border-border/50 p-1.5">
      <CheckboxField
        label="Custom collect policy"
        checked={policy !== undefined}
        hint={
          policy
            ? undefined
            : "Default: wait for every branch, at least one must succeed, failures passed on."
        }
        onChange={(checked) => onChange(checked ? { ...GRAPH_DEFAULT_COLLECT_POLICY } : undefined)}
      />
      {policy ? (
        <div className="grid grid-cols-2 gap-1.5">
          <SelectField
            label="Wait for"
            value={current.wait}
            options={GRAPH_COLLECT_WAITS.map((wait) => ({ value: wait, label: WAIT_LABELS[wait] }))}
            onChange={(wait) => {
              const next: GraphCollectPolicy = { ...current, wait: wait as GraphCollectWait };
              if (wait === "all-settled") delete next.count;
              else if (next.count === undefined) next.count = 1;
              onChange(next);
            }}
          />
          {current.wait !== "all-settled" ? (
            <NumberField
              label="Count"
              value={current.count}
              min={1}
              max={GRAPH_TEMPLATE_BOUNDS.maxBranches}
              optional={current.wait === "first"}
              onCommit={(count) => {
                const next = { ...current };
                if (count === undefined) delete next.count;
                else next.count = count;
                onChange(next);
              }}
            />
          ) : null}
          <NumberField
            label="At least succeed"
            value={current.minSuccessful}
            min={0}
            max={GRAPH_TEMPLATE_BOUNDS.maxBranches}
            onCommit={(minSuccessful) =>
              onChange({ ...current, minSuccessful: minSuccessful ?? 1 })
            }
          />
          <CheckboxField
            label="Pass failures on"
            checked={current.includeFailures}
            onChange={(includeFailures) => onChange({ ...current, includeFailures })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function GraphInputsEditor({
  node,
  title = "Inputs",
}: {
  node: GraphNodeSpec;
  title?: string;
}) {
  const { template, library, edit } = useGraphEditor();
  const inputs = node.inputs ?? [];
  const loop = graphLoopOf(template, node.id);
  const patchPort = (
    name: string,
    label: string,
    patch: (port: GraphInputPortSpec) => GraphInputPortSpec,
    field?: string,
  ) =>
    edit(
      label,
      (current) =>
        updateGraphNode(
          current,
          node.id,
          (target) =>
            ({
              ...target,
              inputs: (target.inputs ?? []).map((port) =>
                port.name === name ? patch(port) : port,
              ),
            }) as GraphNodeSpec,
        ),
      field ? { coalesce: `port:${node.id}:in:${name}:${field}` } : {},
    );
  return (
    <FormSection
      title={title}
      actions={
        <AddButton
          label="Add input"
          disabled={inputs.length >= GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection}
          onClick={() =>
            edit(
              `Add an input to ${node.id}`,
              (current) =>
                addGraphInputPort(current, node.id, { name: "input", type: "markdown@1" }).template,
            )
          }
        />
      }
    >
      {inputs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No inputs. Add one here, or drop a connection on the node's “+ input”.
        </p>
      ) : null}
      {inputs.map((port) => {
        const isList = (parseGraphTypeRef(port.type)?.listDepth ?? 0) > 0;
        const producers = template.edges.filter(
          (edge) => edge.to.node === node.id && edge.to.port === port.name,
        );
        return (
          <EntryCard key={port.name}>
            <div data-graph-port-editor={`in:${port.name}`} className="flex items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <CommitField
                  label="Name"
                  value={port.name}
                  validate={(name) =>
                    !isGraphKey(name)
                      ? "Letters, digits and _; start with a lower-case letter"
                      : inputs.some((other) => other.name === name)
                        ? "Another input has this name"
                        : null
                  }
                  onCommit={(name) =>
                    edit(`Rename input ${port.name}`, (current) =>
                      renameGraphInputPort(current, node.id, port.name, name),
                    )
                  }
                />
              </div>
              <RemoveButton
                label={`Remove input ${port.name}`}
                onClick={() =>
                  edit(`Remove input ${port.name}`, (current) =>
                    removeGraphInputPort(current, node.id, port.name),
                  )
                }
              />
            </div>
            <TypeRefField
              label="Type"
              value={port.type}
              library={library}
              onChange={(type) =>
                patchPort(port.name, `Change ${port.name}'s type`, (current) => {
                  const next = { ...current, type };
                  if ((parseGraphTypeRef(type)?.listDepth ?? 0) === 0) delete next.collect;
                  return next;
                })
              }
            />
            <div className="grid grid-cols-2 gap-1.5">
              <SelectField
                label="Render as"
                value={port.render ?? ""}
                options={[
                  { value: "", label: "Type default" },
                  ...GRAPH_RENDER_MODES.map((mode) => ({
                    value: mode,
                    label: RENDER_LABELS[mode],
                  })),
                ]}
                onChange={(render) =>
                  patchPort(port.name, `Render ${port.name}`, (current) => {
                    const next = { ...current };
                    if (render) next.render = render as GraphRenderMode;
                    else delete next.render;
                    return next;
                  })
                }
              />
              <div className="flex items-end pb-1">
                <CheckboxField
                  label="Required"
                  checked={port.required !== false}
                  onChange={(required) =>
                    patchPort(
                      port.name,
                      `Make ${port.name} ${required ? "required" : "optional"}`,
                      (current) => {
                        const next = { ...current };
                        if (required) delete next.required;
                        else next.required = false;
                        return next;
                      },
                    )
                  }
                />
              </div>
            </div>
            {isList ? (
              <CollectFields
                policy={port.collect}
                onChange={(collect) =>
                  patchPort(port.name, `Collect policy of ${port.name}`, (current) => {
                    const next = { ...current };
                    if (collect) next.collect = collect;
                    else delete next.collect;
                    return next;
                  })
                }
              />
            ) : null}
            {loop && !isList && producers.length > 0 ? (
              <SelectField
                label="Iteration 1 reads from"
                value={port.firstIterationFrom ? sourceKey(port.firstIterationFrom) : ""}
                hint="Inside a loop: the first iteration reads this producer, later ones the other (report §9.2)."
                options={[
                  { value: "", label: "Every iteration reads the same producer" },
                  ...producers.map((edge) => ({
                    value: sourceKey(edge.from),
                    label: sourceLabel(edge.from),
                  })),
                ]}
                onChange={(key) =>
                  patchPort(port.name, `First iteration of ${port.name}`, (current) => {
                    const next = { ...current };
                    const chosen = producers.find((edge) => sourceKey(edge.from) === key);
                    if (chosen) next.firstIterationFrom = chosen.from;
                    else delete next.firstIterationFrom;
                    return next;
                  })
                }
              />
            ) : null}
            <TextField
              label="Label"
              value={port.label ?? ""}
              onChange={(label) =>
                patchPort(
                  port.name,
                  `Label ${port.name}`,
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
          </EntryCard>
        );
      })}
    </FormSection>
  );
}

function isDecision(type: string): boolean {
  const parts = parseGraphTypeRef(type);
  return parts?.name === "decision" && parts.listDepth === 0;
}

export function GraphOutputsEditor({ node }: { node: GraphNodeSpec }) {
  const { library, edit } = useGraphEditor();
  // Gates and human nodes route through outlets instead.
  if (node.kind === "gate" || node.kind === "human") return null;
  const outputs: GraphOutputPortSpec[] = node.outputs ?? [];
  const patchPort = (
    name: string,
    label: string,
    patch: (port: GraphOutputPortSpec) => GraphOutputPortSpec,
    field?: string,
  ) =>
    edit(
      label,
      (current) =>
        updateGraphNode(current, node.id, (target) =>
          target.kind === "gate" || target.kind === "human"
            ? target
            : ({
                ...target,
                outputs: (target.outputs ?? []).map((port) =>
                  port.name === name ? patch(port) : port,
                ),
              } as GraphNodeSpec),
        ),
      field ? { coalesce: `port:${node.id}:out:${name}:${field}` } : {},
    );
  return (
    <FormSection
      title="Outputs"
      actions={
        <AddButton
          label="Add output"
          disabled={outputs.length >= GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection}
          onClick={() =>
            edit(`Add an output to ${node.id}`, (current) =>
              updateGraphNode(current, node.id, (target) => {
                if (target.kind === "gate" || target.kind === "human") return target;
                const list = target.outputs ?? [];
                const name = uniqueGraphKey(
                  "output",
                  list.map((port) => port.name),
                );
                return {
                  ...target,
                  outputs: [...list, { name, type: "markdown@1" }],
                } as GraphNodeSpec;
              }),
            )
          }
        />
      }
    >
      {outputs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No outputs.</p>
      ) : null}
      {outputs.map((port) => (
        <EntryCard key={port.name}>
          <div data-graph-port-editor={`out:${port.name}`} className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <CommitField
                label="Name"
                value={port.name}
                hint={
                  node.kind === "agent"
                    ? `The agent submits it with submit_${port.name}.`
                    : undefined
                }
                validate={(name) =>
                  !isGraphKey(name)
                    ? "Letters, digits and _; start with a lower-case letter"
                    : outputs.some((other) => other.name === name)
                      ? "Another output has this name"
                      : null
                }
                onCommit={(name) =>
                  edit(`Rename output ${port.name}`, (current) =>
                    renameGraphOutputPort(current, node.id, port.name, name),
                  )
                }
              />
            </div>
            <RemoveButton
              label={`Remove output ${port.name}`}
              onClick={() =>
                edit(`Remove output ${port.name}`, (current) =>
                  removeGraphOutputPort(current, node.id, port.name),
                )
              }
            />
          </div>
          <TypeRefField
            label="Type"
            value={port.type}
            library={library}
            onChange={(type) =>
              patchPort(port.name, `Change ${port.name}'s type`, (current) => {
                const next = { ...current, type };
                if (!isDecision(type)) delete next.choices;
                return next;
              })
            }
          />
          <div className="grid grid-cols-2 gap-1.5">
            <SelectField
              label="Provenance"
              value={port.provenance ?? ""}
              hint="A consolidating node cites its sources (report §5.9)."
              options={[
                { value: "", label: "None" },
                ...GRAPH_PROVENANCE_MODES.map((mode) => ({
                  value: mode,
                  label: mode === "cite" ? "Cite sources" : "Account for every source",
                })),
              ]}
              onChange={(provenance) =>
                patchPort(port.name, `Provenance of ${port.name}`, (current) => {
                  const next = { ...current };
                  if (provenance) next.provenance = provenance as GraphProvenanceMode;
                  else delete next.provenance;
                  return next;
                })
              }
            />
            <div className="flex items-end pb-1">
              <CheckboxField
                label="Required"
                checked={port.required !== false}
                onChange={(required) =>
                  patchPort(
                    port.name,
                    `Make ${port.name} ${required ? "required" : "optional"}`,
                    (current) => {
                      const next = { ...current };
                      if (required) delete next.required;
                      else next.required = false;
                      return next;
                    },
                  )
                }
              />
            </div>
          </div>
          {isDecision(port.type) ? (
            <CommitField
              label="Choices"
              value={(port.choices ?? []).join(", ")}
              mono={false}
              hint="The decision's choice must be one of these (for example the lens keys being judged)."
              validate={(text) => {
                const values = text
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean);
                if (values.length > 0 && values.length < 2)
                  return "List at least two choices, or none";
                return values.every((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
                  ? null
                  : "Choices are letters, digits, _, . and -";
              }}
              onCommit={(text) =>
                patchPort(port.name, `Choices of ${port.name}`, (current) => {
                  const values = text
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                  const next = { ...current };
                  if (values.length > 0) next.choices = values;
                  else delete next.choices;
                  return next;
                })
              }
            />
          ) : null}
          <TextField
            label="Description (shown to the model)"
            value={port.description ?? ""}
            multiline
            rows={2}
            onChange={(description) =>
              patchPort(
                port.name,
                `Describe ${port.name}`,
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
        </EntryCard>
      ))}
    </FormSection>
  );
}
