---
id: 7010
title: "Converge backend and web models on protocol schemas"
phase: 7
plan: "§11.2 Definitions and §11.1"
status: not-started
depends_on: [7003, 7005]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 7010 · Converge backend and web models on protocol schemas

- **Report:** [§11.1](../../docs/reports/unified-federation.md#111-where-skew-actually-is), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [7003](7003-domain-environments-docker.md), [7005](7005-domain-projects-config.md) (they define the core `Environment` and `Project` schemas)
- **Parallel with:** the remaining Phase 7 items, each of which moves its own types
- **Size:** M (rolling)
- **Track:** C (contract)

## Goal

One definition of each core model. `apps/backend/src/core/models.ts` (1,334 lines) and `apps/web/src/types/index.ts` (771 lines, which "mirrors the backend model") shrink to re-exports of inferred protocol types, plus genuinely local types.

## Work

- [ ] For each type in both files, record its owner domain and status (moved / local-only / pending) in a table in Notes. Update the table as each domain item lands.
- [ ] Replace the duplicated types with the inferred types of the protocol's Effect Schemas (`typeof X.Type`, or `Schema.Schema.Type<typeof X>`; Decision 13.8 changed from Zod to Effect on 2026-11-07). Where the web needs a narrower or derived view type, derive it from the protocol type.
- [ ] A test that fails if a type exported from both `models.ts` and `types/index.ts` under the same name is not the same protocol type.

## Done when

- [ ] Neither file defines a wire model that protocol also defines.
