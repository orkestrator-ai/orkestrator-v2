# A Codex turn refused for its login leaves no visible error or sign-in prompt

Checked against `main` at `93018933` (2026-10-26), on branch
`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`. Both code items done on
2026-10-27 (branch `todo-0235-codex-refused-login-turn-daa0f536ee31`, base
`863b5782`), and the live check passed up to the sign-in itself.

Found while qualifying
[0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md) on
mbp3. A Codex tab whose login the API refuses (an invalid API key, here)
showed the 401 only while the turn ran. Once the turn failed, the prompt had
no answer, no error row and no sign-in prompt, after a reload too.

## Current state

- Codex 0.162.1 app-server (and the 0.164.0 a `dev:test` profile runs) treats
  an invalid API key as signed in: `account/read` reports it, so readiness
  never locks. A turn fails with
  `codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }` and the
  message "unexpected status 401 Unauthorized: Incorrect API key provided …".
  It sends no `modelProvider/authRecovery*`.
- **Why the row never rendered (item 1).** The tab reads the progressive
  views (`progressiveViewVersions: [1]` is the default). Their transcript read
  (`readProgressiveTranscript`) returns only the provider's rows, and their
  state read dropped `error`/`stopped` notices (`visibleProjectionNotices`)
  and kept the turn error only as `turn.error`, which the tab shows only on a
  connection failure. The `native-terminal:` rows were built only by the full
  projection (`get_native_agent_projection`), which the tab no longer reads.
  So every bridge platform (Claude, Codex, Cursor, Grok, Pi) lost a failed
  turn's terminal row; Claude also lost its sign-in card on a terminal auth
  error row. OpenCode's inline error row was unaffected.
- **Fix.** `nativeTerminalMessages` (`apps/backend/src/core/native-terminal-messages.ts`)
  builds the rows for both reads; the progressive state view carries them as
  `terminalMessages`, the web keeps them on the projection (`applyProgressiveState`,
  carried across transcript reads) and the controller shows them after the
  transcript. Both paths place them with `withNativeTerminalMessages`
  (`packages/protocol/src/native-terminal-rows.ts`), which also drops an error
  the last row already states: OpenCode's inline row, and the error `status`
  line Codex and Pi have put on a failed turn's last row since `08bd63c9`
  (2026-10-26). The full projection used to show such a Codex failure twice.
- **Notice (item 2).** `toTurnError` keeps the forwarded `httpStatusCode`, and
  a turn failed with `unauthorized` or a 401 raises the thread's `needs-auth`
  notice "Codex's login was refused. Sign in to Codex again to keep working."
  (`refusedLoginNotice`, `sessions/auth-recovery-notice.ts`). A sign-in or a
  completed turn clears it, as for the renewal notice.
- **Live, 2026-10-27.** Profile `qa-0235` (`dev:test`, Codex 0.164.0 seeded
  from a throwaway `CODEX_HOME` holding a made-up `sk-proj-…` key,
  GPT-6.1-Sol): one prompt failed with the 401 (`auth error code:
  invalid_api_key`, key masked by OpenAI). The tab showed the reason once, as
  the turn's error line, and the banner with **Sign in to Codex**; after
  `page.reload()` both were still there. (The composer lock itself was not
  asserted in the run.)
  `e2e/agent-testing/codex-refused-login-live.spec.ts` (opt-in,
  [agent-testing.md](../../development/agent-testing.md#codex-refused-login-qualification))
  passed. The turn failed in under a second here rather than after ten
  retries.

## Outstanding work

### Qualification

- In the same kind of profile, sign in from the banner (or store a valid key
  through Settings) and confirm the banner clears. The clearing paths are
  proved only by bridge tests (`account/login/completed` with `success: true`,
  and a completed turn): approving a ChatGPT sign-in needs a person, and no
  valid key was used.

## Assumptions and decisions

- **Where the progressive path gets the rows (item 1).** Options: (a) append
  them to the progressive transcript read; (b) carry them on the progressive
  state view and place them after the transcript in the web; (c) have the web
  build rows from `turn.error`. Chose (b). The transcript read never reads
  session state (adding that read costs a second bridge call per poll), and
  its tokens, deltas and persisted restart preview would then hold a
  transient state row. (c) would duplicate the backend's ids and miss notices.
  Pros: one builder, the state token already moves when the error changes, the
  transcript view stays the provider's rows. Cons: a new optional field on the
  state view and the projection, and the web must carry it across transcript
  reads (done in `applyProgressiveTranscript`).
- **Duplicate failures.** Options: show both the Codex/Pi status line and the
  terminal row; drop the terminal row for Codex and Pi wholesale; drop it only
  when the last row's error status line states the same failure. Chose the
  last, in a shared helper both paths use. Dropping it per platform would hide
  the bridge's own failures that have no status line (a restart mid-turn, a
  rejected structured result). The match is "the error contains the status
  text", minus a trailing ellipsis, so a bounded or JSON-reduced line still
  matches; a stop row is never dropped this way.
- **Kept stop results stay off the state view.** `recordStopNotice` is consumed
  by the full projection the stop mutation answers with; putting it on the
  state view without consuming it would leave a stale "stopped" row on a tab
  that never makes a full read. Provider `stopped` notices (OpenCode) do travel.
- **Which errors raise the notice (item 2).** `unauthorized`, or
  `httpStatusCode === 401` on any variant that forwards one, which adds
  `responseTooManyFailedAttempts` to the three the item named: a 401 there is
  the same refusal. Not 403, 5xx or a missing status, because the notice locks
  the composer. The message text is never read: a "401" in prose does not
  count.
- **Occurrence.** A second refusal keeps the occurrence of a refused-login
  notice already shown, so a dismissed toast stays dismissed; a renewal notice
  is replaced by a new occurrence, because the state (and the composer lock)
  changes.
- **Open question decided: what a 401 on an API-key login offers.** Options:
  the in-tab ChatGPT sign-in; a pointer to where the key is set; both. Chose
  the in-tab sign-in with the message the item prescribed, for both login
  kinds. It is the one route that works in every environment and clears the
  notice (`account/login/completed`), and app-server reports no reliable
  "this was an API key" signal on the failed turn. Con: a user who wants to
  keep using a key must replace it in Settings; whether that clears a live
  thread's notice without a sign-in is under Needs verification.

## Constraints and rationale

- The notice locks a Codex tab's composer, so it must only follow a refused
  login (401), never a network failure without a status or a 5xx.
- Never log or show the key: app-server already masks it in its message, and
  the bridge's output scrub (`bridge-output-redaction.ts`) applies to logs.

## Needs verification

- Whether a ChatGPT login whose refresh fails also ends with
  `httpConnectionFailed`/401 without `authRecovery*` on 0.164.
- Whether storing a valid key through Settings (rather than signing in from
  the tab) emits `account/login/completed` to a running bridge and so clears a
  thread's notice; if not, the locked tab's only way out is the in-tab sign-in.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md#turn-time-auth-notice)
- [native-transcripts.md](../../architecture/native-transcripts.md#terminal-rows)
