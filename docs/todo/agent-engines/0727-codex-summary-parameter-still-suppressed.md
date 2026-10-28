# The backend still advertises a Codex reasoning-summary parameter, hidden only by a suppression entry

Checked against `main` at `863b5782` (2026-10-27). Code fixed on 2026-10-28
against `main` at `31b9c972`; only a live look at a Codex tab is left.

[0004-composer-model-parameters.md](0004-composer-model-parameters.md) item 1
records the Codex `parameter:summary` suppression entry as removed, with tests
that let the control through. On `main` the entry is still there, and the tests
expect the control hidden. The cause is that the backend's Codex catalogue
normaliser still emits a `summary` parameter descriptor, which the bridge no
longer reads, so the entry is what keeps an inert "Reasoning summary" control
out of every Codex composer. The doc is wrong about the code, and the code
still carries a descriptor that 0004's decision removed. No user sees a broken
control today. Found in the task analysis of
[0004-composer-model-parameters.md](0004-composer-model-parameters.md) (task 1).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Settle the intended behaviour**: confirm from 0004 and the PR history which of the doc and the code is wrong. Status: done (both are; see below).
2. **Remove the descriptor at its source**: stop `normalizedCodexModels` emitting `summary`. Status: done (2026-10-28).
3. **Remove the suppression entry and flip the tests**: once nothing produces the control. Status: done (2026-10-28).
4. **Correct 0004's record**: item 1 and its test names. Status: done (2026-10-28).

### 1. Settle the intended behaviour

**Problem.** 0004 says one thing and `main` does another, and #1260's squash
message agrees with the doc.

**Context.** 0004's "Assumptions and decisions" chose option (b) for Codex
summary and personality: remove the bridge plumbing and the suppression entry,
because `model/list` has no summary-support field. The table's own comment says
"an entry needs a descriptor that actually produces it"
(`packages/protocol/src/native-agent.ts:959-970`), and
`docs/architecture/agent-engines.md:360-363` says Codex's reasoning summary is
not offered.

**Investigation.** Confirmed from the code and from the PR's commits
(`gh pr view 1260`).
- PR #1260 had four commits before its merge commit. The first, `f4510b31`
  ("todo 0004: composer model parameters"), removed
  `codex: Object.freeze(["parameter:summary"])`, changed the backend projection
  test to expect `parameter:summary` to pass through for Codex, and renamed the
  renderer test to "suppresses no Codex parameter control in a %s tab",
  expecting "Reasoning summary: Automatic" to render.
