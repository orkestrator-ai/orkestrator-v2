# A Codex turn refused for its login leaves no visible error or sign-in prompt

Checked against `main` at `93018933` (2026-10-26), on branch
`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`. Both code items done on
2026-10-27 (branch `todo-0235-codex-refused-login-turn-daa0f536ee31`, base
`863b5782`). Reworked on 2026-10-29 (branch
`todo-0235-codex-refused-login-2b095027e71e`, base `79f3bc97`): the notice now
names the refused login, a six-platform reload test was added, the refresh
failure shape was read from the 0.164.0 binary, and a live run proved that
replacing the key clears the banner. Only a person approving a real ChatGPT
sign-in is left.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Render a failed turn's terminal error row**: code item 1, find why the projection's `native-terminal:error:` row is not shown, fix it, test it after a reload, and check the other providers. Status: done (2026-10-27; six-platform reload test 2026-10-29).
2. **Raise the `auth` notice for a refused Codex login**: code item 2, keep `httpStatusCode` and set `needs-auth` on a 401. Status: done (2026-10-27).
3. **Which sign-in a 401 on an API key offers**: the open question. Status: done (2026-10-29: the notice names the login; an API key is pointed at `codex login --with-api-key` and still offered the ChatGPT sign-in).
4. **ChatGPT refresh failure shape**: the "Needs verification" item, whether a failed ChatGPT refresh also ends as `httpConnectionFailed`/401 with no `authRecovery*` on 0.164. Status: done from the 0.164.0 binary and the protocol (medium confidence); the exact `codexErrorInfo` of the final failure is left under Needs verification until it is seen live.
5. **Live qualification**: a made-up key in a `dev:test` profile, then reload, sign in and confirm the banner clears. Status: open. The error row, the banner after a reload, and the banner clearing after the key is replaced all passed live (2026-10-29). Clearing after a ChatGPT sign-in needs a person to approve it.

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

- **The notice names the refused login (item 3, 2026-10-29).** The engine
  keeps the login kind from every signed-in `account/read`
  (`getAccountLoginKind`) and emits `account.loginKind` when it changes. A
  refused turn raises "Codex's API key was refused. Replace it with codex
  login --with-api-key, or sign in to Codex with ChatGPT instead." for an API
  key, "Codex's ChatGPT login was refused. Sign in to Codex again to keep
  working." for a ChatGPT login, and the generic wording before any answer.
  The refusal's own `account/read` usually answers after the turn has failed,
  so `account.loginKind` rewords a notice already shown, keeping its
  occurrence (`withRefusedLoginKind`). The banner still offers **Sign in to
  Codex**, which is the ChatGPT sign-in.
