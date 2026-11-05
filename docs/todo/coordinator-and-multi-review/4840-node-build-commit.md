# Report each node's build commit in list_nodes

## Task analysis

Analysed 2026-11-04 against `main` at `a86de7906`. Re-checked and built 2026-11-05 against `main` at `6e796ca32`: the claims below still hold, with one correction under Investigation.

### Tasks

1. **Report the commit a node was built from**: a running backend knows its build commit and `list_nodes` reports it per node, `null` for older nodes. Status: done (2026-11-05).

### 1. Report the commit a node was built from

**Problem.** `list_nodes` now reports each node's version, but that does not answer "does this machine have that fix?". Main's `package.json` stays at one version across many merges, so two builds with the same version can hold different code. On 2026-11-04 this blocked confirming whether rkmbp was running code from before #1724.

**Context.** The version comes from `BackendHello.appVersion` (`packages/protocol/src/backend-profile.ts`), which `NodeReadModel.summaries` reads from the live link and `list_nodes` reports. A new optional hello field would follow the same path, and an older leaf would report `null` for it. A leaf has to be updated before it can send a commit, unlike the version.

**Investigation.** A running backend does not know its commit today:

- `APP_VERSION` (`apps/backend/src/core/constants.ts:83`) is the only build identity the backend holds.
- `sourceRevision` belongs to the container image, not the backend. `scripts/docker-image-build-args.ts:27-34` passes `ORKESTRATOR_SOURCE_REVISION` to `docker build`, and `docker/image-manifest.ts:165-169` writes it into the image manifest. `apps/backend/src/core/docker-image.ts:298` reads it back to describe an image.
- `main.ts` is bundled in two places, neither of which embeds a commit: `apps/backend/scripts/build.ts` for the desktop app and `packages/cli/scripts/build.ts` for the published CLI.
- Both builds run through Turbo, which restores `dist/**` on a cache hit without running the build script (`turbo.json`; `mise.toml` `build*` tasks; `scripts/release-desktop.ts:435` runs `build:all`). The backend's cache key has no environment input and does not cover `bridges/` or `apps/web/`.

So calling `git rev-parse` inside a build script would stamp whichever commit first filled that cache entry. Later commits that only changed a bridge or the renderer would report the older commit, which wrongly suggests a fix is missing. The re-check demonstrated this with real builds (see Assumptions and decisions).

Correction from the re-check: the CLI's build task is configured in `packages/cli/turbo.json`, not the root `turbo.json`. Its inputs already cover `apps/backend/src`, `bridges/*/src` and `packages/protocol/src`, so for the CLI only a commit outside those (the renderer, for example) would reuse an older entry. The hazard and the fix are otherwise the same.

**Decisions.**

- **How does the commit reach the bundle?**
  - **Set it in the build tasks and declare it in Turbo's `env` (recommended).** The `mise` build tasks and `publish:cli` export `ORKESTRATOR_BUILD_COMMIT`, the backend and CLI tasks in `turbo.json` list it under `env`, and both `Bun.build` calls embed it with `define`.
    - Pros: the commit is part of the cache key, so a cache hit cannot serve another commit's stamp. No new artefact to package. `dev:test` and test builds leave it unset, so they keep their cache and report `null`.
    - Cons: builds through these tasks miss the cache once per commit, and so do the packages that depend on the backend. Every build path has to set it, or that path reports `null`.
  - **Write a stamp file in an uncached step after Turbo.** A step writes `dist/build-info.json` from Git, and the backend reads it at startup.
    - Pros: leaves Turbo's cache untouched and is correct on a cache hit.
    - Cons: a new step in every build path, a new file for desktop packaging and the CLI's `files` list to carry, and a startup read that can fail.
  - **Run `git rev-parse` at backend startup.**
    - Pros: no build change.
    - Cons: a packaged app has no repository, so it reports nothing on the machines this is for. In a checkout it reports the current `HEAD`, which may not be the code the process loaded.
  - **Run `git rev-parse` inside the build scripts only.**
    - Pros: the smallest change.
    - Cons: wrong on a Turbo cache hit, as above. A wrong commit is worse than `null` here.
- **What should a build from a dirty tree report?**
  - **`null` (recommended).**
    - Pros: a reported commit always means exactly that code.
    - Cons: a build with local edits has no commit to show.
  - **The commit, with a `-dirty` suffix.**
    - Pros: still shows the base commit.
    - Cons: the field stops being a plain commit, so a reader has to parse it, and it does not say what the edits were.

## Constraints and rationale

