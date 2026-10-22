# Session lifecycle consistency

Checked against `main` at `31d0fb06` (2026-10-17).

The native bridges share one lifecycle contract. Acknowledgements are durable.
State is published before any side effect. A permanent close fences late work.
Cancellation works before a prompt is accepted. Recovery state is bounded. And
closing a tab keeps the conversation. #853 landed the code and the
deterministic tests for all of it. Close retention through the UI is now a
permanent browser spec for Cursor, Pi, OpenCode and Grok. What is left is
real-stack evidence that was never collected, plus a few divergences that the
conformance matrix records but does not resolve.

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

## Outstanding work

### Code

1. **Retire the legacy close fallback after the support window.** Remove the
   `DELETE` fallback and `LEGACY_DELETE_RETAINS_HISTORY` from
   `closeBridgeSessionRetaining`, and the `bridge-upgrade-required` path, once
   no supported bridge predates `POST /session/:id/close` (see
   [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)). Until
   then, a 404 or 405 keeps meaning "old bridge", never "already closed".
2. **Create no session for a tab opened only to resume** (follow-up to the
   resume close, low). A tab locked to a platform for resume still creates a
   provider session as it mounts, and the resume then closes it. The close
   keeps vendor history, so OpenCode and Grok each still store one empty
   conversation per resume, and a signed-in Grok bridge spawns an agent
   process for a few seconds. Creating the session only on the first prompt,
   or when the picker is dismissed, would avoid both. It needs the composer to
   render without a projection.
3. **Retry a replaced-session close that failed** (follow-up, low). The
   resume close is best effort: a 503 pending or a timeout leaves the session
   registered on the bridge, with no mapping for any sweep to find. Only a
   close blocked by owned work answers pending, and a replaced tab session is
   almost always empty. If the leak shows up again, record a durable intent
   keyed by environment, agent and provider session, and replay it in
   `reconcile_tab_teardowns`.
4. **Label untitled resume rows by something a person recognises.**
   `NativeResumeSessionDialog` falls back to `Session <first 8 characters of the
   id>`. Live Grok rows whose title Grok had not generated yet read
   `Session acp-sess`, because the id is the `acp-session:` resume token. A Pi
   row without a name would show the start of a file path. Fall back to the
   row's detail, or a short form of the provider's own id.
5. **Two OpenCode servers starting at once can lose one to "database is
   locked".** Every local OpenCode server shares the user's
   `opencode.db` under XDG data. On 2026-10-21, two OpenCode environments
   whose first turns were dispatched together started their servers in the
   same second. One exited before it became healthy (`Error: Unexpected error
   … database is locked`, code 1), and `commands-servers.ts` stopped it as
   "startup did not complete". The dispatch had already been accepted, and for
   the five minutes the run waited the tab's turn neither started nor reached
   `error`. Restoring several OpenCode tabs at app start, or a mixed panel,
   can start servers together the same way. Retry a startup whose server
   exits on a locked database, or serialise OpenCode server starts per host,
   and surface a startup that fails for good as a turn error instead of a
   silent wait. Found by `paused-interactions-live.spec.ts`, which now starts a
   provider's cases one after the other (see
   [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md#live-pause-record-2026-10-21)).

### Qualification

No code is needed unless a check fails. Live items need provider credentials;
batch them with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

1. **Live close retention for Cursor and Pi.** Run
   `e2e/agent-testing/close-retention-live.spec.ts`
   ([agent-testing.md](../../development/agent-testing.md#live-close-retention))
   with a profile where both are signed in. On 2026-10-17 both were signed
   out in an isolated profile on the qualification host: Pi because nothing
   imports `~/.pi/agent/auth.json` into the profile's private HOME, and Cursor
   for a reason the launcher does not log.
2. **Pi startup interrupt.** Interrupt before the prompt is accepted, switch
   away, return and reload. The turn must stop, status must settle, no approval
   may be left unanswered, and the next prompt must run. The SDK side is
   already source-verified (Pi "Preflight" in
   [`upgrade-agents.md`](../../development/upgrade-agents.md)). The browser
   harness cannot hold Pi's startup: the faux model answers at once and the
   bridge exposes no startup gate outside its in-process test hooks.
3. **Browser: large-transcript recovery after Cursor persistence shedding.**
   Expect an honest truncated view, the same provider identity and working
   controls.
4. **Browser: steer saturation.** Expect the runtime-panel notice, the 429
   refusal, the current turn continuing, and the draft kept across an inactive
   return and a reload.
5. **Browser: a dead-generation card while the environment is inactive.** A
   card whose provider generation died (bridge restart) must be withdrawn after
   close and reload. The still-live case (Grok question and plan approval
   cancelled by the close, nothing actionable after reload or resume) is in
   `e2e/CloseRetention.spec.ts`. No other platform's fake parks a request yet.
6. **Browser: the `bridge-upgrade-required` restart toast for an old Claude
   bridge.** This needs a stale-bundle fixture. The first pass observed only
   the pending intent, not the toast.

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
  resume leaves the tab's own session usable. Lazy creation stays as Code
  item 2, because it also avoids the empty vendor conversation.
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
  request timeout bounds the slow case. A durable retry is Code item 3.
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

- **Idle cancel and abort answer differently** (`BRIDGE_CONTRACT_CAPABILITIES`,
  `cancel-idle-in-band`):
  - Claude has no `/cancel`, and idle `/abort` answers 200
    `{status: "not_running"}`.
  - Codex has no `/cancel`, and `/abort` answers 202 `{status, phase}` because
    `turn/interrupt` is asynchronous.
  - ACP answers 202 `{accepted: true}` in every state.

  Aligning them is a contract decision. The backend abort ladder polls
  authoritative settlement and does not depend on the body.
- Should Claude, Codex, Pi and ACP publish bounded-state occupancy in
  `/runtime-health`? Only Cursor does today (`bounded-recovery-summary` is
  unsupported for the rest).

## Needs verification

- What a real Cursor resume row shows. The bridge creates every SDK agent as
  `name: "Orkestrator"` and has no rename, so each row is probably titled
  "Orkestrator", with the SDK's `summary` as its detail. The browser spec's fake
  assumes the summary describes the conversation. Check on the live run in
  Qualification item 1.

- Whether an attachment-only Cursor or Grok draft survives a backend restart
  without composer hydration erasing the image.
  `apps/backend/src/core/storage-drafts.test.ts` round-trips drafts across
  `StorageService` instances, but no case covers an attachment-only draft
  through a restart.

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md):
  steer and interrupt support per provider.
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md):
  the interaction contract behind qualification item 7.
- [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md):
  truncated history views (item 5).

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
