# Claude read-only review turns on a Linux host whose sandbox cannot run commands

Found on 2026-10-26 while doing
[0145](0145-claude-linux-sandbox-apparmor-nested-userns.md), checked against
`main` at `93018933` plus that branch.

A `readOnly` prompt (Multi Review's structured report turns,
`READ_ONLY_REPORT_TURN` in `apps/backend/src/core/multi-review-service.ts`, and
`review-fanout.ts`) runs under `READ_ONLY_TURN_POLICY`
(`bridges/claude-bridge/src/services/claude-query-config.ts`), whose sandbox
block is the coordinator's with `failIfUnavailable: true`, because an ordinary
bridge has no `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX` and absent reads as
`required`. What happens next depends on the host, and neither outcome was
chosen on purpose.

## Current state

- **Linux without `bwrap` or `socat` (including every container: the image
  ships neither).** The pinned CLI 2.1.309 refuses the whole turn before any
  model call: `Sandbox required but unavailable: sandbox is enabled but
  dependencies are missing … sandbox.failIfUnavailable is set — refusing`
  (`error_during_execution`, 0 model calls). Run on `omarchy-hp` on
  2026-10-26 with the managed CLI and `PATH` hiding both programs.
- **Linux whose bubblewrap cannot nest the CLI's namespace (Ubuntu's AppArmor
  `bwrap-userns-restrict`).** The CLI starts the turn; Read, Grep and Glob
  work, and every Bash call fails in `apply-seccomp`. 0145's bridge refusal
  deliberately leaves these turns alone (`claudeSandboxRefusal` refuses only
  provider-sandbox sessions and coordinators launched as `required`), so this
  is unchanged.
- macOS: Seatbelt always starts; not affected.

## Outstanding work

### Code

1. **Decide and implement one behaviour for read-only turns where the
   sandbox cannot run commands.** Options: (a) refuse the turn with the
   probe's reason (`claudeSandboxRefusal` already has it), as for a
   provider-sandbox session; (b) run it with the sandbox off and the bridge's
   read-only hook as the boundary, the way a `provider-configured`
   coordinator runs; (c) keep the CLI's behaviour. (b) keeps Multi Review
   working in containers and on Ubuntu, but drops OS containment for those
   turns, which nothing shows the user today. (a) is fail-closed but makes
   Multi Review with Claude unusable there. Whichever is chosen, say it where
   Multi Review shows a reviewer's boundary.
2. **Test the chosen path** with the probe's injected answer, in
   `claude-execution-sandbox.test.ts` and the prompt route, and extend
   `conformance-coordinator-sandbox-live.test.ts` with a `readOnly` turn.

### Qualification

- A Multi Review run with a Claude reviewer in a container environment and on
  a stock Ubuntu host, before and after the change. Batch with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Constraints and rationale

- A read-only turn must not gain a way to write the checkout: any option that
  runs without the sandbox keeps the hook, `filesystem.denyWrite` intent and
  the tool allowlist exactly as the coordinator's `unavailable` path does.
- Do not decide this inside 0145: that file's scope was the coordinator and
  the interactive provider sandbox, and refusing review turns there would have
  turned a degraded review on Ubuntu into a failed one without anyone choosing
  that.

## Open questions

- Is Multi Review with Claude reviewers in containers already failing for
  users today (the container case above), or are its read-only turns always
  on the host?

## Needs verification

- The container case on a real environment (the evidence above hid the
  programs with `PATH` on a host).

## Related

- [0145-claude-linux-sandbox-apparmor-nested-userns.md](0145-claude-linux-sandbox-apparmor-nested-userns.md):
  the probe and the refusal this would reuse.
- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md):
  the read-only hook and the `unavailable` coordinator path.

## Replaces

Nothing.
