# a read failure is withheld too, and a successful Retry releases it

- **ID:** 9995
- **Status:** open
- **Date observed:** 2026-11-13
- **Test:** `StaticHtmlArtifactView > document text in Find > a read failure is withheld too, and a successful Retry releases it`
- **File:** `apps/web/src/components/chat/rich/StaticHtmlArtifactView.test.tsx:606`
- **Branch and base:** `snapshot-head-recovery-8d306f0af39d-r1` at `71463d94c`,
  base `17d28238c098b4443d1289df5c4ed75e7cc2802e`. The branch changes backend
  transcript projection, one backend test file and docs; it changes no
  `apps/web` code.
- **Original command:** review preparation's
  `mise run test:logged -- --name review-default-tests -- mise run test`
  (default aggregate, workspace group running beside other worktrees'
  validation). Exit 1, incomplete: the runner's own one-file rerun waited for
  host capacity and gave no verdict within 600 s.
- **Failure:** `expect(artifactSearchBodyWithheld(REF)).toBe(true)` received
  `false` at line 606, right after the card showed "The document could not be
  loaded." (32.6 ms).
- **Suite counts:** backend 18,156 passed and 143 skipped; root and
  agent-support 526 passed and 8 skipped; workspace 14,721 passed, 10 skipped,
  1 failed.
- **Evidence:** `validation-04.stderr.txt` under
  `.orkestrator/review-artifacts/review-validation-fd54b9e6-05f1-4107-8fa8-7d3da2e2eff7/`.
- **Isolated rerun:** `NODE_ENV=test mise run test:logged -- --name static-html-artifact -- bun --cwd=apps/web test src/components/chat/rich/StaticHtmlArtifactView.test.tsx --parallel=2 --only-failures`
  passed the complete unchanged owner (3.4 s). The exact
  `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  then passed at `8f5280090` (1,714.3 s).
- **Hypothesis:** none established. The failure was seen once, under
  aggregate load beside other worktrees' validation, and has not been
  reproduced. No assertion, timeout or skip changed.

## Recurrences

These were first recorded on branch `dev-test-checks-415ac044ae03-r1` as a
separate case, 9996, before this case reached `main`. 9996 named the same
test and line, so its observations were folded in here when that branch
merged `main`; the 9996 claim stays so the number is not reused.

- **2026-11-13**, base `17d28238c098b4443d1289df5c4ed75e7cc2802e`, branch
  `dev-test-checks-415ac044ae03-r1` at `0178a2e78` (docs, `scripts/`,
  `tests/unit/`, `mise.toml` and a workflow; nothing under `apps/`,
  `packages/` or `bridges/`). Same assertion at line 606, received `false`
  (45.14 ms) right after the wait for "The document could not be loaded."
  passed. Command:
  `mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  (default suite, web package at its default worker count) on Linux x86_64,
  with other worktrees' runs holding the host's test capacity (16/16 slots
  reserved during the automatic rerun). Counts: web 14,720 passed and 2
  failed (this case and
  [the relay flake 9997](../web-ui/9997-multiplexed-relay-node-down-reattach-timeout.md));
  backend 18,151, desktop 2,149, protocol 5,835, toolchain 135, CLI 526 and
  web-public 52 passed; root, bridge and codex protocol lockfile groups
  passed. The aggregate runner's rerun waited for host capacity and ended
  `INCOMPLETE (600.1s): the rerun did not finish; no verdict`. Rerun by hand,
  unchanged:
  `mise run test:logged -- --name alone-static-html -- bun --no-env-file scripts/bun-test-tier.ts apps/web src/components/chat/rich/StaticHtmlArtifactView.test.tsx -- --only-failures`
  with `NODE_ENV` unset, as the aggregate runner does: passed (33 tests,
  3.0 s). With the shell's `NODE_ENV=production` the same file fails every
  render with `React.act is not a function`, which is the production React
  build and not this flake. Evidence:
  `orkestrator-test-run.BWoW10/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.
- **2026-11-13**, same base, same branch at `3a88e8609`, in
  `mise run test:logged -- --name review-default-tests-rerun3 -- mise run test`:
  the sibling test `StaticHtmlArtifactView > document text in Find > a frame
  over the element limit and a read over the budget both withhold the
  document` failed at line 594, again `artifactSearchBodyWithheld(REF)`
  received `false` (85.23 ms) right after the wait for the unavailable state
  passed. Web 14,721 passed and 1 failed. The aggregate runner's lone rerun
  of the unchanged file: `PASSED ALONE (2.5s)`. Evidence:
  `orkestrator-test-run.2L8bxS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

A hypothesis recorded with those observations, still unconfirmed: the error
text and the search-withheld mark may be published in separate steps, so the
assertion can run between them when a loaded host delays the second.
Reproduce it first before changing the test. If the gap is real, Find could
briefly see a failed document's text, which is a product question, not a
test budget.
