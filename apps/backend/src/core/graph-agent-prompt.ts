/**
 * The prompt of a graph agent activation (item 204, D13, report §5.6).
 *
 * Inputs are loaded from the run's artifact store and verified before the
 * agent sees them (a reference artifact's sealed file is re-hashed at its
 * source; invariant 4 and P2.1). Each input renders in its port's mode through
 * item 105's `renderGraphNodePrompt`: the user template (or a built-in
 * prompt's text from today's builders, `graph-agent-builtins.ts`) followed by
 * the locked system contract with the activation's capability statement,
 * the unattended policy and its result tools. The preview in the designer
 * renders through the same function, so it shows what the agent gets.
 *
 * Inputs whose type has `items` show each item's stable id (item 205; the
 * protocol's `graphArtifactItemIds`, recorded or derived), and the same ids
 * are the provenance sources a `cite`/`accountForAll` port accepts. A failed
 * branch's `error@1` marker in a fan-in list renders as a failed branch.
 */
import type {
  CompiledGraphCapabilities,
  GraphGrantedActions,
} from "@orkestrator/protocol/graphs/capability-profiles";
import type {
  GraphPlanAgentNode,
  GraphPlanInputPort,
  GraphPlanValueType,
} from "@orkestrator/protocol/graphs/compile";
import { parseGraphTypeRef } from "@orkestrator/protocol/graphs/grammar";
import type { GraphProvenanceSources } from "@orkestrator/protocol/graphs/provenance";
import {
  graphBuiltInPrompt,
  graphBuiltInPromptBindings,
  graphPromptScope,
  renderGraphNodePrompt,
  type GraphBuiltInPromptId,
  type GraphPromptArtifactRef,
  type GraphPromptElement,
  type GraphPromptFileRef,
  type GraphPromptValues,
  type GraphResultTools,
} from "@orkestrator/protocol/graphs/prompts";
import {
  graphArtifactItemIds,
  graphNodeBranches,
  type GraphArtifact,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type {
  GraphAgentNode,
  GraphEnforcementTier,
  GraphLens,
} from "@orkestrator/protocol/graphs/template";
import { GraphTypeLibrary, type GraphValueType } from "@orkestrator/protocol/graphs/types";
import { graphPlanScopeParams, graphPlanSubgraph } from "@orkestrator/protocol/graphs/subgraphs";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import {
  graphBuiltInPromptText,
  graphReviewCoverageGapIds,
  isGraphReviewConsolidationNode,
  type GraphBuiltInPromptInputValue,
} from "./graph-agent-builtins.js";

/** An activation that cannot be prompted: a missing or unverifiable input, a render error. */
export class GraphAgentPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphAgentPromptError";
  }
}

/** The template-shaped node 105's renderer reads, from the frozen plan's node. */
export function graphPlanAgentTemplateNode(node: GraphPlanAgentNode): GraphAgentNode {
  return {
    kind: "agent",
    id: node.id,
    ...(node.label ? { label: node.label } : {}),
    ...(node.description ? { description: node.description } : {}),
    inputs: node.inputs.map((port) => ({
      name: port.name,
      type: port.type,
      ...(port.label ? { label: port.label } : {}),
      ...(port.description ? { description: port.description } : {}),
      required: port.required,
      ...(port.render ? { render: port.render } : {}),
    })),
    outputs: node.outputs.map((port) => ({
      name: port.name,
      type: port.type,
      ...(port.label ? { label: port.label } : {}),
      ...(port.description ? { description: port.description } : {}),
      required: port.required,
      ...(port.provenance ? { provenance: port.provenance } : {}),
      ...(port.choices ? { choices: port.choices } : {}),
    })),
    role: node.role,
    prompt: node.prompt,
    capabilities: node.capabilities.spec,
    workspaceAccess: node.workspaceAccess,
    ...(node.minEnforcement ? { minEnforcement: node.minEnforcement } : {}),
    session: node.session,
    ...(node.replicate
      ? {
          replicate:
            node.replicate.axes.length === 1
              ? (node.replicate.axes[0] as NonNullable<GraphAgentNode["replicate"]>)
              : ({
                  over: "cross",
                  axes: node.replicate.axes,
                } as NonNullable<GraphAgentNode["replicate"]>),
        }
      : {}),
    askHuman: node.askHuman,
  };
}

