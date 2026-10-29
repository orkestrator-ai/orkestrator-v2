import { useMemo, type ReactNode } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import {
  graphPlanValueTypeLabel,
  type CompiledGraphPlan,
  type GraphCompileDiagnostic,
  type GraphPlanNode,
  type GraphPlanSubgraph,
} from "@orkestrator/protocol/graphs/compile";
import {
  isGraphRunInputRef,
  type GraphAgentNode,
  type GraphEdgeSource,
  type GraphNodeSpec,
  type GraphSubgraphNode,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { graphTypeFamily } from "@orkestrator/protocol/graphs/types";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { GRAPH_NODE_KIND_ICONS, TypeFamilyDot } from "./GraphCanvasNodes";
import { GraphDiagnosticRow } from "./GraphCompilePanel";
import { GraphEnforcementMatrix, useGraphNodeCapabilities } from "./GraphEnforcementMatrix";
import { GraphNodeEditor } from "./GraphNodeEditor";
import { GraphEdgeEditor, GraphLoopEditor } from "./GraphStructureEditors";
import { GraphTemplateEditor } from "./GraphTemplateEditor";
import {
  GRAPH_ENFORCEMENT_LABELS,
  GRAPH_NODE_KIND_LABELS,
  graphNodeTitle,
  graphTemplateTypeLibrary,
  type GraphDiagnosticIndex,
} from "./graph-designer-model";

/**
 * The inspector (report §7.2): what the selected node, edge or loop is, with
 * the compiled facts when the template compiled. An agent node shows its
 * compiled capabilities and the per-provider enforcement matrix (106),
 * computed in the browser under the same ceiling the compile used. While a
 * user template is edited (item 212) it shows the editable forms instead,
 * and the template-level form when nothing is selected.
 */

interface GraphInspectorProps {
  template: GraphTemplateV1;
  plan: CompiledGraphPlan | null;
  diagnostics: GraphDiagnosticIndex;
  selection: GraphDesignerSelection;
  ceiling?: GraphCapabilityCeiling;
  /** Enabled providers; the matrix marks the others. */
  providers: readonly AgentPlatform[];
  onSelect: (selection: GraphDesignerSelection) => void;
  /**
   * The editable inspector (item 212): forms instead of facts. The caller
   * provides `GraphEditorContext`.
   */
  editing?: { idEditable: boolean };
}

export function GraphInspector(props: GraphInspectorProps) {
  const { selection, template, editing } = props;
  let body: ReactNode;
  if (editing) {
    if (!selection) body = <GraphTemplateEditor idEditable={editing.idEditable} />;
    else if (selection.kind === "node") {
      const node = template.nodes.find((candidate) => candidate.id === selection.id);
      body = node ? (
        <GraphNodeEditor
          key={node.id}
          node={node}
          diagnostics={props.diagnostics.nodes.get(node.id)}
        />
      ) : (
        <Missing what="node" />
      );
    } else if (selection.kind === "edge") {
      body = (
        <GraphEdgeEditor
          edgeId={selection.id}
          diagnostics={props.diagnostics.edges.get(selection.id)}
        />
      );
    } else {
      body = (
        <GraphLoopEditor
          loopId={selection.id}
          diagnostics={props.diagnostics.loops.get(selection.id)}
        />
      );
    }
  } else if (!selection) {
    body = <TemplateSummary template={template} />;
  } else if (selection.kind === "node") {
    const node = template.nodes.find((candidate) => candidate.id === selection.id);
    body = node ? <NodeInspector {...props} node={node} /> : <Missing what="node" />;
  } else if (selection.kind === "edge") {
    body = <EdgeInspector {...props} edgeId={selection.id} />;
  } else {
    body = <LoopInspector {...props} loopId={selection.id} />;
  }
  return (
    <section
      aria-label="Inspector"
      data-graph-inspector=""
      className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs"
    >
      {body}
    </section>
  );
}

function Missing({ what }: { what: string }) {
  return <p className="text-muted-foreground">This {what} is not in the template any more.</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Fields({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const present = rows.filter((row): row is [string, ReactNode] => Boolean(row));
  if (present.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1">
      {present.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A sub-graph's parameter bindings: the compiled scope when there is one
 * (defaults filled in), else what the node binds.
 */
function subgraphParamsText(
  node: GraphSubgraphNode,
  inlined: GraphPlanSubgraph | undefined,
): string {
  const entries = inlined
    ? Object.entries(inlined.params).map(([key, source]) =>
        "param" in source ? `${key} ← params.${source.param}` : `${key} = ${String(source.value)}`,
      )
    : Object.entries(node.params ?? {}).map(([key, binding]) =>
        binding !== null && typeof binding === "object"
          ? `${key} ← params.${binding.param}`
          : `${key} = ${String(binding)}`,
      );
  return entries.length > 0 ? entries.join(", ") : "defaults";
}

/** A sub-graph node (item 402): its child, pin, bindings and the plan nodes it became. */
function SubgraphDetails({
  node,
  plan,
}: {
  node: GraphSubgraphNode;
  plan: GraphInspectorProps["plan"];
}) {
  const inlined = plan?.subgraphs?.find((instance) => instance.id === node.id);
  const ref = node.template;
  return (
    <Section title="Sub-graph">
      <Fields
        rows={[
          [
            "Template",
            <span key="Template" className="font-mono">
              {inlined?.template.name ? `${inlined.template.name} · ` : ""}
              {ref.scope}:{ref.path ?? ref.id}
            </span>,
          ],
          [
            "Pinned",
            ref.digest
              ? `revision ${ref.revision ?? "?"} (${ref.digest.slice(0, 12)}…)`
              : "no: each compile uses the current version",
          ],
          inlined?.template.engine ? ["Engine", "ignored: a copy runs on the graph runtime"] : null,
          ["Parameters", subgraphParamsText(node, inlined)],
          [
            "Roles",
            Object.entries(inlined?.roles ?? node.roles ?? {})
              .map(([inner, outer]) => (inner === outer ? inner : `${inner} → ${outer}`))
              .join(", ") || "same names",
          ],
          inlined
            ? [
                "Inlined as",
                <span key="Inlined" className="font-mono" data-graph-subgraph-nodes="">
                  {inlined.nodes.join(", ")}
                </span>,
              ]
            : null,
        ]}
      />
    </Section>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-md bg-flow-canvas p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground/90">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function TemplateSummary({ template }: { template: GraphTemplateV1 }) {
  return (
    <>
      <header>
        <h3 className="text-sm font-semibold text-foreground">{template.name}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">
          {template.id} · revision {template.revision}
        </p>
      </header>
      {template.description ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{template.description}</p>
      ) : null}
      <Section title="Template">
        <Fields
          rows={[
            ["Nodes", template.nodes.length],
            ["Edges", template.edges.length],
            ["Loops", template.loops?.length ?? 0],
            ["Workspace", template.workspace.kind],
            ["Agent sessions", `at most ${template.limits.maxAgentSessions}`],
            ["Concurrency", `at most ${template.limits.maxConcurrentAgents} agents`],
            template.engine ? ["Engine", template.engine] : null,
          ]}
        />
      </Section>
      {template.roles.length > 0 ? (
        <Section title="Roles">
          <ul className="flex flex-col gap-1">
            {template.roles.map((role) => (
              <li key={role.key}>
                <span className="font-medium text-foreground">{role.label ?? role.key}</span>{" "}
                <span className="text-muted-foreground">
                  ({role.key} · {role.multiplicity})
                </span>
                {role.description ? (
                  <p className="text-muted-foreground">{role.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {template.inputs.length > 0 ? (
        <Section title="Run inputs">
          <PortList
            ports={template.inputs.map((input) => ({
              ...input,
              required: input.required !== false,
            }))}
            template={template}
          />
        </Section>
      ) : null}
      <p className="text-muted-foreground">Select a node, edge or loop to inspect it.</p>
    </>
  );
}

function PortList({
  ports,
  template,
  extra,
}: {
  ports: Array<{
    name: string;
    type: string;
    label?: string;
    required?: boolean;
    description?: string;
  }>;
  template: GraphTemplateV1;
  extra?: (name: string) => ReactNode;
}) {
  const library = useMemo(() => graphTemplateTypeLibrary(template), [template]);
  if (ports.length === 0) return <p className="text-muted-foreground">None.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {ports.map((port) => (
        <li key={port.name} data-graph-inspector-port={port.name} className="flex flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <TypeFamilyDot
              port={{ family: graphTypeFamily(port.type, library), type: port.type }}
            />
            <span className="font-mono text-foreground">{port.name}</span>
            <span className="truncate font-mono text-muted-foreground">{port.type}</span>
            {port.required === false ? (
              <span className="text-muted-foreground">(optional)</span>
            ) : null}
          </span>
          {port.label || port.description ? (
            <span className="pl-3.5 text-muted-foreground">
              {[port.label, port.description].filter(Boolean).join(" — ")}
            </span>
          ) : null}
          {extra ? <div className="pl-3.5">{extra(port.name)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function DiagnosticsList({
  list,
  onSelect,
}: {
  list: readonly GraphCompileDiagnostic[] | undefined;
  onSelect: (selection: GraphDesignerSelection) => void;
}) {
  if (!list || list.length === 0) return null;
  return (
    <Section title="Diagnostics">
      <ul className="flex flex-col gap-1">
        {list.map((diagnostic, index) => (
          <GraphDiagnosticRow
            key={`${diagnostic.code}:${index}`}
            diagnostic={diagnostic}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </Section>
  );
}

function sourceLabel(source: GraphEdgeSource): string {
  if (isGraphRunInputRef(source)) return `run input ${source.input}`;
  return source.outlet !== undefined
    ? `${source.node} → ${source.outlet} (${source.port})`
    : `${source.node}.${source.port}`;
}

function NodeInspector({
  node,
  template,
  plan,
  diagnostics,
  ceiling,
  providers,
  onSelect,
}: GraphInspectorProps & { node: GraphNodeSpec }) {
  const planNode = plan?.nodes.find((candidate) => candidate.id === node.id);
  const Icon = GRAPH_NODE_KIND_ICONS[node.kind];
  const incoming = template.edges.filter((edge) => edge.to.node === node.id);
  const outgoing = template.edges.filter(
    (edge) => !isGraphRunInputRef(edge.from) && edge.from.node === node.id,
  );
  const loop = template.loops?.find((candidate) => candidate.nodes.includes(node.id));
  return (
    <>
      <header className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{graphNodeTitle(node)}</h3>
        </span>
        <p className="font-mono text-[11px] text-muted-foreground">
          {GRAPH_NODE_KIND_LABELS[node.kind]} · {node.id}
        </p>
      </header>
      {node.description ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{node.description}</p>
      ) : null}
      <DiagnosticsList list={diagnostics.nodes.get(node.id)} onSelect={onSelect} />
      {node.kind === "agent" ? (
        <AgentDetails
          node={node}
          planNode={planNode}
          template={template}
          ceiling={ceiling}
          providers={providers}
        />
      ) : null}
      {node.kind === "system" ? (
        <Section title="System action">
          <Fields
            rows={[
              [
                "Action",
                <span key="Action" className="font-mono">
                  {node.action}
                </span>,
              ],
            ]}
          />
          {node.params && Object.keys(node.params).length > 0 ? <Json value={node.params} /> : null}
        </Section>
      ) : null}
      {node.kind === "gate" ? (
        <Section title="Branches">
          <ul className="flex flex-col gap-1.5">
            {node.branches.map((branch, index) => (
              <li key={`${branch.to}:${index}`}>
                <span className="font-mono text-foreground">→ {branch.to}</span>
                {branch.label ? (
                  <span className="text-muted-foreground"> {branch.label}</span>
                ) : null}
                <Json value={branch.when} />
              </li>
            ))}
            {node.otherwise !== undefined ? (
              <li>
                <span className="font-mono text-foreground">→ {node.otherwise}</span>{" "}
                <span className="text-muted-foreground">otherwise</span>
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
      {node.kind === "merge" ? (
        <Section title="Merge">
          <Json value={node.strategy} />
        </Section>
      ) : null}
      {node.kind === "human" ? (
        <Section title="Human form">
          <Json value={node.form} />
        </Section>
      ) : null}
      {node.kind === "subgraph" ? <SubgraphDetails node={node} plan={plan} /> : null}
      <Section title="Inputs">
        <PortList
          ports={node.inputs ?? []}
          template={template}
          extra={(name) => {
            const spec = node.inputs?.find((port) => port.name === name);
            const port = planNode?.inputs.find((candidate) => candidate.name === name);
            return (
              <Fields
                rows={[
                  port?.render || spec?.render ? ["Render", port?.render ?? spec?.render] : null,
                  port?.collect || spec?.collect
                    ? ["Collect", <Json key="Collect" value={port?.collect ?? spec?.collect} />]
                    : null,
                  spec?.firstIterationFrom
                    ? ["Iteration 1 from", sourceLabel(spec.firstIterationFrom)]
                    : null,
                  port?.deliveredType
                    ? [
                        "Delivered",
                        <span key="Delivered" className="font-mono">
                          {graphPlanValueTypeLabel(port.deliveredType)}
                        </span>,
                      ]
                    : null,
                  port?.fanIn ? ["Fan-in", "yes"] : null,
                ]}
              />
            );
          }}
        />
      </Section>
      {"outputs" in node ? (
        <Section title="Outputs">
          <PortList
            ports={node.outputs ?? []}
            template={template}
            extra={(name) => {
              const spec = node.outputs?.find((port) => port.name === name);
              const port = planNode?.outputs.find((candidate) => candidate.name === name);
              return (
                <Fields
                  rows={[
                    spec?.provenance ? ["Provenance", spec.provenance] : null,
                    spec?.choices ? ["Choices", spec.choices.join(", ")] : null,
                    port?.valueType && port.valueType.kind === "list"
                      ? [
                          "Consumers see",
                          <span key="Consumers see" className="font-mono">
                            {graphPlanValueTypeLabel(port.valueType)}
                          </span>,
                        ]
                      : null,
                  ]}
                />
              );
            }}
          />
        </Section>
      ) : null}
      <Section title="Execution">
        <Fields
          rows={[
            loop ? ["Loop", loop.label ?? loop.id] : null,
            [
              "Workspace",
              planNode?.workspaceAccess ??
                (node.kind === "agent" ? node.workspaceAccess : "by action"),
            ],
            [
              "On failure",
              planNode?.onFailure ??
                ("onFailure" in node ? (node.onFailure ?? "fail-run") : "fail-run"),
            ],
            "retry" in node || planNode
              ? [
                  "Retry",
                  (() => {
                    const retry = planNode?.retry ?? ("retry" in node ? node.retry : undefined);
                    if (!retry || retry.attempts <= 1) return "no";
                    return `${retry.attempts} attempts on ${retry.on.join(", ") || "nothing"}`;
                  })(),
                ]
              : null,
            "timeoutMs" in node && node.timeoutMs !== undefined
              ? ["Timeout", `${Math.round(node.timeoutMs / 1000)} s`]
              : null,
            planNode
              ? [
                  "Branches",
                  planNode.fanOut.min === planNode.fanOut.max
                    ? `${planNode.fanOut.max}`
                    : `${planNode.fanOut.min}–${planNode.fanOut.max}`,
                ]
              : null,
            planNode?.skippable ? ["Skippable", "yes"] : null,
            planNode?.taint.tainted
              ? ["Taint", `reached by ${planNode.taint.sources.join(", ") || "untrusted input"}`]
              : null,
          ]}
        />
        {node.when ? (
          <>
            <span className="text-muted-foreground">Runs when</span>
            <Json value={node.when} />
          </>
        ) : null}
      </Section>
      <Section title="Edges">
        <ul className="flex flex-col gap-0.5">
          {[...incoming, ...outgoing].map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                className="font-mono text-primary hover:underline"
                onClick={() => onSelect({ kind: "edge", id: edge.id })}
              >
                {edge.id}
              </button>{" "}
              <span className="text-muted-foreground">
                {sourceLabel(edge.from)} → {edge.to.node}.{edge.to.port}
              </span>
            </li>
          ))}
          {incoming.length + outgoing.length === 0 ? (
            <li className="text-muted-foreground">None.</li>
          ) : null}
        </ul>
      </Section>
    </>
  );
}

function AgentDetails({
  node,
  planNode,
  template,
  ceiling,
  providers,
}: {
  node: GraphAgentNode;
  planNode: GraphPlanNode | undefined;
  template: GraphTemplateV1;
  ceiling?: GraphCapabilityCeiling;
  providers: readonly AgentPlatform[];
}) {
  const role = template.roles.find((candidate) => candidate.key === node.role);
  const compiled = useGraphNodeCapabilities(node, planNode, ceiling);
  const floor =
    planNode?.kind === "agent"
      ? planNode.minEnforcement
      : (node.minEnforcement ?? compiled?.defaultMinEnforcement);
  const session =
    planNode?.kind === "agent" ? planNode.session : (node.session ?? { mode: "fresh" as const });
  return (
    <>
      <Section title="Agent">
        <Fields
          rows={[
            [
              "Role",
              <>
                <span className="font-mono">{node.role}</span>
                {role ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {role.label ?? role.key} · {role.multiplicity}
                  </span>
                ) : null}
              </>,
            ],
            ["Profile", node.capabilities.profile],
            ["Session", session.mode === "continue" ? `continues ${session.from}` : "fresh"],
            node.replicate ? ["Replicate", <Json key="Replicate" value={node.replicate} />] : null,
            ["Asks a person", node.askHuman ? "yes (ask_human)" : "no, unattended"],
          ]}
        />
      </Section>
      <Section title="Prompt">
        {"builtIn" in node.prompt ? (
          <p>
            Built-in prompt <span className="font-mono text-foreground">{node.prompt.builtIn}</span>
          </p>
        ) : (
          <pre
            data-graph-inspector-prompt=""
            className="max-h-64 overflow-auto rounded-md bg-flow-canvas p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground/90"
          >
            {node.prompt.template}
          </pre>
        )}
      </Section>
      <Section title="Capabilities">
        {compiled ? (
          <Fields
            rows={[
              ["Workspace", compiled.readOnly ? "read-only" : "may write"],
              ["Web search", compiled.webSearch ? "allowed" : "denied"],
              ["Denied", compiled.denied.length > 0 ? compiled.denied.join(", ") : "nothing"],
              node.capabilities.allow?.length
                ? ["Allowed", node.capabilities.allow.join(", ")]
                : null,
              node.capabilities.deny?.length
                ? ["Node denies", node.capabilities.deny.join(", ")]
                : null,
              compiled.removedByCeiling.length > 0
                ? ["Removed by ceiling", compiled.removedByCeiling.join(", ")]
                : null,
              compiled.removedByEnvironment.length > 0
                ? ["Removed by environment", compiled.removedByEnvironment.join(", ")]
                : null,
              compiled.orkestratorGroups.length > 0
                ? ["Orkestrator tools", compiled.orkestratorGroups.join(", ")]
                : null,
              ["Minimum enforcement", floor ? GRAPH_ENFORCEMENT_LABELS[floor] : "none"],
            ]}
          />
        ) : (
          <p className="text-muted-foreground">
            The capability spec is not valid; see diagnostics.
          </p>
        )}
      </Section>
      {compiled ? (
        <Section title="Enforcement by provider">
          <GraphEnforcementMatrix compiled={compiled} providers={providers} />
        </Section>
      ) : null}
    </>
  );
}

function EdgeInspector({
  edgeId,
  template,
  plan,
  diagnostics,
  onSelect,
}: GraphInspectorProps & { edgeId: string }) {
  const edge = template.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return <Missing what="edge" />;
  const planEdge = plan?.edges.find((candidate) => candidate.id === edgeId);
  return (
    <>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">Edge {edge.id}</h3>
        <p className="text-muted-foreground">
          {sourceLabel(edge.from)} → {edge.to.node}.{edge.to.port}
        </p>
      </header>
      <DiagnosticsList list={diagnostics.edges.get(edge.id)} onSelect={onSelect} />
      <Section title="Delivery">
        <Fields
          rows={[
            planEdge?.sourceType
              ? [
                  "Source type",
                  <span key="Source type" className="font-mono">
                    {graphPlanValueTypeLabel(planEdge.sourceType)}
                  </span>,
                ]
              : null,
            planEdge?.deliveredType
              ? [
                  "Delivered type",
                  <span key="Delivered type" className="font-mono">
                    {graphPlanValueTypeLabel(planEdge.deliveredType)}
                  </span>,
                ]
              : null,
            planEdge ? ["Iterations", planEdge.iterations] : null,
            planEdge?.fanIn ? ["Fan-in", "a replicated producer feeds a list"] : null,
            planEdge?.budgetCheck ? ["Budget", "checked at run time"] : null,
            ["Zip", edge.zip ? "branch k feeds branch k" : "no"],
            !plan ? ["Compiled", "not yet: the template has errors"] : null,
          ]}
        />
      </Section>
      <Section title="Transforms">
        {edge.transform && edge.transform.length > 0 ? (
          <Json value={edge.transform} />
        ) : (
          <p className="text-muted-foreground">None.</p>
        )}
      </Section>
      <Section title="Ends">
        <div className="flex flex-wrap gap-2">
          {!isGraphRunInputRef(edge.from) ? (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => onSelect({ kind: "node", id: (edge.from as { node: string }).node })}
            >
              Show {(edge.from as { node: string }).node}
            </button>
          ) : null}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => onSelect({ kind: "node", id: edge.to.node })}
          >
            Show {edge.to.node}
          </button>
        </div>
      </Section>
    </>
  );
}

function LoopInspector({
  loopId,
  template,
  plan,
  diagnostics,
  onSelect,
}: GraphInspectorProps & { loopId: string }) {
  const loop = template.loops?.find((candidate) => candidate.id === loopId);
  if (!loop) return <Missing what="loop" />;
  const planLoop = plan?.loops.find((candidate) => candidate.id === loopId);
  return (
    <>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">↻ {loop.label ?? loop.id}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">
          Loop · {loop.id} · at most {loop.maxIterations} iterations
        </p>
      </header>
      <DiagnosticsList list={diagnostics.loops.get(loop.id)} onSelect={onSelect} />
      <Section title="Members">
        <div className="flex flex-wrap gap-1.5">
          {(planLoop?.members ?? loop.nodes).map((member) => (
            <button
              key={member}
              type="button"
              className="rounded border border-border px-1.5 font-mono text-primary hover:bg-accent"
              onClick={() => onSelect({ kind: "node", id: member })}
            >
              {member}
            </button>
          ))}
        </div>
        {planLoop ? (
          <Fields
            rows={[
              ["Entry", planLoop.entry.join(", ") || "none"],
              planLoop.laterOnly.length > 0
                ? ["From iteration 2", planLoop.laterOnly.join(", ")]
                : null,
            ]}
          />
        ) : null}
      </Section>
      <Section title="Until">
        <Json value={loop.until} />
      </Section>
      <Section title="Carries">
        {loop.carry.length > 0 ? (
          <ul className="flex flex-col gap-0.5 font-mono">
            {loop.carry.map((carry, index) => (
              <li key={index}>
                {carry.from.node}.{carry.from.port} → {carry.to.node}.{carry.to.port}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None.</p>
        )}
      </Section>
    </>
  );
}
