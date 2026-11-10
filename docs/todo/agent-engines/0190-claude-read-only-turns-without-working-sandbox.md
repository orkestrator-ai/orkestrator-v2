# Claude read-only review turns on a Linux host whose sandbox cannot run commands

Found on 2026-10-26 while doing
[0145](0145-claude-linux-sandbox-apparmor-nested-userns.md), checked against
`main` at `93018933` plus that branch.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; task 3 re-analysed and
run 2026-11-10 against `main` at `c98b20e6f`.

### Tasks

1. **Choose and implement the behaviour**: code item 1, one deliberate behaviour for `readOnly` turns where the CLI sandbox cannot run commands, and where the boundary is shown. Status: done 2026-10-28 (option (b), shown in Agent Info and on the Multi Review reviewer and consolidation step; decisions A1 to A9).
2. **Test the chosen path**: code item 2, covering the unit, prompt-route and live conformance cases. Status: done 2026-10-28 on macOS; the Linux run, the Linux-only case included, passed 2026-11-10 (A15).
3. **Container and Ubuntu qualification**: a Multi Review run with a Claude reviewer in a container and on stock Ubuntu, before and after (open question and "Needs verification" included). Status: done for the container and for the Linux live suite on 2026-11-10 (A12 to A17); the run found and fixed two defects. Open: a read-only turn under AppArmor's `bwrap-userns-restrict`, on an Ubuntu CI runner (the AppArmor-restricted phase 0145 task 2 runs, or the `ubuntu-24.04` job 0145 task 3 adds), and Agent Info's "No sandbox" during a reviewer turn on the real stack (see "Needs verification"). The Windows check moved to 7568 on 2026-11-10.

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

**Left (2026-11-10).** No stock Ubuntu desktop is needed for the AppArmor
half: CI's Ubuntu runners ship the profile, and 0145 task 2 already runs a
restricted phase there. Run the live suite's read-only cases in that phase
(expect `nested-user-namespace`, Bash commands that run with no
`apply-seccomp` failure, and the reported policy `none` with the reason).
Separately, catch Agent Info's "No sandbox" while a reviewer turn runs, with
a fake whose reviewer turns last long enough to read it. The Windows check
needs a Windows host and is in 7568.

