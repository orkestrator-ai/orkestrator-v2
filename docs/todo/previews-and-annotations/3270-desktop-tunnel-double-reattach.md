# Concurrent desktop tunnel refusals reattach twice and fail one request

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23fb`.

### Tasks

1. **Reattach once per refused attachment**: a connection refused for an attachment that has already been replaced retries on the new one instead of starting another reattach. Status: open.
2. **Regression test with concurrent requests**: the desktop end-to-end suite revokes access and sends two requests at once through the ingress. Status: open (depends on 1).

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

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) task 6 (reconnect metrics).
