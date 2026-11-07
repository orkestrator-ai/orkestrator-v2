---
id: 1007
title: "Release contract snapshots and backfill"
phase: 1
plan: "§11.3 step 2 and §12 Phase 1.4"
status: not-started
depends_on: [1006]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `release:version` writes `packages/protocol/contracts/releases/<version>.json` using the generator from [1006](1006-contract-manifest-generator.md).
- [ ] Deduplicate snapshots per domain digest:
  - a release file references shared `contracts/domains/<domain>-<digest>.json` blobs;
  - storage grows with domain changes, not with releases.
- [ ] `scripts/backfill-contract-snapshots.ts`:
  - for each published release tag, check it out in a detached worktree under a temporary directory and install with its pinned Bun;
  - enumerate its registry with the old code (every command is untyped in old releases, so the domain map is applied from the current tree);
  - write the snapshot.
  - It never touches the real data directory. It cleans up its worktrees, removing only the paths it created.
- [ ] Record the list of published releases and their dates in `contracts/releases/index.json`. The CI job computes the floor from it, so it does not shell out to `git tag`.

## Done when

- [ ] Snapshots exist for every published release since v2.21.0, and `release:version` writes the next one. Run `tests/unit/release/set-version.test.ts` and extend it for the new step.
