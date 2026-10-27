# Provider non-delivery proof (todo 0223) branch validation

- **ID:** 1147
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0223-provider-non-delivery-proof-13033aea66e1`, based on
  `origin/main` `863b57821`. The branch changes the backend dispatch recovery
  (`review-fanout.ts`, `multi-review-service.ts`,
  `build-pipeline-review-fanout.ts`, `build-pipeline-service-supervisor.ts`,
  `http-bridge-provider.ts`), `packages/protocol` (`native-agent.ts`,
  `build-pipeline.ts`), all five HTTP bridges, the shared bridge contract
  scenarios and docs.
- **Command:** `mise run test`, twice. First run (`orkestrator-test-run.ubhxMD`
  under the host temporary directory): backend 12,100 passed, 120 skipped, 13
  failed; root/support 3,516 passed, 12 failed; Codex bridge 2,458 passed, 1
  failed; the other bridges, web and the protocol lockfile passed. Two of the
  backend failures were this branch's (below) and were fixed before the second
  run (`orkestrator-test-run.38P3gc`): backend 12,105 passed, 120 skipped, 8
  failed; root/support 3,526 passed, 2 failed; desktop two failed; bridges, web
  and the protocol lockfile passed.
- **Host:** shared macOS host, other sessions' suites in parallel.

## This branch's failures (fixed)

- `apps/backend/src/core/build-pipeline-steps.test.ts` "redispatches a lost
  prompt with the step's own model and effort": its recording provider had no
  `dispatchStatus`, so the new at-most-once gate parked the redispatch. The
  provider now answers from the ids it took (`absent` otherwise). 34 passed.
- `apps/backend/tests/claude-cold-dispatch-restart.test.ts`: the resend step
  this branch added failed 2 runs in 10 alone with HTTP 500 "Timed out waiting
  for session preference lock", because the SIGKILLed bridge sometimes died
  holding the preference lock (todo 0059). The test now kills only once the
  turn's writes released the lock: 15 of 15 passed.

## Remaining failures and what they are

Owners were rerun alone with `bun test --preload <setup-node> <file>` on the
branch and on a detached worktree of the base `863b57821` in the host
temporary directory with its own `bun install` (removed afterwards).

| Owning file | Aggregate failures | Branch alone | Base alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/tests/staged-input-relay.test.ts` | Four relay cases (mode `493`, expected `448`) | 5 passed, 4 failed | 5 passed, 4 failed | Deterministic on this host; not a flake. Recorded here. |
| `apps/backend/tests/docker-image.test.ts` | Two `pinned image identity` cases (missing `--add-host`/gateway arguments) | 19 passed, 2 failed | 19 passed, 2 failed | Deterministic on this host; see [0263](../environments-and-containers/0263-docker-image-identity-aggregate-timeout.md) for the aggregate timeouts. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 20 passed, 2 failed | 20 passed, 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | Both `verified copy helper` extraction cases | 10 passed, 2 failed | 10 passed, 2 failed | [1013](1013-interactive-command-main-merge-validation.md) |
| `tests/unit/firewall-policy.test.ts` | Eight five-second deadlines (first run only) | 34 passed | 32 passed, 2 failed | [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md), [0983](../environments-and-containers/0983-firewall-root-entrypoint-shell-timeout.md) |
| `tests/unit/disk-report.test.ts`, `tests/unit/firewall-refresh.test.ts` | Five-second deadlines (first run only) | passed | passed | [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md), [0199](../environments-and-containers/0199-firewall-refresh-aggregate-timeouts.md) |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule moves, failed re-link, restart re-link (first run only) | 38 passed | not needed | [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md) |
| `apps/backend/src/core/commands-registry-coordinator.test.ts` | Dirty submodule switch confirmation (first run only) | 23 passed | not needed | Aggregate-only; recorded here. |
| `apps/backend/src/core/agent-accounts-active.test.ts` | Owner login renewal before the coordinator handoff (first run only) | 27 passed | not needed | [0930](../backend-services-and-tooling/0930-coordinator-codex-login-renewal-loginless.md) |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | `its first answer is stale until a settling re-read…` timed out (first run only) | 30 passed | not needed | [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md) |
| `apps/backend/src/core/preview-local-discovery.test.ts` | `terminal exited 0` (second run, and an earlier focused backend run) | 19 passed | 19 passed | [1145](../previews-annotations-and-gateway/1145-preview-local-discovery-terminal-exit.md) (new) |
| `apps/backend/src/core/opencode-sdk-fetch.test.ts` | Body `{}` instead of `ok` (second run only) | 5 passed | 5 passed | [1146](../backend-services-and-tooling/1146-opencode-sdk-fetch-aggregate-body.md) (new) |