**Investigation (2026-11-10).** Run on beelink (Arch Linux, kernel 7.1.8)
with this branch's dev image (`claude` 2.1.319, no `bwrap` or `socat`) on a
disposable rootless daemon started with `--host-loopback`, so the
containers reach the profile's agent tools server past the host firewall
(ufw drops it from the rootful daemon's ranges, [7080](../containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md)).
Profile `ro-reviewers-0190`, credential-free, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`,
a scripted fake Messages API on the container's loopback
(`e2e/agent-testing/container-fake-claude-review-api.ts`), two Claude
reviewers and a Claude preparation/consolidation model.
- Run 1: the reviewers failed "Not logged in": read-only turns load no
  settings files, so the fake's base URL in `~/.claude/settings.json` never
  reached them. A fixture limitation here, and a real gap for users who
  configure Claude that way: [7565](7565-claude-read-only-turns-ignore-settings-env.md).
  The fake is now staged as managed settings.
- Run 2: every reviewer turn ran (the sandbox-off note was on both reviewers),
  but the hook refused the package's `diffCommand`: without the sandbox it
  refuses every Git command, and the reviewer instructions send reviewers to
  Git for the diff. A container reviewer could not see the change at all
  (fixed, A13).
- Run 3, after the fix: `ready`; both reviewers and consolidation completed
  with the note on each; in every read-only turn `ls` ran, Git and `touch`
  were refused by the hook, the reviewers read the sealed diff file, and
  every submission was accepted. The diff file's SHA-256 matched the
  package and `diffCommand`'s output; no write reached the checkout.
- The note told the user to "Install the bubblewrap and socat packages"
  inside a container (fixed, A14). Run 4, on a rebuilt image with every fix,
  is the committed `container-multi-review-read-only.spec.ts`: passed in
  51 s (1 expected, 0 skipped), with the container wording in both
  inspectors.
- The Linux live suite (`conformance-coordinator-sandbox-live.test.ts`)
  passed 19 of 19, none skipped, `read-only-required-refused` included,
  which reproduces the CLI's refusal of a required sandbox on the old block
  (the "before", A15).

**Investigation (2026-10-27).** The open question is answered by the code: a container environment's reviewers run in the container. `bridgeConnection` starts `start_claude_server` for any non-local environment (`apps/backend/src/core/multi-review-service.ts:4993-5020`). The image ships neither `bwrap` nor `socat` (no match in `docker/Dockerfile`). So today every Claude read-only report turn in a container environment should be refused by the CLI. That is a user-visible failure in normal use, which is why the file rates High. Nothing in the code suggests these turns run on the host instead.

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

Updated 2026-11-10 (task 3); the rest 2026-10-28 on branch
`todo-0190-claude-read-only-no-sandbox`, based on `main` at `1d1f0a87`.

- **Reviewers without Git get the diff as a file (2026-11-10).** The hook
  refuses every Git command when the sandbox is off, so the backend seals the
  package's diff as `review-diff-<sha256>.patch` beside it
  (`apps/backend/src/core/review-diff-artifact.ts`, `diffArtifact` on
  `ReviewPackage`), checks it with the package before each dispatch, and the
  reviewer instructions say to read it when Git is refused
  (`PACKAGED_REVIEW_WORKING_RULES`). Over 16 MiB, or if it cannot be
  produced, it is left out with a package limitation. `diffCommand` gained
  `--no-textconv`, so the file and the command print the same bytes.
- **The note is worded for a container (2026-11-10).** In a container the
  probe says "cannot run commands in this container" and that bubblewrap and
  socat are not in the container's image, without install advice
  (`probeClaudeLinuxSandbox`, `inContainer`).

- **Done: option (b).** A `readOnly` turn in an ordinary bridge (no launcher
  answer) decides per turn whether to ask the CLI for its sandbox
  (`claudeReadOnlyCommandSandbox`,
  `bridges/claude-bridge/src/services/claude-execution-sandbox.ts`): macOS
  asks for Seatbelt, Linux follows the cached bubblewrap probe, any other
  platform has none, and a coordinator process keeps its launcher's answer
  (absent still reads as `required`). Where there is none the turn runs with
  `enabled: false, failIfUnavailable: false`; the hook, the reading-tool
  allowlist, the denied tools, `deny` approvals,
  `allowUnsandboxedCommands: false` and `denyWrite` are unchanged. The answer
  is part of the CLI's launch boundary (`claudeLaunchProfile`), so a warm CLI
  launched under the other answer is not joined. No read-only turn is refused
  for it, before or by the CLI.
- **The boundary is shown.** The bridge keeps the reason on the session
  (`readOnlyCommandSandboxOff`, set by `resolveQueryPlan`, cleared by the next
  turn that is not read-only).
  - Agent Info: while the turn runs, `claudeReportedPolicy` reports
    `sandbox: "none"` and adds `readOnlyCommandSandboxOffNote(reason)` to the
    note (`readOnlyTurnReportedPolicy`,
    `packages/protocol/src/native-agent-policy-effects.ts`).
  - Multi Review: `GET /session/:id` carries
    `readOnlyCommandSandbox: { state: "off", reason }`; the backend reads it
    into `ProviderSessionObservation.commandSandboxOff`
    (`claudeReadOnlySandboxObservation`, bounded to 1,024 characters), the
    fan-out keeps it on `ReviewerRecord.commandSandboxOff` and the
    consolidation observation on `stepRuntimes.consolidate.commandSandboxOff`.
    The reviewer's and the consolidation step's inspector show it as a warning
    note (`CommandSandboxOffNote` in `MultiReviewTab.tsx`). A reviewer's new
    session, a restarted reviewer and a re-run step start without it.
- **Before this change** (kept for the record): on Linux without `bwrap` or
  `socat` (every container: the image ships neither) the pinned CLI 2.1.309
  refused the whole turn before any model call (`Sandbox required but
  unavailable: … sandbox.failIfUnavailable is set — refusing`, seen on
  `omarchy-hp` on 2026-10-26 with `PATH` hiding both programs); under
  Ubuntu's AppArmor `bwrap-userns-restrict` the turn started and every Bash
  call failed in `apply-seccomp`. A container environment's reviewers run in
  the container (`bridgeConnection` starts `start_claude_server` for any
  non-local environment, `apps/backend/src/core/multi-review-service.ts`), so
  a Claude consolidation model or a Claude reviewer in a packaged review was
  refused there.
- macOS: Seatbelt always starts; not affected (the turn still asks for it).
- Durable description: "Read-only review turns without a working sandbox" in
  [`docs/architecture/coordinator.md`](../../architecture/coordinator.md).

## Outstanding work

### Code

1. [x] **Decide and implement one behaviour for read-only turns where the
   sandbox cannot run commands.** Done 2026-10-28: (b), run with the sandbox
   off and the read-only hook as the boundary, shown in Agent Info and on the
   Multi Review reviewer and consolidation step (A1 to A9).
2. [x] **Test the chosen path.** Done 2026-10-28:
   - `claude-execution-sandbox.test.ts`: the resolver per platform, probe
     answer, launcher answer and coordinator process without one; the sandbox
     block differs only in `enabled` and `failIfUnavailable`; read-only turns
     are never refused.
   - `session-manager-sandbox-refusal.test.ts`: real query plan with the
     probe injected (`missing-programs` and `nested-user-namespace`): the CLI
     gets the sandbox off with the hook, allowlist and denied tools intact,
     the reported policy says `none` with the reason, the reason outlives the
     turn and the next ordinary turn clears it; a working probe keeps the
     sandbox required.
   - `routes/session.test.ts`: the prompt route accepts a read-only turn on a
     failing host even in a provider-sandbox session (replacing 0145's "left
     as it was" assertion); `GET /session/:id` serves `readOnlyCommandSandbox`
     while running and idle, and drops it once cleared.
   - `claude-query-config.reported-policy.test.ts`, protocol
     `review-fanout.test.ts` and `multi-review.test.ts` (bounded record
     fields), backend `http-bridge-provider.test.ts` (parsing and bounds),
     `multi-review-service.test.ts` (a packaged review records it on every
     read-only reviewer and on consolidation, not on preparation; a working
     host records nothing), web `MultiReviewTab.test.tsx` (the notes).
   - Live: `conformance-coordinator-sandbox-live.test.ts` gains
     `read-only-unavailable-reads`, `read-only-unavailable-hook-refuses` and,
     on Linux only, `read-only-required-refused` (A8). The first two passed on
     macOS on 2026-10-28 against the pinned CLI and a scripted endpoint.

### Qualification

- [x] A Multi Review with Claude reviewers and a Claude consolidation in a
  container environment: done 2026-11-10, on a fake Messages API
  (`container-multi-review-read-only.spec.ts`, A12). The "before" half is
  the `read-only-required-refused` live case, run on Linux the same day
  (A15).
- [ ] A read-only turn on an Ubuntu host with AppArmor's
  `bwrap-userns-restrict`, on a CI runner (see task 3). The read-only turn on
  Windows moved to 7568 on 2026-11-10.

## Constraints and rationale

- A read-only turn must not gain a way to write the checkout: any option that
  runs without the sandbox keeps the hook, `filesystem.denyWrite` intent and
  the tool allowlist exactly as the coordinator's `unavailable` path does.
- Do not decide this inside 0145: that file's scope was the coordinator and
  the interactive provider sandbox, and refusing review turns there would have
  turned a degraded review on Ubuntu into a failed one without anyone choosing
  that.

## Assumptions and decisions

Made 2026-10-28 while implementing.

- **A1. Behaviour where the sandbox cannot run.** Options: (a) refuse the
  turn with the probe's reason; (b) run with the sandbox off and the hook as
  the boundary; (c) keep the CLI's behaviour. **Chosen: (b)**, as the task
  analysis recommended. Why: Multi Review with Claude keeps working in every
  container and on Ubuntu, and it reuses the coordinator's `unavailable`
  path, which the live suite already qualifies. Pros: no failed reviews; no
  new way to write (same hook, allowlist, denied tools and approvals). Cons:
  no OS containment for those turns; the hook is a command allowlist, not a
  kernel boundary, which is why A2 shows it.
- **A2. Where the boundary is shown.** Options: Agent Info only; Agent Info
  plus the Multi Review reviewer; plus the consolidation step as well.
  **Chosen: all three.** Why: consolidation is always a read-only turn, so it
  is the case users hit most (every Claude consolidation model in a
  container), and the reviewer card is where a user judges a review. Pros:
  visible where the report is read. Cons: two new optional record fields
  (`ReviewerRecord.commandSandboxOff`,
  `MultiReviewStepRuntime.commandSandboxOff`) and a snapshot field.
- **A3. How Multi Review learns it.** Options: read the reported policy
  (present only while the turn runs); a request-scoped field per request id;
  a session field kept until the next turn that is not read-only.
  **Chosen: the session field** (`readOnlyCommandSandbox` on
  `GET /session/:id`, `commandSandboxOff` on the observation). Why: a short
  turn can finish between two polls, and every turn on a reviewer or
  consolidation session is read-only. Pros: no new route; any poll sees it;
  an older bridge simply sends nothing. Cons: on a session that mixes turns
  it describes the latest read-only one, so the backend records it only on
  read-only steps (reviewers, `consolidate`) and keeps the first value seen.
- **A4. Coordinator process without a launcher answer.** Options: probe like
  an ordinary bridge; keep `required`. **Chosen: keep `required`.** Why: the
  documented rule that an older launcher must never turn a missing sandbox
  into an unsandboxed coordinator. Cons: none new; such a host is refused by
  `claudeSandboxRefusal` only when a launcher value exists, as before.
- **A5. Platforms other than macOS and Linux (Windows).** Options: keep
  asking for a required sandbox; treat as no sandbox, like the backend's
  coordinator table (`defaultCoordinatorHostCapabilities`). **Chosen: no
  sandbox, with a generic reason.** Why: the pinned CLI's Windows sandbox is
  off behind a vendor flag, so a required one would refuse the turn just as
  on Linux; the coordinator already runs hook-only there. Pros: one rule for
  both read-only paths. Cons: unverified on Windows ("Needs verification").
- **A6. Reported isolation.** Options: keep `sandbox: "provider"` and only
  add a note; report `sandbox: "none"`. **Chosen: `none` plus the note.**
  Why: Agent Info's summary would otherwise say "Provider sandbox" beside a
  note saying there is none. `networkAccess` stays `restricted`: no admitted
  tool or command can reach the network. Display only; nothing in the
  backend decides on it.
- **A7. Warm CLI reuse.** Options: record the answer at launch and report
  the launch's; put it in the launch boundary. **Chosen: the launch
  boundary.** Why: a CLI launched with the sandbox on must not be joined by a
  turn reported as off, or the reverse, after the probe's 5-minute cache
  changes its answer. Pros: what is reported is what the CLI runs. Cons: on
  that rare flip, a runtime that still owes work answers the usual 409 for a
  launch-only change; an idle one is retired.
- **A8. Live case.** Options: unit and route tests only; a `readOnly` case
  in the existing live suite staged by hiding `bwrap` and `socat` on `PATH`.
  **Chosen: the live case**, as recommended. The staged `PATH` holds only a
  shell and the readers the scenarios run, the bridge's real probe is run
  against it (`missing-programs`), and the pinned CLI gets the resulting
  block. `read-only-required-refused` reproduces the original refusal with
  the old block and is Linux-only, because that refusal was only ever seen on
  Linux. Pros: proves the CLI is not asked for a sandbox and that the hook
  still refuses. Cons: a staged absence, not a real container; the Linux
  cases have not run (this branch was built on macOS).
- **A9. Record compatibility.** Options: new optional keys in the strict
  record validators (`hasOnlyKeys`), as every earlier reviewer field
  (`cacheReadTokens`, `modelSubstitution`) did; a version handshake; reuse an
  existing field such as `error`. **Chosen: new optional keys.** Why: there is
  no handshake, and `error` means failure. Pros: additive and bounded
  (1,024 characters, truncated by the backend). Cons: an older renderer or a
  downgraded backend rejects a workflow that carries one, as with the earlier
  fields; it appears only on hosts where that review used to fail outright.
- **A10. The "before" container run.** Options: run it now with an isolated
  profile and `--fixture-environments local,container`; skip it. **Chosen:
  not run.** Why: it needs the workspace image and a real Claude login in an
  isolated `dev:test` profile, and this delegation forbids using the user's
  provider logins; on this branch the code no longer has the old behaviour.
  The staged live case stands in for the CLI's refusal. Cons: the High
  rating's container failure is still inferred from code, not observed.
- **A11. Rating.** Kept High: what is left is qualification of behaviour that
  is on by default for every Claude read-only turn on Linux and has not run
  on the real stack. Re-rated Medium on 2026-11-10 once the container case
  and the Linux live suite passed: what is left is a qualification run for
  two secondary platforms (A17).

- **A12. How the container run reached a model (2026-11-10, task 3).**
  Options: a real Claude login in the profile; a scripted fake Messages API
  on the container's loopback. **Chosen: the fake**, because the ticket
  forbade logins and billed turns. It drives the image's real `claude`, the
  real bridge, hook and MCP submission tools, and follows the reviewer
  instructions (read the package, run `ls`, run `diffCommand`, read the diff
  file, try a write, submit). Pros: free, repeatable, content-free logs.
  Cons: it proves the boundary and the plumbing, not review quality; a
  Claude Code release that changes its API use can break the fake.
- **A13. How a reviewer without Git reads the diff (task 3).** Options: (a)
  let the hook admit a hardened `git diff` without the sandbox; (b) seal the
  diff as a file when the package is built and point reviewers at it; (c)
  only tell reviewers to read the changed files. **Chosen: (b).** Why: (a)
  reopens the hole the refusal closes (`core.fsmonitor`, filter drivers and
  other configuration run helpers, and the hook checks commands, not Git's
  configuration); (c) loses what changed inside each file. The backend
  already runs Git in the environment to build the package, so (b) costs one
  more `git diff` and a write per round. Pros: the reviewer sees exactly the
  reviewed bytes, verified before dispatch, with no new route through the
  hook. Cons: one more file per round (up to 16 MiB); non-UTF-8 bytes are
  replaced, since the runner decodes Git's output as text.
- **A14. The reason's wording in a container (task 3).** Options: keep the
  host wording; detect a container and drop the install advice. **Chosen:
  detect it** (`/.dockerenv` or `/run/.containerenv`, injectable for tests).
  Why: users cannot install packages into an environment's image, and "on
  this host" pointed them at the wrong machine. Shipping bubblewrap in the
  image was not chosen: an unprivileged container without user namespaces is
  not expected to run it, and that was not tested here.
- **A15. The "before" run (task 3).** Options: run the container case on
  `main` before this branch; use the Linux live case that pins the CLI's
  refusal. **Chosen: the live case**, as A10 proposed: on Linux it runs the
  pinned CLI with the old required block and the staged `PATH`, and passed
  on 2026-11-10. Cons: still a staged absence rather than a container.
- **A16. Where the containers reach the agent tools server (task 3).**
  Options: a ufw rule for the agent-test port range (the user's change to
  make); a disposable rootless daemon with RootlessKit's host loopback.
  **Chosen: the disposable daemon**, the only route that needed no host
  firewall change. Its containers reach the host's loopback, so the
  reachability check names `10.0.2.2` as `host.docker.internal`; nothing on
  the host daemon or firewall changed.
- **A17. Closing the file (task 3).** Options: retire it and move the Ubuntu
  and Windows checks to 0031; keep it open with only those. **Chosen: keep
  it open**, re-rated Medium: both are live checks of behaviour already on by
  default, and 0031 batches the runs but does not own their items. The
  durable description is in
  [coordinator.md](../../architecture/coordinator.md).

## Open questions

- Answered by the code (2026-10-27): Multi Review's Claude reviewers and
  consolidation in a container environment run in the container, not on the
  host, so before this change they were refused there.

## Needs verification

- A stock Ubuntu 24.04 or 26.04 host with AppArmor's `bwrap-userns-restrict`:
  the probe answers `nested-user-namespace`, the read-only turn runs Bash
  commands (no `apply-seccomp` failure) and shows the note. Beelink is Arch
  without that profile; CI's Ubuntu runners have it (task 3), and
  `container-multi-review-read-only.spec.ts`'s fake and a local environment
  could drive it.
- Agent Info saying "No sandbox" while a reviewer turn runs, on the real
  stack: the fake's turns finish in a few seconds, so it was not caught; the
  reported policy is pinned by `claude-query-config.reported-policy.test.ts`.
- Done 2026-11-10: the container case (A12) and the Linux run of the live
  suite (19 of 19, A15).

## Related

- [0145-claude-linux-sandbox-apparmor-nested-userns.md](0145-claude-linux-sandbox-apparmor-nested-userns.md):
  the probe and the refusal this would reuse.
- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md):
  the read-only hook and the `unavailable` coordinator path.
- [7565-claude-read-only-turns-ignore-settings-env.md](7565-claude-read-only-turns-ignore-settings-env.md):
  found by task 3; read-only turns load no settings files.
- [7080-linux-host-firewall-blocks-profile-signals.md](../containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md):
  why the container run used a disposable rootless daemon.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the Windows read-only turn from task 3) moved there on 2026-11-10.

## Replaces

Nothing.
