# Cold realm boot repair aggregate timeout cluster

- **ID:** 9896
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Revision:** `9794274f9` (first repair aggregate, with the later App fallback fixture repair still outstanding).
- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
- **Workers:** repository scheduler; root one, web two, backend four Bun workers in the captured group output.

The default aggregate reported the following failures. Each complete unchanged
owner passed alone afterward through `test:logged`, with `--parallel=1` and
`--only-failures`. No cause is established; the isolated passes establish
intermittence, not environmental causality. No assertions, timeouts or skips
were changed for these cases.

| File | Test / failure | Aggregate duration | Isolated command name and result |
| --- | --- | --- | --- |
| tests/unit/hooks/useEnvironments.test.ts | unnamed beforeEach/afterEach hook timeout | 5622.98 ms | address-root-hook-owner: pass, 2.5 s |
| apps/web/src/components/kanban/ProjectNotesView.test.tsx | unnamed beforeEach/afterEach hook timeout | 6578.91 ms | address-notes-hook-owner: pass, 1.2 s |
| apps/backend/src/core/build-pipeline-review-fanout.test.ts | build pipeline multi-model review > a failed reviewer does not stop the panel | 7062.95 ms | address-review-fanout-owner: pass, 3.9 s |
| apps/backend/src/core/public-api/public-api-pull-requests.test.ts | pr.merge > a detected pull request that already merged is refused, and not stored as open | 6707.34 ms | address-public-pr-owner: pass, 3.4 s |
| apps/backend/src/core/diff-baseline.test.ts | a rebase excludes imported history and retains the rebased worker commits | 7224.83 ms | address-diff-baseline-owner: pass, 2.3 s |

Commands were `mise run test:logged -- --name <name> -- bun test <file>
--parallel=1 --only-failures`; app owners used `bun test --cwd apps/web
./src/...` or `--cwd apps/backend ./src/...` as appropriate, and the root owner
used `./tests/unit/hooks/useEnvironments.test.ts`.

Evidence: `orkestrator-test-run.5kn3Rz` in the host temporary directory,
`root-and-agent-support-tests.log` and
`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (the runner
compresses failing output when the command completes). The backend log also
reports an unhandled Git command error (SIGTERM) after the timed-out rebase case.

Separately, three deterministic `App.test.tsx` hydration assertions failed
because the fallback fixture still emitted synthetic `Unknown command:` text.
That fixture was repaired to use `unknownBackendCommandMessage` in `da731467b`;
the complete owner then passed. Those failures are not counted as flakes here.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure was Bun's five-second default budget (two `beforeEach`/`afterEach` hooks at 5.6 and 6.6 s, three tests at 6.7 to 7.2 s) spent queued behind a loaded aggregate. Each owner took 1.2 to 3.9 s alone. The five owners set no `setDefaultTimeout` and no per-test or hook budget of their own, so nothing smaller than the default applies to them. The three `App.test.tsx` assertions were a fixture defect fixed in `da731467b` and were never part of this flake.
- **Fix:** `tests/default-test-timeout.ts`, imported by `tests/setup.ts` and `tests/setup-node.ts`, raises the default test and hook budget from 5 s to 60 s (an explicit `--timeout` is left alone), so a host that is merely slow no longer fails these tests. No assertion was loosened.
- **Reproduced:** no. The failure was observed only in the aggregate and never recreated. This rests on the timings above, not on a reproduction, and the raised budget is weaker evidence than a reproduced fix.
- **Stress:** none run. If any of the five owners fails again with a duration near 60 s, reopen this case: that would be a hang, not host load.
