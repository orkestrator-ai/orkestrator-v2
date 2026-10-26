# A Codex turn refused for its login leaves no visible error or sign-in prompt

Checked against `main` at `93018933` (2026-10-26), on branch
`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`.

Found while qualifying
[0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md) on
mbp3. A Codex tab whose login the API refuses (an invalid API key, here)
shows the 401 only while the turn runs. Once the turn fails, the prompt has no
answer, no error row and no sign-in prompt, after a reload too.

## Current state

- Codex 0.162.1 app-server (and the 0.164.0 a `dev:test` profile runs) treats
  an invalid API key as signed in: `account/read` reports it, so readiness
  never locks. A turn retries ten times and then fails with
  `codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }` and the
  message "unexpected status 401 Unauthorized: Incorrect API key provided …".
  It sends no `modelProvider/authRecovery*`, so no `auth` notice is raised
  (`sessions/auth-recovery-notice.ts` only follows those). Captured with a
  throwaway `CODEX_HOME` and a made-up key on 2026-10-26.
- `toTurnError` (`bridges/codex-bridge/src/app-server/event-reducer.ts`) keeps
  only the error info's key (`httpConnectionFailed`), so the 401 status is
  lost before anything could act on it.
- The backend projection does carry the failure: `get_native_agent_projection`
  for the tab returned a `native-terminal:error:…` system row with the 401
  message after the turn (`native-agent-transcript-projection.ts`, where
  `terminalMessages` are appended). The tab did not render it, before or after
  a reload: the text was not in the DOM. The tab renders from the transcript
  update path, which appears not to include those rows. Whether other
  providers' terminal error rows are lost the same way is not known.
- Reproduced in profile `qa-0003-usage` (`dev:test`, Codex on an added account
  holding a made-up key, GPT-5.6-Luna) and earlier in `qa-0003-auth` with the
  key as the host login.

## Outstanding work

### Code

1. **Show a failed turn's error in the tab.** Find why the
   `native-terminal:error:` row the projection holds does not reach the
   rendered transcript, fix it, and add a browser or component test that
   renders a failed Codex turn's row after a reload. Check Claude, Cursor,
   Grok, Pi and OpenCode terminal errors on the same path.
2. **Raise the `auth` notice for a refused Codex login.** Keep
   `httpStatusCode` in `toTurnError`, and when a turn fails with
   `unauthorized` or a 401 (`httpConnectionFailed`,
   `responseStreamConnectionFailed`, `responseStreamDisconnected`), set the
   thread's notice (`needs-auth`, "Codex's login was refused. Sign in to Codex
   again to keep working."). The tab then offers the in-tab sign-in. A
   successful sign-in clears it (0003, 2026-10-26), and so does a completed
   turn.

### Qualification

- In a `dev:test` profile with a made-up Codex API key: send a prompt, wait
  for the failure, reload, and confirm the error row and the sign-in banner;
  sign in (or store a valid key) and confirm the banner clears.

## Constraints and rationale

- The notice locks a Codex tab's composer, so it must only follow a refused
  login (401), never a network failure without a status or a 5xx.
- Never log or show the key: app-server already masks it in its message, and
  the bridge's output scrub (`bridge-output-redaction.ts`) applies to logs.

## Open questions

- Should a 401 on an API-key login offer the ChatGPT sign-in, or point to
  where the key is set? The in-tab sign-in replaces the key with a ChatGPT
  login.

## Needs verification

- Whether a ChatGPT login whose refresh fails also ends with
  `httpConnectionFailed`/401 without `authRecovery*` on 0.164.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md#turn-time-auth-notice)
- [native-transcripts.md](../../architecture/native-transcripts.md)
