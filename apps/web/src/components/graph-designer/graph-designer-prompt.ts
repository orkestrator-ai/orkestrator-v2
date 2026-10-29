import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  type GraphPromptNodeContext,
  type GraphPromptScope,
} from "@orkestrator/protocol/graphs/prompts";
import { graphSchemaNonNull } from "@orkestrator/protocol/graphs/schema-subset";
import {
  isGraphRunInputRef,
  type GraphAgentNode,
  type GraphNodeSpec,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";

/**
 * The prompt editor's pure parts (item 212, report §7.3): the node's prompt
 * context with real list sizes, the variables its template may use (from the
 * input types' schemas and the run's own values), and `{{` autocompletion.
 */

const MAX_BRANCHES = 32;

function branchMax(
  template: GraphTemplateV1,
  node: GraphNodeSpec,
  plan: CompiledGraphPlan | null,
): number {
  const planned = plan?.nodes.find((entry) => entry.id === node.id);
  if (planned && (planned.kind === "agent" || planned.kind === "subgraph"))
    return planned.fanOut.max;
  if ((node.kind !== "agent" && node.kind !== "subgraph") || !node.replicate) return 1;
  const axes = node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
  return axes.reduce((product, axis) => {
    switch (axis.over) {
      case "lenses":
        return product * axis.lenses.length;
      case "samples":
        return product * axis.count;
      case "items":
        return product * axis.maxBranches;
      case "panel":
        return (
          product *
          (template.roles.find((role) => role.key === axis.role)?.maxPanel ?? MAX_BRANCHES)
        );
    }
  }, 1);
}

/** The node's prompt context; fan-in ports count the producers' real branches, as the compiler does. */
export function graphPromptContextFor(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  node: GraphAgentNode,
  plan: CompiledGraphPlan | null,
): GraphPromptNodeContext {
  const listItems: Record<string, number> = {};
  for (const port of node.inputs ?? []) {
    let total = 0;
    for (const edge of template.edges) {
      if (edge.to.node !== node.id || edge.to.port !== port.name || edge.zip) continue;
      if (isGraphRunInputRef(edge.from) || edge.from.outlet !== undefined) continue;
      const producer = template.nodes.find(
        (entry) => entry.id === (edge.from as { node: string }).node,
      );
      if (
        producer &&
        (producer.kind === "agent" || producer.kind === "subgraph") &&
        producer.replicate
      ) {
        total += branchMax(template, producer, plan);
      }
    }
    if (total > 0) listItems[port.name] = total;
  }
  return { node, template, library, listItems };
}

export interface GraphPromptSuggestion {
  /** What goes between the braces: `input.report.issues`, `> input.report`. */
  insert: string;
  /** Shown in the list. */
  label: string;
  detail: string;
}

type Schema = Record<string, unknown>;

function fieldPaths(
  schema: Schema | undefined,
  prefix: string,
  depth: number,
  out: Array<{ path: string; type: string }>,
) {
  if (!schema || depth <= 0 || out.length >= 200) return;
  const inner = graphSchemaNonNull(schema).schema;
  if (inner.type !== "object" || !inner.properties || typeof inner.properties !== "object") return;
  for (const [name, child] of Object.entries(inner.properties as Record<string, Schema>)) {
    const path = `${prefix}.${name}`;
    const childInner = graphSchemaNonNull(child).schema;
    const type =
      typeof childInner.type === "string"
        ? childInner.type
        : Array.isArray(childInner.anyOf)
          ? "any of"
          : "value";
    out.push({ path, type: type === "array" ? "list" : type });
    fieldPaths(child, path, depth - 1, out);
  }
}

/** Every variable and partial the node's template can use, from its scope. */
export function graphPromptVariableSuggestions(scope: GraphPromptScope): GraphPromptSuggestion[] {
  const suggestions: GraphPromptSuggestion[] = [];
  for (const port of scope.ports.values()) {
    suggestions.push({
      insert: `> input.${port.name}`,
      label: `> input.${port.name}`,
      detail: `${port.typeLabel}, rendered as ${port.mode}`,
    });
    suggestions.push({
      insert: `input.${port.name}`,
      label: `input.${port.name}`,
      detail: port.typeLabel,
    });
    const schema = scope.sources.get(`input.${port.name}`)?.schema;
    if (port.listDepth === 0) {
      const fields: Array<{ path: string; type: string }> = [];
      fieldPaths(schema, `input.${port.name}`, 3, fields);
      for (const field of fields)
        suggestions.push({ insert: field.path, label: field.path, detail: field.type });
    }
  }
  for (const parameter of scope.params.values()) {
    suggestions.push({
      insert: `params.${parameter.key}`,
      label: `params.${parameter.key}`,
      detail: `launch parameter (${parameter.type})`,
    });
  }
  suggestions.push({
    insert: "run.iteration",
    label: "run.iteration",
    detail: "loop iteration, from 1",
  });
  if (scope.bound.has("lens")) {
    for (const field of ["key", "label", "instruction"]) {
      suggestions.push({
        insert: `lens.${field}`,
        label: `lens.${field}`,
        detail: "this branch's lens",
      });
    }
  }
  if (scope.bound.has("branch")) {
    for (const field of ["index", "key", "count"]) {
      suggestions.push({
        insert: `branch.${field}`,
        label: `branch.${field}`,
        detail: "this branch",
      });
    }
  }
  for (const root of ["ticket", "item"] as const) {
    if (!scope.bound.has(root)) continue;
    suggestions.push({
      insert: root,
      label: root,
      detail: root === "ticket" ? "the run's ticket" : "this branch's item",
    });
    const fields: Array<{ path: string; type: string }> = [];
    fieldPaths(scope.sources.get(root)?.schema, root, 2, fields);
    for (const field of fields)
      suggestions.push({ insert: field.path, label: field.path, detail: field.type });
  }
  return suggestions;
}

export interface GraphPromptCompletion {
  /** Offset of the opening `{{`. */
  start: number;
  /** A section/partial sigil typed after the braces (`#`, `^`, `/`, `>`), if any. */
  sigil: string;
  /** What has been typed of the name so far. */
  prefix: string;
}

/** The unfinished `{{…` tag the caret is in, if any. */
export function graphPromptCompletionAt(text: string, caret: number): GraphPromptCompletion | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open < 0) return null;
  const typed = before.slice(open + 2);
  if (typed.includes("}}") || typed.includes("\n") || typed.length > 128) return null;
  const match = /^([#^/>!]?)\s*([A-Za-z0-9_.-]*)$/.exec(typed);
  if (!match || match[1] === "!") return null;
  return { start: open, sigil: match[1] ?? "", prefix: match[2] ?? "" };
}

export function filterGraphPromptSuggestions(
  suggestions: readonly GraphPromptSuggestion[],
  completion: GraphPromptCompletion,
  limit = 12,
): GraphPromptSuggestion[] {
  const partial = completion.sigil === ">";
  const prefix = completion.prefix.toLowerCase();
  return suggestions
    .filter((suggestion) => suggestion.insert.startsWith(">") === partial)
    .filter((suggestion) => suggestion.insert.replace(/^>\s*/, "").toLowerCase().startsWith(prefix))
    .slice(0, limit);
}

/** Completes the tag at the caret with `suggestion`, closing it when it is not closed yet. */
export function applyGraphPromptCompletion(
  text: string,
  caret: number,
  completion: GraphPromptCompletion,
  suggestion: GraphPromptSuggestion,
): { text: string; caret: number } {
  const name = suggestion.insert.replace(/^>\s*/, "");
  const sigil = suggestion.insert.startsWith(">") ? "> " : completion.sigil;
  const after = text.slice(caret);
  const closed = /^[A-Za-z0-9_.-]*\}\}/.exec(after);
  const rest = closed ? after.slice(closed[0].length) : after;
  const tag = `{{${sigil}${name}}}`;
  return {
    text: `${text.slice(0, completion.start)}${tag}${rest}`,
    caret: completion.start + tag.length,
  };
}
