/**
 * Lints: advisory findings that do not stop a template from compiling,
 * collected into the compiler's diagnostics. Prompt lints come from item 105
 * (`lintGraphNodePrompt`, `prompt-*` codes, including the prompt size
 * ceiling), run with the port types the compiler resolved, so list sizes
 * come from the real fan-out instead of the default 32. Template lints are
 * the compiler's own: unused outputs, run inputs and outlets, `run.iteration`
 * outside loops, and workspace nodes without a pinned commit.
 */
import type { GraphCompileState } from "./compile-state.js";
import { portKey } from "./compile-state.js";
import { parseGraphTypeRef } from "./grammar.js";
import type { GraphPredicate } from "./predicate-shape.js";
import { lintGraphNodePrompt } from "./prompt-lint.js";
import type { GraphPromptNodeContext } from "./prompt-scope.js";
import {
  type GraphAgentNode,
  type GraphNodeSpec,
  graphNodeOutlets,
  isGraphRunInputRef,
} from "./template-model.js";
import type { GraphValueType } from "./types.js";

/** The prompt context of an agent node, with the compiler's port types and list sizes. */
export function graphPromptContextFor(
  state: GraphCompileState,
  node: GraphAgentNode,
): GraphPromptNodeContext {
  const portTypes: Record<string, GraphValueType> = {};
  const listItems: Record<string, number> = {};
  for (const port of node.inputs ?? []) {
    const key = portKey(node.id, port.name);
    const type = state.deliveredTypes.get(key);
    if (type) portTypes[port.name] = type;
    if (state.fanInPorts.has(key)) {
      listItems[port.name] = state
        .producersOf(node.id, port.name)
        .reduce(
          (sum, producer) =>
            sum +
            (producer.sourceNode && state.producerTypes.get(producer.id)?.fanIn
              ? (state.branches.get(producer.sourceNode)?.max ?? 1)
              : 0),
          0,
        );
    }
  }
  return {
    node,
    // An inlined node reads its child template's parameters (item 402).
    template: { ...state.template, parameters: state.parametersOf(node.id) },
    library: state.library,
    portTypes,
    listItems,
  };
}

function lintPrompts(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    if (node.kind !== "agent") continue;
    const compiled = state.capabilities.get(node.id);
    const result = lintGraphNodePrompt({
      ...graphPromptContextFor(state, node),
      ...(compiled ? { compiled } : {}),
      ceilingBytes: state.options.promptCeilingBytes,
    });
    const promptPath = "template" in node.prompt ? `${path}.prompt.template` : `${path}.prompt`;
    for (const diagnostic of result.diagnostics) {
      state.diagnostics.push({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        nodeId: node.id,
        path: diagnostic.source?.startsWith("lens:") ? `${path}.replicate` : promptPath,
        ...(diagnostic.port !== undefined ? { port: diagnostic.port } : {}),
        ...(diagnostic.offset !== undefined ? { offset: diagnostic.offset } : {}),
        ...(diagnostic.length !== undefined ? { length: diagnostic.length } : {}),
        ...(diagnostic.source !== undefined
          ? { detail: diagnostic.source }
          : diagnostic.path !== undefined
            ? { detail: diagnostic.path }
            : {}),
      });
    }
    if (result.omitted > 0) state.diagnostics.omitted += result.omitted;
  }
}

function predicatePaths(predicate: GraphPredicate, into: string[] = []): string[] {
  if ("all" in predicate) for (const child of predicate.all) predicatePaths(child, into);
  else if ("any" in predicate) for (const child of predicate.any) predicatePaths(child, into);
  else if ("not" in predicate) predicatePaths(predicate.not, into);
  else into.push(predicate.path);
  return into;
}

function conditionsOf(node: GraphNodeSpec): Array<{ predicate: GraphPredicate; path: string }> {
  const list: Array<{ predicate: GraphPredicate; path: string }> = [];
  if (node.when) list.push({ predicate: node.when, path: "when" });
  if (node.kind === "gate") {
    node.branches.forEach((branch, index) =>
      list.push({ predicate: branch.when, path: `branches[${index}].when` }),
    );
  }
  return list;
}

