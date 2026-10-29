---
id: 102
title: "Type library and custom types"
phase: 1
plan: "P1.2"
status: not-started
depends_on: [101]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `graphs/types.ts`: built-in types `text`, `markdown`, `ticket`, `workspace`, `validation-plan`, `review-package`, `review-report`, `finding`, `verification-verdict`, `fix-result`, `pr-result`, `pr-description`, `check-summary`, `decision`, `file-list`, `error`, each mapped to its existing schema and domain validator.
- [ ] `ArtifactTypeDef` for custom types: schema, storage class (value or reference), budgets, `items`, `sharedFields`, markdown and summary renderers, `example`.
- [ ] `graphs/schema-subset.ts`: only the keywords `validateWorkflowJsonSchema` supports, plus the cross-provider rules (every property in `required`, nullable for optional, no `pattern`, `$ref` or `oneOf`). Unknown keywords are errors.
- [ ] Assignability rules and named adapters (for example `review-report → finding-list`) for the compiler.
- [ ] "Schema from example": a draft schema from a sample JSON value.

## Tests

- [ ] Every built-in type's schema passes the subset checker, and its example validates.
- [ ] Custom-type errors for each rejected construct.
- [ ] Schema from example produces a schema its own example satisfies.

## Done when

- [ ] The type library is merged with tests and used by [107](107-compiler.md).

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
