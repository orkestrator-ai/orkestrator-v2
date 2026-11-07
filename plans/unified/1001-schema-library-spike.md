---
id: 1001
title: "Schema library in packages/protocol: measure and decide"
phase: 1
plan: "§13.8 and §12 Phase 1.1"
status: in-progress
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1001 · Schema library in packages/protocol: measure and decide

- **Report:** [§13.8 Schema library](../../docs/reports/unified-federation.md#138-schema-library), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Decision:** 13.8 is settled: Effect Schema (`effect/Schema`, `effect` 4.1.2). The user chose it on 2026-11-07 over the earlier Zod 4 recommendation. This item measured it against Zod 4, `zod/mini` and hand-written guards and recorded the decision.
- **Depends on:** none
- **Blocks:** [1002](1002-contract-primitives.md)
- **Parallel with:** all of Phase 0 and Phase 2
- **Size:** S
- **Track:** C (contract)

## Goal

Choose the schema library for command and event contracts, using measured renderer bundle cost rather than an estimate, and add it to `packages/protocol`.

## Current state (verified 2026-11-07)

- `effect` 4.1.2 (exact pin) is a dependency of `packages/protocol`, `apps/web`, `apps/desktop` and `apps/backend` (commit `846b4aee7`). The root `bun.lock` and the Claude bridge lockfile install frozen with no changes, and `tests/unit/version-drift.test.ts` passes.
- Zod stays a dependency only of `apps/backend` (`"zod": "4.6.7"`). Existing Zod users:
  - `apps/backend/src/core/design/commands.ts` (all `.strict()`)
  - `commands-registry-web-annotations.ts`: a schema map `satisfies Record<keyof typeof WEB_ANNOTATION_COMMANDS, z.ZodType>` (:310), with `parse()` at :320-345
  - about 30 other backend files, for MCP tool schemas.
  Phase 7 converts these to Effect Schema or bridges them (both libraries implement Standard Schema).

## Work

- [x] Build `apps/web` with a throwaway module that imports, from `packages/protocol`, 20 representative command schemas (10 commands, args and result each) written four ways:
  - (a) Effect Schema (`effect/Schema`)
  - (b) `zod` 4 classic
  - (c) `zod/mini`
  - (d) hand-written guards in the style of `public-api-inputs*.ts` and `commands-validation.ts`
  - plus a minimal Effect runtime import (`Effect`, `Scope`, `Exit`, `Context`, `Layer`), alone and with (a).
- [x] Record the gzip and brotli size deltas of the main chunk and of total JS (Notes).
- [ ] Parse time on the iPad Safari profile. Not possible on this host: no iPad is reachable from it.
- [x] Check that JSON Schema export (`Schema.toJsonSchemaDocument`) gives stable output for the manifest digests in [1006](1006-contract-manifest-generator.md). Pinned by `packages/protocol/src/effect-json-schema.test.ts`.
- [x] Record the decision with options, pros and cons, and the measured numbers, in this item's Notes and in the report's §13.8.
- [x] Add the chosen dependency to `packages/protocol/package.json` (`effect` 4.1.2, exact). Regenerate lockfiles as described in `AGENTS.md`'s "Updating Bun and lockfiles", and run `tests/unit/version-drift.test.ts`.

## Done when

- [x] The decision is recorded with numbers, and the dependency is in protocol with frozen lockfiles passing.

## Notes

### Measurements (2026-11-07)

Method: production `vite build` of `apps/web` (Vite 8.3.4) with a throwaway Vite config that wrapped `apps/web/vite.config.ts` and prepended an import of the variant module to `src/main.tsx`. Each variant module lived in a git-ignored folder under `packages/protocol`, resolved `effect` and `zod` from there, and exposed its `parse(name, value)` on `globalThis` so nothing was tree-shaken away. Effect decoded with `Schema.decodeUnknownSync`, Zod with `.parse`, mini with `z.parse`. All four variants agreed on a set of accept and reject cases before measuring. Sizes use Bun 1.4.4 `node:zlib` with the settings of `apps/web/scripts/precompress.ts` (gzip level 9, brotli quality 11). No `package.json` or `bun.lock` was changed for the measurement, and every throwaway file was deleted.

Baseline: entry chunk `index-*.js` 14,516 B raw, 6,511 B gzip, 5,677 B brotli; the lazily loaded `renderer-entry-*.js` chunk is about 457 KB gzip; total JS about 5.97 MB gzip over 270 files (most of it Monaco and its workers).

| Variant | Entry chunk Δ raw | Entry Δ gzip | Entry Δ brotli | Total JS Δ gzip | Total JS Δ brotli |
|---|---:|---:|---:|---:|---:|
| (a) Effect Schema | +80,305 | +26,027 | +23,377 | +26,068 | +23,333 |
| (b) Zod 4 classic | +88,354 | +25,006 | +21,858 | +25,086 | +21,713 |
| (c) `zod/mini` | +25,185 | +7,783 | +7,000 | +7,853 | +6,672 |
| (d) hand-written guards | +5,318 | +1,708 | +1,549 | +1,819 | +1,158 |
| Effect runtime only | +33,018 | +11,509 | +10,434 | +11,553 | +10,414 |
| Effect Schema + runtime | +87,229 | +28,466 | +25,560 | +28,547 | +25,479 |

Bytes. The total-JS delta matches the entry delta to within about 100 bytes, so nothing else moved. Effect Schema and the runtime share about 9 KB gzip of core: 26.0 + 11.5 separately against 28.5 together.

**Budget.** Neither this item nor the report set a number. The threshold used was at most 50 KB gzip added to the startup JS for the schema library and the runtime together. That is about 10% of the 457 KB gzip `renderer-entry` chunk and under 1% of total JS. It is a one-time cost that is cached, and it is about the size of the cost the plan already accepted when it recommended Zod 4. Effect Schema with the runtime (+28.5 KB gzip, +25.6 KB brotli) is within it. Variant (d) loses the JSON Schema export, so it was not a candidate unless the others failed the budget.

**iPad Safari parse time:** not done, because no iPad is reachable from this host.

**Status (2026-11-07, orchestrator, completeness check).** The item is open only for the iPad measurement (no iPad reachable from this host). Every other box, including Done when, is met; `status` is `in-progress` because one box is open, not `done`.

### JSON Schema stability

`Schema.toJsonSchemaDocument(schema, options?)` returns `{ dialect: "draft-2020-12", schema, definitions }`, and `$ref`s point at `#/$defs/<identifier>`. `packages/protocol/src/effect-json-schema.test.ts` pins that:

- the same schema, and an identically built one, export byte-identical JSON;
- the exported document matches a pinned literal, so an `effect` upgrade that changes the output fails the test, and every manifest digest would change with it;
- output follows declaration order for `properties` and `required`. [1006](1006-contract-manifest-generator.md) must digest a canonical form, with object keys sorted and `required` sorted. Other arrays keep their order, because union order affects decoding. With that form, declaring fields in a different order gives the same digest;
- a schema with an `identifier` annotation that is reused gives one definition. Two separately built schemas with the same identifier give `Environment` and `Environment_1`, so each named schema must be one shared constant.

Rules for contract schemas that follow from the export:

- Use `Schema.Finite` for wire numbers. `Schema.Number` exports `anyOf` number and the strings `"Infinity"`, `"-Infinity"` and `"NaN"`. `Schema.Int` exports the safe-integer range.
- Use `Schema.optionalKey` for optional fields. `Schema.optional` exports `anyOf [T, null]`, because its JSON codec reads `null` as `undefined`.
- `Schema.isPattern` exports a `pattern` only when the RegExp has the `u` flag.
- Decoding drops unknown keys by default (`onExcessProperty: "ignore"`), which is the tolerant-reader rule in §11.2. `{ onExcessProperty: "error" }` is the strict option for both the decoder and the export.
- `Arbitrary.schema(schema)` (from `effect/Arbitrary`, with no fast-check dependency) can generate the argument fixtures for the contract CI job in §11.3.

### Decision

**Effect Schema (`effect/Schema`, `effect` 4.1.2) in `packages/protocol`.** Approved by the user on 2026-11-07, in one combined PR. The full options, pros and cons are in the report's [§13.8](../../docs/reports/unified-federation.md#138-schema-library).

- If the bundle cost later proves unacceptable, option (d) is the fallback. It costs the JSON Schema export, so [1006](1006-contract-manifest-generator.md) would need hand-kept schema digests. Ask the user before taking (d), because it changes Decision 13.8.

## Work log

- 2026-11-07 (claude-worker): checked the `effect` 4.1.2 dependency from `846b4aee7` (frozen root and bridge installs report no changes; `tests/unit/version-drift.test.ts` passes). Measured seven `apps/web` production builds (baseline, four schema variants, Effect runtime alone and with Effect Schema) with throwaway modules that were deleted afterwards. Added `packages/protocol/src/effect-json-schema.test.ts` (5 pass); protocol typecheck, oxlint and format are clean. Recorded the decision here and in report §13.8, and moved the report's design text from Zod to Effect Schema. The iPad Safari parse time stays open: no iPad is reachable from this host.
- 2026-11-07 (orchestrator, completeness check): `status: done` contradicted the open "Parse time on the iPad Safari profile" box; set `status: in-progress`, open only for the iPad measurement (no iPad reachable from this host). Note added.
