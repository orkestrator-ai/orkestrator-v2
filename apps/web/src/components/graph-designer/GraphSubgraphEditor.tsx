import { useEffect } from "react";
import type {
  GraphNodeSpec,
  GraphParameter,
  GraphParameterBinding,
  GraphSubgraphNode,
} from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import {
  graphDesignerSubgraphKey,
  graphSubgraphBindParam,
  graphSubgraphBindRole,
  graphSubgraphParamLiteral,
  graphSubgraphParamMode,
  graphSubgraphPinnedRef,
  graphSubgraphRefreshPorts,
} from "./graph-designer-subgraphs";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import {
  EntryCard,
  FormSection,
  JsonField,
  NumberField,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * The form of a sub-graph node (item 402): the template it inlines and
 * whether that is pinned to the version on disk, a binding for each of the
 * child's parameters (its default, a value, or one of this template's
 * parameters passed through) and roles (one of this template's roles of the
 * same multiplicity), the ports it exposes, and the plan nodes it became.
 * The child is read from the backend once and kept for the browser compile.
 */
export function GraphSubgraphEditor({
  node,
  projectId,
}: {
  node: GraphSubgraphNode;
  projectId: string | null;
}) {
  const { template, plan } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const key = graphDesignerSubgraphKey(projectId, node.template);
  const entry = useGraphDesignerStore((state) => state.subgraphTemplates.get(key));
  const loadSubgraphTemplate = useGraphDesignerStore((state) => state.loadSubgraphTemplate);
  useEffect(() => {
    if (!entry) void loadSubgraphTemplate(projectId, node.template);
  }, [entry, loadSubgraphTemplate, projectId, node.template]);

  const ready = entry?.status === "ready" ? entry : null;
  const child = ready?.template;
  const missing = ready && "missing" in ready.resolution ? ready.resolution.missing : null;
  const current = child ? graphSubgraphPinnedRef(node.template, child, ready?.summary) : null;
  const pinned = node.template.digest !== undefined;
  const stale =
    current !== null &&
    ((node.template.digest !== undefined && node.template.digest !== current.digest) ||
      (node.template.revision !== undefined && node.template.revision !== current.revision));
  const inlined = plan?.subgraphs?.find((instance) => instance.id === node.id);

  return (
    <div className="flex flex-col gap-3" data-graph-subgraph-editor={node.id}>
      <FormSection title="Template">
        <EntryCard>
          <p className="text-xs text-foreground">
            {child?.name ?? node.template.id}{" "}
            <span className="font-mono text-[11px] text-muted-foreground">
              {node.template.scope}:{node.template.path ?? node.template.id}
            </span>
          </p>
          <p className="text-[11px] text-muted-foreground" data-graph-subgraph-pin="">
            {!entry || entry.status === "loading"
              ? "Reading the template…"
              : missing
                ? `Cannot be inlined: the template is ${missing}.`
                : stale
                  ? `Changed since it was pinned (pinned revision ${node.template.revision ?? "?"}, now ${current?.revision}). Review it, then pin the current version.`
                  : pinned
                    ? `Pinned to revision ${node.template.revision ?? current?.revision} (${node.template.digest!.slice(0, 12)}…).`
                    : "Not pinned: each compile uses the template's current version."}
          </p>
          {child?.engine ? (
            <p className="text-[11px] text-muted-foreground">
              Built-in {child.name} runs on its own engine when launched alone; here a copy of its
              nodes runs on the graph runtime.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!current || missing !== null || (pinned && !stale)}
              onClick={() =>
                current &&
                editNode<GraphSubgraphNode>("Pin sub-graph version", (previous) => ({
                  ...previous,
                  template: current,
                }))
              }
            >
              Pin current version
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!child || missing !== null}
              onClick={() =>
                child &&
                editNode<GraphSubgraphNode>("Update sub-graph ports", (previous) =>
                  graphSubgraphRefreshPorts(previous, child),
                )
              }
            >
              Update ports from template
            </Button>
          </div>
        </EntryCard>
      </FormSection>

      {child && child.parameters.length > 0 ? (
        <FormSection title="Parameters">
          {child.parameters.map((parameter) => (
            <ParamBinding
              key={parameter.key}
              parameter={parameter}
              binding={node.params?.[parameter.key]}
              parents={template.parameters}
              onChange={(binding) =>
                editNode<GraphSubgraphNode>(
                  `Bind ${parameter.key}`,
                  (previous) => graphSubgraphBindParam(previous, parameter.key, binding),
                  `param:${parameter.key}`,
                )
              }
            />
          ))}
        </FormSection>
      ) : null}

      {child && child.roles.length > 0 ? (
        <FormSection title="Roles">
          {child.roles.map((role) => {
            const sameKey = template.roles.some(
              (candidate) =>
                candidate.key === role.key && candidate.multiplicity === role.multiplicity,
            );
            return (
              <SelectField
                key={role.key}
                label={`${role.label ?? role.key} (${role.multiplicity === "panel" ? "panel" : "one model"})`}
                value={node.roles?.[role.key] ?? ""}
                options={[
                  {
                    value: "",
                    label: sameKey ? `Same name (${role.key})` : "Unbound: pick a role",
                    disabled: !sameKey,
                  },
                  ...template.roles
                    .filter((candidate) => candidate.multiplicity === role.multiplicity)
                    .map((candidate) => ({
                      value: candidate.key,
                      label: candidate.label
                        ? `${candidate.label} (${candidate.key})`
                        : candidate.key,
                    })),
                ]}
                onChange={(value) =>
                  editNode<GraphSubgraphNode>(`Bind role ${role.key}`, (previous) =>
                    graphSubgraphBindRole(previous, role.key, value === "" ? undefined : value),
                  )
                }
              />
            );
          })}
        </FormSection>
      ) : null}

      <FormSection title="Ports">
        <p className="text-[11px] text-muted-foreground">
          In:{" "}
          {(node.inputs ?? []).map((port) => `${port.name} (${port.type})`).join(", ") || "none"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Out:{" "}
          {(node.outputs ?? [])
            .map(
              (port) => `${port.name} (${port.type}${port.required === false ? ", optional" : ""})`,
            )
            .join(", ") || "none"}
        </p>
      </FormSection>

      {inlined ? (
        <FormSection title="Inlined as">
          <p className="font-mono text-[11px] text-muted-foreground" data-graph-subgraph-nodes="">
            {inlined.nodes.join(", ")}
          </p>
        </FormSection>
      ) : null}

      <FormSection title="Advanced">
        <JsonField
          label="Node as JSON"
          value={node}
          rows={8}
          onCommit={(value) =>
            editNode("Edit sub-graph JSON", (previous) => ({
              ...(value as GraphNodeSpec),
              id: previous.id,
            }))
          }
        />
      </FormSection>
    </div>
  );
}

/** One child parameter: its default, a value of its type, or a parameter passed through. */
function ParamBinding({
  parameter,
  binding,
  parents,
  onChange,
}: {
  parameter: GraphParameter;
  binding: GraphParameterBinding | undefined;
  parents: readonly GraphParameter[];
  onChange: (binding: GraphParameterBinding | undefined) => void;
}) {
  const mode = graphSubgraphParamMode(binding);
  const label = parameter.label ?? parameter.key;
  const selected = mode === "param" ? `param:${(binding as { param: string }).param}` : mode;
  return (
    <EntryCard>
      <SelectField
        label={label}
        value={selected}
        options={[
          {
            value: "default",
            label:
              parameter.default !== undefined
                ? `Default (${String(parameter.default)})`
                : "No default: give it a value",
            disabled: parameter.default === undefined,
          },
          { value: "value", label: "A value" },
          ...parents.map((parent) => ({
            value: `param:${parent.key}`,
            label: `This template's ${parent.label ?? parent.key}`,
          })),
        ]}
        onChange={(value) => {
          if (value === "default") onChange(undefined);
          else if (value === "value") onChange(graphSubgraphParamLiteral(parameter));
          else onChange({ param: value.slice("param:".length) });
        }}
      />
      {mode === "value" ? (
        <LiteralField
          parameter={parameter}
          value={binding as string | number | boolean | null}
          onChange={onChange}
        />
      ) : null}
    </EntryCard>
  );
}

function LiteralField({
  parameter,
  value,
  onChange,
}: {
  parameter: GraphParameter;
  value: string | number | boolean | null;
  onChange: (value: string | number | boolean) => void;
}) {
  const label = `${parameter.label ?? parameter.key} value`;
  switch (parameter.type) {
    case "boolean":
      return (
        <SelectField
          label={label}
          value={String(value === true)}
          options={[
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
          onChange={(text) => onChange(text === "true")}
        />
      );
    case "integer":
    case "number":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          integer={parameter.type === "integer"}
          {...(parameter.min !== undefined ? { min: parameter.min } : {})}
          {...(parameter.max !== undefined ? { max: parameter.max } : {})}
          onCommit={(number) => number !== undefined && onChange(number)}
        />
      );
    case "enum":
      return (
        <SelectField
          label={label}
          value={typeof value === "string" ? value : ""}
          options={parameter.options.map((option) => ({ value: option, label: option }))}
          onChange={onChange}
        />
      );
    case "string":
      return (
        <TextField
          label={label}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
        />
      );
  }
}
