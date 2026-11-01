# Automatic account switching branch validation

- **ID:** 1652
- **Status:** open
- **Date observed:** 2026-11-01
- **Branch:** `select-soonest-reset-76510e6abff6-r1` at `aefd1d122`, built on `origin/main` `93b99bfba`.
- **Commands:** `mise run test` and `mise run test:browser`, run together by review validation. The host capacity queue reported 18/18 slots reserved by other worktrees. The default suite waited about 815 s, and the browser suite ran with six workers.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-ed33370f-1bad-49f1-bb80-e76ff470a945/validation-04.stdout.txt` and `validation-05.stdout.txt`, in that worktree.

Neither owning test nor anything it imports changed on the branch.

| Owner | Failure on the branch | On `origin/main` `93b99bfba` |
| --- | --- | --- |
| `tests/unit/playwright-validation.test.ts`, the six `Playwright worker cap and retry policy` cases | Exit 1 in the child, alone too (one pass, six fails). Its stub `os.cpus = () => Array(n).fill({})` has no `model`, and Playwright 1.64's `calculatePlatform` calls `cpu.model.includes("Apple")` on macOS: `TypeError: undefined is not an object (evaluating 'cpu.model.includes')`. Deterministic on macOS, so not a flake. | The same six fail alone and in all seven default-suite runs. |
| `e2e/AgentLaunchDialog.spec.ts:18`, `selects a native branch suggestion with the keyboard and confirms`, both projects | The field stays `rel`, alone too. It needs Chrome's native datalist popup, as in [1251](1251-dialog-default-width-validation.md). | The same two fail alone, and in a full browser run (1029 passed, two failed, one flaky, 108 skipped). |
| `apps/desktop/scripts/dev/bridge-builds.test.ts` | Timed out at 15,005 ms. See [1202](../electron-and-desktop/1202-bridge-build-startup-aggregate-timeout.md). | **Not reproduced.** See 1202. |
| `e2e/VirtuosoFollow.spec.ts` | Passed on retry. See [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md). | Did not recur; `e2e/PaneBreakpoint.spec.ts` was the flaky case instead. |

The "service qualification and cleanup" failure named in the validation summary is not one. `tests/unit/qualify-standalone-service.test.ts` passes (26 passed, alone and in that run); its `FAIL cleanup` lines are what it logs for injected failures.

Timing failures seen only on `origin/main` during the same reproduction, each in one default-suite run of seven, none seen in the branch's one run:

- `POST /session/:id/fork > a busy source is refused before the fork extension`, `acp-bridge`.
- `CO-05/UP-02 coordinator mail to and from a leaf agent > delivers as ordinary incoming mail and routes the agent's answer to that command node's outbox`, backend.
- `design service startup > removes the recorded profile of a backend that was killed`, backend ([1314](../design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md)).

No assertion, timeout or skip changed in any owner.
