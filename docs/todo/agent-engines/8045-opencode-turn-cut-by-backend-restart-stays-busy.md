# An OpenCode turn cut short by a backend restart stays busy

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **Settle an OpenCode turn a backend restart cut short**: the restarted backend reads the session as still running, so a subork on OpenCode waits out the 45-minute bound instead of getting its continuation. Status: open.
2. **Turn the restart spec's OpenCode target on**: once task 1 is fixed, make `pi,opencode` the scripted default targets of `suborks-restart-live.spec.ts`. Status: open (depends on 1).

### 1. Settle an OpenCode turn a backend restart cut short

**Problem.** When the backend is killed while an OpenCode subork's turn is in flight and the profile is started again, the subork stays `running`. Its branch record keeps `dispatchState: "sent"`, `status: "running"` and the `progressAt` from before the kill, with no idle polls counted, so the runner is reading the session as `running` on every pass. Nothing reaches the model again. The branch is failed only by the stall bound (`DEFAULT_STALL_ABANDON_MS`, 45 minutes), which is also the subork deadline, so the caller's answers arrive 45 minutes late with that target failed. A Pi target in the same call, killed at the same moment, got the runner's continuation turn and finished within seconds of the restart.

**Context.** The branch runner (`apps/backend/src/core/agent-branch-runner.ts`) gives a turn "a provider restart cut short" one continuation, but only when the provider reports the session as `error` with `interruption: "restart"`. Pi's bridge reports that. OpenCode 2's `status()` (`apps/backend/src/core/opencode2/provider.ts`) answers `running` whenever `GET /api/session/active` names the session, before it looks at the session's outcome. The same read decides a native OpenCode tab's activity, so a tab whose turn was cut by a backend restart is probably affected the same way; that is not yet observed.

**Investigation.** Found by `suborks-restart-live.spec.ts` (4340 (retired) task 4) on 2026-11-13, on this Mac (macOS, Apple silicon), on a disposable `--no-agent-credentials --agent-platforms pi,opencode` profile with the pinned `opencode2` 2.2.6 and a scripted model that held both targets' requests open across the kill. Reproduced twice. On a profile kept after the failure (`ORKESTRATOR_AGENT_TEST_SUBORKS_KEEP=1`):

- The subork row in the profile's `orkestrator.sqlite` (`native-agent-suborks`) showed the OpenCode branch as above, seven minutes after the restart; the Pi branch was `completed` with `resultReminderSent: true`.
- The profile's own OpenCode database (`data/opencode2/opencode.db`, table `session_v2`) had the reviewer session with `time_busy` set, `time_idle` empty, `time_suspended` set and `resume_attempts` 0. Its last assistant message had a `completed` time a few seconds after the kill (the server was stopped under it).
- The scripted model received no request for that session after the restart, so OpenCode did not resume the turn by itself in that time.
- The restarted backend's start-up reaped the orphaned `opencode2 serve` and started a new one (`reaper.server-reaping kind=opencode`, then `bridge.started`).

What is inferred and not observed: that the new server's `/api/session/active` lists the session because of the stored busy state. The server's password is held only in the backend's memory, so the route was not called directly.

**Decisions.**

- **Where to recognise the cut-short turn?**
  - **In the OpenCode 2 provider: a session the server lists as active, whose busy time predates this server process and which has made no progress since, is reported as `error` with `interruption: "restart"` (recommended).**
    - Pros: one place, matching what Pi's bridge already reports; the branch runner, the review fan-out and the build pipeline all treat that answer the same way; native tabs benefit too.
    - Cons: needs OpenCode's own rule for suspended sessions pinned first, so a session OpenCode is about to resume is not treated as dead; a probe in `opencode2-qualification.live.test.ts` (kill the server mid-turn, start it again, read `/api/session/active` and the session) is the way to pin it.
  - **Abort such sessions when the backend starts the server again.**
    - Pros: OpenCode's state then says idle, and every reader agrees.
    - Cons: the backend cannot tell at start-up which sessions it should own; aborting a session another client is running would stop real work.
  - **Leave it to the stall bound.**
    - Pros: no change.
    - Cons: 45 minutes of a target shown as working, and a lost answer, after every restart that lands mid-turn.

### 2. Turn the restart spec's OpenCode target on

**Problem.** The scripted restart case runs an OpenCode caller and a Pi target only, because an OpenCode target fails until task 1 is fixed.

**Context.** `ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_TARGETS` selects the targets; `pi,opencode` reproduces this to-do.

**Investigation.** Not started; depends on task 1.

**Decisions.** No material choice: change the scripted default in `suborks-restart-live.spec.ts` and the description in `docs/development/agent-testing.md`, then run `mise run test:agent:suborks`.

## Related

- [`docs/architecture/suborks.md`](../../architecture/suborks.md) (Lifecycle: "a restart never sends a turn twice").
- [`docs/development/agent-testing.md`](../../development/agent-testing.md#suborks-on-every-provider-and-across-a-restart-fake-model).
- 4340 (retired): the subork live qualification that added the restart spec; its final state is in Git history at `14d8ce8db`.
- [5160](../cross-cutting/5160-silent-failures-live-evidence.md) task 4: a killed `opencode2 serve` whose replacement reads the session idle, with the request's run left unsettled, is now recorded as cut short after `OPENCODE2_UNSETTLED_RUN_GRACE_MS` (`opencode2/environment-provider.ts`, 2026-11-14). It does not cover this to-do's case, where the restarted server still lists the session as active.
