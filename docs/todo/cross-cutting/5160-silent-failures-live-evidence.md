# Live evidence for the silent-failure notices and the vendor debug filter

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from the E13 efficiency batch (`docs/reports/efficiency-logging-database/0720-e13-silent-failures.md`, parts `0720` and `0830`), whose code landed with the change that deleted the report. The report as analysed is in git history at `69a3b4ca5`; the version with its outcome table is the parent of the commit that deleted it. That ticket forbade billed provider turns, so everything below that needs a real agent conversation, or a real vendor CLI, could not be shown there.

### Tasks

3. **The Schedules notice with two real backends on one data directory**: the second backend, and a backend that loses the lease, show the notice in Settings → Schedules. From part `0720` task 1. Status: open (needs live evidence).
4. **Failed native and terminal turns ring "Agent stopped with an error"**: a failed turn on each native provider, a bridge crash, a backend restart mid-turn, and provider errors from a refused login in `claude-tmux` and container Claude CLI tabs. Moved from to-dos 0940, 1060 and 1200 (deleted 2026-11-06). Status: open (needs live evidence; the successful-turn checks are in 7568: 5160 task 4).

### 3. The Schedules notice with two real backends on one data directory

**Problem.** `list_scheduled_jobs` now answers `scheduler` (`{ firing: true }`, or `firing: false` with `writer-lease-lost`, `another-backend` or `newer-data-directory`), and Settings → Schedules shows a notice when it is not firing and schedules exist. Each layer is tested, but no running app has shown it.

**Context.** The state comes from `RegistryWriter.state()` (`apps/backend/src/core/registry-writer-lease.ts`), the mapping is `schedulerStatus` (`commands-registry-scheduled-jobs.ts`), and the text is `schedulerPausedMessage` (`packages/protocol/src/scheduled-jobs.ts`). A lost lease calls `onLost`, which announces a `scheduled-job` change so an open view rereads.

**Investigation.** Tests: `registry-writer-lease.test.ts` (state per case, one callback per loss, a throwing callback is logged), `commands-registry-scheduled-jobs.test.ts`, and `SchedulesSettings.test.tsx` (the notice, a reread after a loss, no notice without schedules or from an older backend). The real component was rendered against a stub backend for screenshots. No provider turn is needed, but starting a second backend on one isolated profile's data directory, or taking its lease over, was not attempted.

**Decisions.**

- **How to reach the states?**
  - **Start an isolated profile, then a second standalone backend on the same profile data directory with its own ports, and read Settings → Schedules from each; then overwrite the lease file to take the first backend's lease (recommended).**
    - Pros: covers `another-backend` and `writer-lease-lost` with real files and the real gateway; no provider turn.
    - Cons: two backends on one directory need care to stop only the processes this run started.
  - **Accept the layer tests.**
    - Pros: no extra work.
    - Cons: the announce-to-reread path through the real event stream stays unobserved.

### 4. Failed native and terminal turns ring "Agent stopped with an error"

**Problem.** A turn that failed used to ring "The agent completed its work".
Now a failure rings `agent_failed` ("Agent stopped with an error"), a stop the
user asked for rings nothing, and a success still rings `agent_finished`. Every
path is proved against stubbed bridges, fake tmux and hand-written hook files,
never against a real provider error.

**Context.** Moved from to-dos 0940, 1060 (its terminal half) and 1200, all
deleted 2026-11-06. The reason is `agent_failed` in
`apps/backend/src/core/models.ts`, with the toast copy in
`environmentUnreadToast.tsx`. Native bridges report `turnFailed` on their
no-touch activity reads (`packages/protocol/src/session-activity-batch.ts`); an
unwatched turn that ends while the backend is down is recovered after a restart
(`native-agent-unwatched-turn-end.test.ts`), and a stop inside
`RUNTIME_STOP_REQUEST_WINDOW_MS` rings nothing
(`native-agent-failed-turn-attention.test.ts`). `claude-tmux` reads Claude's
StopFailure hook (`tmux-hooks.ts`, `tmux-poll.ts`). A container Claude CLI tab
signals `failed` through `orkestrator-state-signal` on images with
`claude-state-signal=3`; that path already passes in CI on linux-x64 and
linux-arm64 (`container-live-qualification.yml`, "Live Claude terminal failed
turn").

**Investigation.** Steps, each in a disposable `dev:test` profile:

1. Run one failing turn per native provider, for example a refused login on
   Codex, Claude, Cursor, Grok, Pi and OpenCode. Check for the "Agent stopped
   with an error" toast, and that a stopped turn rings nothing. (That a good
   turn rings "completed" needs a billed turn; it is in the manual-test
   checklist.)
2. Start a turn and kill its bridge mid-turn; check for `agent_failed`.
3. Start a turn and restart the profile's backend mid-turn, once with the
   bridge surviving and once with it gone; check for `agent_failed`. A stop
   the user asked for must ring nothing.
4. In a real `claude-tmux` tab, cause an API error (a refused key or a rate
   limit). Check for the toast and that the tab stops showing working.
5. In a container Claude CLI tab on an image built from current `main`, cause
   a provider error with a refused key. Check that the sidebar leaves `working`
   and the toast appears. (That a following good turn rings `agent_waiting`
   needs a billed turn; it is in the manual-test checklist.)

**Decisions.**

- **How to fail a turn on demand?**
  - **A refused login: a made-up key in the profile's own provider home (recommended).**
    - Pros: free, repeatable and the same on every provider.
    - Cons: one failure kind only; a rate limit may take a different path.
  - **Wait for a real rate limit.**
    - Pros: the commonest real failure.
    - Cons: cannot be scheduled.

## Open questions

- Whether `orkestrator schedule list` should print the scheduler status too. The public action does not carry it; the report asked only for the Settings notice.

## Related

- [0002 session lifecycle consistency](../agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour itself
- [Application logging](../../architecture/logging.md#failures-that-would-otherwise-leave-no-trace)
- [Scheduled jobs](../../architecture/scheduled-jobs.md#exactly-once)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 2, task 5, the successful-turn checks of task 4) moved there on 2026-11-10.
