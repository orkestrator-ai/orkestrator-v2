---
id: 2012
title: "Lint boundary: transports only from a scope"
phase: 2
plan: "§7.6"
status: not-started
depends_on: [2010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2012 · Lint boundary: transports only from a scope

- **Report:** [§7.6 Lint boundaries](../../docs/reports/unified-federation.md#76-lint-boundaries)
- **Depends on:** [2010](2010-command-scope-wiring.md)
- **Parallel with:** Phase 3
- **Size:** S
- **Track:** S (scopes)

## Goal

New code cannot reach a backend except through a scope. Existing violations are counted and only fall.

## Current state (verified 2026-11-07)

- `.oxlintrc.json` (468 lines) :111-157 has an `overrides` block for `apps/web/src/lib/federation/**` and `components/federation/**`.
  - It uses `no-restricted-imports` with `paths` (`@/lib/native/backend`, `@/lib/backend`, `@/lib/native/events`, `@/lib/native/authoritative-events`) and `patterns`.
  - An override replaces the rule's settings rather than merging them, so every block repeats the base patterns (`node:*`, `bun:*`, `@orkestrator/protocol/node/*` with `allowTypeImports`, `@orkestrator/protocol/testing/*`).
  - Tests and support files are exempt at :305-322.
- oxlint here has built-in plugins only, so counts need a source scan. The precedent is `tests/source-guards/` (`guard.ts`, `scan.ts`, `baseline.ts`, `baseline.json`, `update-baseline.ts`; enforced by `tests/unit/source-guards.test.ts`).
- Lint-boundary tests: `tests/unit/domain-import-boundaries.test.ts`.

## Work

- [ ] A source guard `direct-transport-import`: imports of `@/lib/native/backend`, `@/lib/native/events` and `@/lib/native/authoritative-events` outside `apps/web/src/lib/node-scope/**` and `lib/backend/**`, counted per file in `baseline.json`.
- [ ] Extend the federation `no-restricted-imports` block to `lib/node-scope/**` consumers that must use scopes, if a whole-directory ban fits any directory now. Repeat the base patterns.
- [ ] Document the rule in `docs/development/linting.md`.

## Done when

- [ ] A new direct import fails `tests/unit/source-guards.test.ts`, and the baseline is committed.
