# Message rewind and Pi branch switching have no client surface

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`. Found while qualifying
fork and rewind for Codex and Pi on loopback models
([0006](0006-session-titles-and-history.md) task 6). The backend and the
bridges carry both actions end to end; nothing a user or a CLI can reach
invokes them.

### Tasks

1. **Offer message rewind in the transcript**: a "Rewind to here" action for Codex, Pi and Cursor, through the existing `rewind-messages` session action. Status: open.
2. **Make Pi's other branches reachable**: list a Pi session's abandoned branches with their entry ids, and offer `switch-branch` on them. Status: open (depends on 1).
3. **Reach both from the public CLI**: `session.rewind` (and `session.branch` for Pi) public actions. Status: open (depends on 1).

### 1. Offer message rewind in the transcript

**Problem.** `nativeAgentCapabilities` reports `actions.rewindMessages` for
Codex, Pi and Cursor, and the backend command
`perform_native_agent_session_action` performs `rewind-messages` on all three
(`apps/backend/src/core/http-bridge/provider.ts`). The renderer never sends
it: no component in `apps/web/src` names `rewind-messages` or
`rewindMessages`, and `git log -S` finds no commit that ever did. The only
in-place history action a user has is fork. The root rule "a history action
a provider lacks is a `false` capability bit; the renderer hides it" assumes
the opposite too: a `true` bit should be offered.

**Context.** The renderer already places one fork action per prompt and per
completed response (`buildMessageForkPlan` in
`apps/web/src/components/chat/message-fork.ts`, rendered by
`MessageForkAction.tsx`), with per-platform boundary rules in
`apps/web/src/components/native-agent/native-agent-fork.ts`. Rewind needs the
same placement. Each bridge has its own meaning for the id it is given:

- Codex (`rewindMessages` in `app-server-runtime-sessions.ts`) reverts the turn
  holding that message and every later turn; a message without a `turnId` is
  refused 409.
- Pi (`navigateSessionHistory` and `history-target.ts`) cuts before a prompt
  and after a response with its tool results.
- Cursor reverts to the run's `startCheckpointRef`.

**Investigation.** The loopback-model run on 2026-11-06
(`e2e/agent-testing/session-history-live.spec.ts`, recorded in 0006) drove
`rewind-messages` through the gateway on real Codex 0.166.0 and the real Pi
SDK 1.4.0 with the renderer's own prompt ids: both cut correctly, a bridge
reload kept the cut, and the next model call held only the kept turns. The
missing piece is only the renderer action and its confirmation.

**Decisions.**

- **Where to offer it?**
  - **On each prompt row, beside fork, as "Rewind to before this prompt",
    restoring the prompt into the composer (recommended).**
    - Pros: one rule for all three platforms (each bridge resolves a prompt
      id); matches Pi's own `navigateTree` (the prompt text comes back as a
      draft) and the fork-at-prompt flow users already know.
    - Cons: no way to keep a response and drop only what followed it.
  - **On prompts and responses.**
    - Pros: finer control.
    - Cons: Codex rewinds whole turns, so a response action there would
      behave differently from the label; three boundary rules to keep right.
- **Confirm before rewinding?**
  - **Yes, a dialog naming how many turns are dropped (recommended).**
    - Pros: Codex's revert cannot be undone from Orkestrator; Pi keeps the
      branch but nothing lists it yet (task 2).
    - Cons: one more click.
  - **No, with an Undo toast.**
    - Pros: quicker.
    - Cons: an undo exists only on Pi (branch switch), so the toast would
      promise something two platforms cannot do.

### 2. Make Pi's other branches reachable

**Problem.** `switch-branch` takes a Pi entry id, and no client surface lists
one. A live Pi row carries an id the bridge minted (Pi appends its entry only
after the bridge sees `message_end`), and a rewind replaces the rendered rows
with the kept branch, so the abandoned branch's ids are gone from every read.
The 2026-11-06 run could only switch back by reading the entry id out of Pi's
own session file; the same switch with the live row id the client held was
refused (409).

**Context.** Pi's `SessionManager.getTree()` and `getEntries()` return every
branch; the bridge serves only the active branch. The resume list's
`parentId`/`branchLabel` describe forked *files*, not branches inside one file.

**Investigation.** Not started beyond the run above.

**Decisions.**

- **How to expose branches?**
  - **A bridge route listing the active session's leaves (entry id, the
    prompt that starts the branch, entry count, time), shown as a branch
    picker in the tab (recommended).**
    - Pros: bounded (leaves only); uses Pi's own tree; no change to the row
      contract.
    - Cons: a new route on one bridge and a new picker.
  - **Give live rows Pi entry ids.**
    - Pros: any id a client holds would stay valid.
    - Cons: the id is known only after the row is rendered, so a row would
      change id mid-turn, which breaks the transcript's row identity
      (`bridges/AGENTS.md`, "Transcript rows").

### 3. Reach both from the public CLI

**Problem.** The public API has `session.fork` but no rewind or branch action
(`apps/backend/src/core/public-api/actions-session-controls.ts`), so the
loopback qualification had to drive rewind through the gateway's raw
`/__orkestrator/invoke` command.

**Context.** Public mutations admit before acting and are idempotent per
request key ([public-cli.md](../../architecture/public-cli.md)).

**Investigation.** Not started.

**Decisions.**

- **Add them?**
  - **Yes, `session.rewind --message ID`, gated on `rewindMessages`
    (recommended), after task 1 settles the id rules.**
    - Pros: scriptable qualification and agent use without the gateway.
    - Cons: a public contract to keep stable.
  - **No.**
    - Pros: nothing to maintain.
    - Cons: CLI-driven tests keep needing the raw gateway.

## Related

- [0006-session-titles-and-history.md](0006-session-titles-and-history.md)
  task 6 (the run that found this).
- `bridges/pi-bridge/AGENTS.md`, "Fork, rewind and branch targets".
