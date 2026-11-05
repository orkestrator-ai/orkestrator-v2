# Live evidence for the silent-failure notices and the vendor debug filter

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from the E13 efficiency batch (`docs/reports/efficiency-logging-database/0720-e13-silent-failures.md`, parts `0720` and `0830`), whose code landed with the change that deleted the report. The report as analysed is in git history at `69a3b4ca5`; the version with its outcome table is the parent of the commit that deleted it. That ticket forbade billed provider turns, so everything below that needs a real agent conversation, or a real vendor CLI, could not be shown there.

### Tasks

1. **The resume-fallback note in a real Pi and Cursor session**: a resumable conversation whose resume fails shows the note. From part `0720` task 3. Status: open (needs live evidence).
2. **Vendor CLIs without the dropped debug variables**: no supported provider needs `DEBUG`, `RUST_LOG` or `DEBUG_CLAUDE_AGENT_SDK` in normal use. From part `0830` task 1, "Needs verification". Status: open (needs live evidence).
3. **The Schedules notice with two real backends on one data directory**: the second backend, and a backend that loses the lease, show the notice in Settings → Schedules. From part `0720` task 1. Status: open (needs live evidence).

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

## Open questions

- Whether `orkestrator schedule list` should print the scheduler status too. The public action does not carry it; the report asked only for the Settings notice.

## Related

- [0002 session lifecycle consistency](../agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour itself
- [Application logging](../../architecture/logging.md#failures-that-would-otherwise-leave-no-trace)
- [Scheduled jobs](../../architecture/scheduled-jobs.md#exactly-once)
