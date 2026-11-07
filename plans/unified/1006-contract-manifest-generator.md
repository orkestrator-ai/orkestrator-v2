---
id: 1006
title: "Contract manifest generator with --check"
phase: 1
plan: "§11.3 step 1 and §12 Phase 1.4"
status: done
depends_on: [1003]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1006 · Contract manifest generator with --check

- **Report:** [§11.3 Manifests and CI](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1003](1003-backend-register-overload.md)
- **Blocks:** [1007](1007-release-snapshots-and-backfill.md), [1011](1011-contract-policy-and-docs.md)
- **Size:** M
- **Track:** C (contract)

## Goal

A committed `packages/protocol/contracts/manifest.json` describes every registered command. Defined commands carry schema digests; string-registered ones carry their assigned domain and `untyped: true`. CI fails when the manifest drifts from the code.

## Current state (verified 2026-11-07)

- Model to copy:
  - `apps/backend/src/core/commands-secret-sweep-test-support.ts:117-184` imports `./commands.js` in a child process with a stubbed `fetch` and a temporary home directory, calls `createCommandRegistry()` with no options, and iterates `Array.from(commands.keys()).sort()`.
  - A generator needs only that, plus the `contracts` map from [1003](1003-backend-register-overload.md).
- `--check` precedent: `scripts/generate-codex-app-server-protocol.ts`.
  - It parses arguments at :61-67, regenerates into a temporary directory, and compares digests and method sets (:415-500).
  - Tasks: `codex:protocol`, `codex:protocol:check` and `verify:codex:protocol` (`mise.toml:168-174, 454-457`).
- The report's total of 995 commands cannot be checked statically. Grep finds 904 unique literal names, plus names registered through constants and loops. The generator gives the runtime count.

## Work

- [x] `scripts/generate-contract-manifest.ts [--check]`. It loads the registry the same way the secret sweep does and writes, sorted and stable:
  - `domains`: the version and min accepted, per domain;
  - `commands`: name → `{domain, since, access, read, critical, argsDigest, resultDigest}` for defined commands, or `{domain, untyped: true, read}` for the rest;
  - `events` (from [7011](7011-typed-events.md), empty until then).
- [x] `apps/backend/src/core/contract-domain-map.ts`: an explicit domain for every string-registered command, seeded from Appendix E's grouping by registering file. Any command missing from the map makes the generator fail. This is how new commands are forced to pick a domain.
- [x] Digests: SHA-256 of the canonical JSON Schema export from [1001](1001-schema-library-spike.md).
- [x] `read` for untyped commands comes from the existing classifier `isNodeReadCommand` (`packages/protocol/src/command-nodes.ts:596-601`).
- [x] mise tasks `contract:manifest` and `contract:check`. Add `contract:check` to the CI workflow that already runs `verify:codex:protocol`.

## Tests

- [x] Generator unit test on a fake registry: stable order, digest stability, a missing domain map entry fails, and `--check` detects drift.

## Done when

- [x] The manifest is committed, `contract:check` runs in CI, and the runtime command count replaces the report's estimate in Notes.

## Notes

### Runtime command count (2026-11-07)

The generator counts **996 registered commands** (0 defined, 996 untyped) on this branch, *(2026-11-07, orchestrator, completeness check: these are the counts when this item ran. At `0134c2671` the committed manifest has 999 commands, 999 defined and 0 untyped, after Phase 7.)* against the report's estimate of 995 (Appendix E) and the 904 unique literal names grep finds. The registry is the same under `NODE_ENV=production` and `test` and has no platform-conditional registration, so the manifest does not differ between CI and macOS.

### Decisions (2026-11-07)

