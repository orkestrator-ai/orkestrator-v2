# 07 — Move ACP shape coverage below the subprocess boundary

Status: Retained after boundary audit. Depends on:
[01](01-baseline-and-coverage-inventory.md),
[06](06-runtime-preloads.md).

## Implementation result

No ACP cases were removed. `acp-tools.test.ts` already exercises the direct
parse and merge boundary. The apparently repetitive subprocess cases also
assert transcript association, ordering, acknowledgement and transport
lifecycle behavior, so moving them to another direct matrix would either
duplicate existing tests or lose the boundary that makes them valuable. The
bridge preload change still reduces ACP setup cost without weakening these
contracts.

## Goal

Reduce process launches and polling in the 105.6-second ACP package while
retaining exhaustive normalization and ordering coverage. Preserve real
integration tests wherever persistence, transport, startup configuration or
process lifetime is part of the assertion.

## Existing owners

- [acp-transcript.test.ts](../../../../bridges/acp-bridge/src/acp-transcript.test.ts):
  34.35 seconds and 76 `await spawnBridge(...)` source call sites in the review.
- [acp-tools.test.ts](../../../../bridges/acp-bridge/src/acp-tools.test.ts):
  existing direct parser, todo and tool-state tests.
- [acp-tools.ts](../../../../bridges/acp-bridge/src/acp-tools.ts) and
  [acp-session.ts](../../../../bridges/acp-bridge/src/acp-session.ts): real update
  functions to exercise, including `applyAcpPlanUpdate` and `applySessionUpdate`.
- [testing/unit-test-env.ts](../../../../bridges/acp-bridge/src/testing/unit-test-env.ts):
  provider configuration before import-time bridge initialization.
- [acp-test-harness.ts](../../../../bridges/acp-bridge/src/acp-test-harness.ts):
  tracked child and temporary-directory ownership.

## Classification before movement

Create a case ledger with these three classes:

| Class | Example | Intended owner |
| --- | --- | --- |
| Shape/pure rule | Parse plan entries, map todo status, merge/delete rows | Direct function test with fresh state |
| In-process update sequence | Vendor todo event before/after tool event; repeated completion | Real update dispatcher with controlled session state |
| Transport/lifecycle | HTTP acceptance, request acknowledgement, restart replay, generation death | Existing subprocess integration harness |

The v1 plan and v2 `plan_update` cases are initial candidates. They currently
launch a bridge and poll a whole turn to assert a todo-list shape. Verify that
both wire forms still have an integration owner even if their shape matrices
move below HTTP.

## Tasks

### 1. Establish one faithful direct-state harness

- [ ] Reuse the existing unit environment bootstrap before bridge imports.
  Do not mutate provider identity after importing modules that cache it.
- [ ] Use the real session-state constructor or an existing faithful fixture.
  Keep one fresh state object per case, including revisions, tool indexes,
  notice state and transcript bounds that the update functions actually use.
- [ ] Stub only external process/network/persistence work outside the intended
  unit boundary. Do not mock the update dispatcher or renderer under test.
- [ ] If `acp-tools.test.ts` already covers a proposed matrix row, extend its
  fixture/assertion rather than add a duplicate direct case.
- [ ] Avoid importing subprocess lifecycle hooks into a new pure helper if
  they create unnecessary state; retain shared cleanup for cases that use it.

### 2. Move a small pilot family

- [ ] Select plan/v2-plan normalization and todo merge/reset variants whose
  assertions depend only on input sequence and resulting transcript state.
- [ ] Feed the same production-shaped payloads through the real function at
  the chosen boundary. Preserve IDs, status transitions, message association,
  ordering, malformed-field handling and empty-list semantics.
- [ ] Assert output after each meaningful transition where the old case checked
  intermediate state, not only the final snapshot.
- [ ] Verify repeated events remain idempotent and late updates target the
  correct tool/message. Preserve a full transport test for delivery order.
- [ ] Demonstrate direct and old integration cases agree on representative
  fixtures before deleting the repeated integration shape rows.

### 3. Retain the integration assurance list

- [ ] Keep at least one real path for each distinct supported plan/todo wire
  method and for request methods that require acknowledgements rather than
  one-way notification handling.
- [ ] Keep restart/hydration tests, persistence failure handling, deduplication
  across replay, restored tool arguments and old-session metadata behavior.
- [ ] Keep live follow-up reconciliation, late completion races and work that
  must not block another active session or the stdout read loop.
- [ ] Keep process attachment/detachment, capability refusal, cancellation,
  pending interactions and generation-loss handling at their real boundaries.
- [ ] Keep payload/queue bounds and truncation visibility where the transport
  or persistence layer is what enforces the bound.
- [ ] Keep every provider-specific trust-boundary implementation independently
  tested. This step does not delete the Cursor/ACP attachment copies.

### 4. Reduce waits without deleting ordering evidence

- [ ] For retained 800–1,600 ms delays, determine whether the fake agent can
  expose a completion/barrier signal using its existing fixture protocol.
- [ ] A negative assertion such as “no second child was launched” must wait
  until the reconciliation cycle that could launch it has completed. A timer
  shortened below that cycle is not equivalent.
- [ ] Keep incompatible process environment cases isolated. Do not reuse one
  long-lived bridge across cases by repeatedly mutating configuration.
- [ ] Remove a fake-agent scenario only when no retained integration case
  references it. Check fixtures by actual references rather than test titles.

## Validation and performance

Run the direct owner under its final node preload:

```bash
mise run test:logged -- --name streamlining-acp-tools -- \
  bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts \
  ./src/acp-tools.test.ts --parallel=1 --only-failures

mise run test:logged -- --name streamlining-acp-transcript -- \
  bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts \
  ./src/acp-transcript.test.ts --parallel=1 --only-failures
```

Also run new direct files, related context/reconciliation/persistence cases,
the package script and default aggregate. Validate import-time provider setup
from a fresh worker rather than only after another ACP file has run.

Record actual bridge/agent process counts, poll counts and package/file time
before and after the pilot. The 76 source call sites are not a process-count
baseline. Expand to more families only when the pilot shows worthwhile savings
and retained wire/lifecycle coverage remains identifiable.

## Completion and rollback

- [ ] Every moved case has a direct owner and any required integration owner.
- [ ] Direct tests call production normalization/update code with independent state.
- [ ] Retained integration cases still prove all required real boundaries.
- [ ] ACP executes fewer fixture processes and improves measured duration.
- [ ] No new import-order, stale-state, leaked-child or replay failures appear.

Land by semantic family. Restore a family's original integration rows if the
direct harness cannot faithfully preserve its assertions. Re-measure the whole
bridge group before choosing package scheduling work in step 10.
