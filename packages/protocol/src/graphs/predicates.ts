/**
 * Graph predicates (plan P1.4, report §4.4): the JSON conditions behind a
 * node's `when`, a gate's branches, a loop's `until` and an edge's `filter`.
 *
 * The public entry for three modules:
 * - `predicate-shape.ts`: the shape, its structural guard and the path-root
 *   grammar (`params`, `run`, input ports, `<nodeId>.<port>`);
 * - `predicate-typecheck.ts`: scopes and the type checker the compiler runs
 *   against producer schemas;
 * - `predicate-eval.ts`: the total, bounded, three-valued evaluator and the
 *   list filter the runtime runs.
 */
export * from "./predicate-shape.js";
export * from "./predicate-typecheck.js";
export * from "./predicate-eval.js";
