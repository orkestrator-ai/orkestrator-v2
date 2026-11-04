# S5: Release chain

This file combines 2 reports into one batch to build together. Both cover publishing. `0240` is a one-line fix. `0140` task 3 changes how the package is published, so it needs the maintainer's approval.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0140](#0140-sign-and-pin-the-release-and-update-paths) | High | L6: AppImage manifests, `install.sh` pin, npm provenance, updater lockfile |
| [0240](#0240-drop-persisted-credentials-from-the-image-publish-checkout) | Low | I6: `persist-credentials` on the image publish job |

## 0140: Sign and pin the release and update paths

### Task analysis

#### Tasks

1. **Signed update manifests for the Linux AppImage**: it trusts the release's sha512 alone. Status: open.
2. **Pin `install.sh`**: it runs whatever `bunx orkestrator` resolves to. Status: open.
3. **Publish the npm package from CI with provenance**: it is published from a workstation. Status: open.
4. **Give the standalone updater a lockfile**: transitive dependencies float at install time. Status: open.

#### 1. Signed update manifests for the Linux AppImage

**Problem.** A compromised GitHub release could push code to Linux users.

**Context.** Tracked as [todo 0032](../../todo/cross-cutting/0032-dependency-upgrades.md) task 2, blocked on electron-builder 27 stable.

**Investigation.** `electron-builder.release.linux.config.ts:11-16` says Linux releases are unsigned.

**Decisions.** None here: todo 0032 task 2 holds the options.

#### 2. Pin `install.sh`

**Problem.** The installer follows whichever version the registry tag resolves to, so a compromised publish reaches anyone who runs it.

**Context.** The script also fetches Bun with `curl | bash` when Bun is missing.

**Investigation.** `apps/web-public/public/install.sh:13` and `:25` run `bunx orkestrator "$@"` with no version; `:21` fetches `https://bun.com/install`.

**Decisions.**

- **How to pin?**
  - **Stamp the release version into the published `install.sh` (recommended).**
    - Pros: a reader can see what it runs; the site deploy becomes a deliberate step of a release.
    - Cons: the site has to be deployed with each release, or the pin goes stale; Unstable channel users need another route.
  - **Leave it on the tag and rely on task 3's provenance.**
    - Pros: no deploy coupling.
    - Cons: `bunx` does not check provenance, so it only helps someone who looks.

#### 3. Publish the npm package from CI with provenance

**Problem.** A workstation compromise could publish a malicious package, and nothing shows where a version came from.

**Context.** `docs/development/releasing.md:121-127` describes `release:publish` running `publish:cli` locally, with web authentication approved in a browser. The image publish already attests provenance (`.github/workflows/publish-container.yml:206`).

**Investigation.** `scripts/publish-cli.ts:22-37` builds `bun publish` with no provenance option, and `mise.toml:185-187` runs it. No workflow publishes to npm: the `publish` matches under `.github/workflows` are the container and validation jobs.

**Decisions.**

- **Where should it publish from?**
  - **A release workflow with `id-token: write` and npm trusted publishing (recommended).**
    - Pros: provenance; no long-lived npm credential on a workstation; the workflow pattern already exists.
    - Cons: moves a step out of the local release flow and needs npm package settings changed. Whether `bun publish` supports this is not established, so it may need `npm publish` for that step.
  - **Keep it local, with the web approval.**
    - Pros: a human approves each publish.
    - Cons: no provenance, and the workstation stays the point of trust.

#### 4. Give the standalone updater a lockfile

**Problem.** The update installs a release into an empty directory, so transitive dependencies resolve afresh on each host.

**Context.** The code comment says Bun verifies registry integrity (`apps/backend/src/host-standalone-updater.ts:39-40`). That covers each tarball, not which versions get picked.

**Investigation.** `installRelease` writes a `package.json` with one dependency and runs `bun install --production --no-progress` (`packages/protocol/src/node/standalone-service.ts:331-352`). `packages/cli/package.json:36-40` pins its direct dependencies exactly, but not what they depend on.

**Decisions.**

- **How to fix the versions?**
  - **Publish a lockfile in the npm package, copy it into the staging directory and run with `--frozen-lockfile` (recommended).**
    - Pros: a host installs what the release tested.
    - Cons: the lockfile must be generated for this one-dependency install, not the monorepo; platform-specific optional dependencies have to resolve.
  - **Bundle all dependencies into the package.**
    - Pros: nothing to resolve.
    - Cons: native modules such as `sharp` cannot be bundled this way.

### Needs verification

- Whether `bun install --frozen-lockfile` accepts a lockfile generated this way, and whether `bun publish` can publish with provenance: neither was run.

## 0240: Drop persisted credentials from the image publish checkout

### Task analysis

#### Tasks

1. **Set `persist-credentials: false`**: on the checkout in the job with `packages: write`. Status: open.

#### 1. Set `persist-credentials: false`

**Problem.** The job's `GITHUB_TOKEN`, which can write packages, stays in `.git/config` while later steps run repository scripts.

**Context.** `.dockerignore:1` excludes `.git`, so the image build context does not receive it.

**Investigation.** Of the workflows, `packages: write` appears only in `.github/workflows/publish-container.yml`, at `:54` and `:142`. The job at `:142` has no checkout. The job at `:54` checks out at `:68`, and then runs `mise exec -- bun docker/image-manifest.ts` from the tree. No later step in that job pushes with git; it logs in to GHCR with an explicit password (`:74-78`). `persist-credentials` appears in no workflow.

**Decisions.** None: a one-line change, since no later step uses the stored credential.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L6)
- [Todo 0032](../../todo/cross-cutting/0032-dependency-upgrades.md), task 2
- `docs/development/releasing.md`
- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I6)
