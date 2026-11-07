---
id: 1011
title: "Contract policy, ratchet and documentation"
phase: 1
plan: "§12 Phase 1.6 and §14 (new commands)"
status: done
depends_on: [1006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1011 · Contract policy, ratchet and documentation

- **Report:** [§12 Phase 1](../../docs/reports/unified-federation.md#12-migration-plan), [§14 Risks](../../docs/reports/unified-federation.md#14-risks) ("Long migration collides with ~16 new commands a day")
- **Depends on:** [1006](1006-contract-manifest-generator.md)
- **Blocks:** Phase 7
- **Size:** S
- **Track:** C (contract)

## Goal

From this item on, every new command uses `defineCommand`, and the untyped surface only shrinks. Agents can find the rules.

## Work

- [x] Ratchet: the manifest generator records the count of `untyped` commands per domain in `contracts/untyped-baseline.json`. `contract:check` fails when any count rises, and the baseline can be regenerated only downward. Follow the shrink-only model of `tests/source-guards/baseline.ts` (`compareWithBaseline`).
- [x] New section "Domain contracts" in `docs/architecture/version-compatibility.md`. It covers:
  - domains and versions, and when to bump;
  - tolerant reader and critical fields;
  - typed errors;
  - adapters and their retirement;
  - the manifest, snapshots and CI job;
  - how to add a command.
- [x] Add a row to the root `AGENTS.md` "Read before changing these areas" table: "Backend commands (`commands-registry*.ts`, `packages/protocol/src/contract/**`) → version-compatibility.md#domain-contracts".
- [x] Add a short note in the backend command registry file header pointing to the same section.

## Done when

- [x] A PR that adds a string-registered command fails `contract:check` with a message pointing to the docs.

## Notes

### Decisions (2026-11-07)

- **The ratchet is its own script, not part of the generator.** `scripts/generate-contract-manifest.ts` is 1006's and was being extended by 7011 at the same time, and the item's "the manifest generator records the count" only needs the count the manifest already has (`untypedByDomain`, a derived total `--check` keeps in step with `commands`). `scripts/contract-check.ts` reads the committed manifest as JSON (no `effect`, no registry), so the ratchet does not depend on how the manifest is produced. Deviation from the item's wording: the baseline is written by `mise run contract:manifest`, which now runs the generator and then `bun scripts/contract-check.ts --lower-baseline`, rather than by the generator script itself.
- **Files.** `packages/protocol/contracts/untyped-baseline.json` (next to `manifest.json`): `{ schemaVersion: 1, description, total, untypedByDomain }`, domains sorted, domains with no untyped command left out; `total` must equal the sum. Seeded at 996 over 29 domains, equal to the manifest. *(2026-11-07, orchestrator, completeness check: since lowered to 0 by Phase 7: the committed `untyped-baseline.json` has `total: 0`, and the manifest 999 defined, 0 untyped.)*
- **Model** (`tests/source-guards/baseline.ts`): a domain above its baseline (absent means 0) is a rise and fails; a baseline above the manifest is stale and also fails, so each conversion commits the smaller baseline and a later PR cannot spend the headroom. `--lower-baseline` refuses (writes nothing, exits 1) when any domain rose; a missing baseline is written from the manifest. A per-domain rise is refused even when the total is unchanged: moving an untyped command between domains in `contract-domain-map.ts` is a hand edit of the baseline, justified in review. Options considered: compare only the total (simpler, but a domain could grow while another shrinks unnoticed) or per domain (the item's wording). Chose per domain.
- **`contract:check` is now `bun scripts/contract-check.ts`**, which runs the generator's `--check` (imported `runContractManifest`, unchanged) and then the ratchet. Both always run, and any failure ends with `Contract rules (...): docs/architecture/version-compatibility.md#domain-contracts`. So a PR that adds a string-registered command fails with the docs pointer on either path: without a domain-map entry (the generator's "No contract domain for ..."), or with the entry and a regenerated manifest (the ratchet's "More untyped ... than ... allows ... New commands use defineCommand"). Options: a mise array of two steps (the generator's failure would then not name the docs, and the second step would not run after the first failed) or a wrapper. Chose the wrapper.
- **Files outside the set** (minimal): `mise.toml` (the `contract:manifest` and `contract:check` run lines and descriptions), `.github/workflows/ci.yml` (the step's comment only; the step still runs `mise run contract:check`), `apps/backend/src/core/commands-registry.ts` (a header comment, as this item's last Work box asks).
- **AGENTS.md row** wording: "Backend commands (`commands-registry*.ts`, `packages/protocol/src/contract/**`): adding, converting or changing a command or domain" → `version-compatibility.md#domain-contracts`.
- **Docs.** The section is in `docs/architecture/version-compatibility.md` as the item says, linked from that file's row in `docs/README.md`. Statements were checked against the code on 2026-11-07. Parts still being built are described as plan items and linked rather than stated as present: 1005 (web HTTP and IPC transports, the UI helper), 1007 (snapshots), 1008 (CI job), 1009 (`createDomainClient`, `adapters.json`, counters; the module is `contract/client.ts`), 2011 (`scope.domain`). When those land, their owners should update the matching subsection (the 1009 work in progress already passes a legacy context as the adapter's second argument and takes `domains` as a function; the doc names neither detail).
- **Test.** `tests/unit/contract-untyped-ratchet.test.ts` (default root suite, file-only, no registry load): the committed baseline equals the manifest; the docs anchor and the AGENTS.md link exist; rises, absent domains, stale entries and domain moves; `runContractCheck` with a new untyped command and with a failing drift check (both name the docs); `--lower-baseline` lowers, refuses a rise without writing, and seeds a missing file; parse refusals.
- **Effect:** not used. The ratchet is plain JSON and arithmetic in a root script; the repository root does not depend on `effect`, and nothing here needs schemas, services or typed failures.
- **Effect on concurrent and later items:** any item that converts a command (1010, 7001+) must commit the lower baseline (`mise run contract:manifest` writes it), or `contract:check` and the root unit test fail as stale.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `scripts/contract-check.ts` (`runContractCheck`, `checkUntypedRatchet`, `lowerUntypedBaseline`, `compareUntypedCounts`, `untypedCountsFromManifest`, `parseUntypedBaseline`, `serializeUntypedBaseline`, `CONTRACT_DOCS`), `packages/protocol/contracts/untyped-baseline.json` (996), `tests/unit/contract-untyped-ratchet.test.ts` (17 pass); `contract:check` and `contract:manifest` rewired in `mise.toml`; the "Domain contracts" section in `docs/architecture/version-compatibility.md`, its link in `docs/README.md`, the `AGENTS.md` row, the `commands-registry.ts` header and the CI step comment. `mise run contract:check` passes; `mise tasks validate`, backend typecheck, oxlint and `bun fmt` clean; `tests/tsconfig.json` reports 3 errors, none in these files.
- 2026-11-07 (orchestrator, completeness check): noted the ratchet's current baseline (0 untyped; 999 defined) beside the 996 it was seeded at.
