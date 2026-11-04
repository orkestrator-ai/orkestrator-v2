# Report each node's build commit in list_nodes

## Task analysis

Analysed 2026-11-04 against `main` at `a86de7906`.

### Tasks

1. **Report the commit a node was built from**: a running backend knows its build commit and `list_nodes` reports it per node, `null` for older nodes. Status: open.

### 1. Report the commit a node was built from

**Problem.** `list_nodes` now reports each node's version, but that does not answer "does this machine have that fix?". Main's `package.json` stays at one version across many merges, so two builds with the same version can hold different code. On 2026-11-04 this blocked confirming whether rkmbp was running code from before #1724.

**Context.** The version comes from `BackendHello.appVersion` (`packages/protocol/src/backend-profile.ts`), which `NodeReadModel.summaries` reads from the live link and `list_nodes` reports. A new optional hello field would follow the same path, and an older leaf would report `null` for it. A leaf has to be updated before it can send a commit, unlike the version.

**Investigation.** A running backend does not know its commit today:

- `APP_VERSION` (`apps/backend/src/core/constants.ts:83`) is the only build identity the backend holds.
- `sourceRevision` belongs to the container image, not the backend. `scripts/docker-image-build-args.ts:27-34` passes `ORKESTRATOR_SOURCE_REVISION` to `docker build`, and `docker/image-manifest.ts:165-169` writes it into the image manifest. `apps/backend/src/core/docker-image.ts:298` reads it back to describe an image.
- `main.ts` is bundled in two places, neither of which embeds a commit: `apps/backend/scripts/build.ts` for the desktop app and `packages/cli/scripts/build.ts` for the published CLI.
- Both builds run through Turbo, which restores `dist/**` on a cache hit without running the build script (`turbo.json`; `mise.toml` `build*` tasks; `scripts/release-desktop.ts:435` runs `build:all`). The backend's cache key has no environment input and does not cover `bridges/` or `apps/web/`.

So calling `git rev-parse` inside a build script would stamp whichever commit first filled that cache entry. Later commits that only changed a bridge or the renderer would report the older commit, which wrongly suggests a fix is missing. This follows from the Turbo configuration; no build was run to demonstrate it.

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