- The second, `2690e39f` ("fix: reconcile Codex dispatch models under the
  admission lease"), put the entry back (`+1` line in `native-agent.ts`),
  removed `parameter:summary` from the backend test's expected Codex list, and
  renamed the renderer test to "hides unsupported Codex summary in a %s tab",
  expecting the control hidden. Its message does not mention this.
- The squash commit `1e76744d` kept the first commit's message ("remove …
  the `parameter:summary` suppression entry") and the doc text, so both
  describe the reverted state.
- Why it was restored (inferred, high confidence): the descriptor was never
  removed. `normalizedCodexModels`
  (`apps/backend/src/core/commands-registry-projects.ts:177-211`) adds
  `{ id: "summary", label: "Reasoning summary", … }` to every Codex model
  (`:193-206`). It feeds the live catalogue (`:870`) and the coordinator's
  cached one (`:647`), both returned by `get_native_agent_model_catalog`
  (`:561`). The projection reads that catalogue
  (`NativeAgentCatalogCache.refreshModels`,
  `apps/backend/src/core/native-agent-catalog-cache.ts:84-90`;
  `native-agent-transcript-projection.ts:4339-4386`), and
  `nativeComposerControls` turns every descriptor into a `parameter:*` control
  (`apps/backend/src/core/native-agent-service-shared.ts:777-787`). Without the
  entry, every Codex tab would show a summary picker the bridge ignores.
- Today: entry at `packages/protocol/src/native-agent.ts:976`; tests expecting
  suppression at `apps/backend/src/core/native-agent-service-projection.test.ts:3114-3127`
  and `apps/web/src/components/native-agent/AgentNativeTab.test.tsx:6244` and
  `:6295-6312`. The test name 0004 cites does not exist on `main`.
- A side effect of the residual descriptor: a control update setting
  `parameterValues.summary` on a Codex session passes validation, because the
  descriptor exists (`apps/backend/src/core/native-agent-service.ts:2523-2540`),
  is stored, and is forwarded in the prompt body
  (`http-bridge-prompt-body.ts:35`). The Codex bridge reads no
  `parameterValues` at all, so the value is silently ignored.

**Decisions.**

- **Which is wrong, the doc or the code?**
  - **Both: the decision in 0004 stands, the code is incomplete (the descriptor remains), and the doc overstates what shipped (recommended).** Finish the removal at the descriptor, then drop the entry.
    - Pros: matches 0004's recorded decision, the table's rule and `agent-engines.md`; removes an accepted-but-ignored setting.
    - Cons: touches the backend catalogue, a protocol table and two test files for no visible change.
  - **Accept the current code and rewrite 0004 item 1 to say the suppression stays.**
    - Pros: no code change.
    - Cons: keeps a descriptor nothing sources and a suppression for it, which the table's comment forbids; the inert value stays accepted by control updates.

### 2. Remove the descriptor at its source

**Problem.** `normalizedCodexModels` advertises a parameter the Codex bridge
does not honour.

**Context.** The descriptor dates from #599 (`5df7dec6`); #688 (`8d579e14`)
hid it with the suppression entry rather than removing it.

**Investigation.** The descriptor is built at read time from raw
`CodexModelCatalogEntry` values, not stored as `AgentModel` data: the cache
passes `cache.codex?.models` through the same normaliser (`:647`). So removing it
takes effect on the next catalogue read, with no stored copy to migrate. The
codex bridge produces no model parameters of its own (no `parameters` in
`bridges/codex-bridge/src` outside generated code). No test asserts the
normaliser's descriptor; "Reasoning summary" appears only in the two test
fixtures above.

**Decisions.**

- **What does a Codex model carry after the change?**
  - **No `parameters` at all, as the bridge has no provider-only axis today (recommended).**
    - Pros: the composer shows exactly what Codex honours; re-adding an axis later means a real descriptor, as 0004 says.
    - Cons: a future axis needs the field reintroduced.
  - **An empty `parameters: []`.**
    - Pros: keeps the shape explicit.
    - Cons: no consumer distinguishes it from absent; noise.
- **What about a `summary` value already stored on a Codex session?**
  - **Leave it: `nativeComposerControls` iterates descriptors, so a stored value with no descriptor is never shown, and the bridge ignores it (recommended).**
    - Pros: no migration; matches how other dropped descriptors behave.
    - Cons: the dead value stays in some session records and in prompt bodies.
  - **Add it to the retired-parameter filter (`native-agent-retired-parameters.ts`), as #1260 did for Claude's `permissionMode`.**
    - Pros: the value stops being forwarded and is dropped on the next control update.
    - Cons: the filter is not per platform today, and `summary` can be a real parameter id on another platform's model, so it would need a platform key.

### 3. Remove the suppression entry and flip the tests

**Problem.** Once task 2 lands the entry suppresses nothing, which the table's
rule forbids.

**Context.** 0004's analysis worried that a Codex bridge inside the
compatibility window ([0034](../cross-cutting/0034-mixed-version-compatibility.md))
might still advertise `summary`.

**Investigation.** That worry does not apply: the descriptor comes from the
backend, not the bridge, and the backend applies its own table at both
projection reads (`native-agent-transcript-projection.ts:3373`, `:5259`). A
newer renderer talking to an older backend still gets a filtered projection
from that backend. The renderer's own filter
(`AgentNativeTab.controller.tsx:3379`) is a second guard over the same table.

**Decisions.**

- **Land tasks 2 and 3 together or in sequence?**
  - **Together, in one change (recommended).**
    - Pros: no state where the control is visible; the test flip proves both halves at once.
    - Cons: none of substance.
  - **Remove the descriptor first and the entry in a later change.**
    - Pros: each change is smaller.
    - Cons: leaves a dead entry on `main` again, which is how this file came about.
- **What do the tests assert afterwards?**
  - **Backend: Codex's catalogue has no `summary` descriptor, and the projection test fixture for Codex expects `parameter:summary` to pass through (the table no longer hides it); renderer: "suppresses no Codex parameter control" as #1260's first commit wrote it (recommended).**
    - Pros: pins both the source and the table; the names then match 0004.
    - Cons: the projection test keeps a synthetic Codex summary descriptor, which no longer exists in production.
  - **Delete the Codex summary fixtures entirely.**
    - Pros: tests reflect production.
    - Cons: nothing proves Codex has no suppression entry, so a re-added entry would pass unnoticed.

### 4. Correct 0004's record

**Problem.** 0004 item 1 and its "Current state" describe the reverted commit.

**Context.** Editing an existing item to correct it is allowed (README, "Maintaining the folders").

**Investigation.** Item 1 cites the test "suppresses no Codex parameter
control", which does not exist on `main`, and says the backend test expects
`parameter:summary` to pass through, which is the opposite of `:3114-3127`.

**Decisions.**

- **When is 0004 corrected?**
  - **In the same change as tasks 2 and 3, pointing item 1 at this file until then (recommended).**
    - Pros: the record matches the code from that commit on.
    - Cons: 0004 stays wrong until the fix lands.
  - **Correct 0004 now to say the entry remains.**
    - Pros: accurate today.
    - Cons: two edits to the same text.

## Current state

Fixed on 2026-10-28 (code and unit tests; see Assumptions and decisions).

- `normalizedCodexModels` gives Codex catalogue rows no `parameters`
  (`apps/backend/src/core/commands-registry-projects.ts`), on both the live
  catalogue and the coordinator's cached one, since both go through it.
  Tests: "resolves each provider's default reasoning id from what the model
  offers" (`commands-state-sync.test.ts`) and "returns the Codex catalogue for
  a live coordinator conversation" (`commands-registry-coordinator.test.ts`)
  now also assert that Codex rows have no `parameters`.
- `SUPPRESSED_COMPOSER_PARAMETERS` has no `codex` entry
  (`packages/protocol/src/native-agent.ts`). Claude `thinking` / `context1m`
  and Cursor `variant` remain.
- The backend projection test "filters only provider-specific parameter
  controls for %s at the backend boundary" expects Codex to pass
  `parameter:summary` through, and the renderer test "suppresses no Codex
  parameter control in a %s tab" (`AgentNativeTab.test.tsx`) expects
  "Reasoning summary: Automatic" to render. Both use a synthetic Codex
  descriptor, so a re-added Codex suppression entry fails them.
- A control update that sets `summary` on a Codex session is refused ("Native
  agent parameter summary is invalid"), because no catalogue row offers it.
  Test: "refuses a Codex reasoning summary that no catalogue row offers"
  (`native-agent-service-projection.test.ts`).
- A `summary` value an older Codex session record still holds is retired for
  Codex only (`native-agent-retired-parameters.ts`, now keyed by platform;
  `permissionMode` stays retired on every platform, as before). The next
  control update drops it (`native-agent-session-controls.ts`), and prompt and
  resume bodies never forward it (`http-bridge-prompt-body.ts`,
  `HttpBridgeProvider.resumeSession`). A Cursor or other platform's `summary`
  is untouched. Tests: "drops a stored retired summary value for %s only on a
  control update" (`storage-native-agent-sessions.test.ts`) and "never
  forwards a stored Codex reasoning summary, which only Codex retired"
  (`http-bridge-provider.test.ts`).
- No renderer, protocol or settings path names a Codex summary: the renderer
  has no Codex default parameter values (`configuredParameterValues` is
  Claude-only in `AgentNativeTab.controller.tsx`), there is no Codex summary
  setting, and the renderer's filter reads the same table.
- 0004 item 1, its task 1 and "Current state" now describe this.
- `docs/architecture/agent-engines.md` records the rule.

## Outstanding work

### Code

1. ~~Remove the `summary` descriptor from `normalizedCodexModels`, and add a
   test that Codex catalogue models carry no `summary` parameter.~~ Done
   2026-10-28.
2. ~~Remove `codex` from `SUPPRESSED_COMPOSER_PARAMETERS`.~~ Done 2026-10-28.
3. ~~Flip the backend projection test to expect `parameter:summary` to pass
   through for Codex, and rename the renderer test to "suppresses no Codex
   parameter control in a %s tab", expecting the control rendered.~~ Done
   2026-10-28.
4. ~~Correct 0004 item 1 and its "Current state" in the same change.~~ Done
   2026-10-28.

### Qualification

- Open: a Codex tab in a `dev:test` profile shows no "Reasoning summary"
  control and no other parameter control. Not run: this change was made
  without live runs, and the Codex catalogue on a real profile needs a signed-in
  Codex (or a seeded catalogue cache). Unit tests cover the catalogue, the
  projection and the renderer separately.
- Open, optional: a profile carried over from an older build, whose Codex
  session record holds `parameterValues.summary`, still loads, sends, and
  loses the value on its next control change. Covered only by unit tests.

## Assumptions and decisions

- **Codex model shape after the change (task 2).**
  - Options: (a) omit `parameters`; (b) emit `parameters: []`.
  - Choice: (a).
  - Why: no consumer distinguishes an empty list from an absent one, and the
    OpenCode normaliser sets no `parameters` either.
  - Pros: the composer shows exactly what Codex honours; the shape matches
    "no provider-only axis".
  - Cons: a future Codex axis reintroduces the field (it would need a real,
    bridge-honoured descriptor anyway).
- **A `summary` value already stored on a Codex session (task 2).**
  - Options: (a) leave it: no descriptor, so it is never shown, and the
    bridge ignores it; (b) retire it through
    `native-agent-retired-parameters.ts`, keyed by platform; (c) a one-off
    migration of stored session records.
  - Choice: (b).
  - Why: the task asks that a stored preference is handled gracefully, and
    0004 item 3 set the precedent for `permissionMode`: a value nothing may
    act on should not keep travelling in prompt and resume bodies. Keying by
    platform answers the analysis's objection, since `summary` can be a live
    parameter id elsewhere (an ACP config option or a Cursor axis).
    `permissionMode` keeps its existing every-platform rule, so its behaviour
    does not change.
  - Pros: no migration; the value is never forwarded and disappears on the
    next control change; other platforms' `summary` parameters are unaffected.
  - Cons: a record that never gets another control update keeps the dead
    value on disk (harmless, never sent); the projection's
    `composer.parameterValues` still echoes it until then (nothing renders
    it, because controls iterate descriptors).
- **Where the stored value is filtered.**
  - Options: (a) prompt body and control updates only, as for
    `permissionMode`; (b) also the resume body; (c) also the projection.
  - Choice: (b).
  - Why: Codex's `POST /session/resume` also carried stored
    `parameterValues`, so (a) would still forward it on every resume. The
    projection (c) is renderer-facing only and shows no control without a
    descriptor, so filtering it would add a third call site for no visible
    change.
  - Pros: no bridge request carries a retired value.
  - Cons: Cursor, Grok and Pi resume bodies now also drop a stored
    `permissionMode`, which their bridges never read (no behaviour change).
- **A control update that sets `summary` on Codex.**
  - Options: (a) refuse it, as for any parameter no descriptor offers;
    (b) accept and drop it silently for compatibility with an older renderer.
  - Choice: (a), which needs no code: validation already rejects a parameter
    the selected model does not describe.
  - Why: every renderer since #688 hid the control, so no client in 0034's
    window can send it from the input bar.
  - Pros: an attempt to set an inert value fails loudly.
  - Cons: a scripted client that still sends it gets an error rather than a
    silent no-op.
- **Tests after the flip (task 3).** As the analysis recommended: the
  projection and renderer tests keep a synthetic Codex `summary` descriptor
  and expect it through, so a re-added Codex suppression entry fails them,
  and the catalogue tests pin the source. Deleting the fixtures was rejected
  because nothing would then prove Codex has no entry.
- **Tasks 2 and 3 together (task 3).** One change, as recommended: there is
  no commit where the control is visible or the entry is dead.
- **The file stays open.** Every code item is done, but the qualification
  line needs a live Codex tab, which this change could not run. Finished stays
  No until that look is recorded; then the file is deleted (the rule already
  lives in `agent-engines.md`).

## Constraints and rationale

- A suppression entry needs a descriptor that produces it; a control nothing
  sources is removed at the source, not hidden.
- Re-adding a Codex summary control later means a descriptor the bridge honours
  and `model/list` can advertise, not a suppression.

## Open questions

- None.

## Needs verification

- None. The reason `2690e39f` restored the entry is inferred from the code path
  above; the commit message does not state it.

## Related

- [0004-composer-model-parameters.md](0004-composer-model-parameters.md)
  (item 1 and "Assumptions and decisions").
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md).
- [agent-engines.md](../../architecture/agent-engines.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0004-composer-model-parameters.md](0004-composer-model-parameters.md)'s task
analysis.
