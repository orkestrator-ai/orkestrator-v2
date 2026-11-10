# A slow remote stops a typed coordinator message from fast-forwarding the checkout

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`. Rewritten 2026-11-06
against `main` at `e6c3da89` to hold only its live check: the three code tasks
(the `checkout.message-check` log line, the fast-forward to an upstream that is
already fetched, and held mail no longer spending the mail cooldown) are done
and documented in
[`coordinator.md`](../../architecture/coordinator.md). Analysed again
2026-11-10 against `main` at `04639b12` and finished: the live run passed.

### Tasks

1. **Live run against a slow remote**: a typed message and a mail to a coordinator whose remote is slow fast-forward the checkout to the upstream it has already fetched. Status: done (2026-11-10, `mise run test:agent:coordinator-slow-remote` on beelink).

### 1. Live run against a slow remote

**Problem.** On 2026-11-04 a message typed to the main coordinator of
`arkaydeus/dd-tools-web` did not fast-forward a checkout that was two commits
behind an `origin/main` it had already fetched. GitHub SSH from that host took
between 3 and 43 s, so the fetch outlasted the panel's 5 s bound. The fix is on
for every coordinator message but had only unit and real-Git evidence.

**Context.** The backend bounds its own fetch at 3 s, then merges the exact
commit it checked with a local fast-forward and answers `fast-forwarded`
(`checkUpstreamBeforeMessage` in `coordinator-message-upstream.ts`,
`ProjectGitService.fastForwardToFetchedUpstream`). Mail takes the same fallback
after a slow or failed fetch and logs `outcome=fast-forwarded-fetched`
(`coordinator-mail-upstream.ts`). A mail held behind a running turn no longer
spends the 60 s mail cooldown.

**Investigation.** Done on 2026-11-10 by
`e2e/agent-testing/coordinator-slow-remote-live.spec.ts`, run through
`mise run test:agent:coordinator-slow-remote` (procedure in
[`agent-testing.md`](../../development/agent-testing.md#coordinator-checkout-sync-with-a-slow-remote-fake-model)).
It follows the steps this file set out, on a disposable
`dev:test --fixture --headless --no-agent-credentials --agent-platforms pi`
profile on beelink (Linux), with both main coordinators on Pi driven by a
loopback fake model, and two disposable projects whose origins are
`ssh://git@slow.invalid/repo.git` served by checkout-local `core.sshCommand`
shims over local bare repositories (15 s delay while a marker exists). The
one-shot task passed in 149.7 s (one case, `PASS coordinator-slow-remote`),
and an earlier run of the same spec on a profile started by hand passed too.
Evidence from the one-shot run's content-free summary:

- **Baseline, delay off.** Each shim served a direct fetch and a backend
  `fetch_project_git` (two invocations each; backend status `fresh`).
- **Before.** Each checkout was clean, `HEAD` on the old tip, two commits
  behind an upstream it had fetched; the mail coordinator's turn was parked
  in the fake model and had started while its checkout was current. The
  toolbar of the typed project said "2 commits behind".
- **Typed.** With the delay on and the 60 s fetch cooldown past, a message
  typed in the browser logged `checkout.message-check outcome=fast-forwarded
  fetch=timed-out durationMs=3061`. The shim started 91 ms after the send,
  so the check itself made the slow fetch. `HEAD` reached the recorded
  upstream with one new reflog entry while the 15 s fetch was still pending;
  the toolbar then read "Up to date", and still did once the late fetch
  settled (`behind 0`, `remoteState fresh`). The message reached the
  coordinator and its turn finished.
- **Mail.** A Pi worker tab in the second project sent its coordinator a
  report with Orkestrator's `send_message` tool (sender `tab`, trust
  `same-project`, route `coordinator`). While the coordinator's turn ran, the
  mail waited (`placement pending-inject`, `agent-mail delivery.waiting
  reason=working`), no `checkout.mail-follow` was logged and the checkout
  stayed two commits behind. The turn was released with the delay still on.
  The redelivery started a fetch 423 ms later and logged
  `checkout.mail-follow outcome=fast-forwarded-fetched`, 5482 ms after the
  shim started (past the 5 s bound, before the 15 s fetch could finish), not
  `cooldown`. `HEAD` reached the recorded upstream with one new reflog entry,
  and the mail was then injected and answered.
- **Cleanup.** The spec removed both markers, waited for the late fetches to
  settle, restored each saved origin URL, unset the checkout-local settings,
  closed both conversations and removed both projects; the runner then
  stopped and reset the profile.

Screenshots: `output/visual-previews/coordinator-slow-remote-typed-before.png`,
`-typed-after.png` and `-typed-settled.png` (git-ignored, not committed).

