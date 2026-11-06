# Live evidence for the silent-failure notices and the vendor debug filter

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from the E13 efficiency batch (`docs/reports/efficiency-logging-database/0720-e13-silent-failures.md`, parts `0720` and `0830`), whose code landed with the change that deleted the report. The report as analysed is in git history at `69a3b4ca5`; the version with its outcome table is the parent of the commit that deleted it. That ticket forbade billed provider turns, so everything below that needs a real agent conversation, or a real vendor CLI, could not be shown there.

### Tasks

1. **The resume-fallback note in a real Pi and Cursor session**: a resumable conversation whose resume fails shows the note. From part `0720` task 3. Status: open (needs live evidence).
2. **Vendor CLIs without the dropped debug variables**: no supported provider needs `DEBUG`, `RUST_LOG` or `DEBUG_CLAUDE_AGENT_SDK` in normal use. From part `0830` task 1, "Needs verification". Status: open (needs live evidence).
3. **The Schedules notice with two real backends on one data directory**: the second backend, and a backend that loses the lease, show the notice in Settings → Schedules. From part `0720` task 1. Status: open (needs live evidence).
4. **Failed native and terminal turns ring "Agent stopped with an error"**: a failed turn on each native provider, a bridge crash, a backend restart mid-turn, and real provider errors in `claude-tmux` and container Claude CLI tabs. Moved from to-dos 0940, 1060 and 1200 (deleted 2026-11-06). Status: open (needs live evidence).
5. **Workflow end bells: Multi Review, graph runs and build pipelines**: a failure rings `agent_failed`, a cancel or pause rings nothing, and a success rings `agent_finished`. Moved from to-dos 1060 and 1201 (deleted 2026-11-06). Status: open (needs live evidence).

### 1. The resume-fallback note in a real Pi and Cursor session

**Problem.** When a Pi or Cursor resume fails, the bridge starts a new conversation and now adds a warning status row to the transcript ("Could not resume the previous … conversation, so a new one was started. The agent does not remember the earlier messages."). That row has only been seen with fakes and the real Pi SDK's session manager, never in a real tab.

**Context.** Pi writes it in `sessionManagerFor` (`bridges/pi-bridge/src/agent-session.ts`) and Cursor in `attach` (`bridges/cursor-bridge/src/agent-session.ts`), both through `appendResumeFallbackNotice` in their `translate.ts`, beside the existing `session.resume-fell-back` warning. The row is fixed text, carries none of the provider's error, and is kept in each bridge's state file with the rest of the rendered transcript. Cursor's prompt route publishes it with the replacement agent's id at its persistence barrier. The renderer draws it with the existing `StatusPart`.

