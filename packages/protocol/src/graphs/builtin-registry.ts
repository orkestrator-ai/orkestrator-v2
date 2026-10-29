/**
 * The built-in templates (D2, D5): shipped in code, read-only, duplicable.
 *
 * Item 109 reads built-ins only through {@link graphBuiltinTemplates}; item
 * 108 describes them in `graphs/builtins/`, and each one is registered here.
 */
import {
  GRAPH_BUILT_IN_TEMPLATE_IDS,
  graphBuiltInTemplate,
  type GraphBuiltInEngineStatus,
} from "./builtins/index.js";
import type { GraphTemplateV1 } from "./template-model.js";

/**
 * One factory per built-in template, each returning a fresh `GraphTemplateV1`
 * with `engine` set (Multi Review, Build Pipeline, Looped Review). Ids must be
 * unique and each template must pass `validateGraphTemplate`: the backend
 * skips (and logs) a built-in that does not.
 */
const GRAPH_BUILTIN_TEMPLATE_FACTORIES: ReadonlyArray<() => GraphTemplateV1> =
  GRAPH_BUILT_IN_TEMPLATE_IDS.map((id) => () => graphBuiltInTemplate(id)!.template);

/**
 * Whether a built-in's engine still runs the flow. A `retired` built-in
 * (Looped Review) can only be duplicated onto the graph runtime.
 */
export function graphBuiltinEngineStatus(id: string): GraphBuiltInEngineStatus | undefined {
  return graphBuiltInTemplate(id)?.engineStatus;
}

/** Fresh copies of every built-in template, in registration order. */
export function graphBuiltinTemplates(): GraphTemplateV1[] {
  return GRAPH_BUILTIN_TEMPLATE_FACTORIES.map((factory) => structuredClone(factory()));
}