**Decisions.**

- **How to make the remote slow?**
  - **SSH origins served by delayed, checkout-local shims (recommended).**
    - Pros: repeatable; forces SSH transport while serving only disposable local
      repositories; touches no host SSH or global Git configuration.
    - Cons: simulates a slow handshake and needs a shim per fixture repository.
  - **Wait for GitHub SSH to be slow again.**
    - Pros: the real failure.
    - Cons: cannot be scheduled.
- **Is a fake model and a local slow remote enough, or is a real-provider run
  still needed?**
  - **Enough; no real-provider run (recommended).**
    - Pros: the behaviour under test is the backend's Git step, which runs
      before the typed prompt is dispatched and before the mail is injected,
      whatever model answers. The run used the real backend, project Git
      service, Pi bridge, agent mail routing and renderer, and only the
      model's text was scripted. A real provider would add only a real
      model's reply to the merged code, which is not what this file checks.
    - Cons: GitHub's own SSH (a real `ssh` client, host keys, its
      authentication and its timing) was not used; the shim reproduces only
      the delay.
  - **Also run it on a real provider and a slow real remote.**
    - Pros: the incident's exact setting.
    - Cons: a billed turn and a login, and GitHub's slowness cannot be
      scheduled; it would test the same backend code path.

## Assumptions and decisions

### Task 1: independent checkout state and fetch deadlines (2026-11-06)

Use two fixture projects instead of resetting an advanced checkout: each scenario
starts behind without discarding work. A 15 s delay exceeds both deadlines; the
run must observe the timeout and merge independently. This repairs the procedure,
not its still-open live qualification.

### Task 1: force the SSH transport before delaying it (2026-11-06)

Use explicit SSH origins and checkout-local `core.sshCommand` shims, matching
the real-Git integration test's transport setup. A backend-only
`GIT_SSH_COMMAND` would leave a filesystem origin unchanged and never run.
The shims serve the saved local bare repositories, so the undelayed baseline
must succeed before the delay markers are enabled. Invocation counts and a
fetch pending past its bound are required evidence in both scenarios.

### Task 1: a fake model on Pi stands in for the real coordinator (2026-11-10)

The ticket asked for a coordinator on a disposable profile driven by a loopback
fake model. Pi was chosen because its isolated `models.json` can name a
loopback OpenAI-compatible endpoint with no login, which the Auto-pipeline
qualification (7547) already relies on; the typed coordinator showed
`Read-only · Enforced`. See the decision above on why a real provider adds
nothing to this check.

### Task 1: the mail comes from a worker tab, not the user (2026-11-10)

Mail the user sends from the app takes no route, so a coordinator's mailbox
only stores it (the first attempt saw `placement stored`). The incident's mail
is a worker's report, which takes the `coordinator` route and wakes its
recipient. The spec therefore gives the mail project a Pi worker tab on the
same fake model, which sends one `send_message` call addressed to the
coordinator's mailbox.

### Task 1: wait out the fetch cooldown before each scenario (2026-11-10)

Both paths fetch with the backend's 60 s cooldown. Inside it, the fetch answers
from the last status at once, the checkout is offered a normal sync, and the
fallback under test never runs. The spec opens the panel inside the cooldown
(so its fetch-on-open stays local), then waits until the project's last backend
fetch is more than 62 s old before typing or releasing the turn, so the check
itself starts the slow fetch.

### Task 1: the held mail never reached the busy checkout (2026-11-10)

The step said to confirm the redelivered mail is not answered `cooldown`. It
was not: the follow logged `fast-forwarded-fetched`. During the turn, though,
delivery waited on the coordinator's `working` presence and did not call the
checkout step at all, so the "busy attempt does not spend the cooldown" branch
was not reached live. That branch is reached when the checkout is busy for
another reason (another conversation's or the project home's turn) and stays
covered by `coordinator-mail-upstream.test.ts`; nothing in this run suggests a
defect, so no follow-up was opened.

## Related

- [`coordinator.md`](../../architecture/coordinator.md), checkout sync before a
  message.
- [`agent-testing.md`](../../development/agent-testing.md#coordinator-checkout-sync-with-a-slow-remote-fake-model),
  how to rerun the qualification.
- [7547](7547-auto-pipeline-launch-flow.md), the Pi fake-model pattern this run
  reuses.

## Replaces

This file's own earlier version (2026-11-04), which held the incident
evidence and the three code tasks; git history keeps it. Two of its
verification items were dropped on 2026-11-06: how long the 09:55 UTC check
took cannot be recovered, and how slow GitHub SSH is from one host is an
observation, not a check.