**Investigation.** Tests: `agent-session.test.ts` in each bridge (the row appears on both Pi fallback paths and the Cursor fallback, not on a clean reopen, an unused session or a Cursor configuration resume, and Cursor's survives `loadPersistedState`). Not observed: the row in the browser, its place relative to the next user message, and a reload of the tab and of the bridge after it. Reaching the state needs a conversation that has run at least one real turn, then a broken resume (a deleted Pi session file, or a Cursor agent id the store no longer has).

**Decisions.**

- **How to produce a failed resume?**
  - **On an isolated `dev:test` profile, run one cheap turn, stop the bridge, remove the Pi session file (or edit the Cursor state file's `agentId`), then send again (recommended).**
    - Pros: the real path end to end, including reload and bridge restart; one short turn per provider.
    - Cons: billed turns; needs the user's approval.
  - **Seed the bridge state file with a fabricated transcript and a missing session file.**
    - Pros: no turn is billed for the fallback itself.
    - Cons: the next send is still a real turn, and a fabricated state proves less about a real one.

### 2. Vendor CLIs without the dropped debug variables

**Problem.** A local bridge launch now drops `DEBUG`, `RUST_LOG` and `DEBUG_CLAUDE_AGENT_SDK` inherited from the backend's environment, unless the backend runs with `ORKESTRATOR_KEEP_VENDOR_DEBUG=1`. If a provider CLI relied on one of them in normal use, it would change behaviour silently.

**Context.** `dropInheritedVendorDebug` (`apps/backend/src/core/bridge-vendor-debug-env.ts`), called from `startLocalServerAttempt` in `commands-servers.ts`; documented in `docs/architecture/logging.md` under the bridge hop. The removal also reaches the vendor CLI and the commands an agent runs, which is the report's recommended scope.

**Investigation.** No code in `apps/backend/src`, `packages/protocol/src` or `bridges/*/src` reads any of the three. No settings field passes user-set variables to a local bridge, so the escape hatch is the only way to keep them. The vendor CLIs were not run, so whether any reads one of them for something other than debug output is unproven.

**Decisions.**

- **How to check?**
  - **One short turn per provider on an isolated profile, with each variable exported in the launching shell and without, comparing the result (recommended).**
    - Pros: direct evidence; also shows how much text each variable produced before the filter.
    - Cons: billed turns.
  - **Read each vendor's documentation and source for the variable names.**
    - Pros: free.
    - Cons: Claude Code and Grok are closed source, so the answer stays partial.

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
   with an error" toast, and that a stopped turn rings nothing and a good turn
   rings "completed".
2. Start a turn and kill its bridge mid-turn; check for `agent_failed`.
3. Start a turn and restart the profile's backend mid-turn, once with the
   bridge surviving and once with it gone; check for `agent_failed`. A stop
   the user asked for must ring nothing.
4. In a real `claude-tmux` tab, cause an API error (a refused key or a rate
   limit). Check for the toast and that the tab stops showing working.
5. In a container Claude CLI tab on an image built from current `main`, cause
   a real provider error. Check that the sidebar leaves `working` and the toast
   appears, then that a following good turn rings `agent_waiting`.

**Decisions.**

- **How to fail a turn on demand?**
  - **A refused login: a made-up key in the profile's own provider home (recommended).**
    - Pros: free, repeatable and the same on every provider.
    - Cons: one failure kind only; a rate limit may take a different path.
  - **Wait for a real rate limit.**
    - Pros: the commonest real failure.
    - Cons: cannot be scheduled.

### 5. Workflow end bells: Multi Review, graph runs and build pipelines

**Problem.** Multi Review, graph runs and build pipelines used to ring
`agent_finished` however they ended. Each now passes its outcome to the bell.
The tests use the real services and storage with stub providers and
hand-written records, not a running workflow.

**Context.** Moved from to-dos 1060 (its workflow half) and 1201, both deleted
2026-11-06. The outcome type is `AgentActivityCompletionOutcome` in
`apps/backend/src/core/models.ts`, set by `workflowCompletionOutcome`
(`multi-review-service.ts`), `graphRunCompletionOutcome`
(`graph-run-attention.ts`) and `buildPipelineCompletionOutcome`
(`build-pipeline-activity.ts`). For a pipeline, a cancel is a `failed` with
`BUILD_CANCELLED_ERROR` and rings nothing, requested and supervisor pauses ring
nothing, a stall is not an end, and a pipeline that stalls and then ends rings
once.

**Investigation.** Steps, each in a disposable `dev:test` profile:

1. Run a Multi Review that fails and one that is cancelled. Check that the
   failure rings "Agent stopped with an error" and the cancel rings nothing.
2. Do the same with a graph run: one that fails, one cancelled or paused.
3. Run a build pipeline to completion (rings "completed"), one that fails
   (rings "Agent stopped with an error"), and cancel and pause one each
   (neither rings).
4. If one can be produced, watch a pipeline that stalls and then ends, and
   check that it rings once.

Two known limits stay as they are and need no run: a failed auto PR launch
still rings `agent_finished`, because the review and Fix did complete and only
the coordinator's wake reports it (changing it needs a fix-identity check); and
a supervisor pause (an unchanged Fix that needs a decision) rings nothing,
although nobody asked for it. Whether it should ring `agent_waiting` is still
an open question.

**Decisions.**

- **One profile or three?**
  - **One profile with a live provider for all three workflows (recommended).**
    - Pros: one setup; the same toast to watch.
    - Cons: a long billed session.
  - **Stub providers in the profile.**
    - Pros: free.
    - Cons: that is what the tests already do.

## Open questions

- Whether `orkestrator schedule list` should print the scheduler status too. The public action does not carry it; the report asked only for the Settings notice.

## Related

- [0002 session lifecycle consistency](../agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour itself
- [Application logging](../../architecture/logging.md#failures-that-would-otherwise-leave-no-trace)
- [Scheduled jobs](../../architecture/scheduled-jobs.md#exactly-once)
