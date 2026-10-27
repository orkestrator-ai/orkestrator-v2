# A Codex turn refused for its login leaves no visible error or sign-in prompt

Checked against `main` at `93018933` (2026-10-26), on branch
`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Render a failed turn's terminal error row**: code item 1, find why the projection's `native-terminal:error:` row is not shown, fix it, test it after a reload, and check the other providers. Status: open.
2. **Raise the `auth` notice for a refused Codex login**: code item 2, keep `httpStatusCode` and set `needs-auth` on a 401. Status: open.
3. **Which sign-in a 401 on an API key offers**: the open question. Status: open.
4. **ChatGPT refresh failure shape**: the "Needs verification" item, whether a failed ChatGPT refresh also ends as `httpConnectionFailed`/401 with no `authRecovery*` on 0.164. Status: open.
5. **Live qualification**: a made-up key in a `dev:test` profile, then reload, sign in and confirm the banner clears. Status: open (depends on 1 and 2).

### 1. Render a failed turn's terminal error row

**Problem.** A failed turn's error is in the backend projection but not in the tab, before or after a reload. A user with a bad Codex key sees no answer and no error. The defect may reach other providers' failed turns too.

**Context.** Found during 0003's live qualification. AGENTS.md says the native tab renders from the backend's authoritative snapshot, so a row present in the projection should render.

**Investigation.** The row is built as the file says.
- `terminalNotices` become `native-terminal:<kind>:<hash>` system rows with a fixed `createdAt` of `1970-01-01T00:00:00.000Z` (`apps/backend/src/core/native-agent-transcript-projection.ts:5041-5064`). They are appended as `messagesWithNotices` (`:5066`) and returned in `projection.messages` (`:5254`).
- For the `sync-v1` representation the paging history is fed `normalized.messages`, without the terminal rows (`:5100-5122`). So any renderer path that builds from history or paged transcript summaries rather than `projection.messages` never sees them. This is the strongest lead.
- The fixed 1970 timestamp is a second lead if any renderer path orders or windows by time.
- The renderer knows the prefix only in `apps/web/src/lib/claude-auth.ts:8` (Claude sign-in detection), so the row is expected to arrive.
- The root cause was not confirmed in this pass.

**Decisions.**

- **Where should the terminal row live?**
  - **Make it part of the authoritative transcript the tab renders, so the sync-v1 live tail and history both include it (recommended).** Then add a component test that renders a failed turn after a reload.
    - Pros: fixes every provider at once; follows invariant 3 (live events are not the only source).
    - Cons: the row's id and time must be stable across reads, and paging must not duplicate it.
  - **Render terminal notices from `projection.turn.error` or the notices list, outside the transcript.**
    - Pros: no transcript-shape change.
    - Cons: a second rendering path; the error is not in its place in the conversation, and it is lost once a new turn starts.
- **How far does the cross-provider check go?**
  - **A parametrised component test over all six platforms' failed-turn snapshots (recommended).**
    - Pros: cheap once the fixture exists; answers "other providers too" for good.
    - Cons: needs a realistic snapshot per provider.
  - **Live-check each provider.**
    - Pros: real evidence.
    - Cons: six live runs for a renderer bug.

### 2. Raise the `auth` notice for a refused Codex login

**Problem.** app-server reports an invalid API key as signed in and sends no `modelProvider/authRecovery*`. The bridge only follows those notifications, so no sign-in prompt appears.

**Context.** The notice locks the composer, so it must follow only a 401, never a network failure without a status or a 5xx. The pinned app-server is 0.164.0 (`bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`).

**Investigation.**
- `toTurnError` (`bridges/codex-bridge/src/app-server/event-reducer.ts:71-81`) keeps only `codexErrorInfoToCode` (`bridges/codex-bridge/src/app-server/errors.ts:254-261`), which returns the single key, so `httpStatusCode` is dropped.
- The generated `CodexErrorInfo` carries `httpStatusCode: number | null` on `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected` and `responseTooManyFailedAttempts`, and has a bare `"unauthorized"` variant (`generated/typescript/v2/CodexErrorInfo.ts`).
- `nextThreadAuthNotice` (`bridges/codex-bridge/src/sessions/auth-recovery-notice.ts:22-46`) handles only `started` and `completed` recovery events. `CODEX_LOGIN_RENEWAL_FAILED_SUFFIX` ("Sign in to Codex again to keep working.") is at `:20` and can be reused.
- The file's variant list leaves out `responseTooManyFailedAttempts`, which also carries a status.

**Decisions.**

- **Which errors set `needs-auth`?**
  - **`unauthorized`, or any `codexErrorInfo` variant whose `httpStatusCode` is exactly 401, on a failed turn (recommended).**
    - Pros: covers every status-carrying variant, including the one the file missed; follows the constraint (401 only).
    - Cons: a 401 from a misconfigured custom provider would also lock the composer.
  - **Only the three variants the file names.**
    - Pros: narrow.
    - Cons: misses `responseTooManyFailedAttempts`, which is how the observed ten-retry failure could also be reported.
- **Where is the 401 kept?**
  - **Add an optional `httpStatus` to `EngineError` in `toTurnError`, and decide the notice where turn failure is finalised (recommended).**
    - Pros: the status is available to anything else that needs it later; one decision point.
    - Cons: touches a shared error type.
  - **Inspect the raw error only inside the notice logic.**
    - Pros: smallest change.
    - Cons: duplicates the parsing of `codexErrorInfo`.

### 3. Which sign-in a 401 on an API key offers

**Problem.** The in-tab sign-in replaces an API key with a ChatGPT login, which may not be what an API-key user wants.

**Context.** `docs/architecture/agent-accounts.md` ("Turn-time auth notice").

**Investigation.** The notice cannot tell which login kind was refused unless the bridge reads it from `account/read`, which already reports the account.

**Decisions.**

- **What does the notice offer?**
  - **Say which login was refused. For an API key, point to where the key is set and also offer the ChatGPT sign-in (recommended).**
    - Pros: an API-key user is not pushed into switching accounts; a ChatGPT user gets the one-click path.
    - Cons: needs the login kind in the notice and a second piece of wording.
  - **Always offer the in-tab ChatGPT sign-in.**
    - Pros: one path; already built.
    - Cons: silently changes an API-key user's account type.

### 4. ChatGPT refresh failure shape

**Problem.** It is not known whether a ChatGPT login whose refresh fails also ends with a 401 and no recovery notifications on 0.164.

**Context.** If it does, task 2's rule covers it. If Codex sends `authRecovery*`, the existing path already does.

**Investigation.** Nothing in the generated protocol distinguishes the two. It needs a live run with a revoked refresh token, which is awkward to stage.

**Decisions.**

- **How is it settled?**
  - **Let task 2's rule cover both cases and record the shape when it is next seen live, instead of staging it (recommended).**
    - Pros: the 401 rule is correct either way; no fragile set-up.
    - Cons: the item stays open until it is seen.
  - **Stage it with a throwaway `CODEX_HOME` and a corrupted refresh token.**
    - Pros: a definite answer.
    - Cons: may be refused differently from a genuinely expired login, so the evidence is weaker.

### 5. Live qualification

**Problem.** The fix needs to be seen with a real app-server refusing a made-up key.

**Context.** The file's procedure is already agreed (`qa-0003-usage`, `qa-0003-auth` reproduced it).

**Investigation.** A `dev:test` profile isolates the Codex home, so a made-up key does not touch the host login.

**Decisions.**

- **What counts as a pass?**
  - **The error row and the banner both visible after a reload, and the banner gone after a successful sign-in (recommended).**
    - Pros: matches both fixes and the rehydration invariant.
    - Cons: the sign-in half needs a valid credential in the profile.
  - **The error row only.**
    - Pros: no valid credential needed.
    - Cons: leaves the clearing path unproved.

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
