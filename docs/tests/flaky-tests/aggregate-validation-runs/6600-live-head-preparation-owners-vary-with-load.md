# To-do 4520 preparation: owners that pass or fail alone with no code change

- **ID:** 6600
- **Status:** open
- **Date observed:** 2026-11-05
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` in review preparation, macOS arm64, Bun 1.4.4, 10 CPUs. It ended incomplete at the 1,800 s group deadline with no closing totals.
- **Commits:** failures recorded at `92241e0eb`; reruns at `a4eba4a9d`. Neither changes anything outside `apps/web/src/hooks/` and `docs/`.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-8ee81cce-14a1-40bb-9709-07e0974a61b9/validation-04.stderr.txt` (preserved, not committed).

## Failing tests

These 16 were triaged `related` because a doc comment naming `apps/web` in `packages/protocol/src/web-annotations.ts`, which their import graphs load, counted as a reference to the changed directory. To-do 6601 fixed that on 2026-11-05: a replay of these failures now gives `undetermined` ([failure triage](../../../architecture/review-preparation.md#failure-triage)). Their import closures reach no changed file. The 17th `related` failure, in `packages/cli/tests/service-install.test.ts`, failed every time on macOS, because it faked Linux and then read the host's `/proc` for a process identity, so it is not a flake. The test now publishes a fixed identity.

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

In the same preparation, `scrollbar departure after find stays put when streaming reapplies highlights` (`e2e/StreamingTranscript.spec.ts:361`, case [0767](../native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md)) failed on mobile. Run alone at a load of about 43 on both projects, with two workers on a private port, it passed. The whole command then hit its 1,800 s deadline with 1,220 of 1,590 tests reported. `CodexHostRules.spec.ts` failed alone too, so it is not a flake either: it took a `[storage] ledger.moved` log line from its fixture host as the host's address, and now waits for the host's readiness marker instead.

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
[6603](../environments-and-containers/6603-container-status-excludes-aggregate-timeout.md).


## Storage/mail review recurrence — 2026-11-06

The exact recorded command, `mise run test:logged -- --name review-default-tests -- mise run test`,
recurred on the storage/mail branch (`023c7a2ce`, followed by the unchanged-test
classification rename `ee92c4741`). The workspace reserved six slots; backend
used four isolated workers alongside two web workers and the root group.
The completed backend totals were 16,613 pass, 138 skip, 4 fail and 2 errors
across 16,755 tests in 1,109 files (670.51 s execution). The full command
finished with exit 1 in 1,499.6 s; workspace and root failed, while bridges
and the protocol lockfile passed.

Evidence: `workspace-web-backend-desktop-web-public-cli-protocol-toolchain` in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KcOGqn`;
outer wrapper `orkestrator-test-run.uRCFAT` under the same temporary root.

The shared-skills owner had two 5 s timeouts, both receiving a null child exit
code instead of zero from `runEntrypoint`:

- `shared skills root (task 1) > the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount`: 5,012.10 ms.
- `review security regressions > Codex materializes cross-provider links and imports siblings per entry`: 5,011.76 ms.

The unchanged complete owner passed alone, exit 0 in 4.2 s:

```sh
mise run test:logged -- --name findings-shared-skills -- bun test --cwd apps/backend ./tests/portable-inputs-shared-skills.test.ts --parallel=1 --only-failures
```

Passing logs were removed; isolated case counts are not inferred. No portable
input code, assertion, deadline or skip changed. This records intermittence;
load was not measured and no cause was established.

The two backend errors between tests were the same null-exit-code assertions
from these two timed-out `runEntrypoint` calls, not additional failing owners.
Their contexts were inspected in the compressed workspace artifact after the
aggregate completed.

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/backend/tests/portable-inputs-shared-skills.test.ts` — `shared skills root (task 1) > the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount`: Test deadline 5,000 ms exceeded. Observed 5009.88ms. Complete unchanged owner: 21 pass, 0 fail, 0 skip in 6.65 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-shared-skills -- bun test --cwd apps/backend ./tests/portable-inputs-shared-skills.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/shared-skills.xml
```

- `apps/backend/tests/portable-inputs-shared-skills.test.ts` — `linked skill entries (task 2) > the entrypoint imports a linked skill where Claude reads user skills`: Test deadline 5,000 ms exceeded. Observed 5014.14ms. Complete unchanged owner: 21 pass, 0 fail, 0 skip in 6.65 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-shared-skills -- bun test --cwd apps/backend ./tests/portable-inputs-shared-skills.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/shared-skills.xml
```

- `apps/backend/tests/portable-inputs-stamps.test.ts` — `a changed input is reflected at the next start > changing one file in a tree copies that tree alone`: Test deadline 60,000 ms exceeded. Observed 60026.06ms. Complete unchanged owner: 50 pass, 0 fail, 0 skip in 186.11 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-portable-stamps -- bun test --cwd apps/backend ./tests/portable-inputs-stamps.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/portable-stamps.xml
```

`mise run flaky:recurrence -- 6600 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` reported the case open; this records a recurrence.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