- Follow the `version` rules: `null` while a node is not connected, and `null` for a leaf whose hello has no commit, so that an older node still lists normally.
- Validate the value the way the image manifest does (`/^[0-9a-f]{7,40}$/`), and drop anything else rather than refuse the hello.

## Related

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#multiple-machines) describes `list_nodes`.
- [`docs/development/releasing.md`](../../development/releasing.md#build-commit) lists what every build path reports.

## Assumptions and decisions

### Task 1: the recommended options were taken

The commit reaches the bundle through `ORKESTRATOR_BUILD_COMMIT`, set by the build tasks and declared in Turbo's `env`, and a modified tree reports `null`. The re-check found nothing against either.

### Task 1: how Turbo was proven not to serve an older commit

Run on 2026-11-05 with real `mise run build:backend` and `mise run build:cli` builds, at this change's commit A, a temporary bridge-only commit B and a temporary renderer-only commit C on top of it. The temporary commits were then removed.

| Step | Turbo | Bundle reports |
| --- | --- | --- |
| `build:backend` at A | miss | A |
| `build:backend` at A again | hit | A |
| No variable at A | miss, key `328f864454efb49c` | `null` |
| No variable at B | hit, same key | `null` |
| `build:backend` at B | miss | B |
| `build:backend` at C | miss | C |
| `build:cli` at C | miss | C |
| `build:backend`, `build:cli` back at A | hit | A |
| `build:backend` with an untracked file | miss | `null` |
| `build:cli` with a modified file | miss | `null` |

The two "No variable" rows show the hazard: with no commit in it, the backend's key does not change across a bridge-only commit, and it was still the same at C. So a stamp read from Git inside the build script would have kept reporting A. A dry run also shows the commit changes only `@orkestrator/backend#build`, `@orkestrator/desktop#build` and `orkestrator#build`; every bridge, the renderer and the public client keep their keys.

`tests/unit/monorepo-scripts.test.ts` pins this configuration, so it cannot be dropped unnoticed. It does not run Turbo.

### Task 1: test builds get their own tasks

`test:agent:browser`, `test:agent:browser:isolated` and `test:cli:scenarios` depended on `build:cli`, and `package:linux:unpacked:test` and `test:package:security` ran `build:all`. Those would have missed the cache per commit and reported a commit, so they now use `build:cli:test` and `build:all:test`, which set nothing.

### Task 1: `start:web` and `start:web-public` report `null`

They are not build tasks, and Turbo passes `ORKESTRATOR_*` to the backend they start. Exporting the commit there would hand it to that backend and everything it launches, so a later test build run from one of its agents would be stamped with a stale commit. They are for a source checkout, and a wrong commit is worse than `null`.

### Task 1: a modified tree exports an empty value

Turbo hashes an empty variable differently from an unset one, so a build from a modified tree has its own cache entry rather than sharing the test builds'. Both report `null`, so this costs one entry and cannot report a wrong commit. It keeps the same one-line export in every task, instead of a wrapper that unsets the variable.

### Task 1: `publish:cli` sets the variable in `scripts/publish-cli.ts`

`bun publish` rebuilds in `prepack` without Turbo, so the variable has to be in its environment. Setting it in the script also covers running the script directly, and removes a value it inherited when the tree is modified. A throwaway package with a dry-run `bun publish` and an isolated `HOME` confirmed that `prepack` sees the variable; a real `bun pm pack` of `packages/cli` embedded the commit with it and `null` without it. Nothing was published.

### Task 1: the public `node.list` action is unchanged

The operator `list_nodes` over `node.list` keeps its public schema, as it did for machine load. The ticket names `NodeReadModel.summaries` and the coordinator's `list_nodes`.

### Task 1: no compatibility register row

A missing `buildCommit` is permanent shape handling rather than a path to retire: development, test and modified builds send none either, so a counter could not tell an old peer from a dirty one. It is listed under "Not governed by the window" in [`version-compatibility.md`](../../architecture/version-compatibility.md).

## Needs verification

- No real release or second real machine was involved: the first real desktop release and CLI publish after this merges are the first to show a commit from `list_nodes` end to end. Node behaviour was tested through the real node links and read model against fake leaves.
- `dev:test` was not booted. That it reports `null` rests on `backend-process.ts` starting `apps/backend/src/main.ts` in development and on a test that runs that module from source.
- `release:desktop` and `package:*` were not run. They reach the backend only through `build:all`, whose key was checked with a dry run, and `package.json` packages `apps/backend/dist` as built.