function valueType(library: GraphTypeLibrary, type: GraphPlanValueType): GraphValueType | null {
  switch (type.kind) {
    case "named": {
      const resolved = library.resolve(type.ref);
      return resolved.ok ? resolved.type : null;
    }
    case "shape":
      return { kind: "shape", origin: type.origin, schema: type.schema, budgets: type.budgets };
    case "list": {
      const element = valueType(library, type.element);
      return element ? { kind: "list", element } : null;
    }
  }
}

/** One loaded and verified input artifact. */
export interface GraphAgentInputArtifact {
  port: string;
  artifact: GraphArtifact;
}

/** What the activation consumed, loaded and verified. */
export interface GraphAgentInputs {
  values: GraphPromptValues;
  /** Every consumed artifact id, in port order: the lineage of the outputs. */
  consumed: string[];
  /** Artifacts by id, for `read_artifact` (only what this activation was given). */
  readable: Map<string, GraphAgentInputArtifact>;
  /** Item ids of list inputs, for provenance ports: id → the artifact's type. */
  sources: GraphProvenanceSources;
  /** Acceptance criterion ids of a ticket input, for verdict ports. */
  criterionIds?: string[];
  /** The workspace commit an input `workspace@1` names, when one does. */
  inputWorkspace?: { branch?: string; headRef: string };
  /** Built-in input name → bound input, when the node names a built-in prompt. */
  builtInInputs?: Record<string, GraphBuiltInPromptInputValue | GraphBuiltInPromptInputValue[]>;
}

function bodyValue(artifact: GraphArtifact): unknown {
  return "value" in artifact.body ? artifact.body.value : undefined;
}

/**
 * The stable ids of an input artifact's items (recorded at accept time, else
 * derived from its producer), empty when its type has no `items`. Prompts
 * show exactly these, and provenance accepts exactly these.
 */
export function graphInputItemIds(
  library: GraphTypeLibrary,
  artifact: Pick<GraphArtifact, "type" | "producer" | "itemIds" | "body">,
): string[] {
  const parts = parseGraphTypeRef(artifact.type);
  if (!parts || parts.listDepth > 0) return [];
  const definition = library.definition(parts.name, parts.version);
  return graphArtifactItemIds(artifact, definition?.items, {
    value: "value" in artifact.body ? artifact.body.value : undefined,
  });
}

/** A failed branch's `error@1` marker on a port that collects something else (`includeFailures`). */
export function isGraphFailureMarker(portType: string, artifactType: string): boolean {
  return (
    parseGraphTypeRef(artifactType)?.name === "error" &&
    parseGraphTypeRef(portType)?.name !== "error"
  );
}

function isReviewReport(type: string): boolean {
  const parts = parseGraphTypeRef(type);
  return parts?.name === "review-report" && parts.listDepth === 0;
}

/** A review report's coverage gap source ids (`graphReviewCoverageGapIds`). */
function reviewCoverageGapIds(artifact: GraphArtifact): string[] {
  const value = bodyValue(artifact) as { testCoverageGaps?: unknown } | undefined;
  const gaps = Array.isArray(value?.testCoverageGaps) ? value.testCoverageGaps.length : 0;
  return graphReviewCoverageGapIds(artifact.producer, gaps);
}

/**
 * Who wrote a review report, as Multi Review labels its reviewers: the
 * producing activation's agent and model, and the lens label of its panel
 * position. Undefined when the producer is not an agent activation of the run.
 */
function reviewReportAuthor(
  run: Readonly<GraphRun>,
  artifact: GraphArtifact,
): GraphBuiltInPromptInputValue["reviewer"] {
  const activation = run.activations.find(
    (candidate) => candidate.key === artifact.producer.activation,
  );
  const producer = run.plan.nodes.find(
    (candidate): candidate is GraphPlanAgentNode =>
      candidate.kind === "agent" && candidate.id === artifact.producer.nodeId,
  );
  if (!activation?.session || !producer) return undefined;
  const { lens } = graphAgentBranchValues(run, producer, activation);
  return {
    agent: activation.session.agent,
    model: activation.session.model ?? "default",
    ...(lens ? { focus: lens.label } : {}),
  };
}

function isTicket(type: string): boolean {
  return parseGraphTypeRef(type)?.name === "ticket";
}

function ticketCriteria(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const criteria = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) return undefined;
  const ids = criteria
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined,
    )
    .filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : undefined;
}

