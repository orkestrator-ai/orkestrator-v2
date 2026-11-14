# Publish the npm package from CI with provenance

Carried from security report batch S5, part `0140` task 3 (finding L6).

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. Updated 2026-11-14: the user
approved task 1, so it is agent work.

### Tasks

1. **Publish the npm package from CI with provenance**: it is published from a workstation. Write the release workflow (`id-token: write`, `npm publish --provenance` under trusted publishing) and move `release:publish`'s npm step to it. Status: open (approved by the user on 2026-11-14). Registering the workflow as the package's trusted publisher in npm is the user's, on the manual-test checklist; it gates only the first real publish, not writing the workflow.

### 1. Publish the npm package from CI with provenance

**Problem.** A workstation compromise could publish a malicious package, and nothing shows where a version came from.

**Context.** `docs/development/releasing.md` describes `release:publish` running `publish:cli` locally, with web authentication approved in a browser. The image publish already attests provenance (`.github/workflows/publish-container.yml`, step "Attest build provenance"). Since the same batch, `install.sh` runs a pinned Stable release, and standalone updates install dependencies from a lockfile published in the package (5022 (retired 2026-11-14), recorded in [host-updates.md](../../architecture/host-updates.md#qualification)). Neither shows where the package itself came from.

**Investigation.** `scripts/publish-cli.ts:22-39` still builds `bun publish` with no provenance option, and `mise.toml:185-187` still runs it. No workflow publishes to npm: the `publish` matches under `.github/workflows` are the container and validation jobs. The report left open whether `bun publish` supports provenance. On Bun 1.4.4, `bun publish --help` lists `--tag`, `--otp` and `--auth-type` and no provenance option, so this step would need `npm publish` unless a later Bun adds one. Nothing was published to check this further.

**Decisions.** Where to publish from was the maintainer's call; the user approved the recommended option on 2026-11-14 (see Assumptions and decisions). The recommended option is a release workflow with `id-token: write` and npm trusted publishing: it gives provenance and no long-lived npm credential on a workstation, and the workflow pattern already exists; it moves a step out of the local release flow, needs npm package settings changed, and likely needs `npm publish` for that step because `bun publish` shows no provenance option. The alternative, keeping the local publish with its web approval, keeps a human approving each publish but gives no provenance. Once approved, this task writes the workflow.

## Assumptions and decisions

### Task 1: publish from CI with trusted publishing (user decision, 2026-11-14)

- **Chose:** the recommended option. The user (maintainer) approved a release
  workflow with `id-token: write` and npm trusted publishing (provenance),
  likely with `npm publish` for that step because `bun publish` shows no
  provenance option.
- **What the agent does:** write the workflow, move `release:publish`'s npm
  step to it, update [releasing.md](../../development/releasing.md), and
  remove or narrow the stored npm token path (see Related). Name the workflow
  file in this section so the user registers exactly that file.
- **What the user does:** add the workflow as a trusted publisher in the
  `orkestrator` package's npm settings. That is a manual-test checklist item
  (outward action); it gates the first publish from CI only.
- **Document:** moving the project to a new GitHub repository later means
  updating the npm trusted-publisher entry and the `repository` field of
  `packages/cli/package.json` together; write that into releasing.md with the
  workflow.

## Constraints and rationale

This changes how the package is published and needs npm settings changed; the user approved it on 2026-11-14, and the npm setting stays the user's (7568: 5021 task 1). `bunx` does not check provenance, so this helps someone who looks, or a future check in the updater, rather than blocking a bad version by itself.

## Needs verification

- That `npm publish --provenance` under trusted publishing can publish the package `mise run smoke:cli` tested, with the bundled `resources/` intact.

## Related

- [Releasing the desktop app](../../development/releasing.md)
- `publish:cli` can now publish with a stored npm token (`~/.config/orkestrator-release/npm-token`, see "npm authentication" in the releasing guide), added 2026-11-10 so a release needs no browser approval. That token is the kind of long-lived workstation credential task 1 would retire; once CI publishing lands, remove the token path or limit it to CI.
- 5022 (retired 2026-11-14; `git show $(git log -1 --diff-filter=D --format=%h -- docs/todo/cross-cutting/5022-release-chain-live-evidence.md)^:docs/todo/cross-cutting/5022-release-chain-live-evidence.md`): the lockfile install and the pinned `install.sh`; its Linux run is in [host-updates.md](../../architecture/host-updates.md#qualification)
- Security report, §5 Low severity (`git show 413bd6219:docs/reports/2-26-10-27-security.md`) (L6)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only part of this to-do (the npm trusted-publisher setting for task 1; the approval was given on 2026-11-14).
