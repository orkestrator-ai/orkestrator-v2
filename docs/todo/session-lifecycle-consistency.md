# Session lifecycle consistency

Checked against `main` at `2459b05c` (2026-10-15).

The native bridges share one lifecycle contract. Acknowledgements are durable.
State is published before any side effect. A permanent close fences late work.
Cancellation works before a prompt is accepted. Recovery state is bounded. And
closing a tab keeps the conversation. #853 landed the code and the
deterministic tests for all of it. What is left is real-stack evidence that
was never collected, plus a few divergences that the conformance matrix records
but does not resolve.

## Current state

- **Retention is decided.** Closing a tab retains the conversation on every
  platform. This is policy in AGENTS.md ("Tab close and conversation
  retention"), `bridges/AGENTS.md` and
  [`agent-engines.md`](../architecture/agent-engines.md#closing-a-tab-retains-the-conversation).
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
    note in [`upgrade-agents.md`](../development/upgrade-agents.md)).
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
- **Live evidence so far** (2026-09-26 unless noted): retention through the UI
  for Claude and Codex; a bridge restart that kept the plan-mode selection;
  draft restoration for an assigned Cursor tab and for the pre-session picker
  (Cursor and Grok). `e2e/agent-testing/native-draft-attachments.spec.ts`
  reports a skip with its reason when a bridge cannot connect.

## Outstanding work

### Code

1. **Optional repeatable retention spec.** Add an opt-in real-stack spec under
   `e2e/agent-testing/`: complete a turn, close the tab, find the conversation
   in the resume list, resume it. One case per configured provider. No such
   spec exists, so qualification item 3 has to be repeated by hand.
2. **Retire the legacy close fallback after the support window.** Remove the
   `DELETE` fallback and `LEGACY_DELETE_RETAINS_HISTORY` from
   `closeBridgeSessionRetaining`, and the `bridge-upgrade-required` path, once
   no supported bridge predates `POST /session/:id/close` (see
   [mixed-version-compatibility.md](mixed-version-compatibility.md)). Until
   then, a 404 or 405 keeps meaning "old bridge", never "already closed".

### Qualification

No code is needed unless a check fails. Items 1 to 4 need provider
credentials; batch them with
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

1. **Cursor close during cold startup and during a run.** Close, switch
   environment, return, reload. Expect no late work, no resurrected tab and a
   truthful closing state.
2. **Pi startup interrupt.** Interrupt before the prompt is accepted, switch
   away, return and reload. The turn must stop, status must settle, no approval
   may be left unanswered, and the next prompt must run. The SDK side is
   already source-verified (Pi "Preflight" in
   [`upgrade-agents.md`](../development/upgrade-agents.md)).
3. **Retention after close through the UI** for Cursor, Pi, OpenCode and Grok:
   complete a turn, close the tab, find the conversation in the resume list and
   resume it. Grok's vendor-side retention is verified; the UI path is not.
4. **Assigned Grok tab image-draft restoration in the browser.** The spec cases
   exist and skip while the Grok CLI cannot connect.
5. **Browser: large-transcript recovery after Cursor persistence shedding.**
   Expect an honest truncated view, the same provider identity and working
   controls.
6. **Browser: steer saturation.** Expect the runtime-panel notice, the 429
   refusal, the current turn continuing, and the draft kept across an inactive
   return and a reload.
7. **Browser: pending approval or question while the environment is inactive,
   then close and reload.** A still-live provider request is denied per its
   contract, a dead-generation card is withdrawn, and no card comes back
   actionable.
8. **Browser: the `bridge-upgrade-required` restart toast for an old Claude
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
- Which records survive a bridge or backend restart, and who owns each, is in
  the kept
  [record-ownership table](../improvements/inconsistencies/plan/01-contract-baseline-and-regression-fixtures.md).
  Its backend `.json` file names predate SQLite (#969); the stores are now
  `native-agent-sessions`, `compose-drafts` and `environments`
  (`tabTeardownIntents`).
- Every caller of close and its intended retention is in the kept
  [caller inventory](../improvements/inconsistencies/plan/09-conversation-retention-and-close-semantics.md).
  Two rows are stale: #970 removed the renderer `deleteSession` helpers, and
  ACP now sends `session/close`.

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

- Whether an attachment-only Cursor or Grok draft survives a backend restart
  without composer hydration erasing the image.
  `apps/backend/src/core/storage-drafts.test.ts` round-trips drafts across
  `StorageService` instances, but no case covers an attachment-only draft
  through a restart.

## Related

- [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md):
  steer and interrupt support per provider.
- [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md):
  the interaction contract behind qualification item 7.
- [transcript-history-efficiency.md](transcript-history-efficiency.md):
  truncated history views (item 5).
- Living-doc drift to fix in
  [`agent-engines.md`](../architecture/agent-engines.md):
  - The Grok paragraph says "ACP has no release call and no delete method".
    Since #964 close sends `session/close` when advertised.
  - The sentence at the end of the close section that sends readers to the
    inconsistency plan for the caller inventory should link the kept
    [caller inventory](../improvements/inconsistencies/plan/09-conversation-retention-and-close-semantics.md)
    directly, or move its corrected rows inline.

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
- The open items of `plan/01-…` and `plan/09-…`, which stay as reference.
