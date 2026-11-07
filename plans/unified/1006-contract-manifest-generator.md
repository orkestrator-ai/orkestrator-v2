---
id: 1006
title: "Contract manifest generator with --check"
phase: 1
plan: "§11.3 step 1 and §12 Phase 1.4"
status: not-started
depends_on: [1003]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `scripts/generate-contract-manifest.ts [--check]`. It loads the registry the same way the secret sweep does and writes, sorted and stable:
  - `domains`: the version and min accepted, per domain;
  - `commands`: name → `{domain, since, access, read, critical, argsDigest, resultDigest}` for defined commands, or `{domain, untyped: true, read}` for the rest;
  - `events` (from [7011](7011-typed-events.md), empty until then).
- [ ] `apps/backend/src/core/contract-domain-map.ts`: an explicit domain for every string-registered command, seeded from Appendix E's grouping by registering file. Any command missing from the map makes the generator fail. This is how new commands are forced to pick a domain.
- [ ] Digests: SHA-256 of the canonical JSON Schema export from [1001](1001-schema-library-spike.md).
- [ ] `read` for untyped commands comes from the existing classifier `isNodeReadCommand` (`packages/protocol/src/command-nodes.ts:596-601`).
- [ ] mise tasks `contract:manifest` and `contract:check`. Add `contract:check` to the CI workflow that already runs `verify:codex:protocol`.

## Tests

- [ ] Generator unit test on a fake registry: stable order, digest stability, a missing domain map entry fails, and `--check` detects drift.

## Done when

- [ ] The manifest is committed, `contract:check` runs in CI, and the runtime command count replaces the report's estimate in Notes.