/** Types that name the commit a node sees (report §6.7 rule 3). */
const PINNING_TYPES = new Set(["workspace", "review-package"]);

function lintTemplate(state: GraphCompileState): void {
  const { diagnostics, template } = state;
  const consumed = new Set<string>();
  const outletsUsed = new Set<string>();
  const inputsUsed = new Set<string>();
  const sources = [
    ...state.edges.map(({ edge }) => edge.from),
    ...state.carries.map((carry) => carry.from),
    ...(template.outputs ?? []).map((output) => output.from),
  ];
  for (const source of sources) {
    if (isGraphRunInputRef(source)) {
      inputsUsed.add(source.input);
    } else if (source.outlet !== undefined) {
      outletsUsed.add(`${source.node}:${source.outlet}`);
    } else {
      consumed.add(portKey(source.node, source.port));
    }
  }
  // A loop's `until` reads `<nodeId>.<port>`: that port decides the loop, so
  // it is consumed even when no edge leaves it.
  for (const loop of template.loops ?? []) {
    for (const path of predicatePaths(loop.until)) {
      const [node, port] = path.split(".");
      if (node !== undefined && port !== undefined) consumed.add(portKey(node, port));
    }
  }
  for (const { node } of state.nodes.values()) {
    for (const port of node.inputs ?? []) {
      const first = port.firstIterationFrom;
      if (first && isGraphRunInputRef(first)) inputsUsed.add(first.input);
    }
  }

  template.inputs.forEach((input, index) => {
    if (inputsUsed.has(input.name)) return;
    diagnostics.add("run-input-unused", `Run input ${input.name} is never read`, {
      path: `inputs[${index}]`,
    });
  });

  for (const { node, path } of state.nodes.values()) {
    if ("outputs" in node) {
      const outputs = node.outputs ?? [];
      const terminal = outputs.every((port) => !consumed.has(portKey(node.id, port.name)));
      if (!terminal) {
        outputs.forEach((port, index) => {
          if (port.name === "error" || consumed.has(portKey(node.id, port.name))) return;
          diagnostics.add(
            "output-unused",
            `Nothing consumes ${node.id}.${port.name}; connect it, or remove the port`,
            { nodeId: node.id, port: port.name, path: `${path}.outputs[${index}]` },
          );
        });
      }
    }
    for (const outlet of graphNodeOutlets(node) ?? []) {
      if (outletsUsed.has(`${node.id}:${outlet}`)) continue;
      diagnostics.add(
        "outlet-unused",
        `Outlet ${outlet} of ${node.id} leads nowhere; when it is taken, the nodes after ${node.id} are skipped`,
        { nodeId: node.id, path },
      );
    }
    if (!state.loopOf.has(node.id)) {
      for (const condition of conditionsOf(node)) {
        if (!predicatePaths(condition.predicate).some((entry) => entry.startsWith("run."))) {
          continue;
        }
        diagnostics.add(
          "iteration-outside-loop",
          `${node.id} is in no loop, so run.iteration is always 1 in its condition`,
          { nodeId: node.id, path: `${path}.${condition.path}` },
        );
      }
    }
    if (node.kind === "agent" && node.workspaceAccess !== "none") {
      const pinned = (node.inputs ?? []).some((port) => {
        const parts = parseGraphTypeRef(port.type);
        return parts !== null && PINNING_TYPES.has(parts.name);
      });
      if (!pinned) {
        diagnostics.add(
          "workspace-unpinned",
          `${node.id} ${node.workspaceAccess === "write" ? "writes" : "reads"} the workspace but takes no workspace@1 (or review package) input, so the commit it sees is not recorded`,
          { nodeId: node.id, path: `${path}.inputs` },
        );
      }
    }
  }
}

/** Every lint, into the compile's diagnostics. */
export function lintGraphTemplate(state: GraphCompileState): void {
  lintTemplate(state);
  lintPrompts(state);
}
