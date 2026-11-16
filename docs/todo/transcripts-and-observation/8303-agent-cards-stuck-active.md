# Finished Claude fork agents stay "Active" in the pinned Agents panel

## Task analysis

Analysed 2026-11-15 against `main` at `348d13c78`.

### Tasks

1. **Find which copy of the state says "active"**: reproduce on a `dev:test` profile and read the bridge's snapshot and transcript rows for a stuck card. Status: open.
2. **Settle the card at its source**: fix whatever task 1 names (a row that never reaches the reader, a task record that never settles, or both). Status: open (depends on 1).
3. **No card stays "Active" without live evidence**: make the renderer fall back to a non-live label when nothing backs a running state. Status: open.
4. **Regression tests**: a bridge or projection test for task 2's cause and a renderer test for task 3. Status: open (depends on 1).

### 1. Find which copy of the state says "active"

**Problem.** In a native Claude tab, the pinned **Agents** panel at the bottom
of the transcript showed fork subagents as **Active**, with spinners and
elapsed timers still counting (about 8 hours), long after they had finished.
`TaskStop` on their ids answered `No task found`, so nothing was running.
Leaving the environment and coming back made it worse: the panel went from
four stuck cards to six.

**Context.** Observed on 2026-11-15 in this repository's own session (the
flake sweep on `fix-flaky-tests-57033d2a4f0e-r1`). The main agent started
general-purpose background subagents, and each of those started several
`fork` subagents in parallel (`subagent_type: "fork"`; the launch returns at
once, and the fork reports back through a task notification). During the run
the CLI died at about 16:06 on a usage limit, the session moved accounts and
was resumed several times, and the bridge served it throughout.

The panel is `AgentGroupPart` in
`apps/web/src/components/chat/NativeMessage.agent-parts.tsx`, fed by
`apps/web/src/lib/chat/native-agent-pinning.ts`. Pinning collects every
agent part in the rows the tab holds, including agents nested inside another
agent's card, whose status (`getNativeAgentStatus`,
`apps/web/src/lib/chat/native-agent-status.ts`) is `active`. For a Claude
agent row, `applyClaudeBackgroundTaskStates`
(`apps/web/src/lib/chat/native-message-adapters.ts`, around line 1262) takes
the state from the bridge's background-task record when one matches the
launch, and otherwise from the launch call's own tool state: `pending`
becomes `active`.

**Investigation.** Read from the session's rollout files, printing only ids,
record types and timestamps:

- The six stuck cards were all forks: "ACP bridge flaky cases" and "Claude
  bridge flaky cases" (started by one worker), "Fix flaky cases batch 1" to
  "3" (started by another), and "Triage web-ui flakes" (started at 21:43 by a
  third).
- Every one of their launch calls has a successful tool result in the
  rollout, so a pending launch call in Claude's own record is not the cause.
- Four of the six finished normally, each ending on a final assistant
  message: batches 1 to 3 at 15:57, 16:37 and 16:11, and "Triage web-ui
  flakes" at 21:46. Batches 2 and 3 also delivered `completed` task
  notifications to the main session (16:37 and 16:11). The other two were
  killed with the CLI at 16:06.
- The death of the CLI that owned them does not explain it. Other forks killed
  at the same moment ("Desktop scripts flaky cases", "Backend coordinator
  flakes A1") show as settled, and "Triage web-ui flakes" was started and
  finished hours after the last restart.
- In each batch started together, earlier siblings stuck and the last did not:
  batches 1 to 3 but not batch 4; ACP and Claude but not Cursor/Codex/Pi,
  Electron or Desktop; "Triage web-ui flakes" but not the three triage forks
  started after it. That is an observed pattern, not an established cause.
- The cards read **Active**, not **Running**. A card backed by a background-task
  record takes its label from that record (`BACKGROUND_TASK_PRESENTATION`:
  Starting, Running, Paused, Completed, Failed, Stopped), so these cards had no
  record attached, and their state came from a row the tab holds.
- The count rose from four to six on remount. A remount re-reads history, so
  the panel shows whatever stale rows the tab loaded, not what is running.

What was not checked: the live bridge's `GET /session/:id` snapshot and its
transcript pages for these launch ids. Reading them needs the bridge token,
which a session must not handle, so this needs a reproduction on a
throwaway profile.

**Decisions.**

- **How to establish the source?**
  - **Reproduce on a `dev:test` profile and read both copies (recommended).**
    Start a native Claude session that launches one background
    general-purpose agent, which launches three parallel `fork` agents that
    each run a few tool calls and finish. Let them finish, switch
    environments and back, and reload. Then compare, for each fork's launch
    `toolUseId`: the bridge snapshot's `backgroundTasks`, the row in
    `/session/:id/transcript?version=2` and the history pages, and the
    renderer's held row. Repeat with the CLI ended mid-run (a session
    `close`, or the idle window set to 0) to cover the restart variant.
    - Pros: tells apart a row that changed but never reached the reader
      (invariant 14, `revisedMessages`), a background-task record that never
      settled, and a renderer that keeps an old copy; real Claude CLI and
      real fork semantics.
    - Cons: a live run with credentials and a few minutes of model time.
  - **A scripted bridge test from recorded frames.**
    - Pros: deterministic, no credentials.
    - Cons: first needs the frame sequence a parallel fork batch produces,
      which only a live run shows; better as task 4 once task 1 has the
      recording.

### 2. Settle the card at its source

