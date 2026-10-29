/**
 * The built-in templates (D2, D5): shipped in code, read-only, duplicable.
 *
 * Item 109 reads built-ins only through {@link graphBuiltinTemplates}; item
 * 108 describes them (`graphs/builtins/`) and registers each one here by
 * adding its factory to {@link GRAPH_BUILTIN_TEMPLATE_FACTORIES}. Until then
 * the list is empty and the library shows user and project templates only.
 */
import type { GraphTemplateV1 } from "./template-model.js";

/**
 * One factory per built-in template, each returning a fresh `GraphTemplateV1`
 * with `engine` set (Multi Review, Build Pipeline, Looped Review). Ids must be
 * unique and each template must pass `validateGraphTemplate`: the backend
 * skips (and logs) a built-in that does not.
 */
const GRAPH_BUILTIN_TEMPLATE_FACTORIES: ReadonlyArray<() => GraphTemplateV1> = [];

/** Fresh copies of every built-in template, in registration order. */
export function graphBuiltinTemplates(): GraphTemplateV1[] {
  return GRAPH_BUILTIN_TEMPLATE_FACTORIES.map((factory) => structuredClone(factory()));
}
