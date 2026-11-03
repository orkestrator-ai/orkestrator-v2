# Concurrent desktop tunnel refusals reattach twice and fail one request

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23fb`.

### Tasks

1. **Reattach once per refused attachment**: a connection refused for an attachment that has already been replaced retries on the new one instead of starting another reattach. Status: done (2026-11-03).
2. **Regression test with concurrent requests**: the desktop end-to-end suite revokes access and sends two requests at once through the ingress. Status: done (2026-11-03).

### 1. Reattach once per refused attachment

**Problem.** After the backend revokes a desktop tunnel attachment (operator revocation, expiry or a generation change), two requests arriving at the loopback ingress together can each start their own reattach. The second reattach releases the attachment the first one just created, so the first request's retry is refused and the page gets `401 Preview access expired. Reconnect to continue.` One revocation also produces two `create_preview_attachment` calls and two `desktop.reconnect` counts.

**Context.** `PreviewTransportManager.connect` (`apps/desktop/electron/preview-transport-manager.ts`) opens a tunnel with `group.attachment`. On an `access-expired` or `generation-changed` refusal it calls `attach(group, category)` and retries `open()` once. `attach` joins an attach already in flight (`group.attaching`), but once that attach has settled the next caller starts a new one, and each new attach releases its `previous` attachment. Found while adding the reconnect metrics for [0042](0042-service-preview-rollout.md) task 6.

**Investigation.** Reproduced on branch `preview-reconnect-metrics-ca90ec0df07b-r1` (based on `7b48c23fb`) in `apps/desktop/tests/preview-transport-manager.test.ts`: acquire a service, revoke it with `harness.runtime.access.revokeServices`, then send two `GET`s through the ingress with `Promise.all`. In 3 of 3 runs one answered 401 and the backend saw `create_preview_attachment` three times (initial attach plus two reattaches) and `release_preview_attachment` twice. The dedupe in `attach` is the same on `main` (`group.attaching ??=`); the branch only adds the reconnect counter, so the race is not new. A first variant that also had a pooled keep-alive connection from an earlier request failed the same way; whether reusing a pooled connection across a revocation fails on its own was not established. The existing sequential test ("revoked access reattaches transparently for new connections") does not hit either case.

**Decisions.**

- **How should a refused connection decide whether to reattach?**
  - **Remember which attachment the refused open used, and reattach only if it is still current; otherwise retry on the current one (recommended).**
    - Pros: one reattach per revocation however many connections were refused; no extra backend calls; the reconnect metric then counts real reattaches.
    - Cons: one more piece of state threaded through `open()`.
  - **Allow a second retry after a failed retry.**
    - Pros: a small change.
    - Cons: still creates and releases spare attachments; under load it can still lose the race.
  - **Leave it.**
    - Pros: no work.
    - Cons: a revocation or generation change can fail a page request that should have recovered, and inflates the reconnect count the rollout thresholds will read.

### 2. Regression test with concurrent requests

**Problem.** No test sends concurrent requests across a revocation.

**Context.** The end-to-end suite above already has a real tunnel server, command registry and fixture app.

**Investigation.** The reproduction in task 1 is the test; it fails today.

**Decisions.**

- **Where should the test live?**
  - **In `apps/desktop/tests/preview-transport-manager.test.ts`, beside the existing revocation tests (recommended).**
    - Pros: reuses the harness; asserts both statuses and exactly two `create_preview_attachment` calls.
    - Cons: none beyond a slightly longer file.
  - **A unit test with a fake tunnel.**
    - Pros: deterministic ordering.
    - Cons: would not exercise the real refusal path.

## Assumptions and decisions

### Task 1: which refusals reattach

`PreviewTransportManager.connect` now keeps the attachment each open used and
passes it to `replacementFor`. A refusal reattaches only if that attachment is
still current. Otherwise it retries on the current one, with no backend call, no
`desktop.reconnect` and no `reconnecting` state. This is the recommended option;
the alternatives are compared under task 1 above.

While an attach is in flight, a refused connection joins it even if the current
attachment differs from the one it used, because that attachment is about to be
released.

### Task 1: renewals follow the same rule

The ticket's criterion is one reattach per revocation, and `renew` could break
it. A renewal still pending when another path replaced its attachment is refused
with `not-found` once that attachment is released, and `renew` then started
another attach, which released the replacement. `renew` now returns without
reattaching in that case. Without this, the connection fix would leave one route
to the same failure.

### Task 1: one retry stays the limit

A connection still gets one retry. If the attachment it retries on is revoked as
well (a second revocation inside that window), the request fails with the refusal
rather than looping. This matches the behaviour before the fix, and bounds the
work one request can cause.

### Task 1: pooled connections

The investigation left open whether reusing a pooled connection across a
revocation fails on its own. With the fix, the test that first pools a keep-alive
connection and then sends two `GET`s immediately after the revocation passes, so
this did not show a separate failure. It covers only `GET`s; requests with a body
on a pooled connection were not tested.

### Task 2: tests added

All in `apps/desktop/tests/preview-transport-manager.test.ts`, on the real
harness except the last. Each failed before the fix.

- Two concurrent requests after a revocation, with and without a pooled
  connection: both answer 200, two `create_preview_attachment`, one
  `release_preview_attachment`, one `desktop.reconnect{access-expired}`.
- The same after a generation change, with `authenticateTunnel` refusing the first
  attachment as `generation-changed`: a real generation bump also revokes, which
  reports `access-expired`.
- A refusal that arrives after the replacement: the gateway holds the second
  tunnel upgrade until the first request has recovered, so the order is fixed
  rather than timing-dependent.
- A renewal refused after its attachment was replaced, in the fake-backend
  lifecycle suite.

### Keeping this file

The index marks this file finished, and it stays in place until a later sweep
retires it, as with the other finished rows and retirement commits such as #1442.
The durable behaviour is in
[browser-previews.md](../../architecture/browser-previews.md#connections-through-the-tunnel).

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) task 6 (reconnect metrics).
