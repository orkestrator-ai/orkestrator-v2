# Idle-spec sidebar probe (todo 0199) branch validation

- **ID:** 1290
- **Status:** open
- **Date observed:** 2026-10-28
- **Branch:** `todo-0199-idle-spec-sidebar-probe-14c5f40807ee`. The branch
  changes only `e2e/` helpers and specs, `tests/unit/components/EnvironmentItem.test.tsx`
  and docs. No owner below changed.

## Run 1: `mise run test` on base `6a6009a09`

- **Host admission:** four worktrees ran aggregates at once, with a load
  average of 37–44. Workspace and root waited 568 s for an exclusive resource
  held by another worktree. Bridges never ran: the 1,800-second deadline in
  `test:logged` expired while the group was still queued.
- **Evidence:** `orkestrator-test-run.gMsRpq/summary.json` and the group logs
  in `orkestrator-test-run.XvMSFe/`, under the host temporary directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `name the store they write` timed out at 7,312 ms (5,000 ms budget). Earlier observations: [1003](1003-legacy-migration-0058-validation.md), [1010](1010-environment-disk-cleanup-0023-validation.md), [1247](1247-pending-rename-recovery-validation.md). | Also timed out alone, at 7,203 ms, still under load. On a clean `origin/main` (`6a6009a09`) checkout it timed out the same way (6,088 ms), so it is load, not this branch. |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Maximal-list filtering expected one projection read and saw two (3,919 ms). Recurrence of [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). | Passed alone: `bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.commands.test.tsx src/components/federation/node-action-requests.test.tsx` (the federation owner failed in that run, see below). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Over-limit root-change approval timed out at 8,610 ms. | Also timed out alone, at 7,295 ms, under load. It timed out the same way on clean `origin/main` (5,905 ms). |

The bridges group was then run by itself, as `test-all.ts` runs it:
`mise run test:logged -- --name bridges-group -- bunx turbo run test:bridge --cwd . --filter=./bridges/* --concurrency=2`
passed (143 s). An earlier bare `bun test bridges --parallel=2 --only-failures`
also ran the slow-tier `*-live.test.ts` and `*.live.test.ts` files, which the
default tier excludes. Its 20 failures (the ACP bridge's process reaping,
Claude's sandbox qualification and pinned-CLI structured output, scripted
endpoints only) are outside `mise run test` and were not investigated.

## Run 2: `mise run test` after rebasing on `92f8c25a7`

- **Host admission:** load average about 14. Run with
  `ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS=3600000`. Root (394 s), bridges (252 s)
  and the codex protocol lockfile (171 s) passed. The workspace group failed
  on one test. The groups finished in 474 s.
- **Evidence:** `orkestrator-test-run.QxwkSu/` under the host temporary
  directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `apps/backend/tests/codex-subagent-cards.test.ts` | `each child keeps one card, its transcript and status across a fresh backend and a cold restart`: the cold projection read `recovering` instead of `idle` (1,145 ms). Recurrence of [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). | `mise run test:logged -- --name codex-subagent-cards-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` passed. A second rerun with no filter showed 1 pass, 0 fail. |

No implementation, assertion, wait, timeout or skip in these owners changed.
The aggregate stays non-green. The two timeouts reproduced alone only under
heavy load, and identically on `origin/main`.

## Review follow-up (2026-10-28)

Preparation passed `mise run format:check`, `mise run lint` and
`mise run typecheck`; the passing repository-wide lint and type checks were
reused. Repository formatting was rerun after editing and passed.
The changed fixtures and specs passed focused lint, both E2E TypeScript
projects and formatting checks. The dedicated sidebar-probe browser spec
passed in both Chromium viewport projects (2 tests, 16.9 s), including
working/waiting/idle updates, stopped and markerless stopping rows, a working
neighbour, an absent name and an unrelated same-named label. It no longer
depends on the phone settings drawer (0278).

The exact incomplete preparation command `mise run test` was rerun through
`test:logged` (`sidebar-review-default`). Root/agent support, bridges and the
protocol lockfile passed. The workspace group failed; all reported owners are
unchanged by this branch. Evidence: `/tmp/orkestrator-test-run.3QKeuI/` and
`/tmp/orkestrator-test-run.dLhC3S/`.

| Owner | Aggregate result | Complete owner rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | 5 s deadline expired at 8,126 ms, as in Run 1. | Still failed at 5,146 ms; not classified as a new flake. Evidence: `/tmp/orkestrator-test-run.J7YiLY/`. |
| `apps/backend/src/core/native-agent-command-catalogue-scale.test.ts` | Maximal inventories timed out at 6,192 ms; existing [0826](../native-agents-and-transcripts/0826-command-catalogue-maximal-inventories-timeout.md). | Passed unchanged, 6.3 s. |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Maximal-list filtering failed; existing [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). | Passed unchanged, 11.4 s. |
| `apps/web/src/lib/chat/rich-conversation-revocation.test.tsx` | Sibling ledger length was 0 instead of 1; existing [0626](../native-agents-and-transcripts/0626-rich-content-sibling-ledger-aggregate.md). | Passed unchanged, 2.2 s. |

The exact browser and isolated-browser preparation commands were also rerun.
The first browser attempt was invalidated by overlapping fixture-server and
artifact ownership; it was interrupted and restarted after the focused probe
finished. Only the subsequent run counts as broad browser evidence.

- `mise run test:browser`: the clean rerun was deliberately interrupted
  after reproducing 23 failure titles also present in preparation, all in
  unchanged owners (usage cards, background-task layout, canvas/settings,
  mail and review-flow fixtures). Final result: 25 failed, 6 interrupted,
  218 passed, 60 skipped and 705 not run, 683.0 s. This is incomplete,
  non-green broad coverage, not a passing browser suite. The public-site
  command following the component suite did not run. Evidence:
  `/tmp/orkestrator-test-run.FlGrvw/`. The separate focused probe passed in
  both viewport projects before this run.
- `mise run test:agent:browser:isolated`: the runner's 900 s test deadline
  expired (943.5 s including startup/cleanup), after 11 failures in unchanged
  account/gateway specs and reaching case 24/109. Error contexts show the
  host Docker connectivity dialog blocking the app's accessible project
  tree; the preparation run failed on the same missing project controls.
  Profile `qa-browser-b49d3ad1-055` was stopped and reset by its owner.
  Evidence: `/tmp/orkestrator-test-run.TrzSSq/` and
  `output/agent-testing/qa-browser-b49d3ad1-055/browser/artifacts/`.
- Credentialed targeted qualification did complete: Claude (113.8 s) and
  Codex (136.8 s) each passed the live idle spec with
  `ORKESTRATOR_AGENT_TEST_IDLE_CASES=missed-final`. Both warm-ups recorded exactly
  `working`, `idle`, with no `unknown`; the missed-final cases passed too.
  Timings and run IDs are recorded in
  [0199](../../todo/transcripts-and-observation/0199-idle-observation-spec-sidebar-probe.md#live-qualification-2026-10-28-review-follow-up)
  and [0049](../../todo/transcripts-and-observation/0049-native-agent-idle-observation.md#sidebar-probe-qualification-2026-10-28).
  Profile `idleqa-0199-review` was stopped and reset.
