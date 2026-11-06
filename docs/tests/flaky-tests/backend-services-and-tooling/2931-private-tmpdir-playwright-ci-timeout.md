# Playwright private TMPDIR wiring: fixture spec times out on the CI runner

- **ID:** 2931
- **Status:** open
- **Date observed:** 2026-11-02 (GitHub Actions CI run 41548937096, `main` at `a4e6c3087`)
- **Tests:** `Playwright private TMPDIR wiring > e2e/playwright.config.ts: runner and worker share a directory that is removed on exit`
  and `... that is retained for a live browser`
- **File:** `tests/unit/private-tmpdir-playwright.integration.test.ts`
- **Original command:** `mise run test:full` in the "Unit and integration tests" job on
  `ubuntu-latest` (4 cores); the root group ran with one worker while the workspace,
  bridge and protocol groups ran concurrently.
- **Failure:** the first case's nested Playwright run reported "Test timeout of 30000ms
  exceeded" for its fixture spec, and the owner failed at 45055 ms. The second case
  failed at 6679 ms with a `toBe(true)` assertion inside the fixture spec. Neither case
  failed in the other five CI runs checked on 2026-11-03.
- **Isolated rerun:** `mise run test:logged -- --name pw-tmpdir-alone -- bun test ./tests/unit/private-tmpdir-playwright.integration.test.ts --parallel=1 --only-failures`
  passed (24.5 s) on a 16-core Linux host on 2026-11-03.
- **Hypothesis:** the fixture spec launches Chromium in a nested Playwright run, and
  under the CI job's concurrent groups that launch exceeded the spec's 30 s budget. The
  second failure may be a consequence of the first case's leftover state, but the
  log does not show which assertion failed or why. Unproven.

## Recurrence 2026-11-06 (PR #1889 branch)

- **Run:** GitHub Actions CI run 42144144681, job `Tests (root-bridges)`
  (`mise run test:full` with `ORKESTRATOR_TEST_GROUPS=root,bridges,codex-protocol`),
  branch `remove-work-panel-354fb749b77f-r1` at `f366b85e8`. That branch changes only
  coordinator renderer files and docs; it does not touch this owner,
  `tests/private-tmpdir.ts`, `tests/temp-sweep.ts` or `e2e/playwright.config.ts`.
- **Failure:** only the first case failed. Its nested fixture spec
  (`worker inherits runner TMPDIR`) reported "Test timeout of 30000ms exceeded", and
  the owner case failed at 34765.87 ms. The root group finished 4030 pass / 2 fail; the
  other failure was the deterministic DOM absence scan in
  `tests/unit/test-diagnostic-bounds.test.ts`, which is not a flake.
- **Isolated reruns on 2026-11-06, 16-core Linux host:** `bun test
  tests/unit/private-tmpdir-playwright.integration.test.ts` on a clean `origin/main`
  checkout at `c5a478f67` passed 15 / 0 in 19.2 s. The same owner on the branch at
  `7d86583e0`, through `mise run test:logged -- --name tmpdir-branch`, passed in 18.9 s.
- **Hypothesis:** unchanged, and still unproven: launching Chromium in the nested
  Playwright run exceeds the spec's 30 s budget while the CI shard's other groups run
  at the same time. This is the second CI occurrence, in a different job layout (the
  sharded `Tests (root-bridges)` job rather than "Unit and integration tests").

## Investigation — 2026-11-06 (mitigation applied; status stays open until CI confirms)

- **Pattern:** both CI failures hit the first browser starts in the file, in its first `describe` case (`e2e/playwright.config.ts`, removed on exit), which is the first Chromium launch of the run. On 2026-11-02 the second case, the second launch, then failed at 6.7 s inside the fixture spec's `expect.poll` for `DevToolsActivePort`. That poll used Playwright's default 5 s timeout. Later cases (twelve more launches) never failed. This fits a one-off cold start of the runner's `/usr/bin/google-chrome` (binary pages and font caches, on a shard running other groups) more than per-launch slowness. Unproven, because neither a cold page cache nor the CI runner can be reproduced on this host.
- **Change:** `tests/unit/private-tmpdir-playwright.integration.test.ts` now has a `beforeAll` that starts the selected Chromium once (`--headless --dump-dom about:blank` with a throwaway profile, 120 s bound). The cold start is paid outside the nested runs' 30 s budgets. The fixture spec's `DevToolsActivePort` poll now has an explicit 20 s bound inside its 30 s test budget, replacing the default 5 s. No assertion was changed.
- **Local check (load average 25–40):** `mise run test:logged -- --name pw-tmpdir -- bun test tests/unit/private-tmpdir-playwright.integration.test.ts` PASS (61.1 s, exit 0). No warm-up browser process remained afterwards.
- **To resolve:** several CI `Tests (root-bridges)` and `Unit and integration tests` runs without this failure.