- **Manifest shape.** `packages/protocol/contracts/manifest.json` is `{ schemaVersion: 1, generatedBy, counts: { commands, defined, untyped }, untypedByDomain, domains, commands, events }`. Every object is sorted by key. `domains` comes from the registry's `domainRanges` (only domains with a defined command, as the hello advertises them), written as `{ version, min }`. `critical` is sorted. `events` is `{}` until 7011. A defined command's entry has no `untyped` key, so `untyped === true` is the test for an untyped command.
- **Cheap untyped count for 1011.** `counts.untyped` and `untypedByDomain` (only domains that have untyped commands) are derived totals at the top of the file, so a ratchet reads them without walking `commands`. `untypedCommandCounts(manifestTextOrObject)` in the script returns `{ total, byDomain }` and refuses an unknown `schemaVersion`. `--check` compares the whole text, so the totals cannot drift from `commands`. 1011's `untyped-baseline.json` can be compared against `untypedByDomain` directly.
- **Digests.** `sha256:<hex>` of `canonicalJsonSchema(schema)`: `JSON.stringify` of the canonical form of the whole `Schema.toJsonSchemaDocument` result (dialect, schema and definitions), with object keys sorted, `required` sorted (only when it is an array of strings) and every other array kept in order. The canonical form lives in `packages/protocol/src/contract/json-schema.ts` (`canonicalJson`, `canonicalJsonSchema`, subpath `@orkestrator/protocol/contract/json-schema`, also re-exported from `./contract`), not in the script. Two reasons: 1007 (release snapshots) and the contract CI job must digest the same text, and the repository root does not depend on `effect`, so a root script cannot import `effect/Schema` itself. The module is browser-safe; hashing (`node:crypto`) stays in the script. The test pins one canonical text and its digest, next to 1001's pinned export.
- **Domain map rules.** `CONTRACT_DOMAIN_MAP` is `{ [domain]: sorted command names }` (`satisfies ContractDomainMap`, so a domain outside `DOMAIN_NAMES` is a type error, and the generator checks it again at run time). The generator fails, listing every finding, when a string-registered command has no entry, when an entry names a command that is not registered, when an entry names a command registered with its definition (the definition carries the domain, so converting a command means deleting its entry), and when a command is listed twice. Options considered for the redundant-entry case: allow it when it matches the definition (smaller diffs while converting) or refuse it (the map stays the exact untyped surface). Chose refusing: the map and `untypedByDomain` then always agree, and the error says what to do.
- **Seeding.** File-level from Appendix E's grouping (the per-file counts reproduce Appendix E's group totals, for example nodes 67 + ticket-sync 6 + backend-profile 2 = 75 and native 41 + prompts 20 + sessions 24 + suborks 2 = 87). Appendix E's groups are coarser than `DOMAIN_NAMES`, so a file was split by command name where it clearly serves several domains:
  - `commands-registry-nodes.ts`: `node-mail` (mail delivery, outbox, action requests, `get_node_project_coordinator`, `get_worker_request_state`, `record_node_environment_origin`) and `node-files` (stat/read/write, transfers), as listed in 1010; the rest `nodes`. 1010's lenient neighbours follow it: `coordinator-mail-attachments.ts` and `coordinator-node-coordinator-mail.ts` are `node-mail`, `coordinator-node-tickets.ts` is `ticket-sync`.
  - `commands-registry-projects.ts`: config and settings commands are `config`; `cursor_sdk_login_*` and `get_plan_usage` are `accounts`; the model catalog commands are `agent-servers`; `greet` and the resource revision manifests are `system`; the rest `projects`.
  - `commands-registry-terminal.ts`: file commands are `files`, git status and diff stats are `git`, the rest `terminals`.
  - `commands-registry-pr.ts`: the local agent server and bridge commands are `agent-servers` (like `commands-registry-servers.ts`); the rest `pull-requests`.
  - Judgement calls: `commands-registry-github.ts` (GitHub issues) is `pull-requests`, the GitHub API surface, since `DOMAIN_NAMES` has no `github`; `commands-registry-sessions.ts` stays `native-sessions` as in Appendix E; `commands-registry-user-commands.ts` is `terminals` (it runs shell commands with input) and `commands-registry-workflow-results.ts` is `pipelines`; `commands-registry-client-state.ts` and `commands-registry-permission-rules.ts` are `config`; `commands-registry-backend-profile.ts` is `nodes`; `commands-host-files.ts` and `agents-md-commands.ts` are `projects`.
  - A command's domain is only a starting point: adopting `defineCommand` picks the domain for real and removes the entry.
- **New domain `public-api`** added to `DOMAIN_NAMES` (now 29 names) for Appendix E's "Public API (`public_action`)" group: `public_action` has its own per-action versioning (Appendix F) and fits no other domain.
- **Registry loading.** The script spawns itself (`--child <file>`, internal) with `process.execPath --no-env-file`, a constructed environment (temporary HOME, XDG and TMPDIR, an empty PATH, `NODE_ENV=production`, nothing inherited), cwd in the temporary directory, a refusing `fetch`, and `createCommandRegistry()` with no options. No command runs. A 60 s timeout and 1 MiB output cap bound it. The child takes about 0.4 s.
- **Output formatting.** The serializer writes what `bun fmt` keeps (objects expanded, a scalar array inline when the line fits 100 columns, counting the trailing comma), so `format:check` and `contract:check` never fight. Checked by running `bun fmt` on boundary samples (lines of exactly 100 and 101 columns, last and not-last keys). The only array is `critical` (at most 16 names of at most 64 characters).
- **`--check`** regenerates and compares the text. On a difference it lists commands, domains and events added, removed or changed, and otherwise reports a format or totals difference. It never writes.
- **CI.** No workflow runs `verify:codex:protocol` itself. `ci.yml` runs `codex:protocol:check` through `test:full`'s `codex-protocol` group. `contract:check` is a step in `ci.yml`'s Lint job, next to the other repository-wide guards that need no build. It was not added to `scripts/test-all.ts` (outside this item's files).
- **Test location.** The generator test is `apps/backend/src/core/contract-manifest.test.ts`, not under `tests/` or `scripts/`: the fake definitions need `effect`, which only the packages depend on (there is precedent for backend tests importing root scripts).
- **Effect.** Effect Schema only, through `Schema.toJsonSchemaDocument` in `contract/json-schema.ts`. The generator is a plain script (promises, `child_process`). Nothing here needs services, scopes or typed failures; `ContractManifestError` is a plain `Error` with a `problems` list because the script prints it and exits.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `scripts/generate-contract-manifest.ts`, `apps/backend/src/core/contract-domain-map.ts` (996 commands over 29 domains), `packages/protocol/src/contract/json-schema.ts` (+ `./contract/json-schema` export and index re-export), `public-api` in `DOMAIN_NAMES`, the `contract:manifest` and `contract:check` mise tasks, the CI step, and the generated `packages/protocol/contracts/manifest.json`. `apps/backend/src/core/contract-manifest.test.ts` passes 13 tests (33 with `commands-registry-contracts.test.ts`); protocol contract tests pass 46; `domain-import-boundaries.test.ts` passes. `mise run contract:check` passes, and fails as expected with an entry removed from the map. Backend and protocol typecheck clean; `tests/tsconfig.json` reports only 3 errors in web component tests owned by another item (`appDialogStore` `nodeId`). `bun fmt`, `oxlint` and `mise tasks validate` clean.
- 2026-11-07 (orchestrator, completeness check): noted the current manifest counts (999 defined, 0 untyped) beside the 996/0/996 recorded when the generator was built.
