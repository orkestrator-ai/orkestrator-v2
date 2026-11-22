# Provider-replay corpus: real recordings and what the synthetic fixtures found

## Task analysis

Analysed 2026-11-19 against `main` at `0007f0e66`; tasks 1, 3 and 4 updated 2026-11-22 against `main` at `dd1391427`. Follow-up to the provider-replay suite for the Claude, Cursor, Pi and ACP bridges (`tests/conformance/provider-replay/`).

### Tasks

1. **Record real traffic for the priority scenarios on Claude, Cursor and Pi, and add it beside the synthetic fixture.** Status: done.
2. **Decide whether an interrupted turn should settle its started tool cards on Claude and Pi.** Status: done.
3. **Record Grok (ACP) traffic.** Status: open (depends on 7568: a Grok sign-in on the host).
4. **Record the scenarios still synthetic only: Claude `resume`, and `outside-tail-update` on Claude, Cursor and Pi.** Status: open (depends on 7568: approval for the billed turns).

### 1. Record real traffic for the priority scenarios

**Problem.** The original corpus used hand-written fixtures. Most scenarios needed captured traffic to check the shapes providers emit in practice.

**Context.** Each of the four bridges carries an opt-in recorder (`@orkestrator/protocol/node/provider-replay-recorder`, switched on by `ORKESTRATOR_PROVIDER_RECORD_DIR` plus `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1`) that writes the fixture format directly. Local bridges inherit the backend's environment, so a local fixture environment in a `dev:test` profile records; a container's bridge does not receive the variables. The README's "Recording real traffic" section is the procedure.

**Investigation.** The first pass (2026-11-19) added `basic-turn` captures for Claude, Cursor and Pi and `interruption` captures for Cursor and Pi. The second pass (2026-11-22, one-time billing permission, about nine billed turns) recorded in an isolated `dev:test` profile with local fixture environments, one of them under an `ask` execution policy:

| Bridge | Scenario | Fixture |
| --- | --- | --- |
| Claude (CLI 2.1.326, SDK 0.3.326) | `approval-denial` | `bridges/claude-bridge/src/testing/provider-replay/approval-denial-recorded.jsonl` |
| Claude | `interruption` | `interruption-recorded.jsonl` (a foreground command stopped while it ran) |
| Claude | `late-background-output` | `late-background-output-recorded.jsonl` (a background Bash command) |
| Pi (SDK 1.5.2) | `approval-denial` | `bridges/pi-bridge/src/testing/provider-replay/approval-denial-recorded.jsonl` |
| Pi | `resume` | `resume-recorded.jsonl` (a turn, a profile restart, a turn) |
| Cursor (SDK 1.4.1) | `resume` | `bridges/cursor-bridge/src/testing/provider-replay/resume-recorded.jsonl` |

Cursor has no `approval-denial` (no approval callback, `capabilities.ts`). Grok was not signed in on the host ("Grok Build isn't signed in"), so it has no captures (task 3). Every recording was scrubbed, normalised (workspace paths, Claude's init inventory and Pi's MCP tool schemas removed) and read before commit. Each expectation matches its synthetic counterpart in rows, tool states, pending interactions and completion. The real traffic showed these differences:

- **Claude results name their prompt.** A real `result` carries `user_message_uuid(s)` and `result_index`, and the bridge treats a success that names another input as not this turn's (`resultAnswersOtherInput`). The replay could not settle a recorded turn until the adapter gained a `"$prompt"` placeholder for the client uuid of the latest prompt the bridge wrote. The same result also records the prompt row's SDK uuid (`recordPromptSdkUuid`) and republishes it, so the prompt row reaches readers as revised outside the live tail (`revisedOutsideTail: [0]`). No synthetic fixture exercised either.
- **The user's Claude stop was not what the replay drove.** The backend's stop is `POST /abort` (`gracefulInterruptClaudeSession`, the SDK's `interrupt()`), after which the CLI sends `task_notification` (stopped), the rejected tool result, `[Request interrupted by user for tool use]` and an `error_during_execution` result (`terminal_reason: aborted_tools`). The adapter's `interrupt` called `abortSession` (`/hard-abort`), which delivers nothing after it. The adapter now takes `"graceful": true` for a captured stop; the recorded fixture ends idle, the tool card failed and the "Interrupted by user" row present, the same as the synthetic one. A stop that lands while the model is thinking gives `terminal_reason: aborted_streaming` instead (seen live, not committed). The first pass's live stop that "ended with an execution error" most likely saw this same normal result.
- **Pi starts the tool before its approval hook.** Real Pi emits `tool_execution_start` before the `tool_call` hook that parks the call; the synthetic fixture has it after the denial. The bridge shows the card pending while parked and failed after the denial either way. Real Pi also emits `agent_start`, `turn_start` and `agent_end`, which the bridge counts as unrendered drift, and a system message and `session_info_changed` the synthetic fixtures lack.
- **The Claude CLI refuses a bare `sleep N`** as a foreground command, so an interruption capture needs another long command (`perl -e 'sleep 25'`).
- **`--strip-content` changes some scenarios.** Pi and Cursor render no row for empty text, so their fixtures keep the short replies to these harmless prompts. Claude offers a command card only with its command, so the approval fixture keeps `rm -rf build`. Claude recognises its interruption marker by its text, so that marker is kept. The README now says so.

**Decisions.**

- **Which recordings first?**
  - **One per scenario the provider can produce, `approval-denial` and `interruption` first (recommended, implemented).**
    - Pros: those are the sequences where pending interactions and completion semantics differ most between providers; one recording each is enough to compare against the synthetic fixture.
    - Cons: billed turns on four providers.
  - **Only on the next pin bump of each provider.**
    - Pros: no extra turns now.
    - Cons: the first real recording then arrives together with a protocol change, so a difference cannot be told apart from the bump.
- **Strip prose from recordings?**
  - **Run the scrubber with `--strip-content` unless the scenario depends on the text (recommended, implemented).**
    - Pros: removes known prompt, file and tool payload fields before manual review.
    - Cons: excerpts in the expectations become empty, so prose assembly is pinned by length only; Pi and Cursor lose their rows entirely, so their fixtures keep text.
  - **Keep prose and scrub identity and secrets only.**
    - Pros: expectations stay readable.
    - Cons: relies on reading every diff for content the scrubber cannot recognise.
- **How should the Claude replay stop a recorded turn?**
  - **Add `"graceful": true`, which takes the user's `/abort` path through an `interrupt()` control on the query double (recommended, implemented).**
    - Pros: replays the frames the CLI really sends after a stop through the production route; the synthetic fixture keeps covering `/hard-abort`.
    - Cons: one more adapter option to know about.
  - **Keep `abortSession` and cut recordings at the stop.**
    - Pros: no adapter change.
    - Cons: the captured post-stop frames would be committed but never replayed, so a change in how the bridge handles them would go unseen.

### 2. Settle started tool cards on interrupt (Claude, Pi)

**Problem.** The synthetic `interruption` fixtures showed tool cards staying `pending` after Claude and Pi returned idle. Cursor settles it as failed (`settleAbandonedToolParts`), and ACP marks it failed when `session/prompt` returns `cancelled`.

**Context.** Pinned in `bridges/claude-bridge/src/testing/provider-replay/interruption.expected.json` and `bridges/pi-bridge/src/testing/provider-replay/interruption.expected.json`. Both synthetic fixtures end at the interrupt with a tool result still outstanding.

**Investigation.** The revised expectations show the tool card pending mid-turn and failed after interruption. Claude applies the same settlement when reading a persisted interrupt marker. The recorded Claude stop (task 1) ends with the card failed too.

**Decisions.**

- **What should the bridge do with an interrupted tool card?**
  - **Settle open tool parts as failed with a fixed note when the turn ends interrupted, as Cursor does (recommended).**
    - Pros: one behaviour across bridges; the transcript stops claiming work is running on an idle session.
    - Cons: a background command that genuinely survives the interrupt would read as failed.
  - **Leave them pending and let the renderer mark tools on an idle session as left running.**
    - Pros: no bridge change.
    - Cons: every renderer path has to know; the transcript itself still says pending.

### 3. Record Grok (ACP) traffic

**Problem.** The ACP bridge's corpus is synthetic only.

**Context.** The ACP recorder writes one file per agent process and records the agent's own `initialize` version. The 2026-11-19 run found the profile's Grok credential expired; the 2026-11-22 run found Grok signed out ("Grok Build isn't signed in"). Agents do not sign in or out of real logins, so the sign-in is a checklist item (7568).

**Investigation.** Not started. Once Grok is signed in, the same procedure applies: `basic-turn`, `approval-denial` (an environment under the `ask` policy) and `interruption` cost one or two short turns each. For ACP, omit side-effecting client requests, keep the prompt response and add a `settle` step (README step 2).

**Decisions.**

- **Which Grok scenarios?**
  - **`basic-turn`, `approval-denial` and `interruption`, one capture each (recommended).**
    - Pros: covers the permission prompt and cancellation, where ACP differs most from the other bridges.
    - Cons: billed turns.
  - **`basic-turn` only.**
    - Pros: cheapest.
    - Cons: leaves the approval and cancellation shapes synthetic.

### 4. Record the scenarios still synthetic only

**Problem.** After task 1, these supported scenarios have no real capture: Claude `resume`, and `outside-tail-update` on Claude, Cursor and Pi.

**Context.** `session-rekey` (Claude) happens only when the CLI answers under another session id, which cannot be produced on demand, and `malformed-events` is synthetic by nature; neither is in this task. Claude's `resume` fixture starts with the persisted rollout the successor reads (`getSessionMessages`), which the recorder does not capture: the rollout frames come from the CLI's own session file under the profile's Claude config directory. `outside-tail-update` needs a transcript longer than the live tail, so it costs several turns.

**Investigation.** Not started.

**Decisions.**

- **How to build the Claude `resume` recording?**
  - **Record one turn, read that session's rollout file from the profile, scrub it into the fixture's leading frames, then record the resumed turn (recommended).**
    - Pros: both halves are real; only the rollout read is assembled by hand.
    - Cons: the rollout lines need their own scrub and review, as they hold the conversation verbatim.
  - **Keep `resume` synthetic on Claude.**
    - Pros: no billed turns.
    - Cons: the rollout shape a successor reads stays unchecked against a real CLI.

## Assumptions and decisions

### Task 1. Keep the recorded checkpoints alongside synthetic scenarios

Use a disposable fixture project and retain the provider events relevant to each scenario, with workspace and session metadata removed. Recorded fixtures are named `<scenario>-recorded.jsonl` and supplement the synthetic cases.

### Task 1. Keep whole captures rather than excerpts (2026-11-22)

The second pass commits each capture whole (every frame the bridge consumed) instead of the two or three frames the first pass kept, so that frames the synthetic fixtures do not model (Claude's `command_lifecycle`, `status` and `thinking_tokens`; Pi's system message and lifecycle events) are replayed too. Only inventory was dropped: Claude's init lists of tools, skills, plugins and paths, and the Orkestrator MCP tool schemas in Pi's system message.

### Task 1. Adapter changes for real Claude traffic (2026-11-22)

The Claude adapter gained `"$prompt"` and `interrupt` `"graceful": true` (see task 1's Decisions). Both are documented in the adapter's header comment and the README.

### Task 2. Settle interrupted tools at the bridge boundary

Mark pending tool invocations in the interrupted turn failed with a fixed message. The transcript keeps existing output and uses the same tool state when it is read again.

## Constraints and rationale

- A recording holds prompts, file contents and absolute paths until scrubbed; never commit one unread.
- A changed expectation is reviewed, not regenerated blindly (`bridges/AGENTS.md`, "Recorded provider traffic").
- Recording needs billed turns and real logins, which only the user can approve or sign in; tasks 3 and 4 wait on items in the manual-test checklist.

## Related

- [Provider-traffic replay](../../../tests/conformance/provider-replay/README.md)
- [Upgrading agent SDKs and binaries](../../development/upgrade-agents.md#replay-recorded-provider-traffic)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md) (8313 tasks 3 and 4)