function portIds(activation: Readonly<NodeActivation>, port: GraphPlanInputPort): string[] {
  const bound = activation.inputs[port.name];
  if (bound === undefined) return [];
  return Array.isArray(bound) ? [...bound] : [bound];
}

/** Lens and branch values of a replicated activation. */
export function graphAgentBranchValues(
  run: Readonly<GraphRun>,
  node: GraphPlanAgentNode,
  activation: Readonly<NodeActivation>,
): { lens?: GraphLens; branch?: { index: number; key: string; count: number } } {
  if (!node.replicate || activation.branchKey === undefined) return {};
  const branches = graphNodeBranches(node, run.bindings.roles) ?? [];
  const position = branches.findIndex((entry) => entry.key === activation.branchKey);
  if (position < 0) return {};
  const branch = branches[position]!;
  const lensAxis = node.replicate.axes.find((axis) => axis.over === "lenses");
  // A template lens wins; otherwise a panel member's own lens (item 214).
  const lens =
    branch.lens !== undefined && lensAxis?.over === "lenses"
      ? lensAxis.lenses.find((entry) => entry.key === branch.lens)
      : panelMemberLens(run, branch);
  return {
    ...(lens ? { lens: { key: lens.key, label: lens.label, instruction: lens.instruction } } : {}),
    branch: { index: position + 1, key: branch.key, count: branches.length },
  };
}

/** The lens a panel member was launched with, keyed by its panel position. */
function panelMemberLens(
  run: Readonly<GraphRun>,
  branch: { role: string; panelIndex?: number },
): GraphLens | undefined {
  if (branch.panelIndex === undefined) return undefined;
  const bound = run.bindings.roles[branch.role];
  const member = Array.isArray(bound) ? bound[branch.panelIndex] : undefined;
  if (!member?.lens) return undefined;
  return {
    key: `panel-${branch.panelIndex + 1}`,
    label: member.lens.label,
    instruction: member.lens.instruction,
  };
}

/**
 * Loads and verifies every input artifact of the activation, and the run's
 * ticket input, into prompt values. Throws {@link GraphAgentPromptError} when
 * an input cannot be verified: a consumer never reads an artifact that fails
 * its checks.
 */
