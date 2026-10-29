import { useMemo } from "react";
import {
  GRAPH_TEMPLATE_BOUNDS as B,
  isGraphId,
  isGraphKey,
} from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_PARAMETER_TYPES,
  GRAPH_ROLE_DEFAULT_ACTION_KEYS,
  GRAPH_ROLE_MULTIPLICITIES,
  type GraphNodeSpec,
  type GraphParameter,
  type GraphParameterType,
  type GraphRole,
  type GraphRoleDefaultSource,
  type GraphRoleMultiplicity,
  type GraphRunOutputSpec,
  type GraphTemplateV1,
  type GraphWorkspaceSpec,
} from "@orkestrator/protocol/graphs/template";
import { GraphTypesEditor } from "./GraphTypeEditor";
import { TypeRefField } from "./GraphPortsEditor";
import {
  mapGraphPredicatePaths,
  removeGraphAcknowledgements,
  removeGraphRunInput,
  removeGraphRunOutput,
  renameGraphRunInput,
  uniqueGraphId,
  uniqueGraphKey,
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
 * The template-level form (item 212), shown when nothing is selected: name,
 * description, the run's workspace and limits, launch parameters, roles (the
 * model slots chosen at launch, with the saved defaults they start from),
 * run inputs and outputs, custom types, and the acknowledgements on record.
 */

const ROLE_DEFAULT_LABELS: Readonly<Record<GraphRoleDefaultSource, string>> = {
  review: "Review",
  review2: "Second review",
  reviewPreparation: "Review preparation",
  fixReviewIssues: "Fix review issues",
  verify: "Verify",
  pr: "Pull request",
  resolve: "Resolve conflicts",
  additionalReviewers: "Additional reviewers (panel)",
};

function renameParamPaths(template: GraphTemplateV1, from: string, to: string): GraphTemplateV1 {
  const rename = (path: string) =>
    path === `params.${from}` || path.startsWith(`params.${from}.`)
      ? `params.${to}${path.slice(`params.${from}`.length)}`
      : path;
  return {
    ...template,
    nodes: template.nodes.map((node) => {
      let next: GraphNodeSpec = node.when
        ? { ...node, when: mapGraphPredicatePaths(node.when, rename) }
        : node;
      if (next.kind === "gate") {
        next = {
          ...next,
          branches: next.branches.map((branch) => ({
            ...branch,
            when: mapGraphPredicatePaths(branch.when, rename),
          })),
        };
      }
      return next;
    }),
    ...(template.loops
      ? {
          loops: template.loops.map((loop) => ({
            ...loop,
            until: mapGraphPredicatePaths(loop.until, rename),
          })),
        }
      : {}),
  };
}

function renameRole(template: GraphTemplateV1, from: string, to: string): GraphTemplateV1 {
  return {
    ...template,
    roles: template.roles.map((role) => (role.key === from ? { ...role, key: to } : role)),
    nodes: template.nodes.map((node) => {
      if (node.kind !== "agent") return node;
      let next = node.role === from ? { ...node, role: to } : node;
      const replicate = next.replicate;
      if (replicate?.over === "panel" && replicate.role === from)
        next = { ...next, replicate: { ...replicate, role: to } };
      if (replicate?.over === "lenses" && replicate.lenses.some((lens) => lens.role === from)) {
        next = {
          ...next,
          replicate: {
            ...replicate,
            lenses: replicate.lenses.map((lens) =>
              lens.role === from ? { ...lens, role: to } : lens,
            ),
          },
        };
      }
      return next;
    }),
  };
}

function freshParameter(
  type: GraphParameterType,
  key: string,
  base: Partial<GraphParameter> = {},
): GraphParameter {
  const common = {
    key,
    ...(base.label ? { label: base.label } : {}),
    ...(base.description ? { description: base.description } : {}),
  };
  switch (type) {
    case "boolean":
      return { ...common, type, default: false };
    case "integer":
    case "number":
      return { ...common, type, default: 1 };
    case "string":
      return { ...common, type, default: "" };
    case "enum":
      return { ...common, type, options: ["a", "b"], default: "a" };
  }
}