**Problem.** Whatever task 1 finds, a finished fork's card must end up
terminal in the bridge's snapshot, in every transcript row that holds its
launch, and in every reader, including rows outside the live tail and after a
remount.

**Context.** The bridge already settles two cases. When a CLI ends,
`releaseClaudeRuntimeTasks`
(`bridges/claude-bridge/src/services/session-manager-background-tasks.ts`)
marks every live task it owned as `killed`. When a transcript is hydrated,
`normalizePersistedSessionMessages`
(`bridges/claude-bridge/src/services/session-manager-messages.ts`, around line
1926) marks every task that is still live as `killed` with "The Claude process
that owned this task is no longer running". Both act on the root session's
`backgroundTasks`. Forks started from inside a subagent appear in the parent
agent's row (`rehydrateSubagentParts` on reload, `routeClaudeFrame` live).
The bridge `AGENTS.md` requires a late change to a row outside the live tail
to be noted in `RecentlyRevisedRows`, so readers replace their copy.

**Investigation.** Pending task 1. The candidates the evidence leaves open:

1. A fork's ending updates a nested row (inside the parent agent's card) that
   has already left the live tail, and that row is not noted as revised, so
   readers keep the copy from before the ending.
2. A fork started by a subagent gets a background-task record, or a nested
   agent state, that its `task_notification` never matches. The launch
   `toolUseId` belongs to the subagent's row and the notification arrives
   through the root, so the record stays `running`.
3. Parallel siblings share a row, and a later sibling's update replaces the
   earlier siblings' settled state with an older copy. This would fit the
   "all but the last" pattern.

**Decisions.**

- **Where should the fix live?**
  - **In the bridge, at the change (recommended once task 1 names the
    cause).** Note the revised row, or settle the record, where the fork's
    ending is read.
    - Pros: one authoritative snapshot; every reader, tab and reload agrees;
      follows invariants 3, 6 and 14.
    - Cons: the Claude bridge's row routing is intricate (`routeClaudeFrame`,
      shared stream rows), so it needs task 4's test first.
  - **In the renderer only.**
    - Pros: smaller.
    - Cons: two tabs or a reload can disagree, and the snapshot stays wrong
      for the backend's activity and pipeline logic.

### 3. No card stays "Active" without live evidence

**Problem.** Even once task 2 is fixed, any future gap leaves a card spinning
forever. `getNativeAgentStatus` returns `active` for any agent with no
explicit state and no terminal tool state: both of its last branches return
`active`. The elapsed timer then counts for as long as the tab is open.

**Context.** The renderer already has the right idea for background shell
tasks: `UNKNOWN_BACKGROUND_TASK` shows a launch with no live snapshot behind
it as **Launched**, never live and with no stop control. The Cursor bridge
does the same for sub-agents once their parent run ends, showing them as
detached rather than claiming they completed (root `AGENTS.md`, Cursor
bridge).

**Investigation.** Not started beyond reading the code above.

**Decisions.**

- **What should a card with no live backing show?**
  - **Active only while the snapshot lists the task as live, or the parent
    agent is itself still active (recommended).** Otherwise show a neutral
    terminal label ("Ended" or "Launched", with the
    `UNKNOWN_BACKGROUND_TASK` styling), and let pinning skip it.
    - Pros: a stale row can no longer pin a spinner; matches the existing
      Launched and detached conventions; "live" is decided by the same
      snapshot the stop control trusts.
    - Cons: a nested agent of a provider that reports no lifecycle could
      read as ended while it is still working. Gate the rule on providers
      whose snapshot carries task lifecycle (Claude), or on the parent
      being terminal.
  - **A time ceiling (for example, hide after an hour with no new child
    frame).**
    - Pros: simple.
    - Cons: a timed rule, which is exactly what makes tests and readers
      disagree on a loaded host; rejected.

### 4. Regression tests

**Problem.** Nothing currently covers parallel forks started from a subagent,
or their endings landing after the parent's row has left the live tail.

**Context.** `session-manager-prompt-stream.test.ts` drives the Claude
stream directly, and the renderer has `native-agent-pinning` and adapter
tests.

**Investigation.** Pending task 1's recording.

**Decisions.**

- **What to test?**
  - **One bridge or projection test replaying task 1's frame sequence, plus
    one renderer test for task 3 (recommended).** The bridge test: a parent
    agent row with three fork launches whose endings arrive after newer rows
    exist; assert that every launch reads terminal in the snapshot and in
    `revisedMessages` (or the page read). The renderer test: a held row with
    a pending nested launch and no live snapshot task is not pinned and not
    active.
    - Pros: covers both the cause and the floor; deterministic.
    - Cons: needs the recorded frames, and they must be scrubbed
      (`scripts/scrub-codex-recording.ts` covers Codex only, so scrub
      Claude frames by hand: no prompts or file content).
  - **An agent-testing browser spec.**
    - Pros: end to end.
    - Cons: live model time on every run; keep it as a manual check in 7568
      at most.

## Needs verification

- Whether the panel's cards are `task-group` or `subagent` parts. Their
  **Active** label fits both; task 1's held-row read answers it.
- Whether the "all but the last sibling" pattern holds outside this one
  session.

## Related

- Root `AGENTS.md`, "Background Work and Transport Invariants" (3, 6 and 14)
  and the Cursor bridge's detached sub-agent rule.
- `bridges/AGENTS.md`, "Transcript rows" (`RecentlyRevisedRows`,
  `revisedMessages`).
- `bridges/claude-bridge/AGENTS.md`, "Background work belongs to the runtime".