export async function loadGraphAgentInputs(
  run: Readonly<GraphRun>,
  node: GraphPlanAgentNode,
  activation: Readonly<NodeActivation>,
  artifacts: Pick<GraphArtifactStore, "verify">,
): Promise<GraphAgentInputs> {
  const verified = async (id: string, port: string): Promise<GraphArtifact> => {
    // A node's branches share one sealed-file permit (item 301): a reviewer
    // panel hashes the shared package once, not once per reviewer.
    const verification = await artifacts.verify(run.id, id, { permit: node.id });
    if (!verification.ok) {
      throw new GraphAgentPromptError(
        `Input ${port} could not be verified (${verification.code}): ${verification.message}`,
      );
    }
    return verification.artifact;
  };
  const inputs: Record<string, unknown> = {};
  const files: Record<string, GraphPromptFileRef> = {};
  const onDemand: Record<string, GraphPromptArtifactRef[]> = {};
  const consumed: string[] = [];
  const readable = new Map<string, GraphAgentInputArtifact>();
  const sources: Record<string, string> = {};
  const elements: Record<string, GraphPromptElement[]> = {};
  const library = new GraphTypeLibrary(run.plan.types);
  let criterionIds: string[] | undefined;
  let inputWorkspace: GraphAgentInputs["inputWorkspace"];
  const loaded = new Map<string, GraphArtifact[]>();
  // Multi Review's consolidation contract (item 301): issues and coverage gaps
  // are sources of their own kind, as the built-in's text promises.
  const reviewConsolidation = isGraphReviewConsolidationNode(node);
  for (const port of node.inputs) {
    const ids = portIds(activation, port);
    if (ids.length === 0) continue;
    const list: GraphArtifact[] = [];
    const facts: GraphPromptElement[] = [];
    for (const id of ids) {
      const artifact = await verified(id, port.name);
      list.push(artifact);
      consumed.push(id);
      readable.set(id, { port: port.name, artifact });
      const itemIds = graphInputItemIds(library, artifact);
      const review = reviewConsolidation && isReviewReport(artifact.type);
      for (const itemId of itemIds) sources[itemId] = review ? "issue" : artifact.type;
      if (review) {
        for (const gapId of reviewCoverageGapIds(artifact)) sources[gapId] = "coverage-gap";
      }
      facts.push(
        isGraphFailureMarker(port.type, artifact.type)
          ? { failure: true }
          : itemIds.length > 0
            ? { itemIds }
            : {},
      );
    }
    if (facts.some((fact) => fact.failure || fact.itemIds)) elements[port.name] = facts;
    loaded.set(port.name, list);
    const listPort = parseGraphTypeRef(port.type)?.listDepth ? true : ids.length > 1;
    const values = list.map(bodyValue);
    inputs[port.name] = listPort ? values : values[0];
    const first = list[0]!;
    if (port.render === "file" && !listPort && "file" in first.body) {
      files[port.name] = {
        path: first.body.file.path,
        sha256: first.body.file.sha256,
        bytes: first.body.file.bytes,
      };
    }
    if (port.render === "on-demand") {
      onDemand[port.name] = list.map((artifact) => ({ id: artifact.id, bytes: artifact.bytes }));
    }
    if (isTicket(first.type)) criterionIds ??= ticketCriteria(values[0]);
    if (parseGraphTypeRef(first.type)?.name === "workspace" && !listPort) {
      const workspace = values[0] as { branch?: unknown; headRef?: unknown } | undefined;
      if (typeof workspace?.headRef === "string") {
        inputWorkspace = {
          headRef: workspace.headRef,
          ...(typeof workspace.branch === "string" ? { branch: workspace.branch } : {}),
        };
      }
    }
  }
  const values: GraphPromptValues = {
    inputs,
    // An inlined node reads its sub-graph's parameters (item 402).
    params: graphPlanScopeParams(run.plan, node.subgraph, run.bindings.params),
    run: { iteration: activation.iteration },
    ...graphAgentBranchValues(run, node, activation),
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(Object.keys(onDemand).length > 0 ? { artifacts: onDemand } : {}),
    ...(Object.keys(elements).length > 0 ? { elements } : {}),
  };
  const ticketInput = run.plan.inputs.find(
    (input) => isTicket(input.type) && !parseGraphTypeRef(input.type)?.listDepth,
  );
  const ticketId = ticketInput ? run.bindings.inputs[ticketInput.name] : undefined;
  if (ticketId) {
    const ticket = await verified(ticketId, ticketInput!.name);
    values.ticket = bodyValue(ticket);
    criterionIds ??= ticketCriteria(values.ticket);
  }
  const result: GraphAgentInputs = {
    values,
    consumed: [...new Set(consumed)],
    readable,
    sources,
    ...(criterionIds ? { criterionIds } : {}),
    ...(inputWorkspace ? { inputWorkspace } : {}),
  };
  if ("builtIn" in node.prompt) {
    result.builtInInputs = builtInInputs(run, node, loaded);
  }
  return result;
}

function builtInInputs(
  run: Readonly<GraphRun>,
  node: GraphPlanAgentNode,
  loaded: ReadonlyMap<string, GraphArtifact[]>,
): Record<string, GraphBuiltInPromptInputValue | GraphBuiltInPromptInputValue[]> {
  const prompt = node.prompt as { builtIn: string };
  const definition = graphBuiltInPrompt(prompt.builtIn);
  if (!definition) throw new GraphAgentPromptError(`There is no built-in prompt ${prompt.builtIn}`);
  const context = promptContext(run, node);
  const library = context.library;
  const { bound } = graphBuiltInPromptBindings(definition, graphPromptScope(context));
  const result: Record<string, GraphBuiltInPromptInputValue | GraphBuiltInPromptInputValue[]> = {};
  for (const input of definition.inputs) {
    const port = bound.get(input.name);
    const portType = node.inputs.find((candidate) => candidate.name === port)?.type ?? "";
    // Today's builders take the reports themselves: failed branches' markers stay out.
    const artifacts = port
      ? loaded.get(port)?.filter((artifact) => !isGraphFailureMarker(portType, artifact.type))
      : undefined;
    if (!port || !artifacts || artifacts.length === 0) continue;
    const reviewConsolidation = isGraphReviewConsolidationNode(node);
    const values = artifacts.map((artifact): GraphBuiltInPromptInputValue => {
      const itemIds = graphInputItemIds(library, artifact);
      const review = reviewConsolidation && isReviewReport(artifact.type);
      const author = review ? reviewReportAuthor(run, artifact) : undefined;
      const gapIds = review ? reviewCoverageGapIds(artifact) : [];
      return {
        port,
        type: artifact.type,
        artifactId: artifact.id,
        ...("value" in artifact.body && artifact.body.value !== undefined
          ? { value: artifact.body.value }
          : {}),
        ...("file" in artifact.body ? { file: { ...artifact.body.file } } : {}),
        ...(itemIds.length > 0 ? { itemIds } : {}),
        ...(gapIds.length > 0 ? { coverageGapIds: gapIds } : {}),
        ...(author ? { reviewer: author } : {}),
        // A submitted report keeps the provider schema's null placeholders;
        // consolidation reads it as Multi Review accepts a reviewer's report.
        ...(review ? { acceptedReport: true } : {}),
      };
    });
    result[input.name] = input.list ? values : values[0]!;
  }
  return result;
}

