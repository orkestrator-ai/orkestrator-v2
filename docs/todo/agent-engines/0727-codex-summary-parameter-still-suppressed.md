# The backend still advertises a Codex reasoning-summary parameter, hidden only by a suppression entry

Checked against `main` at `863b5782` (2026-10-27).

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
2. **Remove the descriptor at its source**: stop `normalizedCodexModels` emitting `summary`. Status: open.
3. **Remove the suppression entry and flip the tests**: once nothing produces the control. Status: open (depends on 2).
4. **Correct 0004's record**: item 1 and its test names. Status: open.

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

- `normalizedCodexModels` adds a `summary` select descriptor to every Codex model
  (`apps/backend/src/core/commands-registry-projects.ts:193-206`).
- `SUPPRESSED_COMPOSER_PARAMETERS.codex` is `["parameter:summary"]`
  (`packages/protocol/src/native-agent.ts:976`); the comment above it no longer
  mentions Codex (`:959-970`).
- The backend projection test expects Codex's controls without
  `parameter:summary` (`native-agent-service-projection.test.ts:3114-3127`); the
  renderer test "hides unsupported Codex summary in a %s tab" expects it hidden
  (`AgentNativeTab.test.tsx:6295-6312`).
- The Codex bridge reads no `parameterValues`; control updates still accept a
  `summary` value for Codex (`native-agent-service.ts:2523-2540`).
- PR #1260's first commit removed the entry and its second commit restored it;
  the squash message and 0004 describe the first.

## Outstanding work

### Code

1. Remove the `summary` descriptor from `normalizedCodexModels`, and add a test
   that Codex catalogue models carry no `summary` parameter.
2. Remove `codex` from `SUPPRESSED_COMPOSER_PARAMETERS`.
3. Flip the backend projection test to expect `parameter:summary` to pass
   through for Codex, and rename the renderer test to "suppresses no Codex
   parameter control in a %s tab", expecting the control rendered.
4. Correct 0004 item 1 and its "Current state" in the same change.

### Qualification

- None beyond the tests in Code. A Codex tab in a `dev:test` profile should
  show no "Reasoning summary" control before and after the change.

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