## Conclusion

Apart from the two fixed above, none of these owners is reached by the 0223
change: staged input relay, Docker image arguments, profile cleanup and
migrate-copy fail the same way on the base, and the rest pass alone on the
branch. No assertion, deadline, skip or implementation was changed to hide a
failure.


## Recovery review implementation validation (2026-10-27)

A further `mise run test` ran through `test:logged` with four concurrent groups:
workspace four worker slots (Turbo concurrency two), root/support one, bridges
two, and lockfile one. Artifacts: `orkestrator-test-run.mif9L3` (inner groups)
and `orkestrator-test-run.ikB7ZC` (outer logged command), under the host temporary
directory. The run finished in 511.6 seconds. Bridges and the protocol lockfile
passed. Backend: 12,130 passed, 120 skipped, nine failed; desktop: 1,369 passed,
16 skipped, two failed; root/support: 3,526 passed, two failed. Other workspace
packages passed.

Three backend failures were related fixture assumptions in
`build-pipeline-steps.test.ts`: its provider fabricated a structured result for
any requested id, including unsent ones. The shared recovery rule correctly
accepted that purported result instead of resending. The fake now returns a
result only for an id in its accepted-id set; all 34 owning-file tests passed.
The combined pipeline/fan-out run also passed after this correction:

```sh
mise run test:logged -- --name pipeline-and-fanout -- bun test --cwd apps/backend ./src/core/build-pipeline-steps.test.ts ./src/core/build-pipeline-service-recovery.test.ts ./src/core/build-pipeline-result-reminder.test.ts ./src/core/review-fanout-dispatch.test.ts ./src/core/review-fanout-interleaving.test.ts ./src/core/build-pipeline-review-fanout.test.ts --parallel=4 --only-failures
```

Remaining failures match the previously recorded base failures above:

- `tests/unit/migrate-copy.test.ts`: both missing-completion cases expected
  extraction status `0` but received `2` (41.36/41.70 ms). Its isolated logged
  rerun with `--parallel=1` repeated them: 10 passed, two failed (1.1 s).
- `apps/desktop/scripts/dev/profile-cleanup.test.ts`: both extra
  `keychainWarning` failures repeated alone with `--parallel=1`: 20 passed,
  two failed (0.5 s).
- `apps/backend/tests/docker-image.test.ts`: both missing `--add-host`
  failures repeated alone with `--parallel=1`: 19 passed, two failed (4.2 s).
- `apps/backend/tests/staged-input-relay.test.ts`: the four relay
  failures match the previous runs and base comparison above. An isolated
  logged rerun with `--parallel=1` repeated them: five passed, four failed
  (0.3 s).

These are repeatable failures, not newly classified flakes. No assertion or
skip was changed for them. Format, lint and typechecking passed through
`mise run check`; the new cancellation, legacy-upgrade, round-trip and
saved-result regressions passed in their focused suites. Signed-in restart
qualification for Claude, Codex and Pi and the remaining Cursor/Grok limits are
recorded in [0223](../../../todo/coordinator-and-multi-review/0223-provider-non-delivery-proof.md).
