# Claude two-reviewer resend: the second reviewer's resend never reached the model under load

- **ID:** 9968
- **Status:** open
- **Date observed:** 2026-11-17
- **Test:** `automatic switching on the pinned claude > two reviewers on one bridge each continue once, still read-only`
- **File:** `apps/backend/tests/account-switch-claude-live.test.ts` (scenarios in
  `apps/backend/tests/account-switch-resend-suite.ts`, runner
  `apps/backend/tests/account-switch-resend-runner.ts:89`, wait in
  `apps/backend/tests/account-switch-stack-host.ts:172`)
- **Observed from:** branch `update-sdks-agents-05fcb748288d-r1`, base
  `ec7178707`, during the Claude Code 2.1.326 / Agent SDK 0.3.326 bump, with
  the pinned 2.1.326 CLI and Codex 0.169.0 from the worktree
  (`ORKESTRATOR_POLICY_CLAUDE_PATH`, `ORKESTRATOR_POLICY_CODEX_PATH`).

## Failure

`mise run verify:accounts:resend-live` (both platform files,
`--parallel=2`, on a Linux host where other agents were running their own
checks): 19 passed, 1 failed in 123.34 s. The scenario failed after
123,318.86 ms with:

```text
Timed out waiting for both reviewers' resends:
[{"account":"soonest","refused":true,"resendTurn":false,"stoppedPromptCopies":1},
 {"account":"soonest","refused":true,"resendTurn":false,"stoppedPromptCopies":1},
 {"account":"later","refused":false,"resendTurn":true,"stoppedPromptCopies":1},
 {"account":"later","refused":false,"resendTurn":false,"stoppedPromptCopies":1},
 {"account":"later","refused":false,"resendTurn":false,"stoppedPromptCopies":1},
 {"account":"later","refused":false,"resendTurn":false,"stoppedPromptCopies":0}]
```

Both reviewers were refused on the first account, the bridge was replaced
(`replacing bridge: the active agent account changed`), and one reviewer's
resend reached the scripted model on the next account. The other reviewer's
resend did not arrive within the host's 120 s wait. The scenario host keeps
only the last 4,000 characters of its output, which showed no bridge health
or port error.

## Isolated reruns

- The scenario alone (`bun test --cwd apps/backend
  ./tests/account-switch-claude-live.test.ts --preload ../../tests/setup-node.ts
  --parallel=1 --test-name-pattern "two reviewers"`): passed in 25.8 s.
- The owning file alone (same command without the pattern): 10 of 10 passed
  in 28.2 s, the two-reviewer scenario in 27.5 s.

## Hypothesis

Load: the failing run shared the host with the Codex file and with other
agents' checks, and every Claude scenario took about four times as long as
alone. Not shown to be a product race. A slow host could still reach the same
gap if the second reviewer's resend is queued behind the first one on the
replacement bridge, so a recurrence should keep the full host output (raise
the 4,000-character tail) before raising any budget. Compare
[9967](9967-codex-account-switch-bridge-health-under-load.md), the Codex
file's load flake in the same suite, whose recorded cause is different (the
bridge never answered health, or could not bind its port).
