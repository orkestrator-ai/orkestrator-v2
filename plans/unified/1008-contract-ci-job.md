---
id: 1008
title: "Contract CI job against the support window"
phase: 1
plan: "§11.3 steps 3 and 5 and §12 Phase 1.4"
status: done
depends_on: [1007, 1009]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1008 · Contract CI job against the support window

- **Report:** [§11.3 Manifests and CI](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1007](1007-release-snapshots-and-backfill.md), [1009](1009-domain-clients-and-adapters.md)
- **Blocks:** [1010](1010-pilot-node-mail-and-ticket-sync.md) exit, and all of Phase 7
- **Size:** M
- **Track:** C (contract)

## Goal

On every PR, CI proves that the current code still serves every client in the support window, and still has a client adapter for every backend in it.

## Current state (verified 2026-11-07)

- The floor rule (`version-compatibility.md:14-46`): the newest Stable release published at least 60 days ago, otherwise v2.21.0.
- The register (`version-compatibility.md:120-216`) has 56 rows with columns `Path | Where | Counter | Serves | Retire when | Owner`. Nothing tests it today.
- Usage counter ids are in `COMPATIBILITY_PATH_IDS` (`apps/backend/src/core/compatibility-path-usage.ts:21`).

## Work

Stage 1, enabled with this item:

- [x] Compute the floor from `contracts/releases/index.json` and today's date (injected, for tests).
- [x] For every (domain, version) that appears in any in-window snapshot, assert a client adapter exists. Adapters are listed in a committed `contracts/adapters.json`, written by the adapter registry in [1009](1009-domain-clients-and-adapters.md).
- [x] Assert that no command in an in-window snapshot disappeared without a domain bump and a register row naming it.
- [x] Register consistency: every register row with a counter names an id in `COMPATIBILITY_PATH_IDS`, and every domain bump has a row.

Stage 2, enabled when the first domain other than the pilot converts:

- [x] For every defined command in an in-window snapshot, generate argument fixtures from its old schema and assert that the current backend's parser accepts them. Run this through the real `register(def)` parser, not a copy. Built behind `CONTRACT_CI_STAGE_2` (off); turning it on is [7001](7001-domain-native-sessions.md)'s box.
- [x] Flag a new required field without a version bump. Built behind the same switch.
- [x] Old argument schemas are kept (`contracts/schemas/`, written by `mise run contract:manifest`, checked in stage 1), so stage 2 has them when it is turned on.

## Tests

- [x] Each check has a failing fixture: a missing adapter, a removed command, a new required field, and a register row without a counter id.

## Done when

- [x] Stage 1 runs on every PR in the same workflow as `contract:check`. Stage 2 is listed as a box on [7001](7001-domain-native-sessions.md).

## Notes

### Decisions (2026-11-07)

