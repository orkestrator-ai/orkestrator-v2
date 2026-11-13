# Graph project templates: a retired watch's readiness reported a change under load

- **ID:** 9989
- **Status:** open
- **Date observed:** 2026-11-11
- **Test:** `watching > readiness from a retired watch cannot rescan or rearm it`
- **File:** `apps/backend/src/core/graph-project-templates.test.ts:162`
- **Base commit:** `14df96544` (`git merge-base HEAD origin/main` on branch `conversation-links-de945f872863-r1`, to-dos 0038 and 7440, at `c5991d56e`).
- **Original command:** `mise run test:logged -- --name rerun-default-tests -- mise run test` on beelink2 (Linux, 16 threads) while other worktrees' aggregate runs shared the host (load average 62.8 over 1 minute when it started).
- **Failure:** `expect(changes).toEqual([])` received `["p1"]` at line 185, after the test's 20 ms wait (26.29 ms).
- **Suite counts:** root and agent-support, bridges and codex protocol lockfile groups passed; the workspace group's only failure was this test. The aggregate runner's own isolated rerun of the file queued for host capacity and was cut off by the 30-minute group deadline without a verdict.
- **Isolated rerun:** `mise run test:logged -- --name graph-templates-alone-N -- bun --cwd=apps/backend test src/core/graph-project-templates.test.ts --parallel=1` passed three times in a row (1.6 s, 1.7 s, 0.8 s).
- **Changed code:** the branch changes design-canvas, design protocol and perf-harness files only; nothing it changes is imported by this test or `graph-project-templates.ts`.
- **Hypothesis:** the test writes a real file into the checkout after `forget("p1")`; under load a file-system event or a settle from the earlier part of the test may still be delivered to `onChange` after the 20 ms wait starts. Unproven; not reproduced.

## Recurrences

- **2026-11-13**, base `17d28238c098b4443d1289df5c4ed75e7cc2802e`, branch
  `dev-test-checks-415ac044ae03-r1` at `3a88e8609` (docs, `scripts/`,
  `tests/unit/`, `mise.toml` and a workflow; nothing under `apps/`). Same
  assertion at line 185 (`["p1"]` received). Command:
  `mise run test:logged -- --name review-default-tests-rerun3 -- mise run test`,
  default workers, load average about 34 to 52 on 16 threads. Counts: backend
  18,150 passed and 1 failed; web 14,721 passed and 1 failed (flake
  [9996](../design-canvas-and-artifacts/9996-static-html-read-failure-search-withheld.md));
  desktop 2,149, protocol 5,835, toolchain 135, CLI 526, web-public 52, root,
  bridge and codex protocol lockfile groups passed. The aggregate runner's own
  lone rerun, while other worktrees still held the host, **failed** the same
  way (`FAILED ALONE (476ms)`, line 185). Three manual lone reruns straight
  after, `mise run test:logged -- --name alone-graph-N -- bun --no-env-file scripts/bun-test-tier.ts apps/backend src/core/graph-project-templates.test.ts -- --only-failures`,
  passed (0.6 s, 0.9 s, 0.8 s). A lone failure under load means the test does
  not need a sibling file to fail, which fits the hypothesis of a late
  file-system event. `mise run flaky:recurrence -- 9989 --base 17d28238c`:
  "open, record as a recurrence". Evidence:
  `orkestrator-test-run.2L8bxS/rerun-apps-backend-src-core-graph-project-templates-test-ts.log.gz`
  under the host temporary directory.