function promptContext(run: Readonly<GraphRun>, node: GraphPlanAgentNode) {
  const library = new GraphTypeLibrary(run.plan.types);
  const portTypes: Record<string, GraphValueType> = {};
  const listItems: Record<string, number> = {};
  for (const port of node.inputs) {
    const delivered = port.deliveredType ? valueType(library, port.deliveredType) : null;
    if (delivered) portTypes[port.name] = delivered;
    if (port.fanIn) listItems[port.name] = 32;
  }
  return {
    node: graphPlanAgentTemplateNode(node),
    template: {
      parameters: graphPlanSubgraph(run.plan, node.subgraph)?.parameters ?? run.plan.parameters,
      inputs: run.plan.inputs.map((input) => ({ name: input.name, type: input.type })),
      types: run.plan.types,
    },
    library,
    portTypes,
    listItems,
  };
}

export interface GraphAgentPromptInput {
  run: Readonly<GraphRun>;
  node: GraphPlanAgentNode;
  activation: Readonly<NodeActivation>;
  inputs: GraphAgentInputs;
  compiled: CompiledGraphCapabilities;
  actions: GraphGrantedActions;
  enforcement?: GraphEnforcementTier;
  /** Port → result key of the request the prompt is sent under. */
  resultKeys: Record<string, string>;
  capability?: string;
  resultTools: GraphResultTools;
  targetBranch: string;
  notes?: string;
}

/** The activation's whole prompt, or {@link GraphAgentPromptError}. */
export function renderGraphAgentPrompt(input: GraphAgentPromptInput): string {
  const { node } = input;
  let builtInText: string | undefined;
  if ("builtIn" in node.prompt) {
    const outputs: Record<string, string> = {};
    const definition = graphBuiltInPrompt(node.prompt.builtIn);
    for (const output of definition?.outputs ?? []) {
      const port = node.outputs.find(
        (candidate) =>
          candidate.name === output.name ||
          (output.types ?? []).includes(parseGraphTypeRef(candidate.type)?.name ?? ""),
      );
      if (port) outputs[output.name] = port.name;
    }
    const { lens, branch } = input.inputs.values;
    const scopeParams = graphPlanScopeParams(
      input.run.plan,
      node.subgraph,
      input.run.bindings.params,
    );
    builtInText = graphBuiltInPromptText({
      builtIn: node.prompt.builtIn as GraphBuiltInPromptId,
      inputs: input.inputs.builtInInputs ?? {},
      outputs,
      targetBranch: input.targetBranch,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(lens ? { lens } : {}),
      ...(branch ? { branch: { index: branch.index, count: branch.count } } : {}),
      ...(typeof scopeParams.instruction === "string"
        ? { instruction: scopeParams.instruction }
        : {}),
      ...(typeof scopeParams.reviewInstruction === "string"
        ? { reviewInstruction: scopeParams.reviewInstruction }
        : {}),
    });
  }
  const rendered = renderGraphNodePrompt({
    ...promptContext(input.run, node),
    compiled: input.compiled,
    actions: input.actions,
    ...(input.enforcement ? { enforcement: { tier: input.enforcement } } : {}),
    values: {
      ...input.inputs.values,
      resultKeys: input.resultKeys,
      ...(input.capability ? { capability: input.capability } : {}),
    },
    ...(builtInText !== undefined ? { builtInText } : {}),
    resultTools: input.resultTools,
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new GraphAgentPromptError(
      `The prompt could not be rendered: ${errors
        .slice(0, 4)
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }
  return rendered.prompt;
}