- **Cross-provider render test (item 1, 2026-10-29).**
  `AgentNativeTab.progressive.test.tsx` renders a failed turn for Claude,
  Codex, Cursor, Grok, OpenCode and Pi, on first load and after a reload, and
  checks the reason shows exactly once (OpenCode's from its own inline row).
- **What a failed ChatGPT refresh looks like (item 4).** Read from the 0.164.0
  binary and the generated protocol; not seen live. Medium confidence.
  - A ChatGPT login has recovery steps; an API key has none. The binary
  carries `No more recovery steps available.`, the refresh reason
  `unauthorized_recovery` (beside `scheduled` and `forced`), and
  `AuthRecoveryStarted`/`AuthRecoveryCompleted` with outcomes
  `recovery_succeeded`, `recovery_failed_permanent` and
  `recovery_failed_transient`. So a 401 on a ChatGPT login starts Codex's
  recovery (reload `auth.json`, then refresh) and sends
  `modelProvider/authRecoveryStarted` and `…Completed`. An API key cannot
  recover and fails the turn straight away, which is what the 2026-10-26 and
  2026-10-29 live runs showed.
  - When the refresh is refused, the turn ends with `CodexErr::RefreshTokenFailed`
  (in the binary's error list) and one of its messages, for example "Your
  access token could not be refreshed because your refresh token was already
  used. Please log out and sign in again." `authRecoveryCompleted` carries a
  message too, and `RENEWAL_FAILED` matches both ("could not", "log out … again").
  - Covered either way. A failed completion keeps a `needs-auth` notice
  (`nextThreadAuthNotice`). A turn failed with `unauthorized`, or with a 401
  on any status-carrying variant, raises the refused-login notice, now worded
  for ChatGPT. A transient refresh failure with no 401 locks nothing.
  - Not established: which `codexErrorInfo` the final turn failure carries. It
  is probably `unauthorized` (the generated enum has it, and nothing else
  fits `RefreshTokenFailed`), but the binary's strings cannot show the mapping.
- **Live, 2026-10-29.** Profile `qa-0235b` (`dev:test`, Codex 0.164.0, seeded
  from a throwaway `CODEX_HOME` holding a made-up `sk-proj-…` key). The turn
  failed in under a second with `invalid_api_key`. After a reload the tab
  showed the error row and the banner, worded for the API key. The spec then
  wrote a second made-up key into the profile's own
  `agent-credentials/codex/auth.json`, as `codex login --with-api-key` stores
  it, and reloaded. The `auth` notice left the projection and the banner was
  gone, with no sign-in (`ORKESTRATOR_AGENT_TEST_PROFILE_CODEX_HOME` in
  `codex-refused-login-live.spec.ts`).
- **Seen in passing.** The failed turn raised the "Agent finished: The agent
  completed its work." toast. Unread reasons have no failure case; see
  [0940](../cross-cutting/0940-failed-turn-reads-as-completed.md).

## Outstanding work

### Qualification

- In the same kind of profile, sign in from the banner and confirm the banner
  clears. That needs a person to approve a ChatGPT sign-in. Replacing the key
  in `CODEX_HOME` was proved live on 2026-10-29. The sign-in path
  (`account/login/completed` with `success: true`) and a completed turn are
  proved by bridge tests only.

## Assumptions and decisions

Choices made on 2026-10-27 (first pass) are kept below. Their task numbers
are this file's Tasks list.

### Task 1: where the progressive path gets the rows (2026-10-27)

Options: (a) append them to the progressive transcript read; (b) carry them on
the progressive state view and place them after the transcript in the web; (c)
have the web build rows from `turn.error`. Chose (b), which is the recommended
option's aim (the rows are part of what the tab renders, live and after a
reload) on the read the tab actually uses. The transcript read never reads
session state (adding that read costs a second bridge call per poll), and its
tokens, deltas and persisted restart preview would then hold a transient state
row. (c) would duplicate the backend's ids and miss notices. Pros: one
builder, the state token already moves when the error changes, the
transcript view stays the provider's rows. Cons: a new optional field on the
state view and the projection, and the web must carry it across transcript
reads (done in `applyProgressiveTranscript`).

### Task 1: duplicate failures (2026-10-27)

Options: show both the Codex/Pi status line and the terminal row; drop the
terminal row for Codex and Pi wholesale; drop it only when the last row's
error status line states the same failure. Chose the last, in a shared helper
both paths use. Dropping it per platform would hide the bridge's own failures
that have no status line (a restart mid-turn, a rejected structured result).
The match is "the error contains the status text", minus a trailing ellipsis,
so a bounded or JSON-reduced line still matches; a stop row is never dropped
this way.

### Task 1: kept stop results stay off the state view (2026-10-27)

`recordStopNotice` is consumed by the full projection the stop mutation
answers with; putting it on the state view without consuming it would leave a
stale "stopped" row on a tab that never makes a full read. Provider `stopped`
notices (OpenCode) do travel.

### Task 1: cross-provider check is a parametrised component test (2026-10-29)

Took the recommended option. The backend test already ran five bridge
platforms plus OpenCode through the state view. It did not render them. The
new web test renders all six, with a reload, and checks the reason appears
once. Live runs per provider were not needed for a renderer path shared by
all six.

### Task 2: which errors raise the notice (2026-10-27)

`unauthorized`, or `httpStatusCode === 401` on any variant that forwards one,
which adds `responseTooManyFailedAttempts` to the three the item named: a 401
there is the same refusal. Not 403, 5xx or a missing status, because the
notice locks the composer. The message text is never read: a "401" in prose
does not count. Kept as `httpStatusCode` on `EngineError` (the recommended
"keep it on the shared error" option, under the protocol's own name).

### Task 2: occurrence (2026-10-27)

A second refusal keeps the occurrence of a refused-login notice already shown,
so a dismissed toast stays dismissed; a renewal notice is replaced by a new
occurrence, because the state (and the composer lock) changes.

### Task 3: the notice names the login and offers both routes (2026-10-29)

Took the recommended option. The first pass chose the in-tab sign-in for
both kinds because "app-server reports no reliable 'this was an API key'
signal on the failed turn". That is true of the turn but not of the bridge.
`account/read` reports `account.type` (`apiKey` or `chatgpt`), and the bridge
already calls it on every refusal (`checkAccountSignIn(false, true)`). So the
code did not show the recommended option was wrong.

- **Where the key is set.** Orkestrator's Settings have no Codex API-key
  field: Codex sign-in there is device code. The key lives in
  `$CODEX_HOME/auth.json`, written by `codex login --with-api-key`, so the
  notice names that command. It is plain text: the banner renders the message
  as a paragraph.
- **The kind can arrive late.** The refusal's own `account/read` usually
  answers after the turn has failed. The engine emits `account.loginKind` when
  the kind changes, and the runtime rewords any refused-login notice in place,
  keeping its occurrence. A refusal while the kind is still unknown never
  overwrites a notice that already names it.
- **Does replacing the key clear the notice?** Yes. After a refusal the engine
  fingerprints the stored login. The next `account/read`, for example the
  banner's sign-in-options read on a reload, sees a different key, replaces
  the app-server child and emits `account.signedIn`, which clears every
  thread's notice. Bridge tests proved this
  (`app-server-runtime-account-reload.test.ts`), and so did the 2026-10-29
  live run.
- **Pros:** an API-key user is no longer pushed into switching account type
  without being told; a ChatGPT user still gets the one-click path.
- **Cons:** three messages instead of one, and a key from an environment
  variable (not `auth.json`) gets advice that does not apply. Orkestrator
  strips `OPENAI_API_KEY` and `CODEX_API_KEY` for added accounts, so that is
  only possible for the host login.

### Task 4: settled from the binary and the protocol, not staged (2026-10-29)

Took the recommended option: no staged refresh failure. I read the evidence
from the pinned 0.164.0 binary's strings (outcome names, refresh reasons,
`RefreshTokenFailed` and its messages, `No more recovery steps available.`)
and from the generated protocol. A ChatGPT refresh failure goes through
`authRecovery*` and is covered by the existing rule; task 2's 401 rule
catches any final 401. Confidence: medium. The strings show what exists, not
the order it runs in or which `codexErrorInfo` the final failure carries. The
offline probe (`scripts/codex-access-only-auth-probe.ts`) could stage it
without any real login if a definite answer is ever needed.

### Task 5: a live clearing path without a person (2026-10-29)

The recommended pass needs a successful sign-in, which needs a person (ChatGPT)
or a valid key, and the task allowed only made-up keys. I proved the clearing
path that needs neither: a second made-up key written to the profile's own
`CODEX_HOME`, as `codex login --with-api-key` stores it. I wrote the file
rather than running `codex login`, because a CLI on a credential-store
setting other than `file` could write to the macOS Keychain instead. The
in-tab ChatGPT sign-in stays open.

## Constraints and rationale

- The notice locks a Codex tab's composer, so it must only follow a refused
  login (401), never a network failure without a status or a 5xx.
- Never log or show the key: app-server already masks it in its message, and
  the bridge's output scrub (`bridge-output-redaction.ts`) applies to logs.

## Needs verification

- Which `codexErrorInfo` a turn carries when a ChatGPT refresh is refused
  (probably `unauthorized`; see Current state). Record it when one is seen
  live; no code depends on the answer.
- Settled 2026-10-29: storing a new key in `CODEX_HOME` clears the notice
  without `account/login/completed`, through the stored-login reload (live
  and bridge tests). Orkestrator's Settings have no Codex key field.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md#turn-time-auth-notice)
- [native-transcripts.md](../../architecture/native-transcripts.md#terminal-rows)
- [0940-failed-turn-reads-as-completed.md](../cross-cutting/0940-failed-turn-reads-as-completed.md)
