# 02 — Stabilize the gateway expiry fixture

Status: Implemented; pending review and integration. Depends on:
[01](01-baseline-and-coverage-inventory.md).

## Implementation result

The fixture now establishes the event stream while the credential is valid,
captures only the production session-expiry callback, then marks the credential
expired and invokes that callback. Network timers remain real. The assertions
still require both client abort and removal from the server client map, and the
flake-registry entry records the corrected mechanism. Ten serial owning-file
runs passed in 6.5 seconds.

## Goal

Remove the observed connection-versus-expiry race from the fixture while still
proving that a connected event stream is closed by production authentication
expiry. This improves reliability of later measurements; it is not a deletion
or timeout increase to conceal the failed run.

## Evidence and owners

The review's aggregate failed `closes an established event stream when its
agent-test session expires`; the owning file passed alone. The fixture sets
`entry.expiresAt = Date.now() + 40` before establishing the stream, so ordinary
connection scheduling can consume its entire authenticated lifetime.

Read:

- [gateway-auth.test.ts](../../../../tests/unit/electron/gateway-auth.test.ts)
- [gateway-test-harness.ts](../../../../tests/unit/electron/gateway-test-harness.ts)
- [gateway-handlers.ts](../../../../apps/backend/src/gateway-handlers.ts)
- [gateway-auth.ts](../../../../apps/backend/src/gateway-auth.ts)
- [flake index](../../../tests/flaky-tests/0000-index.md)

The handler schedules `scheduleCredentialExpiry` for the accepted deadline.
Its callback checks the credential again and either closes or schedules the
next deadline. Mutating `expiresAt` after connect, by itself, leaves the old
timer scheduled and is not a complete fixture fix.

## Tasks

- [ ] Search the flake index for this exact case and recurrence symptoms. Reuse
  its entry if present; otherwise record the review's aggregate/isolated
  evidence in the existing registry, not another registry in this plan.
- [ ] Confirm the failure mechanism with a bounded focused reproduction or
  source-driven timer observation. If a different cause appears, document it
  and change the implementation approach before editing assertions.
- [ ] Keep the credential valid while opening the stream and awaiting the
  client-side connected signal.
- [ ] Control the expiry clock and the actual production-scheduled timer only
  after that connection exists. Prefer an existing harness clock seam; otherwise
  prototype a narrowly scoped timer controller in the test harness that captures
  and invokes the production callback while leaving network I/O real.
- [ ] Ensure the callback reads an expired credential when fired. Do not call
  the fixture's `stream.close()` as the action under test, replace the production
  auth predicate with `false`, or assert only that the session map was cleared.
- [ ] Assert both the eventual client-side abort and removal from the server's
  client map. Close remaining resources in `finally` so assertion failures
  do not leak streams or timer overrides.
- [ ] Retain the complementary case that a credential expired before a new
  request is refused. Retain absolute lifetime versus sliding idle-expiry
  coverage wherever those are currently distinct cases.
- [ ] Verify a durable gateway token has no session-expiry timer and that normal
  stream close clears a pending expiry timer if those paths share the helper.

Avoid global fake time across a real HTTP handshake unless the pinned runtime's
network and timer interactions have been demonstrated safe. The intended test
has deterministic ordering, not a larger arbitrary validity window. A new
production seam is a fallback only if test-local control cannot reach the real
callback without brittle interception; its runtime effect needs separate review.

## Validation

```bash
mise run test:logged -- --name streamlining-gateway-auth -- \
  bun test ./tests/unit/electron/gateway-auth.test.ts \
  --parallel=1 --only-failures
```

Run the owning file repeatedly in a bounded diagnostic batch, then with the
neighboring gateway suites at the normal root worker allocation through the
aggregate runner. Record the number of runs, failures and fixture cleanup.
Start with ten focused repetitions; expand only if the failure rate or a
remaining hypothesis warrants it. Repetition is evidence, not an automatic
retry policy for normal validation.

The test must fail if the production expiry callback no longer closes an
expired stream. Verify this with a temporary local fault when reviewing the
fixture, then restore the source before final tests and diff checks.

## Completion and rollback

- [ ] Connection setup cannot consume a deliberately tiny expiry deadline.
- [ ] The assertion still observes real client/server disconnect behavior.
- [ ] No global, timer, stream or credential state leaks into another case.
- [ ] Focused and contended evidence is attached to the existing flake entry;
  mark it resolved only when the repository's flake criteria are met.

Keep this correction in its own commit/PR. If it weakens expiry coverage,
revert the harness change while retaining the recorded failure evidence.
