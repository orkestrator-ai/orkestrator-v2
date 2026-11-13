# Seeded workflow records review: mixed-owner aggregate failures

- **ID:** 9999
- **Status:** open
- **Date observed:** 2026-11-13
- **Snapshot:** `f4be0d1d1` on `workflow-store-testing-551c328ddecd-r1` (base `17d28238c`), the Multi Review validation for the `dev:test --seed-workflow-records` change.
- **Original command:**
  `mise run test:logged -- --name review-default-tests -- mise run test`
  (default worker plan). Exit 1 after 1,076 s of test groups. The runner's own
  rerun of the first failing owner queued behind another worktree's exclusive
  resource (16 of 16 host slots reserved), spent its 600 s budget without a
  verdict, and left the other two owners not rerun.
- **Groups:** guards, bridges and the codex protocol lockfile passed. The
  workspace group (backend 18,301 tests, 1 fail; web 14,732 tests, 1 fail) and
  the root and agent-support group (1 fail) failed.

## Failures and complete owning-file reruns

| Test | Failure | Owner rerun alone (2026-11-13, same branch) |
| --- | --- | --- |
| `agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes` in `apps/backend/tests/agent-mail-store-size-bench.test.ts` | `this test timed out after 5000ms` (5,002 ms) | `mise run test:logged -- --name rerun-store-size-bench -- bun --cwd=apps/backend test tests/agent-mail-store-size-bench.test.ts --parallel=1 --only-failures` passed, exit 0, 9.9 s. |
| `a remote workspace opens Docker in parent Settings and every action targets its selected host` in `apps/web/src/components/settings/SettingsPage.test.tsx` | Failed after 1,277 ms in the web workspace run | `mise run test:logged -- --name rerun-settings-page-3 -- bash -c 'cd apps/web && NODE_ENV=test bun --no-env-file ../../scripts/bun-test-tier.ts apps/web src/components/settings/SettingsPage.test.tsx -- --only-failures --parallel=1'` passed, exit 0, 6.3 s. (Run without `--no-env-file` from a shell with `NODE_ENV=production`, every case fails on `React.act is not a function`; that is the invocation, not this flake.) |
| `counting link > a reset drops what is queued for the connection and counts it as dropped` in `e2e/agent-testing/remote-bandwidth-meter.test.ts` | `expect(after.droppedBytes).toBeGreaterThan(0)` received 0 at `:397` (1,190 ms) | `mise run test:logged -- --name rerun-bandwidth-meter -- bun test ./e2e/agent-testing/remote-bandwidth-meter.test.ts --parallel=1 --only-failures` passed, exit 0, 1.1 s. |

The branch changes only development scripts (`apps/backend/scripts/`,
`apps/desktop/scripts/dev/`), their tests and documentation. None of the three
owners imports a changed file. The review package's failure triage left the
bandwidth-meter case `undetermined` (`dependency-graph-incomplete`) and listed
no other owner because the command did not finish. Host contention is a
hypothesis consistent with the 5 s timeout and the queued rerun, not a
confirmed cause. No assertion, timeout or skip was changed.
