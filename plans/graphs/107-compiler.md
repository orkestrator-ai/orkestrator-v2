---
id: 107
title: "Compiler"
phase: 1
plan: "P1.7"
status: not-started
depends_on: [101, 102, 104, 105, 106]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 107 · Compiler

- **Plan:** [P1.7 Compiler](../composable-graphs.md#p17-compiler)
- **Decisions:** D3, D4, D8, D9, D10, D11, D12
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md), [104](104-predicates.md), [105](105-prompt-templates.md), [106](106-capability-profiles.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A pure compiler that turns a template into a frozen, hashed plan, or explains exactly what is wrong with it.

## Work

- [ ] `graphs/compile.ts`: `compile(template, {types, providers}) → {plan, diagnostics, cost}`. The plan is normalised and carries a digest. Diagnostics carry a node or edge ID, a code and a severity.
- [ ] Checks: cycles outside loops; loops without a bound; type and cardinality; required inputs; producers on mutually exclusive gate branches; condition paths; workspace concurrency (D3); replicated writers; push or GitHub capabilities on agent nodes (D12); taint reaching side effects; unmet `minEnforcement`; prompt size; limits.
- [ ] `graphs/cost.ts`: best-case and worst-case agent sessions and peak parallelism.
- [ ] Port option `firstIterationFrom` for loops (report §9.2).
- [ ] `graphs/lint.ts` collects prompt and template lints into the same diagnostics.
- [ ] Reference checks the template guard leaves to the compiler (see [101](101-template-schema.md) Notes), and rejection of `subgraph` nodes until [402](402-subgraphs.md).

## Tests

- [ ] One test per diagnostic code.
- [ ] The report §9 examples compile.
- [ ] The digest is stable across key order and layout changes.

## Done when

- [ ] The compiler is merged with tests and every diagnostic code is documented in this file's notes.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
