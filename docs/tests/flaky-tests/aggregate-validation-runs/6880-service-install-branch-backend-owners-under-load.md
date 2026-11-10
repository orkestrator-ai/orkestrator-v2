# To-do 6602 preparation: backend owners triaged `related` to a CLI test change

- **ID:** 6880
- **Status:** open
- **Date observed:** 2026-11-06
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` in review preparation for branch `macos-service-install-a16e2242456d-r1` at `87105bf47`, macOS arm64, Bun 1.4.4, 10 CPUs. It ended incomplete (exit 1).
- **Evidence:** `.orkestrator/review-artifacts/review-validation-144d8053-87f3-45ad-aa36-2269d5bbb14e/validation-04.stdout.txt` and the review package beside it (preserved, not committed).
- **Branch change:** only `packages/cli/tests/service-install.test.ts`, `e2e/CodexHostRules.spec.ts`, `e2e/fixtures/codex-host-rules-host.ts` (spawned by that spec alone) and documents. No module imports any of them.

## Failing tests triaged `related`

Each has `references-changed-path` with `changedPath: packages/cli/tests/service-install.test.ts`. That is the false match fixed by to-do 6601 on this branch ([failure triage](../../../architecture/review-preparation.md#failure-triage)): the classifier used to search each test's whole import closure for changed directories, and non-test backend and protocol modules name the directory `packages/cli` in doc comments. The four that do are `packages/protocol/src/public-api.ts:3` (reached through `public-api-resources.ts`, which the goals test imports), `packages/protocol/src/public-api-cli.ts:6`, `packages/protocol/src/node/build-commit.ts:6` and `apps/backend/src/core/bridge-runtime-install.ts:7`. Which of them each closure reaches was not traced. The classifier then names the first changed file under that directory.

| Owner | Test | Original failure | Known case |
| --- | --- | --- | --- |
| apps/backend/src/core/control-mcp-coordinator-goals.test.ts | `setting a goal > the same requestId sets one goal, even after that goal was cleared` | 5 s timeout (5,105 ms). The late call then threw `Orkestrator control MCP is disabled or unavailable` between tests, because the fixture had stopped the server under it | Same shape as [1651](../coordinator-and-multi-review/1651-coordinator-tools-list-timeout-under-load.md), a different test |
| apps/backend/tests/portable-inputs-stamps.test.ts | `a restart with unchanged inputs > the relay's fresh copy of unchanged mounts is still unchanged`; `a changed input is reflected at the next start > adding one input, to a tree and as a file that was absent`, `> removing one input takes only that input out of the home` | 60 s timeout, `entrypoint failed:` with empty stderr | [5561](../environments-and-containers/5561-portable-input-stamps-spawn-latency-deadline.md), [6600](6600-live-head-preparation-owners-vary-with-load.md) |
| apps/backend/tests/claude-state-signal-integration.test.ts | `hook writers serialize counters and retain a completed turn without any config` | `working 4 0` instead of `working 20 0` | [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md) |

## Runs alone at `87105bf47`

Each ran through `mise run test:logged` as `bun --cwd=apps/backend test <file> --only-failures`. Load is the one-minute average around the run.

| Owner | Result |
| --- | --- |
| control-mcp-coordinator-goals | pass, 31.3 s, load about 53 |
| claude-state-signal-integration | pass, 0.7 s, load about 16 |
| portable-inputs-stamps | fail: 40 pass, 10 fail, 951 s, load about 50 to 53. All ten were 60 s timeouts with `entrypoint failed:` and empty stderr; they include two of the three aggregate failures and eight other tests |
| portable-inputs-stamps, `--parallel=2` | pass, 154 s, load about 14 to 15, exit 0 (passing output removed by the runner, so no totals) |

## What this shows

- **Established:** the three owners cannot load anything this branch changed, and the `related` verdicts come from the 6601 false match. The goals and hook-writer owners passed alone. The stamps owner failed alone at a load near 50 and passed alone at about 14, as in 6600, where 22 of 50 failed alone at load 38 and all passed at load 17.
- **Not established:** the mechanism behind the timeouts. Spawn latency was not measured in these runs.

## Fix

None here. No assertion, deadline or fixture changed. The tests belong to other areas. To-do 6601 fixed the classifier match; to-do 6920 then limited how far a changed import may be before it alone makes a failure `related` ([failure triage](../../../architecture/review-preparation.md#failure-triage)).
