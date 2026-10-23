# Session lifecycle consistency

Checked against `main` at `06297124` (2026-10-23).

The native bridges share one lifecycle contract. Acknowledgements are durable.
State is published before any side effect. A permanent close fences late work.
Cancellation works before a prompt is accepted. Recovery state is bounded. And
closing a tab keeps the conversation. #853 landed the code and the
deterministic tests for all of it. Close retention through the UI is a
permanent browser spec for Cursor, Pi, OpenCode and Grok, and since
2026-10-23 so are the lifecycle faults that spec could not reach before:
persistence shedding, steer saturation, a dead generation, an old Claude
bridge and a stop during Pi's startup. What is left is the live Cursor and Pi
run, the legacy close fallback (blocked on a support window) and one live
check of Cursor's resume rows.

## Current state

- **Retention is decided.** Closing a tab retains the conversation on every
  platform. This is policy in AGENTS.md ("Tab close and conversation
  retention"), `bridges/AGENTS.md` and
  [`agent-engines.md`](../../architecture/agent-engines.md#closing-a-tab-retains-the-conversation).
- **Close path.**
  - Every managed bridge serves `POST /session/:id/close`. Backend teardown
    (`commands-registry-teardown.ts`) and `HttpBridgeProvider.closeSession`
    both call `closeBridgeSessionRetaining`
    (`apps/backend/src/core/bridge-session-close.ts`).
  - A 404 or 405 from the close route means the bridge predates it. The
    legacy `DELETE` fallback is used only where `LEGACY_DELETE_RETAINS_HISTORY`
    is `true`. Claude is `false`, so an old Claude bridge raises
    `BridgeCloseUnsupportedError`, which carries
    `TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER`. The renderer then shows the
    restart notice (`apps/web/src/lib/tab-teardown-notice.ts`).
  - OpenCode closes through `apps/backend/src/core/opencode-session-close.ts`
    and `OpenCodeProvider.closeSession`, never `session.delete`.
  - Since #964 the ACP bridge sends `session/close` when the agent advertises
    it (`bridges/acp-bridge/src/acp-session-close.ts`). Grok CLI 1.0.52 keeps
    the conversation afterwards (verified 2026-10-13, see the `session/close`
    note in [`upgrade-agents.md`](../../development/upgrade-agents.md)).
  - New teardown intents carry the `retain-history-close:` fence
    (`fenceRetainingCloseSessionId`, `packages/protocol/src/tab-teardown.ts`),
    so an older backend refuses them instead of replaying a `DELETE`.
  - Multi Review cleanup calls the same non-destructive `closeSession`.
- **Cursor durability** (`bridges/cursor-bridge/src/`): `persistBarrier`
  (`persistence.ts`), `persistence-budget.ts`, `session-close.ts`,
  `session-tombstones.ts` and `steer-journal.ts`. The steer journal is capped
  at `MAX_STEER_JOURNAL` 256 entries and `MAX_STEER_JOURNAL_BYTES` 512 KiB
  (`config.ts`). It refuses with 429 (`steer-capacity-exceeded`,
  `steer-not-recorded`), and publishes its occupancy as
  `NativeAgentRuntimeSummary.steer`.
- **Pi startup cancellation.** The claim is taken at route entry
  (`promptClaim`, `cancelRequestedClaim` in `bridges/pi-bridge/src/state.ts`).
  A parked cancel answers 202 pending, and startup is bounded by
  `PI_BRIDGE_STARTUP_TIMEOUT_MS`.
- **Drafts.** `apps/web/src/lib/native-draft-attachments.ts` decides from
  `nativeAgentCapabilities(platform).attachments`, with no Cursor or Grok
  special case. Drafts persist in the backend `compose-drafts` store.
- **Conformance.** Scenarios and the capability matrix are in
  `tests/conformance/bridge-contract/` (`scenarios.ts`, `capabilities.ts`).
  Each bridge runs them in `bridges/*/src/conformance-bridge-contract.test.ts`,
  guarded by `tests/unit/bridge-contract-conformance.test.ts`. Interaction
  scenarios are in `bridges/cursor-bridge/src/conformance-interactions.test.ts`.
  Every unsupported cell carries its reason.
- **Close retention through the UI** (`e2e/CloseRetention.spec.ts`, in
  `mise run test:browser`). The spec drives the real pane tree and native agent
  tab. Its host (`e2e/fixtures/close-retention-host.ts`) runs the real backend
  command registry, native agent service, Cursor, Pi and ACP bridges and
  OpenCode provider, with fakes only at each vendor engine:
  - Cursor: `bridges/cursor-bridge/src/testing/fake-engine-server.ts`
  - Pi: `bridges/pi-bridge/src/testing/fake-engine-server.ts`, using pi-ai's
    faux model, so the JSONL session files are real
  - Grok: `bridges/acp-bridge/src/testing/fake-agent-close.ts`
  - OpenCode: `e2e/fixtures/close-retention-opencode.ts`

  For each platform the spec completes a turn and closes the tab with its
  close button. It checks the bridge received `POST /session/:id/close` and
  never a `DELETE` (for OpenCode, that `session.delete` was never called), and
  that a reload does not bring the tab back. It then opens a new tab, picks the
  platform in the resume dialog, picks the conversation, and checks the
  transcript is restored once. The next prompt must run in the same vendor
  conversation: the engine's own store holds exactly `[first, second]`. A
  final reload keeps both turns and dispatches nothing.

  The same harness covers three further cases:
  - Closing mid-turn for Cursor, OpenCode and Grok: the owned run is
    cancelled, the tab stays closed across an inactive environment and a
    reload, and the conversation resumes and continues.
  - Closing a Cursor tab during cold start, while `Agent.create` is held: the
    dispatch already in flight reaches the bridge after the close and is
    fenced there. The late agent is disposed without a send, and no teardown
    intent is left pending.
  - An assigned Grok tab restoring an image draft, with text and
    attachment-only, across an inactive environment and two reloads.
- **Live evidence so far** (2026-09-26 unless noted): retention through the UI
  for Claude and Codex; a bridge restart that kept the plan-mode selection;
  draft restoration for an assigned Cursor tab and for the pre-session picker
  (Cursor and Grok). `e2e/agent-testing/native-draft-attachments.spec.ts`
  reports a skip with its reason when a bridge cannot connect.
  On 2026-10-17, `e2e/agent-testing/close-retention-live.spec.ts` passed for
  Grok and OpenCode through the real app on an isolated profile with host
  credentials. Each case: closed the tab, the tab stayed closed after a reload,
  the conversation was resumed from a new tab, and the resumed session repeated
  a codeword it had only been told before the close. Cursor and Pi were
  skipped as signed out in that profile (Qualification item 1).
- **A resume closes the session it replaced** (fixed 2026-10-17). A new
  agent tab creates a provider session as it mounts, before its resume picker
  opens. `resumeProjectionSession`
  (`apps/backend/src/core/native-agent-service-dispatch.ts`) adopted the
  resumed id and left the created session running. On Grok that was a `grok`
  process holding an `ACP_MAX_SESSIONS` slot for the life of the bridge, with
  no reaper. On every other platform it was a bridge map entry (Codex drops
  one after 7 days untouched). It now closes the replaced session with
  `provider.closeSession`, the same non-destructive close tab teardown uses.
  Tab teardown's ownership rules and its per-session lock moved into
  `apps/backend/src/core/provider-session-ownership.ts`, and both paths use
  them: a session another tab maps, or a Multi Review owns, is not closed.
  The browser spec's main case now checks that the new tab's session gets
  `POST /session/:id/close` (for OpenCode, an abort and no delete) once the
  resume lands. It fails without the fix on all four platforms. Live on an
  isolated profile with host Grok credentials,
  `close-retention-live.spec.ts` (Grok) passed either way. A process sampler
  under that profile's backend saw the new tab's empty-session `grok` process
  stay alive beside the resumed one until the environment was deleted without
  the fix, and exit when the resumed one started with it.
- **OpenCode conversations are titled from their first prompt** (fixed
  2026-10-17). Every provider session is created as "Agent Session"
  (`native-agent-service-provider.ts`). The projection replaced that
  placeholder with the first prompt only for Claude
  (`native-agent-service-projection.ts`), so every OpenCode conversation read
  "Agent Session" in the resume list. Live, before the fix, the only OpenCode
  row was "Agent Session". Now any platform's placeholder is replaced. A
  provider's own title (Codex's brief title, Grok's generated title) is still
  kept.

- **Done 2026-10-23** (this change). Each is covered by tests that fail
  without it:
  - **A tab opened only to resume creates no session.** While the picker of
    a tab opened from **Resume Session** is open, the controller keeps the
    session hook disabled (`awaitingResumeChoice`,
    `AgentNativeTab.controller.tsx`) and shows the picker alone. Picking a
    row resumes straight into the unmapped tab with no composer controls;
    dismissing the picker, or a failed resume, starts the tab's own session
    as before. `CloseRetention.spec.ts` checks for all four platforms that
    the resume sent no `POST /session/create` and no close (OpenCode: no new
    session), and a new case per platform checks that a tab which did start
    its own session (picker dismissed) still has it closed by a later resume.
    Renderer cases are in `AgentNativeTab.test.tsx` ("a tab opened only to
    resume…", "dismissing the resume picker…", "a failed resume falls back…").
  - **A replaced session's close is durable.** `closeReplacedSession`
    journals `replacedSessionCloseIntent(agent, providerSessionId)` (a tab
    teardown intent under the reserved key `resume-replaced:<agent>:<digest>`)
    before the close and clears it on confirmation. `reconcile_tab_teardowns`
    replays it under the same lock and last-owner rules, without the tab
    mapping checks and without revoking a tab credential, and `teardown_tab`
    refuses the prefix. Tests: `native-agent-service-resume-close.test.ts`,
    `commands-registry-teardown.test.ts` ("replaying the close of a session a
    resume replaced").
  - **Untitled resume rows** read `Session <8 chars of the provider's own
    id>`: the ACP token's encoded Grok id, or Pi's session id from its file
    name, instead of `Session acp-sess` or the start of a path
    (`shortResumeSessionId`, `NativeResumeSessionDialog.tsx`). The row's
    detail (Pi's first message, a message count) stays beside it.
  - **OpenCode servers start one at a time.** `opencode-host-start.ts` holds
    every host OpenCode start (environment servers, catalogue and sign-in
    servers) from spawn until healthy or exited. A local start whose server
    exits saying `database is locked` is retried twice (0.5 s, 2 s) and then
    refused with that reason (`opencode-host-start.test.ts`, which also proves
    two environments starting together launch one server at a time). The
    2026-10-21 "silent wait" was the live spec, not the product: the dispatch
    had been refused with the startup error, and
    `paused-interactions-live.spec.ts` ignored the outcome and polled for five
    minutes. The spec now fails at once on a refused dispatch; the tab already
    shows a refused dispatch as a send error.
  - **Stopping a prompt before the provider accepts it works.** Three defects
    stood between the user and Pi's startup cancel, found by the new browser
    case with the real Pi SDK:
    - The compose bar disabled its Stop button while a prompt was being
      submitted, which is the whole startup window (Escape already worked).
      Stop now follows only `onStop` (`NativeComposeBar.tsx`).
    - The backend stop awaited its durable interrupt record before sending
      the abort. A dispatch the provider has not acknowledged holds the
      session's storage queue until it is, so the abort reached Pi only after
      Pi had accepted and run the prompt. The write is now started, the abort
      sent, and the write awaited at the end; the in-memory interrupt fence
      covers the gap, as it already did for a failed write
      (`native-agent-service-dispatch.ts`).
    - The interrupt was recorded against `dispatchedRequestIds.at(-1)`, the
      finished turn before, because the starting prompt is only in
      `pendingDispatch`. It now names the starting prompt, and storage
      records an interrupt for a pending dispatch too, so one whose
      acknowledgement is lost keeps its Stop across reconciliation and a
      restart. The in-memory fence is dropped only once the marker is durable.
    - Stop shows from the moment a dispatch starts (the controller's
      `isTurnActive` includes `isDispatching`), not only once the projection
      reports a running turn.
    `native-agent-service-turn-outcome.test.ts` ("Stop reaches a prompt the
    provider has not accepted yet…") and `NativeComposeBar.test.tsx` cover
    the backend and renderer halves.
  - **Browser qualification on the real stack** (`e2e/CloseRetention.spec.ts`,
    host endpoints in
    [agent-testing.md](../../development/agent-testing.md#live-close-retention)):
    - *Large transcript after Cursor shedding*: three turns, then the Cursor
      bridge restarts on a state file shed by the bridge's own budget code.
      The reload shows the newest message only and says earlier messages are
      not available here; the next prompt runs in the same Cursor agent,
      after all three turns. This found a product gap: a window that is
      truncated but cannot page said nothing (the notice for that shape was
      dropped in #755 when the load-earlier button was always shown, and the
      button was later retired without restoring it). The controller now
      shows "Earlier messages in this conversation are not available here.
      The conversation itself is kept." for a truncated window with no
      byte-limit notice and no load-earlier control.
    - *Steer saturation*: a held Cursor turn's steer journal is filled until
      the bridge refuses with `steer-capacity-exceeded`. The runtime panel
      shows "Steering is full for this turn"; a `/steer` from the composer is
      refused with the bridge's reason, the instruction stays in the composer
      across an inactive return and a reload, and the turn keeps running
      until stopped. The Cursor fake engine's run gained `steer`.
    - *Dead generation while inactive*: Grok parks a question and a plan
      approval, the environment goes inactive and the Grok bridge restarts.
      On return both cards are withdrawn; they stay gone after close and
      reload, and the resumed conversation offers nothing to answer. The
      dead requests are never answered on the new process's behalf.
    - *Old Claude bridge*: a stale bridge answering 404 to the close route.
      Closing the tab shows the "Restart the environment to finish closing
      this tab" toast, the intent stays pending through the sweep, no
      `DELETE` is ever sent, and the tab stays closed across a reload.
    - *Pi startup interrupt*: the Pi fake engine holds `AgentSession.prompt`
      before Pi accepts it (`FAKE_PI_STARTUP_GATE`). Stop, switch away,
      return and reload, then release: the turn settles without an answer,
      every model request Pi made for the stopped prompt already carried an
      aborted signal (a real provider sends nothing then), no approval is
      left, and the next prompt runs.
  - **Attachment-only drafts survive a backend restart.** Storage round-trips
    a text-less image draft across `StorageService` instances
    (`storage-drafts.test.ts`), and hydrating one for Cursor or Grok keeps
    the image and never deletes or blanks the record
    (`draft-persistence.test.ts`).

## Outstanding work

### Code

1. **Retire the legacy close fallback after the support window** (blocked).
   Remove the `DELETE` fallback and `LEGACY_DELETE_RETAINS_HISTORY` from
   `closeBridgeSessionRetaining`, and the `bridge-upgrade-required` path, once
   no supported bridge predates `POST /session/:id/close`. There is no agreed
   support window yet
   ([0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)
   owns that decision), so nothing can be retired. Until then, a 404 or 405
   keeps meaning "old bridge", never "already closed". The restart notice is
   now proved in the browser suite, so retiring it later has a test to
   delete with it.

### Qualification

Live items need provider credentials; batch them with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

1. **Live close retention for Cursor and Pi.** Run
   `e2e/agent-testing/close-retention-live.spec.ts`
   ([agent-testing.md](../../development/agent-testing.md#live-close-retention))
   with a profile where both are signed in. Attempted 2026-10-23 on an
   isolated `dev:test` profile with host credentials
   (`--agent-platforms cursor,pi`), neither case reached the close:
   - Pi is now signed in (the profile reads the host's `auth.json` through
     `PI_BRIDGE_AUTH_FILE`), but its first turn failed: Pi's own default
     `gpt-4` is "not supported when using Codex with a ChatGPT account". With
     `ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_MODELS=pi=openai/gpt-5.5` the
     same error named `gpt-5.5`, and `pi=openai-codex/gpt-5.5` never sent.
     A usable Pi model for agent-test profiles is
     [0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md);
     rerun this after it.
   - Cursor's case timed out waiting for its first prompt to appear: the
     test environment it created was still starting (sidebar spinner) when
     the 60-second wait ran out, so this is environment setup in that
     profile, not close retention. Rerun on a profile whose environments
     start.

## Constraints and rationale

- Close never deletes vendor history. Never call Claude SDK `deleteSession`,
  Codex `thread/delete` or OpenCode `session.delete` from a close path.
- Only a 2xx that affirms `closed: true` confirms a close. A 404 or 405 from
  the close route is never evidence that the session is gone.
- A missing, evicted or old-generation journal entry is not proof of
  non-delivery. An ambiguous dispatch is never retried automatically under a
  new ID.
- Use deterministic fixtures to gate races, and live smoke only for SDK
  integration. Keep fakes at the engine boundary; do not build a universal fake
  agent that grants every vendor every feature.
- An unavailable live layer is reported as skipped with its reason, never as a
  pass.
- Persisted format changes stay additive, with a recorded downgrade behaviour.
- **Cursor steer-fence downgrade.** The Cursor state file gained two additive
  fields: the bounded `steerFence` per session (`runs`, plus `overflowBefore`
  and the legacy `overflow: true` once a run name has been dropped) and the
  byte-bounded `steerJournal`. An older bridge loads the file and ignores
  `steerFence`. A downgrade loses the fence, not the delivery guarantee,
  because of two properties of the older bridge:
  - It re-adopts a running run only when `/session/resume` creates a new
    session, which starts with an empty journal. A session restored from the
    state file never gets its old run back as `activeRun`. A retried ID aimed at
    an old run therefore answers `idle` or `mismatch` and is never sent.
  - A steer the backend still has parked cannot have been evicted. Storage
    refuses every other request ID for a session while one is parked (AGENTS.md,
    "A parked dispatch blocks its whole session"), so no new steer creates
    eviction pressure.

  The remaining risk is a restore that dropped a legacy oversized journal: the
  older bridge answers `idle` rather than `unknown` for the forgotten ID.
  Nothing is migrated destructively, and upgrading restores the fence from the
  same file. The legacy `overflow` boolean is still written so that a bridge
  reading only it treats every recovered run as fenced. A legacy
  `overflow: true` without `overflowBefore` is read as bounded by the load
  time.
- **Close retention is proved in the component browser suite, with real
  layers down to each vendor engine.** `e2e/CloseRetention.spec.ts` drives the
  real renderer against the real backend command registry and bridges. Each
  engine is faked at its own boundary: the Cursor SDK `Agent` statics, pi-ai's
  faux model, the ACP fake agent process and the OpenCode SDK client. Bridges
  are not faked. The alternatives were weaker or riskier:
  - A renderer fixture with a fake `invoke` would not exercise `teardown_tab`,
    the bridge close route, list or resume.
  - A backend-only test would skip the close button, the resume dialogs and
    the tab and pane state.
  - A `dev:test` profile with fake engines would need a test seam in the
    shipped backend.

  The cost is a fixture host that knows each engine's quirks. A new
  platform needs its own fake engine before it gets a case.
- **Fake engine entry points live in the bridge that owns them**
  (`bridges/*/src/testing/fake-engine-server.ts`). They use the bridge's own
  `*ForTests` seams, so the bridge's `tsconfig.test.json` typechecks them and
  nothing in `src` outside `testing/` imports them. Each starts the server
  itself (Cursor imports `server.ts`; Pi sets `PI_BRIDGE_LIBRARY_ONLY`), so the
  shipped entry point is unchanged.
- **"Same conversation" is judged from the engine's store, not the
  transcript.** The spec reads the prompts each vendor conversation actually
  ran: the Cursor agent's turns, the Pi model's context on each call, the Grok
  store and the OpenCode session messages. A resume that silently started a
  new conversation, re-sent the first prompt, or dropped history fails there
  even if the rendered transcript looks right.
- **One viewport.** The cases skip the mobile project: the close, resume and
  continue path does not depend on layout, and each case spends real bridge
  work.
- **Live proof is a separate, opt-in spec**
  (`e2e/agent-testing/close-retention-live.spec.ts`). It is not in
  `mise run test` or the review scheduler, because turns cost tokens. A
  codeword the second turn must repeat proves the model kept its context.
  Signed-out platforms are skipped with that reason, never passed.
- **The OpenCode title placeholder is fixed here.** It is one condition in
  the projection, it decides whether the closed conversation can be found in
  the resume list (this item's subject), and live evidence showed it.
  `native-agent-service-projection.test.ts` covers it per platform, and the
  OpenCode browser case fails without it, because the OpenCode fake now keeps
  a session's created title as OpenCode does.
- **The resume close is in the backend, after the resume is adopted.** A
  renderer-only fix (create no session for a tab opened to resume) would miss
  a user who opens a plain new tab and then clicks Resume Session, and every
  non-UI caller of `resume_native_agent_session`. The backend knows which
  session the tab showed (`existing.providerSessionId`, which is also the
  adoption's `expectedProviderSessionId`), so the close takes no id from the
  renderer. The close runs only after the adoption succeeds, so a failed
  resume leaves the tab's own session usable. Lazy creation (done
  2026-10-23) also avoids the empty vendor conversation, but the backend close
  stays for a tab that did start its own session.
- **The resume close follows tab teardown's last-owner rules and lock.**
  `providerSessionHeldElsewhere` and `withProviderSessionTeardownLock`
  (`provider-session-ownership.ts`) are shared code, not a copy. The lock is
  keyed by (environment, agent, provider session) within one storage, so a
  tab close racing a resume in another tab cannot both skip the close: the
  resume checks under the lock, after its adoption, and the teardown checks
  and retires its mapping under the same lock. A session another tab shares,
  or one a Multi Review owns, is left alone, as tab close leaves it.
- **It closes any replaced session, not only empty ones.** The tab no longer
  shows the replaced session, which is what a tab close means, and the close
  keeps the conversation, so it can be resumed again. In the UI the Resume
  Session button only shows on an empty transcript, so the replaced session
  is almost always empty. Checking for emptiness first would need a provider
  read on every resume and would keep the leak for a replaced session that
  had one turn.
- **The close is best effort and runs beside the projection refresh.** A
  failure is logged (the agent name and error class only, never the message)
  and the resume still succeeds; a bridge that cannot be reached has usually
  lost the session with its process. The resume answers once both the refresh
  and the close settle, so the close never outlives the request unobserved.
  On a responsive bridge an idle close is one local request, and the bridge
  request timeout bounds the slow case. Since 2026-10-23 the close is
  journaled first, so one that stays pending or times out is retried by the
  reconcile sweep.
- **`provider.closeSession`, not the teardown's raw bridge request.** The
  resume has already resolved the provider and reached the bridge, so there
  is no bridge to avoid starting. `HttpBridgeProvider.closeSession` calls
  `closeBridgeSessionRetaining` like teardown, so the legacy-DELETE and
  Claude upgrade rules are the same. OpenCode's `closeSession` runs its own
  retaining close.
- Which records survive a bridge or backend restart, and who owns each, is in
  [agent-engines.md → What survives a restart](../../architecture/agent-engines.md#what-survives-a-restart).
- Every caller of close and its intended retention is in
  [agent-engines.md → Who calls close](../../architecture/agent-engines.md#who-calls-close).

## Open questions

None. The two questions this file carried (idle cancel and abort bodies,
bounded-state occupancy in `/runtime-health`) are decided below.

## Needs verification

- What a real Cursor resume row shows. The bridge creates every SDK agent as
  `name: "Orkestrator"` and has no rename, so each row is probably titled
  "Orkestrator", with the SDK's `summary` as its detail. The browser spec's
  fake assumes the summary describes the conversation. Check on the live run
  in Qualification item 1. If every row reads "Orkestrator", title untitled
  Cursor rows from the summary rather than the agent name.

## Assumptions and decisions

### Lazy session only for tabs opened from the resume flow (Code item 2)

- **Options.** (a) Create the session on first prompt for every new tab.
  (b) Defer only while a tab opened from **Resume Session** shows its picker;
  create it when the picker is dismissed or the resume fails. (c) Keep
  creating on mount and rely on the backend close.
- **Choice: (b).**
- **Why.** It removes the empty conversation for the case that produced it,
  without touching the composer's dependence on a projection for every other
  tab (models, modes, send lock, slash commands all read it). An unassigned
  tab is already lazy until its first prompt.
- **Pros.** Small, local to the controller; no protocol change; the backend
  resume already accepts an unmapped tab.
- **Cons.** The resume sends no composer controls, so the resumed
  conversation keeps its own settings (the old path sent the empty session's
  defaults, which was never a user choice). The "for resume" flag is not
  persisted: a reload while the picker is open creates the session as before.
  The backend close is kept for tabs that did start a session.

### Durable replaced-session close reuses the tab teardown journal (Code item 3)

- **Options.** (a) A new environment field and sweep. (b) The existing tab
  teardown intents under a reserved key, with a replay branch. (c) Leave it
  best effort.
- **Choice: (b).** Key `resume-replaced:<agent>:<sha256(agent, id) prefix>`,
  `kind` `<agent>-native`, the id fenced as every native intent is.
- **Why.** The journal already has the storage lock, `createdAt`
  generations, the 60-second sweep with per-intent backoff, startup replay and
  deletion with its environment. The item was conditional ("if the leak shows
  up again"); journaling it costs one write per resume.
- **Pros.** No new storage or sweep. Downgrade-safe: an older backend sees a
  fenced intent for a tab nobody maps and clears it without a provider call.
  One intent per replaced session (the key is deterministic), and no session
  content in the key or the logs.
- **Cons.** A reserved prefix in what are otherwise tab ids, guarded in
  `teardown_tab`. Like a tab intent, it stays pending while the bridge is down
  (an un-restarted local bridge holds no session, a restarted Cursor bridge
  restores it), backing off to 15 minutes.

### Resume row fallback: the provider's own short id (Code item 4)

- **Options.** Fall back to the row's detail, or to a short form of the
  provider's id.
- **Choice:** the short id, keeping the detail beside it.
- **Why.** The detail is sometimes a message count ("3 messages"), which is no
  title, and using it as the title would repeat it on the same row.
- **Cons.** The label is an id fragment rather than words; Pi's first message
  still sits right beside it.

### OpenCode startup: serialise and retry; no new turn-error record (Code item 5)

- **Options.** Retry a locked-database exit; serialise starts per host;
  record a turn error for a failed start.
- **Choice:** serialise every host start from spawn to healthy, and retry a
  locked-database exit twice. No new turn-error record.
- **Why.** Serialising removes the race between this backend's own servers;
  the retry covers an `opencode` the user runs in a terminal. A failed start
  happens before the at-most-once window, so the dispatch is refused with the
  reason and the tab already shows it as a send error; the silent wait was the
  live spec ignoring that outcome.
- **Pros.** Bounded: a start holds the host turn for at most the 15-second
  health budget. The short-lived catalogue and sign-in servers share the lock.
- **Cons.** Several environments restoring at app start come up one after
  another (seconds each) instead of together. A coordinator's MCP wait is
  outside the lock, so it does not lengthen anyone else's start.

### The legacy close fallback is not retired (Code item 1)

- **Choice:** keep it. Retiring needs a support window that 0034 has not
  agreed; removing it now would turn an old Claude bridge's 404 into a
  failure with no notice, or worse, tempt a DELETE.

### Pi startup interrupt is proved in the browser suite (Qualification item 2)

- **Options.** Gate Pi through a user extension (`before_agent_start`);
  through the bridge's in-process test hooks; at `AgentSession.prompt` in the
  fake engine.
- **Choice:** `AgentSession.prompt` in `bridges/pi-bridge/src/testing/fake-engine-server.ts`.
- **Why.** The bridge loads no discovered extensions unless project resources
  are enabled (`noExtensions`), so an extension never runs for an ordinary
  tab. The hooks replace the whole SDK session. Holding the SDK's own entry
  point keeps every layer above it real.
- **Cons.** It holds the first stage of Pi's preflight (input handlers,
  auth), not auto-compaction. The second stage is source-verified in
  `prompt-cancel-preflight.test.ts`. A stop recorded before acceptance is
  applied by the bridge after its acceptance await resumes; with the backend
  fix, the real SDK showed that abort reaching the run before its first model
  request (the request carried an aborted signal), so the bridge's ordering
  was left as it is.

### The backend stop no longer waits for its interrupt write before aborting

- **Options.** Keep "record, then abort"; take the interrupt write out of the
  session queue; start the write and send the abort without waiting.
- **Choice:** start the write, abort, and await the write at the end.
- **Why.** The session queue is the at-most-once fence of the dispatch and
  must stay held until the provider acknowledges. The in-memory interrupt
  fence was already how a failed write is honoured.
- **Cons.** A backend that dies between the abort and the write loses the
  "interrupted" classification for that request, the same exposure as a
  failed write today. The stop request answers only once the write lands,
  which during a startup is once the provider settles the prompt.

### A truncated window that cannot page says so

- **Choice:** show "Earlier messages in this conversation are not available
  here. The conversation itself is kept." when the window is truncated, the
  16 MiB notice does not apply and there is no load-earlier control.
- **Why.** The persistence-shed transcript rendered as if it were the whole
  conversation, which is exactly what the qualification forbids. #755 removed
  the old "Earlier messages are not shown." because the button always showed
  then; once the button was retired for unpageable windows, nothing said it.
- **Cons.** Any provider whose source reports truncation with no paging now
  shows the line too, which is accurate but new to users.

### Idle cancel and abort answer differently (former open question)

- **Options.** Align every bridge on one idle body; keep the bodies and
  document that the backend reads settlement.
- **Choice:** keep them.
- **Why.** The backend abort ladder polls authoritative status and never
  reads the body, and the conformance matrix already records each
  difference with its reason (`cancel-idle-in-band`). Aligning would change
  three bridges' wire contracts and the version skew between them for no
  behaviour change.
- **Cons.** A new caller must not read the body as a stop; the matrix and
  `bridges/AGENTS.md` are where it learns that.

### Bounded-state occupancy in `/runtime-health` stays Cursor-only (former open question)

- **Choice:** do not publish occupancy for Claude, Codex, Pi or ACP.
- **Why.** Cursor publishes its steer journal because it refuses user work
  (429) when the journal is full and the runtime panel tells the user why. The
  other bridges' bounds (queues, journals) do not refuse a user action the
  panel could explain. Publishing numbers nobody acts on is cost without use.
- **Revisit** when another bridge gains a bound that refuses user work.

### Assumptions

- The live failures recorded under Qualification item 1 are environment and
  model problems of the agent-test profile on this host, not close
  retention: neither case reached the close.
- The faux model being asked for the stopped Pi prompt is not a request sent:
  pi-ai's faux provider calls its response factory even for an aborted
  request, so the evidence is the signal it was handed.

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md):
  steer and interrupt support per provider.
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md):
  the interaction contract behind the dead-generation case.
- [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md):
  truncated history views.
- [0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md):
  the Pi model the live run in Qualification item 1 needs.

## Replaces

- `docs/improvements/incocnsistencies.md`
- `docs/improvements/inconsistencies/plan/00-index.md`
- `docs/improvements/inconsistencies/plan/02-mandatory-persistence-and-dispatch-barriers.md`
- `docs/improvements/inconsistencies/plan/03-aggregate-persistence-budgeting-and-recovery.md`
- `docs/improvements/inconsistencies/plan/04-durable-session-lifecycle-acknowledgements.md`
- `docs/improvements/inconsistencies/plan/05-cursor-permanent-close-and-late-work-ownership.md`
- `docs/improvements/inconsistencies/plan/06-pi-cancellation-during-startup-and-preflight.md`
- `docs/improvements/inconsistencies/plan/07-capability-driven-attachment-draft-restoration.md`
- `docs/improvements/inconsistencies/plan/08-bounded-steer-history-with-safe-replay.md`
- `docs/improvements/inconsistencies/plan/10-shared-transcript-cursor-validation.md`
- `docs/improvements/inconsistencies/plan/11-conformance-verification-and-release-handoff.md`
- `docs/improvements/inconsistencies/plan/01-contract-baseline-and-regression-fixtures.md`
  (record-ownership table now in `agent-engines.md`)
- `docs/improvements/inconsistencies/plan/09-conversation-retention-and-close-semantics.md`
  (caller inventory now in `agent-engines.md`)