- **Files.** `scripts/contract-ci.ts` (the job, `mise run contract:ci`), `scripts/contract-ci-register.ts` (the register read as data), `scripts/contract-ci-schemas.ts` (argument schema store, stage 2 fixtures, the sandboxed registry child), `tests/unit/contract-ci.test.ts`. CI: one step, "Check the contract against the support window", after `contract:adapters:check` in `ci.yml`'s Lint job (the same job as `contract:check`). `contract:manifest` gained a third step, `bun scripts/contract-ci-schemas.ts`.
- **Floor.** `supportFloor(index, now)`: the newest (by version) `stable` index entry whose `publishedAt` is at least 60 days before `now`, otherwise v2.21.0. `publishedAt: null` is never the floor; the window (`windowReleases`) is every index entry at or above the floor, unpublished ones included (1007's rule). `--now <ISO date>` runs the job as on another day; tests pin the documented transitions (v2.21.1 on 2026-12-15 after 16:49 UTC, v2.22.3 on 2026-12-16, v2.23.0 on 2026-12-18). The job also fails when `releases/index.json` and the `releases/*.json` files disagree or an in-window snapshot does not verify (`readReleaseSnapshot`). It does not call GitHub: `contract:backfill -- --check` (needs `gh` and the network) stays out of CI.
- **Adapters.** A release speaks each domain it has commands in at its advertised version, or 0. Options for a domain with **no client** in `adapters.json`: (a) fail for every (domain, version), (b) exempt it, (c) exempt version 0 only. (a) fails today for all 29 domains (the list is empty); (c) would fail at the next `release:version` because `system` v1 (`record_domain_adapter_usage`) has no client and the renderer calls it by name. Chose (b): such a domain is called through the untyped invoke, which is version 0 for every peer, so it is checked from the day it gets a client; a versioned domain that left `DOMAIN_NAMES` always fails. The check asks for the exact version a release speaks (the item's wording and the retirement rule "adapter v goes when the floor passes v + 1"), not merely an overlap with the release's `[min, version]`.
- **Removed commands.** A command of an in-window snapshot that the current manifest lacks needs a row (Register or Retired) naming it as a code span, and its domain at a higher version now than in that release. The bump is not required when the domain is unversioned on both sides (an untyped domain cannot be bumped without converting a command) or the snapshot has no domain for it (`unmapped`: pre-contract names the backfill's map did not place). On this tree that left the 18 Looped Review commands removed by #1417 (2026-10-29, first in v2.34.4-beta) and in v2.21.0 to v2.34.3-beta; I added one **Retired** row for them in `version-compatibility.md` (outside this item's docs section; the prompt-queue and `export_build_pipeline_for_downgrade` removals already had rows).
- **Register conventions** (parsed from the document, nothing new to maintain): rows under `## Register` up to `### Retired` are register rows (56 today), rows under `### Retired` are retired rows. A row *names* something it holds as a code span. Counter ids are the dotted lowercase code spans of the Counter cell (file names excluded); a cell starting "None" has none. Failures: a Counter cell with no id, an id neither in `COMPATIBILITY_PATH_IDS` nor a well-formed `domain-adapter.*` id, a register row without six cells. A **domain bump** is a domain whose current version is above the version an in-window release advertises; it needs a register row naming `domain-adapter.<renderer|backend>.<domain>.v<old>` (the old adapter's counter id, which also satisfies the counter check). A register row naming a domain adapter that `adapters.json` no longer has fails ("move the row to Retired"). A domain below an in-window release's version also fails. Introducing a domain (0 to 1) is not a bump. The reverse check (every `COMPATIBILITY_PATH_IDS` id has a row) was not added: `slash-catalogue.outdated-bridge` and `bridge-close.upgrade-required` are permanent counters described in prose.
- **Argument schema store** (a deviation: not in the report). Manifests and snapshots keep only `argsDigest`, and the "old schema" of stage 2 cannot be recovered from a digest. Options: (a) re-run old releases' registries from their tags in CI (minutes, like the backfill); (b) put the schemas in the manifest (1006's format, being extended by 7011); (c) a content-addressed store next to the snapshots. Chose (c): `packages/protocol/contracts/schemas/<hex16>.json` = `{ schemaVersion, digest, document }` with the canonical document (`canonicalJson(Schema.toJsonSchemaDocument(args))`, so the digest is the manifest's). Written by `mise run contract:manifest` from the real registry (sandboxed child); a file is removed only when no registry command, manifest entry or snapshot blob references it, so a release's schemas outlive the code. Stage 1 fails when a defined command of the current manifest or an in-window snapshot has no stored schema, so the store is complete before stage 2 is turned on. One file today (`record_domain_adapter_usage`).
- **Stage 2 switch.** `CONTRACT_CI_STAGE_2 = false` in `scripts/contract-ci.ts`; *(2026-11-07, orchestrator, completeness check: stale: stage 2 is now on, `CONTRACT_CI_STAGE_2 = true` in `scripts/contract-ci.ts`, set by [7001](7001-domain-native-sessions.md).)* 7001 sets it to `true` (its box "Turn on contract CI stage 2"). `--stage2` runs it now (passes: no in-window snapshot has a defined command yet). For each (command, old digest) of an in-window release whose command is still defined and whose domain has not been bumped since: `checkNewRequiredFields` compares the stored documents (`required` through `properties`, `items` and local `$ref`s; `anyOf`/`oneOf` branches are not compared), and fixtures are generated from the old document (`SchemaRepresentation.fromJsonSchemaDocument` with `patterns: "apply"` because the documents are committed, then `Arbitrary.schema`, 25 samples seeded by command and digest, sent through `JSON.stringify`/`parse` as on the wire) and decoded in a sandboxed child by `decodeCommandArgs` with the definition the real `createCommandRegistry()` registered (`registry.contracts`), which is the decode `register(def, handler)` runs before its handler. No handler runs. A bumped domain is skipped: it may refuse an older version's arguments by design.
- **Known limits of stage 2**, for 7001: a command converted from untyped to defined has no old schema (an older client's untyped arguments are not fixture-checked); a check the JSON Schema export cannot express is lost in the stored document, so a fixture may be refused for a reason the old schema did not state (a false positive to fix in the schema or the export when it appears); events (7011) are not compared.
- **Effect.** Used only in stage 2: `effect/Arbitrary`, `effect/SchemaRepresentation` and `Effect.runSync`, resolved at run time from `packages/protocol` (`Bun.resolveSync`), because the repository root does not depend on `effect` and `tests/tsconfig.json` covers `scripts/`; the narrow `FixtureGenerator` interface keeps the script typed. Stage 1 is plain JSON and arithmetic in a root script (no services, scopes or typed failures needed); problems are strings because the script prints them.
- **Docs.** `version-compatibility.md#the-manifest-the-ratchet-and-ci` ("Commands", "Contract CI job", including the schema store and stage 2) and step 5 of "How to add a command".
- **For the orchestrator:** (1) concurrent items that add defined commands (1010) must run `mise run contract:manifest` after this commit and commit the new `packages/protocol/contracts/schemas/*.json`, or `contract:ci` fails with "No stored argument schema"; (2) eight rows at the end of `version-compatibility.md`'s Register (`Renderers that build, deliver and prune "Continue in..." handoffs` to `seed: false`, after the "Not governed by the window" list) have no table header, so Markdown renders them as text; the job reads them as register rows, and they should move up into the table; (3) the report's §11.3 could mention the schema store.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `scripts/contract-ci.ts` (`supportFloor`, `windowReleases`, `checkReleaseIndex`, `checkAdapters`, `checkRemovedCommands`, `checkDomainRegister`, `neededArgumentDigests`, `checkNewRequiredFields`, `fixtureCases`, `runContractCi`, `CONTRACT_CI_STAGE_2`), `scripts/contract-ci-register.ts` (`parseRegisterDocument`, `rowCounterIds`, `rowAdapters`, `checkRegisterCounters`), `scripts/contract-ci-schemas.ts` (store: `documentDigest`, `schemaStoreFile`, `readStoredSchema`, `checkSchemaStore`, `writeSchemaStore`, `runWriteSchemaStore`; stage 2: `newRequiredFields`, `loadFixtureGenerator`, `runArgumentFixtures`, `runFixturesInChild`), the first stored schema, the `contract:ci` task and the `contract:manifest` step, the CI step, the Looped Review Retired row and the docs. `tests/unit/contract-ci.test.ts` passes 25 (with `contract-untyped-ratchet.test.ts`, 42), including a real-registry child run where an older schema's fixture is refused. `mise run contract:ci` passes on this tree (floor v2.21.0, 31 releases in the window); `--stage2` passes. `mise tasks validate`, oxlint, `bun fmt`, backend typecheck clean; `tests/tsconfig.json` reports only the 3 known errors in web component tests.
- 2026-11-07 (orchestrator, completeness check): marked the "stage 2 off" note stale: `CONTRACT_CI_STAGE_2 = true` since 7001.
