---
id: 7014
title: "Move the remaining Zod schemas (MCP tools, design service) to Effect Schema"
phase: 7
plan: "§13.8 (Effect Schema) and §12 Phase 7"
status: not-started
depends_on: [7004]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 7014 · Move the remaining Zod schemas (MCP tools, design service) to Effect Schema

- **Report:** [§13.8 Schema library](../../docs/reports/unified-federation.md#138-schema-library), [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan)
- **Decision:** 13.8 is Effect Schema (the user's choice, 2026-11-07). This item removes the second schema system that remains after the domain conversions.
- **Depends on:** [7004](7004-domain-previews-annotations-artifacts-design.md), which converted the design and web-annotation *command* schemas and left the design service's own parsing and the tool schemas.
- **Size:** M
- **Track:** C (contract)

## Goal

`zod` leaves `apps/backend`. Every schema in the backend is an Effect Schema, so the project has one schema system.

## Current state (verified 2026-11-07)

Found while doing [7004](7004-domain-previews-annotations-artifacts-design.md): 35 non-test files in `apps/backend/src` still import `zod`.

- MCP and agent tool input schemas (29 files): `agent-tools*.ts`, `control-mcp-*.ts`, `build-pipeline-key-information-tools.ts`, `graph-agent-tools.ts`, `scheduled-jobs/tools.ts`, `ticket-tool-fields.ts`, `transcript-artifacts/tools.ts`, `web-annotation-tools.ts`, `workflow-result-tools.ts`, `design/tools.ts`.
- The design service's own parsing (6 files): `design/schemas.ts`, `records.ts`, `intents.ts`, `history.ts`, `library.ts`, `errors.ts`.
- The MCP server SDK in use accepts the JSON Schema an Effect Schema exports, so tool registration does not need Zod.

## Work

- [ ] Convert the design service's parsing modules to Effect Schema, keeping user-facing error text.
- [ ] Add one helper that registers an MCP tool from an Effect Schema (JSON Schema for the tool listing, `decodeUnknown` for the call), and convert every tool file to it.
- [ ] Remove `zod` from `apps/backend/package.json` and regenerate the lockfiles as `AGENTS.md` describes.
- [ ] A test (or source guard) that fails if a file in `apps/backend/src` imports `zod`.

## Tests

- [ ] Each tool's existing tests pass, and its listed input schema is unchanged in meaning (a snapshot of the exported JSON Schema per tool, reviewed once).
- [ ] The design service's parsing tests pass with the same messages.

## Done when

- [ ] No backend file imports `zod`, and `zod` is not a dependency of any package.

## Notes

- 2026-11-07 (orchestrator): created from 7004's finding, because the user asked that no second schema system be left without a plan. Until this item is done, Zod remains in exactly the 35 files above; the contract layer (`packages/protocol/src/contract/**`) uses only Effect Schema.

## Work log
