---
id: 2012
title: "Lint boundary: transports only from a scope"
phase: 2
plan: "§7.6"
status: done
depends_on: [2010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] A source guard `direct-transport-import`: imports of `@/lib/native/backend`, `@/lib/native/events` and `@/lib/native/authoritative-events` outside `apps/web/src/lib/node-scope/**` and `lib/backend/**`, counted per file in `baseline.json`.
- [x] Extend the federation `no-restricted-imports` block to `lib/node-scope/**` consumers that must use scopes, if a whole-directory ban fits any directory now. Repeat the base patterns.
- [x] Document the rule in `docs/development/linting.md`.

## Done when

- [x] A new direct import fails `tests/unit/source-guards.test.ts`, and the baseline is committed.

## Notes

- **Guard (`tests/source-guards/direct-transport-import.ts`, 2026-11-07).** A production-source guard (`productionRoots: ["apps/web/src"]`, as 2010's `window-orkestrator-direct`). It counts, per file, each value import, `export … from`, `export * from` and literal `import("…")` of a transport module. The transports are `lib/native/backend` (`invoke`), `lib/native/events` (`listen`), `lib/native/authoritative-events` (`listenAuthoritative`) and `lib/native/node-transport` (`createNodeTransport`). The window global's transport members (`window.orkestrator.invoke`, `listen`, `eventStreamReady`, `eventStreamConnection`, `node`, `nodes`) are already held at zero by 2010's `transportAccesses` assertion, so this guard does not count them again. Specifiers are resolved with a new shared helper, `tests/source-guards/web-modules.ts` (`resolveWebModule(fromFile, specifier)` for the `@/` alias and relative paths, `moduleIdOfFile`, `moduleReferences(program, source)`, `dynamicImportOf`, `bringsValues`). So `../native/events` counts, and `@/lib/native/events-helpers` does not. Type-only imports (`import type`, `import { type X }`, `export type … from`) reach nothing and are not counted.
- **Deviation: `lib/native/**` is exempt too (2026-11-07).** The item names only `lib/node-scope/**` and `lib/backend/**`. `lib/native` is the adapter layer that defines these transports and builds them on one another: `authoritative-events` on `events`, `web-gateway` and `window-shell` on `node-transport`. Counting those would make entries that can never reach zero without moving the wrappers themselves. `apps/web/src/test/**` (in-tree test helpers, not matched by `isTestSource`) is exempt as in 2010.
- **Also counted: `node-transport`.** The orchestrator's brief for this wave lists `createNodeTransport` as a transport. Its only importers outside `lib/node-scope` are in `lib/native` (exempt) and `lib/acp-client.ts`, whose import is type-only, so it adds no entries today. It stops new ones.
- **Baseline (2026-11-07):** 45 imports in 40 files, made with `bun tests/source-guards/update-baseline.ts --guard direct-transport-import`. Only this guard's section was added, and the other five guards' entries were checked unchanged by diffing the parsed JSON. The scan reads the shared worktree, so the count includes other agents' uncommitted files from this wave. One of them is the untracked `apps/web/src/lib/node-scope-slots.ts` from 3016 (2 entries). **The orchestrator should rerun `--guard direct-transport-import` once the wave's commits land**, so the committed baseline matches the committed tree.
- **Whole-directory bans (`.oxlintrc.json`, a file outside this item's set; minimal additive change).** These directories had no transport importer, test files aside: `components/chat`, `components/native-agent`, `components/pane-layout`, `components/projects`, `components/sidebar` and `contexts`. One new override bans the four transport paths there (with `allowTypeImports`, matching the guard) and repeats the renderer's base patterns, because overrides replace one another. Test files stay exempt through the later test override (checked: `components/chat/*.test.tsx` that import `@/lib/native/backend` still lint clean, and a probe production file there fails). Options considered: (a) a ban only on directories already at zero (chosen); (b) widening the federation block's `@/lib/backend` ban, which would wrongly refuse the typed command clients, the sanctioned path until 3002; (c) `lib/chat`, also at zero, which is left out because 3016 is editing it in this wave. Add it, and `stores/` once `previewServiceStore.ts` moves, in a later pass.
- **Ratchet messages** now suggest `update-baseline.ts --guard <id>`, so a regeneration cannot also absorb another guard's findings.
- **Effect.** Not used. This is a static scan in test tooling, with no lifetimes, retries or typed failures.
- **Pre-existing failures.** `tests/unit/source-guards.test.ts`'s repository ratchet still fails only on the other guards' findings in untouched test files (as recorded by 2010). It has no finding or stale entry for `direct-transport-import`.

## Work log

- 2026-11-07 (claude-worker): added the `direct-transport-import` guard and the shared `web-modules.ts` resolver, registered the guard, and committed its baseline section only (`--guard`). Added the whole-directory `no-restricted-imports` override for six directories at zero. Documented "Transports only through a scope" and the `--guard` workflow in `docs/development/linting.md`. Tests in `tests/unit/source-guards.test.ts`: flagged forms (alias, relative, re-export, `export *`, side-effect, `import()`), ignored forms (type-only, `lib/backend`, other wrappers, lookalikes), applicability, a new direct import fails the committed baseline, an existing importer may not add one, production-only scan, and module resolution. 36 pass; 1 fails, the repository ratchet, on the other guards' pre-existing findings only.
