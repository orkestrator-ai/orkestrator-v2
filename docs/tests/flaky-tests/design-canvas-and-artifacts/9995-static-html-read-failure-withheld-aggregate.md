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
