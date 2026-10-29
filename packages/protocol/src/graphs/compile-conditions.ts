/**
 * Compiler pass: condition paths (report §5.10). Node `when`, gate branches
 * and loop `until` are type-checked against the schemas of what actually
 * arrives (edge transforms applied, replicated producers lifted to lists,
 * decision `choices` narrowing `choice`); edge `filter` predicates against
 * one element of the list they receive (called from compile-ports).
 */
import { FieldErrorCollector } from "../field-validation.js";
import type { GraphDiagnosticLocation } from "./compile-diagnostics.js";
import { type GraphCompileState, portKey } from "./compile-state.js";
import {
  checkGraphPredicateTypes,
  graphFilterPredicateScope,
  graphLoopPredicateScope,
  graphNodePredicateScope,
  type GraphPredicatePortRoot,
  type GraphPredicateScope,
} from "./predicate-typecheck.js";
import type { GraphPredicate } from "./predicate-shape.js";
import { graphListType, type GraphValueType } from "./types.js";
import { type GraphNodeSpec, isGraphRunInputRef } from "./template-model.js";

function reportPredicate(
  state: GraphCompileState,
  predicate: GraphPredicate,
  scope: GraphPredicateScope,
  path: string,
  at: GraphDiagnosticLocation,
): void {
  const errors = new FieldErrorCollector(20);
  checkGraphPredicateTypes(predicate, scope, path, errors);
  for (const error of errors.errors) {
    state.diagnostics.add("condition-invalid", error.message, {
      ...at,
      path: error.path,
      detail: error.code,
    });
  }
}

/** The `choices` of the decision port feeding an input, when exactly one does. */
function producerChoices(
  state: GraphCompileState,
  node: string,
  port: string,
): string[] | undefined {
  const choices = state.producersOf(node, port).map((producer) => {
    const from = producer.from;
    if (isGraphRunInputRef(from) || from.outlet !== undefined) return undefined;
    const source = state.nodes.get(from.node)?.node;
    if (!source || !("outputs" in source)) return undefined;
    return source.outputs?.find((output) => output.name === from.port)?.choices;
  });
  const first = choices[0];
  return first !== undefined && choices.every((entry) => entry === first) ? first : undefined;
}

function inputRoots(state: GraphCompileState, node: GraphNodeSpec): GraphPredicatePortRoot[] {
  return (node.inputs ?? []).flatMap((port) => {
    const type =
      state.deliveredTypes.get(portKey(node.id, port.name)) ??
      state.inputTypes.get(portKey(node.id, port.name));
    if (type === undefined) return [];
    const choices = producerChoices(state, node.id, port.name);
    // An unresolved type stays a root (paths under it are not re-checked).
    return [
      {
        name: port.name,
        type: type ?? port.type,
        ...(choices ? { choices } : {}),
      },
    ];
  });
}

/** `when`, gate branches and loop `until`. */
export function checkGraphConditions(state: GraphCompileState): void {
  const parameters = state.template.parameters;
  for (const { node, path } of state.nodes.values()) {
    const needsScope = node.when !== undefined || node.kind === "gate";
    if (!needsScope) continue;
    const scope = graphNodePredicateScope(inputRoots(state, node), parameters, state.library);
    const at = { nodeId: node.id };
    if (node.when !== undefined) reportPredicate(state, node.when, scope, `${path}.when`, at);
    if (node.kind === "gate") {
      node.branches.forEach((branch, index) =>
        reportPredicate(state, branch.when, scope, `${path}.branches[${index}].when`, at),
      );
    }
  }
  for (const { loop, index } of state.loops.values()) {
    const outputs = [...state.loopOf]
      .filter(([, owner]) => owner === loop.id)
      .flatMap(([member]) => {
        const node = state.nodes.get(member)?.node;
        if (!node || !("outputs" in node)) return [];
        return (node.outputs ?? []).map((port) => {
          const declared = state.outputTypes.get(portKey(member, port.name));
          const type: GraphValueType | string =
            declared === null || declared === undefined
              ? port.type
              : state.isReplicated(member)
                ? graphListType(declared)
                : declared;
          return {
            node: member,
            port: port.name,
            type,
            ...(port.choices ? { choices: port.choices } : {}),
          };
        });
      });
    const scope = graphLoopPredicateScope(outputs, parameters, state.library);
    reportPredicate(state, loop.until, scope, `loops[${index}].until`, { loopId: loop.id });
  }
}

/** An edge `filter`, against one element of the list it receives. */
export function checkGraphFilterPredicate(
  state: GraphCompileState,
  predicate: GraphPredicate,
  received: GraphValueType,
  path: string,
  at: GraphDiagnosticLocation,
): void {
  const scope = graphFilterPredicateScope(received);
  // A non-list is reported by the transform's own type check.
  if (!scope.ok) return;
  reportPredicate(state, predicate, scope.scope, path, at);
}
