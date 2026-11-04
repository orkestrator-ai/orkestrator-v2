# A restart inside the verification window keeps the old generation

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23f`; rechecked and fixed
2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Close the window for process-keyed loopback targets**: a new upstream
   connection to a `managed-process` target must not reach a different
   process than the one last verified. Status: done (2026-11-04).
2. **Drop the wait from the seeded restart check**: remove the 6 s wait in
   check 3 of `e2e/agent-testing/service-preview-seeded-electron.spec.ts` and
   let it restart immediately. Status: done (2026-11-04).

### 1. Close the window for process-keyed loopback targets

**Problem.** When a local dev server is restarted on the same port within 5 s
of the last verified connection to it, the next request from an open preview
tab reaches the new process under the old endpoint generation. Nothing is
revoked, and the generation stays where it was until something re-resolves the
service. The same window would let another environment's server that takes
the freed port within those 5 s be shown in this environment's tab, which
seeded services exist to prevent
([0045](0045-preview-service-discovery.md), D1).

**Context.** Found by the in-app qualification of
[0045](0045-preview-service-discovery.md) task 1 (D12 there). A new upstream
connection, through the desktop tunnel (`preview-tunnel-server.ts`, `open`)
or the HTTP proxy (`preview-http-proxy.ts`, `authorizedTarget`), calls
`PreviewServiceRegistry.acquireTarget`
(`apps/backend/src/core/preview-service-registry.ts`). That checked the
attachment's generation against the registry's and re-resolved only when the
cached target was older than `verificationTtlMs`, 5 s by default. Within the
window it returned the cached target, `127.0.0.1:<port>`, and connected to
whatever listened there. For a loopback target the resolver keys the binding
to the listener process (`preview-target-resolver.ts`, `resolveLoopback`;
`processKey` from `preview-listener-ownership.ts`), so a re-resolve would have
rebound it and revoked the old attachments (`commitResolution`). The window
skipped exactly that check. D3 in 0045 listed the window as a known cost.

**Investigation.** Observed on macOS (arktech-mini, Bun 1.4.4) in the real
Electron window, three runs of the seeded spec without its wait: the dev
server was stopped with Ctrl-C and started again in the same terminal, a
fetch from the open page answered with the new process's marker, and the
service's `endpointGeneration` was unchanged with `revoked: 0` in
`get_preview_diagnostics` 30–90 s later. An explicit `probe_preview_service`
then bumped the generation (3 → 4). With the request delayed until 6 s after
the old process exited, the same request re-verified, bumped the generation,
and the old attachment was refused on renewal: the check passes. The likely
last verification was the tab's own load when the previous check re-showed it,
a few seconds before the restart. The window is per service, so any traffic
keeps refreshing it.

**Decisions.**

- **How to stop a cached loopback target reaching a different process?**
  - **Check the listener pid on each new connection to a process-keyed target,
    and re-resolve when it differs (recommended).** Cache the listener pid with
    the target; before reusing it inside the window, run only the port lookup
    (`lsof -Fp`, or `ss` on Linux), not the full `ps` ancestry walk.
    - Pros: closes the restart case and the other-environment case; the
      common case (same pid) costs one coalesced port lookup; no change for
      container or user-registered targets.
    - Cons: one `lsof` per new connection burst on local previews (coalesced
      per port by `attribute`'s in-flight map, but still tens of ms of latency
      on a cold connection); pid reuse within 5 s would still pass, which is
      far less likely than a restart.
  - **Always re-resolve process-keyed targets (TTL 0 for them).**
    - Pros: simplest; exact.
    - Cons: the full `lsof` plus `ps -A` walk on every new connection; a page
      load opens many.
  - **Shorten the window for loopback targets (for example 1 s).**
    - Pros: one-line change.
    - Cons: narrows the gap without closing it; a fast restart still slips
      through.
  - **Accept it and document it in `browser-previews.md`.**
    - Pros: no code.
    - Cons: leaves a path by which another environment's server is shown in a
      seeded service, against D1.

### 2. Drop the wait from the seeded restart check

**Problem.** Check 3 of the seeded Electron spec waits until 6 s after the old
server exits before it sends the request that must reach the new process, so
it does not exercise the fast-restart case.

**Context.** `e2e/agent-testing/service-preview-seeded-electron.spec.ts`, test
"3. a restarted dev server is reached from the open tab without a reload, and
the old generation is refused"; the wait is commented with this file's number.

**Investigation.** The analysis recorded that without the wait the check fails
at "the seeded service rebinds to the new process" (generation unchanged), as
described in task 1. On 2026-11-04, with the fix temporarily disabled and no
wait, check 3 passed in 4.4 s because its polling outlasts the window; check 6
is the one that failed. See **Assumptions and decisions**.

**Decisions.**

- **When task 1 lands, what should the check do?**
  - **Remove the wait and keep every assertion (recommended).**
    - Pros: covers the case real users hit (restart within seconds).
    - Cons: none beyond the fix itself.
  - **Keep the wait and add a second, immediate restart.**
    - Pros: covers both timings.
    - Cons: a third server process and more runtime for little extra signal.

## Needs verification

The real-window run was on macOS, with `lsof`. The Linux `ss` path of the port
lookup is covered only by scripted-host tests, in
`preview-listener-ownership.test.ts`.

## Related

- [0045-preview-service-discovery.md](0045-preview-service-discovery.md) (D3,
  D12 and the in-app qualification).
- [browser-previews.md](../../architecture/browser-previews.md) §"Local
  environments".

## Assumptions and decisions

### Task 1: compare the whole listener set, not one pid

The todo says "the listener pid"; `processKey` digests only the lowest of
possibly several. The target caches the sorted set instead, so a stranger or a
new worker sharing the port (`SO_REUSEPORT`, forked workers) is noticed too.
A changed set only triggers the full check: if the lowest pid and its start
time are the same, the generation stays.

### Task 1: a lookup that cannot answer re-resolves

A timeout, a missing tool or a listener with a hidden process returns `null`,
which goes through the full check rather than trusting the cache. That matches
what the same failure already does once the window expires (`unchecked`), and
"cannot tell" must never become "same process". The cost is that a transient
`lsof` timeout can end a binding a few seconds sooner; the existing recheck
schedule restores it.

### Task 1: a resolve already running cannot vouch for a newer lookup

`resolveNow` joins a job in flight, which may have listed the port before the
restart. After a mismatch the connection waits for that job, compares its answer
with what the lookup saw, and starts a fresh resolve if they still differ.

### Task 1: only new connections look anything up

The HTTP proxy's `takeIdle` also goes through `acquireTarget`, once per request.
It passes `reusingConnection`, because a pooled socket stays on the process it
was opened to; otherwise keep-alive traffic would pay an `lsof` per request,
which the todo's cost estimate did not intend. The TTL check still applies there.

### Task 1: known gaps left as they are

Pid reuse within 5 s is out of scope. A lookup that a connection joins may have
started just before the connection asked, and the connect itself follows the
lookup, so a replacement within those milliseconds is caught by the next
connection. Coalescing was the ticket's decision, and no port lookup can close
the gap to the connect. Both are recorded in `browser-previews.md`.

### Task 2: outcome and evidence

Check 3 has no wait and keeps every assertion; check 6 has no expected-failure
annotation. `service-preview-seeded-electron.spec.ts` passed all six checks in
nine of ten runs on macOS, including five in a row on the committed fix. The
other run timed out in check 2, before any restart, on a step this change does
not touch; it is recorded as flake
[4470](../../tests/flaky-tests/previews-annotations-and-gateway/4470-seeded-preview-moved-port-link-not-printed.md),
cause not established. With the recheck temporarily disabled, check 6
failed on the generation (`Expected: > 4, Received: 4`), so the spec detects the
defect. Check 3 still passed in that run, in 4.4 s rather than about 0.6 s, so
check 6 is the regression guard and check 3 covers the visible reconnect.
Deterministic coverage is `apps/backend/src/core/preview-verification-window.test.ts`,
8 of whose 12 tests fail on the old code. The evidence log is in
[0042](0042-service-preview-rollout.md#evidence-log).

### This file is kept although finished

`docs/README.md` deletes a finished file once its durable behaviour has moved to
`architecture/`, but this ticket asked for the file to record the outcome. It
stays marked Finished; removing it and its index row is a later cleanup.
