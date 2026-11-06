# To-do 4520 preparation: owners that pass or fail alone with no code change

- **ID:** 6600
- **Status:** open
- **Date observed:** 2026-11-05
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` in review preparation, macOS arm64, Bun 1.4.4, 10 CPUs. It ended incomplete at the 1,800 s group deadline with no closing totals.
- **Commits:** failures recorded at `92241e0eb`; reruns at `a4eba4a9d`. Neither changes anything outside `apps/web/src/hooks/` and `docs/`.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-8ee81cce-14a1-40bb-9709-07e0974a61b9/validation-04.stderr.txt` (preserved, not committed).

## Failing tests

These 16 were triaged `related` through the false match described in [to-do 6601](../../../todo/coordinator-and-multi-review/6601-triage-related-from-a-directory-named-in-a-comment.md). Their import closures reach no changed file. The 17th `related` failure, in `packages/cli/tests/service-install.test.ts`, fails every time and is in [to-do 6602](../../../todo/cross-cutting/6602-service-install-and-codex-host-rules-fail-alone.md), so it is not a flake.

| Owner | Tests that failed in the aggregate | Original failure |
| --- | --- | --- |
| apps/backend/tests/commands-container-exec.test.ts | `gives an image without the helper the token-bearing rewrite, idempotently`; in `GitHub credential helper`: `answers Git from the token file and keeps the token out of the config`, `never hands the token to another host or over plain HTTP`, `an empty token removes the helper and the SSH rewrite`, `the fixture is not answered by the runner's checkout or environment`, `keeps working after setup clears credential.helper, on either order`, `replaces a GitHub helper copied from a host config`, `takes a token out of an origin left by an earlier clone` | 5 s timeout; a child's status `null` instead of 0; `killed 1 dangling process` |
| apps/backend/tests/claude-state-signal-integration.test.ts | `hook writers serialize counters and retain a completed turn without any config` (case [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md)) | `working 2 0` instead of `working 20 0` |
| apps/backend/tests/container-readiness.test.ts | `bounded in-container boot wait > a pending shell probe is clipped to the remaining overall deadline` | 2,656 ms against a 1,500 ms bound |
| apps/backend/tests/portable-inputs-shared-skills.test.ts | `shared skills root (task 1) > the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount` | 5 s timeout |
| apps/backend/tests/portable-inputs-stamps.test.ts | `a changed input is reflected at the next start > changing one file in a tree copies that tree alone`, `> a file that never came from an input is never removed` | 60 s timeout, `entrypoint failed:` with empty stderr (the pattern of case [5561](../environments-and-containers/5561-portable-input-stamps-spawn-latency-deadline.md)) |
| apps/backend/tests/portable-inputs-user-extensions.test.ts | `user skills and commands in containers > withholds nested credentials before staging and import while preserving safe resources`, `> the entrypoint imports them where Claude and Grok read user resources` | 5 s timeout |
| apps/backend/src/core/coordinator-worker-turns.test.ts | `stop_worker_turn > an idle tab answers plainly, and nothing is marked or stopped` | 5 s timeout; `git` in the fixture ended by SIGTERM |

## Runs alone at `a4eba4a9d`

Each ran through `mise run test:logged`, as `bun test --cwd apps/backend <file> --parallel=1 --only-failures`, unless noted. Load is the one-minute average when the run ended.

| Owner | First pass | Second pass | Later |
| --- | --- | --- | --- |
| commands-container-exec | pass, 5 s, load 24 | fail: 13 pass, 2 fail, 48 s, load 67 | fail: 9 pass, 6 fail, 55 s, load 45; then 8 of 8 pass, 5 to 7 s, load 28 to 32 |
| claude-state-signal-integration | pass, 1 s, load 24 | fail: 6 pass, 1 fail, 8 s, load 67 | pass, 1 s, load 33 |
| container-readiness | fail: 20 pass, 1 fail, 7 s, load 24 | fail: 18 pass, 3 fail, 27 s, load 58 | pass, 8 s, load 34 |
| portable-inputs-shared-skills | pass, 4 s, load 29 | fail: 18 pass, 3 fail, 24 s, load 56 | pass, 2 s, load 34 |
| portable-inputs-user-extensions | fail: 2 pass, 1 skip, 3 fail, 22 s, load 40 | fail: 2 pass, 1 skip, 3 fail, 23 s, load 54 | pass, 2 s, load 34 |
| coordinator-worker-turns | pass, 41 s, load 45 | fail: 17 pass, 2 fail, 65 s, load 43 | pass, 7 s, load 34 |
| portable-inputs-stamps | fail: 28 pass, 22 fail, 1,490 s, load 38 | not run | pass, 171 s, load 17, with `--parallel=2` |

The tests that fail change from run to run, and they are often not the ones that failed in the aggregate.

The first pass passed `--preload` wrongly, as one quoted word. That does not affect the comparison: `apps/backend/bunfig.toml` already applies the same preload, and `commands-container-exec` passed all eight alternating runs at load 28 to 32, four with the flag and four without.

## What this shows

- **Established:** with no code change, each of these owners has passed and failed alone. Most passes came at the lower loads and most failures at the higher ones. No failing test can load the changed code.
- **Not established:** the mechanism. Load is a correlation, not a cause, and the bands overlap (`container-readiness` failed once at load 24; `coordinator-worker-turns` passed at load 45).
- **Not slow spawning, in the runs measured:** during the failing `commands-container-exec` run at load 45, 79 spawns of `/usr/bin/true` had a median of 4.9 ms, a 90th percentile of 21.7 ms and a maximum of 76.7 ms. That is far from the 279 to 379 ms in case 5561. Separately, between failures, `bash -c "exit 0"` and `git config` took about 25 to 40 ms.
- **An unproven lead:** the timeouts look like a stall rather than slowness: the child status is `null` and the test ends at exactly its deadline. [To-do 4260](../../../todo/cross-cutting/4260-bun-loses-child-process-events.md) records Bun losing child completion events, but for asynchronous pipe readers, whereas these fixtures use synchronous `spawnSync`. No stalled child was sampled here.

When the host was sampled, headless Chromium processes this work had not started were among its busiest. Nothing on the host was stopped or changed for these measurements.

## Browser suite

In the same preparation, `scrollbar departure after find stays put when streaming reapplies highlights` (`e2e/StreamingTranscript.spec.ts:361`, case [0767](../native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md)) failed on mobile. Run alone at a load of about 43 on both projects, with two workers on a private port, it passed. The whole command then hit its 1,800 s deadline with 1,220 of 1,590 tests reported. `CodexHostRules.spec.ts` failed alone too, so it is in to-do 6602.

## Fix

None here. No assertion, deadline or fixture changed, because a longer deadline on this branch would only hide the condition, and the tests belong to other areas.

## Recurrence 2026-11-05 (worktree-probe change)

On arktech-mini at `585cf97d8` plus the uncommitted worktree-probe change,
`linked skill entries (task 2) > the entrypoint imports a linked skill where
Claude reads user skills` (`apps/backend/tests/portable-inputs-shared-skills.test.ts`)
timed out at 5009.67 ms in the four-worker backend aggregate of `mise run test`,
at a load average of about 31 measured just after the run. The unchanged
owning file passed alone in 2.2 s:

```sh
mise run test:logged -- --name linked-skill -- mise exec -- bun --cwd=apps/backend test ./tests/portable-inputs-shared-skills.test.ts --parallel=1
```

The same run also failed case
[9834](../environments-and-containers/9834-container-status-excludes-aggregate-timeout.md).