function ParameterDefault({
  parameter,
  onChange,
}: {
  parameter: GraphParameter;
  onChange: (next: GraphParameter) => void;
}) {
  switch (parameter.type) {
    case "boolean":
      return (
        <SelectField
          label="Default"
          value={parameter.default === undefined ? "" : String(parameter.default)}
          options={[
            { value: "", label: "Ask at launch" },
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]}
          onChange={(value) => {
            const next = { ...parameter };
            if (value === "") delete next.default;
            else next.default = value === "true";
            onChange(next);
          }}
        />
      );
    case "integer":
    case "number":
      return (
        <div className="grid grid-cols-3 gap-1.5">
          {(["default", "min", "max"] as const).map((field) => (
            <NumberField
              key={field}
              label={field === "default" ? "Default" : field === "min" ? "Min" : "Max"}
              value={parameter[field]}
              integer={parameter.type === "integer"}
              optional
              onCommit={(value) => {
                const next = { ...parameter };
                if (value === undefined) delete next[field];
                else next[field] = value;
                onChange(next);
              }}
            />
          ))}
        </div>
      );
    case "string":
      return (
        <TextField
          label="Default"
          value={parameter.default ?? ""}
          onChange={(value) => onChange({ ...parameter, default: value })}
        />
      );
    case "enum":
      return (
        <div className="grid grid-cols-2 gap-1.5">
          <CommitField
            label="Options"
            mono={false}
            value={parameter.options.join(", ")}
            validate={(text) =>
              text
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean).length === 0
                ? "List at least one option"
                : null
            }
            onCommit={(text) => {
              const options = text
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
              const next = { ...parameter, options };
              if (next.default !== undefined && !options.includes(next.default))
                delete next.default;
              onChange(next);
            }}
          />
          <SelectField
            label="Default"
            value={parameter.default ?? ""}
            options={[
              { value: "", label: "Ask at launch" },
              ...parameter.options.map((option) => ({ value: option, label: option })),
            ]}
            onChange={(value) => {
              const next = { ...parameter };
              if (value) next.default = value;
              else delete next.default;
              onChange(next);
            }}
          />
        </div>
      );
  }
}

function outputSources(template: GraphTemplateV1) {
  return template.nodes.flatMap((node) =>
    node.kind !== "gate" && node.kind !== "human"
      ? (node.outputs ?? []).map((port) => ({
          value: `${node.id}.${port.name}`,
          label: `${node.id}.${port.name}`,
          type: port.type,
        }))
      : [],
  );
}

