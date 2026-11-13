# Static HTML artifact: a read failure is not yet withheld from Find

- **ID:** 9996
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e`.
- **Observed head:** `dev-test-checks-415ac044ae03-r1` at `0178a2e78`. The
  branch changes docs, `scripts/`, `tests/unit/`, `mise.toml` and a workflow;
  nothing under `apps/`, `packages/` or `bridges/`.
- **File:** `apps/web/src/components/chat/rich/StaticHtmlArtifactView.test.tsx:606`
- **Test:** `StaticHtmlArtifactView > document text in Find > a read failure is withheld too, and a successful Retry releases it`
- **Failure:** `expect(artifactSearchBodyWithheld(REF)).toBe(true)`, received
  `false` (45.14 ms), right after the wait for "The document could not be
  loaded." passed.
- **Original command:** `mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  (default suite, web package at its default worker count) on Linux x86_64,
  with other worktrees' runs holding the host's test capacity (16/16 slots
  reserved during the automatic rerun).
- **Suite counts:** web 14,720 passed and 2 failed (this case and
  [the relay flake 9995](../web-ui/9995-multiplexed-relay-node-down-reattach-timeout.md)); backend 18,151, desktop 2,149, protocol 5,835,
  toolchain 135, CLI 526 and web-public 52 passed; root, bridge and codex
  protocol lockfile groups passed.
- **Isolated rerun:** the aggregate runner's rerun waited for host capacity
  and ended `INCOMPLETE (600.1s): the rerun did not finish; no verdict`.
  Rerun by hand, unchanged:
  `mise run test:logged -- --name alone-static-html -- bun --no-env-file scripts/bun-test-tier.ts apps/web src/components/chat/rich/StaticHtmlArtifactView.test.tsx -- --only-failures`
  with `NODE_ENV` unset, as the aggregate runner does: passed (33 tests,
  3.0 s). With the shell's `NODE_ENV=production` the same file fails every
  render with `React.act is not a function`, which is the production React
  build and not this flake.
- **Evidence:** `orkestrator-test-run.BWoW10/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Hypothesis

Unconfirmed. The error text and the search-withheld mark may be published
in separate steps, so the assertion can run between them when a loaded host
delays the second. Reproduce it first before changing the test. If the gap
is real, Find could briefly see a failed document's text, which is a product
question, not a test budget.
