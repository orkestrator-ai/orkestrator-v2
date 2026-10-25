# OpenCode undo leaves the reverted turn in the transcript

Checked against `main` at `00a0cb82` (2026-10-25).

Found by the live OpenCode spec run recorded in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
("Live OpenCode spec evidence"). Agent Info's **Undo turn** on an OpenCode
tab shows "Session reverted", but the reverted prompt and reply stay in the
transcript, in the backend projection as well as on screen.

## Current state

- Undo calls `client.session.revert({ sessionID, messageID })` with the last
  user message's id (`opencode-provider.ts`, the `undo` branch of the session
  action handler); redo calls `session.unrevert`.
- OpenCode 1.19 does not delete reverted messages. It records
  `Session.revert = { messageID, snapshot, diff }` and keeps every message
  until the next prompt, which then drops the reverted ones. Its own TUI hides
  messages from `revert.messageID` onward.
- Nothing in the backend reads `Session.revert`. `readOpenCodeMessages` and
  `openCodeTranscriptSnapshot` (`opencode-snapshots.ts`) serve
  `session.messages` as is, so the projection keeps the reverted turn until
  the next prompt.
- Live evidence, 2026-10-25, macOS 27.0 arm64, OpenCode 1.19.0, models
  `opencode-go/gpt-5.6-luna` (connected default) and
  `opencode-go/deepseek-v4.1-flash`: after Undo, OpenCode's session row held
  `revert.messageID` equal to the second user message (read from the
  profile's own `opencode.db`), and the projection still contained the
  second reply 30 s later. Redo then worked.
- `e2e/agent-testing/opencode-live.spec.ts` asserts that the reverted reply
  leaves the projection and the screen, so its native-tab case fails at that
  step until this is fixed.

## Outstanding work

### Code

1. **Hide reverted messages while `Session.revert` is set.** Read the
   session's `revert` marker with the transcript (from `session.get`, and
   from `session.updated` events in the stream cache), and drop messages from
   `revert.messageID` onward in the snapshot, history pages and revised rows.
   Unrevert, or the next prompt, must bring the transcript back to
   OpenCode's messages. Respect the transport invariants: the marker change
   must move the source token or history epoch so that a cached snapshot
   and named page cursors are not served stale.
2. **Backend test** over a fake OpenCode server: revert hides the turn in the
   snapshot and in a paged read, unrevert restores it, and a following
   prompt (where OpenCode deletes the messages) leaves no gap.

### Qualification

- Re-run `e2e/agent-testing/opencode-live.spec.ts` (procedure in
  [`agent-testing.md`](../../development/agent-testing.md)); the native-tab
  case must pass the undo step.

## Constraints and rationale

- Do not delete anything in OpenCode to make the transcript look right; the
  revert must stay undoable.
- `Session.revert.partID` can name a part inside a message. Decide whether a
  partial revert hides the rest of that message or the whole message, and
  test it.

## Open questions

- Should the composer show that a revert is pending (as OpenCode's TUI does),
  so the user knows the next prompt discards the reverted turn?

## Needs verification

- Whether `session.updated` carries the `revert` field in 1.19, or the
  marker has to be read with `session.get` after the action.

## Related

- [0006-session-titles-and-history.md](0006-session-titles-and-history.md)
  (fork, rewind and revert semantics per provider)
- [0008-opencode-v2.md](0008-opencode-v2.md) (staged revert in OpenCode 2)
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)

## Replaces

- Nothing; new from the 2026-10-25 live run.
