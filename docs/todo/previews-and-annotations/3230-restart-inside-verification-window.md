# A restart inside the verification window keeps the old generation

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23f`.

### Tasks

1. **Close the window for process-keyed loopback targets**: a new upstream
   connection to a `managed-process` target must not reach a different
   process than the one last verified. Status: open.
2. **Drop the wait from the seeded restart check**: remove the 6 s wait in
   check 3 of `e2e/agent-testing/service-preview-seeded-electron.spec.ts` and
   let it restart immediately. Status: open (depends on 1).

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
connection, through the desktop tunnel (`apps/backend/src/preview-tunnel-server.ts:271`)
or the HTTP proxy (`apps/backend/src/preview-http-proxy.ts:134`), calls
`PreviewServiceRegistry.acquireTarget`
(`apps/backend/src/core/preview-service-registry.ts:1298`). That checks the
attachment's generation against the registry's and re-resolves only when the
cached target is older than `verificationTtlMs`, 5 s by default (`:267`,
`:1310`). Within the window it returns the cached target, `127.0.0.1:<port>`,
and connects to whatever listens there now. For a loopback target the
resolver keys the binding to the listener process
(`apps/backend/src/core/preview-target-resolver.ts:474`, `processKey` from
`apps/backend/src/core/preview-listener-ownership.ts:205`), so a re-resolve
would have rebound it and revoked the old attachments
(`commitResolution`, `preview-service-registry.ts:1113-1124`). The window
skips exactly that check. D3 in 0045 lists the window as a known cost.

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

**Investigation.** Without the wait the check fails at "the seeded service
rebinds to the new process" (generation unchanged), as described in task 1.

**Decisions.**

- **When task 1 lands, what should the check do?**
  - **Remove the wait and keep every assertion (recommended).**
    - Pros: covers the case real users hit (restart within seconds).
    - Cons: none beyond the fix itself.
  - **Keep the wait and add a second, immediate restart.**
    - Pros: covers both timings.
    - Cons: a third server process and more runtime for little extra signal.

## Related

- [0045-preview-service-discovery.md](0045-preview-service-discovery.md) (D3,
  D12 and the in-app qualification).
- [browser-previews.md](../../architecture/browser-previews.md) §"Local
  environments".
