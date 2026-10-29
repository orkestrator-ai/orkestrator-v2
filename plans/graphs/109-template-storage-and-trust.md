---
id: 109
title: "Template storage and trust"
phase: 1
plan: "P1.9"
status: not-started
depends_on: [101, 107]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 109 · Template storage and trust

- **Plan:** [P1.9 Template storage and trust](../composable-graphs.md#p19-template-storage-and-trust)
- **Decisions:** D2, D18
- **Depends on:** [101](101-template-schema.md), [107](107-compiler.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Templates are stored, versioned and trusted in the three scopes of D2, under the per-project ceiling of D18.

## Work

- [ ] Add `graph-templates` to `STORE_LAYOUTS` (`storage-stores.ts`): user templates with revision compare-and-swap.
- [ ] Load built-ins from code.
- [ ] Read project templates from `.orkestrator/graphs/*.graph.json` in the project's checkout, and re-read them when files change.
- [ ] Trust records per project as `{path, digest, approvedAt}`. A changed digest is untrusted again.
- [ ] Per-project capability ceiling. The default allows every agent capability up to the environment's policy. Push and GitHub writes are outside it (D12).
- [ ] Commands in `commands-registry-graphs.ts`: `graph_templates_list`, `graph_template_get`, `graph_template_save`, `graph_template_delete`, `graph_template_duplicate`, `graph_template_compile`, `graph_template_import`, `graph_template_export`, `graph_template_trust`.

## Tests

- [ ] Save conflicts on a stale revision.
- [ ] Trust resets when a project template's digest changes.
- [ ] The ceiling narrows a template's profiles, and a template asking for push is rejected.
- [ ] Command tests for each command.

## Done when

- [ ] Templates can be saved, listed, compiled, imported, exported and trusted through backend commands.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
