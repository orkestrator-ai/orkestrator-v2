# A Codex command left running at the end of its turn reads "running..." for good

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`, while running
[0049](0049-native-agent-idle-observation.md) task 3 (the Codex background
shell) with a loopback fake model on beelink.

### Tasks

1. **Settle the card of a command that outlives its turn**: once a Codex turn has ended, a command whose `exec_command` yielded while it was still running must not keep reading "running..." on an idle thread. Status: open.

### 1. Settle the card of a command that outlives its turn

**Problem.** When Codex starts a command that is still running when its
`exec_command` call yields (a dev server, a watcher, a long build: anything
the model does not wait for), and the turn then ends, the command's card
keeps `toolState: "pending"`, which the transcript renders as
"running...". It stays that way after the command has exited: nothing ever
settles it. The thread is idle (no Stop button, sidebar idle, backend
`idle`), so the card contradicts the rest of the view and claims a process
is running that may long be gone.

**Context.** Loopback-model run, beelink, 2026-11-06, profile
`idleqa-0049-r2`, pinned Codex 0.166.0, run `idleqa-0049-r2-codex-dev`. The
scripted model ran `exec` with
`tools.exec_command({"cmd":"sleep 20; echo <marker>","yield_time_ms":1000})`;
the call returned after 1 s with a `session_id` and no exit code, and the
model ended the turn with its reply. The live spec's `background` case read
the fresh tool calls when the turn settled (`bash:pending`) and again 30 s
after dispatch, 9 s after the command had exited (`bash:pending`, no marker in
any tool result).

**Investigation.** The card is the app-server `commandExecution` item, which
`commandExecutionParts` (`bridges/codex-bridge/src/messages/normalization.ts`)
maps to `pending` unless its status is `completed` or `failed`. Codex never
sends that status: its own log (`logs_2.sqlite` in the profile's Codex home)
shows `item/started` and `item/completed` for the `exec` cell, then
`turn/completed`, and no app-server event of any kind for the command after
the turn ended, through and past the moment it exited. The rollout holds no
exec end either. So no notification is being dropped by the bridge; Codex
leaves an unpolled unified-exec process unreported, and the bridge renders
the last state it was given. Claude handles the same request as a
background task with its own lifecycle (0049 task 2), so only Codex is
affected. Not checked: whether a later turn that polls the session
(`write_stdin`) or a bridge restart (rehydration from the rollout) changes the
card.

**Decisions.**

- **What should the card say once the turn has ended?**
  - **Render a command still `inProgress` in a terminal turn as settled-unknown ("left running" with no spinner), never "running..." (recommended).**
    - Pros: stops the contradiction with the idle thread; needs no signal
      Codex does not give; a later `item/completed` (if a poll produces one)
      can still update it.
    - Cons: the card no longer says the process may still be alive; needs a
      tool state (or a flag on the part) the renderer understands.
  - **Leave it, and document that Codex does not report background exits.**
    - Pros: no code.
    - Cons: every backgrounded Codex command shows a spinner for ever.
  - **Poll the unified-exec session from the bridge until it exits.**
    - Pros: a true end state and its output.
    - Cons: app-server has no client method for it outside a turn; would
      mean running turns the user never asked for.
- **Where should the fix live?**
  - **In the Codex bridge's rendering of a terminal turn (`render-turn.ts`), so every reader gets the same row (recommended).**
    - Pros: one place; the row the backend and every client read is right.
    - Cons: touches the row-revision path (a frozen row must be published
      again when its turn ends).
  - **In the renderer only.**
    - Pros: small.
    - Cons: the projection, CLI and other readers keep the stale state.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md)
  task 3, which found this.
- [5040-revision-token-spec-background-output.md](5040-revision-token-spec-background-output.md):
  background command output on Claude.

## Replaces

- Number 7520, renumbered on 2026-11-06. Three pull requests merged a 7520 the same day; the earliest to merge, 7520 (#1957), kept it; that to-do was done and deleted on 2026-11-09.