export function GraphTemplateEditor({ idEditable }: { idEditable: boolean }) {
  const { template, library, compile, edit } = useGraphEditor();
  const patch = (
    label: string,
    change: (current: GraphTemplateV1) => GraphTemplateV1,
    coalesce?: string,
  ) => edit(label, change, coalesce ? { coalesce } : {});
  const staleAcknowledgements = useMemo(
    () =>
      new Set(
        (compile?.diagnostics ?? [])
          .filter((diagnostic) => diagnostic.code === "acknowledgement-stale")
          .map((diagnostic) =>
            Number(/acknowledgements\[(\d+)\]/.exec(diagnostic.path ?? "")?.[1] ?? -1),
          ),
      ),
    [compile],
  );
  const sources = outputSources(template);
  const workspace = template.workspace;
  const workspaceValue =
    workspace.kind === "none"
      ? "none"
      : workspace.create
        ? `create:${workspace.create.kind}`
        : "environment";
  return (
    <div className="flex flex-col gap-3" data-graph-template-editor="">
      <FormSection title="Template">
        <CommitField
          label="Template id"
          value={template.id}
          disabled={!idEditable}
          hint={
            idEditable
              ? "A kebab-case slug; it cannot change once saved."
              : "Saved templates keep their id; Save as copy forks under a new one."
          }
          validate={(id) =>
            isGraphId(id)
              ? null
              : "Lower-case letters, digits and single dashes, starting with a letter"
          }
          onCommit={(id) => patch("Template id", (current) => ({ ...current, id }))}
        />
        <TextField
          label="Template name"
          value={template.name}
          onChange={(name) =>
            patch("Template name", (current) => ({ ...current, name }), "template:name")
          }
        />
        <TextField
          label="Template description"
          value={template.description ?? ""}
          multiline
          rows={2}
          onChange={(description) =>
            patch(
              "Template description",
              (current) => {
                const next = { ...current };
                if (description) next.description = description;
                else delete next.description;
                return next;
              },
              "template:description",
            )
          }
        />
      </FormSection>

      <FormSection title="Run">
        <SelectField
          label="Workspace"
          value={workspaceValue}
          hint="One environment per run (D7); the launcher may still pick an existing one."
          options={[
            { value: "environment", label: "An environment (the launcher chooses)" },
            { value: "create:worktree", label: "A new worktree" },
            { value: "create:container", label: "A new container" },
            { value: "none", label: "No workspace" },
          ]}
          onChange={(value) => {
            const next: GraphWorkspaceSpec =
              value === "none"
                ? { kind: "none" }
                : value.startsWith("create:")
                  ? {
                      kind: "environment",
                      create: { kind: value.slice(7) as "worktree" | "container" },
                    }
                  : { kind: "environment" };
            patch("Workspace", (current) => ({ ...current, workspace: next }));
          }}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label="Agent sessions at most"
            value={template.limits.maxAgentSessions}
            min={1}
            max={B.maxAgentSessions}
            onCommit={(value) =>
              patch("Session limit", (current) => ({
                ...current,
                limits: { ...current.limits, maxAgentSessions: value ?? 1 },
              }))
            }
          />
          <NumberField
            label="Agents at once"
            value={template.limits.maxConcurrentAgents}
            min={1}
            max={B.maxConcurrentAgents}
            onCommit={(value) =>
              patch("Concurrency limit", (current) => ({
                ...current,
                limits: { ...current.limits, maxConcurrentAgents: value ?? 1 },
              }))
            }
          />
          <NumberField
            label="Tokens (soft)"
            value={template.limits.maxTokens}
            min={1}
            max={B.maxTokens}
            optional
            onCommit={(value) =>
              patch("Token limit", (current) => {
                const limits = { ...current.limits };
                if (value === undefined) delete limits.maxTokens;
                else limits.maxTokens = value;
                return { ...current, limits };
              })
            }
          />
          <NumberField
            label="Wall clock (minutes)"
            value={
              template.limits.maxWallClockMs === undefined
                ? undefined
                : template.limits.maxWallClockMs / 60_000
            }
            min={1}
            max={B.maxWallClockMs / 60_000}
            optional
            onCommit={(value) =>
              patch("Wall-clock limit", (current) => {
                const limits = { ...current.limits };
                if (value === undefined) delete limits.maxWallClockMs;
                else limits.maxWallClockMs = value * 60_000;
                return { ...current, limits };
              })
            }
          />
        </div>
      </FormSection>

      <FormSection
        title="Parameters"
        actions={
          <AddButton
            label="Add parameter"
            disabled={template.parameters.length >= B.maxParameters}
            onClick={() =>
              patch("Add a parameter", (current) => ({
                ...current,
                parameters: [
                  ...current.parameters,
                  freshParameter(
                    "boolean",
                    uniqueGraphKey(
                      "flag",
                      current.parameters.map((entry) => entry.key),
                    ),
                  ),
                ],
              }))
            }
          />
        }
      >
        {template.parameters.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            None. Prompts and conditions read parameters as params.&lt;key&gt;.
          </p>
        ) : null}
        {template.parameters.map((parameter, index) => {
          const replace = (label: string, next: GraphParameter) =>
            patch(label, (current) => ({
              ...current,
              parameters: current.parameters.map((entry, position) =>
                position === index ? next : entry,
              ),
            }));
          return (
            <EntryCard key={`${parameter.key}:${index}`}>
              <div className="flex items-end gap-1.5">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                  <CommitField
                    label="Key"
                    value={parameter.key}
                    validate={(key) =>
                      !isGraphKey(key)
                        ? "Letters, digits and _; start with a lower-case letter"
                        : template.parameters.some(
                              (other, position) => position !== index && other.key === key,
                            )
                          ? "Another parameter has this key"
                          : null
                    }
                    onCommit={(key) =>
                      patch(`Rename parameter ${parameter.key}`, (current) =>
                        renameParamPaths(
                          {
                            ...current,
                            parameters: current.parameters.map((entry, position) =>
                              position === index ? { ...entry, key } : entry,
                            ),
                          },
                          parameter.key,
                          key,
                        ),
                      )
                    }
                  />
                  <SelectField
                    label="Type"
                    value={parameter.type}
                    options={GRAPH_PARAMETER_TYPES.map((type) => ({ value: type, label: type }))}
                    onChange={(type) =>
                      replace(
                        `Parameter ${parameter.key} type`,
                        freshParameter(type as GraphParameterType, parameter.key, parameter),
                      )
                    }
                  />
                </div>
                <RemoveButton
                  label={`Remove parameter ${parameter.key}`}
                  onClick={() =>
                    patch(`Remove parameter ${parameter.key}`, (current) => ({
                      ...current,
                      parameters: current.parameters.filter((_, position) => position !== index),
                    }))
                  }
                />
              </div>
              <TextField
                label="Label"
                value={parameter.label ?? ""}
                onChange={(label) => {
                  const next = { ...parameter };
                  if (label) next.label = label;
                  else delete next.label;
                  replace("Parameter label", next);
                }}
              />
              <ParameterDefault
                parameter={parameter}
                onChange={(next) => replace(`Parameter ${parameter.key}`, next)}
              />
            </EntryCard>
          );
        })}
      </FormSection>

      <FormSection
        title="Roles"
        actions={
          <AddButton
            label="Add role"
            disabled={template.roles.length >= B.maxRoles}
            onClick={() =>
              patch("Add a role", (current) => ({
                ...current,
                roles: [
                  ...current.roles,
                  {
                    key: uniqueGraphId(
                      "role",
                      current.roles.map((role) => role.key),
                    ),
                    multiplicity: "one",
                  },
                ],
              }))
            }
          />
        }
      >
        {template.roles.map((role, index) => {
          const replace = (label: string, next: GraphRole) =>
            patch(label, (current) => ({
              ...current,
              roles: current.roles.map((entry, position) => (position === index ? next : entry)),
            }));
          const used = template.nodes.filter(
            (node) => node.kind === "agent" && node.role === role.key,
          ).length;
          const sources: GraphRoleDefaultSource[] = [
            ...GRAPH_ROLE_DEFAULT_ACTION_KEYS,
            ...(role.multiplicity === "panel" ? (["additionalReviewers"] as const) : []),
          ];
          return (
            <EntryCard key={`${role.key}:${index}`}>
              <div className="flex items-end gap-1.5">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                  <CommitField
                    label="Key"
                    value={role.key}
                    hint={`${used} node${used === 1 ? "" : "s"}`}
                    validate={(key) =>
                      !isGraphId(key)
                        ? "Lower-case letters, digits and single dashes"
                        : template.roles.some(
                              (other, position) => position !== index && other.key === key,
                            )
                          ? "Another role has this key"
                          : null
                    }
                    onCommit={(key) =>
                      patch(`Rename role ${role.key}`, (current) =>
                        renameRole(current, role.key, key),
                      )
                    }
                  />
                  <SelectField
                    label="Models"
                    value={role.multiplicity}
                    options={GRAPH_ROLE_MULTIPLICITIES.map((value) => ({
                      value,
                      label: value === "one" ? "One" : "A panel",
                    }))}
                    onChange={(value) => {
                      const next: GraphRole = {
                        ...role,
                        multiplicity: value as GraphRoleMultiplicity,
                      };
                      if (value === "one") {
                        delete next.maxPanel;
                        if (next.defaultsFrom)
                          next.defaultsFrom = next.defaultsFrom.filter(
                            (entry) => entry !== "additionalReviewers",
                          );
                      }
                      replace(`Role ${role.key} multiplicity`, next);
                    }}
                  />
                </div>
                <RemoveButton
                  label={`Remove role ${role.key}`}
                  onClick={() =>
                    patch(`Remove role ${role.key}`, (current) => ({
                      ...current,
                      roles: current.roles.filter((_, position) => position !== index),
                    }))
                  }
                />
              </div>
              {role.multiplicity === "panel" ? (
                <NumberField
                  label="Panel size at most"
                  value={role.maxPanel}
                  min={1}
                  max={B.maxBranches}
                  optional
                  onCommit={(maxPanel) => {
                    const next = { ...role };
                    if (maxPanel === undefined) delete next.maxPanel;
                    else next.maxPanel = maxPanel;
                    replace(`Role ${role.key} panel size`, next);
                  }}
                />
              ) : null}
              <fieldset className="flex flex-col gap-0.5">
                <legend className="text-[11px] text-muted-foreground">
                  Starts from the saved defaults of
                </legend>
                <div className="grid grid-cols-2 gap-x-2">
                  {sources.map((source) => (
                    <CheckboxField
                      key={source}
                      label={ROLE_DEFAULT_LABELS[source]}
                      checked={role.defaultsFrom?.includes(source) ?? false}
                      onChange={(checked) => {
                        const current = (role.defaultsFrom ?? []).filter(
                          (entry) => entry !== source,
                        );
                        if (checked) current.push(source);
                        // `additionalReviewers` may only come last.
                        const ordered = [
                          ...current.filter((entry) => entry !== "additionalReviewers"),
                          ...current.filter((entry) => entry === "additionalReviewers"),
                        ];
                        const next = { ...role };
                        if (ordered.length > 0) next.defaultsFrom = ordered;
                        else delete next.defaultsFrom;
                        replace(`Role ${role.key} defaults`, next);
                      }}
                    />
                  ))}
                </div>
              </fieldset>
            </EntryCard>
          );
        })}
      </FormSection>

      <FormSection
        title="Run inputs"
        actions={
          <AddButton
            label="Add run input"
            disabled={template.inputs.length >= B.maxRunInputs}
            onClick={() =>
              patch("Add a run input", (current) => ({
                ...current,
                inputs: [
                  ...current.inputs,
                  {
                    name: uniqueGraphKey(
                      current.inputs.length === 0 ? "ticket" : "input",
                      current.inputs.map((input) => input.name),
                    ),
                    type: current.inputs.length === 0 ? "ticket@1" : "workspace@1",
                  },
                ],
              }))
            }
          />
        }
      >
        {template.inputs.map((input) => (
          <EntryCard key={input.name}>
            <div className="flex items-end gap-1.5" data-graph-run-input={input.name}>
              <div className="min-w-0 flex-1">
                <CommitField
                  label="Name"
                  value={input.name}
                  validate={(name) =>
                    !isGraphKey(name)
                      ? "Letters, digits and _; start with a lower-case letter"
                      : template.inputs.some((other) => other.name === name)
                        ? "Another run input has this name"
                        : null
                  }
                  onCommit={(name) =>
                    patch(`Rename run input ${input.name}`, (current) =>
                      renameGraphRunInput(current, input.name, name),
                    )
                  }
                />
              </div>
              <RemoveButton
                label={`Remove run input ${input.name}`}
                onClick={() =>
                  patch(`Remove run input ${input.name}`, (current) =>
                    removeGraphRunInput(current, input.name),
                  )
                }
              />
            </div>
            <TypeRefField
              label="Type"
              value={input.type}
              library={library}
              onChange={(type) =>
                patch(`Run input ${input.name} type`, (current) => ({
                  ...current,
                  inputs: current.inputs.map((entry) =>
                    entry.name === input.name ? { ...entry, type } : entry,
                  ),
                }))
              }
            />
            <CheckboxField
              label="Required at launch"
              checked={input.required !== false}
              onChange={(required) =>
                patch(
                  `Run input ${input.name} ${required ? "required" : "optional"}`,
                  (current) => ({
                    ...current,
                    inputs: current.inputs.map((entry) => {
                      if (entry.name !== input.name) return entry;
                      const next = { ...entry };
                      if (required) delete next.required;
                      else next.required = false;
                      return next;
                    }),
                  }),
                )
              }
            />
          </EntryCard>
        ))}
      </FormSection>

      <FormSection title="Run outputs">
        {(template.outputs ?? []).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            None. Drop a connection on “+ output” of Run outputs.
          </p>
        ) : null}
        {(template.outputs ?? []).map((output) => {
          const replace = (label: string, next: GraphRunOutputSpec) =>
            patch(label, (current) => ({
              ...current,
              outputs: (current.outputs ?? []).map((entry) =>
                entry.name === output.name ? next : entry,
              ),
            }));
          return (
            <EntryCard key={output.name}>
              <div className="flex items-end gap-1.5">
                <div className="min-w-0 flex-1">
                  <CommitField
                    label="Name"
                    value={output.name}
                    validate={(name) =>
                      !isGraphKey(name)
                        ? "Letters, digits and _; start with a lower-case letter"
                        : (template.outputs ?? []).some((other) => other.name === name)
                          ? "Another run output has this name"
                          : null
                    }
                    onCommit={(name) =>
                      replace(`Rename run output ${output.name}`, { ...output, name })
                    }
                  />
                </div>
                <RemoveButton
                  label={`Remove run output ${output.name}`}
                  onClick={() =>
                    patch(`Remove run output ${output.name}`, (current) =>
                      removeGraphRunOutput(current, output.name),
                    )
                  }
                />
              </div>
              <SelectField
                label="From"
                value={output.from.outlet ? "" : `${output.from.node}.${output.from.port}`}
                options={sources}
                onChange={(value) => {
                  const source = sources.find((entry) => entry.value === value);
                  if (!source) return;
                  const [node, port] = value.split(".") as [string, string];
                  replace(`Run output ${output.name} source`, {
                    ...output,
                    from: { node, port },
                    type: source.type,
                  });
                }}
              />
              <TypeRefField
                label="Type"
                value={output.type}
                library={library}
                onChange={(type) => replace(`Run output ${output.name} type`, { ...output, type })}
              />
            </EntryCard>
          );
        })}
      </FormSection>

      <GraphTypesEditor />

      <FormSection title="Acknowledgements">
        {(template.acknowledgements ?? []).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            None. Warnings that need one (taint reaching a side effect, a lowered enforcement floor)
            are listed in the compile panel with an Acknowledge action.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-graph-acknowledgement-list="">
            {(template.acknowledgements ?? []).map((entry, index) => (
              <li
                key={`${entry.kind}:${entry.digest}`}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{entry.code ?? entry.kind}</span>{" "}
                  <span className="text-muted-foreground">
                    {entry.digest.slice(0, 12)}… · {entry.acknowledgedAt.slice(0, 10)}
                    {staleAcknowledgements.has(index) ? " · no longer matches a warning" : ""}
                  </span>
                </span>
                <RemoveButton
                  label={`Remove acknowledgement ${entry.digest.slice(0, 12)}`}
                  onClick={() =>
                    patch("Remove acknowledgement", (current) =>
                      removeGraphAcknowledgements(current, [index]),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </FormSection>
    </div>
  );
}
