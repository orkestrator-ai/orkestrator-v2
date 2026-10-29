---
id: 102
title: "Type library and custom types"
phase: 1
plan: "P1.2"
status: in-progress
depends_on: [101]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-phase1-protocol"
pr: ""
updated: 2026-10-29
---

# 102 · Type library and custom types

- **Plan:** [P1.2 Type library and custom types](../composable-graphs.md#p12-type-library-and-custom-types)
- **Decisions:** D8, D13
- **Depends on:** [101](101-template-schema.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Every edge payload has a named, versioned type. Built-in types reuse today's schemas and validators. Custom types are limited to schemas every provider accepts.

## Work

- [x] `graphs/types.ts`: built-in types `text`, `markdown`, `ticket`, `workspace`, `validation-plan`, `review-package`, `review-report`, `finding`, `verification-verdict`, `fix-result`, `pr-result`, `pr-description`, `check-summary`, `decision`, `file-list`, `error`, each mapped to its existing schema and domain validator.
- [x] `ArtifactTypeDef` for custom types: schema, storage class (value or reference), budgets, `items`, `sharedFields`, markdown and summary renderers, `example`.
- [x] `graphs/schema-subset.ts`: only the keywords `validateWorkflowJsonSchema` supports, plus the cross-provider rules (every property in `required`, nullable for optional, no `pattern`, `$ref` or `oneOf`). Unknown keywords are errors.
- [x] Assignability rules and named adapters (for example `review-report → finding-list`) for the compiler.
- [x] "Schema from example": a draft schema from a sample JSON value.
- [x] `x-orkestrator-sources` provenance annotation: recognised, recorded, stripped for providers (report §5.9).
- [x] A browser-safe value validator: `validateWorkflowJsonSchema` moved into the protocol, shared by the backend.
- [x] Edge transform result types for `pick`, `filter`, `limit`, `flatten` and `adapt`.
- [x] Type families for port colouring (`graphTypeFamily`).
- [x] `decision@1` choices supplied by the node: `choices` on decision output ports.

## Tests

- [x] Every built-in type's schema passes the subset checker, and its example validates.
- [x] Custom-type errors for each rejected construct.
- [x] Schema from example produces a schema its own example satisfies.

## Done when

- [ ] The type library is merged with tests and used by [107](107-compiler.md).

## Notes

**2026-10-29 · Files and exports.** New browser-safe protocol modules, each with a package
export: `./graphs/types` (library, families, value validation), `./graphs/schema-subset`,
`./graphs/schema-from-example`, `./graphs/type-assignability`; `graphs/type-validators.ts` is
re-exported through `./graphs/types`. Moved into the protocol so the browser runs the same
checks as the backend, with the backend modules re-exporting the old names (no importer
changed): `./workflow-json-schema` (`validateWorkflowJsonSchema`, from
`workflow-result-contracts.ts`), `./review-results` (`REVIEW_FIX_RESULT_JSON_SCHEMA`,
`REVIEW_PR_RESULT_JSON_SCHEMA`, `parseFixResult`, `parsePrResult`, `ReviewFixResult`,
`ReviewPrResult`, from `review-prompts.ts`), and `REVIEW_VALIDATION_PLAN_SCHEMA` into
`review-validation.ts` (from `review-validation-prompts.ts`). Behaviour is unchanged; the
existing workflow-result suites pass unmodified, and
`apps/backend/src/core/graph-types-conformance.test.ts` pins each built-in type that maps a
result kind to that kind's schema and full backend validation.

**2026-10-29 · Built-in types.** `GRAPH_BUILT_IN_TYPE_NAMES`; all version 1 except
`review-package@2` (`REVIEW_PACKAGE_FORMAT`). Each `GraphBuiltInTypeDefinition` has `ref`,
`label`, `description`, `family`, `schema` (frozen clone), `storage`, `budgets`, `items?`,
`itemType?`, `sharedFields?`, `sources`, `render {markdown, summary}`, `example`,
`validator?`, `resultKind?`, `formatter?`. Schemas: `review-report` =
`STRUCTURED_REVIEW_REPORT_JSON_SCHEMA` (items `issues`/`issue`, `itemType: finding@1`, sources
`issues[].reviewSourceIds` and `testCoverageGaps[].reviewSourceIds`, sharedFields = what
`buildConsolidationEvidence` hoists, `formatter: structured-review-report`); `finding` = the
report's issue schema; `verification-verdict` = `VERIFICATION_VERDICT_SCHEMA` (items
`acceptanceCriteria`); `validation-plan` = `REVIEW_VALIDATION_PLAN_SCHEMA` (items `commands`);
`fix-result`/`pr-result` = the moved schemas; `review-package@2` = `ReviewPackageReference`
without the legacy `diffCharacters`, storage `reference`, 16 MiB. New shapes: `text {text}`,
`markdown {markdown}`, `ticket {title, kind|null, description, criteria [{id, text}], comments
[{text}]}` (`graphTicketFromTaskSnapshot`; images are not carried), `workspace {branch,
headRef, baseRef|null}`, `pr-description {title, body}`, `check-summary {state
passed|failed|pending|none, headRef|null, total, pending, failing [{name, conclusion,
detailsUrl|null, summary|null}]}` (`graphCheckSummaryState` maps the PR monitor's rolled-up
state), `decision {choice, rationale}` (`graphDecisionSchema(choices)`), `file-list {files
[{path, reason}]}`, `error {node, cause, code, message, attempts, retryable}` with
`GRAPH_ERROR_CAUSES`. Every root is an object, so predicates and renders address fields.
`resultKind` (validation-plan, review-report, verification-result, fix-result, pr-result) tells
103 which existing kind's backend checks also apply.

**2026-10-29 · Validators.** `GRAPH_BUILT_IN_VALIDATOR_IDS`: `ticket-sections`,
`workspace-commit`, `validation-plan`, `review-package-reference`, `structured-review-report`,
`review-finding`, `verification-verdict`, `fix-result`, `pr-result`, `pr-description`,
`check-summary`, `decision-choice`, `file-list-paths`. Every id has a pure protocol check
wrapping the existing function (`wraps`); `backend` names what only the backend can check and
the existing function where there is one: placeholder prose via `validateWorkflowResult`
(validation-plan, review-report, verification-result, fix-result, pr-result),
`verifyEnvironmentReviewPackage` (package hash), and new runtime checks for 201/207 (commit
exists and is reachable; file paths resolve inside the worktree; plan `headRef` is the
validated HEAD). Context: `GraphTypeValidationContext {choices?, criterionIds?}`. `text`,
`markdown` and `error` have budgets and schema only. `finding@1` uses the report contract
and its budgets but not `report_finding`'s 16 KiB provisional cap, so every issue of a valid
report is a valid finding.

**2026-10-29 · Schema subset (deviation recorded).** Accepted keywords: `type` (one string),
`properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`,
`maximum`, `anyOf`, plus annotations `description`, `title`, `x-orkestrator-sources`.
`minLength`, `maxLength`, `minItems` and `maxItems` are validator keywords but are rejected:
the repository already documents that several providers reject or strip them
(`structured-review/budgets.ts`, `build-pipeline.ts`), so bounds go in budgets, which the
runtime enforces. This is the plan's "intersection with provider subsets", not a change of
decision. Rules: root is an object; every object has `properties`, lists every property in
`required` and sets `additionalProperties: false`; optional = `anyOf [X, {type: null}]`;
`anyOf` 2–8 branches, not at the root, not nested, only annotations beside it; arrays need one
`items` schema; property names follow the path-segment grammar; bounds
`GRAPH_SCHEMA_SUBSET_BOUNDS` (object depth 10, 100 properties per object, 1000 in total, 256
values per enum, 1000 in total). Codes: `unsupported_keyword` (with a hint per well-known
keyword), `not_applicable`, `required`, `type`, `enum`, `not_required`, `unknown_property`,
`duplicate`, `conflict`, `out_of_range`, `not_integer`, `pattern`, `too_few`, `too_many`,
`too_deep`, `too_large`, `empty`, `not_json`. API: `checkGraphSchemaSubset(schema, path,
errors) → GraphSchemaSubsetInfo {sources}`, `validateGraphSchemaSubset(schema)` (paths from
`$`), `graphProviderSchema` (strips `x-orkestrator-sources`), `validateGraphSchemaValue`,
`graphSchemaAtPath(schema, dottedPath) → {schema, nullable} | null` (objects and nullable
wrappers only; 104 can reuse it for path typing), `graphSchemaNonNull`.
`x-orkestrator-sources: true` is valid only on a non-root, array-of-strings property (or its
nullable wrapper); fields are recorded as `{segments, path}` with `[]` for array elements.

**2026-10-29 · Custom types.** `checkArtifactTypeDef` now also rejects built-in names
(`built_in_type`, which 101 had left to 107), runs the subset check under
`types[i].schema`, requires `items.path` to be a never-null list (`unknown_path`,
`not_a_list`), requires `sharedFields` and `render.summary` paths to exist (`unknown_path`),
and validates the example against budgets and schema (issue codes from the value validator,
at `types[i].example…`). Field references and the example are skipped while the schema is
invalid. Storage semantics: a `reference` type's value is a descriptor validated by the
schema and held to the value cap; `maxBytes` bounds the sealed file (201 seals and
hash-verifies it). `maxStringBytes` bounds every string and `maxItems` every array.

**2026-10-29 · Library, assignability and transforms (for 107).** `new
GraphTypeLibrary(template.types)`: `resolve(ref) → {ok, type: GraphValueType} | {ok: false,
code: type_ref|unknown_type|unknown_version}`, `definition(name, version)`, `definitions()`,
`conflicts`. `GraphValueType` = `named {definition}` | `shape {schema, budgets, origin}` (a
transform's anonymous result) | `list {element}`. `graphTypeAssignability(source, target) →
{ok, via: identical} | {ok, via: structural, budgetCheck} | {ok: false, code: cardinality |
version_mismatch | nominal_target | storage_mismatch | schema_mismatch, path?}`. Built-in
targets with a validator are nominal. Because subset objects forbid unknown fields, a
structural fit means the same fields with narrower values (extra fields need `pick`).
Budgets that cannot be proven to fit (a flattened element inherits its parent's byte budget,
as in §9.4) give `budgetCheck: true`: the runtime must apply `graphBudgetIssues(target
budgets)` as the value crosses the edge. Cardinality is the caller's: lift a replicated
producer's output to `list<T>` before asking. `graphEdgeTransformResultType(type, transform,
library)` and `graphEdgeTransformsResultType` (failure carries `index`) with codes
`requires_list`, `unknown_field`, `not_a_list`, `too_deep`, `unknown_adapter`,
`adapter_mismatch`; `filter`'s predicate is typed by 104 against the element. Adapters
(`graphTypeAdapters`, `graphTypeAdapter`, `applyGraphTypeAdapter`,
`suggestGraphTypeAdapters`): `review-report-to-finding-list`, `review-report-to-markdown`,
`ticket-to-markdown`, `fix-result-to-file-list`, `text-to-markdown`, `markdown-to-text`;
over a list they map element-wise and list-producing ones concatenate. Applying `pick`,
`filter`, `limit` and `flatten` to values is left to the runtime (202/213) with 104's
evaluator.

**2026-10-29 · Families, values, renders.** `graphTypeFamily(ref, library?)` →
`GRAPH_TYPE_FAMILIES` (`text`, `ticket`, `report`, `workspace`, `decision`, `package`,
`error`, `list`, `unknown`); custom types are `report`, or `package` when stored by reference.
`validateGraphArtifactValue(definition, value, context)` is the one produced-value check:
budgets (`graphBudgetIssues`, content-free messages), then schema (narrowed by `choices` for
decisions), then the protocol domain check. Built-in markdown renders use only `{{a.b}}` and
`{{#list}}…{{/list}}`; 105 must support dotted names and list sections, and may prefer
`formatter` where set. `draftGraphSchemaFromExample(value) → {schema, notes} | errors`
(`type`, `pattern`, `inconsistent_fields`, `too_deep`, `too_many`, `not_finite`, …).

**2026-10-29 · Open box.** "Done when" stays unticked: it needs 107 (not started) to use the
library, and a merged PR.

**2026-10-29 · Template change.** Output ports take `choices?: string[]` (2–32 distinct
enum-grammar values, `decision@N` only, else `not_applicable`): the report's "choice enum
supplied by the node". The §9.3 judge declares its lens keys.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Type library, validators, schema subset, schema from example, assignability, transforms, adapters, families, custom-type guard, decision choices; shared validators moved into the protocol; tests. · Work and tests done; the Done-when box waits for 107 to use the library and for the PR.
