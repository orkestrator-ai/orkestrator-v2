---
id: 104
title: "Predicates"
phase: 1
plan: "P1.4"
status: in-progress
depends_on: [101, 102]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-phase1-protocol"
pr: ""
updated: 2026-10-29
---

# 104 · Predicates

- **Plan:** [P1.4 Predicates](../composable-graphs.md#p14-predicates)
- **Decisions:** D10, D14
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Conditions for gates, `when` and loop `until`, written as JSON that forms can build and the compiler can type-check.

## Work

- [x] `graphs/predicates.ts`: the predicate shape and guard, with operators `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `exists`, `empty`, `nonEmpty`, `count`, `all`, `any`, `not`.
- [x] Paths into input artifacts, `params.*` and `run.iteration`.
- [x] A type checker against producer schemas.
- [x] A total evaluator: it never throws, and a missing or unknown value is false. Depth and node count are bounded.
- [x] A list filter for edge `filter` transforms (used by [206](206-gate-merge-loop-failure.md)).

## Tests

- [x] Table tests per operator.
- [x] Type-check errors for bad paths and operator mismatches.
- [x] Evaluator totality over generated inputs.

## Done when

- [x] Predicates are merged with tests and used by [107](107-compiler.md).
- [x] Predicates are used by [206](206-gate-merge-loop-failure.md).

## Notes

**2026-10-29 · Files and exports.** `./graphs/predicates` (no new package export) is now the
public entry and re-exports three browser-safe modules under `packages/protocol/src/graphs/`:
`predicate-shape.ts` (101's AST and structural guard, moved unchanged, plus the path-root
grammar), `predicate-typecheck.ts` (scopes and the type checker) and `predicate-eval.ts` (the
evaluator and list filter). `template.ts`, `template-nodes.ts`, `template-model.ts` and
`examples.ts` import the shape from `predicate-shape.js` so the entry has no import cycle. 101's
shape already covered every operator; nothing in it changed.

**2026-10-29 · Paths and roots.** A path is the 101 dotted grammar. Its root is chosen in this
order: the reserved roots `params` (launch parameters) and `run` (`{iteration}`, 1-based), then
a two-segment root `<nodeId>.<port>` (loop `until`, as in `verify.verdict.complete`), then a
one-segment input port (`report.issues`, or `failures` naming a list port itself). A filter's
path is relative to one list element and has no roots (`params` is then a field name).
`splitGraphPredicatePath(segments, hasRoot)` implements the order for both the checker and the
evaluator. Paths never enter lists: `count`, `empty` and `nonEmpty` test a list, and an edge
`filter` selects elements.

**2026-10-29 · Type checker API (for 107).** Build a scope, then check:
- `graphNodePredicateScope(inputs, parameters, library)` for node `when` and gate branches;
  `inputs` are `GraphPredicatePortRoot {name, type: string | GraphValueType, choices?}`. Pass
  the type the edge delivers (after transforms) and the producing port's `choices`, which
  narrow `decision@N`'s `choice` to an enum.
- `graphLoopPredicateScope(outputs, parameters, library)` for `until`; `outputs` are
  `{node, port, type, choices?}` for the ports produced inside the region.
- `graphFilterPredicateScope(listType)` for an edge `filter`, with the type the filter
  receives; `{ok: false, code: "requires_list", scope}` when it is not a list.
- `checkGraphPredicateTypes(predicate, scope, basePath, errors: FieldErrorCollector)` adds
  diagnostics at `basePath` + the predicate's own path (`nodes[3].when.any[1].op`);
  `typeCheckGraphPredicate(predicate, scope) → FieldValidation<GraphPredicate>` is the
  standalone form. The structural guard runs first; if it fails its errors (101 codes) are
  reported instead. Also exported: `graphPredicateTypeSchema(GraphValueType)` (a list becomes
  an array schema), `graphParamsPredicateSchema(parameters)`, `GRAPH_RUN_PREDICATE_SCHEMA`,
  `GraphPredicateScope`, `GraphPredicateRoot`. A port whose type does not resolve becomes an
  untyped root (`schema: null`): the compiler reports the type at the port, and paths under it
  are not checked again.

**2026-10-29 · Diagnostic codes** (`GRAPH_PREDICATE_TYPE_CODES`):
- `unknown_root` (at `…path`): the first segment(s) name no root in scope.
- `shadowed_root` (at `…path`): an input port or node-port is named `params` or `run`; the
  reserved root wins, so the port cannot be reached. Rename the port.
- `unknown_path` (at `…path`): a field does not exist, or the path continues below a scalar.
- `through_list` (at `…path`): the path continues below a list.
- `operator_type` (at `…op`): the operator does not apply to the field's type: ordering on a
  non-number, `empty`/`nonEmpty` on anything but a list or string, `count` on a non-list,
  `eq`/`neq`/`in` on a list or object (except `eq`/`neq` `null`).
- `value_type` (at `…value` or `…value[i]`): a literal of another primitive type, a fraction
  against an integer field, or `null` against a field that is never null.
- `enum_value` (at `…value` or `…value[i]`): a string outside the field's `enum`/`const`
  (built-in enums such as severity, parameter `options`, decision `choices`).
- `requires_list`: from `graphFilterPredicateScope` only.
`in` with a non-list value, orderings against strings and other shape errors are the guard's
(`type`, `too_few`, …), reported through the checker unchanged.

**2026-10-29 · Evaluator API (for 206 and 213).**
`evaluateGraphPredicate(predicate, {values?, params?, run?}) → GraphPredicateEvaluation {value,
truth: "true"|"false"|"unknown", unknownPaths (≤ 8), error?: {code, message, at}}`. `values`
is a record or `Map` keyed by root name (`report`, `verify.verdict`).
`evaluateGraphElementPredicate(predicate, element)` evaluates a filter predicate on one value.
`filterGraphPredicateList(list, where, {maxItems?}) → {ok, items (same references, in order),
dropped, unknown} | {ok: false, code: not_a_list | too_many_items | <error code>, message,
at?}`; `maxItems` defaults to and is capped at 10 000 (`maxArtifactItems`). Error codes
(`GRAPH_PREDICATE_EVAL_ERROR_CODES`): `malformed` (shape, operand or bound the guard would
reject; text grammar such as control characters is not re-checked), `too_deep` (> 8 levels),
`too_many_nodes` (> 64), `internal` (a value could not be read, e.g. a throwing proxy). With an
error, `value` is false.

**2026-10-29 · Semantics (decision recorded).** Three-valued logic: a leaf is *unknown* when its
value is missing, of the wrong kind for the operator (a list for `eq`, null for `empty`, a
string for `lt`), NaN or infinite, or of another primitive type than every literal (`"80"` vs
`80`; `null` compares with anything). `not` keeps unknown; `all` is false if any child is false,
else unknown if any is; `any` is true if any child is true, else unknown if any is. The
decision is `truth === "true"`, so "missing or unknown is false" holds for the whole predicate
even under `not` (a gate falls to `otherwise`, a loop runs another bounded iteration). `exists`
is never unknown: true for a present non-null JSON value, so absence is
`{not: {path, op: "exists"}}`. `null` is a value for `eq`/`neq`/`in`. Values are read only as
own data properties of plain objects (prototype `Object.prototype` or `null`): getters never
run, `__proto__`/`constructor`/`toString` resolve only when they are own data (as `JSON.parse`
makes them), class instances, functions, bigints and symbols are not values. The predicate is
re-validated by the evaluator (prepared once; a filter prepares once per list), so cyclic or
oversized predicates stop at the depth or node bound. Work per evaluation is bounded by 64
nodes × 16 path segments; list operators use `length` only.

**2026-10-29 · Open box.** "Done when" stays unticked: it needs 107 and 206 to use the API, and
a merged PR.

**2026-10-29 · Used by 107; box split.** The compiler type-checks node `when` and gate branches
with `graphNodePredicateScope` (delivered port types after transforms, decision `choices` from
the producing port), loop `until` with `graphLoopPredicateScope` (member outputs, lifted for
replicated members) and edge filters with `graphFilterPredicateScope`, all through
`checkGraphPredicateTypes`; every finding is `condition-invalid` with the 104 code as `detail`.
The Done-when box is split: the 107 half is ticked, the 206 half stays open.

**2026-10-29 · Code coverage (Phase 1 exit).** `predicate-typecheck.test.ts` "one case per
code" covers every `GRAPH_PREDICATE_TYPE_CODES` entry and `predicate-eval.test.ts` "one case per
error code" every `GRAPH_PREDICATE_EVAL_ERROR_CODES` entry (`internal` from a revoked proxy).
Both tables are typed `Record<Code, …>`, so a new code without a case fails the typecheck, and
a final test asserts every case still produces its code. All codes were already reachable; none
removed. The structural codes come from 101's guard (`predicate-shape.ts`) and are tested in
`predicates.test.ts`.

**2026-10-29 · Used by 206; box ticked.** The gate executor (`graph-node-gate.ts`) chooses its
outlet with `evaluateGraphPredicate` (first branch whose predicate is definitely true, else
`otherwise`), and edge `filter` transforms apply `filterGraphPredicateList` to delivered values
(`graph-edge-transforms.ts`); node `when` and loop `until` already used the evaluator (203).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Path roots, scopes and type checker with diagnostic codes, total three-valued evaluator and list filter, table, type-check, example and generated-input totality tests. · Work and tests done; the Done-when box waits for 107 and 206 to use the API and for the PR.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · 107 uses the type checker; Done-when split, 107 half ticked. · 206 half open.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Typed per-code coverage tables for the type checker and the evaluator. · 206 half of Done-when still open.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · 206 uses the evaluator (gates) and the list filter (edge transforms); 206 half ticked. · complete; awaiting PR
