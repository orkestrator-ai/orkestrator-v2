# Live evidence for the silent-failure notices and the vendor debug filter

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf` (first analysed 2026-11-05 at `69a3b4ca5`). Carried from the E13 efficiency batch (`docs/reports/efficiency-logging-database/0720-e13-silent-failures.md`, parts `0720` and `0830`), whose code landed with the change that deleted the report. The report as analysed is in git history at `69a3b4ca5`; the version with its outcome table is the parent of the commit that deleted it. Tasks 1, 2 and 5, the parts of task 4 that need a real login or a billed turn, and task 3's open decision on `orkestrator schedule list`, are in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

### Tasks

3. **The Schedules notice with two real backends on one data directory**: the second backend, a backend that loses the lease, and (found here) a backend that wins it late. Status: done (2026-11-14).
4. **Failed native and terminal turns ring "Agent stopped with an error"**: Claude, Codex, Pi and OpenCode refused, stopped, bridge-killed and restarted with the bridge gone, and a container Claude CLI tab. Status: done (2026-11-14); Cursor and Grok moved to 7568, the rest is tasks 6 and 7.
6. **A backend restart mid-turn with the bridge surviving**: the half of task 4's step 3 a local profile cannot reach. Status: open.
7. **A refused login in a `claude-tmux` tab**: task 4's step 4. Status: open.

### 3. The Schedules notice with two real backends on one data directory

**Problem.** `list_scheduled_jobs` answers `scheduler` (`{ firing: true }`, or
`firing: false` with `writer-lease-lost`, `another-backend` or
`newer-data-directory`), and Settings → Schedules shows a notice when it is
not firing and schedules exist. Each layer was tested; no running app had
shown it.

**Context.** The state comes from `RegistryWriter.state()`
(`apps/backend/src/core/registry-writer-lease.ts`), the mapping is
`schedulerStatus` (`commands-registry-scheduled-jobs.ts`) and the text is
`schedulerPausedMessage` (`packages/protocol/src/scheduled-jobs.ts`).

**Investigation.** Done on beelink on 2026-11-14 with
`e2e/agent-testing/schedules-two-backends-live.spec.ts` on a throwaway
`--no-agent-credentials --no-host-seed` profile (commands in
[agent-testing.md](../../development/agent-testing.md#schedules-notice-with-two-backends-on-one-data-directory)).
The second backend ran the profile backend's own arguments with another
gateway port and its own gateway token. Passed in 72 s, every step without a
reload:

| Step | First backend | Second backend |
| --- | --- | --- |
| Both running | `{ firing: true }`, no notice | `another-backend` notice |
| Lease file overwritten under a token neither holds | `writer-lease-lost` notice, 4.6 s after the write | `another-backend` |
| That lease left to go stale | still `writer-lease-lost` | won it 37 s after the write: `{ firing: true }`, notice gone |

The last row needed a fix. Task 4's restart case found that a backend which
started while the lease was held never got it: the lease was taken once at
startup, so a backend restarted within 30 s of a crash read `another-backend`
for its whole life, fired no schedules and refused every container change.
`openRegistryWriter` now returns a `ReclaimingRegistryWriter` for a busy
lease. It retries every heartbeat and becomes the lease once the holder stops
refreshing it, writes `writer-lease.acquired-late`, runs the writer-only
startup work with the won lease (`runWriterStartupWork` in
`apps/backend/src/core/index.ts`) and only then reports the lease held and
announces the scheduler change, so no schedule or container mutation runs
beside that recovery (review round 1, 2026-11-14). It takes over only once
it has itself watched the same lease go unrefreshed for 30 s of its own
running time, each retry counting at most one heartbeat, so a live holder
whose heartbeat could not fire across a host sleep keeps its lease when it
wakes (review round 2, 2026-11-14). The live takeover timings above predate
that rule, which can add up to one retry (10 s). Screenshots:
`output/visual-previews/5160-schedules-*.png` (not committed).

**Decisions.** See [Assumptions and decisions](#assumptions-and-decisions).

### 4. Failed native and terminal turns ring "Agent stopped with an error"

**Problem.** A failed turn used to ring "The agent completed its work". Now a
failure rings `agent_failed` ("Agent stopped with an error") and a success
`agent_finished`. Every path had been proved against stubbed bridges, fake
tmux and hand-written hook files only.

**Context.** Moved from to-dos 0940, 1060 and 1200 (deleted 2026-11-06). The
reason is `agent_failed` in `apps/backend/src/core/models.ts`, the toast copy
is in `environmentUnreadToast.tsx`. A stop the user asks for rings
`agent_finished`, never `agent_failed` (`native-agent-failed-turn-attention.test.ts`,
"a finished or user-stopped turn rings agent_finished"); only a goal's own
Stop rings nothing. This file used to say a stop "rings nothing", which was
wrong for ordinary turns.

**Investigation.** Done on beelink on 2026-11-14, every run on a throwaway
`--no-agent-credentials --no-host-seed` profile with no login and nothing
billed; commands are in
[agent-testing.md](../../development/agent-testing.md#failed-turn-bell-refused-login-model).

- **Native tabs** (`e2e/agent-testing/failed-turn-bell-live.spec.ts`): each
  provider's own config pointed at `refused-login-model.ts`, a loopback model
  that answers the 401 a wrong key gets and can hold requests. All sixteen
  cases passed on the final code, the page parked on another environment and
  the toast seen on opening the bell's:

  | Platform | Refused | Stopped | Bridge killed | Backend restarted, bridge gone |
  | --- | --- | --- | --- | --- |
  | Claude | `agent_failed`, 5 s | `agent_finished`, 30 s | `agent_failed`, 14 s | `agent_failed`, 18 s |
  | Codex | `agent_failed`, 16 s | `agent_finished`, 28 s | `agent_failed`, 14 s | `agent_failed`, 25 s |
  | Pi | `agent_failed`, 4 s | `agent_finished`, 28 s | `agent_failed`, 13 s | `agent_failed`, 20 s |
  | OpenCode | `agent_failed`, 6 s | `agent_finished`, 34 s | `agent_failed`, 80 s | `agent_failed`, 20 s |

  Times run from parking the page to the bell, so they include the stop's
  20 s quiet check and the 6 s activity sample.
- **Fixed: OpenCode's killed server.** Before the fix the OpenCode
  bridge-kill case never rang and the environment read `working` for good:
  the backend starts a replacement `opencode2 serve`, which reads the session
  idle but has no boundary row for the request's run, so
  `openCode2TurnTerminalError` threw "not settled yet" on every sweep and
  the environment was withheld as working. The provider now records such a
  run as cut short once it has stayed unsettled on an idle server for
  `OPENCODE2_UNSETTLED_RUN_GRACE_MS` (60 s). That is why the case takes 80 s.
- **Kept: the first-sweep window after a dispatch.** Pi's restart case first
  failed because the spec killed the backend about one second after dispatch,
  before any sweep had checkpointed the turn as active. After the restart no
  record said the turn was in flight, so it settled quietly. That is the
  rule chosen in #1484 ("a dispatch without an active checkpoint is not proof
  of an unfinished turn"), so the spec now samples the environment for 6 s
  first. Claude and Codex did not show it because their own bridges report
  the interrupted turn after a restart.
- **Container Claude CLI tab** (`container-claude-terminal-signal.spec.ts`
  with `ORKESTRATOR_AGENT_TEST_CLAUDE_TERMINAL_FAILED_TURN=1`), on a
  `docker:disposable --host-loopback` daemon with
  `orkestrator-v2:dev-5f4767c83385` built from this checkout: passed in
  224 s. The image's `claude` retried the in-container fake's 401 ten times,
  then `StopFailure` rang. The refused turn left `working` 179.4 s after
  Enter, read `idle` in the backend and the sidebar, rang `agent_failed`, and
  opening the environment showed the toast. The two good turns before it met
  their budgets (sidebar working within 460 and 720 ms, waiting within 386
  and 310 ms of the Stop hook), with the signal confirmed and rings going
  1 → 8: the host-loopback daemon lets the ring reach the profile through
  beelink's firewall. The next prompt in that session is answered "Not
  logged in" by the CLI with no hook, so the tab reads `working` for good:
  recorded as a known gap, [8092](../containers-and-environments/8092-claude-cli-prompt-after-refused-login-reads-working.md).
- **Not reachable with a fake model:** Cursor's SDK and Grok's CLI have no
  endpoint override, and with no credential they refuse before a turn
  starts. Their refused logins need a made-up key sent to Cursor's and xAI's
  real services, which is an outward action; they are in 7568.
- **Left running:** after the OpenCode `restart` case an `opencode2 serve`
  outlived the profile's reset; the reaper skips orphans that a
  `systemd --user` subreaper adopts. Stopped by hand; recorded as
  [8093](../containers-and-environments/8093-reaper-skips-orphans-under-a-subreaper.md).

**Decisions.** See [Assumptions and decisions](#assumptions-and-decisions).

### 6. A backend restart mid-turn with the bridge surviving

**Problem.** Task 4's step 3 asked for a restart once with the bridge gone
and once with it surviving. On a local profile `dev:stop` stops every
bridge with the backend, so only the first was shown.

**Context.** Container bridges run inside the container and keep running
across a backend restart. The bridge then reports the turn's own end, and the
restarted backend reads it through `unwatchedWorkingEnvironments` and the
bridge's `turnFailed` (`native-agent-unwatched-turn-end.test.ts`, "a turn
that failed across the restart rings agent_failed").

**Investigation.** Not run. What it needs: a container fixture environment on
`docker:disposable -- start --host-loopback`, a native Claude tab in it, and
an in-container model that holds a request and then refuses it.
`container-fake-claude-api.ts` refuses `REFUSE_QA_401` before its
`--reply-delay-ms` wait, so it needs a delayed refusal first.
`installContainerFakeClaude` in `idle-observation-fake-models.ts` already
points a container's native Claude at an in-container fake.

**Decisions.**

- **Where to add the case?**
  - **A container mode of `failed-turn-bell-live.spec.ts` (`ORKESTRATOR_AGENT_TEST_BELL_ENVIRONMENT=container`), Claude only, `restart` case only (recommended).**
    - Pros: reuses the parking, bell and toast checks and the restart helper.
    - Cons: the spec grows a second fake-model path.
  - **Extend `container-claude-terminal-signal.spec.ts`.**
    - Pros: that spec already owns a container and its fake.
    - Cons: it is a terminal-tab spec; a native tab and a backend restart do not belong there.

### 7. A refused login in a `claude-tmux` tab

**Problem.** Task 4's step 4: in a host `claude-tmux` tab, a refused key
should ring `agent_failed` and stop the tab reading working. Not shown.

**Context.** `claude-tmux` is behind the `experimentalTmux` setting. It reads
Claude's `StopFailure` hook (`tmux-hooks.ts`, `tmux-poll.ts`). The CLI runs
interactively under the profile's own `CLAUDE_CONFIG_DIR`, so a fresh profile
meets the CLI's first-run prompts (theme, API-key approval), which a run has
to answer or pre-seed in that directory only.

**Investigation.** Not run. Two findings from task 4 apply: the image's CLI
retries a 401 for about three minutes before `StopFailure`, and it then
answers the next prompt "Not logged in" with no hook (8092), which probably
holds for `claude-tmux` too.

**Decisions.**

- **How to fail the turn?**
  - **Point the profile's Claude `settings.json` at `refused-login-model.ts`, as the native cases do (recommended).**
    - Pros: the same loopback model, no outward request; the settings file already reaches every Claude the profile starts.
    - Cons: the first-run prompts must be handled in the profile's config directory.
  - **A made-up key against Anthropic.**
    - Pros: the real refusal.
    - Cons: an outward request; it belongs in 7568.

## Assumptions and decisions

### Task 4: a refused login is a loopback 401, not a made-up key sent to the provider

Chose a loopback model (`refused-login-model.ts`) that answers each provider
the 401 a wrong key gets. The ticket required a fake model and no outward
requests, and the bridges and CLIs are real, so the failure path is the
provider's own. The alternative, a made-up key against the real API (as
`codex-refused-login-live.spec.ts` does), proves the provider's exact error
text but sends a request outward; that is left to 7568 for Cursor and Grok,
which have no endpoint override.

### Task 4: a user's stop rings `agent_finished`

The spec asserts the unit-tested rule (a stop never rings `agent_failed`)
rather than this file's old wording ("rings nothing"). Changing the product
to ring nothing would contradict `native-agent-failed-turn-attention.test.ts`
and #1484's decision, and the ticket asked for evidence, not a new rule.

### Task 4: OpenCode's cut-short run is decided in the provider, after a grace

Options: a grace in `OpenCodeEnvironmentProvider.turnTerminalError`
(chosen); comparing the server generation at dispatch with the current one;
a rule in the activity reconciler. The generation lives in memory and says
nothing after a backend restart; the reconciler is already over 2,000 lines
and the evidence is OpenCode-specific. The grace keeps the guard against an
early idle read, which is why the throw existed, and applies only while the
server reads the session idle. The cost is up to a minute before the bell.

### Task 4: the first sweep interval after a dispatch stays unproven

Treating a dispatch with no active checkpoint as cut short would ring
`agent_failed` for a turn that finished inside the same 2 s window. #1484
chose `agent_finished` for that case and a unit test pins it, so the rule was
kept and the spec samples for 6 s before it kills the backend.

### Task 3: a busy writer keeps trying for the lease

Options: retry until the holder lets the lease go stale (chosen); check
whether the recorded holder's PID is alive at startup; leave it. A PID check
is unsafe across PID reuse and containers, and leaving it makes every crash
followed by a fast restart a read-only backend. The retry reuses the
existing takeover rule, so a live holder that keeps refreshing is never
displaced.

### Task 3: a retry counts the holder's silence on its own clock

Review round 2 found that the stale rule alone is wall-clock time: across a
host sleep the lease file ages past 30 s while neither backend runs, so the
retrying backend could take over from a live holder on wake, and that holder
would stay lost until restarted. Options: require the retrying backend to
have watched the same lease (token and modification time) go unrefreshed
for 30 s itself, each retry counting at most one heartbeat on the monotonic
clock (chosen); take over only when the recorded holder's PID is dead; let
a lost holder take the lease back. The chosen rule holds whatever the clock
does across a sleep and costs at most one extra retry after a crash. A PID
check is unsafe across PID reuse and containers, and a holder taking the
lease back would undo a takeover the other backend has already recovered
from. A holder whose own event loop stalls for longer than 30 s while the
other backend runs is still displaced, as a holder that died would be.

### Task 4: the container prompt that reads working is recorded, not fixed

The gap is the CLI's (no hook for a locally refused prompt), and each fix
needs a choice (screen reading, a ceiling, or a CLI change), so it is to-do
8092 and the spec records it as a known gap.

## Open questions

- Whether `orkestrator schedule list` should print the scheduler status too is a decision for the user, in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) (5160 task 3). The public action does not carry it; the report asked only for the Settings notice.

## Related

- [0002 session lifecycle consistency](../agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour itself
- [8045](../agent-engines/8045-opencode-turn-cut-by-backend-restart-stays-busy.md): an OpenCode turn whose restarted server still lists it as active, which the grace in task 4 does not cover.
- [8092](../containers-and-environments/8092-claude-cli-prompt-after-refused-login-reads-working.md): found by task 4.
- [8093](../containers-and-environments/8093-reaper-skips-orphans-under-a-subreaper.md): found by task 4's OpenCode restart case, which left an `opencode2 serve` running after the profile was reset.
- [Application logging](../../architecture/logging.md#failures-that-would-otherwise-leave-no-trace)
- [Scheduled jobs](../../architecture/scheduled-jobs.md#exactly-once)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 2, task 5, task 3's `schedule list` decision, and the successful-turn checks and Cursor's and Grok's refused logins of task 4).
