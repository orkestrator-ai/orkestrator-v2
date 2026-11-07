---
id: 1001
title: "Schema library in packages/protocol: measure and decide"
phase: 1
plan: "§13.8 and §12 Phase 1.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1001 · Schema library in packages/protocol: measure and decide

- **Report:** [§13.8 Schema library](../../docs/reports/unified-federation.md#138-schema-library), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Decision:** 13.8 recommends Zod 4. This item measures it and then records the decision.
- **Depends on:** none
- **Blocks:** [1002](1002-contract-primitives.md)
- **Parallel with:** all of Phase 0 and Phase 2
- **Size:** S
- **Track:** C (contract)

## Goal

Choose the schema library for command and event contracts, using measured renderer bundle cost rather than an estimate, and add it to `packages/protocol`.

## Current state (verified 2026-11-07)

- Zod is a dependency only of `apps/backend` (`"zod": "4.6.7"`, `bun.lock:2471`).
- `packages/protocol` has no `dependencies` block. `apps/web` and `apps/desktop` do not depend on Zod.
- Precedents in command handlers:
  - `apps/backend/src/core/design/commands.ts` (all `.strict()`)
  - `commands-registry-web-annotations.ts`: a schema map `satisfies Record<keyof typeof WEB_ANNOTATION_COMMANDS, z.ZodType>` (:310), with `parse()` at :320-345
- About 30 other backend files use Zod for MCP tool schemas.

## Work

- [ ] Build `apps/web` with a throwaway module that imports, from `packages/protocol`, 20 representative command schemas written three ways:
  - (a) `zod` 4 classic
  - (b) `zod/mini`
  - (c) hand-written guards in the style of `public-api-inputs*.ts`
- [ ] Record the gzip and brotli size deltas of the main chunk, and parse time on the iPad Safari profile if it is reachable.
- [ ] Check that JSON Schema export (`z.toJSONSchema` or the mini equivalent) gives stable output for the manifest digests in [1006](1006-contract-manifest-generator.md).
- [ ] Record the decision with options, pros and cons, and the measured numbers, in this item's Notes and in the report's §13.8.
- [ ] Add the chosen dependency to `packages/protocol/package.json` at the backend's pinned version. Regenerate lockfiles as described in `AGENTS.md`'s "Updating Bun and lockfiles", and run `tests/unit/version-drift.test.ts`.

## Done when

- [ ] The decision is recorded with numbers, and the dependency is in protocol with frozen lockfiles passing.

## Notes

- If the bundle cost is unacceptable, option (c) is a fallback. It costs the JSON Schema export, so [1006](1006-contract-manifest-generator.md) would need hand-kept schema digests. Ask the user before taking (c), because it changes Decision 13.8.
