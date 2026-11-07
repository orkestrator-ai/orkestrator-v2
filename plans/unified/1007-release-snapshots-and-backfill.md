---
id: 1007
title: "Release contract snapshots and backfill"
phase: 1
plan: "§11.3 step 2 and §12 Phase 1.4"
status: done
depends_on: [1006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1007 · Release contract snapshots and backfill

- **Report:** [§11.3 Manifests and CI](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1006](1006-contract-manifest-generator.md)
- **Blocks:** [1008](1008-contract-ci-job.md)
- **Size:** M
- **Track:** C (contract)

## Goal

Every published release in the support window has a contract snapshot. That gives the CI job something to compare against.

## Current state (verified 2026-11-07)

- `scripts/set-version.ts` (142 lines; `release:version`, `mise.toml:541-544`):
  - writes the manifests in `VERSIONED_MANIFESTS` (:26-40);
  - runs installs;
  - runs `tests/unit/version-drift.test.ts`.
  - A snapshot step fits after :119 or :127.
- Tags are `v<semver>` with optional `-beta`/`-alpha`. There are 40, from v2.21.0 (2026-10-16) to v2.36.6-beta (2026-11-06); the newest Stable is v2.36.1.
- Tags `v2.24.0-alpha` to `v2.26.0-alpha` are drafts that were never published (`version-compatibility.md:21-25`). Backfill only published releases.
- Precedent for running older releases from `git worktree add --detach`: `scripts/qualify-backend-upgrade-rollback.ts:186-191`, cleaned up at :1412-1414.

## Work

- [x] `release:version` writes `packages/protocol/contracts/releases/<version>.json` using the generator from [1006](1006-contract-manifest-generator.md).
- [x] Deduplicate snapshots per domain digest:
  - a release file references shared `contracts/domains/<domain>-<digest>.json` blobs;
  - storage grows with domain changes, not with releases.
- [x] `scripts/backfill-contract-snapshots.ts`:
  - for each published release tag, check it out in a detached worktree under a temporary directory and install with its pinned Bun;
  - enumerate its registry with the old code (every command is untyped in old releases, so the domain map is applied from the current tree);
  - write the snapshot.
  - It never touches the real data directory. It cleans up its worktrees, removing only the paths it created.
- [x] Record the list of published releases and their dates in `contracts/releases/index.json`. The CI job computes the floor from it, so it does not shell out to `git tag`.

## Done when

- [x] Snapshots exist for every published release since v2.21.0, and `release:version` writes the next one. Run `tests/unit/release/set-version.test.ts` and extend it for the new step.

## Notes

### Published releases (2026-11-07)

Read with `gh release list --repo orkestrator-ai/orkestrator-v2 --json tagName,isDraft,publishedAt` (read-only). **31 published releases** from v2.21.0 to v2.36.6-beta: v2.21.0, v2.21.1, v2.22.3, v2.23.0, v2.26.2-beta, v2.26.3-beta, v2.27.0-beta to v2.33.0-beta, v2.34.0-alpha, v2.34.1-beta to v2.34.5-beta, v2.35.0-beta, v2.35.1-beta, v2.35.3-beta to v2.35.5-beta, v2.36.0, v2.36.1, v2.36.2-beta to v2.36.6-beta. Their dates are in `packages/protocol/contracts/releases/index.json`.

- Not published: the drafts v2.24.0-alpha, v2.25.0-alpha, v2.25.1-alpha, v2.26.0-alpha, **v2.26.1-alpha** and **v2.35.2-beta** (the item and `version-compatibility.md` named only v2.24.0-alpha to v2.26.0-alpha), and the tags v2.22.0 to v2.22.2, which have no GitHub release at all. `version-compatibility.md` "The support window" now says so.
- npm (`orkestrator` package) disagrees in both directions: it carries 2.24.0-alpha to 2.26.1-alpha (GitHub drafts) and lacks 2.21.0 and 2.21.1. The policy defines *published* as a non-draft GitHub release, so GitHub is the source; npm was only cross-checked.

### Decisions (2026-11-07)

- **Layout.** Under `packages/protocol/contracts/`: `releases/<version>.json` per release; `domains/<domain>-<hex16>.json` blobs, one domain's commands, named by the first 16 hex digits of the SHA-256 of the blob's own text (the release file holds the full `sha256:` digest and the reader verifies it, so a 64-bit prefix collision or a hand edit is refused rather than silently shared); `releases/index.json`. A release file holds `{ schemaVersion: 1, version, channel, preContract, source, commit?, readClassified, counts: { commands, defined, untyped, unmapped }, domains: { [domain]: { file, digest, commands, version?, min? } }, unmapped?, events }`. A blob holds `{ schemaVersion: 1, domain, version?, min?, commands }` where each command is its manifest entry without `domain`. Every object is key-sorted and written in the shape `bun fmt` keeps (checked: `bun fmt --check` on all 177 files).
- **Dedup result.** 31 releases × up to 29 domains reference **145 blobs** (972 KB in total: 252 KB of release files, 720 KB of blobs). Releases with no command change (v2.21.1, v2.26.3-beta, v2.32.0-beta, v2.34.3-beta, v2.35.1-beta, v2.35.4-beta, v2.36.6-beta) added no blob. Options considered: one file per release (simplest, but ~900 KB per ten releases and growing with releases), a content-addressed per-command store (smallest, but a release would reference ~1000 files and a diff would be unreadable), per-domain blobs (the report's choice). Chose per-domain blobs.
- **Pre-contract snapshots** (every published release so far: none has a manifest or a `domains` hello). `preContract: true`, `source: "registry"`, `commit` the tag's commit. Each command is `{ untyped: true, read }`, where `read` is the release's **own** routing classifier `isNodeReadCommand` (`packages/protocol/src/command-nodes.ts`, present from v2.26.1-alpha) applied to its names; v2.21.0 to v2.23.0 have no classifier, so their entries carry no `read` and the file says `readClassified: false`. The domain is this tree's: the committed manifest's domain of each command (domain map for string commands, definition for defined ones; the map alone would lose a command once it is converted and leaves the map), then the domain map. Names this tree no longer registers go to an `unmapped` blob (`domain: null`, `unmapped-<hex16>.json`) rather than an invented domain: 20 in v2.21.0 to v2.29.0-beta (the looped-review commands, the prompt-queue claim commands, `export_build_pipeline_for_downgrade`), 15 in v2.30.0-beta to v2.33.0-beta, 18 in v2.34.0-alpha to v2.34.3-beta, none from v2.34.4-beta. A snapshot is never rewritten once written, so later domain-map changes do not move old releases' commands.
- **Contract-era releases.** A release whose tag commits `packages/protocol/contracts/manifest.json` is split from that manifest with `git show` (no checkout, `preContract: false`, `source: "manifest"`). `release:version` does the same from the working tree.
- **Registry enumeration.** One release at a time: `git worktree add --detach` under `output/contract-backfill/<version>-XXXXXX/tree` (new `.gitignore` line `/output/contract-backfill/`; the item said "a temporary directory" and the orchestrator asked for `output/`), the Bun pinned in the tag's `mise.toml` (1.4.3 up to v2.26.x, 1.4.4 after; `mise install` only when `mise where` fails), `bun install --frozen-lockfile --ignore-scripts` (no lifecycle script of an old release runs; the registry needs only sources), then a child under that Bun running this script's `--child` mode: it imports the release's `apps/backend/src/core/commands-registry.ts`, calls `createCommandRegistry()` with no options (a `Map` in old releases, a registry with `keys()` in newer ones) and lists the names. The child gets the generator's sandbox: a constructed environment (temporary HOME, XDG, TMPDIR, empty PATH, `NODE_ENV=production`, nothing inherited), cwd in the sandbox, `--no-env-file`, a refusing `fetch`, 60 s timeout, 1 MiB output cap; no command runs and no port is bound. The worktree is removed with `git worktree remove --force <path>` in a `finally` and on SIGINT/SIGTERM; only paths this run created are touched (no `git worktree prune`). A checkout whose `package.json` version differs from the tag is refused. The full backfill took about 5 minutes; afterwards `git worktree list` has no `contract-backfill` entry and `output/contract-backfill/` is gone.
- **Index and publication times.** `releases/index.json` is `{ schemaVersion: 1, generatedBy, releases: [{ version, channel, publishedAt }] }`, sorted by version. `release:version` adds its version with `publishedAt: null` (it is not published yet) and fills the times of already recorded releases from `gh release list` (best effort: without `gh` it warns and leaves them). It does not add published releases that have no snapshot; it names them and points at `mise run contract:backfill`. A known time is never replaced by `null`. For 1008: an entry with `publishedAt: null` is a versioned but unconfirmed release; never use it as the floor, and treat it conservatively (include it) when choosing in-window snapshots.
- **`release:version` order.** Validate every package manifest (no writes), run `bun scripts/generate-contract-manifest.ts --check` (the snapshot is split from the committed manifest, so a stale manifest fails before anything is written), write the manifests, install, frozen installs, drift test, then the snapshot and index in-process (`writeVersionSnapshot`). A same-target retry rewrites identical files. The ratchet (`contract-check.ts`) is not part of it: a release only needs the manifest current.
- **Reader for 1008.** `readReleaseSnapshot(contractsDir, version)` reassembles `{ version, channel, preContract, readClassified, domains, commands: { [name]: entry & { domain: string | null } }, events }` and verifies each blob's file name, digest, domain and count; `readReleaseIndex(contractsDir)`. The floor computation itself is left to 1008.
- **`--check`.** `mise run contract:backfill -- --check` lists GitHub's releases and fails, without writing or checking out, when a published release has no snapshot, a snapshot does not verify, or the index lacks a publication time. Not wired into CI here (it needs `gh` and the network); 1008 can call it or read the index.
- **Events.** The release file copies the manifest's `events` inline (empty until 7011). If 7011's events become large or per domain, they should move into the domain blobs.
- **Formatter.** `scripts/contract-snapshots.ts` has its own copy of the manifest serializer's rules (~25 lines) instead of importing `serializeContractManifest`: `scripts/set-version.ts` imports this module, and the generator imports `effect`, which the repository root does not depend on. `scripts/generate-contract-manifest.ts` is unchanged (type-only import).
- **Effect.** Not used. These are root scripts (the root does not depend on `effect`), synchronous file work and child processes; nothing needs services, scopes or typed failures.
- **Docs.** `docs/development/releasing.md` (step 1), `AGENTS.md` "Application Version Bumps" and `docs/architecture/version-compatibility.md` ("The support window" draft list, "Release snapshots" bullet) describe the new step.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `scripts/contract-snapshots.ts` (formats, blob dedup, writer, verifying reader, index, `gh` release parsing), `scripts/backfill-contract-snapshots.ts` (+ `mise run contract:backfill`, `--check`, `--only`), the snapshot step and contract check in `scripts/set-version.ts`, and ran the backfill: 31 published releases snapshotted (632 to 995 commands each, all pre-contract) into 145 domain blobs, `--check` passes. Tests: `tests/unit/release/set-version.test.ts` (24, extended for the check step, the snapshot, blob sharing between releases, publication-time refresh and an unavailable `gh`) and `tests/unit/release/backfill-contract-snapshots.test.ts` (17: draft filtering, index merge, pre-contract entries with and without a classifier, unmapped commands, digest verification, dedup across releases, idempotent rerun, manifest-based tags, `--check`, `--only`, and a real `git worktree` round trip against a fixture repository with a sandboxed child, including removal after a failure). `bun fmt`, `oxlint` and `bun check -p tests/tsconfig.json` clean for these files (3 pre-existing errors in web component tests owned by another item).

