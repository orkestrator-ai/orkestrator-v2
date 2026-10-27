# Codex Default-mode question (todo 0161) branch validation

- **ID:** 1175
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0161-codex-default-mode-question-2cf150514fc2`, based on
  `origin/main` `863b57821`. Outside `bridges/codex-bridge` and docs the
  branch changes only comments in `apps/backend/src/core/http-bridge-interactions.ts`
  and the test `native-agent-service-projection-lifecycle.test.ts`; every
  owner below, and everything it imports, is byte-identical to the base.
- **Command:** `mise run test` (logs `orkestrator-test-run.TBDb6d` below the
  host temporary directory). The Codex protocol lockfile and bridges passed
  (bridges 156.9 s); web passed (9,941); backend 11,477 passed, 106 skipped,
  18 failed; desktop two failed; root/support 3,526 passed, two failed.
- **Host:** shared macOS host, 18 cores, load average 63–104 while the suite
  and the reruns ran. The checkout is on an APFS volume mounted `noowners`.

## Failures and what they are

Owners were rerun with `mise run test:logged -- --name 0161-<owner> -- bun
test --cwd <package> <file> --parallel=1 --only-failures`; a first combined
backend rerun at `--parallel=2` (`orkestrator-test-run.21QSu7`) failed more
widely, all five-second deadlines, at load average about 100.

| Owning file | Aggregate failures | Owner alone on the branch | Registry |
| --- | --- | --- | --- |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity`: restricted runtime joining its egress gateway, rootless daemon host address; the `--add-host` argument is missing | 19 passed, 2 failed, deterministic (1.8 s, `63BISY`) | Recorded here; the cases came with todo 0109 (`1aabf049e`, in the base). |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases: modes read `0755` where `0700` is expected, refusals do not happen | 5 passed, 4 failed, deterministic (0.5 s, `gVP7rI`) | Recorded here; consistent with the `noowners` mount. |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | `V09: environments aliasing one checkout share one watcher and scan` (14.0 s) | 14 passed, 1 failed (35.0 s, `9XNbib`) | Recorded here. |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init > initializes a local repository…`: `git rev-parse HEAD` failed | 10 passed, 1 failed (21.1 s, `PZshgR`) | Recorded here. |
| `apps/backend/src/core/environment-move.test.ts`, `worktree-snapshots-git.test.ts`, `commands-environment-worktree-location.test.ts`, `apps/backend/tests/worktree-watcher.test.ts`, `commands-integration.test.ts`, `commands-registry-environments.test.ts` | Five-second deadlines on real-Git fixtures | Failed again in the combined rerun under the same load | Same owners and cases as [1101](1101-codex-typed-prompts-0211-validation.md), which also failed on the base. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 20 passed, 2 failed, deterministic | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper`: extraction status 2, not 0 | 10 passed, 2 failed, deterministic | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |

## Conclusion

None of these files is reached by the 0161 change: the only runtime change is
in `bridges/codex-bridge/src/app-server/interactions.ts`, whose only importer
outside the bridge is the updated backend test, and the bridges group passed.
The four owners new to this list fail alone on code identical to the base, so
they were not run on a separate base worktree. No assertion, deadline, skip or
implementation was changed.

## Coverage follow-up validation (2026-10-27)

Only live-test code, the paused-interaction case selector, and documentation
changed in this follow-up; no runtime implementation changed.

- `mise run check` passed after each test edit; focused question interaction,
  router, runtime lifecycle, and backend projection tests passed (8.0 s).
- Fixed real-app-server deadline qualification passed (652.8 s): a held
  Default-mode question survived 10.5 minutes and returned the chosen answer;
  an unheld control expired after five minutes with an empty answer. Summary:
  host temporary directory `orkestrator-test-run.2w0Gfw/summary.json`.
- Aggregate `mise run test` artifacts are in host temporary directory
  `orkestrator-test-run.SuudhC` (completed in 1,957.4 s, including capacity
  waits). Host load reached 253/219/206. The protocol lockfile passed;
  workspace, root/support and bridges failed outside the changed question
  tests. Backend finished with 11,444 passed, 106 skipped and 51 failed.
  Root/support repeated only the two known `migrate-copy` failures (3,526 passed); owner rerun `Aqe4zz` repeated both (10 passed).
- Desktop repeated the two Keychain-warning assertions above; owner rerun
  `6mqieY` repeated both (20 passed). Backend's real-Git worktree cases hit
  five-second deadlines again; `environment-move.test.ts` alone (`Ap6MvT`)
  also timed out (17 passed, 21 failed, 19 follow-on errors, 247.8 s).
- Bridges additionally hit Codex catalogue's two-second settle wait
  ([0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md)); its
  owner rerun (`u3qij2`) failed a sibling settle-wait case (29 passed).
  Claude coordinator sandbox cases `default-sandbox-writes` and
  `unavailable-hook-refuses-abbreviation`, execution-policy `escape`, and
  steer-journal `bounds coalesced input at 64 UUIDs and definitively refuses
  excess steers` also failed. The steer owner passed alone
  (`question-claude-steer-baseline`, 5.4 s); the two policy owners together (`YCbFZN`) passed 12 cases and
  repeated only `default-sandbox-writes` (the CLI's 15-second abort, 101.8 s
  total). These owners and their runtime imports are unchanged by the follow-up.

The billed browser run's question outcome and its separate approval-model
completion-token failure are recorded in
[todo 0161](../../../todo/agent-engines/0161-codex-default-mode-question-activity.md#qualification).

The independent question-only browser qualification then passed all three
tests (745.9 s), with its default 10.5-minute wait, reload, chosen-codeword
completion, and both setup-cleanup cases. Artifacts:
`output/agent-testing/codex-question-only-0161/browser/`; host temporary
summary `orkestrator-test-run.wM2c5n/summary.json`.
