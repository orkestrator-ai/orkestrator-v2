# Publish the npm package from CI with provenance

Carried from security report batch S5, part `0140` task 3 (finding L6).

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Publish the npm package from CI with provenance**: it is published from a workstation. Write the release workflow (`id-token: write`, `npm publish --provenance` under trusted publishing) and move `release:publish`'s npm step to it. Status: blocked (waits on 7568: 5021 task 1). The maintainer's approval of the move and the npm trusted-publisher setting are in the manual-test checklist.

### 1. Publish the npm package from CI with provenance

**Problem.** A workstation compromise could publish a malicious package, and nothing shows where a version came from.

**Context.** `docs/development/releasing.md` describes `release:publish` running `publish:cli` locally, with web authentication approved in a browser. The image publish already attests provenance (`.github/workflows/publish-container.yml`, step "Attest build provenance"). Since the same batch, `install.sh` runs a pinned Stable release, and standalone updates install dependencies from a lockfile published in the package ([5022](5022-release-chain-live-evidence.md)). Neither shows where the package itself came from.

**Investigation.** `scripts/publish-cli.ts:22-39` still builds `bun publish` with no provenance option, and `mise.toml:185-187` still runs it. No workflow publishes to npm: the `publish` matches under `.github/workflows` are the container and validation jobs. The report left open whether `bun publish` supports provenance. On Bun 1.4.4, `bun publish --help` lists `--tag`, `--otp` and `--auth-type` and no provenance option, so this step would need `npm publish` unless a later Bun adds one. Nothing was published to check this further.

**Decisions.** Where to publish from is the maintainer's call (7568: 5021 task 1). The recommended option is a release workflow with `id-token: write` and npm trusted publishing: it gives provenance and no long-lived npm credential on a workstation, and the workflow pattern already exists; it moves a step out of the local release flow, needs npm package settings changed, and likely needs `npm publish` for that step because `bun publish` shows no provenance option. The alternative, keeping the local publish with its web approval, keeps a human approving each publish but gives no provenance. Once approved, this task writes the workflow.

## Constraints and rationale

This changes how the package is published and needs npm settings changed, so it waits for the maintainer's approval (7568: 5021 task 1). `bunx` does not check provenance, so this helps someone who looks, or a future check in the updater, rather than blocking a bad version by itself.

## Needs verification

- That `npm publish --provenance` under trusted publishing can publish the package `mise run smoke:cli` tested, with the bundled `resources/` intact.

## Related

- [Releasing the desktop app](../../development/releasing.md)
- `publish:cli` can now publish with a stored npm token (`~/.config/orkestrator-release/npm-token`, see "npm authentication" in the releasing guide), added 2026-11-10 so a release needs no browser approval. That token is the kind of long-lived workstation credential task 1 would retire; once CI publishing lands, remove the token path or limit it to CI.
- [5022](5022-release-chain-live-evidence.md)
- Security report, §5 Low severity (`git show 413bd6219:docs/reports/2-26-10-27-security.md`) (L6)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the approval and npm setting for task 1) moved there on 2026-11-10.
