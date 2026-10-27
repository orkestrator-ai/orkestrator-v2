# Claude read-only review turns on a Linux host whose sandbox cannot run commands

Found on 2026-10-26 while doing
[0145](0145-claude-linux-sandbox-apparmor-nested-userns.md), checked against
`main` at `93018933` plus that branch.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Choose and implement the behaviour**: code item 1, one deliberate behaviour for `readOnly` turns where the CLI sandbox cannot run commands, and where the boundary is shown. Status: open.
2. **Test the chosen path**: code item 2, covering the unit, prompt-route and live conformance cases. Status: open (depends on 1).
3. **Container and Ubuntu qualification**: a Multi Review run with a Claude reviewer in a container and on stock Ubuntu, before and after (open question and "Needs verification" included). Status: open; the code answers the open question.

### 1. Choose and implement the behaviour

**Problem.** A `readOnly` prompt (Multi Review's report turns, plan-mode fan-out reviewers) always asks the CLI for a required sandbox. Where the sandbox cannot run, the outcome is accidental. With no `bwrap` or `socat`, the CLI refuses the whole turn (0 model calls). Under Ubuntu's AppArmor profile, Read and Grep work and every Bash call fails.

**Context.** Split from 0145 D3 so the product choice was not made inside that file. The constraint is that any option that runs without the sandbox keeps the hook, the `denyWrite` intent and the tool allowlist, exactly as a `provider-configured` coordinator does.

**Investigation.** The description is still accurate at HEAD.
- `READ_ONLY_TURN_POLICY` is at `bridges/claude-bridge/src/services/claude-query-config.ts:32-39`, and `claudeTurnPolicy` substitutes it for a `readOnly` turn (`:60-68`).
- `claudeExecutionSandbox` sends it through `claudeReadOnlySandbox` (`bridges/claude-bridge/src/services/claude-execution-sandbox.ts:36-41`). The launcher value comes from `coordinatorCommandSandboxFromEnv`, which reads absent as `required` (`packages/protocol/src/coordinator.ts:21-25`), so `enabled` and `failIfUnavailable` are both true (`bridges/claude-bridge/src/services/read-only-policy.ts:521-526`).
- `claudeSandboxRefusal` refuses a coordinator-shaped policy only when a launcher value is present (`claude-execution-sandbox.ts:88-91`), so an ordinary bridge's read-only turn is never refused up front.
- The bridge already has the probe's reason (`claudeLinuxSandboxStatus`, cached for 5 minutes) and an Agent Info note path for read-only turns (`readOnlyTurnReportedPolicy`, `packages/protocol/src/native-agent-policy-effects.ts:124-128`). That is the natural place to say which boundary held.
- Callers: `READ_ONLY_REPORT_TURN` (`apps/backend/src/core/multi-review-service.ts:209`, used at `:3777` and `:3969`) and the plan-mode fan-out (`apps/backend/src/core/review-fanout.ts:1077` and `:1218`).

**Decisions.**

- **Which behaviour?**
  - **(b) Run with the sandbox off and the read-only hook as the boundary, and say so in the turn's reported policy (recommended).** Treat the probe's `available: false` like the launcher's `unavailable`.
    - Pros: Multi Review keeps working in every container and on Ubuntu. It reuses the coordinator's proven `unavailable` path (live case `unavailable-hook-reads`). The hook, tool allowlist and `denyWrite` intent are unchanged, so a read-only turn gains no way to write.
    - Cons: drops OS containment for those turns. The hook is a command allowlist, not a kernel boundary, so the boundary has to be shown or it weakens silently.
  - **(a) Refuse the turn with the probe's reason.**
    - Pros: fail-closed and consistent with provider-sandbox sessions; the code change is tiny (drop the launcher condition for read-only turns).
    - Cons: Multi Review and plan-mode fan-out with Claude become unusable in every container environment and on stock Ubuntu.
  - **(c) Keep the CLI's behaviour.**
    - Pros: no change.
    - Cons: containers fail outright and Ubuntu fails per command; neither was chosen on purpose.
- **Where is the boundary shown?**
  - **In the turn's reported execution policy note (Agent Info), and as a reviewer-level note in the Multi Review result (recommended).**
    - Pros: uses the existing `appendNativeAgentPolicyNote` path; the reviewer card is where a user judges a review.
    - Cons: the Multi Review UI needs a small new field.
  - **Agent Info only.**
    - Pros: no Multi Review UI change.
    - Cons: Multi Review users rarely open Agent Info for a reviewer turn.

### 2. Test the chosen path

**Problem.** Nothing pins the read-only behaviour where the sandbox is unavailable.

**Context.** The file names the tests to extend. The probe answer is pinned to `available` in `tests/setup-node.ts` (0145 D5), so tests must inject it.

**Investigation.** `bridges/claude-bridge/src/services/claude-execution-sandbox.test.ts` and `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` both exist. 0145's route test already includes "a read-only review turn unaffected", which must change with the decision.

**Decisions.**

- **Is the live case added now?**
  - **Yes, as a `readOnly` case in the existing live suite, staged by hiding `bwrap` on `PATH` the way the evidence was gathered (recommended).**
    - Pros: runs on any Linux host, so no AppArmor host is needed; it proves the CLI is not asked for a sandbox.
    - Cons: a staged absence rather than a real container.
  - **Unit and route tests only.**
    - Pros: deterministic and fast.
    - Cons: the CLI's own refusal message and flags are not exercised.

### 3. Container and Ubuntu qualification

**Problem.** Neither the container case nor the stock Ubuntu case has been run with a real Multi Review.

**Context.** Batched in 0031 (`docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:202`) with 0145.

**Investigation.** The open question is answered by the code: a container environment's reviewers run in the container. `bridgeConnection` starts `start_claude_server` for any non-local environment (`apps/backend/src/core/multi-review-service.ts:4993-5020`). The image ships neither `bwrap` nor `socat` (no match in `docker/Dockerfile`). So today every Claude read-only report turn in a container environment should be refused by the CLI. That is a user-visible failure in normal use, which is why the file rates High. Nothing in the code suggests these turns run on the host instead.

**Decisions.**

- **When is the "before" run done?**
  - **Run the container case now, before the code change (recommended).**
    - Pros: confirms the High rating with real evidence; cheap with an isolated profile and `--fixture-environments local,container`.
    - Cons: builds the workspace image, so it is slow.
  - **Skip "before" and qualify only the fix.**
    - Pros: one run instead of two.
    - Cons: the reported failure stays inferred; the 0145 evidence hid the programs with `PATH` on a host.
- **Does stock Ubuntu gate closure?**
  - **No: close on the container run plus 0145's CI AppArmor runner, and keep Ubuntu desktop in 0031 (recommended).**
    - Pros: the container path is the one most users reach; the AppArmor branch is already exercised in CI.
    - Cons: the per-command Bash failure under AppArmor is not re-observed with a real reviewer.
  - **Require a stock Ubuntu run as well.**
    - Pros: complete.
    - Cons: blocked on hardware, like 0145 task 3.

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
- **So Multi Review with Claude in a container environment should fail
  today** (code reading at `863b5782`, not run). Its Claude bridge runs in the
  container: `bridgeConnection` calls `start_claude_server` for any
  non-local environment (`apps/backend/src/core/multi-review-service.ts:4992-5020`),
  which launches `/opt/claude-bridge` without
  `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX` (`commands-containers.ts:929-950`),
  so the sandbox reads as `required`. The image's only `apt-get install`
  lines (`docker/Dockerfile:71-100`, `:469`, both `--no-install-recommends`)
  install neither `bubblewrap` nor `socat`. Consolidation is always a
  read-only turn (`multi-review-service.ts:3777`, `:3969`), and so are a
  packaged review's reviewers (`reviewerMode: "plan"`, `:3414`), so a Claude
  consolidation model, or a Claude reviewer in a packaged review, would be
  refused.
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
